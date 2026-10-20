import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  PURCHASE_MAX_MONEY_AMOUNT,
  PURCHASE_MONEY_SCALE,
} from '../purchase/purchase-money';
import { PURCHASE_LINE_MAX_DECIMAL_PLACES } from '../purchase/purchase.dto';
import {
  MAX_QUOTATION_ATTACHMENT_REF_LENGTH,
  MAX_QUOTATION_DECISION_COMMENT_LENGTH,
  MAX_QUOTATION_LINE_DESCRIPTION_LENGTH,
  MAX_QUOTATION_LINES,
  MAX_QUOTATION_NOTES_LENGTH,
  MAX_QUOTATION_REFERENCE_LENGTH,
  MAX_QUOTATION_SUPPLIER_LABEL_LENGTH,
  QUOTATION_DECISIONS,
  type QuotationDecision,
} from './quotation.constants';

/**
 * PHASE GAP-6: the wire contract of the three price-quotation routes — list,
 * record (create a version) and decide. Nothing else.
 *
 * WHAT IS NOT ON THE WIRE, AND NEVER WILL BE: `tenantId` and any actor id (the
 * session resolves both — the global pipe's `whitelist` + `forbidNonWhitelisted`
 * makes sending one a 400); `status` (the confirmation state is walked by the
 * decision route, never stated); `version` and `lineNumber` (server-derived); and
 * `lineTotal` / a computed `totalAmount` when lines are present (both DERIVED by
 * `purchase-money.ts` — a client-stated total that disagrees with its own lines
 * is the exact fact this slice exists to make consistent).
 *
 * WHY BOTH TOTAL MODES EXIST: the procurement process specification records two
 * entry shapes — the itemised table (count × unit price = line total, summed
 * into the quote total) and the "fast" scan-only entry where the attached
 * document itself is the evidence. So `lines` is optional, and `totalAmount` is
 * accepted ONLY as the recorder's stated invoice total when no lines are given;
 * when lines ARE given the stored total is the derived sum and a stated
 * `totalAmount` is refused at the boundary rather than silently ignored.
 *
 * MONEY IS VALIDATED WITH THE PURCHASE LINE'S OWN RULES: `@IsNumber` at
 * `PURCHASE_MONEY_SCALE` decimals, bounded by what `Decimal(18,4)` can hold,
 * converted with `moneyFromNumber`/`multiplyMoney` before Prisma — one precision
 * model for the whole module.
 */

/** One quoted line as a client states it: what, how many, at which unit price. */
export class CreateQuotationLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUOTATION_LINE_DESCRIPTION_LENGTH)
  description!: string;

  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  quantity!: number;

  @IsNumber({
    maxDecimalPlaces: PURCHASE_MONEY_SCALE,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  unitPrice!: number;
}

/**
 * Record ONE quotation version (`POST commerce/price-quotations`).
 *
 * `quoteDate` is the date ON the seller's document (an ISO date string), not an
 * instant this server stamps — the row records what the evidence says.
 * `attachmentRef` is the uploaded scan's storage reference, not file bytes.
 */
export class CreatePriceQuotationDto {
  @IsUUID('4')
  purchaseDocumentId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUOTATION_SUPPLIER_LABEL_LENGTH)
  supplierLabel?: string;

  /**
   * The SUPPLIER DIRECTORY row this quote was obtained from — optional, and
   * validated by the service against the tenant's own `Supplier` rows before it
   * is stored (an unknown or foreign id is refused; there is no cross-database
   * join and no silent acceptance of an unverifiable reference). `supplierLabel`
   * stays beside it for sellers not (yet) in the directory.
   */
  @IsOptional()
  @IsUUID('4')
  supplierId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUOTATION_REFERENCE_LENGTH)
  quoteReference?: string;

  @IsOptional()
  @IsDateString()
  quoteDate?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /**
   * The recorder's stated invoice total — accepted ONLY when no `lines` are
   * given (the service refuses the combination rather than choosing between
   * two totals).
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUOTATION_ATTACHMENT_REF_LENGTH)
  attachmentRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUOTATION_NOTES_LENGTH)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUOTATION_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateQuotationLineDto)
  lines?: CreateQuotationLineDto[];
}

/**
 * Decide the pending quotation (`POST commerce/price-quotations/:id/decision`).
 *
 * `comment` is OPTIONAL at the boundary and REQUIRED by the service for a
 * RETURNED decision — a service rule rather than a conditional validator,
 * because the condition is the value of another field.
 */
export class QuotationDecisionDto {
  @IsIn(QUOTATION_DECISIONS)
  decision!: QuotationDecision;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUOTATION_DECISION_COMMENT_LENGTH)
  comment?: string;
}

/**
 * The page query for `GET commerce/price-quotations`: one document's whole
 * quotation history, newest version last. `documentId` is REQUIRED — the same
 * document-scoped posture the commercial assignment/approval reads answer with,
 * and for the same reason (a tenant-wide quotation list has no question to
 * answer and no existence probe to refuse).
 */
export class ListQuotationsQueryDto {
  @IsUUID('4')
  documentId!: string;
}
