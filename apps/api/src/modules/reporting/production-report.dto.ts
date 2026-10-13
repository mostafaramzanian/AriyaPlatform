import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PRODUCTION_MAX_PAGE_SIZE } from '../production/production.constants';
import { BOM_STATUSES } from '../production/bom/bom-status';
import type { BomStatus } from '../production/bom/bom-status';

/**
 * Phase REPORTING-PRODUCTION-REPORT: the Reporting-side wire contract for
 * «گزارش خلاصه و وضعیت عملیات تولید».
 *
 * ONLY the filters the Production read contract supports — `status` (the closed lifecycle
 * set, four members) and `search` (the ONE text column a BOM header has: its `title`)
 * plus the repository's own page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 422.
 *  * NO `requesterUserId` / `approverUserId` — raw actor ids with no reporting display
 *    contract, so a screen could not label the filter honestly (the same reason the
 *    Financial and Commerce reports never offered one).
 *  * NO date/window vocabulary — the Production list contract has none (`status` +
 *    `search` only), and inventing one here would be a new filter without a source
 *    behind it. Exactly the absence the two sibling report DTOs record.
 *
 * `@IsIn(BOM_STATUSES)` is read from `bom-status.ts`, the lifecycle's ONE authority —
 * the same trick the sibling DTOs use with their closed sets. An unknown member is a
 * 400/422 at the boundary rather than a filter the database silently matches nothing
 * with.
 *
 * THE PAGE CEILING IS PRODUCTION'S, NOT ANOTHER CONTEXT'S. A Production list and a report
 * over Production must answer "how big may a page be?" identically
 * (`PRODUCTION_MAX_PAGE_SIZE`), because two bounded contexts disagreeing on that makes
 * the answer depend on which route a client happens to call.
 */
export class ListProductionReportQueryDto {
  @IsOptional()
  @IsIn(BOM_STATUSES)
  status?: BomStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
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
 * Its own class rather than a reuse of `ListProductionReportQueryDto`: a timeline has
 * nothing to filter by status or search, and a whitelisted `?status=…` that was accepted
 * and silently ignored is exactly the dishonest parameter this module's DTOs refuse.
 */
export class ProductionReportTimelineQueryDto {
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
