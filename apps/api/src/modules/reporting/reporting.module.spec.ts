import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { AI_GATEWAY, type AIGatewayContract } from '../../platform/ai/ai-gateway.contract';
import { PlatformAIModule } from '../../platform/ai/platform-ai.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { PrismaService } from '../../database/prisma.service';
import { NotificationPublisher } from '../../notifications/notification.publisher';
import { CommercePrismaService } from '../commerce/database/commerce-prisma.service';
import { COMMERCE_PURCHASE_REPORTING_READER } from '../commerce/reporting/commerce-purchase-reporting.contract';
import { CommercePurchaseReportingModule } from '../commerce/reporting/commerce-purchase-reporting.module';
import { COMMERCE_PAYMENT_REPORTING_READER } from '../commerce/reporting/commerce-payment-reporting.contract';
import { CommercePaymentReportingModule } from '../commerce/reporting/commerce-payment-reporting.module';
import { COMMERCE_RETURN_LIFECYCLE_REPORTING_READER } from '../commerce/reporting/return-lifecycle-reporting.contract';
import { CommerceReturnLifecycleReportingModule } from '../commerce/reporting/return-lifecycle-reporting.module';
import { COMMERCE_RECEIVING_REPORTING_READER } from '../commerce/reporting/commerce-receiving-reporting.contract';
import { CommerceReceivingReportingModule } from '../commerce/reporting/commerce-receiving-reporting.module';
import { FinancialPrismaService } from '../financial/database/financial-prisma.service';
import { FINANCIAL_CHECK_REQUEST_REPORTING_READER } from '../financial/reporting/financial-check-request-reporting.contract';
import { FinancialCheckRequestReportingModule } from '../financial/reporting/financial-check-request-reporting.module';
import { ProductionPrismaService } from '../production/database/production-prisma.service';
import { PRODUCTION_REPORTING_READER } from '../production/reporting/production-reporting.contract';
import { ProductionReportingModule } from '../production/reporting/production-reporting.module';
import { PRODUCTION_BOM_CHANGE_REPORTING_READER } from '../production/reporting/production-bom-change-reporting.contract';
import { ProductionBomChangeReportingModule } from '../production/reporting/production-bom-change-reporting.module';
import { HrPrismaService } from '../hr/database/hr-prisma.service';
import { HR_PERSONNEL_TRAFFIC_REPORTING_READER } from '../hr/reporting/hr-personnel-traffic-reporting.contract';
import { HrPersonnelTrafficReportingModule } from '../hr/reporting/hr-personnel-traffic-reporting.module';
import { HR_LEAVE_REQUEST_REPORTING_READER } from '../hr/reporting/hr-leave-reporting.contract';
import { HrLeaveRequestReportingModule } from '../hr/reporting/hr-leave-reporting.module';
import { HR_MISSION_REQUEST_REPORTING_READER } from '../hr/reporting/hr-mission-reporting.contract';
import { HrMissionRequestReportingModule } from '../hr/reporting/hr-mission-reporting.module';
import { CheckRequestReportController } from './check-request-report.controller';
import { CheckRequestReportService } from './check-request-report.service';
import { PurchaseReportController } from './purchase-report.controller';
import { PurchaseReportService } from './purchase-report.service';
import { PaymentHistoryReportController } from './payment-history-report.controller';
import { PaymentHistoryReportService } from './payment-history-report.service';
import { ReturnLifecycleReportController } from './return-lifecycle-report.controller';
import { ReturnLifecycleReportService } from './return-lifecycle-report.service';
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
import { ReceivingReportController } from './receiving-report.controller';
import { ReceivingReportService } from './receiving-report.service';
import { ReportingModule } from './reporting.module';

/**
 * Phase REPORTING-AI-CONSUMER + REPORTING-CHECK-REQUEST-REPORT + REPORTING-PURCHASE-REPORT +
 * REPORTING-PRODUCTION-REPORT + REPORTING-HR-PERSONNEL-TRAFFIC:
 * the WIRING of Reporting's seams — its AI consumer token AND its four approved read seams.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM THE ARCHITECTURE GATES
 * ------------------------------------------------------------
 * `src/ai/ai-boundaries.spec.ts` asserts what Reporting SOURCES cannot import.
 * This file asserts the positive half — the claim the module's whole existence
 * rests on: that the `AI_GATEWAY` token really resolves through Reporting's
 * module graph, and that the module really is part of a deployed composition
 * root. Both failures are silent ones (a missing import produces a runtime
 * `Nest could not find` error only when the first Reporting service lands, and
 * an unregistered module produces nothing at all), so they are made executable
 * here, on the way in.
 *
 * WHAT IS ASSERTED, AND WHY EACH IS NOT OBVIOUS
 * ---------------------------------------------
 *  1. THE TOKEN RESOLVES THROUGH THE REAL PLATFORM GRAPH — `ReportingModule` →
 *     `PlatformAIModule` → `AIModule` → the resolver, with only the two
 *     socket-opening leaves stubbed (see below). This is the same technique
 *     `platform-identity.module.spec.ts` established: a wiring test must not
 *     open a Postgres or RabbitMQ connection, but everything between the stub
 *     and the token resolves for real.
 *  2. THE SEAM IS LOAD-BEARING — outside Reporting's graph, the token is not
 *     ambient. The negative control is what proves the positive result came
 *     from this module's import rather than from the test container.
 *  3. THE SURFACE ENDS AT THE TOKEN — `PlatformAIModule` is composed in, and
 *     `AI_GATEWAY` is NOT re-exported: a consumer that imports Reporting cannot
 *     reach the AI platform through it.
 *  4. THE MODULE IS REGISTERED in the combined composition root, read as
 *     source, because "it boots with Reporting" is exactly the claim that
 *     silently rots when `app.module.ts` is edited.
 *
 * Note on the two stubs: `PrismaService` would connect to Postgres, and
 * `NotificationPublisher` opens a RabbitMQ connection in its CONSTRUCTOR; both
 * arrive transitively through `PlatformAIModule` → `AIModule` → `RbacModule` →
 * `NotificationModule` and are pre-existing platform behaviour, not anything
 * Reporting introduced. Stubbing them is a test concern, which is why the
 * boundary gates audit reporting sources (not spec files) for forbidden
 * imports.
 */

const SRC = path.resolve(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

describe('ReportingModule wiring (AI seam + four report surfaces)', () => {
  const prismaStub = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const financePrismaStub = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    checkRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  /**
   * The Commerce half of the same stub-and-override: the narrow Commerce read module
   * brings `CommercePrismaService` into the graph exactly as the Financial one brings
   * `FinancialPrismaService`, and the wiring test must not open a second database to
   * prove that the token resolves. Every method the READER reaches is present, so a
   * missing method would fail loudly rather than silently resolving to `undefined`.
   */
  const commercePrismaStub = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn().mockResolvedValue([[], 0]),
    purchaseDocument: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Phase REPORTING-COMMERCE-PAYMENT-HISTORY: the SECOND Commerce read seam reaches
    // `paymentRecord` (paged list + count in the array-form `$transaction`, bounded
    // `groupBy` for the method summary, tenant-scoped `findFirst` for detail) — the same
    // four shapes the other delegates above carry, so a missing method fails loudly.
    paymentRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Phase REPORTING-COMMERCE-RECEIVING-STATUS: the FOURTH Commerce read seam reaches
    // `purchaseLine` (the candidate-line set with its document number) and `receiptLine`
    // (the events scoped to exactly those lines) — the aggregated facts read, so a
    // missing delegate would fail loudly rather than resolving to `undefined`.
    purchaseLine: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    receiptLine: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  /**
   * The Production half of the same stub-and-override: the narrow Production read module
   * brings `ProductionPrismaService` into the graph, and the wiring test must not open a
   * third database to prove the token resolves. The stub carries exactly the delegates
   * the Production reader reaches — `bomHeader` (paged list, count, bounded groupBy and
   * the tenant-scoped `findFirst`) — so the real graph above it resolves while no socket
   * opens.
   */
  const productionPrismaStub = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    bomHeader: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  /**
   * The HR half of the same stub-and-override: the narrow HR read module brings
   * `HrPrismaService` into the graph, and the wiring test must not open a fourth
   * database to prove the token resolves. The stub carries exactly the delegates the
   * HR reader reaches — `attendance` (the paged register read, its total, a bounded
   * `groupBy` for the summary and the tenant-scoped `findFirst` for detail and the
   * timeline existence check) — so the real graph above it resolves while no socket
   * opens.
   */
  const hrPrismaStub = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn().mockResolvedValue([[], 0]),
    attendance: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    leaveRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    missionRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const publisherStub = { publish: jest.fn().mockResolvedValue(undefined) };

  const build = () =>
    Test.createTestingModule({ imports: [ReportingModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(FinancialPrismaService)
      .useValue(financePrismaStub)
      .overrideProvider(CommercePrismaService)
      .useValue(commercePrismaStub)
      .overrideProvider(ProductionPrismaService)
      .useValue(productionPrismaStub)
      .overrideProvider(HrPrismaService)
      .useValue(hrPrismaStub)
      .overrideProvider(NotificationPublisher)
      .useValue(publisherStub)
      .compile();

  it('resolves the AI_GATEWAY token through the REAL platform module graph', async () => {
    const moduleRef = await build();

    const gateway = moduleRef.get<AIGatewayContract>(AI_GATEWAY, { strict: false });

    // The contract's one capability — the token must hand back the gateway,
    // not a placeholder, and the contract must be satisfied at runtime.
    expect(typeof gateway.embed).toBe('function');

    await moduleRef.close();
  });

  it('is load-bearing: without Reporting in the graph the token is not ambient', async () => {
    // The negative control for the test above. An empty container cannot resolve
    // the token, so the resolution asserted there is Reporting's import doing the
    // work — not the testing module silently making the token global.
    const bare = await Test.createTestingModule({}).compile();

    expect(() => bare.get(AI_GATEWAY, { strict: false })).toThrow();

    await bare.close();
  });

  it('composes the platform seam and all ten read seams, and re-exports no AI surface', () => {
    const imports = Reflect.getMetadata('imports', ReportingModule) as unknown[] | undefined;
    const exported = Reflect.getMetadata('exports', ReportingModule) as unknown[] | undefined;

    expect(imports).toContain(PlatformAIModule);
    expect(imports).toContain(PlatformEntitlementModule);
    expect(imports).toContain(FinancialCheckRequestReportingModule);
    expect(imports).toContain(CommercePurchaseReportingModule);
    expect(imports).toContain(CommercePaymentReportingModule);
    expect(imports).toContain(CommerceReturnLifecycleReportingModule);
    expect(imports).toContain(CommerceReceivingReportingModule);
    expect(imports).toContain(ProductionReportingModule);
    expect(imports).toContain(ProductionBomChangeReportingModule);
    expect(imports).toContain(HrPersonnelTrafficReportingModule);
    expect(imports).toContain(HrLeaveRequestReportingModule);
    expect(imports).toContain(HrMissionRequestReportingModule);
    // The token stays at the platform seam: it is not ours to spread. A module
    // that imported Reporting must not inherit an AI surface through it.
    expect(exported ?? []).not.toContain(AI_GATEWAY);
    // Nor any READ seam: Reporting consumes them, it does not re-export the
    // right to read a source context's tables.
    expect(exported ?? []).not.toContain(FINANCIAL_CHECK_REQUEST_REPORTING_READER);
    expect(exported ?? []).not.toContain(COMMERCE_PURCHASE_REPORTING_READER);
    expect(exported ?? []).not.toContain(COMMERCE_PAYMENT_REPORTING_READER);
    expect(exported ?? []).not.toContain(COMMERCE_RETURN_LIFECYCLE_REPORTING_READER);
    expect(exported ?? []).not.toContain(COMMERCE_RECEIVING_REPORTING_READER);
    expect(exported ?? []).not.toContain(PRODUCTION_REPORTING_READER);
    expect(exported ?? []).not.toContain(PRODUCTION_BOM_CHANGE_REPORTING_READER);
    expect(exported ?? []).not.toContain(HR_PERSONNEL_TRAFFIC_REPORTING_READER);
    expect(exported ?? []).not.toContain(HR_LEAVE_REQUEST_REPORTING_READER);
    expect(exported ?? []).not.toContain(HR_MISSION_REQUEST_REPORTING_READER);
  });

  it('mounts all ten report controllers over their approved read seams', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(CheckRequestReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(CheckRequestReportService, { strict: false })).toBeDefined();
    // The Financial READ token resolves through the Financial-owned narrow module —
    // the seam the isolation suite pins — never a repository, service or client.
    expect(
      moduleRef.get(FINANCIAL_CHECK_REQUEST_REPORTING_READER, { strict: false })
    ).toBeDefined();

    expect(moduleRef.get(PurchaseReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(PurchaseReportService, { strict: false })).toBeDefined();
    // The Commerce READ token resolves through the Commerce-owned narrow module —
    // the same shape, and for the same reason: ownership of the source fixes the
    // direction of the dependency.
    expect(moduleRef.get(COMMERCE_PURCHASE_REPORTING_READER, { strict: false })).toBeDefined();

    expect(moduleRef.get(ProductionReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(ProductionReportService, { strict: false })).toBeDefined();
    // The Production READ token resolves through the Production-owned narrow module —
    // the seam the isolation suite pins — never a repository, service or client. The
    // Production half is asserted LAST so the two existing halves read exactly as the
    // previous phase left them; only the new surface grows.
    expect(moduleRef.get(PRODUCTION_REPORTING_READER, { strict: false })).toBeDefined();

    expect(moduleRef.get(ProductionBomChangeReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(ProductionBomChangeReportService, { strict: false })).toBeDefined();
    // The change-request READ token resolves through the second Production-owned narrow
    // module — a second aggregate's token beside the header one, never a widening of it.
    expect(moduleRef.get(PRODUCTION_BOM_CHANGE_REPORTING_READER, { strict: false })).toBeDefined();

    expect(moduleRef.get(HrPersonnelTrafficReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(HrPersonnelTrafficReportService, { strict: false })).toBeDefined();
    // The HR READ token resolves through the HR-owned narrow module — the same shape
    // for the same reason: the register, its summary and its audit trail, and never a
    // punch surface, a repository or a client.
    expect(moduleRef.get(HR_PERSONNEL_TRAFFIC_REPORTING_READER, { strict: false })).toBeDefined();

    // The sixth surface: «گزارش وضعیت درخواست‌های مرخصی» over the SECOND HR-owned narrow
    // module — a second aggregate's token beside the attendance one, never a widening of
    // it (the same rule the second Production seam states for Production).
    expect(moduleRef.get(HrLeaveReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(HrLeaveReportService, { strict: false })).toBeDefined();
    expect(moduleRef.get(HR_LEAVE_REQUEST_REPORTING_READER, { strict: false })).toBeDefined();

    // The seventh surface: «گزارش وضعیت درخواست‌های مأموریت» over the THIRD HR-owned
    // narrow module — the mission-request aggregate's own token, never a widening of
    // either predecessor.
    expect(moduleRef.get(HrMissionReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(HrMissionReportService, { strict: false })).toBeDefined();
    expect(moduleRef.get(HR_MISSION_REQUEST_REPORTING_READER, { strict: false })).toBeDefined();

    // The eighth surface: «گزارش تاریخچه پرداخت‌های بازرگانی» over the SECOND Commerce-owned
    // narrow module — the payment aggregate's own token beside the purchase one, never a
    // widening of it (the same rule the second HR and second Production seams state).
    expect(moduleRef.get(PaymentHistoryReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(PaymentHistoryReportService, { strict: false })).toBeDefined();
    expect(moduleRef.get(COMMERCE_PAYMENT_REPORTING_READER, { strict: false })).toBeDefined();

    // The ninth surface: «گزارش چرخه حیات مرجوعی‌های بازرگانی» over the THIRD Commerce-owned
    // narrow module — the return aggregate's own token beside the purchase and payment
    // ones, never a widening of either (the same rule the second Commerce seam states
    // for the second reported aggregate).
    expect(moduleRef.get(ReturnLifecycleReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(ReturnLifecycleReportService, { strict: false })).toBeDefined();
    expect(
      moduleRef.get(COMMERCE_RETURN_LIFECYCLE_REPORTING_READER, { strict: false })
    ).toBeDefined();

    // The tenth surface: «گزارش وضعیت دریافت‌های بازرگانی» over the FOURTH Commerce-owned
    // narrow module — the receiving aggregate's own per-line token beside the purchase,
    // payment and return ones, never a widening of any of them.
    expect(moduleRef.get(ReceivingReportController, { strict: false })).toBeDefined();
    expect(moduleRef.get(ReceivingReportService, { strict: false })).toBeDefined();
    expect(moduleRef.get(COMMERCE_RECEIVING_REPORTING_READER, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it('is registered in the combined composition root', () => {
    // Read as source: this is a statement about app.module.ts, not about this
    // module, and a registration that disappears there must fail here.
    const appModule = read(path.join(SRC, 'app.module.ts'));

    expect(appModule).toContain(
      "import { ReportingModule } from './modules/reporting/reporting.module';"
    );
    expect(appModule).toMatch(/^ {4}ReportingModule,$/m);
  });
});
