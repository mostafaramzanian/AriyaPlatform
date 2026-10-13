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
import { BomHeaderRepository } from '../bom/bom.repository';
import type { BomHeaderRecord } from '../bom/bom.repository';
import { BomItemRepository } from '../bom/bom-item.repository';
import type { BomItemRecord } from '../bom/bom-item.repository';
// Phase PRODUCTION-BOM-AUDIT-TIMELINE owns the ONE timeline shape; it is imported as a
// TYPE only, so this file depends on no part of the header's runtime.
import type { BomTimelineItem, BomTimelinePage } from '../bom/bom.service';
import { BomChangeRequestRepository } from './bom-change.repository';
import type {
  BomChangeRequestItemRecord,
  BomChangeRequestRecord,
} from './bom-change.repository';
import {
  PRODUCTION_BOM_CHANGE_ERROR_CODES,
  bomChangeRequestStatusAfter,
  isBomChangeRequestEditable,
  isQuantityChangePayloadComplete,
  isValidCoefficientDelta,
} from './bom-change';
import type { BomChangeType } from './bom-change';
import {
  resolveBomChangeRequestPageWindow,
  type AddBomChangeRequestItemDto,
  type BomChangeRequestDetailView,
  type BomChangeRequestItemView,
  type BomChangeRequestPage,
  type BomChangeRequestView,
  type CreateBomChangeRequestDto,
  type DecideBomChangeRequestDto,
  type ListBomChangeRequestsQueryDto,
  type UpdateBomChangeRequestDto,
  type UpdateBomChangeRequestItemDto,
} from './bom-change.dto';
import { resolveProductionTimelineWindow, type BomTimelineQueryDto } from '../bom/bom.dto';

/**
 * Phase PRODUCTION-BOM-CHANGE: the BOM Change Request slice's application surface — create,
 * read, list, the detail rows' add / update / delete while the request is a DRAFT, submit,
 * and the three decision acts.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * ----------------------------------------
 * It owns ORCHESTRATION and the rules that need more than one fact: tenant scoping,
 * "the named item really belongs to THIS request's BOM", the duplicate-detail rule, the
 * delta pair rule, approver membership, self-approval, the freeze at submit, the authority
 * to decide, and the audit trail. It issues NO raw Prisma query and holds no client —
 * persistence is `BomChangeRequestRepository`'s, and the two reads it needs from OUTSIDE its
 * own aggregate (the target BOM, the named item) come from the repositories that already
 * own those tables rather than from a second client.
 *
 * THE TENANT COMES FROM THE ACTOR, ALWAYS. Every method takes the actor and passes
 * `actor.tenantId` as the repository's first argument. No DTO carries a tenant field, no
 * method accepts one, and no lookup is by id alone — so there is no shape of these routes
 * that reads another tenant's request.
 *
 * THE REQUESTER COMES FROM THE ACTOR TOO. The source resolved «درخواست کننده» from the
 * CURRENT user; here it is `actor.userId`, never a body field. A `null` userId (a machine
 * caller) cannot author a request — a document whose requester nobody can name would be a
 * document with no one to hold accountable.
 *
 * IDENTITY IS REACHED THROUGH THE PLATFORM PORT, NEVER DIRECTLY. One need: "is this id a
 * member of my tenant?" before an approver id is STORED. That is `USER_DIRECTORY
 * .findTenantMember`'s question, answered by the platform adapter — never by a join,
 * because Production's database cannot see Core's identity tables.
 *
 * ONE TRAIL, AND ONLY AFTER A WRITE SUCCEEDED. The audit gateway is handed the row the
 * repository RETURNED, never the intent that produced it.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 *  * NO `apply` behaviour of any kind. Approving a request records a DECISION and nothing
 *    more: it writes no column of `BomHeader` and no column of `BomItem`. The source proves
 *    the two change types and proves nothing about what approval would write, so
 *    `Apply Change` is `DEFERRED / CONTRACT NOT ESTABLISHED`.
 *  * NO `inactive` flag, NO `BomItem` state, NO deletion, NO renumbering — the same
 *    prohibition, stated from the write side.
 *  * NO title derivation from a project name: there is no project-name contract to read
 *    (M-1), so a title the caller did not state is a 400 rather than a fabricated string.
 *  * NO `> 0`, NO maximum, NO precision rule on a delta, and NO stored total: every one of
 *    those is either commented out in the source or a display-only derivation.
 *  * NO notification, NO search projection, NO workflow: audit is not notification, and
 *    neither contract is claimed by a change-request mutation.
 */

/**
 * The audit `action` values this slice records. Lowercase verbs, like the header's and the
 * item's — the SAME six the header already writes, plus the three DETAIL acts the brief
 * requires (`add_item`, `update_item`, `remove_item`).
 *
 * WHY THE DETAIL ACTS CARRY THE REQUEST'S `resourceId`. `ProductionAuditAct.resourceId` is
 * bound to the change request for all NINE families, so ONE timeline read returns the whole
 * history of the document — including what was added to and removed from it. The detail
 * row's own id travels inside `newValue` / `changedFields` instead of becoming a second
 * resource the platform read contract cannot filter on (the same structural wall that
 * `PHASE-PRODUCTION-BOM-AUDIT-TIMELINE-IMPLEMENTATION.md` records for the BOM's item
 * events, and which this aggregate does not have to inherit).
 */
export const PRODUCTION_BOM_CHANGE_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  ADD_ITEM: 'add_item',
  UPDATE_ITEM: 'update_item',
  REMOVE_ITEM: 'remove_item',
  SUBMIT: 'submit',
  APPROVE: 'approve',
  REJECT: 'reject',
  REQUEST_CORRECTION: 'request_correction',
} as const;

/** The actor shape this service needs — structurally `ProductionActor`. */
interface BomChangeActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Projects a stored header row onto the wire shape. No derived field, no label, no total.
 */
export function toBomChangeRequestView(row: BomChangeRequestRecord): BomChangeRequestView {
  return {
    id: row.id,
    bomId: row.bomId,
    title: row.title,
    projectRef: row.projectRef,
    productTreeRef: row.productTreeRef,
    requesterUserId: row.requesterUserId,
    approverUserId: row.approverUserId,
    status: row.status,
    managerOpinion: row.managerOpinion,
    notes: row.notes,
    requestDate: row.requestDate.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Projects a stored detail row onto the wire shape — the stored columns plus the part name
 * read through the item FK. The two coefficient PAIRS are returned exactly as they were
 * stored; the derived `original + delta` figure is NOT computed here, because the source
 * computes it for display and never persists it (S8).
 */
export function toBomChangeRequestItemView(
  row: BomChangeRequestItemRecord
): BomChangeRequestItemView {
  return {
    id: row.id,
    changeRequestId: row.changeRequestId,
    bomItemId: row.bomItemId,
    partName: row.partName,
    changeType: row.changeType,
    originalDrawingCoefficient: row.originalDrawingCoefficient,
    originalSpareCoefficient: row.originalSpareCoefficient,
    drawingCoefficientDelta: row.drawingCoefficientDelta,
    spareCoefficientDelta: row.spareCoefficientDelta,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}


@Injectable()
export class BomChangeRequestService {
  /**
   * The module's own logger, used for ONE purpose on this surface: recording that the
   * platform refused a timeline read, with the platform's CLOSED code — the same single
   * use `BomHeaderService` makes of its own.
   */
  private readonly logger = new Logger(BomChangeRequestService.name);

  constructor(
    private readonly repository: BomChangeRequestRepository,
    private readonly headers: BomHeaderRepository,
    private readonly items: BomItemRepository,
    private readonly audit: ProductionAuditGateway,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectoryContract
  ) {}

  // ---------------------------------------------------------------------------
  // HEADER
  // ---------------------------------------------------------------------------

  /**
   * Creates a change request for the acting tenant, as a DRAFT.
   *
   * THE REQUESTER IS `actor.userId`, NEVER `dto.*`. The source resolved «درخواست کننده» from
   * the current user (`form.UserID()` against «لیست کارکنان»), so the ERP equivalent is the
   * authenticated principal — and a machine caller (`userId === null`) is refused here
   * rather than storing a row with no one to attribute it to.
   *
   * THE SCOPE SNAPSHOT COMES FROM THE TARGET BOM, NEVER FROM THE BODY. `projectRef` and
   * `productTreeRef` are read off the header this request already resolved, exactly as
   * `BomItemService` reads them off its header, so no payload can file a change against BOM
   * B while claiming project A. The `bomId` itself is the ONLY scope input accepted, and it
   * is re-resolved tenant-scoped — a BOM this tenant does not hold is a 404, not a write.
   *
   * SELF-APPROVAL IS REFUSED. The source has no such rule, so this is a DECISION, not a
   * discovery — the same one `bom.service.ts` records: V1 does not permit it, and the check
   * compares the row's two ROLES rather than "the actor versus the approver", because a
   * delegate may file a request whose requester is somebody else.
   *
   * NO TITLE IS DERIVED. `بomEdit` composed `تغییر اقلام پروژه - <project name>` from a
   * lookup Ariya has no contract for; deriving a title from an opaque `projectRef` would be
   * a fabricated name, so the caller states one (M-1's decision, restated for this form).
   */
  async create(
    actor: BomChangeActor,
    dto: CreateBomChangeRequestDto
  ): Promise<BomChangeRequestDetailView> {
    if (!actor.userId) {
      throw new ForbiddenException(
        'A change request must be authored by an identified tenant member.'
      );
    }

    const bom = await this.requireBom(actor.tenantId, dto.bomId);
    const approverUserId = dto.approverUserId;

    await this.assertTenantMember(actor.tenantId, approverUserId, 'approverUserId');
    this.assertNotSelfApproval(actor.userId, approverUserId);

    const row = await this.repository.create(actor.tenantId, {
      bomId: bom.id,
      title: this.requireText(dto.title, 'title'),
      projectRef: bom.projectRef,
      productTreeRef: bom.productTreeRef,
      requesterUserId: actor.userId,
      approverUserId,
      notes: dto.notes ?? null,
    });

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.CREATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: row.id,
      newValue: {
        id: row.id,
        bomId: row.bomId,
        title: row.title,
        requesterUserId: row.requesterUserId,
        approverUserId: row.approverUserId,
      },
      changedFields: [
        'id',
        'bomId',
        'title',
        'requesterUserId',
        'approverUserId',
        'projectRef',
        'productTreeRef',
        'requestDate',
      ],
    });

    return { ...toBomChangeRequestView(row), items: [] };
  }

  /**
   * One page of this tenant's change requests.
   *
   * EVERY FILTER IS SERVER-SIDE and passed through the clamped window — no filter is
   * computed in the client, because a client-side filter over one page would silently
   * describe a subset while looking like the whole register.
   */
  async list(actor: BomChangeActor, dto: ListBomChangeRequestsQueryDto): Promise<BomChangeRequestPage> {
    const window = resolveBomChangeRequestPageWindow(dto);
    const { requests, total } = await this.repository.list(actor.tenantId, {
      skip: window.skip,
      take: window.take,
      bomId: dto.bomId,
      projectRef: dto.projectRef,
      status: dto.status,
      search: dto.search,
    });

    return {
      items: requests.map(toBomChangeRequestView),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /**
   * One request with ALL of its detail rows, or 404.
   *
   * The rows come back in ONE read of this tenant's own table, ordered by `createdAt` — the
   * source's grid order — so "the request and what it changes" can never disagree about
   * which set it is showing.
   */
  async getOne(actor: BomChangeActor, id: string): Promise<BomChangeRequestDetailView> {
    const row = await this.requireRow(actor.tenantId, id);
    const items = await this.repository.listItems(actor.tenantId, row.id);
    return { ...toBomChangeRequestView(row), items: items.map(toBomChangeRequestItemView) };
  }

  /**
   * Changes a DRAFT request's own fields: its title, its notes, or WHO will decide it.
   *
   * THE APPROVER IS RE-VALIDATED AND THE SELF-APPROVAL RULE RE-RUN, for the same two
   * reasons `create` does: the person named must be a member of THIS tenant at the moment
   * it is stored, and the row's two roles must differ. Everything else is a bounded text
   * field.
   *
   * AN EMPTY PATCH IS REFUSED. A no-op would still bump `updatedAt` and still audit an
   * "update", and a trail in which a no-op is indistinguishable from a real edit is a trail
   * that lies — the header's own rule, restated here rather than inherited by accident.
   *
   * WHY THIS ROUTE EXISTS AT ALL. The brief's minimum surface lists the detail-row
   * mutations; the header's own fields are edit-while-draft, which is what the source's
   * section-01 controls do for a record that has not yet been routed and what the BOM
   * header's `PATCH :id` already provides for its sibling aggregate. After SUBMIT the row is
   * frozen by the repository's `status: 'DRAFT'` predicate, so the approver snapshot cannot
   * be rewritten once anything has been decided — which is the invariant that matters.
   */
  async update(
    actor: BomChangeActor,
    id: string,
    dto: UpdateBomChangeRequestDto
  ): Promise<BomChangeRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    this.assertEditable(current);

    const patch: { title?: string; approverUserId?: string; notes?: string | null } = {};

    if (dto.title !== undefined) patch.title = this.requireText(dto.title, 'title');
    if (dto.notes !== undefined) patch.notes = dto.notes;

    if (dto.approverUserId !== undefined) {
      await this.assertTenantMember(actor.tenantId, dto.approverUserId, 'approverUserId');
      this.assertNotSelfApproval(current.requesterUserId, dto.approverUserId);
      patch.approverUserId = dto.approverUserId;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.PATCH_EMPTY,
        message: 'State at least one field to change.',
      });
    }

    const updated = await this.repository.updateDraft(actor.tenantId, id, patch);

    if (!updated) {
      // The conditional write lost a race with a concurrent transition. Re-read so the
      // refusal names the CURRENT status instead of guessing what changed.
      const now = await this.requireRow(actor.tenantId, id);
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and can no longer be edited; only a DRAFT is editable.`,
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.UPDATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: updated.id,
      oldValue: { title: current.title, approverUserId: current.approverUserId },
      newValue: { title: updated.title, approverUserId: updated.approverUserId },
      changedFields: Object.keys(patch),
    });

    return this.getOne(actor, updated.id);
  }

  // ---------------------------------------------------------------------------
  // DETAIL ROWS
  // ---------------------------------------------------------------------------

  /**
   * Adds one detail row to a DRAFT request.
   *
   * FOUR CHECKS, IN THIS ORDER, AND WHY THE ORDER IS THE ORDER:
   *
   *  1. THE REQUEST EXISTS AND IS EDITABLE. Everything below is scoped by it, so without
   *     it there is no scope — an unscoped item lookup would be a cross-tenant leak rather
   *     than a 404.
   *  2. THE PAYLOAD IS COMPLETE FOR ITS OWN TYPE (S2). For `QUANTITY_CHANGE` at least one
   *     delta must be stated; for `DEACTIVATE` no delta rule exists in the source, so none
   *     is applied. Doing this BEFORE the item lookup keeps a malformed payload a 400
   *     instead of leaking whether some item id exists.
   *  3. THE NAMED ITEM BELONGS TO THIS REQUEST'S BOM. Resolved by
   *     `items.findById(tenantId, request.bomId, itemId)`, so an item of ANOTHER BOM in the
   *     same tenant, an item of another tenant, and an item that does not exist are all the
   *     SAME 404 — a caller cannot probe for item ids across BOMs it has not been pointed at.
   *  4. IT IS NOT ALREADY DETAILED (S3). The pre-check exists to EXPLAIN the refusal with
   *     the typed code the legacy form's message maps to; the UNIQUE index
   *     `(tenantId, changeRequestId, bomItemId)` is what makes it true under concurrency.
   *
   * THE SNAPSHOT IS TAKEN FROM THE ITEM AND NEVER FROM THE CALLER (S6). `MizanAvaliye…` is
   * read off the row this method just resolved, so the stored "original" is provably the
   * item's value at the moment the detail was created, and no payload can write a history
   * that disagrees with what it claims to snapshot.
   *
   * NO LIVE RECALCULATION IS EVER PERFORMED against the item afterwards: the detail keeps
   * its own pair, and the UI derives `original + delta` from the detail's pair alone.
   */
  async addItem(
    actor: BomChangeActor,
    id: string,
    dto: AddBomChangeRequestItemDto
  ): Promise<BomChangeRequestDetailView> {
    const request = await this.requireRow(actor.tenantId, id);
    this.assertEditable(request);

    const changeType = dto.changeType;
    const drawingDelta = normalizeDelta(dto.drawingCoefficientDelta);
    const spareDelta = normalizeDelta(dto.spareCoefficientDelta);
    this.assertDeltaPayload(changeType, drawingDelta, spareDelta);

    const item = await this.requireItemOfBom(actor.tenantId, request.bomId, dto.bomItemId);

    const existing = await this.repository.findItemById(actor.tenantId, request.id, item.id);
    if (existing) {
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_DUPLICATE,
        message: 'This item is already detailed in this change request.',
      });
    }

    const created = await this.repository.createItem(actor.tenantId, request.id, {
      bomItemId: item.id,
      changeType,
      originalDrawingCoefficient: item.drawingConsumptionCoefficient,
      originalSpareCoefficient: item.spareConsumptionCoefficient,
      drawingCoefficientDelta: drawingDelta,
      spareCoefficientDelta: spareDelta,
    });

    if (!created) {
      const now = await this.requireRow(actor.tenantId, request.id);
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and its details can no longer be changed; only a DRAFT is editable.`,
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.ADD_ITEM,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: request.id,
      newValue: {
        id: created.id,
        bomItemId: created.bomItemId,
        partName: created.partName,
        changeType: created.changeType,
        originalDrawingCoefficient: created.originalDrawingCoefficient,
        originalSpareCoefficient: created.originalSpareCoefficient,
        drawingCoefficientDelta: created.drawingCoefficientDelta,
        spareCoefficientDelta: created.spareCoefficientDelta,
      },
      changedFields: ['items', 'bomItemId', 'changeType'],
    });

    return this.getOne(actor, request.id);
  }

  /**
   * Changes one detail row of a DRAFT request.
   *
   * THE EFFECTIVE PAIR IS VALIDATED, NOT THE PATCH. `changeType` may change and either
   * delta may be set, cleared (`null`) or left alone (absent) — so the rule that matters is
   * the one over the MERGED result: a `QUANTITY_CHANGE` whose effective deltas are both
   * "not stated" is refused, and clearing the last stated delta is refused for the same
   * reason as never having stated one. Validating the incoming object alone would let that
   * state be reached.
   *
   * THE SNAPSHOT IS NEVER RE-WRITTEN. `originalDrawingCoefficient` /
   * `originalSpareCoefficient` belong to the moment the detail was created (S6) and this
   * method has no path to them — the repository's patch input does not carry them, so a
   * future caller cannot refresh history to match a current item value.
   *
   * WHY `NOT_FOUND` AND NOT A PARTICULAR REASON. A detail of ANOTHER tenant's request, of
   * ANOTHER request in this tenant, and one that does not exist are all the same 404: an
   * answer that told them apart would confirm that an id exists in a scope the caller
   * cannot see.
   */
  async updateItem(
    actor: BomChangeActor,
    id: string,
    itemId: string,
    dto: UpdateBomChangeRequestItemDto
  ): Promise<BomChangeRequestDetailView> {
    const request = await this.requireRow(actor.tenantId, id);
    this.assertEditable(request);

    const current = await this.requireItem(actor.tenantId, request.id, itemId);

    const changeType = dto.changeType ?? current.changeType;
    const drawingDelta =
      'drawingCoefficientDelta' in dto
        ? normalizeDelta(dto.drawingCoefficientDelta)
        : current.drawingCoefficientDelta;
    const spareDelta =
      'spareCoefficientDelta' in dto ? normalizeDelta(dto.spareCoefficientDelta) : current.spareCoefficientDelta;

    this.assertDeltaPayload(changeType, drawingDelta, spareDelta);

    const patch: {
      changeType?: BomChangeType;
      drawingCoefficientDelta?: number | null;
      spareCoefficientDelta?: number | null;
    } = {};

    if (dto.changeType !== undefined) patch.changeType = dto.changeType;
    if ('drawingCoefficientDelta' in dto) patch.drawingCoefficientDelta = drawingDelta;
    if ('spareCoefficientDelta' in dto) patch.spareCoefficientDelta = spareDelta;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.PATCH_EMPTY,
        message: 'State at least one field to change.',
      });
    }

    const updated = await this.repository.updateItemDraft(
      actor.tenantId,
      request.id,
      itemId,
      patch
    );

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, request.id);
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and its details can no longer be changed; only a DRAFT is editable.`,
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.UPDATE_ITEM,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: request.id,
      oldValue: {
        id: current.id,
        changeType: current.changeType,
        drawingCoefficientDelta: current.drawingCoefficientDelta,
        spareCoefficientDelta: current.spareCoefficientDelta,
      },
      newValue: {
        id: updated.id,
        changeType: updated.changeType,
        drawingCoefficientDelta: updated.drawingCoefficientDelta,
        spareCoefficientDelta: updated.spareCoefficientDelta,
      },
      changedFields: Object.keys(patch),
    });

    return this.getOne(actor, request.id);
  }

  /**
   * Deletes one detail row from a DRAFT request, returning the id that was removed.
   *
   * THE ROW IS READ BEFORE IT IS DELETED, and the trail records what it held. A deletion is
   * the one act whose evidence is destroyed by performing it, so the audit event carries the
   * previous values — otherwise "what was taken out of this request?" would be
   * unanswerable the moment it happened.
   *
   * ONLY THE DETAIL ROW IS REMOVED (S15). The source's «حذف» called `DeleteRecord` on
   * «جزئیات تغییر Bom» and nothing else, so the BOM item itself is untouched: removing a
   * change from a request is not removing the part from the BOM.
   */
  async deleteItem(
    actor: BomChangeActor,
    id: string,
    itemId: string
  ): Promise<{ id: string }> {
    const request = await this.requireRow(actor.tenantId, id);
    this.assertEditable(request);

    const current = await this.requireItem(actor.tenantId, request.id, itemId);

    const removed = await this.repository.deleteItemDraft(actor.tenantId, request.id, itemId);

    if (!removed) {
      const now = await this.requireRow(actor.tenantId, request.id);
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and its details can no longer be changed; only a DRAFT is editable.`,
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.REMOVE_ITEM,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: request.id,
      oldValue: {
        id: current.id,
        bomItemId: current.bomItemId,
        partName: current.partName,
        changeType: current.changeType,
        originalDrawingCoefficient: current.originalDrawingCoefficient,
        originalSpareCoefficient: current.originalSpareCoefficient,
        drawingCoefficientDelta: current.drawingCoefficientDelta,
        spareCoefficientDelta: current.spareCoefficientDelta,
      },
      changedFields: ['items', 'bomItemId'],
    });

    return { id: itemId };
  }

  // ---------------------------------------------------------------------------
  // LIFECYCLE
  // ---------------------------------------------------------------------------

  /**
   * Submits a DRAFT for decision: DRAFT → SUBMITTED, once.
   *
   * THE FREEZE POINT, AND THE EMPTY-REQUEST GATE (S4). `repository.submit` carries
   * `items: { some: {} }` inside the same conditional UPDATE, so "a request with no detail
   * rows cannot be submitted" and the DRAFT→SUBMITTED transition are ONE atomic statement —
   * not a count read followed by a write that a concurrent DELETE could invalidate. The
   * source refused the empty case with «اقلامی جهت تغییر ثبت نشده است!»; the block below
   * turns a refusal that lands while the row is STILL a DRAFT into the typed
   * `BOM_CHANGE_REQUEST_ITEMS_REQUIRED`, and turns everything else into a 409 naming the
   * current status.
   *
   * THE APPROVER IS RE-VERIFIED AT THE FREEZE, not only at create: between creation and
   * submission a person can leave the tenant, and routing to somebody who can no longer act
   * is precisely what the source's own refusal («یوزر مدیر در سامانه ست نشده است») guarded.
   *
   * NO BODY. There is nothing for the caller to state: the approver is the row's own frozen
   * snapshot, not a field of the request.
   */
  async submit(actor: BomChangeActor, id: string): Promise<BomChangeRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (bomChangeRequestStatusAfter(current.status, 'SUBMIT') !== 'SUBMITTED') {
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${current.status} and cannot be submitted; only a DRAFT can.`,
      });
    }

    if (!current.approverUserId) {
      // Structurally unreachable — create requires it and the schema's CHECK refuses a
      // non-DRAFT row without one. Stated anyway, because the error it would otherwise
      // produce is a routing decision with nobody to route to.
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: 'This change request has no approver and cannot be submitted.',
      });
    }

    await this.assertTenantMember(actor.tenantId, current.approverUserId, 'approverUserId');

    // Phase B2.4: build the durable outbox payload BEFORE the write.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PRODUCTION_BOM_CHANGE_AUDIT_ACTION.SUBMIT,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: 'SUBMITTED', approverUserId: current.approverUserId },
      changedFields: ['status', 'submittedAt'],
    });

    const updated = await this.repository.submit(actor.tenantId, id, current.notes, outbox);

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);

      if (isBomChangeRequestEditable(now.status)) {
        // Still a DRAFT and in this tenant, so the ONLY predicate the conditional write
        // could have failed on is `items: { some: {} }`. Told as a 400 (the rule is wrong,
        // not the state) carrying the typed code, so the UI maps it to
        // «اقلامی جهت تغییر ثبت نشده است!» by identifier instead of by sentence.
        throw new BadRequestException({
          code: PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEMS_REQUIRED,
          message: 'A change request must contain at least one item before it can be submitted.',
        });
      }

      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and cannot be submitted; only a DRAFT can.`,
      });
    }

    return this.getOne(actor, updated.id);
  }

  /**
   * Records one of the approver's three decisions.
   *
   * THE ROUTE STATES THE OPINION, NOT THE BODY. Unlike `BomHeaderService.decide`, which
   * re-reads an `opinion` field so a mismatch is a 400, this slice's decision DTO carries
   * only an optional `notes` — there is no opinion field on the wire at all, so the meaning
   * of `POST …/reject` cannot be rewritten by a payload. The source's three radio values
   * (`تایید;رد;نیاز به اصلاح`) map one-for-one onto `APPROVED` / `REJECTED` /
   * `NEEDS_CORRECTION`.
   *
   * ONLY THE SNAPSHOTTED APPROVER MAY DECIDE. The check is
   * `actor.userId === row.approverUserId` — an equality against the STORED, FROZEN value,
   * never a re-resolution from a hierarchy. A `null` actor id cannot equal a stored id, so a
   * non-human caller is refused by construction rather than by a separate branch. This is
   * also where self-approval is blocked at the DECISION side: the row's two roles were
   * required to differ at create and at patch, so an approver can never be the requester who
   * routed it to themselves.
   *
   * A CORRECTION MOVES THE ROW BACK TO `DRAFT`, exactly what the legacy task's «نیاز به
   * اصلاح» branch did. The decision is still recorded (`managerOpinion`, decider, instant),
   * so "returned for correction" stays distinguishable from "never submitted" — and the
   * detail rows become editable again, because editability asks ONLY the status.
   *
   * APPROVING WRITES NOTHING ON THE BOM. This method records a decision on the request and
   * returns; `Apply Change` is `DEFERRED / CONTRACT NOT ESTABLISHED`.
   */
  async decide(
    actor: BomChangeActor,
    id: string,
    expected: 'APPROVED' | 'REJECTED' | 'NEEDS_CORRECTION',
    dto: DecideBomChangeRequestDto
  ): Promise<BomChangeRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);

    const action =
      expected === 'APPROVED'
        ? ('APPROVE' as const)
        : expected === 'REJECTED'
          ? ('REJECT' as const)
          : ('REQUEST_CORRECTION' as const);

    const next = bomChangeRequestStatusAfter(current.status, action);
    if (next === null) {
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${current.status} and cannot be decided; only a SUBMITTED request can.`,
      });
    }

    if (!actor.userId || actor.userId !== current.approverUserId) {
      throw new ForbiddenException(
        'Only the approver recorded on this change request may decide it.'
      );
    }

    // Phase B2.4: build the durable outbox payload BEFORE the write.
    const auditAction =
      expected === 'APPROVED'
        ? PRODUCTION_BOM_CHANGE_AUDIT_ACTION.APPROVE
        : expected === 'REJECTED'
          ? PRODUCTION_BOM_CHANGE_AUDIT_ACTION.REJECT
          : PRODUCTION_BOM_CHANGE_AUDIT_ACTION.REQUEST_CORRECTION;

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: auditAction,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: id,
      oldValue: { status: current.status, managerOpinion: current.managerOpinion },
      newValue: { status: next, managerOpinion: expected },
      changedFields: ['status', 'managerOpinion', 'decidedAt', 'decidedByUserId', 'notes'],
    });

    const updated = await this.repository.decide(actor.tenantId, id, 'SUBMITTED', {
      status: next,
      managerOpinion: expected,
      notes: dto.notes ?? current.notes,
      decidedByUserId: actor.userId,
    }, outbox);

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${now.status} and cannot be decided; only a SUBMITTED request can.`,
      });
    }

    return this.getOne(actor, updated.id);
  }

  /**
   * This request's audit history, read-only — `GET /production/bom-change-requests/:id/timeline`.
   *
   * EXISTENCE FIRST, TENANT-SCOPED, AND IT IS A 404. A request another tenant owns must be
   * indistinguishable from one that does not exist, so the audit boundary is only ever
   * reached for a row this tenant owns.
   *
   * ONE READ RETURNS THE WHOLE DOCUMENT'S HISTORY, because all nine families are recorded
   * under `resourceId = <change request id>` — header acts AND detail acts. That is the
   * difference from the BOM header's timeline, whose item events are structurally
   * unreachable through the read contract; see `production.constants.ts`.
   *
   * ORDERING IS THE CONTRACT'S, AND IS NOT REVERSED HERE. EMPTY IS NOT FAILED: a rejected
   * read is a 503 with the platform's CLOSED code, never a quiet empty page.
   *
   * ARCHITECTURE (the only path allowed):
   *   Controller → resolveProductionActor → this service → BomChangeRequestRepository
   *             (existence) → ProductionAuditGateway.read → AUDIT_PORT.read → Platform Audit
   * Never Core Prisma, never `AuditLog`, never a Production audit mirror, never a
   * reconstruction from `BomChangeRequest` / `BomChangeRequestItem` rows.
   */
  async getTimeline(
    actor: BomChangeActor,
    id: string,
    query: BomTimelineQueryDto
  ): Promise<BomTimelinePage> {
    const row = await this.requireRow(actor.tenantId, id);
    const window = resolveProductionTimelineWindow(query);

    const result = await this.audit.read({
      tenantId: actor.tenantId,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      this.logger.error(`Audit read rejected for change request ${row.id}: ${result.code}`);

      if (result.code === 'AUDIT_READ_FAILED') {
        throw new ServiceUnavailableException({
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        });
      }

      throw new UnprocessableEntityException({
        code: result.code,
        message: 'The audit read query was rejected by the platform.',
      });
    }

    return {
      items: result.page.items.map(BomChangeRequestService.projectTimelineItem),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
  }

  /**
   * The timeline projection — an EXPLICIT WHITELIST of the same seven fields the header's
   * projection exposes, so this slice cannot accidentally publish more of the platform item
   * than that one did. Typed STRUCTURALLY for the same reason: `AuditReadItem` is a value
   * consumed here, not a token this module holds, so the ONE audit seam stays exactly where
   * `production-isolation.spec.ts` puts it.
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



  // ---------------------------------------------------------------------------
  // PRIVATE RULES
  // ---------------------------------------------------------------------------

  /** One change request of THIS tenant, or 404. Never a read by id alone. */
  private async requireRow(tenantId: string, id: string): Promise<BomChangeRequestRecord> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) {
      // A row of another tenant is INDISTINGUISHABLE from one that does not exist — by
      // design, so the answer cannot confirm that an id exists elsewhere.
      throw new NotFoundException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_FOUND,
        message: 'Change request not found.',
      });
    }
    return row;
  }

  /** The target BOM of THIS tenant, or 404 naming the BOM rather than the request. */
  private async requireBom(tenantId: string, bomId: string): Promise<BomHeaderRecord> {
    const row = await this.headers.findById(tenantId, bomId);
    if (!row) {
      throw new NotFoundException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.BOM_NOT_FOUND,
        message: 'BOM not found.',
      });
    }
    return row;
  }

  /**
   * One item of THIS tenant under THIS request's BOM, or 404.
   *
   * `bomId` travels with the predicate — the REQUEST's own `bomId`, never a body value — so
   * an item that belongs to a different BOM in the same tenant is indistinguishable from one
   * that does not exist, and a caller cannot probe for item ids across BOMs it has not been
   * pointed at. This is also what makes "foreign BOM item rejected" true without a rule that
   * re-derives BOM ownership from the item.
   */
  private async requireItemOfBom(
    tenantId: string,
    bomId: string,
    bomItemId: string
  ): Promise<BomItemRecord> {
    const row = await this.items.findById(tenantId, bomId, bomItemId);
    if (!row) {
      throw new NotFoundException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_NOT_FOUND,
        message: 'BOM item not found.',
      });
    }
    return row;
  }

  /** One detail row of THIS request under THIS tenant, or 404. */
  private async requireItem(
    tenantId: string,
    changeRequestId: string,
    itemId: string
  ): Promise<BomChangeRequestItemRecord> {
    const row = await this.repository.findItemById(tenantId, changeRequestId, itemId);
    if (!row) {
      throw new NotFoundException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.ITEM_NOT_FOUND,
        message: 'Change detail not found.',
      });
    }
    return row;
  }

  /**
   * Refuses a mutation when the request is no longer a DRAFT (S10).
   *
   * This is `isBomChangeRequestEditable` — which IS the header's predicate, re-exported —
   * so "may a detail change?" and "may the header change?" have one answer. The three
   * detail mutations and the header patch all fall out of this single call, and a correction
   * returning the row to DRAFT makes them editable again with no separate un-freeze step to
   * forget.
   */
  private assertEditable(request: BomChangeRequestRecord): void {
    if (!isBomChangeRequestEditable(request.status)) {
      throw new ConflictException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.NOT_EDITABLE,
        message: `This change request is ${request.status} and can no longer be edited; only a DRAFT is editable.`,
      });
    }
  }


  /**
   * The pair rule for a `QUANTITY_CHANGE` (S2), and the integrality rule for BOTH types.
   *
   * The type check is repeated here even though `@IsIn(BOM_CHANGE_TYPES)` already bound it
   * on the wire: the DTO is a WIRE bound while this is the DOMAIN fact, and a future
   * internal caller building a patch object directly must not be able to skip it. The
   * service also re-asserts integrality rather than trusting `@IsInt()`, for the same
   * reason `bom-item.service.ts` re-asserts its coefficient.
   *
   * NOTHING ELSE IS CHECKED: no `> 0`, no maximum, no sum, no cross-field formula — the
   * source's own versions of those are commented out or display-only (S7/S8).
   */
  private assertDeltaPayload(
    changeType: BomChangeType,
    drawingDelta: number | null,
    spareDelta: number | null
  ): void {
    const stated: Array<[string, number | null]> = [
      ['drawingCoefficientDelta', drawingDelta],
      ['spareCoefficientDelta', spareDelta],
    ];

    for (const [field, value] of stated) {
      if (value === null) continue;
      if (!isValidCoefficientDelta(value)) {
        throw new BadRequestException({
          code: PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_INVALID,
          message: `${field} must be an integer.`,
        });
      }
    }

    if (
      changeType === 'QUANTITY_CHANGE' &&
      !isQuantityChangePayloadComplete({
        drawingCoefficientDelta: drawingDelta,
        spareCoefficientDelta: spareDelta,
      })
    ) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.DELTA_REQUIRED,
        message:
          'At least one of the drawing or spare consumption-coefficient deltas must be stated.',
      });
    }
  }

  /**
   * Trims and requires a text field, or refuses naming it.
   *
   * `@IsNotEmpty()` rejects `""` but not `"   "`; a title of three spaces is exactly the
   * value a non-blank rule must refuse. Trimming here is what makes the rule mean
   * "non-blank" rather than "length > 0".
   */
  private requireText(value: string | undefined, field: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.FIELD_REQUIRED,
        message: `${field} is required and cannot be blank.`,
      });
    }
    return trimmed;
  }

  /**
   * Asserts the id is a member of the acting tenant, or refuses with a 400 naming the
   * field. WHY 400 AND NOT 403: this is a statement about the PAYLOAD, not about the
   * caller's rights — the caller may hold every permission there is and still name somebody
   * who is not in their tenant, which is a malformed request.
   *
   * WHY THE ANSWER IS A BOOLEAN AND NOT A DISCLOSURE: `findTenantMember` returns a profile
   * for a member and `null` otherwise, so a probing caller learns "not mine" rather than
   * "belongs to somebody else".
   */
  private async assertTenantMember(
    tenantId: string,
    userId: string,
    field: string
  ): Promise<void> {
    const member = await this.directory.findTenantMember(tenantId, userId);
    if (!member) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.FIELD_REQUIRED,
        message: `${field} is not a member of this tenant, or does not exist.`,
      });
    }
  }

  /**
   * Refuses a request whose requester and approver are the same person.
   *
   * THE SOURCE HAS NO SUCH RULE, so this is a DECISION, not a discovery — the same one
   * `bom.service.ts` records for the BOM header. V1 does not permit self-approval, and the
   * check compares the two identity VALUES rather than "the actor versus the approver",
   * because a delegate may file a request whose requester is somebody else.
   */
  private assertNotSelfApproval(requesterUserId: string, approverUserId: string): void {
    if (requesterUserId === approverUserId) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_CHANGE_ERROR_CODES.FIELD_REQUIRED,
        message:
          'The approver must be a different person from the requester; self-approval is not permitted.',
      });
    }
  }
}

/**
 * `undefined` and `null` both mean "not stated" on the way IN, and the schema stores both as
 * NULL. The distinction the DTO keeps — absent vs explicit `null` on a PATCH — is resolved by
 * the caller (`'key' in dto`), not here: this function only normalises the VALUE so the pair
 * rule can ask "is anything stated?" without caring which of the two the caller sent.
 */
function normalizeDelta(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return value;
}

