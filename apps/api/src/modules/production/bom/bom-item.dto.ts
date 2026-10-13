import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { BOM_CONTROL_PLANS, BOM_PART_TYPES } from './bom-item';
import type { BomControlPlan, BomPartType } from './bom-item';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
} from '../production.constants';

/**
 * Phase PRODUCTION-BOM-ITEM: the wire contract of the BOM Item routes — list, get, create,
 * update-while-draft and delete, all under `/production/boms/:bomId/items`.
 *
 * WHAT IS ON THE WIRE, AND WHY THAT LINE IS DRAWN HERE
 * ----------------------------------------------------
 * Every column the source's item list stores is either a DOMAIN field (validated, written)
 * or a LEGACY field (stored for migration, never a rule). Only the DOMAIN half appears
 * below. The legacy half — `Code_Ghatae`, the item's `state`, its `NazarModir` snapshot and
 * the five derived consumption projections — is deliberately NOT accepted and NOT returned:
 * there is no writer for them in the source, so accepting one would invent a contract, and
 * returning one would invite a UI to treat a migration artefact as a fact.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHAT THAT MEANS
 * ------------------------------------------------
 *  * NO `standardPartCode` on create or update. `CodeStandardDarSanat` is a RESERVED,
 *    DEFERRED column: the Product Tree code source that would drive its generation is
 *    BLOCKED (RB-1-P), so no route may mint one, no DTO may be asked to mint one, and no
 *    requiredness is imposed. Because the global pipe runs `whitelist` +
 *    `forbidNonWhitelisted`, sending it anyway is a 400 rather than a silent drop — which
 *    is exactly the "no fake generation button, no invented field" rule, enforced by the
 *    transport instead of by a UI promise.
 *  * NO `tenantId`, NO `bomId` in the body. The tenant comes from
 *    `resolveProductionActor(req)`; the BOM comes from the path parameter and is
 *    re-resolved tenant-scoped by the service. A body that could name either would be a
 *    cross-tenant write.
 *  * NO coefficient beyond the two confirmed ones, and no total: the five derived
 *    coefficients have no writer in the source and no formula anywhere (M-7a / §14).
 *
 * EVERY COLUMN LENGTH BELOW IS THE WIDTH OF THE COLUMN THE VALUE LANDS IN. Without a DTO
 * bound a too-long value reaches Postgres and comes back as a driver error — a 500 for what
 * is a client mistake, with no field name attached. With the bound it is a 400 naming the
 * field, and the database constraint stays the last line of defence rather than the only one.
 */

/** `partName` (the source's item `Title`, «نام قطعه») — `VARCHAR(200)`. REQUIRED (V11). */
export const MAX_BOM_ITEM_PART_NAME_LENGTH = 200;
/** `industryPartName` — `VARCHAR(200)`. Optional (V12 does not validate it). */
export const MAX_BOM_ITEM_INDUSTRY_NAME_LENGTH = 200;
/** `material` — `VARCHAR(200)`. REQUIRED (V14). */
export const MAX_BOM_ITEM_MATERIAL_LENGTH = 200;
/** `measurementUnit` — `VARCHAR(64)`. REQUIRED (V15). */
export const MAX_BOM_ITEM_MEASUREMENT_UNIT_LENGTH = 64;
/** `specifications` — `VARCHAR(2000)`. Optional. */
export const MAX_BOM_ITEM_SPECIFICATIONS_LENGTH = 2000;
/** `manufacturer` — `VARCHAR(200)`. Optional (explicitly not required, §10.6). */
export const MAX_BOM_ITEM_MANUFACTURER_LENGTH = 200;
/** `suggestedSupplier` — `VARCHAR(200)`. Optional, and a SUGGESTION (§15). */
export const MAX_BOM_ITEM_SUPPLIER_LENGTH = 200;
/** `notes` — `VARCHAR(2000)`. Optional. */
export const MAX_BOM_ITEM_NOTES_LENGTH = 2000;

/**
 * One BOM item as the API returns it.
 *
 * A projection of the row's DOMAIN half only — no derived value, no Persian label, no
 * computed total. A screen that wants «ساختی» renders `BOM_PART_TYPE_LABELS[partType]`.
 * `standardPartCode` is returned (it may hold a migrated value) but is always `null` for a
 * row this API created, because nothing in this phase writes it.
 */
export interface BomItemView {
  id: string;
  bomId: string;
  projectRef: string;
  productTreeRef: string;
  partName: string;
  industryPartName: string | null;
  standardPartCode: string | null;
  partType: string;
  specifications: string | null;
  manufacturer: string | null;
  material: string;
  measurementUnit: string;
  drawingConsumptionCoefficient: number;
  spareConsumptionCoefficient: number;
  suggestedSupplier: string | null;
  suggestedSupplierPrice: string | null;
  controlPlan: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The CREATE payload.
 *
 * The five REQUIRED fields are exactly the source's V11/V13/V14/V15/V16/V17 refusals:
 * `partName`, `partType`, `material`, `measurementUnit` and the two coefficients — every one
 * of which the legacy `btn_Save` refused when empty. Optional fields are optional for the
 * same reason the source left them unvalidated.
 *
 * The two coefficients are `@IsInt() @Min(0)` — integer, `>= 0`, no `@Max()` because the
 * source defines no ceiling, and no decimal because every arithmetic use `parseInt`s
 * (§14.2).
 */
export class CreateBomItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_PART_NAME_LENGTH)
  partName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_INDUSTRY_NAME_LENGTH)
  industryPartName?: string;

  @IsIn(BOM_PART_TYPES)
  partType!: BomPartType;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_SPECIFICATIONS_LENGTH)
  specifications?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_MANUFACTURER_LENGTH)
  manufacturer?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_MATERIAL_LENGTH)
  material!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_MEASUREMENT_UNIT_LENGTH)
  measurementUnit!: string;

  @IsInt()
  @Min(0)
  drawingConsumptionCoefficient!: number;

  @IsInt()
  @Min(0)
  spareConsumptionCoefficient!: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_SUPPLIER_LENGTH)
  suggestedSupplier?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  suggestedSupplierPrice?: number;

  @IsOptional()
  @IsIn(BOM_CONTROL_PLANS)
  controlPlan?: BomControlPlan;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_NOTES_LENGTH)
  notes?: string;
}

/**
 * The list query — the shared pagination envelope of every Production list endpoint.
 *
 * `PRODUCTION_MAX_PAGE_SIZE` is enforced HERE (a 400 for an absurd page size) and again in
 * the service (`Math.min`), the same two-bounds rule `bom.dto.ts` records. `search` matches
 * the PART NAME — the one free-text column this child has — and is a `contains` filter, not
 * an authorization decision: what a caller may see is `production.bom.read` plus the tenant
 * and BOM predicates.
 *
 * THERE IS NO `tenantId` FIELD AND THERE NEVER WILL BE. The tenant comes from
 * `resolveProductionActor(req)` and the BOM from the path parameter.
 */
export class ListBomItemsQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Resolves the effective page window for an item list query, clamped to the ceiling. */
export function resolveBomItemPageWindow(query: ListBomItemsQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(
    PRODUCTION_MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ?? PRODUCTION_DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * The PATCH payload — domain fields only, and only while the parent BOM is a DRAFT.
 *
 * EVERY FIELD IS OPTIONAL, for the same reason the header's PATCH is all-optional: a patch
 * that stated nothing would still bump `updatedAt` and still audit an "update", and a trail
 * in which a no-op is indistinguishable from a real edit is a trail that lies. The service
 * refuses an empty patch with 400.
 *
 * `partType` IS editable here because the source let an author correct a part type before
 * submission; it is NOT a lifecycle fact like the header's `status`. `standardPartCode` is
 * absent for the reason stated at the top of this file.
 */
export class UpdateBomItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_PART_NAME_LENGTH)
  partName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_INDUSTRY_NAME_LENGTH)
  industryPartName?: string;

  @IsOptional()
  @IsIn(BOM_PART_TYPES)
  partType?: BomPartType;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_SPECIFICATIONS_LENGTH)
  specifications?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_MANUFACTURER_LENGTH)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_MATERIAL_LENGTH)
  material?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_ITEM_MEASUREMENT_UNIT_LENGTH)
  measurementUnit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  drawingConsumptionCoefficient?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  spareConsumptionCoefficient?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_SUPPLIER_LENGTH)
  suggestedSupplier?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  suggestedSupplierPrice?: number;

  @IsOptional()
  @IsIn(BOM_CONTROL_PLANS)
  controlPlan?: BomControlPlan;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_ITEM_NOTES_LENGTH)
  notes?: string;
}


