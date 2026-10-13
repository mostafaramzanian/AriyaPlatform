import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  USER_DIRECTORY,
  type UserDirectoryContract,
} from '../../../platform/user-directory/user-directory.contract';
import { ProductionAuditGateway } from '../production-audit.gateway';
import { PRODUCTION_AUDIT_RESOURCE } from '../production.constants';
import { BomHeaderRepository } from './bom.repository';
import type { BomHeaderPatchInput, BomHeaderRecord } from './bom.repository';
import { BOM_MANAGER_OPINION_LABELS, bomStatusAfter, isBomHeaderEditable } from './bom-status';
import type { BomManagerOpinion } from './bom-status';
// Phase PRODUCTION-BOM-ITEM: the EMPTY-BOM submit gate's typed code. Only the CODE is
// imported — never an item type — so the header slice stays free of the item aggregate's
// shape while still sharing the one vocabulary the UI maps errors by.
import { PRODUCTION_BOM_ERROR_CODES } from './bom-item';
import {
  resolveProductionPageWindow,
  resolveProductionTimelineWindow,
  type BomHeaderView,
  type BomTimelineQueryDto,
  type CreateBomHeaderDto,
  type DecideBomHeaderDto,
  type ListBomHeadersQueryDto,
  type UpdateBomHeaderDto,
} from './bom.dto';

/**
 * Phase PRODUCTION-BOM-HEADER: the BOM Header slice's application surface — create, read,
 * list, update-while-editable, submit and the three decision acts.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * ----------------------------------------
 * It owns ORCHESTRATION and the rules that need more than one fact: tenant scoping,
 * approver membership, self-approval, the freeze at submit, and the audit trail. It
 * issues NO raw Prisma query and holds no client — persistence is
 * `BomHeaderRepository`'s, which is what keeps the tenant predicate and the conditional
 * status writes in a single reviewable file.
 *
 * THE TENANT COMES FROM THE ACTOR, ALWAYS. Every method takes `ProductionActor` and
 * passes `actor.tenantId` as the repository's first argument. No DTO carries a tenant
 * field, no method accepts one, and no lookup is by id alone — so there is no shape of
 * these routes that reads another tenant's BOM.
 *
 * IDENTITY IS REACHED THROUGH THE PLATFORM PORT, NEVER DIRECTLY. One need: "is this id a
 * member of my tenant?" before a requester or an approver id is STORED. That is
 * `USER_DIRECTORY.findTenantMember`'s question, answered against Core's identity tables by
 * the platform adapter — never by a join, because Production's database cannot see them.
 *
 * ONE TRAIL, AND ONLY AFTER A WRITE SUCCEEDED. The audit gateway is handed the row the
 * repository RETURNED, never the intent that produced it: a trail recording what a caller
 * meant to write would disagree with `production_db` the first time a conditional write
 * refused one. The call decides nothing — the write is already committed by then — and it
 * cannot turn a completed mutation into a failure (`ProductionAuditGateway` logs and
 * swallows).
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 *  * NO duplicate-part-name rule, NO total-consumption formula, NO `standardPartCode`
 *    generation or requiredness. Each of those is either a rule whose SCOPE the source
 *    does not establish (duplicate part name is scoped "within the project"), a rule the
 *    source never performs (no total), or a rule BLOCKED on Product Tree Code (RB-1-P).
 *    This file does not fake any of them: there is no `hasItems` placeholder, no computed
 *    sum and no minted code.
 *  * NO workflow engine, NO reach into Commerce's `WorkflowInstance`, NO notification
 *    (the recipient set for a BOM decision is a later phase's decision).
 *
 * WHAT THIS FILE DOES ANSWER, THAT IT ONCE DEFERRED
 * -------------------------------------------------
 * "May a BOM be submitted?" now includes "does it have at least one item?". The check is
 * NOT a count here: it is the `items: { some: {} }` predicate inside the repository's
 * conditional UPDATE, so the rule and the transition are one statement. The block below
 * turns a refusal that lands while the row is STILL a DRAFT into
 * `BOM_SUBMIT_ITEMS_REQUIRED` — the typed form of the source's V8 message
 * `اقلامی ثبت نشده است!`.
 */

/** The audit `action` values this slice records. Lowercase verbs, like HR's and Commerce's. */
export const PRODUCTION_BOM_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  SUBMIT: 'submit',
  APPROVE: 'approve',
  REJECT: 'reject',
  REQUEST_CORRECTION: 'request_correction',
} as const;

/** The actor shape this service needs — structurally `ProductionActor`. */
interface BomActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: ONE entry of the BOM's audit timeline, as this
 * module exposes it.
 *
 * AN EXPLICIT WHITELIST OF SEVEN FIELDS, for the reason Commerce's
 * `PurchaseTimelineItem` states: the platform's `AuditReadItem` is a CONTRACT, not a
 * ceiling, so spreading it through would publish any field the platform later adds
 * without this module ever deciding it is safe for this surface. The fields below are
 * copied one-by-one from the platform projection — `id`, `action`, `actorId`, `success`,
 * `reason`, `changedFields`, `createdAt` — and nothing else.
 *
 * WHAT IS ABSENT BY CONSTRUCTION, not by filtering: `tenantId` (the scope does not belong
 * in data), `ip`, `userAgent`, `sessionId`, `requestId`, `correlationId`, `oldValue`,
 * `newValue`, `changes` — the platform's read implementation does not even SELECT them,
 * so no redaction here could leak what was never fetched. There is no raw payload on
 * this type because there is no raw payload in the projection.
 *
 * `resource` and `resourceId` are deliberately NOT echoed. Every entry in this page
 * shares the one server-bound pair the request already established
 * (`production.bom` + this BOM's id), so repeating them would be noise — and echoing
 * `resourceId` would be the one place a future caller could mistake an echo for a
 * request field it is allowed to set.
 *
 * `action` is the RAW audit vocabulary (lowercase verb). Presentation is the UI's
 * (`production-labels.ts`), never a rewriting of the trail: the API must not decide the
 * Persian sentence for an event it only stored.
 */
export interface BomTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

/**
 * One page of that timeline — the `{ items, page, pageSize, total }` envelope every
 * Production list already returns, so a client needs no second paging idiom.
 *
 * `total` is the platform's own count for THIS resource binding, never a sum the module
 * computed, and `page`/`pageSize` are echoed from the resolved window so a client can
 * render "صفحه ۲ از ۵" without re-deriving what it asked for.
 */
export interface BomTimelinePage {
  items: BomTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** Projects a stored row onto the wire shape. No derived field, no label. */
export function toBomHeaderView(row: BomHeaderRecord): BomHeaderView {
  return {
    id: row.id,
    title: row.title,
    projectRef: row.projectRef,
    productTreeRef: row.productTreeRef,
    requesterUserId: row.requesterUserId,
    approverUserId: row.approverUserId,
    status: row.status,
    managerOpinion: row.managerOpinion,
    comments: row.comments,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class BomHeaderService {
  /**
   * The module's own logger, used for ONE purpose on this surface: recording that the
   * platform refused a timeline read, with the platform's CLOSED code.
   *
   * It is not here for business logging. The gateway already logs a transport failure on
   * its side; what this adds is the correlation between a SPECIFIC BOM and the refusal,
   * so "this BOM's history 503'd" is one log line rather than a guess made from a port
   * error with no resource attached. A rejection is never silently converted into an
   * empty timeline, and this line is what proves that distinction was observed.
   */
  private readonly logger = new Logger(BomHeaderService.name);

  constructor(
    private readonly repository: BomHeaderRepository,
    private readonly audit: ProductionAuditGateway,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectoryContract
  ) {}

  /**
   * Creates a BOM header for the acting tenant.
   *
   * TWO IDENTITIES ARE VERIFIED, NOT TRUSTED. `requesterUserId` and `approverUserId` are
   * STATED by the caller (a delegate may raise a BOM for somebody else — the legacy form
   * allowed exactly that) and then checked against the acting tenant. An id that is not a
   * member is a 400 naming the field, never a stored reference to a stranger: nothing
   * inside `production_db` can check that, because there is no foreign key across
   * databases by design.
   *
   * SELF-APPROVAL IS REFUSED HERE (M-5b §5.6). The source has no such guard — a search for
   * one returned nothing — so the brief's own rule governs: an actor may not approve their
   * own request unless the business explicitly opts in, and V1 does not. Refusing is the
   * fail-closed direction, and permitting it later is a one-line change.
   */
  async create(actor: BomActor, dto: CreateBomHeaderDto): Promise<BomHeaderView> {
    await this.assertTenantMember(actor.tenantId, dto.requesterUserId, 'requesterUserId');
    await this.assertTenantMember(actor.tenantId, dto.approverUserId, 'approverUserId');
    this.assertNotSelfApproval(dto.requesterUserId, dto.approverUserId);

    const row = await this.repository.create(actor.tenantId, {
      title: dto.title.trim(),
      projectRef: dto.projectRef,
      productTreeRef: dto.productTreeRef,
      requesterUserId: dto.requesterUserId,
      approverUserId: dto.approverUserId,
      comments: dto.comments ?? null,
    });

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_AUDIT_ACTION.CREATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: row.id,
      newValue: { status: row.status, projectRef: row.projectRef },
    });

    return toBomHeaderView(row);
  }

  /** One page of the acting tenant's BOM headers. */
  async list(
    actor: BomActor,
    query: ListBomHeadersQueryDto
  ): Promise<{ items: BomHeaderView[]; total: number; page: number; pageSize: number }> {
    const window = resolveProductionPageWindow(query);

    const { items, total } = await this.repository.list(actor.tenantId, {
      skip: window.skip,
      take: window.take,
      status: query.status,
      search: query.search,
    });

    return {
      items: items.map(toBomHeaderView),
      total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /** One BOM header of the acting tenant, or 404. */
  async getOne(actor: BomActor, id: string): Promise<BomHeaderView> {
    return toBomHeaderView(await this.requireRow(actor.tenantId, id));
  }

  /**
   * Phase PRODUCTION-BOM-AUDIT-TIMELINE: ONE page of this BOM's audit history, in the
   * platform's authoritative order (`createdAt ASC, id ASC`).
   *
   * THE SCOPE IS EXACTLY ONE RESOURCE, BOUND SERVER-SIDE — and this is the entire safety
   * of the route. Every query this method issues is
   *
   *     tenantId   = actor.tenantId          (from `resolveProductionActor`)
   *     resource   = 'production.bom'        (the closed vocabulary constant)
   *     resourceId = row.id                  (resolved tenant-scoped by `requireRow`)
   *
   * — and nothing else. None of the three is a request input: the DTO carries only
   * `page`/`pageSize`, `:id` is parsed as a UUID v4 at the edge, and the actor comes from
   * the session. There is therefore no shape of this endpoint that reads another tenant's
   * trail, that pivots the query to a foreign resource type, or that turns an audit read
   * into a cross-tenant existence oracle.
   *
   * WHY ONLY THE `production.bom` FAMILY (Commerce's C7 decision, restated here)
   * --------------------------------------------------------------------------
   * `production.bom.item` events are recorded with the ITEM's own id as `resourceId`; the
   * parent `bomId` travels only inside `oldValue`/`newValue` JSON — and the platform read
   * contract deliberately has NO JSON predicate ("no metadata or JSON predicate, no ORDER
   * BY parameter"). C7 met the identical situation (payment, receipt, return and
   * assignment events carry the document id only in payload) and answered it the same
   * way: a truthful PARTIAL timeline returning exactly the one family it can
   * authoritatively correlate, implying nothing more.
   *
   * Enumerating this BOM's item ids from `production_db` to reach that family would be
   * WORSE than partial, which is why it is not done:
   *   * an item DELETE is a HARD delete, so a removed item's id is unrecoverable — its
   *     `create`, `update` and `delete` events would all become unreachable and the
   *     timeline would silently assert the item never existed;
   *   * one read per item cannot produce ONE honest `{ page, pageSize, total }`: the
   *     contract bounds each read, not the union, so a merged page would have to
   *     materialise everything and invent a count.
   * Letting `AuditReadQuery` filter on a correlation field is a PLATFORM contract
   * decision, not this module's to invent — a blocked surface, not an omission.
   *
   * ORDERING IS THE CONTRACT'S, AND IS NOT REVERSED HERE. The platform returns
   * `createdAt ASC, id ASC` — chronological, total (the id breaks ties) and stable under
   * appends. Presenting newest-first is a VIEW's decision to make explicitly; flipping it
   * inside the API would hide the fact that the trail's own order is authoritative, and
   * would need a second ordering opinion the read contract has no parameter for.
   *
   * EMPTY IS NOT FAILED. Zero events answers `items: []` with the platform's `total` —
   * "nothing was recorded under this binding". A REJECTED read is a 503 (422 for a caller
   * fault), never a quiet empty page: the two states mean opposite things and a client
   * must be able to tell them apart.
   *
   * ARCHITECTURE (the only path allowed):
   *   Controller → resolveProductionActor → this service → BomHeaderRepository (existence)
   *             → ProductionAuditGateway.read → AUDIT_PORT.read → Platform Audit → core_db
   * Never Core Prisma, never `AuditLog`, never a Production audit mirror, never a
   * reconstruction from `BomHeader`/`BomItem` rows.
   */
  async getTimeline(
    actor: BomActor,
    id: string,
    query: BomTimelineQueryDto
  ): Promise<BomTimelinePage> {
    // EXISTENCE FIRST, TENANT-SCOPED, AND IT IS A 404 — not a 403 and not an empty page.
    // A BOM another tenant owns (or no tenant at all) must be indistinguishable from one
    // that does not exist, so the audit boundary is only ever reached for a row this
    // tenant owns.
    const row = await this.requireRow(actor.tenantId, id);
    const window = resolveProductionTimelineWindow(query);

    const result = await this.audit.read({
      tenantId: actor.tenantId,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      // The diagnostic classification is preserved: the CLOSED platform code is logged
      // and carried to the client, never an internal message and never a fabricated
      // `items: []`.
      this.logger.error(`Audit read rejected for BOM ${row.id}: ${result.code}`);

      if (result.code === 'AUDIT_READ_FAILED') {
        throw new ServiceUnavailableException({
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        });
      }

      // The caller-fault codes are unreachable through this route — the DTO validates
      // `page`/`pageSize` and the service binds the scope — but they are mapped per
      // P-AUDIT-READ rather than swallowed: a rejected read is never an empty timeline.
      throw new UnprocessableEntityException({
        code: result.code,
        message: 'The audit read query was rejected by the platform.',
      });
    }

    return {
      items: result.page.items.map(BomHeaderService.projectTimelineItem),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
  }

  /**
   * The BOM timeline projection — an EXPLICIT WHITELIST, so the response exposes exactly
   * the seven fields documented on `BomTimelineItem` and nothing else the platform item
   * happens to carry.
   *
   * A whitelist rather than a deny-list because the platform projection is a CONTRACT,
   * not a ceiling: the day it adds a field, a spread-through would publish it without
   * this module ever deciding it is safe for this surface. The parameter is typed
   * STRUCTURALLY for the reason Commerce's `PurchaseTimelineService.project` is —
   * `AuditReadItem` is a value this method consumes, not a token this module holds, so
   * the ONE audit seam stays exactly where `production-isolation.spec.ts` puts it.
   *
   * `resource`/`resourceId` are omitted (every entry shares the one server-bound pair the
   * request already established), and every field the contract calls out as
   * absent-by-construction — `tenantId`, `ip`, `userAgent`, `sessionId`, `requestId`,
   * `correlationId`, `oldValue`, `newValue`, `changes` — is not named here at all.
   */
  private static projectTimelineItem(item: {
    id: string;
    action: string;
    actorId: string | null;
    success: boolean;
    reason: string | null;
    changedFields: string[];
    createdAt: string;
  }): BomTimelineItem {
    return {
      id: item.id,
      action: item.action,
      actorId: item.actorId,
      success: item.success,
      reason: item.reason,
      changedFields: item.changedFields,
      createdAt: item.createdAt,
    };
  }

  /**
   * Patches a DRAFT header. 409 once it has been submitted.
   *
   * AN EMPTY PATCH IS A 400. `updatedAt` only moves on a real write, so an audit row for
   * a mutation that changed nothing would make the trail unable to distinguish a no-op
   * from a real edit — and `changedFields` would be an empty list nothing can act on.
   *
   * THE APPROVER MAY BE RE-CHOSEN HERE, AND ONLY HERE. While the row is a DRAFT the
   * approver is still a pending routing decision (the legacy form behaves the same way:
   * the field is editable during authoring and frozen afterwards). A new approver is
   * membership-checked and self-approval-checked against the row's OWN requester, and the
   * change is audited with the before/after pair — so "who was asked" is answerable for
   * the moment before the freeze.
   */
  async update(actor: BomActor, id: string, dto: UpdateBomHeaderDto): Promise<BomHeaderView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (!isBomHeaderEditable(current.status)) {
      throw new ConflictException(
        `This BOM is ${current.status} and can no longer be edited; only a DRAFT is editable.`
      );
    }

    const patch: BomHeaderPatchInput = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.projectRef !== undefined) patch.projectRef = dto.projectRef;
    if (dto.productTreeRef !== undefined) patch.productTreeRef = dto.productTreeRef;
    if (dto.comments !== undefined) patch.comments = dto.comments;

    if (dto.approverUserId !== undefined) {
      await this.assertTenantMember(actor.tenantId, dto.approverUserId, 'approverUserId');
      this.assertNotSelfApproval(current.requesterUserId, dto.approverUserId);
      patch.approverUserId = dto.approverUserId;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('State at least one field to change.');
    }

    const updated = await this.repository.updateDraft(actor.tenantId, id, patch);

    if (!updated) {
      // The conditional write lost a race with a concurrent transition. Re-read so the
      // refusal names the CURRENT status instead of guessing what changed.
      const now = await this.requireRow(actor.tenantId, id);
      throw new ConflictException(
        `This BOM is ${now.status} and can no longer be edited; only a DRAFT is editable.`
      );
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_AUDIT_ACTION.UPDATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: updated.id,
      oldValue: { title: current.title, approverUserId: current.approverUserId },
      newValue: { title: updated.title, approverUserId: updated.approverUserId },
      changedFields: Object.keys(patch),
    });

    return toBomHeaderView(updated);
  }
/**
   * Submits a DRAFT for decision: DRAFT → SUBMITTED, once.
   *
   * THE FREEZE POINT, AND WHY IT IS THIS METHOD. `submit` is the transition after which
   * the header is read-only for ordinary editing (M-5: "`submit` freezes the BOM Header
   * against ordinary editing"). The repository's conditional write carries
   * `status: 'DRAFT'` in its WHERE clause, so a second submit — or a submit racing an edit
   * — loses rather than both winning.
   *
   * THE APPROVER IS RE-VERIFIED AT THE FREEZE, NOT ONLY AT CREATE. Between creation and
   * submission a person can leave the tenant, and M-5b's rule is that the approver must be
   * a valid TENANT MEMBER. Re-checking here means a row is never routed to somebody who
   * can no longer act — the concrete meaning of the source's own refusal to submit when
   * the manager's system account could not be resolved
   * (`یوزر مدیر پروژه در سامانه ست نشده است`).
   *
   * THE EMPTY-BOM GATE, AND WHERE IT LIVES. `repository.submit` carries
   * `items: { some: {} }` inside the same conditional UPDATE, so "a BOM with no items
   * cannot be submitted" and the DRAFT→SUBMITTED transition are ONE atomic statement —
   * not a count read followed by a write that a concurrent DELETE could invalidate. That
   * is the source's V8 rule (`اقلامی ثبت نشده است!`) expressed as a typed domain refusal
   * rather than a UI-only string, which is what the block below distinguishes.
   */
  async submit(actor: BomActor, id: string): Promise<BomHeaderView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (bomStatusAfter(current.status, 'SUBMIT') !== 'SUBMITTED') {
      throw new ConflictException(
        `This BOM is ${current.status} and cannot be submitted; only a DRAFT can.`
      );
    }

    if (!current.approverUserId) {
      // Structurally impossible: create requires it and the schema's CHECK refuses a
      // non-DRAFT row without one. Stated anyway, because the error it would otherwise
      // produce is a routing decision with nobody to route to.
      throw new ConflictException('This BOM has no approver and cannot be submitted.');
    }

    await this.assertTenantMember(actor.tenantId, current.approverUserId, 'approverUserId');

    // Phase B2.4: build the durable outbox payload BEFORE the write.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PRODUCTION_BOM_AUDIT_ACTION.SUBMIT,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: 'SUBMITTED', approverUserId: current.approverUserId },
      changedFields: ['status', 'submittedAt'],
    });

    const updated = await this.repository.submit(actor.tenantId, id, current.comments, outbox);

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);

      if (isBomHeaderEditable(now.status)) {
        // Still a DRAFT and in this tenant, so the ONLY predicate the conditional write
        // could have failed on is `items: { some: {} }` — the BOM holds no rows. Told as
        // a 400 (the payload/rule is wrong, not the state) carrying a typed code, so the
        // UI maps it to «اقلامی ثبت نشده است!» by identifier instead of by sentence.
        throw new BadRequestException({
          code: PRODUCTION_BOM_ERROR_CODES.ITEMS_REQUIRED,
          message: 'A BOM must contain at least one item before it can be submitted.',
        });
      }

      throw new ConflictException(
        `This BOM is ${now.status} and cannot be submitted; only a DRAFT can.`
      );
    }

    return toBomHeaderView(updated);
  }
/**
   * The decision acts: approve, reject and request-correction.
   *
   * ONE METHOD, THREE ROUTES, AND THE OUTCOME IS FIXED BY THE ROUTE. `expected` is the
   * opinion the endpoint stands for, so the reject route cannot produce an APPROVED row
   * even if a client sends `opinion: "APPROVED"` — a mismatch is a 400 rather than a body
   * field that silently rewrites the meaning of the call.
   *
   * ONLY THE SNAPSHOTTED APPROVER MAY DECIDE (M-5b §5.4). The check is
   * `actor.userId === row.approverUserId` — an equality against the STORED, FROZEN value,
   * never a re-resolution from a hierarchy. A `null` actor id (a machine caller) cannot
   * equal a stored id, so a non-human caller is refused by construction rather than by a
   * separate branch.
   *
   * A CORRECTION MOVES THE ROW BACK TO `DRAFT`, exactly what the legacy approval task's
   * `نیاز به اصلاح` branch did (`item.State = 0`). The DECISION is still recorded
   * (`managerOpinion = NEEDS_CORRECTION`, decider, instant), so "returned for correction"
   * stays distinguishable from "never submitted" — which is why no fifth state is needed.
   *
   * THE APPROVER'S OWN MEMBERSHIP IS NOT RE-CHECKED HERE. It was verified at create and
   * again at submit; re-asking at decision time would let an identity change between those
   * two flip a decision the frozen-approver rule deliberately protects.
   */
  async decide(
    actor: BomActor,
    id: string,
    expected: BomManagerOpinion,
    dto: DecideBomHeaderDto
  ): Promise<BomHeaderView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (dto.opinion !== expected) {
      throw new BadRequestException(
        `This endpoint records "${BOM_MANAGER_OPINION_LABELS[expected]}"; the body states "${BOM_MANAGER_OPINION_LABELS[dto.opinion]}".`
      );
    }

    const action =
      expected === 'APPROVED'
        ? ('APPROVE' as const)
        : expected === 'REJECTED'
          ? ('REJECT' as const)
          : ('REQUEST_CORRECTION' as const);

    const next = bomStatusAfter(current.status, action);
    if (next === null) {
      throw new ConflictException(
        `This BOM is ${current.status} and cannot be decided; only a SUBMITTED BOM can.`
      );
    }

    if (!actor.userId || actor.userId !== current.approverUserId) {
      throw new ForbiddenException('Only the approver recorded on this BOM may decide it.');
    }

    // Phase B2.4: build the durable outbox payload BEFORE the write.
    const auditAction =
      expected === 'APPROVED'
        ? PRODUCTION_BOM_AUDIT_ACTION.APPROVE
        : expected === 'REJECTED'
          ? PRODUCTION_BOM_AUDIT_ACTION.REJECT
          : PRODUCTION_BOM_AUDIT_ACTION.REQUEST_CORRECTION;

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: auditAction,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM,
      resourceId: id,
      oldValue: { status: current.status, managerOpinion: current.managerOpinion },
      newValue: { status: next, managerOpinion: expected },
      changedFields: ['status', 'managerOpinion', 'decidedAt', 'decidedByUserId'],
    });

    const updated = await this.repository.decide(actor.tenantId, id, 'SUBMITTED', {
      status: next,
      managerOpinion: expected,
      comments: dto.comments ?? current.comments,
      decidedByUserId: actor.userId,
    }, outbox);

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);
      throw new ConflictException(
        `This BOM is ${now.status} and cannot be decided; only a SUBMITTED BOM can.`
      );
    }

    return toBomHeaderView(updated);
  }

  // ---------------------------------------------------------------------------
  // PRIVATE RULES — the two facts this slice needs and cannot get from its own
  // database: a row of THIS tenant, and a person of THIS tenant.
  // ---------------------------------------------------------------------------

  /** One row of the acting tenant, or 404. Never a read by id alone. */
  private async requireRow(tenantId: string, id: string): Promise<BomHeaderRecord> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) {
      // A row of another tenant is INDISTINGUISHABLE from one that does not exist — by
      // design, so the answer cannot confirm that an id exists elsewhere.
      throw new NotFoundException('BOM not found.');
    }
    return row;
  }

  /**
   * Asserts the id is a member of the acting tenant, or refuses with a 400 naming the
   * field.
   *
   * WHY 400 AND NOT 403: this is a statement about the PAYLOAD, not about the caller's
   * rights. The caller may hold every permission there is and still name somebody who is
   * not in their tenant — that is a malformed request, in the same class as a missing
   * required field.
   *
   * WHY THE ANSWER IS A BOOLEAN AND NOT A DISCLOSURE: `findTenantMember` returns a profile
   * for a member and `null` otherwise, so a probing caller learns "not mine" rather than
   * "belongs to somebody else" — the distinction the platform contract records for exactly
   * this reason.
   */
  private async assertTenantMember(
    tenantId: string,
    userId: string,
    field: string
  ): Promise<void> {
    const member = await this.directory.findTenantMember(tenantId, userId);
    if (!member) {
      throw new BadRequestException(`${field} is not a member of this tenant, or does not exist.`);
    }
  }

  /**
   * Refuses a BOM whose requester and approver are the same person (M-5b §5.6).
   *
   * THE SOURCE HAS NO SUCH RULE, so this is a DECISION, not a discovery: the search for a
   * self-approval guard across all eight legacy files returned nothing. The brief's own
   * instruction governs — "actor cannot approve unless the business rule explicitly
   * permits self-approval" — and V1 does not permit it. The check compares the two
   * identity VALUES rather than "the actor versus the requester", because a delegate may
   * create a BOM whose requester is somebody else, and the rule being protected is about
   * the row's two roles rather than about who happened to call the API.
   */
  private assertNotSelfApproval(requesterUserId: string, approverUserId: string): void {
    if (requesterUserId === approverUserId) {
      throw new BadRequestException(
        'The approver must be a different person from the requester; self-approval is not permitted.'
      );
    }
  }
}