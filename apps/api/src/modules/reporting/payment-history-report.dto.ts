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
import { PAYMENT_METHODS } from '../commerce/payment/payment-status';
import type { PaymentMethod } from '../commerce/payment/payment-status';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Reporting-side wire contract for
 * «گزارش تاریخچه پرداخت‌های بازرگانی».
 *
 * ONLY the filters the Commerce payment read contract supports — `method` (the closed
 * three-member `PAYMENT_METHODS` set), `search` (the row's own opaque references +
 * the parent `documentNumber`), `purchaseDocumentId` (one document's history, exact
 * UUID), and the HALF-OPEN `[paymentFrom, paymentTo)` ISO-instant window on
 * `paymentDate` (the report's primary date) — plus the repository's own page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 422.
 *  * NO `paymentStatus` filter — the schema stores NO per-row status column; the
 *    four-member vocabulary is a whole-document read-time projection, so a per-row
 *    status query would be a filter against a fact that does not exist.
 *  * NO `currency` / amount range / `recordedByUserId` filters — a snapshot column with
 *    no closed set, no source-backed range vocabulary, and a raw actor id with no
 *    reporting display contract respectively.
 *
 * `@IsIn(PAYMENT_METHODS)` is read from `payment/payment-status.ts`, the vocabulary's
 * ONE authority (the same trick the sibling DTOs use): an unknown member is a refusal at
 * the boundary rather than a filter the database silently matches nothing with. The
 * page ceiling is COMMERCE's (`COMMERCE_MAX_PAGE_SIZE`), because two surfaces over one
 * context must answer «how big may a page be?» identically.
 */
export class ListPaymentHistoryReportQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsUUID('4')
  purchaseDocumentId?: string;

  /** Inclusive lower bound of the half-open `[from, to)` window on `paymentDate`. */
  @IsOptional()
  @IsDateString()
  paymentFrom?: string;

  /** Exclusive upper bound of the same window. Refused if it precedes `paymentFrom`. */
  @IsOptional()
  @IsDateString()
  paymentTo?: string;

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

/** The closed method set this report counts over — re-exported for callers. */
export const REPORTING_PAYMENT_METHODS: readonly string[] = [...PAYMENT_METHODS];
