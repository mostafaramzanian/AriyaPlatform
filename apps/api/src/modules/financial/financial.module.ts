import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../platform/audit/platform-audit.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { UserDirectoryModule } from '../../platform/user-directory/user-directory.module';
import { StorageModule } from '../../storage/storage.module';
import { FinancialAuditGateway } from './financial-audit.gateway';
import { AuditOutboxRelayService } from './audit-outbox-relay.service';
import { FinancialPrismaModule } from './database/financial-prisma.module';
import { CheckRequestController } from './check-request/check-request.controller';
import { CheckProcessController } from './check-request/check-process.controller';
import { CheckRequestRepository } from './check-request/check-request.repository';
import { CheckRequestService } from './check-request/check-request.service';
import { CheckAttachmentRepository } from './check-request/check-attachment.repository';
import { CheckAttachmentService } from './check-request/check-attachment.service';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial bounded context's composition root.
 *
 * REGISTERED IN `AppModule` AND DELIBERATELY NOT IN `CoreAppModule`, exactly like
 * Correspondence, HR, Commerce and Production: the Core-only deployable boots with zero
 * Financial knowledge and reaches none of Financial's tables.
 *
 * WHAT IT IMPORTS, AND WHY EACH ONE
 * ---------------------------------
 *   FinancialPrismaModule — this module's OWN database. It binds `FINANCE_PRISMA_CLIENT`,
 *     which is what makes `finance_db` reachable and what the combined health graph
 *     probes. Nothing else in this repository holds a handle to `finance_db`.
 *   PlatformAuditModule — the platform's ONE audit trail, reached as a port. Financial
 *     keeps no audit table and never touches `core_db."AuditLog"` directly.
 *   PlatformEntitlementModule — the module/feature gate. Financial DECLARES the
 *     requirement (`@RequiresModule` / `@RequiresFeature` on the controller) and the
 *     platform DECIDES it.
 *   UserDirectoryModule — the platform's identity contract, for "is this id a member of
 *     my tenant?" before a project-manager id is stored. Financial's database cannot
 *     answer that, and must not try: there is no foreign key across databases.
 *   NO `RbacModule` (Phase CHECK-ISSUANCE). `@Roles(...)` on the controller is METADATA,
 *     and the only guard that reads it — `RolesGuard` — is a global APP_GUARD registered
 *     at each runtime's composition root, which resolves `PermissionSource` from the
 *     runtime's own binding (Core's `CorePermissionSource` in the combined runtime, a
 *     claim-backed `TokenPermissionSource` in a Core-free one). Financial injects NOTHING
 *     that `RbacModule` exports, and importing it anyway would pull Core's `PrismaModule`
 *     and `NotificationModule` into this bounded context transitively — exactly the
 *     coupling the boundary exists to prevent. `HrModule` established this shape first.
 *   StorageModule — the platform's `IStorageProvider` (MinIO) behind the string token
 *     `'IStorageProvider'`, for request-stage attachment bytes. Financial stores METADATA
 *     rows of its own and never a second copy of the object's lifecycle.
 *
 * WHAT IT DELIBERATELY DOES NOT IMPORT
 * ------------------------------------
 * No `PrismaModule` (Core), no `HrPrismaModule`, no `CommercePrismaModule`, no
 * `CorrespondencePrismaModule`, no `ProductionPrismaModule`, no `RbacModule` (Core's
 * authorization implementation), no notification module, no search module, no workflow
 * module of any kind. In particular: NO Commerce surface of any kind — `orderReference`
 * stays an opaque string and the `PurchaseOrderReferencePort` interface remains unbound
 * (no adapter exists, by the brief's §6).
 *
 * THE PROVIDER LIST IS THE WHOLE MODULE. One gateway (the audit envelope owner), two
 * repositories (the request and its child attachment — each the only writer of its own
 * table), two services (the application surfaces) and the platform guard. The repository
 * is PROVIDED and NOT exported, so nothing outside this bounded context can issue a query
 * against `finance_db`; the gateway is exported because it is the module's one seam the
 * future phases will share.
 */
@Module({
  imports: [
    FinancialPrismaModule,
    PlatformAuditModule,
    PlatformEntitlementModule,
    UserDirectoryModule,
    StorageModule,
  ],
  // TWO controllers, ONE feature: the requests surface (`check-requests/:id/...`) and
  // the static process definition the wizard renders from (`check-process`). Both carry
  // the same entitlement + authentication chain; neither reaches the database without a
  // service in between.
  controllers: [CheckRequestController, CheckProcessController],
  providers: [
    // The entitlement gate, provided where Nest instantiates it. The DECLARATION is on
    // the controller; this is what makes the declaration enforceable.
    ModuleEntitlementGuard,
    // The audit envelope owner: the ONE surface through which Financial writes to the
    // platform trail.
    FinancialAuditGateway,
    // Phase B2 — AUDIT DURABILITY: the relay that drains the outbox. Polls every 10s
    // for pending audit events and writes them through AUDIT_PORT.
    AuditOutboxRelayService,
    // The CheckRequest slice: the repository is the only writer of `CheckRequest`'s own
    // columns; the service above it is this module's own application surface.
    CheckRequestRepository,
    CheckRequestService,
    // The CheckAttachment slice: a child of the request above, scoped to one request of
    // one tenant on every call, and the only writer of `CheckAttachment`. Its service
    // shares the request repository for the state guard rather than reaching `finance_db`
    // itself, so each table keeps exactly one writer.
    CheckAttachmentRepository,
    CheckAttachmentService,
  ],
  exports: [FinancialAuditGateway],
})
export class FinancialModule {}
