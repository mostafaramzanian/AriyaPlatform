import { Injectable } from '@nestjs/common';
import { ProductionPrismaService } from '../database/production-prisma.service';
import type { BomHeader, Prisma } from '../../../generated/production-client';
import type { BomStatus, BomManagerOpinion } from './bom-status';
import type { ProductionAuditOutboxPayload } from '../production-audit.gateway';

/**
 * Phase PRODUCTION-BOM-HEADER: the BOM Header persistence boundary — every statement
 * this slice issues against `production_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * This file owns INSERTs, UPDATEs and tenant-scoped SELECTs. It does not decide whether
 * a BOM is editable, whether a transition is legal, whether an approver may approve, or
 * whether a self-approval is refused — those live in `bom-status.ts` and
 * `bom.service.ts`. A repository that refused a status change would be a second place
 * the lifecycle is written down, and the two would disagree the first time one of them
 * changed. `purchase.repository.ts` records the same reasoning for Commerce.
 *
 * THE ONE THING IT DOES DECIDE, BECAUSE ONLY IT CAN
 * -------------------------------------------------
 * The CONDITIONAL TRANSITION: `transition` carries the expected `from` status inside the
 * WHERE clause, so two concurrent decision requests for the same BOM cannot both win.
 * That is a persistence concern (it must be one statement to be atomic), which is why it
 * lives here rather than in the service.
 *
 * TENANCY
 * -------
 * `tenantId` is the FIRST parameter of every method and appears in EVERY `where`.
 * `prisma.findUnique` is NEVER used: it cannot carry a tenant predicate, so a "find by
 * id" written with it would read another tenant's row — and an `id` alone is not an
 * isolation key. `findFirst({ where: { id, tenantId } })` is the only shape used for a
 * single row, so a foreign id returns `null` and the SERVICE maps that to 404.
 *
 * WHAT THIS FILE MUST NEVER DO
 * ----------------------------
 * No HTTP logic, no permission resolution, no call to Project or Product Tree (they do
 * not exist), no access to `commerce_db`, `core_db`, `hr_db` or any other owner's client.
 * The ONE item statement this file issues is the `items: { some: {} }` predicate inside
 * `submit` — an existence check on its OWN child, in the same conditional UPDATE, because
 * expressing it as a separate read would make "an empty BOM cannot be submitted" a race.
 * Every other item read and write lives in `bom-item.repository.ts`.
 */

/** The row as Production's own Prisma client returns it. */
export type BomHeaderRecord = BomHeader;

/** The subset of writable fields the service passes on create. */
export interface BomHeaderCreateInput {
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string;
  comments?: string | null;
}

/** The subset of writable fields a DRAFT-only patch may change. */
export interface BomHeaderPatchInput {
  title?: string;
  projectRef?: string;
  productTreeRef?: string;
  approverUserId?: string;
  comments?: string | null;
}

/** What a decision act writes: the status it lands on and the decision record. */
export interface BomHeaderDecisionInput {
  status: BomStatus;
  managerOpinion: BomManagerOpinion;
  comments?: string | null;
  decidedByUserId: string;
}

/** The list window and filters, already clamped by the service. */
export interface BomHeaderListQuery {
  skip: number;
  take: number;
  status?: BomStatus;
  search?: string;
  /**
   * Phase KPI-RUNTIME: half-open instant window on `decidedAt` — ISO 8601 strings. The SAME
   * filter the report contract names (`ProductionReportQuery.decidedFrom/decidedTo`), stated
   * here so the KPI runtime can scope a cohort to one Jalali month through the seam.
   */
  decidedFrom?: string;
  decidedTo?: string;
}

/**
 * The FILTER half of `BomHeaderListQuery` — the part a list page, a status aggregation
 * and the reporting reads must agree on (Phase REPORTING-PRODUCTION-REPORT).
 *
 * Extracted as a named type so `buildListWhere` can be the ONE predicate builder for all
 * three: a page, its total and its per-status summary that each rebuilt the predicate
 * would be three places the tenant or a filter could drift apart.
 */
export type BomHeaderFilter = Pick<
  BomHeaderListQuery,
  'status' | 'search' | 'decidedFrom' | 'decidedTo'
>;

/** A header row PLUS its item count, as the reporting reads receive it. */
export type BomHeaderWithItemCount = BomHeaderRecord & { _count: { items: number } };

@Injectable()
export class BomHeaderRepository {
  constructor(private readonly prisma: ProductionPrismaService) {}

  /**
   * Inserts one header for the acting tenant and returns the created row.
   *
   * `status` is NOT a parameter: a created BOM is always a DRAFT, and the schema's
   * default says so. Letting a caller pass `APPROVED` here would be a write path that
   * bypasses every transition the routes own.
   */
  async create(tenantId: string, data: BomHeaderCreateInput): Promise<BomHeaderRecord> {
    return this.prisma.bomHeader.create({ data: { ...data, tenantId } });
  }

  /**
   * One row of the acting tenant, or `null`.
   *
   * `null` means BOTH "does not exist" and "belongs to another tenant" — deliberately
   * indistinguishable, because telling a caller which of the two it was would confirm
   * that an id exists in a tenant the caller cannot see. The SERVICE turns `null` into
   * 404 either way.
   */
  async findById(tenantId: string, id: string): Promise<BomHeaderRecord | null> {
    return this.prisma.bomHeader.findFirst({ where: { id, tenantId } });
  }

  /**
   * One page of the acting tenant's headers, newest first.
   *
   * `total` is counted with the SAME predicate as the page, so a page and its count can
   * never disagree about which rows exist.
   *
   * `search` matches the TITLE only: the header has exactly one free-text column, and a
   * search that matched a description nobody stores would be a route that always returns
   * everything. It is a `contains` filter, not an authorization decision — what a caller
   * may see is decided by `production.bom.read` and by the tenant predicate.
   */
  async list(
    tenantId: string,
    query: BomHeaderListQuery
  ): Promise<{ items: BomHeaderRecord[]; total: number }> {
    const where = this.buildListWhere(tenantId, query);

    const [items, total] = await Promise.all([
      this.prisma.bomHeader.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.bomHeader.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * THE one predicate every header LIST-shaped read is built from — `list`,
   * `listWithItemCount` and `countByStatus` (Phase REPORTING-PRODUCTION-REPORT).
   *
   * `tenantId` is unconditional; `status` and `search` are the ONLY filters the header
   * read contract supports, applied exactly as `list` always applied them. A second
   * builder that re-stated these three lines would be a second place the tenant
   * predicate could be forgotten — which is why the reporting seam reaches THIS one
   * rather than composing its own.
   */
  private buildListWhere(tenantId: string, query: BomHeaderFilter): Prisma.BomHeaderWhereInput {
    const where: Prisma.BomHeaderWhereInput = { tenantId };

    if (query.status) where.status = query.status;
    if (query.search) where.title = { contains: query.search };
    if (query.decidedFrom !== undefined || query.decidedTo !== undefined) {
      // Phase KPI-RUNTIME: the half-open `[from, to)` window the report contract declares —
      // `gte` on the lower bound, `lt` on the upper. Half-open on purpose: a closed upper
      // bound would either double-count a row at the boundary or drop the final
      // millisecond of the month, and Jalali month arithmetic already produces "next month
      // at 00:00" as the exclusive end (`jalaliDayRange`).
      where.decidedAt = {
        ...(query.decidedFrom !== undefined ? { gte: new Date(query.decidedFrom) } : {}),
        ...(query.decidedTo !== undefined ? { lt: new Date(query.decidedTo) } : {}),
      };
    }
    return where;
  }

  /**
   * Phase REPORTING-PRODUCTION-REPORT: one page of the acting tenant's headers WITH each
   * header's item count — the source-owned query the Production reporting seam reads.
   *
   * Same predicate (`buildListWhere`), same `updatedAt desc` order and same page/count
   * pairing as `list`; the ONLY addition is Prisma's bounded `_count` subquery over the
   * header's OWN child, so the count of items is read with the row rather than in a
   * second pass. This is a COUNT of rows that exist — not a figure computed from them —
   * exactly the property `lineCount` has on the Commerce register.
   *
   * Nothing outside this repository sees `_count`: the projection onto the contract's
   * `itemCount` field belongs to the reporting reader, and Production's own routes keep
   * reading `list` unchanged.
   */
  async listWithItemCount(
    tenantId: string,
    query: BomHeaderListQuery
  ): Promise<{ items: BomHeaderWithItemCount[]; total: number }> {
    const where = this.buildListWhere(tenantId, query);

    const [items, total] = await Promise.all([
      this.prisma.bomHeader.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.bomHeader.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Phase REPORTING-PRODUCTION-REPORT: one header of the acting tenant WITH its item
   * count, or `null`.
   *
   * The tenant-scoped `findFirst` shape of `findById` — never `findUnique`, for the same
   * reason: a foreign id must be indistinguishable from a missing one, so the reporting
   * detail and timeline can answer 404 without becoming an existence oracle. The
   * reporting reader uses THIS instead of `findById` so its detail row and its list rows
   * carry the identical field set.
   */
  async findByIdWithItemCount(
    tenantId: string,
    id: string
  ): Promise<BomHeaderWithItemCount | null> {
    return this.prisma.bomHeader.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { items: true } } },
    });
  }

  /**
   * Phase REPORTING-PRODUCTION-REPORT: per-status row counts over the SAME predicate the
   * list pages with — the summary's bounded aggregation (one `groupBy`, not a scan).
   *
   * The keys this method can return are whatever the DATABASE holds; zero-filling the
   * closed lifecycle set is the reader's decision, because only the pure vocabulary module
   * may state how many states exist. A status the lifecycle does not declare can be
   * COUNTED here but can never be NAMED by the summary — and a missing member reads as `0`
   * rather than as a hole.
   */
  async countByStatus(tenantId: string, query: BomHeaderFilter): Promise<Map<string, number>> {
    const where = this.buildListWhere(tenantId, query);

    const groups = await this.prisma.bomHeader.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    return new Map(groups.map((group) => [group.status, group._count._all]));
  }

  /**
   * Applies a DRAFT-only patch and returns the updated row.
   *
   * The `status: 'DRAFT'` predicate travels WITH the write, so a row a concurrent request
   * has already submitted is not updated — the route's "only while editable" rule and the
   * database's own atomicity agree instead of racing. A `null` return is the caller's
   * signal that the row either does not exist in this tenant or is no longer editable;
   * the SERVICE distinguishes the two by re-reading, so the 409 it returns names the
   * CURRENT status rather than guessing.
   */
  async updateDraft(
    tenantId: string,
    id: string,
    data: BomHeaderPatchInput
  ): Promise<BomHeaderRecord | null> {
    const result = await this.prisma.bomHeader.updateMany({
      where: { id, tenantId, status: 'DRAFT' },
      data,
    });

    if (result.count === 0) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Submits a DRAFT: DRAFT → SUBMITTED, conditionally, writing NO decision column.
   *
   * WHY THIS IS NOT A `transition` CALL. A submission is not a decision: the approver has
   * not yet stated anything, so `managerOpinion`, `decidedAt` and `decidedByUserId` must
   * stay NULL. "Nobody has decided" is then readable as NULL rather than as a placeholder
   * value, and the decision columns keep exactly one writer — `decide` — for the same
   * reason `PurchaseRepository` stays the only writer of a document's status.
   *
   * The `status: 'DRAFT'` predicate travels WITH the write, so a second submit — or a
   * submit racing an edit — finds `count === 0` and loses rather than both winning.
   * `submittedAt` is stamped here because this is the instant the routing fact began.
   *
   * THE ITEM PREDICATE IS PART OF THE SAME STATEMENT (Phase PRODUCTION-BOM-ITEM).
   * `items: { some: {} }` refuses a BOM that holds no rows, in the same conditional UPDATE,
   * which is what makes "a BOM cannot be submitted empty" atomic rather than a
   * read-then-write pair a concurrent DELETE could invalidate. It expresses the source's V8
   * rule (`اقلامی ثبت نشده است!`) as a database fact; the SERVICE maps a refusal that lands
   * while the row is STILL a DRAFT to `BOM_SUBMIT_ITEMS_REQUIRED`.
   */
  async submit(
    tenantId: string,
    id: string,
    comments?: string | null,
    outbox?: ProductionAuditOutboxPayload,
  ): Promise<BomHeaderRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.bomHeader.updateMany({
        where: { id, tenantId, status: 'DRAFT', items: { some: {} } },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          comments: comments ?? undefined,
        },
      });

      if (result.count === 0) return null;

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return tx.bomHeader.findFirst({ where: { id, tenantId } });
    });
  }

  /**
   * Runs a conditional DECISION: only `from` may move to `to`, and the decision is
   * recorded in the same statement.
   *
   * The expected `from` status is in the WHERE clause, so two concurrent decisions for the
   * same BOM cannot both win, and a retry of a request whose response was lost loses
   * rather than appending a second decision. Reading the status and then writing it in a
   * second statement would be exactly the `SELECT … then UPDATE` pair this repository's
   * own numbering contract refuses.
   *
   * `null` = the row is not in this tenant OR is not in `from`. The SERVICE re-reads to
   * tell them apart, so the refusal it returns is accurate.
   */
  async decide(
    tenantId: string,
    id: string,
    from: BomStatus,
    data: BomHeaderDecisionInput,
    outbox?: ProductionAuditOutboxPayload,
  ): Promise<BomHeaderRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.bomHeader.updateMany({
        where: { id, tenantId, status: from },
        data: {
          status: data.status,
          managerOpinion: data.managerOpinion,
          comments: data.comments ?? undefined,
          decidedAt: new Date(),
          decidedByUserId: data.decidedByUserId,
        },
      });

      if (result.count === 0) return null;

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return tx.bomHeader.findFirst({ where: { id, tenantId } });
    });
  }
}
