import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce/commerce.constants';
import { PURCHASE_DOCUMENT_STATUSES } from '../commerce/purchase/purchase-status';
import type { PurchaseDocumentStatus } from '../commerce/purchase/purchase-status';

/**
 * Phase REPORTING-PURCHASE-REPORT: the Reporting-side wire contract for
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید».
 *
 * ONLY the filters the Commerce read contract supports — `status` (the closed lifecycle
 * set, six members) and `search` (the ONE text column a purchase document has:
 * `documentNumber`) — plus the repository's own page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 422.
 *  * NO `requesterId` — `ListPurchaseDocumentsQueryDto` accepts it, but it is a raw actor
 *    id with no reporting display contract, so a screen could not label the filter
 *    honestly. Same reason the Financial report never offered `requesterUserId`.
 *  * NO date/window vocabulary — the Commerce list contract has none, and inventing one
 *    here would be a new filter without a source behind it.
 *
 * `@IsIn(PURCHASE_DOCUMENT_STATUSES)` is read from `purchase-status.ts`, the lifecycle's
 * ONE authority — the same trick `check-request-report.dto.ts` uses with
 * `CHECK_REQUEST_STATUSES`. An unknown member is a 400 at the boundary rather than a
 * filter the database silently matches nothing with.
 *
 * THE PAGE CEILING IS COMMERCE'S, NOT FINANCIAL'S. A Commerce list and a report over
 * Commerce must answer "how big may a page be?" identically (`COMMERCE_MAX_PAGE_SIZE`),
 * because two bounded contexts disagreeing on that makes the answer depend on which
 * route a client happens to call.
 */
export class ListPurchaseReportQueryDto {
  @IsOptional()
  @IsIn(PURCHASE_DOCUMENT_STATUSES)
  status?: PurchaseDocumentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  pageSize?: number;
}

/**
 * The timeline window — page + pageSize only, like every sibling list.
 *
 * Its own class rather than a reuse of `ListPurchaseReportQueryDto`: a timeline has
 * nothing to filter by status or search, and a whitelisted `?status=…` that was accepted
 * and silently ignored is exactly the dishonest parameter this module's DTOs refuse.
 */
export class PurchaseReportTimelineQueryDto {
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

/** The closed lifecycle set this report counts over — re-exported for callers. */
export const REPORTING_PURCHASE_STATUSES: readonly string[] = [...PURCHASE_DOCUMENT_STATUSES];
