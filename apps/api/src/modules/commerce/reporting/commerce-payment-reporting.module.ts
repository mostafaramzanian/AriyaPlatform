import { Module } from '@nestjs/common';
import { CommercePrismaModule } from '../database/commerce-prisma.module';
import { PaymentHistoryRepository } from '../payment/payment-history.repository';
import { CommercePaymentReportingReaderService } from './commerce-payment-reporting.reader';
import { COMMERCE_PAYMENT_REPORTING_READER } from './commerce-payment-reporting.contract';

/**
 * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the Commerce-owned READ MODULE — the narrow
 * composition Reporting imports instead of the whole CommerceModule.
 *
 * WHY A NARROW MODULE RATHER THAN AN EXPORT ON CommerceModule: `CommerceModule` composes
 * the FULL write surface (ten controllers, the workflow executor, the commercial
 * lifecycle, the notification/search projections); Reporting importing it would inherit
 * that whole graph transitively. This module composes ONLY the read seam: the Commerce
 * Prisma handle, the payment repository, and the reader above them. No audit binding
 * (this report has NO timeline — the contract's grain ruling), no write services, no
 * controllers, no entitlement gate: importing this module cannot mount a Commerce route
 * or append a payment, by construction rather than by review — the exact reasoning the
 * purchase and the six sibling narrow reporting modules state.
 *
 * IT EXPORTS THE TOKEN AND NOTHING ELSE. `PaymentHistoryRepository` is provided, not
 * exported, so a consumer of this module reaches Commerce persistence only through the
 * three typed reads the contract declares.
 */
@Module({
  imports: [CommercePrismaModule],
  providers: [
    PaymentHistoryRepository,
    CommercePaymentReportingReaderService,
    {
      provide: COMMERCE_PAYMENT_REPORTING_READER,
      useExisting: CommercePaymentReportingReaderService,
    },
  ],
  exports: [COMMERCE_PAYMENT_REPORTING_READER],
})
export class CommercePaymentReportingModule {}
