import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PRODUCTION_DEFAULT_PAGE_SIZE, PRODUCTION_MAX_PAGE_SIZE } from '../production.constants';
import { BOM_CHANGE_TYPES, BOM_STATUSES } from './bom-change';
import type { BomChangeType, BomChangeRequestStatus } from './bom-change';

/**
 * Phase PRODUCTION-BOM-CHANGE: the wire contract of the BOM Change Request routes.
 *
 * WHAT IS ON THE WIRE, AND WHAT IS DELIBERATELY NOT
 * ------------------------------------------------
 *  * NO `tenantId` — it comes from `resolveProductionActor(req)`. The global pipe runs
 *    `whitelist` + `forbidNonWhitelisted`, so sending one is a 400 rather than a silently
 *    ignored field, which is the difference between a multi-tenant module and a data leak.
 *  * NO `requesterUserId` — the source resolved the requester from the CURRENT user, and
 *    Ariya takes it from `actor.userId`. A body that could name somebody else would be a
 *    delegated-authorship feature nobody asked for.
 *  * NO `status`, NO `managerOpinion`, NO `decidedAt`, NO `decidedByUserId` — the lifecycle
 *    is walked by the routes that own each transition. A body that could set `APPROVED`
 *    would be a way to approve your own request.
 *  * NO `projectRef` / `productTreeRef` — they are COPIED off the target BOM the request
 *    already points at, exactly as `BomItem` copies its scope snapshot off its header. A
 *    caller that could state them could file a change against project A that names BOM B.
 *  * NO `originalDrawingCoefficient` / `originalSpareCoefficient` — the snapshot is taken
 *    from the ITEM at creation (S6). Accepting them on the wire would let a caller write a
 *    history that disagrees with the item it claims to snapshot.
 *  * NO `total` — the source derives `original + delta` for DISPLAY only and never stores
 *    it (S8); a persisted total would be a second, authoritative-looking answer.
 *
 * EVERY COLUMN LENGTH BELOW IS THE WIDTH OF THE COLUMN THE VALUE LANDS IN. Without a DTO
 * bound a too-long value reaches Postgres and comes back as a driver error — a 500 for what
 * is a client mistake, with no field name attached.
 */

/** `title` — `VARCHAR(200)`. REQUIRED (the source's `c_Title` was `IsRequired`). */
export const MAX_BOM_CHANGE_TITLE_LENGTH = 200;
/** `notes` — `VARCHAR(2000)`. Optional: the source never required «توضیحات». */
export const MAX_BOM_CHANGE_NOTES_LENGTH = 2000;
/** An opaque external reference (project) — `VARCHAR(128)`, a length rule only. */
export const MAX_BOM_CHANGE_REF_LENGTH = 128;
/** A PLATFORM USER ID — never a UUID, never `ParseUUIDPipe`. */
export const MAX_BOM_CHANGE_USER_ID_LENGTH = 64;

/**
 * The CREATE payload.
 *
 * `requestDate` IS ABSENT ON PURPOSE. The source's picker defaulted to today and was not an
 * independent business input, so the column defaults server-side at creation; accepting a
 * caller-stated date would let a request claim it was raised before it existed.
 */
export class CreateBomChangeRequestDto {
  @IsUUID('4')
  bomId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_CHANGE_TITLE_LENGTH)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(MAX_BOM_CHANGE_USER_ID_LENGTH)
  approverUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_CHANGE_NOTES_LENGTH)
  notes?: string;
}

/** The PATCH payload — draft fields only, and only while the request is a DRAFT. */
export class UpdateBomChangeRequestDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_CHANGE_TITLE_LENGTH)
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BOM_CHANGE_USER_ID_LENGTH)
  approverUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_CHANGE_NOTES_LENGTH)
  notes?: string;
}

/** The decision payload, shared by approve / reject / request-correction. */
export class DecideBomChangeRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_CHANGE_NOTES_LENGTH)
  notes?: string;
}

/**
 * One detail row as an ADD states it.
 *
 * `drawingCoefficientDelta` / `spareCoefficientDelta` ARE `@IsInt()` AND NOTHING ELSE — no
 * `@Min`, no `@Max`. That is the phase's explicit decision: the source's own range checks
 * live inside a commented-out block (S7), a decrease is the point of the field, and the
 * domain re-asserts integrality in `bom-change.ts` so a future internal caller cannot skip
 * it. `@IsOptional()` lets a delta be absent; when the type is `QUANTITY_CHANGE` at least
 * one of the two must then be present, and the SERVICE is where that pair rule is decided
 * because it is a fact about BOTH fields at once.
 */
export class AddBomChangeRequestItemDto {
  @IsUUID('4')
  bomItemId!: string;

  @IsIn(BOM_CHANGE_TYPES)
  changeType!: BomChangeType;

  @IsOptional()
  @IsInt()
  drawingCoefficientDelta?: number | null;

  @IsOptional()
  @IsInt()
  spareCoefficientDelta?: number | null;
}

/**
 * The detail PATCH payload.
 *
 * THREE DISTINCT ANSWERS ARE EXPRESSIBLE, and the difference matters:
 *   * the key ABSENT  → leave the stored value alone;
 *   * the key `null`  → CLEAR it (back to "not stated");
 *   * the key a number → set it.
 *
 * `@IsOptional()` makes `null` legal for both deltas, and the SERVICE reads presence with
 * `in` rather than with `!== undefined` so "clear" and "leave" cannot be confused. The pair
 * rule is re-evaluated against the EFFECTIVE values after the merge, so clearing one delta
 * of a `QUANTITY_CHANGE` that has no other delta is refused rather than silently stored.
 */
export class UpdateBomChangeRequestItemDto {
  @IsOptional()
  @IsIn(BOM_CHANGE_TYPES)
  changeType?: BomChangeType;

  @IsOptional()
  @IsInt()
  drawingCoefficientDelta?: number | null;

  @IsOptional()
  @IsInt()
  spareCoefficientDelta?: number | null;
}

/**
 * The register query — the shared pagination envelope of every Production list endpoint.
 *
 * `PRODUCTION_MAX_PAGE_SIZE` is enforced HERE (a 400 for an absurd page size) and again in
 * the service (`Math.min`), the same two-bounds rule `bom.dto.ts` records. Every filter is
 * SERVER-SIDE and whitelisted — `bomId`, `projectRef`, `status`, and a `search` over the
 * title — and none of them is an authorization decision: what a caller may see is
 * `production.bom.read` plus the tenant predicate.
 *
 * THERE IS NO `tenantId` FIELD AND THERE NEVER WILL BE.
 */
export class ListBomChangeRequestsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * The ceiling is enforced HERE as a CONTRACT (an absurd `pageSize` is a 400 naming the
   * field) and again in `resolveBomChangeRequestPageWindow` as a GUARANTEE (an internal
   * caller that builds a query object itself cannot exceed it). Neither replaces the other
   * — the two-bounds rule `bom.dto.ts` records.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCTION_MAX_PAGE_SIZE)
  pageSize?: number;

  @IsOptional()
  @IsUUID('4')
  bomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_CHANGE_REF_LENGTH)
  projectRef?: string;

  @IsOptional()
  @IsIn(BOM_STATUSES)
  status?: BomChangeRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BOM_CHANGE_TITLE_LENGTH)
  search?: string;
}

/** Resolves the effective page window for a register query, clamped to the ceiling. */
export function resolveBomChangeRequestPageWindow(query: ListBomChangeRequestsQueryDto): {
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
 * One change request as the API returns it.
 *
 * Every field is a projection of the row — no derived value, no label, no computed status:
 * the wire states the stored fact, and a screen renders the Persian label
 * (`BOM_MANAGER_OPINION_LABELS` / the change-type labels) if it wants one.
 *
 * THE TOTAL IS NOT HERE. The source derives `original + delta` for DISPLAY only (S8); the
 * row does not hold a total, so neither does this type. A screen that wants the derived
 * figure computes it from the two pairs it was given — which is exactly what the legacy
 * form's `ValueChangeScript` did.
 */
export interface BomChangeRequestView {
  id: string;
  bomId: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string | null;
  status: string;
  managerOpinion: string | null;
  notes: string | null;
  requestDate: string;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One detail row as the API returns it.
 *
 * `partName` is the ONLY projection beyond the stored columns: it comes from the referenced
 * `BomItem` through the FK, never from a copied column, because the part's name is the
 * item's fact and a second copy would be a second thing to keep in sync.
 */
export interface BomChangeRequestItemView {
  id: string;
  changeRequestId: string;
  bomItemId: string;
  partName: string;
  changeType: string;
  originalDrawingCoefficient: number;
  originalSpareCoefficient: number;
  drawingCoefficientDelta: number | null;
  spareCoefficientDelta: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The DETAIL response: the header and ALL of its detail rows in one read.
 *
 * The rows are a full set rather than a page, deliberately — the source's «اقلام انتخاب
 * شده» grid showed every row (`PageSize=0`), the submit gate needs the whole set, and a
 * second endpoint for a list the caller must anyway fetch whole would only add a race
 * between "what the header says" and "what the items say".
 */
export interface BomChangeRequestDetailView extends BomChangeRequestView {
  items: BomChangeRequestItemView[];
}

/** The register envelope — `{ items, page, pageSize, total }`, as every Production list. */
export interface BomChangeRequestPage {
  items: BomChangeRequestView[];
  page: number;
  pageSize: number;
  total: number;
}

