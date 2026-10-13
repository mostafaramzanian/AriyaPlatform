import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  FINANCIAL_DEFAULT_PAGE_SIZE,
  FINANCIAL_MAX_PAGE_SIZE,
} from '../financial/financial.constants';
import { CHECK_REQUEST_STATUSES } from '../financial/check-request/check-request-status';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Reporting-side wire contract for
 * «گزارش وضعیت و گردش درخواست‌های صدور چک».
 *
 * ONLY the filters Financial already supports — `status` (the closed
 * lifecycle set) and `search` (title match) — plus the repository's own page
 * window. No date/window vocabulary: the source list contract has none, and
 * inventing one here would be a new filter without a source behind it. No
 * `tenantId`: the scope comes from the authenticated request context.
 */
export class ListCheckRequestReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(CHECK_REQUEST_STATUSES as unknown as number[])
  status?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCIAL_MAX_PAGE_SIZE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCIAL_MAX_PAGE_SIZE)
  pageSize?: number;
}

/** The timeline window — page + pageSize only, like every sibling list. */
export class CheckRequestReportTimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCIAL_MAX_PAGE_SIZE)
  pageSize?: number;
}

export const REPORTING_CHECK_REQUEST_STATUSES: readonly number[] = [...CHECK_REQUEST_STATUSES];

export { FINANCIAL_DEFAULT_PAGE_SIZE, FINANCIAL_MAX_PAGE_SIZE };
