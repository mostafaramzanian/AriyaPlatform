import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PURCHASE_MAX_MONEY_AMOUNT, PURCHASE_MONEY_SCALE } from '../purchase/purchase-money';
import type { PaymentMethod } from '../payment/payment-status';
import { PAYMENT_METHODS } from '../payment/payment-status';

/**
 * PAYMENT PLAN: the boundary of the payment-instruction routes.
 *
 * WHAT MAY NEVER APPEAR HERE: `tenantId` (the actor resolves it), `status`
 * fields (the routes name their own transition), `committedAmount` and
 * `currency` (snapshotted from the document), `executedPaymentId` (the server
 * states execution), and a plan or installment `id` the client invents. A
 * payload carrying any of them is a 400 under the global pipe's `whitelist` +
 * `forbidNonWhitelisted`.
 */

/** One stage of a plan — مبلغ، سررسید و روش قسط. `seq` is server-assigned. */
export class PaymentInstallmentInputDto {
  @IsNumber({ maxDecimalPlaces: PURCHASE_MONEY_SCALE })
  @Min(0.0001)
  @Max(PURCHASE_MAX_MONEY_AMOUNT)
  amount!: number;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** `POST …/payment-plans` — a plan is its stage list plus its reason. */
export class CreatePaymentPlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentInstallmentInputDto)
  installments!: PaymentInstallmentInputDto[];
}

/**
 * `POST …/payment-plans/:planId/supersede` — the revision act: a NEW draft
 * that names the approved plan it replaces. Same payload shape as creation;
 * the link is a fact the server states from the path.
 */
export class SupersedePaymentPlanDto extends CreatePaymentPlanDto {}

/** `POST …/payment-plans/:planId/cancel` — body fully optional. */
export class CancelPaymentPlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * `POST …/installments/:seq/execute` — the EVIDENCE of the payment event. The
 * amount and method are never client-stated: they are the installment's own
 * approved facts, mirrored onto the appended `PaymentRecord` by the server.
 */
export class ExecuteInstallmentDto {
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
