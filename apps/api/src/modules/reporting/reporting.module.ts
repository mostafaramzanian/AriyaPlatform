import { Module } from '@nestjs/common';
import { PlatformAIModule } from '../../platform/ai/platform-ai.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { CommercePurchaseReportingModule } from '../commerce/reporting/commerce-purchase-reporting.module';
import { CommercePaymentReportingModule } from '../commerce/reporting/commerce-payment-reporting.module';
import { CommerceReturnLifecycleReportingModule } from '../commerce/reporting/return-lifecycle-reporting.module';
import { CommerceReceivingReportingModule } from '../commerce/reporting/commerce-receiving-reporting.module';
import { FinancialCheckRequestReportingModule } from '../financial/reporting/financial-check-request-reporting.module';
import { ProductionReportingModule } from '../production/reporting/production-reporting.module';
import { ProductionBomChangeReportingModule } from '../production/reporting/production-bom-change-reporting.module';
import { HrPersonnelTrafficReportingModule } from '../hr/reporting/hr-personnel-traffic-reporting.module';
import { HrLeaveRequestReportingModule } from '../hr/reporting/hr-leave-reporting.module';
import { HrMissionRequestReportingModule } from '../hr/reporting/hr-mission-reporting.module';
import { CheckRequestReportController } from './check-request-report.controller';
import { CheckRequestReportService } from './check-request-report.service';
import { PurchaseReportController } from './purchase-report.controller';
import { PurchaseReportService } from './purchase-report.service';
import { PaymentHistoryReportController } from './payment-history-report.controller';
import { PaymentHistoryReportService } from './payment-history-report.service';
import { ReturnLifecycleReportController } from './return-lifecycle-report.controller';
import { ReturnLifecycleReportService } from './return-lifecycle-report.service';
import { ReceivingReportController } from './receiving-report.controller';
import { ReceivingReportService } from './receiving-report.service';
import { ProductionReportController } from './production-report.controller';
import { ProductionReportService } from './production-report.service';
import { ProductionBomChangeReportController } from './production-bom-change-report.controller';
import { ProductionBomChangeReportService } from './production-bom-change-report.service';
import { HrPersonnelTrafficReportController } from './hr-personnel-traffic-report.controller';
import { HrPersonnelTrafficReportService } from './hr-personnel-traffic-report.service';
import { HrLeaveReportController } from './hr-leave-report.controller';
import { HrLeaveReportService } from './hr-leave-report.service';
import { HrMissionReportController } from './hr-mission-report.controller';
import { HrMissionReportService } from './hr-mission-report.service';

/**
 * Phase REPORTING-CONTEXT + REPORTING-CHECK-REQUEST-REPORT + REPORTING-PURCHASE-REPORT +
 * REPORTING-PRODUCTION-REPORT + REPORTING-HR-PERSONNEL-TRAFFIC +
 * REPORTING-PRODUCTION-BOM-CHANGE-REPORT + REPORTING-HR-LEAVE-REQUEST +
 * REPORTING-HR-MISSION-REQUEST + REPORTING-COMMERCE-PAYMENT-HISTORY +
 * REPORTING-COMMERCE-RETURN-LIFECYCLE + REPORTING-COMMERCE-RECEIVING-STATUS: the Reporting
 * BOUNDED CONTEXT's composition root — now carrying TEN real capabilities: «گزارش وضعیت و گردش درخواست‌های صدور چک»،
 * «گزارش وضعیت و چرخه عمر درخواست‌های خرید»، «گزارش خلاصه و وضعیت عملیات تولید»،
 * «گزارش تردد پرسنل»، «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)»،
 * «گزارش وضعیت درخواست‌های مرخصی»، «گزارش وضعیت درخواست‌های مأموریت»، «گزارش تاریخچه پرداخت‌های بازرگانی»،
 * «گزارش چرخه حیات مرجوعی‌های بازرگانی» and «گزارش وضعیت دریافت‌های بازرگانی».
 *
 * WHAT THIS CONTEXT OWNS (the whole list)
 * ---------------------------------------
 * Its composition root, the AI consumer seam (`PlatformAIModule` -> `AI_GATEWAY`,
 * embed-only — unchanged), and the TEN report surfaces the contracts establish:
 * `CheckRequestReportController` + `CheckRequestReportService` over the APPROVED
 * Financial read seam, `PurchaseReportController` + `PurchaseReportService` over the
 * APPROVED Commerce read seam, `ProductionReportController` + `ProductionReportService`
 * over the APPROVED Production read seam, `HrPersonnelTrafficReportController` +
 * `HrPersonnelTrafficReportService` over the APPROVED HR attendance read seam,
 * `ProductionBomChangeReportController` + `ProductionBomChangeReportService` over the
 * APPROVED second Production read seam (the change-request aggregate, never the header
 * token widened), and `HrLeaveReportController` + `HrLeaveReportService` over the
 * APPROVED second HR read seam (the leave-request aggregate, never the attendance
 * token widened), `HrMissionReportController` + `HrMissionReportService` over the
 * APPROVED third HR read seam (the mission aggregate's own token), and
 * `PaymentHistoryReportController` + `PaymentHistoryReportService` over the APPROVED
 * second Commerce read seam (the payment aggregate's own token — never the purchase
 * token widened), and `ReturnLifecycleReportController` +
 * `ReturnLifecycleReportService` over the APPROVED third Commerce read seam (the
 * return aggregate's own token — never the purchase or payment tokens widened),
 * and `ReceivingReportController` + `ReceivingReportService` over the APPROVED
 * fourth Commerce read seam (the receiving aggregate's own per-line token — none
 * of the three earlier Commerce tokens widened).
 *
 * THE READ SEAMS — the only cross-context dependencies, each stated exactly once.
 * Reporting READS source truth through the SOURCE-OWNED narrow modules: contract +
 * reader + the two providers they need (repository, audit gateway). Reporting never
 * imports a Financial, Commerce, Production or HR repository, service, controller, Prisma
 * client, generated client or DTO internals — the isolation suite fails the build on any
 * of them. The source contexts never import Reporting: the direction is one-way by
 * construction, ten times — one narrow module per reported aggregate.
 *
 * WHY PER-AGGREGATE SEAMS AND NOT A GENERAL ONE. Each narrow module is owned by the context
 * whose tables it reads, because ownership of the source is what fixes the direction of
 * the dependency. A single "Reporting reader" reaching four databases would be Reporting
 * owning reads whose truth it does not own — the exact thing the first phase refused.
 * (Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: the second Production seam is a second
 * AGGREGATE's token, not a second OWNER — the same rule, applied where one owner holds
 * two reported aggregates. Phase REPORTING-HR-LEAVE-REQUEST: the second HR seam is the
 * same rule for HR's second reported aggregate.)
 *
 * It owns NO datasource (`prisma/reporting` does not exist and no
 * `REPORTING_DATABASE_URL` is declared), NO client, NO write surface, NO `reporting.*`
 * permission (each report answers to its SOURCE's existing read remit —
 * `financial.check.read`, `commerce.read`, `production.bom.read`, `hr.attendance.read`
 * and `hr.leave.read`; the change-request report answers to `production.bom.read` too,
 * because it reads the SAME aggregate family the three Production strings already
 * govern),
 * NO export/scheduling/AI vocabulary.
 */
@Module({
  imports: [
    PlatformAIModule,
    PlatformEntitlementModule,
    FinancialCheckRequestReportingModule,
    CommercePurchaseReportingModule,
    CommercePaymentReportingModule,
    CommerceReturnLifecycleReportingModule,
    CommerceReceivingReportingModule,
    ProductionReportingModule,
    ProductionBomChangeReportingModule,
    HrPersonnelTrafficReportingModule,
    HrLeaveRequestReportingModule,
    HrMissionRequestReportingModule,
  ],
  controllers: [
    CheckRequestReportController,
    PurchaseReportController,
    PaymentHistoryReportController,
    ReturnLifecycleReportController,
    ReceivingReportController,
    ProductionReportController,
    ProductionBomChangeReportController,
    HrPersonnelTrafficReportController,
    HrLeaveReportController,
    HrMissionReportController,
  ],
  providers: [
    ModuleEntitlementGuard,
    CheckRequestReportService,
    PurchaseReportService,
    PaymentHistoryReportService,
    ReturnLifecycleReportService,
    ReceivingReportService,
    ProductionReportService,
    ProductionBomChangeReportService,
    HrPersonnelTrafficReportService,
    HrLeaveReportService,
    HrMissionReportService,
  ],
})
export class ReportingModule {}
