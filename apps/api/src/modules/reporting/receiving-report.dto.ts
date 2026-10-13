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
import { RECEIVING_STATUSES } from '../commerce/receiving/receiving-status';
import type { ReceivingStatus } from '../commerce/receiving/receiving-status';

/**
 * Phase REPORTING-COMMERCE-RECEIVING-STATUS: the Reporting-side wire contract for
 * «گزارش وضعیت دریافت‌های بازرگانی».
 *
 * ONLY the filters the Commerce receiving read contract supports — `status` (the
 * closed three-member `RECEIVING_STATUSES` set, a COMPUTED projection narrowing,
 * never a stored column), `purchaseDocumentId` and `purchaseLineId` (exact UUIDs),
 * `search` (the parent `documentNumber` only — receipt lines carry no searchable
 * text of their own), and the HALF-OPEN `[receivedFrom, receivedTo)` ISO-instant
 * window on the line's LATEST receiving instant — plus the repository's own page
 * window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and
 *    the global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one
 *    into a 422.
 *  * NO `supplierId` / `warehouseId` / `unit` / quantity range — the schema
 *    stores no warehouse, an opaque supplier ref is no display contract, `unit`
 *    is free text with no closed set, and no source-backed range vocabulary
 *    exists.
 *  * NO `receiverId` — a raw actor id with no reporting display contract (the
 *    payment register's `recordedByUserId` omission).
 *  * NO document-level status filter — there is no document-level status to
 *    filter by (R5: the schema carries none anywhere).
 *
 * `@IsIn(RECEIVING_STATUSES)` reads the vocabulary from
 * `receiving/receiving-status.ts`, the ONE authority (the sibling DTOs' own
 * trick): an unknown member is a refusal at the boundary rather than a filter
 * the pipeline silently matches nothing with. The page ceiling is COMMERCE's,
 * because two surfaces over one context answer «how big may a page be?»
 * identically.
 */
export class ListReceivingReportQueryDto {
  @IsOptional()
  @IsIn(RECEIVING_STATUSES)
  status?: ReceivingStatus;

  @IsOptional()
  @IsUUID('4')
  purchaseDocumentId?: string;

  @IsOptional()
  @IsUUID('4')
  purchaseLineId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Inclusive lower bound of the half-open `[from, to)` window on the latest `receivedAt`. */
  @IsOptional()
  @IsDateString()
  receivedFrom?: string;

  /** Exclusive upper bound of the same window. Refused if it precedes `receivedFrom`. */
  @IsOptional()
  @IsDateString()
  receivedTo?: string;

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

/** The closed status set this report counts over — re-exported for callers. */
export const REPORTING_RECEIVING_STATUSES: readonly string[] = [...RECEIVING_STATUSES];
