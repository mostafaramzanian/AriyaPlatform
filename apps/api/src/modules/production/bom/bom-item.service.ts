import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProductionAuditGateway } from '../production-audit.gateway';
import { PRODUCTION_AUDIT_RESOURCE } from '../production.constants';
import { BomHeaderRepository } from './bom.repository';
import type { BomHeaderRecord } from './bom.repository';
import { isBomHeaderEditable } from './bom-status';
import { BomItemRepository } from './bom-item.repository';
import type { BomItemCreateInput, BomItemPatchInput, BomItemRecord } from './bom-item.repository';
import {
  PRODUCTION_BOM_ERROR_CODES,
  isValidConsumptionCoefficient,
} from './bom-item';
import {
  resolveBomItemPageWindow,
  type BomItemView,
  type CreateBomItemDto,
  type ListBomItemsQueryDto,
  type UpdateBomItemDto,
} from './bom-item.dto';

/**
 * Phase PRODUCTION-BOM-ITEM: the BOM Item slice's application surface — list, get,
 * create, update-while-draft and delete, all scoped to ONE header of ONE tenant.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT
 * ----------------------------------------
 * It owns ORCHESTRATION and the rules that need more than one fact: that the header exists
 * and belongs to this tenant, that it is still editable, that a required field really is
 * non-blank once trimmed, and that the audit trail records what was actually written. It
 * issues NO raw Prisma query and holds no client — persistence is `BomItemRepository`'s.
 *
 * THE HEADER IS THE AUTHORITY FOR EVERYTHING THE ITEM CANNOT ANSWER ALONE.
 * -----------------------------------------------------------------------
 * The item's `projectRef` / `productTreeRef` are COPIED off the header at creation rather
 * than read from the body (§6.3), so a caller cannot place an item under a project other
 * than its BOM's. Whether the item may change at all is `isBomHeaderEditable(header.status)`
 * — the header's own predicate, not a second lifecycle. And the item's own DRAFT guard is
 * enforced INSIDE the repository's write, so this file never has to guess whether a
 * concurrent submit won.
 *
 * TENANT AND BOM SCOPE TOGETHER, ALWAYS. `requireHeader` resolves the header by
 * `tenantId` + `id` from the PATH (never the body), and `requireItem` resolves the item by
 * `tenantId` + `bomId` + `itemId`. A cross-tenant or cross-BOM id is a 404 that cannot be
 * distinguished from "does not exist" — by design, so an answer cannot confirm that an id
 * exists in a scope the caller cannot see.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 *  * NO `standardPartCode` handling of any kind: no generation, no uniqueness rule, no
 *    requiredness. Product Tree Code is DEFERRED (RB-1-P) and this file does not fake it.
 *  * NO duplicate-part-name rule. The source's V12 scope is "within the PROJECT", which
 *    would need a cross-BOM query across every BOM of a project; the contract for that scope
 *    is not established, so it is not invented here.
 *  * NO total or sum over the coefficients, and no rule of any kind on the five legacy
 *    consumption columns (M-7a / §14).
 *  * NO notification, NO search projection, NO workflow: audit is not notification, and
 *    neither contract is claimed by an item mutation.
 */

/** The audit `action` values this child slice records. Lowercase verbs, like the header's. */
export const PRODUCTION_BOM_ITEM_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
} as const;

/** The actor shape this service needs — structurally `ProductionActor`. */
interface BomItemActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Projects a stored row onto the wire shape. No derived field, no label, no total.
 *
 * The LEGACY columns are deliberately absent: they exist for migration and traceability
 * only, and a response carrying them would invite a screen to render a migration artefact
 * as a live fact.
 *
 * `suggestedSupplierPrice` is a `Decimal` in storage and a STRING on the wire, so a price
 * never crosses the boundary as a lossy binary float.
 */
export function toBomItemView(row: BomItemRecord): BomItemView {
  return {
    id: row.id,
    bomId: row.bomId,
    projectRef: row.projectRef,
    productTreeRef: row.productTreeRef,
    partName: row.partName,
    industryPartName: row.industryPartName,
    standardPartCode: row.standardPartCode,
    partType: row.partType,
    specifications: row.specifications,
    manufacturer: row.manufacturer,
    material: row.material,
    measurementUnit: row.measurementUnit,
    drawingConsumptionCoefficient: row.drawingConsumptionCoefficient,
    spareConsumptionCoefficient: row.spareConsumptionCoefficient,
    suggestedSupplier: row.suggestedSupplier,
    suggestedSupplierPrice:
      row.suggestedSupplierPrice === null ? null : row.suggestedSupplierPrice.toString(),
    controlPlan: row.controlPlan,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class BomItemService {
  constructor(
    private readonly items: BomItemRepository,
    private readonly headers: BomHeaderRepository,
    private readonly audit: ProductionAuditGateway
  ) {}

  /** One page of this BOM's items, in the order they were added. */
  async list(
    actor: BomItemActor,
    bomId: string,
    query: ListBomItemsQueryDto
  ): Promise<{ items: BomItemView[]; total: number; page: number; pageSize: number }> {
    const header = await this.requireHeader(actor.tenantId, bomId);
    const window = resolveBomItemPageWindow(query);

    const { items, total } = await this.items.list(actor.tenantId, header.id, {
      skip: window.skip,
      take: window.take,
      search: query.search,
    });

    return {
      items: items.map(toBomItemView),
      total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /** One item of this BOM, or 404 — including when it belongs to a different BOM. */
  async getOne(actor: BomItemActor, bomId: string, itemId: string): Promise<BomItemView> {
    const header = await this.requireHeader(actor.tenantId, bomId);
    return toBomItemView(await this.requireItem(header.id, itemId, actor.tenantId));
  }

  /**
   * Adds an item to a DRAFT BOM.
   *
   * THE SCOPE SNAPSHOT IS TAKEN FROM THE HEADER, NOT FROM THE BODY. `projectRef` and
   * `productTreeRef` are the two values the source duplicates onto every item (§6.3); both
   * come from the header this request already resolved, so no payload can claim a project
   * other than the BOM's own — which is what makes the uniqueness scope meaningful later.
   *
   * THE REPOSITORY RETURNS `null` ONLY WHEN THE HEADER STOPPED BEING EDITABLE between the
   * check above and the transaction's guard. Re-reading turns that race into an accurate
   * 409 naming the CURRENT status rather than a generic failure.
   */
  async create(
    actor: BomItemActor,
    bomId: string,
    dto: CreateBomItemDto
  ): Promise<BomItemView> {
    const header = await this.requireHeader(actor.tenantId, bomId);
    this.assertEditable(header);

    const data: BomItemCreateInput = {
      projectRef: header.projectRef,
      productTreeRef: header.productTreeRef,
      partName: this.requireText(dto.partName, 'partName'),
      industryPartName: dto.industryPartName ?? null,
      partType: dto.partType,
      specifications: dto.specifications ?? null,
      manufacturer: dto.manufacturer ?? null,
      material: this.requireText(dto.material, 'material'),
      measurementUnit: this.requireText(dto.measurementUnit, 'measurementUnit'),
      drawingConsumptionCoefficient: this.requireCoefficient(
        dto.drawingConsumptionCoefficient,
        'drawingConsumptionCoefficient'
      ),
      spareConsumptionCoefficient: this.requireCoefficient(
        dto.spareConsumptionCoefficient,
        'spareConsumptionCoefficient'
      ),
      suggestedSupplier: dto.suggestedSupplier ?? null,
      suggestedSupplierPrice: dto.suggestedSupplierPrice ?? null,
      controlPlan: dto.controlPlan ?? null,
      notes: dto.notes ?? null,
    };

    const row = await this.items.create(actor.tenantId, header.id, data);

    if (!row) {
      const now = await this.requireHeader(actor.tenantId, header.id);
      this.assertEditable(now);
      // The guard said DRAFT and the insert still failed: state changed twice under us.
      throw new ConflictException({
        code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
        message: 'This BOM changed state while the item was being saved; please retry.',
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.CREATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_ITEM,
      resourceId: row.id,
      newValue: { bomId: header.id, partName: row.partName, partType: row.partType },
    });

    return toBomItemView(row);
  }

  /**
   * Patches a DRAFT item. 409 once its BOM has been submitted.
   *
   * AN EMPTY PATCH IS A 400, for the same reason the header's is: `updatedAt` only moves on
   * a real write, so an audit row for a mutation that changed nothing would make the trail
   * unable to distinguish a no-op from a real edit, and `changedFields` would be a list
   * nothing can act on.
   *
   * The DRAFT guard lives INSIDE the repository's WHERE clause, so an item whose BOM a
   * concurrent request submitted is never updated — the race resolves into an accurate 409
   * naming the CURRENT status rather than a lost write.
   */
  async update(
    actor: BomItemActor,
    bomId: string,
    itemId: string,
    dto: UpdateBomItemDto
  ): Promise<BomItemView> {
    const header = await this.requireHeader(actor.tenantId, bomId);
    this.assertEditable(header);
    const current = await this.requireItem(header.id, itemId, actor.tenantId);

    const patch: BomItemPatchInput = {};
    if (dto.partName !== undefined) patch.partName = this.requireText(dto.partName, 'partName');
    if (dto.industryPartName !== undefined) patch.industryPartName = dto.industryPartName;
    if (dto.partType !== undefined) patch.partType = dto.partType;
    if (dto.specifications !== undefined) patch.specifications = dto.specifications;
    if (dto.manufacturer !== undefined) patch.manufacturer = dto.manufacturer;
    if (dto.material !== undefined) patch.material = this.requireText(dto.material, 'material');
    if (dto.measurementUnit !== undefined) {
      patch.measurementUnit = this.requireText(dto.measurementUnit, 'measurementUnit');
    }
    if (dto.drawingConsumptionCoefficient !== undefined) {
      patch.drawingConsumptionCoefficient = this.requireCoefficient(
        dto.drawingConsumptionCoefficient,
        'drawingConsumptionCoefficient'
      );
    }
    if (dto.spareConsumptionCoefficient !== undefined) {
      patch.spareConsumptionCoefficient = this.requireCoefficient(
        dto.spareConsumptionCoefficient,
        'spareConsumptionCoefficient'
      );
    }
    if (dto.suggestedSupplier !== undefined) patch.suggestedSupplier = dto.suggestedSupplier;
    if (dto.suggestedSupplierPrice !== undefined) {
      patch.suggestedSupplierPrice = dto.suggestedSupplierPrice;
    }
    if (dto.controlPlan !== undefined) patch.controlPlan = dto.controlPlan;
    if (dto.notes !== undefined) patch.notes = dto.notes;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_ERROR_CODES.PATCH_EMPTY,
        message: 'State at least one field to change.',
      });
    }

    const updated = await this.items.updateDraft(actor.tenantId, header.id, itemId, patch);

    if (!updated) {
      const now = await this.requireHeader(actor.tenantId, header.id);
      this.assertEditable(now);
      throw new ConflictException({
        code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
        message: 'This BOM changed state while the item was being saved; please retry.',
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.UPDATE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_ITEM,
      resourceId: updated.id,
      oldValue: { bomId: header.id, partName: current.partName },
      newValue: { bomId: header.id, partName: updated.partName },
      changedFields: Object.keys(patch),
    });

    return toBomItemView(updated);
  }

  /**
   * Deletes an item from a DRAFT BOM, and reports which one it was.
   *
   * THE ROW IS READ BEFORE IT IS DELETED so the audit trail records what existed, not what
   * the caller intended to remove. The DELETE itself is conditional on the header still
   * being a DRAFT — a submit that landed first makes `deleteDraft` return `false`, which
   * becomes an accurate 409 rather than a silent no-op.
   */
  async delete(
    actor: BomItemActor,
    bomId: string,
    itemId: string
  ): Promise<{ id: string }> {
    const header = await this.requireHeader(actor.tenantId, bomId);
    this.assertEditable(header);
    const current = await this.requireItem(header.id, itemId, actor.tenantId);

    const deleted = await this.items.deleteDraft(actor.tenantId, header.id, itemId);

    if (!deleted) {
      const now = await this.requireHeader(actor.tenantId, header.id);
      this.assertEditable(now);
      throw new ConflictException({
        code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
        message: 'This BOM changed state while the item was being deleted; please retry.',
      });
    }

    await this.audit.record(actor, {
      action: PRODUCTION_BOM_ITEM_AUDIT_ACTION.DELETE,
      resource: PRODUCTION_AUDIT_RESOURCE.BOM_ITEM,
      resourceId: current.id,
      oldValue: { bomId: header.id, partName: current.partName },
    });

    return { id: current.id };
  }

  // ---------------------------------------------------------------------------
  // PRIVATE RULES — the facts this slice needs and cannot get from its own table.
  // ---------------------------------------------------------------------------

  /**
   * One header of the acting tenant, or 404. Never a read by id alone.
   *
   * The PATH parameter is the only source of the BOM id; it is already parsed as a UUID v4
   * by the controller, so this is the first thing that can say "not yours" — and it says it
   * the same way it says "does not exist", on purpose.
   */
  private async requireHeader(tenantId: string, bomId: string): Promise<BomHeaderRecord> {
    const row = await this.headers.findById(tenantId, bomId);
    if (!row) {
      throw new NotFoundException({
        code: PRODUCTION_BOM_ERROR_CODES.ITEM_NOT_FOUND,
        message: 'BOM not found.',
      });
    }
    return row;
  }

  /**
   * One item of THIS BOM under THIS tenant, or 404.
   *
   * `bomId` travels with the predicate, so an item id that belongs to a different BOM in the
   * same tenant is indistinguishable from one that does not exist — a caller cannot probe
   * for item ids across BOMs it has not been pointed at.
   */
  private async requireItem(bomId: string, itemId: string, tenantId: string): Promise<BomItemRecord> {
    const row = await this.items.findById(tenantId, bomId, itemId);
    if (!row) {
      throw new NotFoundException({
        code: PRODUCTION_BOM_ERROR_CODES.ITEM_NOT_FOUND,
        message: 'BOM item not found.',
      });
    }
    return row;
  }

  /**
   * Refuses a mutation when the BOM is no longer a DRAFT.
   *
   * This is `isBomHeaderEditable` — the HEADER's predicate, reused rather than re-derived,
   * because "may an item change?" and "may the header change?" are the same question with
   * one answer. Rule 2/3 of the item contract (edit only while editable; submit freezes
   * every item) fall out of this single call, and rule 6 (correction returns the header to
   * DRAFT makes items editable again) falls out of `isBomHeaderEditable` being the only
   * thing asked — there is no separate item state to un-freeze.
   */
  private assertEditable(header: BomHeaderRecord): void {
    if (!isBomHeaderEditable(header.status)) {
      throw new ConflictException({
        code: PRODUCTION_BOM_ERROR_CODES.HEADER_NOT_EDITABLE,
        message: `This BOM is ${header.status} and its items can no longer be changed; only a DRAFT is editable.`,
      });
    }
  }

  /**
   * Trims and requires a text field, or refuses naming it.
   *
   * `@IsNotEmpty()` in the DTO rejects `""` but not `"   "`, and a part name of three spaces
   * is exactly the value the source refused (`نام قطعه نمی تواند خالی باشد!`). Trimming
   * here is what makes the rule mean "non-blank" rather than "length > 0".
   */
  private requireText(value: string | undefined, field: string): string {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_ERROR_CODES.FIELD_REQUIRED,
        message: `${field} is required and cannot be blank.`,
      });
    }
    return trimmed;
  }

  /**
   * Re-asserts the coefficient rule before it is written.
   *
   * The DTO already binds it with `@IsInt() @Min(0)`; this second assertion exists because
   * the DTO is a WIRE bound while `isValidConsumptionCoefficient` is the DOMAIN fact, and a
   * future internal caller building a patch object directly must not be able to bypass it.
   * It is deliberately the ONLY coefficient rule: no maximum, no unit, no total (§5 / §14).
   */
  private requireCoefficient(value: number, field: string): number {
    if (!isValidConsumptionCoefficient(value)) {
      throw new BadRequestException({
        code: PRODUCTION_BOM_ERROR_CODES.COEFFICIENT_INVALID,
        message: `${field} must be an integer greater than or equal to 0.`,
      });
    }
    return value;
  }
}


