import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PRODUCTION_MAX_PAGE_SIZE } from '../production/production.constants';
import { BOM_STATUSES } from '../production/bom/bom-status';
import type { BomStatus } from '../production/bom/bom-status';

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the Reporting-side wire contract for
 * «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)».
 *
 * ONLY the filters the Production change-request read contract proves — `bomId`, the
 * register's `projectRef` scope (see below), `status` (the closed four-member lifecycle
 * set) and `search` (the source's free-text column: its `title`) — plus the
 * repository's own page window.
 *
 * WHY THE TWO LENGTHS ARE LITERALS, NOT IMPORTS. `bom-change.dto.ts` states
 * `MAX_BOM_CHANGE_REF_LENGTH = 128` (the opaque external reference's `VARCHAR(128)`)
 * and `MAX_BOM_CHANGE_TITLE_LENGTH = 200` (the title's `VARCHAR(200)`), and these
 * numbers name THE SAME columns here — but importing them would be an owner-DTO-internals
 * dependency the isolation suite refuses (`reporting-isolation.spec.ts` group C), and
 * rightly: Reporting's wire contract must be readable without opening Production's write
 * DTOs. The literals below are the same widths, each commented with its source, exactly
 * as `production-report.dto.ts` pins `@MaxLength(200)` with a comment rather than a
 * cross-context import. If Production ever widens its columns, this spec-level contract
 * changes in the same review that changes the source — not silently at runtime.
 *
 * `projectRef`: the source column is an opaque EXTERNAL reference copied off the BOM
 * (no foreign key, no prefix rule — `bom-change.dto.ts` calls this out), and the source
 * register MATCHES it exactly (no `contains`, no normalization). Honest reporting keeps
 * that: this filter is an exact string match, so a screen must present it as "exact
 * project reference", never as a search box. `search` is the ONLY fuzzy filter on this
 * surface, and it searches titles only.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 422.
 *  * NO `requesterUserId` / `approverUserId` / `decidedByUserId` — raw actor ids with no
 *    reporting display contract, so a screen could not label the filter honestly (the
 *    same reason the four sibling report DTOs never offered one).
 *  * NO date/window vocabulary — the source list contract has none (`bomId` /
 *    `projectRef` / `status` / `search` only), and inventing one here would be a new
 *    filter without a source behind it. Exactly the absence every sibling report DTO
 *    records.
 *
 * `@IsIn(BOM_STATUSES)` is read from `bom-status.ts`, the lifecycle's ONE authority —
 * the same trick the sibling DTOs use with their closed sets. An unknown member is a
 * 400/422 at the boundary rather than a filter the database silently matches nothing
 * with.
 *
 * `@IsUUID('4')` on `bomId` names the same `Uuid` column the source register filters on:
 * a malformed id is a 400/422 at validation time, not a silent miss at read time.
 *
 * THE PAGE CEILING IS PRODUCTION'S, NOT ANOTHER CONTEXT'S. A Production list and a
 * report over Production must answer "how big may a page be?" identically
 * (`PRODUCTION_MAX_PAGE_SIZE`), because two bounded contexts disagreeing on that makes
 * the answer depend on which route a client happens to call.
 */
export class ListProductionBomChangeReportQueryDto {
  @IsOptional()
  @IsUUID('4')
  bomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128) // source: `MAX_BOM_CHANGE_REF_LENGTH` — the opaque reference's VARCHAR(128)
  projectRef?: string;

  @IsOptional()
  @IsIn(BOM_STATUSES)
  status?: BomStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200) // source: `MAX_BOM_CHANGE_TITLE_LENGTH` — the title's VARCHAR(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCTION_MAX_PAGE_SIZE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCTION_MAX_PAGE_SIZE)
  pageSize?: number;
}

/**
 * The timeline window — page + pageSize only, like every sibling list.
 *
 * Its own class rather than a reuse of `ListProductionBomChangeReportQueryDto`: a
 * timeline has nothing to filter by status, BOM or search, and a whitelisted `?status=…`
 * that was accepted and silently ignored is exactly the dishonest parameter this
 * module's DTOs refuse.
 */
export class ProductionBomChangeReportTimelineQueryDto {
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
