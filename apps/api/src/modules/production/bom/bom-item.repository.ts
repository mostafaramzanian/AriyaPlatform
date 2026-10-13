import { Injectable } from '@nestjs/common';
import { ProductionPrismaService } from '../database/production-prisma.service';
import type { BomItem, Prisma } from '../../../generated/production-client';
import type { BomControlPlan, BomPartType } from './bom-item';

/**
 * Phase PRODUCTION-BOM-ITEM: the BOM Item persistence boundary — every statement this
 * child slice issues against `production_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * It owns INSERTs, conditional UPDATEs/DELETEs and tenant+BOM scoped SELECTs. Whether an
 * item may change at all is the HEADER's state, which lives in `bom-status.ts` and
 * `bom.service.ts` — a repository that refused a write would be a second copy of the
 * lifecycle. `bom.repository.ts` records the same reasoning for Commerce's purchase rows.
 *
 * THE ONE THING ONLY IT CAN DECIDE: THE CONDITIONAL WRITE
 * -------------------------------------------------------
 * Update and delete carry the parent's `status: 'DRAFT'` predicate INSIDE the WHERE clause
 * through the `bom` relation filter, so an item can never be written into a BOM that a
 * concurrent request has already submitted. A read-then-write pair would lose that race;
 * one statement cannot.
 *
 * Create is the exception: Prisma cannot filter a parent on an INSERT, so `create` opens a
 * `$transaction` whose FIRST statement conditionally touches the header while it is still a
 * DRAFT. If that guard matches nothing the callback returns `null` and nothing is written —
 * which is the same atomicity, achieved by two statements that either both commit or
 * neither does.
 *
 * TENANCY
 * -------
 * `tenantId` is the FIRST parameter of every method and appears in EVERY `where`, together
 * with `bomId`. `findUnique` is NEVER used: it cannot carry a tenant predicate, so an id
 * alone would read another tenant's row. `findFirst({ where: { id, tenantId, bomId } })`
 * is the only single-row shape used, and the SERVICE maps `null` to 404.
 *
 * WHAT THIS FILE MUST NEVER DO
 * ----------------------------
 * No HTTP logic, no permission resolution, no call to Project or Product Tree (they do not
 * exist), no access to `commerce_db`, `core_db`, `hr_db` or any other owner's client, no
 * write to `standardPartCode`, and no formula over any `legacyConsumption*` column.
 */

/** The row as Production's own Prisma client returns it. */
export type BomItemRecord = BomItem;

/**
 * The subset of writable fields the service passes on create.
 *
 * `projectRef` / `productTreeRef` are REQUIRED here because they are the DENORMALISED scope
 * snapshot copied from the header at creation (§6.3) — the source stores them on every item
 * and validates the uniqueness scope against them. They are not caller-stated: the service
 * takes them off the HEADER it already loaded.
 */
export interface BomItemCreateInput {
  projectRef: string;
  productTreeRef: string;
  partName: string;
  industryPartName?: string | null;
  partType: BomPartType;
  specifications?: string | null;
  manufacturer?: string | null;
  material: string;
  measurementUnit: string;
  drawingConsumptionCoefficient: number;
  spareConsumptionCoefficient: number;
  suggestedSupplier?: string | null;
  suggestedSupplierPrice?: number | null;
  controlPlan?: BomControlPlan | null;
  notes?: string | null;
}

/**
 * The subset of writable fields a DRAFT-only patch may change.
 *
 * NOTE THE ABSENCE OF `projectRef` / `productTreeRef`: once an item exists its scope
 * snapshot is frozen — the source never edits those on an item either (§6.4), and an item
 * that could silently change project would invalidate the uniqueness scope it was created
 * under. `standardPartCode` is absent because it is deferred (RB-1-P).
 */
export interface BomItemPatchInput {
  partName?: string;
  industryPartName?: string | null;
  partType?: BomPartType;
  specifications?: string | null;
  manufacturer?: string | null;
  material?: string;
  measurementUnit?: string;
  drawingConsumptionCoefficient?: number;
  spareConsumptionCoefficient?: number;
  suggestedSupplier?: string | null;
  suggestedSupplierPrice?: number | null;
  controlPlan?: BomControlPlan | null;
  notes?: string | null;
}

/** The list window and filter, already clamped by the service. */
export interface BomItemListQuery {
  skip: number;
  take: number;
  search?: string;
}

@Injectable()
export class BomItemRepository {
  constructor(private readonly prisma: ProductionPrismaService) {}

  /**
   * Inserts one item for the acting tenant under the named BOM, or returns `null` when the
   * header is missing or is no longer editable.
   *
   * THE TRANSACTION IS THE GUARD, NOT DECORATION. `tx.bomHeader.updateMany` runs first with
   * `status: 'DRAFT'` in its WHERE clause: it both bumps the header's `updatedAt` (adding
   * an item genuinely touches the BOM, so the header's own ordering reflects it) and proves
   * the parent was still editable at the moment of the write. A `count === 0` means a
   * concurrent submit won — the callback returns `null` without inserting, and nothing else
   * was written, so there is no partial state to roll back from.
   *
   * The composite FK (`tenant_id`, `bom_id` → `BomHeader`) is the second line of defence: an
   * INSERT naming another tenant's header fails in Postgres even if a predicate were ever
   * missing here.
   */
  async create(
    tenantId: string,
    bomId: string,
    data: BomItemCreateInput
  ): Promise<BomItemRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const guard = await tx.bomHeader.updateMany({
        where: { id: bomId, tenantId, status: 'DRAFT' },
        data: { updatedAt: new Date() },
      });

      if (guard.count === 0) return null;

      return tx.bomItem.create({ data: { ...data, tenantId, bomId } });
    });
  }

  /**
   * One item of the acting tenant under the acting BOM, or `null`.
   *
   * `null` means ALL OF "does not exist", "belongs to another BOM" and "belongs to another
   * tenant" — deliberately indistinguishable, because telling a caller which it was would
   * confirm that an id exists in a scope the caller cannot see. The SERVICE turns `null`
   * into 404 either way.
   */
  async findById(tenantId: string, bomId: string, id: string): Promise<BomItemRecord | null> {
    return this.prisma.bomItem.findFirst({ where: { id, tenantId, bomId } });
  }

  /**
   * One page of this BOM's items, in the order they were added.
   *
   * `total` is counted with the SAME predicate as the page, so a page and its count can
   * never disagree about which rows exist. `search` matches the PART NAME only: it is a
   * `contains` filter, not an authorization decision — what a caller may see is
   * `production.bom.read` plus the tenant and BOM predicates.
   */
  async list(
    tenantId: string,
    bomId: string,
    query: BomItemListQuery
  ): Promise<{ items: BomItemRecord[]; total: number }> {
    const where: Prisma.BomItemWhereInput = { tenantId, bomId };
    if (query.search) where.partName = { contains: query.search };

    const [items, total] = await Promise.all([
      this.prisma.bomItem.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.bomItem.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Applies a DRAFT-only patch and returns the updated row.
   *
   * The parent's `status: 'DRAFT'` predicate travels WITH the write through the relation
   * filter, so an item belonging to a BOM a concurrent request already submitted is not
   * updated. `null` is the caller's signal that the row is gone or no longer editable; the
   * SERVICE re-reads so the refusal it returns names the CURRENT header status.
   */
  async updateDraft(
    tenantId: string,
    bomId: string,
    id: string,
    data: BomItemPatchInput
  ): Promise<BomItemRecord | null> {
    const result = await this.prisma.bomItem.updateMany({
      where: { id, tenantId, bomId, bom: { status: 'DRAFT' } },
      data,
    });

    if (result.count === 0) return null;
    return this.findById(tenantId, bomId, id);
  }

  /**
   * Deletes a DRAFT-only item, conditionally, and reports whether it matched.
   *
   * Same predicate as `updateDraft`, same reasoning. The SERVICE reads the row BEFORE
   * calling this, so the audit trail records what was deleted rather than an intent.
   */
  async deleteDraft(tenantId: string, bomId: string, id: string): Promise<boolean> {
    const result = await this.prisma.bomItem.deleteMany({
      where: { id, tenantId, bomId, bom: { status: 'DRAFT' } },
    });
    return result.count > 0;
  }

  /**
   * How many items this BOM has — the human-readable form of the submit gate.
   *
   * The SUBMIT itself does NOT use this: it uses the atomic `items: { some: {} }` predicate
   * in `bom.repository.ts`. This read exists for the UI's item count and for tests, and is
   * deliberately never on a write's critical path.
   */
  async countForBom(tenantId: string, bomId: string): Promise<number> {
    return this.prisma.bomItem.count({ where: { tenantId, bomId } });
  }
}
