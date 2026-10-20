import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { PurchaseHistoryQueryDto } from './purchase.dto';
import { PurchaseRepository } from './purchase.repository';
import { PurchaseHistoryRepository } from './purchase-history.repository';
import {
  CommerceIdentityGateway,
  type DirectoryUserProfile,
} from '../commerce-identity.gateway';

/**
 * PHASE W3.2 — the purchase document's AGGREGATED traceability history.
 *
 * THREE REAL SOURCES, THREE DISTINCT MEANINGS — never merged into one fiction:
 *
 *   `status`  — `PurchaseStatusEvent` rows: lifecycle transitions the writers
 *               appended atomically (fromStatus → toStatus, actor, instant).
 *   `audit`   — platform audit events (`CommerceAuditGateway.read`): the
 *               actor/action evidence for every audited write touching this
 *               document — purchase-document acts, payments (resourceId is the
 *               document id by the payment slice's contract), and the receipt,
 *               return and payment-plan events correlated by the ids THIS
 *               module's rows state. A rejected read is reported, never
 *               rendered as "no events".
 *   `posting` — `InventoryPosting` rows: the integration diagnostic stream —
 *               status, attempt count, last error, produced movement id. One
 *               item per posting describes its CURRENT persisted state; the
 *               table holds no per-attempt history, so none is fabricated.
 *
 * FILTERS APPLY TO THE MERGED SET, SERVER-SIDE: `sources`, `outcome`,
 * `action`, `actorId`, `from`, `to` narrow the assembled items before the
 * deterministic `(occurredAt, id)` order and the page slice. Nothing here
 * accepts a tenant, an unbounded page, or a foreign resource id.
 *
 * COMPLETE TRAVERSAL, HONESTLY BOUNDED (W4-D): every (family, resourceId)
 * correlation is paged THROUGH the platform contract until `total` events are
 * collected — a 101st event can no longer vanish silently. Two bounds remain,
 * and both are reported instead of implied: `MAX_CORRELATED_IDS` child ids
 * per family (a document whose family overflows reports the family in
 * `coverage.audit.truncatedFamilies`) and `MAX_AUDIT_PAGES_PER_ID` pages per
 * resource (an overflow reports `family:id`). Filters the audit contract
 * supports natively — `action`, `from`, `to` — are PUSHED DOWN to the source
 * so the traversal reads only the eligible events, while `sources`,
 * `outcome` and `actorId` still narrow the merged set server-side.
 */
const MAX_CORRELATED_IDS = 200;
const AUDIT_PAGE_LIMIT = 100;
const MAX_AUDIT_PAGES_PER_ID = 50;

/**
 * The audit item type, derived THROUGH the gateway's signature — never
 * imported from `platform/audit/audit.contract` (gate I8 pins that import to
 * the gateway and relay alone).
 */
type GatewayAuditItem = Extract<
  Awaited<ReturnType<CommerceAuditGateway['read']>>,
  { status: 'ok' }
>['page']['items'][number];

export type PurchaseHistorySource = 'status' | 'audit' | 'posting';
export type PurchaseHistoryOutcome = 'succeeded' | 'failed' | 'pending';

export interface PurchaseHistoryItem {
  id: string;
  /** The event instant — the source row's own clock, ISO-8601. */
  occurredAt: string;
  /** Which truth source produced this item. */
  source: PurchaseHistorySource;
  /**
   * A stable, searchable type code: `status.<TO>` for transitions, the audit
   * `action` for audit events, `posting.<kind>.<status>` for diagnostics.
   */
  action: string;
  /** The acting user where the source recorded one — else null. */
  actorUserId: string | null;
  /**
   * The actor's CURRENT directory profile, resolved in one batch for the
   * page — `null` when the id resolves to nobody (a departed user is a
   * normal historical state, never a fabricated name). It is the profile as
   * it reads TODAY, not a snapshot of the name at event time; consumers
   * must not render it as historical evidence.
   */
  actorProfile?: DirectoryUserProfile | null;
  outcome: PurchaseHistoryOutcome;
  /** Status transitions only. */
  fromStatus?: string | null;
  toStatus?: string;
  /** Audit events only — the platform resource coordinates. */
  resource?: string;
  resourceId?: string;
  changedFields?: string[];
  reason?: string | null;
  /** Posting diagnostics only. */
  postingStatus?: string;
  attempts?: number;
  lastError?: string | null;
  movementId?: string | null;
  /** Attempt-granularity items: the posting this attempt belongs to + ordinal. */
  postingId?: string;
  attemptNo?: number;
}

export interface PurchaseHistoryCoverage {
  statusEvents: { complete: true; earliest: string | null };
  audit:
    | {
        status: 'ok';
        truncatedFamilies: string[];
        /** Audit events actually collected before merge — evidence, not a guess. */
        eventsRead: number;
        /** The traversal bounds that still apply — never silently complete. */
        bounds: { maxCorrelatedIds: number; maxPagesPerResource: number };
      }
    | { status: 'unavailable'; code: string };
  postings: { status: 'ok' };
}

@Injectable()
export class PurchaseHistoryService {
  private readonly logger = new Logger(PurchaseHistoryService.name);

  constructor(
    private readonly repository: PurchaseRepository,
    private readonly history: PurchaseHistoryRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly identity: CommerceIdentityGateway
  ) {}

  async getHistory(actor: CommerceActor, id: string, query: PurchaseHistoryQueryDto) {
    const document = await this.repository.findDocumentById(actor.tenantId, id);
    if (!document) throw new NotFoundException('Purchase document not found');

    // ---- source 1: the persisted status-transition stream ------------------
    const statusEvents = await this.repository.listStatusEvents(actor.tenantId, id);
    const statusItems: PurchaseHistoryItem[] = statusEvents.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      source: 'status',
      action: `status.${event.toStatus.toLowerCase()}`,
      actorUserId: event.actorUserId,
      outcome: 'succeeded',
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
    }));

    // ---- source 3 first (the ids it needs are also the audit correlation) --
    const lineIds = await this.history.listLineIds(actor.tenantId, id);
    const postings = await this.history.listPostings(actor.tenantId, lineIds);
    const postingItems: PurchaseHistoryItem[] = postings.map((posting) => ({
      id: posting.id,
      occurredAt: (posting.lastAttemptAt ?? posting.createdAt).toISOString(),
      source: 'posting',
      action: `posting.${posting.kind.toLowerCase()}.${posting.status.toLowerCase()}`,
      actorUserId: null,
      outcome:
        posting.status === 'POSTED'
          ? 'succeeded'
          : posting.status === 'FAILED'
            ? 'failed'
            : 'pending',
      postingStatus: posting.status,
      attempts: posting.attempts,
      lastError: posting.lastError,
      movementId: posting.movementId,
      resourceId: posting.sourceLineId,
    }));

    // ---- source 3b: the append-only ATTEMPT stream -------------------------
    // One item per ledger call — the retry story the posting row's `attempts`
    // counter only summarizes. Actor, interval and the verbatim refusal are
    // the attempt row's own persisted fields; nothing is reconstructed.
    const attempts = await this.history.listAttempts(
      actor.tenantId,
      postings.map((posting) => posting.id)
    );
    const postingById = new Map(postings.map((posting) => [posting.id, posting]));
    const attemptItems: PurchaseHistoryItem[] = attempts.map((attempt) => {
      const posting = postingById.get(attempt.postingId);
      return {
        id: attempt.id,
        occurredAt: attempt.finishedAt.toISOString(),
        source: 'posting',
        action: `posting.attempt.${attempt.result.toLowerCase()}`,
        actorUserId: attempt.actorUserId,
        outcome: attempt.result === 'FAILED' ? 'failed' : 'succeeded',
        postingStatus: posting?.status,
        postingId: attempt.postingId,
        attemptNo: attempt.attempt,
        lastError: attempt.error,
        movementId: attempt.movementId,
        resourceId: posting?.sourceLineId,
      };
    });

    // ---- source 2: the platform audit trail, correlated by real ids --------
    const [receipts, returns, plans, assignments, approvals, quotations] = await Promise.all([
      this.history.listReceipts(actor.tenantId, id),
      this.history.listReturns(actor.tenantId, id),
      this.history.listPlans(actor.tenantId, id),
      this.history.listAssignments(actor.tenantId, id),
      this.history.listApprovals(actor.tenantId, id),
      this.history.listQuotations(actor.tenantId, id),
    ]);
    const families: Array<{ resource: string; ids: string[]; name: string }> = [
      {
        name: 'purchase_document',
        resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
        ids: [document.id],
      },
      {
        name: 'payment_record',
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD,
        ids: [document.id],
      },
      {
        name: 'receipt',
        resource: COMMERCE_AUDIT_RESOURCE.RECEIPT,
        ids: receipts.map((row) => row.id),
      },
      {
        name: 'return_document',
        resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
        ids: returns.map((row) => row.id),
      },
      {
        name: 'payment_plan',
        resource: COMMERCE_AUDIT_RESOURCE.PAYMENT_PLAN,
        ids: plans.map((row) => row.id),
      },
      {
        name: 'commercial_assignment',
        resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_ASSIGNMENT,
        ids: assignments.map((row) => row.id),
      },
      {
        name: 'commercial_approval',
        resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_APPROVAL,
        ids: approvals.map((row) => row.id),
      },
      {
        name: 'price_quotation',
        resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
        ids: quotations.map((row) => row.id),
      },
    ];

    const auditItems: PurchaseHistoryItem[] = [];
    const seenAuditIds = new Set<string>();
    const truncatedFamilies: string[] = [];
    let auditUnavailable: string | null = null;
    let auditEventsRead = 0;
    for (const family of families) {
      const ids = family.ids.slice(0, MAX_CORRELATED_IDS);
      if (family.ids.length > MAX_CORRELATED_IDS) truncatedFamilies.push(family.name);
      for (const resourceId of ids) {
        // FULL traversal of this resource's trail: page until the contract's
        // own `total` is collected. The supported filters ride the read so
        // ineligible events never leave the audit store.
        for (let page = 1; page <= MAX_AUDIT_PAGES_PER_ID; page++) {
          const result = await this.audit.read({
            tenantId: actor.tenantId,
            resource: family.resource,
            resourceId,
            pageSize: AUDIT_PAGE_LIMIT,
            page,
            // Source-pushed filters: the contract answers only eligible events.
            action: query.action ?? undefined,
            from: query.from ?? undefined,
            to: query.to ?? undefined,
          });
          if (result.status === 'rejected') {
            // One failed family read degrades the whole audit source honestly:
            // partial audit trails cannot be distinguished from complete ones.
            this.logger.error(
              `History audit read rejected (${family.resource} ${resourceId}): ${result.code}`
            );
            auditUnavailable = result.code;
            break;
          }
          for (const item of result.page.items) {
            if (!seenAuditIds.has(item.id)) {
              seenAuditIds.add(item.id);
              auditItems.push(PurchaseHistoryService.projectAudit(item));
            }
          }
          auditEventsRead += result.page.items.length;
          if (result.page.page * result.page.pageSize >= result.page.total) break;
          if (page === MAX_AUDIT_PAGES_PER_ID) {
            truncatedFamilies.push(`${family.name}:${resourceId}`);
          }
        }
        if (auditUnavailable !== null) break;
      }
      if (auditUnavailable !== null) break;
    }

    const coverage: PurchaseHistoryCoverage = {
      statusEvents: {
        complete: true,
        earliest: statusEvents.length > 0 ? statusEvents[0].occurredAt.toISOString() : null,
      },
      audit:
        auditUnavailable === null
          ? {
              status: 'ok',
              truncatedFamilies,
              eventsRead: auditEventsRead,
              bounds: {
                maxCorrelatedIds: MAX_CORRELATED_IDS,
                maxPagesPerResource: MAX_AUDIT_PAGES_PER_ID,
              },
            }
          : { status: 'unavailable', code: auditUnavailable },
      postings: { status: 'ok' },
    };

    // ---- merge, filter, order, page — all server-side -----------------------
    const wantedSources = new Set(
      (query.sources ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is PurchaseHistorySource =>
          s === 'status' || s === 'audit' || s === 'posting'
        )
    );

    let items = [...statusItems, ...auditItems, ...postingItems, ...attemptItems];
    if (wantedSources.size > 0) items = items.filter((i) => wantedSources.has(i.source));
    if (query.outcome) items = items.filter((i) => i.outcome === query.outcome);
    if (query.action) items = items.filter((i) => i.action === query.action);
    if (query.actorId) items = items.filter((i) => i.actorUserId === query.actorId);
    if (query.from) items = items.filter((i) => i.occurredAt >= query.from!);
    if (query.to) items = items.filter((i) => i.occurredAt < query.to!);

    items.sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1));

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const total = items.length;
    const paged = items.slice((page - 1) * pageSize, page * pageSize);

    // ---- actor enrichment: ONE batched directory read for the page --------
    // Absent ids stay absent — a departed actor keeps its raw id and never a
    // fabricated name (the profile is current identity, not event-time truth).
    const profiles = await this.identity.profilesFor(paged.map((item) => item.actorUserId));
    for (const item of paged) {
      item.actorProfile = item.actorUserId ? profiles.get(item.actorUserId) ?? null : null;
    }

    return { items: paged, page, pageSize, total, coverage };
  }

  private static projectAudit(item: GatewayAuditItem): PurchaseHistoryItem {
    return {
      id: item.id,
      occurredAt: item.createdAt,
      source: 'audit',
      action: item.action,
      actorUserId: item.actorId,
      outcome: item.success ? 'succeeded' : 'failed',
      resource: item.resource,
      resourceId: item.resourceId,
      changedFields: item.changedFields,
      reason: item.reason,
    };
  }
}
