import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { PURCHASE_MAX_MONEY_AMOUNT, PURCHASE_MONEY_SCALE } from '../purchase/purchase-money';
import type { PaymentMethod } from './payment-status';
import { PAYMENT_METHODS } from './payment-status';

/**
 * Phase C1 Step Q (contract §6, §3-C, §7): the boundary of the three payment routes.
 *
 * WHAT MAY NEVER APPEAR HERE: `tenantId` (the actor resolves it — §3-F), `currency`
 * (snapshotted from the document, never taken from a payload — §7's service test), and
 * `reversesPaymentId` (the compensation route names its target in the PATH; the link is
 * a fact the server states, never one a client may point at another row). A payload
 * carrying any of the three is a 400 under the global pipe's `whitelist` +
 * `forbidNonWhitelisted`, not a silently ignored field.
 *
 * THE AMOUNT IS VALIDATED AS A NUMBER AND CONVERTED BEFORE PRISMA (§3-C): `@IsNumber`
 * with `maxDecimalPlaces: PURCHASE_MONEY_SCALE` refuses a fifth decimal at the edge,
 * `@Max(PURCHASE_MAX_MONEY_AMOUNT)` refuses what the `Decimal(18,4)` column cannot
 * hold, `@Min` refuses zero and negatives (a payment of nothing is not a payment), and
 * `moneyFromNumber` — never a float op — turns it into the exact string the repository
 * stores. A driver error is never a business answer (§3-E).
 *
 * NO `PATCH`, NO `PUT`, NO `DELETE` DTO EXISTS (§6): the only two writes are appending
 * a payment and appending its compensation, so this file declares exactly the payloads
 * those two POSTs and the one GET accept — nothing more.
 */

/**
 * Append one payment event (`POST …/payments`, §6).
 *
 * `paymentDate` is optional: the caller's stated instant, else the row default
 * (§3-D). The four references are each opaque `VARCHAR(128)` strings — there is no
 * supplier, bank or invoice table behind them to validate against (§13), and
 * `@MaxLength(128)` is what keeps a client from writing an essay where a reference
 * belongs.
 */
export class CreatePaymentDto {
  @IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  amount!: number;

  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethod;

  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  payerRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  payeeRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  invoiceRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalReference?: string;
}

/**
 * Append the compensating row (`POST …/payments/:paymentId/compensate`, §6).
 *
 * EVERY FIELD IS OPTIONAL BY DESIGN — including the body itself. The reversal's
 * `amount` is by default the exact negation of the target, its `method` and
 * `currency` are mirrored from the target, and `reversesPaymentId` comes from
 * the path (§3-D), so an empty POST is a complete request.
 *
 * PHASE W4 (partial compensation): a caller MAY state an `amount` strictly
 * smaller than the target's — the written row then negates THAT figure, which
 * is the honest persisted representation of a partial refund. A stated amount
 * larger than the target is refused by the service (409): over-refunding a
 * payment is not a compensation, it is a ledger error. `method` and `currency`
 * still mirror the target — a refund happens in the money that was paid.
 * What the caller MAY also state is its own evidence: when the correction was
 * made, its own external reference, and a `reason` — which is not a column but
 * the platform audit event's `reason` field (one trail, §3-G).
 */
export class CompensatePaymentDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  amount?: number;

  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * The page query for `GET …/payments` (contract Q9, §6).
 *
 * The two optional filters narrow only the PAGE: `method` selects a method, `search`
 * (inherited from the shared envelope) matches the row's own references. The
 * `paymentStatus` block returned beside the page is computed over ALL of the
 * document's rows, unfiltered — a filtered page reporting a filtered total would be a
 * status that changes when a user types into a search box, and the projection is a
 * fact about the document, not about the view (Q9).
 */
export class ListPaymentsQueryDto extends CommercePageQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  method?: PaymentMethod;
}
