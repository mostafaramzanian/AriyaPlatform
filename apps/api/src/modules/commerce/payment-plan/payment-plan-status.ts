/**
 * PAYMENT PLAN (دستور پرداخت / رژیم پرداخت): the closed vocabularies of the
 * payment-instruction slice, mirrored from the schema enums so a new member
 * arrives as an additive migration plus one line here — never as a typo in a
 * `where` clause or a DTO.
 *
 * THE TWO STATUS AXES, AND WHY THEY ARE SEPARATE
 * ---------------------------------------------
 * `PaymentPlanStatus` is the plan's lifecycle: DRAFT -> SUBMITTED -> APPROVED,
 * with SUPERSEDED and CANCELLED as the two terminal exits. An installment's
 * `status` is only its DECISION state (PENDING / APPROVED / CANCELLED); whether
 * it was EXECUTED is a fact the server states through `executedPaymentId`,
 * never an enum member a transition could reach. The requirements' three
 * questions — is the plan approved, was this stage approved, was this stage
 * actually paid — stay three independent facts.
 */
export const PAYMENT_PLAN_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUSES)[number];

export const PAYMENT_INSTALLMENT_STATUSES = ['PENDING', 'APPROVED', 'CANCELLED'] as const;
export type PaymentInstallmentStatus = (typeof PAYMENT_INSTALLMENT_STATUSES)[number];

/**
 * The statuses a plan may still be cancelled from — an executed installment
 * makes cancellation impossible regardless (the service checks that fact
 * separately), so this list is the status gate, nothing more.
 */
export const PAYMENT_PLAN_CANCELLABLE: readonly PaymentPlanStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
];
