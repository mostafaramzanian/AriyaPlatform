import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PURCHASE_MAX_MONEY_AMOUNT } from '../purchase/purchase-money';
import { MAX_PURCHASE_LINES, PURCHASE_LINE_MAX_DECIMAL_PLACES } from '../purchase/purchase.dto';

/**
 * Phase C1 Step R (contract R7, §3-C, §3-E, §6): the wire boundary of the
 * three receiving routes. Every refusal the contract names is one test here.
 *
 * WHAT MAY NEVER APPEAR HERE: `tenantId` (the actor resolves it — §3-F),
 * `actorId` / `receiverId` (the receiver is the acting session's user,
 * server-derived — §16), `reversesReceiptLineId` (the compensation route
 * names its target in the PATH and the server states the link — §3-D; a
 * payload that could point the link at another row, or at itself, is a 400),
 * and any `status` (receiving status is a projection, R5 — there is no
 * status to state). Under the global pipe's `whitelist` +
 * `forbidNonWhitelisted` each is a 400, not a silently ignored field.
 *
 * QUANTITY IS VALIDATED WITH PURCHASELINE'S OWN RULES (contract §4): the
 * same `@IsNumber({ maxDecimalPlaces })` bound the purchase line input uses
 * — one precision model, `Decimal(18,4)`, never a second one — positive
 * (`@Min(0.0001)`: a zero receiving is not a receiving) and at most what the
 * column can hold. A NEGATIVE quantity is deliberately NOT expressible here:
 * it exists only as the server-derived value of a compensating line (§3-D).
 * On the response side the stored decimal is the exact STRING (§6), so the
 * wire carries `Decimal(18,4)` text, never a float.
 *
 * NO `PATCH`, NO `PUT`, NO `DELETE` DTO EXISTS (R7): the only two writes are
 * appending a receipt and appending its compensation, so this file declares
 * exactly the payloads those two POSTs accept — nothing more.
 */

/**
 * One receiving line as a client states it: WHICH purchase line of THIS
 * document arrived, and HOW MUCH of it — strictly positive, at most four
 * decimals, at most the column's maximum.
 *
 * The line NUMBER, the document id and the tenant are deliberately absent:
 * the document is the route, and the purchase line must belong to it (the
 * service refuses a line the document does not own with the same 404 a
 * foreign id gets — no existence probe).
 */
export class ReceiptLineInputDto {
  @IsUUID('4')
  purchaseLineId!: string;

  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  quantity!: number;

  /**
   * Phase W2-B: the destination warehouse the arriving quantity posts into —
   * REQUIRED (by the service, not this DTO) when the purchase line is
   * stock-tracked (`itemReference` set); absent on non-stocked lines. Opaque
   * here; Inventory validates it at posting time.
   */
  @IsOptional()
  @IsUUID('4')
  warehouseId?: string;

  /** The cell inside the warehouse — optional, opaque to Commerce. */
  @IsOptional()
  @IsUUID('4')
  locationId?: string;
}

/**
 * Append one receiving event (`POST …/receipts`, R7).
 *
 * `receivedAt` is optional: the caller's stated instant, else the row default
 * (§2's `receivedAt`, default now). `lines` is REQUIRED and non-empty — a
 * receipt that receives nothing is not a receiving operation — and bounded by
 * the purchase document's own line ceiling, because one operation cannot
 * touch more lines than a document can hold.
 *
 * The same purchase line may appear more than once: two entries are two
 * arrivals inside one operation, and both count toward the over-receipt
 * check exactly as two separate receipts would.
 */
export class CreateReceiptDto {
  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineInputDto)
  lines!: ReceiptLineInputDto[];
}

/**
 * Append the compensating receiving event
 * (`POST …/receipts/:receiptLineId/compensate`, R4/R7).
 *
 * `quantity` is the POSITIVE MAGNITUDE to compensate — required, because
 * unlike Q's full-negation reversal this correction may be PARTIAL (the
 * contract's +100 / −20 example), and the amount is a decision a caller must
 * make explicitly rather than a default this server silently picks. The
 * SERVICE derives the sign (exact negation), the target link and the
 * purchase line from the path and the stored row; the cap — magnitude ≤ what
 * remains compensable — is enforced there against locked history (§3-D),
 * because a DTO cannot know a SUM.
 *
 * `reason` is not a column: it rides the ONE audit event (§3-G), the
 * `CompensatePaymentDto` precedent. `receivedAt` states when the correction
 * was made, defaulting to now.
 */
export class CompensateReceiptLineDto {
  @IsNumber({
    maxDecimalPlaces: PURCHASE_LINE_MAX_DECIMAL_PLACES,
    allowNaN: false,
    allowInfinity: false,
  })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  quantity!: number;

  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
