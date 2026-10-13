import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
} from '../production.constants';
import { BOM_MANAGER_OPINIONS } from './bom-status';
import type { BomManagerOpinion } from './bom-status';

/**
 * Phase PRODUCTION-BOM-HEADER: the wire contract of the BOM Header routes — create, read,
 * list, update-while-editable, submit and the three decision acts.
 *
 * WHY THE COLUMN LENGTHS ARE MIRRORED HERE INSTEAD OF BEING LEFT TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Every maximum below is the width of the column the value lands in (`VARCHAR(200)` for
 * the title, `VARCHAR(128)` for an opaque reference, `VARCHAR(64)` for a platform user
 * id). Without a DTO bound, a long value reaches Postgres and comes back as a driver
 * error — a 500 for what is a client mistake, with no field name attached. With the
 * bound here it is a 400 naming the field, and the database constraint stays what it is:
 * the last line of defence rather than the only one.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE
 * ------------------------------------
 *  * NO `tenantId` — it comes from `resolveProductionActor(req)`. The global pipe's
 *    `whitelist` + `forbidNonWhitelisted` makes sending one a 400 rather than a silently
 *    ignored field, which is the difference between a multi-tenant module and a data
 *    leak.
 *  * NO `status` — the lifecycle is walked by the routes that own each transition
 *    (submit, approve, reject, correct), never by a client writing a status field. A
 *    client that could set `APPROVED` directly could approve its own document.
 *  * NO `managerOpinion` / `decidedAt` / `decidedByUserId` — the DECISION is written by
 *    the decision routes only (M-5b).
 *  * NO `approverUserId` on DECIDE — the approver is the row's SNAPSHOT, never the
 *    caller's claim about who they are (M-5b).
 *  * NO `standardPartCode`, NO `Code_Ghatae`, NO consumption coefficients — those belong
 *    to the BOM ITEM aggregate, which does not exist in this phase.
 *  * NO `projectId` / `productTreeId` as anything but an opaque string: there is no
 *    Project or Product Tree table to validate against (M-1 / RB-1), and a UUID-shaped
 *    validator would reject a legitimate legacy id while proving nothing about tenancy.
 *
 * `status`'s absence is worth restating, because it is the single most important thing
 * this file refuses: a `PATCH` carrying `status: "APPROVED"` is a 400 here, and the
 * approval decision can only be reached through a route guarded by
 * `production.bom.approve`.
 */

/**
 * The wire bound on an EXTERNAL reference (Project, Product Tree).
 *
 * The column is `VARCHAR(128)`; the legacy values are numeric SharePoint list ids, and a
 * real key is comfortably inside this. The bound exists so a typo cannot write a value no
 * future reader can match — it is a length rule, NOT a format rule, because the format of
 * those two identifiers is exactly what has no authoritative contract yet (RB-1-P).
 */
export const MAX_PRODUCTION_EXTERNAL_REF_LENGTH = 128;

/**
 * The wire bound on a PLATFORM USER ID (requester, approver, decider).
 *
 * `@IsString()` + `@MaxLength(64)` + `@MinLength(1)`, and NEVER `ParseUUIDPipe` or
 * `@IsUUID()` — the same rule `commerce/commercial/commercial.dto.ts` and
 * `purchase.dto.ts` state for a platform identity: "UUID v4 remains the format of
 * Commerce-OWNED row ids only; the platform's own seeded administrator is
 * `super-admin-user`, and a DTO that refused it would refuse a real tenant member."
 * Production's OWNED row ids are UUIDs (see `BomHeader.id`); the platform's are opaque.
 *
 * Membership of the id is asserted by the SERVICE against `USER_DIRECTORY`, never here:
 * this layer can only say "this is a bounded non-empty string", and the row that proves
 * it is a member of THIS tenant lives in another database.
 */
export const MAX_PRODUCTION_USER_ID_LENGTH = 64;

/** The title snapshot's column width (M-1: stored, never derived from a Project name). */
export const MAX_PRODUCTION_TITLE_LENGTH = 200;

/** The approver's reason / the requester's note — `VARCHAR(2000)` on the column. */
export const MAX_PRODUCTION_COMMENTS_LENGTH = 2000;

/**
 * One BOM header as the API returns it.
 *
 * Every field is a projection of the row — no derived value, no label, no computed
 * status: the wire states the stored fact, and a screen renders the Persian label
 * (`BOM_MANAGER_OPINION_LABELS`) if it wants one. A response carrying a computed
 * "displayStatus" would be a second source of truth for a fact the row already holds.
 */
export interface BomHeaderView {
  id: string;
  title: string;
  projectRef: string;
  productTreeRef: string;
  requesterUserId: string;
  approverUserId: string | null;
  status: string;
  managerOpinion: string | null;
  comments: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The CREATE payload.
 *
 * `title` is REQUIRED and STORED — never derived from the project, because there is no
 * project contract to derive it from (M-1). A caller that cannot state a title is
 * refused here rather than at the database, and the legacy formula
 * (`'اقلام پروژه - ' + <project name>`) is deliberately NOT reproduced: doing so would
 * require a project-name read contract that does not exist.
 *
 * `projectRef` and `productTreeRef` are REQUIRED because both are part of the BOM's
 * identity in the source, and a BOM that does not say which project and which tree it
 * belongs to cannot be explained later. They are validated for BOUND and PRESENCE only —
 * see this file's header note for why there is no UUID check and no existence check.
 *
 * `requesterUserId` and `approverUserId` are required, and the SERVICE refuses a row
 * whose two are equal (M-5b: self-approval is not permitted).
 */
export class CreateBomHeaderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PRODUCTION_TITLE_LENGTH)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_EXTERNAL_REF_LENGTH)
  projectRef!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_EXTERNAL_REF_LENGTH)
  productTreeRef!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_USER_ID_LENGTH)
  requesterUserId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_USER_ID_LENGTH)
  approverUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PRODUCTION_COMMENTS_LENGTH)
  comments?: string;
}

/**
 * The PATCH payload — header fields only, and only while the row is a DRAFT.
 *
 * EVERY FIELD IS OPTIONAL: a PATCH that stated nothing would otherwise be a no-op that
 * still bumps `updatedAt` and still audits an "update", and a trail in which a
 * mutation with no changes is indistinguishable from one that changed a field is a
 * trail that lies. The service refuses an empty patch with 400.
 *
 * WHY `approverUserId` IS HERE AT ALL. The legacy header form makes the approver field
 * editable while the record is being authored and frozen the moment it is saved
 * (`IsEnabledOnEdit="False"`), and M-5b's snapshot is taken at SUBMIT. So while the row
 * is a DRAFT the approver may still be re-chosen — an explicit, audited edit by a
 * permitted actor — and SUBMIT is the line after which it never changes. No decision
 * route accepts this field, so the freeze is enforced by the ROUTE rather than by a
 * hidden rule.
 */
export class UpdateBomHeaderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PRODUCTION_TITLE_LENGTH)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_EXTERNAL_REF_LENGTH)
  projectRef?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_EXTERNAL_REF_LENGTH)
  productTreeRef?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PRODUCTION_USER_ID_LENGTH)
  approverUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PRODUCTION_COMMENTS_LENGTH)
  comments?: string;
}

/**
 * The DECISION payload for `approve`, `reject` and `request-correction`.
 *
 * THE OUTCOME IS FIXED BY THE ROUTE, NOT BY THE CLIENT. Each route passes its own
 * `expected` opinion to the service, which refuses a body that states a different one —
 * so a client cannot send `opinion: "APPROVED"` to the reject endpoint and obtain an
 * APPROVED row out of a REJECTED act. The endpoint decides the outcome; this DTO only
 * lets the caller confirm which of the three it meant, which is what keeps three
 * handlers from re-typing three literals (one of which would eventually be spelled
 * differently).
 *
 * WHY THE OPINION IS NOT OPTIONAL. The legacy approval task refused to act without one
 * (`نظر مدیر مشخص نشده`), and a decision with no stated outcome is not a decision
 * anybody can later explain.
 */
export class DecideBomHeaderDto {
  @IsIn(BOM_MANAGER_OPINIONS)
  opinion!: BomManagerOpinion;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PRODUCTION_COMMENTS_LENGTH)
  comments?: string;
}

/**
 * The list query — the shared pagination envelope of every Production list endpoint.
 *
 * `PRODUCTION_MAX_PAGE_SIZE` is enforced HERE (a 400 for an absurd page size) and again
 * in the service (`Math.min`, so an internal caller that builds its own query object
 * cannot exceed it either). The DTO bound is the CONTRACT; the service bound is the
 * GUARANTEE — the same two-bounds rule `commerce-query.dto.ts` records.
 *
 * `status` filters the read by lifecycle, because "which BOMs are in this state?" is the
 * one question this phase's two indexes answer (see `prisma/production/schema.prisma`).
 * It is a READ filter and can never be a write: an unknown value is a 400, so the filter
 * cannot express a status the domain does not have.
 *
 * THERE IS NO `tenantId` FIELD AND THERE NEVER WILL BE. The tenant comes from
 * `resolveProductionActor(req)`, so a client cannot widen its own scope by asking for
 * another tenant's page.
 */
export class ListBomHeadersQueryDto {
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

  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'])
  status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
}

/** Resolves the effective page window for a list query, clamped to the ceiling. */
export function resolveProductionPageWindow(query: ListBomHeadersQueryDto): {
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
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the query of `GET /production/boms/:id/timeline`.
 *
 * ONLY `page` AND `pageSize`, EXACTLY LIKE `PurchaseTimelineQueryDto`.
 * ---------------------------------------------------------------
 * The timeline's SCOPE is not a request input and cannot become one: `tenantId` comes
 * from `resolveProductionActor`, `resource` is the closed vocabulary constant
 * `production.bom`, and `resourceId` is the `:id` the route already parsed as a UUID v4
 * and then resolved tenant-scoped. A `?resource=` a caller could set would turn this
 * route into a reader of any resource in the platform trail — which is precisely what
 * the platform's own read contract refuses to be (no free text, no caller-built
 * predicate). A whitelisted `?search=` or `?action=` is likewise refused by the global
 * pipe's `forbidNonWhitelisted` rather than silently ignored.
 *
 * THE CEILING IS ENFORCED TWICE, AND THE TWO ARE NOT REDUNDANT.
 * `@Max(PRODUCTION_MAX_PAGE_SIZE)` makes an out-of-range `pageSize` a 400 that names
 * the field (the CONTRACT); `resolveProductionTimelineWindow` clamps with `Math.min`
 * (the GUARANTEE), so a service called by another service cannot exceed it either. The
 * platform read contract rejects `pageSize > 100` as `AUDIT_READ_PAGE_INVALID` — a
 * third bound that the first two make unreachable, which is the point: the client is
 * told it was wrong rather than the platform being asked and refusing.
 *
 * THERE IS NO `resourceId` FIELD, AND THAT IS THE WHOLE SAFETY OF THIS ROUTE. The id is
 * bound from the path and proven to belong to the acting tenant BEFORE any audit query
 * is built, so no shape of this endpoint reaches another tenant's trail.
 */
export class BomTimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCTION_MAX_PAGE_SIZE)
  pageSize?: number;
}

/**
 * Resolves the timeline's page window against the MODULE's own page-size pair.
 *
 * The audit platform contract ships its own default (20) and ceiling (100), and
 * Production's `PRODUCTION_DEFAULT_PAGE_SIZE` / `PRODUCTION_MAX_PAGE_SIZE` happen to be
 * the same two numbers. They are still resolved HERE rather than being left to the
 * platform's defaults, because "what a Production list page means" is a module decision
 * and must not silently follow a platform constant that a later release could change.
 * The values agree today; the SEAMS stay separate.
 */
export function resolveProductionTimelineWindow(query: BomTimelineQueryDto): {
  page: number;
  pageSize: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    PRODUCTION_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? PRODUCTION_DEFAULT_PAGE_SIZE))
  );
  return { page, pageSize };
}
