import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce/commerce.constants';
import { RETURN_STATES } from '../commerce/returns/return-lifecycle';
import type { ReturnState } from '../commerce/returns/return-lifecycle';

/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the Reporting-side wire contract for
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی».
 *
 * ONLY the filters the Commerce return read contract supports — `state` (the closed
 * five-member lifecycle set, PROJECTED at read time, never a column), `search` (the
 * return's OWN `reason` free text OR the parent document's number), `purchaseDocumentId`
 * (one document's returns, exact UUID) and the HALF-OPEN `[createdFrom, createdTo)`
 * ISO-instant window on `createdAt` (the report's primary date) — plus the page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 422.
 *  * NO actor/requester filter — raw actor ids have no reporting display contract.
 *  * NO money/refund-amount, supplier, warehouse, item filters — the source proves
 *    none of them answerable on this grain.
 *
 * `@IsIn(RETURN_STATES)` is read from `return-lifecycle.ts`, the lifecycle's ONE
 * authority: an unknown member is a 400 at the boundary rather than a filter the
 * database silently matches nothing with. The page ceiling is COMMERCE's
 * (`COMMERCE_MAX_PAGE_SIZE`), because two surfaces over one context must answer
 * «how big may a page be?» identically.
 */
export class ListReturnLifecycleReportQueryDto {
  @IsOptional()
  @IsIn(RETURN_STATES)
  state?: ReturnState;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsUUID('4')
  purchaseDocumentId?: string;

  /** Inclusive lower bound of the half-open `[from, to)` window on `createdAt`. */
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  /** Exclusive upper bound of the same window. Refused if it precedes `createdFrom`. */
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  pageSize?: number;
}

/**
 * The timeline window — page + pageSize only. Its own class rather than a reuse of
 * `ListReturnLifecycleReportQueryDto`: a timeline has nothing to filter by state or
 * search, and a whitelisted `?state=…` that was accepted and silently ignored is
 * exactly the dishonest parameter this module's DTOs refuse.
 */
export class ReturnLifecycleReportTimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  pageSize?: number;
}

/** The closed state set this report counts over — re-exported for callers. */
export const REPORTING_RETURN_STATES: readonly string[] = [...RETURN_STATES];
