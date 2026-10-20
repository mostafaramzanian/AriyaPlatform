import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { resolveCommerceActor } from '../commerce-actor';
import { PurchaseService } from './purchase.service';
import { PurchaseCompletionService } from '../completion/purchase-completion.service';
import { PurchaseTimelineService } from './purchase-timeline.service';
import { PurchaseHistoryService } from './purchase-history.service';
import {
  CreatePurchaseDocumentDto,
  ListPurchaseDocumentsQueryDto,
  PurchaseTimelineQueryDto,
  PurchaseHistoryQueryDto,
  UpdatePurchaseDocumentDto,
} from './purchase.dto';

/**
 * Phase C1 Step L (§8, gates §14-F/I7–I9, §10): the purchase routes.
 *
 * THE NAMESPACE. `commerce/purchase-documents` under the application's global
 * `api/v1` prefix, which is what §8's `/api/commerce/**` means in this repository —
 * HR's `hr/missions` establishes the shape, and a Commerce-only prefix would be the
 * second route convention the module does not need.
 *
 * WHY `purchase-documents` AND NOT `purchases`. The path names the ROW the calls address
 * (`PurchaseDocument`, §5.1), and C1 grows three more things a caller may call a
 * "purchase": its payment history (step Q), its receipts (step R) and its returns
 * (step S). Those hang off this document — `/purchase-documents/:id/...` — so the
 * collection that owns the id has exactly one meaning, and a route added later cannot
 * be ambiguous about which one it meant.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. That is all: no rule, no
 * status decision, no query, no audit call, no notification. Every ordering decision in
 * this file is a decorator, and every one of them is a boundary statement:
 *
 *   `@RequiresModule(COMMERCE_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the
 *   requirement — they never decide it. The decision is the platform's
 *   `ModuleEntitlementGuard`, provided at the composition root, which is why the module
 *   id comes from `commerce.constants.ts` rather than from a literal here: the value
 *   must agree with the Core provisioning migration's SQL, and neither file can import
 *   the other.
 *
 *   `@Roles(Permissions.COMMERCE_*)` DECLARES who may act. `commerce.read` for the two
 *   reads, `commerce.manage` for the three writes: §10 splits reading procurement from
 *   changing it, so a caller entitled to look at a purchase request is not thereby
 *   entitled to submit one. Approval is deliberately ABSENT — `commerce.approve` means
 *   deciding a document's workflow outcome (step N), and no route here decides anything.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost
 *   check: an anonymous request is refused before anything asks what it is entitled to,
 *   and no entitlement question is ever asked about an unauthenticated caller.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source
 * of `tenantId` and `userId`; no route accepts either. A request that never resolved to
 * a tenant is refused (403) instead of being served unscoped, which is the difference
 * between a multi-tenant module and a data leak.
 */
@Controller('commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PurchaseController {
  constructor(
    private readonly purchases: PurchaseService,
    private readonly completion: PurchaseCompletionService,
    // PHASE C7 (GAP-7): the audit-timeline read — injected beside the two act services,
    // because the timeline route is a sibling of the document routes it reads for, not
    // a new controller: the collection that owns `:id` is the one that answers for it.
    private readonly timeline: PurchaseTimelineService,
    // PHASE W3.2: the aggregated traceability read — sibling of the timeline,
    // a second honest view over the same real sources.
    private readonly history: PurchaseHistoryService
  ) {}

  /** One page of the tenant's purchase documents, newest first. */
  @Get()
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListPurchaseDocumentsQueryDto) {
    return this.purchases.list(resolveCommerceActor(req), query);
  }

  /**
   * The home surface's aggregate read — declared BEFORE `@Get(':id')` so the
   * literal `summary` is never parsed as a document id by `ParseUUIDPipe` (a
   * route declared after it would answer every summary call with 400).
   */
  @Get('summary')
  @Roles(Permissions.COMMERCE_READ)
  async summary(@Request() req: ExRequest) {
    return this.purchases.summary(resolveCommerceActor(req));
  }

  /** One document, with its lines and its requester's rendering profile. */
  @Get(':id')
  @Roles(Permissions.COMMERCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.purchases.getOne(resolveCommerceActor(req), id);
  }

  /** Raise a purchase request. The number is minted server-side, inside the write. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreatePurchaseDocumentDto) {
    return this.purchases.create(resolveCommerceActor(req), dto);
  }

  /** Change a document while it is still editable (DRAFT). 409 once it is submitted. */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePurchaseDocumentDto
  ) {
    return this.purchases.update(resolveCommerceActor(req), id, dto);
  }

  /**
   * Submit a document for decision: DRAFT → SUBMITTED, once.
   *
   * `200`, not `201`: nothing is created by this route — the document's state moves, and
   * the answer is the document. A caller that retried a `201` and re-submitted would be
   * the double-routing the repository's conditional write exists to refuse.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_MANAGE)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.purchases.submit(resolveCommerceActor(req), id);
  }

  /**
   * PHASE C4-R (GAP-3): COMPLETE the purchase — the document's own status moves to
   * `CLOSED` (C1 §29), and ONLY when the tenant's published Purchase Completion Policy
   * permits that move.
   *
   * `200`, not `201`: nothing is created — the document's state moves, and the answer is
   * the document as the GET route projects it. The VERB is the transition's own
   * (`submit` → SUBMITTED, `close` → CLOSED), the same naming every other route in this
   * family uses, while the DOMAIN EVENT keeps §29's name ("completion") in the columns and
   * the audit row.
   *
   * THE WHOLE DECISION LIVES BELOW THIS LINE. `commerce.manage` is the document-write
   * remit §10 already assigns to every act that changes a purchase document (create,
   * update, submit, payments, receiving, returns) — completion is the same kind of write
   * on the same row, so it reuses the existing permission rather than inventing one. What
   * the caller MAY do is answered by the guard; WHAT the document's state permits is
   * answered by `PurchaseCompletionService` against the published policy (an unconfigured
   * tenant fails closed with its own named 409).
   *
   * NO BODY IS ACCEPTED, deliberately. The action is the route itself — the "explicit
   * completion" §29 requires is a dedicated, permissioned, policy-gated transition rather
   * than a field that could be defaulted — and §29's warning/confirmation requirement is
   * the UI's to satisfy when a close control is designed (§30 of the C4-R brief leaves
   * that to a later, explicit task). No client may state an actor, a tenant or a timestamp;
   * all three are server-derived and recorded by the act.
   */
  @Post(':id/close')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_MANAGE)
  async close(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.completion.close(resolveCommerceActor(req), id);
  }

  /**
   * REACTIVATION (GAP-6 follow-up): return a REJECTED document to DRAFT
   * (`POST commerce/purchase-documents/:id/reopen`).
   *
   * `200`, not `201`: nothing is created — the document's state moves, and the
   * answer is the document as the GET route projects it. `commerce.manage` is the
   * same document-write remit as create/update/submit/close; WHAT the document's
   * state permits (only `REJECTED`) is answered by the service against the status
   * table, so CANCELLED, CLOSED and in-flight documents are refused there with a
   * named 409 rather than by a control this page does not render yet. The
   * rejection itself is never erased — it stays on the settled workflow instance
   * and in the audit trail.
   */
  @Post(':id/reopen')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_MANAGE)
  async reopen(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.purchases.reopen(resolveCommerceActor(req), id);
  }

  /**
   * PHASE C7 (GAP-7): the purchase document's audit timeline.
   *
   * `GET /commerce/purchase-documents/:id/timeline` — a READ, so `commerce.read`, the
   * same permission every other read on this collection already answers to: the
   * timeline is the document's history, not a new capability, and no new permission
   * enters Core's catalogue.
   *
   * WHAT THIS HANDLER DOES NOT DO: it does not accept a tenant, a resource type, a
   * resource id or an audit filter — `:id` is the ONLY thing the request contributes,
   * and `PurchaseTimelineService` binds everything else server-side from the actor and
   * that id. The DTO carries only `page`/`pageSize`, so the global pipe refuses any
   * other parameter (422) rather than ignoring it. Ordering, pagination and the safe
   * projection are the platform contract's, passed through unchanged.
   *
   * NOT 409 (no conflict exists for a read), NOT 403 for a foreign id (a document
   * another tenant owns is a 404 below, exactly like `getOne`), and an audit outage is
   * the service's 503 `AUDIT_READ_FAILED` — never a quiet empty timeline.
   */
  @Get(':id/timeline')
  @Roles(Permissions.COMMERCE_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: PurchaseTimelineQueryDto
  ) {
    return this.timeline.getTimeline(resolveCommerceActor(req), id, query);
  }

  /**
   * PHASE W3: `GET /commerce/purchase-documents/:id/status-events` — the
   * append-only status-transition history of this document, oldest first.
   *
   * A READ, so `commerce.read` — the same permission every other read on this
   * collection answers to. NOT the audit timeline: these rows record the
   * transitions every status writer appended atomically; the audit trail
   * records actor/action evidence under the platform contract. No body, no
   * filter, no foreign id leaks (a foreign document is the same 404 as absent).
   */
  @Get(':id/status-events')
  @Roles(Permissions.COMMERCE_READ)
  async getStatusEvents(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.purchases.getStatusEvents(resolveCommerceActor(req), id);
  }

  /**
   * PHASE W3.2: `GET /commerce/purchase-documents/:id/history` — the
   * aggregated traceability stream: status transitions, correlated audit
   * events and inventory-posting diagnostics merged under server-side
   * filters, one deterministic order, paged. A READ — `commerce.read`.
   *
   * The `coverage` block reports each source's honesty state (which stream is
   * complete, which family was truncated, whether the audit trail was
   * unavailable) so a client never mistakes a partial answer for a full one.
   */
  @Get(':id/history')
  @Roles(Permissions.COMMERCE_READ)
  async getHistory(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: PurchaseHistoryQueryDto
  ) {
    return this.history.getHistory(resolveCommerceActor(req), id, query);
  }
}
