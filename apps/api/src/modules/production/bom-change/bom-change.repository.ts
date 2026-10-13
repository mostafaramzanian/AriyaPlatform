import { Injectable } from '@nestjs/common';
import { ProductionPrismaService } from '../database/production-prisma.service';
import type {
  BomChangeRequest,
  BomChangeRequestItem,
  Prisma,
} from '../../../generated/production-client';
import type { BomStatus, BomManagerOpinion } from '../bom/bom-status';
import type { BomChangeType } from './bom-change';
import type { ProductionAuditOutboxPayload } from '../production-audit.gateway';

/**
 * Phase PRODUCTION-BOM-CHANGE: the BOM Change Request persistence boundary — every
 * statement this slice issues against `production_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * It owns INSERTs, conditional UPDATEs/DELETEs and tenant-scoped SELECTs. Whether a request
 * is editable, whether a transition is legal, whether a delta pair is complete, whether an
 * item belongs to the request's BOM and whether a self-approval is refused all live in
 * `bom-change.ts` (the pure rules) and `bom-change.service.ts` (the rules that need more
 * than one fact). A repository that refused a status change would be a second place the
 * lifecycle is written down, and the two would disagree the first time one of them changed
 * — the reasoning `bom.repository.ts` and `bom-item.repository.ts` already record.
 *
 * THE TWO THINGS ONLY IT CAN DECIDE
 * ---------------------------------
 *   1. THE CONDITIONAL TRANSITION: `submit` and `decide` carry the expected `from` status
 *      (and, for submit, the `items: { some: {} }` existence predicate) INSIDE the same
 *      UPDATE, so two concurrent acts cannot both win and an empty request cannot be
 *      submitted. That is a persistence concern — it must be ONE statement to be atomic.
 *   2. THE CHILD'S PARENT GUARD: `createItem` opens a `$transaction` whose FIRST statement
 *      conditionally touches the request while it is still a DRAFT; if that guard matches
 *      nothing the callback returns `null` and nothing is inserted. Prisma cannot filter a
 *      parent on an INSERT, so a guarded two-statement transaction is the only shape that
 *      gives an insert the same atomicity the child's UPDATE/DELETE get from a relation
 *      filter.
 *
 * TENANCY
 * -------
 * `tenantId` is the FIRST parameter of every method and appears in EVERY `where`.
 * `prisma.findUnique` is NEVER used: it cannot carry a tenant predicate, so a "find by id"
 * written with it would read another tenant's row — and an `id` alone is not an isolation
 * key. `findFirst({ where: { id, tenantId, … } })` is the only single-row shape used, so a
 * foreign id returns `null` and the SERVICE maps that to a 404 that cannot be told apart
 * from "does not exist".
 *
 * WHAT THIS FILE MUST NEVER DO
 * ----------------------------
 * No HTTP logic, no permission resolution, no call to Project or Product Tree (they do not
 * exist), no access to `core_db`, `hr_db`, `commerce_db` or any other owner's client, and
 * — the phase's central rule — **no write to `BomHeader` or `BomItem`**. Approving a
 * request does NOT apply it: the source proves no such behaviour, so this file contains no
 * statement that could perform one.
 */

/** The row as Production's own Prisma client returns it. */
export type BomChangeRequestRecord = BomChangeRequest;

/**
 * A request row plus its bounded detail count (Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT):
 * the same shape `BomHeaderWithItemCount` is for the header register — the stored columns
 * and ONE `_count` read WITH the row, never a per-row query and never the detail rows
 * themselves (their coefficient snapshots are evidence for Production's own detail
 * surface, not for this projection).
 */
export type BomChangeRequestWithItemCount = BomChangeRequest & {
  _count: { items: number };
};

/**
 * A detail row AS THE API NEEDS IT: the stored columns plus the part name read through the
 * `bomItem` relation.
 *
 * WHY THE NAME IS READ AND NOT STORED. The source's detail list shows «نام قطعه», but the
 * value lives on the ITEM — the source reached it through the lookup
 * (`IdBomFehresteAghlameProje`), while its own `Title` column held the CHANGE REQUEST's
 * title, a SharePoint mandatory-title artefact rather than a business fact. Copying the
 * part name onto the detail would create a second, staleable copy of a fact the referenced
 * row already owns; the FK is RESTRICT, so that row is guaranteed to exist.
 */
export type BomChangeRequestItemRecord = BomChangeRequestItem & {
  /** `BomItem.partName` of the referenced item — read, never stored here. */
  partName: string;
};

/** The subset of writable fields the service passes on create. */
export interface BomChangeRequestCreateInput {
  bomId: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string;
  notes?: string | null;
}

/** The subset of writable fields a DRAFT-only patch may change. */
export interface BomChangeRequestPatchInput {
  title?: string;
  approverUserId?: string;
  notes?: string | null;
}

/** What a decision act writes: the status it lands on and the decision record. */
export interface BomChangeRequestDecisionInput {
  status: BomStatus;
  managerOpinion: BomManagerOpinion;
  notes?: string | null;
  decidedByUserId: string;
}

/** The list window and filters, already clamped by the service. */
export interface BomChangeRequestFilter {
  bomId?: string;
  projectRef?: string;
  status?: BomStatus;
  search?: string;
}

/** The list window plus the filter subset — `list` has always answered with both. */
export interface BomChangeRequestListQuery extends BomChangeRequestFilter {
  skip: number;
  take: number;
}

/** The subset of writable fields a detail INSERT carries. */
export interface BomChangeRequestItemCreateInput {
  bomItemId: string;
  changeType: BomChangeType;
  originalDrawingCoefficient: number;
  originalSpareCoefficient: number;
  drawingCoefficientDelta?: number | null;
  spareCoefficientDelta?: number | null;
}

/** The subset of writable fields a DRAFT-only detail PATCH may change. */
export interface BomChangeRequestItemPatchInput {
  changeType?: BomChangeType;
  drawingCoefficientDelta?: number | null;
  spareCoefficientDelta?: number | null;
}

/**
 * `bomItem` is INCLUDEd with the item row so the part name travels with it in ONE query.
 * Selecting only `partName` keeps the read honest: nothing else about the item is this
 * slice's business, and a wider projection would invite a second opinion about the item's
 * state to be derived here.
 */
const ITEM_INCLUDE = { bomItem: { select: { partName: true } } } as const;

type BomChangeRequestItemWithPart = BomChangeRequestItem & { bomItem: { partName: string } };

/**
 * Narrows a row read with the `bomItem` include to the API's flat shape.
 *
 * The mapper exists rather than a `select` because the STORED columns are the contract —
 * `BomChangeRequestItemRecord` IS the row — and the part name is an added read-only
 * projection. Returning the nested object instead would leak the relation's shape into
 * every consumer and invite somebody to accept `bomItem` on a WRITE.
 */
function toItemRecord(row: BomChangeRequestItemWithPart): BomChangeRequestItemRecord {
  const { bomItem, ...rest } = row;
  return { ...rest, partName: bomItem.partName };
}

@Injectable()
export class BomChangeRequestRepository {
  constructor(private readonly prisma: ProductionPrismaService) {}

  // ---------------------------------------------------------------------------
  // HEADER
  // ---------------------------------------------------------------------------

  /**
   * Inserts one change request for the acting tenant.
   *
   * NO PARENT GUARD IS NEEDED and none is faked: the header has no parent, `status` closes
   * at the schema's `DRAFT` default, and "the BOM exists in this tenant" is a composite
   * FOREIGN KEY (`tenant_id`, `bom_id`) that Postgres enforces — the service checks it
   * first so the caller gets a 404 naming the right cause rather than a driver error.
   */
  async create(
    tenantId: string,
    data: BomChangeRequestCreateInput
  ): Promise<BomChangeRequestRecord> {
    return this.prisma.bomChangeRequest.create({ data: { ...data, tenantId } });
  }

  /** One request of the acting tenant, or `null`. Never a read by id alone. */
  async findById(tenantId: string, id: string): Promise<BomChangeRequestRecord | null> {
    return this.prisma.bomChangeRequest.findFirst({ where: { id, tenantId } });
  }

  /**
   * One page of this tenant's requests, newest first, plus the total counted with the SAME
   * predicate — so a page and its count can never disagree about which rows exist.
   *
   * Every filter is a SERVER-SIDE predicate the DTO whitelists: `bomId`, `projectRef`,
   * `status` and a `contains` search over the title. None of them is an authorization
   * decision — what a caller may see is `production.bom.read` plus the tenant predicate.
   */
  async list(
    tenantId: string,
    query: BomChangeRequestListQuery
  ): Promise<{ requests: BomChangeRequestRecord[]; total: number }> {
    const where = this.buildListWhere(tenantId, query);

    const [requests, total] = await Promise.all([
      this.prisma.bomChangeRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.bomChangeRequest.count({ where }),
    ]);

    return { requests, total };
  }

  /**
   * ONE predicate builder for the register page, its total, its per-status summary and
   * (Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT) the report's page/detail/summary reads.
   *
   * Extracted exactly as `bom.repository.ts` factored `buildListWhere` for its own report
   * seam: a predicate written four times is a predicate whose tenant or filter can differ
   * four ways, and the first divergence would be a summary describing a different
   * population than the table beside it. `tenantId` is a PARAMETER, never a filter key a
   * caller can omit.
   */
  private buildListWhere(
    tenantId: string,
    query: BomChangeRequestFilter
  ): Prisma.BomChangeRequestWhereInput {
    const where: Prisma.BomChangeRequestWhereInput = { tenantId };
    if (query.bomId) where.bomId = query.bomId;
    if (query.projectRef) where.projectRef = query.projectRef;
    if (query.status) where.status = query.status;
    if (query.search) where.title = { contains: query.search };
    return where;
  }

  /**
   * The reporting PAGE read: `list`'s exact predicate, ordering and window, plus Prisma's
   * bounded `_count` subquery over the request's OWN detail rows so the change-line count
   * travels with the row instead of in a second query per row. The ONLY addition over
   * `list` is that count; the rows `list` reads today are unchanged.
   */
  async listWithItemCount(
    tenantId: string,
    query: BomChangeRequestListQuery
  ): Promise<{ requests: BomChangeRequestWithItemCount[]; total: number }> {
    const where = this.buildListWhere(tenantId, query);

    const [requests, total] = await Promise.all([
      this.prisma.bomChangeRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.bomChangeRequest.count({ where }),
    ]);

    return { requests, total };
  }

  /**
   * The reporting DETAIL read: `findById`'s tenant-scoped `findFirst` shape plus the same
   * bounded `_count`. A foreign or unknown id is `null`, never a throw — so the reporting
   * layer's 404 cannot be told apart from "does not exist", which is the isolation rule
   * this repository has always held (`findUnique` carries no tenant predicate).
   */
  async findByIdWithItemCount(
    tenantId: string,
    id: string
  ): Promise<BomChangeRequestWithItemCount | null> {
    return this.prisma.bomChangeRequest.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { items: true } } },
    });
  }

  /**
   * The reporting SUMMARY read: per-status counts over the SAME `buildListWhere` predicate
   * the page answers with, as one bounded `groupBy` — the shape `BomHeaderRepository.
   * countByStatus` established. Rows whose status is not in the result are simply absent
   * here; zero-filling the closed four-member lifecycle set is the READER's decision over
   * the pure `BOM_STATUSES` vocabulary, never this file inventing a bucket.
   */
  async countByStatus(
    tenantId: string,
    query: BomChangeRequestFilter
  ): Promise<Map<string, number>> {
    const where = this.buildListWhere(tenantId, query);

    const groups = await this.prisma.bomChangeRequest.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    return new Map(groups.map((group) => [group.status, group._count._all]));
  }

  /**
   * Applies a DRAFT-only patch and returns the updated row.
   *
   * The `status: 'DRAFT'` predicate travels WITH the write, so a request a concurrent act
   * has already submitted is not edited. `null` is the caller's signal that the row is gone
   * or no longer editable; the SERVICE re-reads so the refusal it returns names the CURRENT
   * status rather than guessing.
   */
  async updateDraft(
    tenantId: string,
    id: string,
    data: BomChangeRequestPatchInput
  ): Promise<BomChangeRequestRecord | null> {
    const result = await this.prisma.bomChangeRequest.updateMany({
      where: { id, tenantId, status: 'DRAFT' },
      data,
    });

    if (result.count === 0) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Submits a DRAFT: DRAFT → SUBMITTED, conditionally, writing NO decision column.
   *
   * WHY THIS IS NOT A `decide` CALL. A submission is not a decision: the approver has not
   * stated anything, so `managerOpinion`, `decidedAt` and `decidedByUserId` must stay NULL.
   * "Nobody has decided" is then readable as NULL rather than as a placeholder value, and
   * the decision columns keep exactly one writer — `decide`.
   *
   * THE EMPTY-REQUEST GATE IS PART OF THE SAME STATEMENT (S4). `items: { some: {} }` refuses
   * a request that holds no detail rows, in the same conditional UPDATE, which is what makes
   * «اقلامی جهت تغییر ثبت نشده است!» atomic rather than a read-then-write pair a concurrent
   * DELETE could invalidate. The SERVICE maps a refusal that lands while the row is STILL a
   * DRAFT to `BOM_CHANGE_REQUEST_ITEMS_REQUIRED`.
   *
   * `submittedAt` is stamped here because this is the instant the routing fact began.
   */
  async submit(
    tenantId: string,
    id: string,
    notes?: string | null,
    outbox?: ProductionAuditOutboxPayload,
  ): Promise<BomChangeRequestRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.bomChangeRequest.updateMany({
        where: { id, tenantId, status: 'DRAFT', items: { some: {} } },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          notes: notes ?? undefined,
        },
      });

      if (result.count === 0) return null;

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return tx.bomChangeRequest.findFirst({ where: { id, tenantId } });
    });
  }

  /**
   * Runs a conditional DECISION: only `from` may move to `to`, and the decision is recorded
   * in the same statement.
   *
   * The expected `from` status is in the WHERE clause, so two concurrent decisions for the
   * same request cannot both win, and a retry of a request whose response was lost loses
   * rather than appending a second decision. Reading the status and then writing it in a
   * second statement would be exactly the `SELECT … then UPDATE` pair this repository's
   * numbering contract refuses.
   *
   * `null` = the row is not in this tenant OR is not in `from`. The SERVICE re-reads to tell
   * them apart, so the refusal it returns is accurate.
   */
  async decide(
    tenantId: string,
    id: string,
    from: BomStatus,
    data: BomChangeRequestDecisionInput,
    outbox?: ProductionAuditOutboxPayload,
  ): Promise<BomChangeRequestRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.bomChangeRequest.updateMany({
        where: { id, tenantId, status: from },
        data: {
          status: data.status,
          managerOpinion: data.managerOpinion,
          notes: data.notes ?? undefined,
          decidedAt: new Date(),
          decidedByUserId: data.decidedByUserId,
        },
      });

      if (result.count === 0) return null;

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return tx.bomChangeRequest.findFirst({ where: { id, tenantId } });
    });
  }

  // ---------------------------------------------------------------------------
  // DETAIL ROWS
  // ---------------------------------------------------------------------------

  /** A detail row of THIS request under THIS tenant, mapped to the API's shape, or `null`. */
  async findItemById(
    tenantId: string,
    changeRequestId: string,
    itemId: string
  ): Promise<BomChangeRequestItemRecord | null> {
    const row = await this.prisma.bomChangeRequestItem.findFirst({
      where: { id: itemId, tenantId, changeRequestId },
      include: ITEM_INCLUDE,
    });
    return row ? toItemRecord(row) : null;
  }

  /**
   * Every detail row of this request, in the order they were added.
   *
   * NOT PAGED, deliberately: the source's «اقلام انتخاب شده» grid was `PageSize=0` (all
   * rows), the set is bounded in practice by the items of ONE BOM, and the submit gate needs
   * the whole set anyway. A page window here would make "does this request hold at least one
   * detail?" a question about a PAGE rather than about the request.
   */
  async listItems(
    tenantId: string,
    changeRequestId: string
  ): Promise<BomChangeRequestItemRecord[]> {
    const rows = await this.prisma.bomChangeRequestItem.findMany({
      where: { tenantId, changeRequestId },
      include: ITEM_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toItemRecord);
  }

  /**
   * Inserts one detail row, or returns `null` when the parent is missing or is no longer
   * editable.
   *
   * THE TRANSACTION IS THE GUARD, NOT DECORATION — the same shape `BomItemRepository.create`
   * uses. `tx.bomChangeRequest.updateMany` runs first with `status: 'DRAFT'` in its WHERE
   * clause: it both bumps the request's `updatedAt` (adding a detail genuinely touches the
   * request) and proves the parent was still editable at the moment of the write. A
   * `count === 0` means a concurrent submit won — the callback returns `null` without
   * inserting, so there is no partial state to roll back from.
   *
   * The DUPLICATE rule (S3) is NOT enforced here: the UNIQUE index
   * `(tenant_id, change_request_id, bom_item_id)` is what makes it true, and the SERVICE
   * pre-checks so the caller gets the typed `BOM_CHANGE_ITEM_DUPLICATE` refusal instead of a
   * raw constraint error. Two layers, two jobs — the pre-check explains, the index
   * guarantees.
   *
   * The composite FK (`tenant_id`, `bom_item_id` → `BomItem`) is the second line of defence
   * for "the item belongs to this tenant": an INSERT naming another tenant's item fails in
   * Postgres even if a predicate here were ever missing.
   */
  async createItem(
    tenantId: string,
    changeRequestId: string,
    data: BomChangeRequestItemCreateInput
  ): Promise<BomChangeRequestItemRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const guard = await tx.bomChangeRequest.updateMany({
        where: { id: changeRequestId, tenantId, status: 'DRAFT' },
        data: { updatedAt: new Date() },
      });

      if (guard.count === 0) return null;

      const created = await tx.bomChangeRequestItem.create({
        data: { ...data, tenantId, changeRequestId },
        include: ITEM_INCLUDE,
      });
      return toItemRecord(created);
    });
  }

  /**
   * Applies a DRAFT-only patch to one detail row.
   *
   * The parent's `status: 'DRAFT'` predicate travels WITH the write through the relation
   * filter, so a detail whose request a concurrent act already submitted is not updated.
   * `null` is the caller's signal that the row is gone or no longer editable; the SERVICE
   * re-reads so the refusal it returns names the CURRENT status.
   */
  async updateItemDraft(
    tenantId: string,
    changeRequestId: string,
    itemId: string,
    data: BomChangeRequestItemPatchInput
  ): Promise<BomChangeRequestItemRecord | null> {
    const result = await this.prisma.bomChangeRequestItem.updateMany({
      where: {
        id: itemId,
        tenantId,
        changeRequestId,
        changeRequest: { status: 'DRAFT' },
      },
      data,
    });

    if (result.count === 0) return null;
    return this.findItemById(tenantId, changeRequestId, itemId);
  }

  /**
   * Deletes a DRAFT-only detail row, conditionally, and reports whether it matched.
   *
   * Same predicate as `updateItemDraft`, same reasoning. The SERVICE reads the row BEFORE
   * calling this, so the audit trail records what was deleted rather than an intent.
   */
  async deleteItemDraft(
    tenantId: string,
    changeRequestId: string,
    itemId: string
  ): Promise<boolean> {
    const result = await this.prisma.bomChangeRequestItem.deleteMany({
      where: {
        id: itemId,
        tenantId,
        changeRequestId,
        changeRequest: { status: 'DRAFT' },
      },
    });
    return result.count > 0;
  }

  /**
   * How many detail rows this request holds — the human-readable form of the submit gate.
   *
   * The SUBMIT itself does NOT use this: it uses the atomic `items: { some: {} }` predicate
   * above. This read exists for the UI's count and for tests, and is deliberately never on a
   * write's critical path.
   */
  async countForRequest(tenantId: string, changeRequestId: string): Promise<number> {
    return this.prisma.bomChangeRequestItem.count({ where: { tenantId, changeRequestId } });
  }
}
