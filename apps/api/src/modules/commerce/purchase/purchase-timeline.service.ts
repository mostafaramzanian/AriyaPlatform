import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { PurchaseTimelineQueryDto } from './purchase.dto';
import { PurchaseRepository } from './purchase.repository';

/**
 * PHASE C7 (GAP-7): the PurchaseDocument audit timeline — the ONE read of the platform
 * audit trail this module exposes, and only for events the platform contract can
 * AUTHORITATIVELY correlate to a single document.
 *
 * THE SCOPE IS EXACTLY ONE RESOURCE, BOUND SERVER-SIDE
 * ----------------------------------------------------
 * Every query this service issues is
 *
 *     resource   = 'commerce.purchase_document'   (the closed vocabulary constant)
 *     resourceId = the document id the route addressed
 *     tenantId   = the acting tenant, from `resolveCommerceActor`
 *
 * — and nothing else. `resource`, `resourceId` and `tenantId` are NOT request inputs:
 * the route binds `:id`, the DTO carries only `page`/`pageSize`, and the actor comes
 * from the session. There is therefore no shape of this endpoint that reads another
 * tenant's trail, that pivots the query to a foreign resource type, or that turns an
 * audit read into a cross-tenant existence oracle.
 *
 * WHY ONLY `PURCHASE_DOCUMENT` EVENTS (C6 §H, P-AUDIT-READ §T)
 * -----------------------------------------------------------
 * Payment, receipt, return, assignment and approval events carry the document id only
 * inside JSON payloads the read contract deliberately does not filter on, and workflow
 * decisions are not audited at all. A truthful PARTIAL timeline is therefore the
 * honest deliverable: this service returns exactly the `commerce.purchase_document`
 * family and implies nothing more. No event is fabricated, no correlation is invented,
 * no snapshot JSON is parsed.
 *
 * EMPTY IS NOT FAILED. A successful read with zero events answers `items: []` with the
 * platform's `total` — "no recorded events under this correlation". A rejected read
 * (storage refusing, `AUDIT_READ_FAILED`) is a 503, never a quiet empty page: the two
 * states mean opposite things and a client must be able to tell them apart.
 *
 * ARCHITECTURE (the only path allowed):
 *   Controller → resolveCommerceActor → this service → PurchaseRepository (existence)
 *             → CommerceAuditGateway.read → AUDIT_PORT.read → Platform Audit → core_db
 * Never Core Prisma, never AuditLog, never a Commerce audit mirror.
 */
@Injectable()
export class PurchaseTimelineService {
  private readonly logger = new Logger(PurchaseTimelineService.name);

  constructor(
    private readonly repository: PurchaseRepository,
    private readonly audit: CommerceAuditGateway
  ) {}

  /**
   * One page of the document's audit history, in the platform's authoritative order
   * (`createdAt ASC, id ASC`) — the API does not reverse it; presentation is the UI's
   * decision to make explicitly.
   *
   * EXISTENCE IS CHECKED FIRST, TENANT-SCOPED, AND IT IS A 404 — NOT A 403 AND NOT AN
   * EMPTY PAGE. An id from another tenant (or no tenant at all) must be
   * indistinguishable from an id that does not exist, and the audit query must never
   * become the thing that answers "does this resource exist somewhere?". Only a
   * document this tenant owns reaches the audit boundary.
   */
  async getTimeline(actor: CommerceActor, id: string, query: PurchaseTimelineQueryDto) {
    const document = await this.repository.findDocumentById(actor.tenantId, id);
    if (!document) throw new NotFoundException('Purchase document not found');

    const result = await this.audit.read({
      tenantId: actor.tenantId,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: document.id,
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    });

    if (result.status === 'rejected') {
      // The diagnostic classification is preserved at this boundary: the CLOSED platform
      // code is logged and carried to the client, never an internal error message and
      // never a fabricated `items: []`.
      this.logger.error(
        `Audit read rejected for purchase document ${document.id}: ${result.code}`
      );

      if (result.code === 'AUDIT_READ_FAILED') {
        throw new ServiceUnavailableException({
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        });
      }

      // The caller-fault codes (invalid query/page/range) are unreachable through this
      // route — the DTO validates `page`/`pageSize` and the service binds the scope — but
      // they are mapped per P-AUDIT-READ §R (422 for an invalid query) rather than
      // swallowed: a rejected read is never rendered as an empty timeline.
      throw new UnprocessableEntityException({
        code: result.code,
        message: 'The audit read query was rejected by the platform.',
      });
    }

    return {
      items: result.page.items.map((item) => PurchaseTimelineService.project(item)),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
  }

  /**
   * The Commerce timeline projection — an EXPLICIT WHITELIST, so the response exposes
   * exactly these seven fields and nothing else the platform item happens to carry.
   *
   * A whitelist rather than a deny-list because the platform projection is a CONTRACT,
   * not a ceiling: the day it adds a field, a spread-through would publish it without
   * this module ever deciding that it is safe for this surface. `resource` and
   * `resourceId` are omitted as well — every item shares the one server-bound pair the
   * request already established, so echoing them would be noise, not information.
   *
   * Excluded by construction: `ip`, `userAgent`, `sessionId`, `requestId`,
   * `correlationId`, `tenantId`, `oldValue`, `newValue`, `changes`, and every raw
   * snapshot — none of them exist on `AuditReadItem`, and none are selected here.
   * `actorId` is the plain user id the platform stores (no directory enrichment, no
   * N+1 lookups) — the same identifier every Commerce read already renders.
   */
  private static project(item: {
    id: string;
    action: string;
    actorId: string | null;
    success: boolean;
    reason: string | null;
    changedFields: string[];
    createdAt: string;
  }): PurchaseTimelineItem {
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
}

/**
 * One timeline entry as this module exposes it: the platform's safe projection,
 * narrowed to the whitelist above. `createdAt` is the STORED WRITE INSTANT (ISO-8601),
 * never a claimed event time, and `action` is the raw audit vocabulary — presentation
 * labels are the UI's (`commerce-labels.ts`), never a rewriting of the trail.
 */
export interface PurchaseTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}