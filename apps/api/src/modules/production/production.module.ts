import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../platform/audit/platform-audit.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { UserDirectoryModule } from '../../platform/user-directory/user-directory.module';
import { ProductionAuditGateway } from './production-audit.gateway';
import { ProductionAuditOutboxRelayService } from './production-audit-outbox-relay.service';
import { ProductionPrismaModule } from './database/production-prisma.module';
import { BomHeaderController } from './bom/bom.controller';
import { BomItemController } from './bom/bom-item.controller';
import { BomChangeRequestController } from './bom-change/bom-change.controller';
import { BomHeaderRepository } from './bom/bom.repository';
import { BomHeaderService } from './bom/bom.service';
import { BomItemRepository } from './bom/bom-item.repository';
import { BomItemService } from './bom/bom-item.service';
import { BomChangeRequestRepository } from './bom-change/bom-change.repository';
import { BomChangeRequestService } from './bom-change/bom-change.service';

/**
 * Phase PRODUCTION-BOM-HEADER: the Production bounded context's composition root.
 *
 * REGISTERED IN `AppModule` AND DELIBERATELY NOT IN `CoreAppModule`, exactly like
 * Correspondence, HR and Commerce: the Core-only deployable boots with zero Production
 * knowledge and reaches none of Production's tables.
 *
 * WHAT IT IMPORTS, AND WHY EACH ONE
 * ---------------------------------
 *   ProductionPrismaModule — this module's OWN database. It binds
 *     `PRODUCTION_PRISMA_CLIENT`, which is what makes `production_db` reachable and what
 *     the combined health graph probes. Nothing else in this repository holds a handle to
 *     `production_db`.
 *   PlatformAuditModule — the platform's ONE audit trail, reached as a port. Production
 *     keeps no audit table and never touches `core_db."AuditLog"` directly.
 *   PlatformEntitlementModule — the module/feature gate. Production DECLARES the
 *     requirement (`@RequiresModule` / `@RequiresFeature` on the controller) and the
 *     platform DECIDES it.
 *   UserDirectoryModule — the platform's identity contract, for "is this id a member of my
 *     tenant?". Production's database cannot answer that, and must not try to: there is no
 *     foreign key across databases.
 *   NO `RbacModule` (Phase CHECK-ISSUANCE). `@Roles(...)` on the controllers is METADATA,
 *     and `RolesGuard` — the only reader — is a global APP_GUARD registered at each
 *     runtime's composition root, resolving `PermissionSource` from the runtime's own
 *     binding (Core's `CorePermissionSource` combined, `TokenPermissionSource` Core-free).
 *     Production injects NOTHING that `RbacModule` exports; importing it anyway would pull
 *     Core's `PrismaModule` and `NotificationModule` in transitively. `HrModule` holds the
 *     same shape.
 *
 * WHAT IT DELIBERATELY DOES NOT IMPORT
 * ------------------------------------
 * No `PrismaModule` (Core), no `HrPrismaModule`, no `CommercePrismaModule`, no
 * `CorrespondencePrismaModule`, no `RbacModule`, no `NotificationModule` (no notification
 * this phase), no `PlatformSearchSourceModule` (no search this phase), no workflow module
 * of any kind. The architecture boundary spec asserts the first four, and the absence of
 * the rest is a scope decision recorded in the phase report.
 *
 * THE PROVIDER LIST IS THE WHOLE MODULE. One gateway (the audit envelope owner), two
 * repositories (the header and its child item — each the only writer of its own table), two
 * services (the application surfaces) and the platform guard. There is no second gateway
 * for identity because there is exactly one consumer of it, and a gateway with one caller
 * would be indirection without a boundary.
 *
 * THE EXPORTED SURFACE IS THE GATEWAY AND NOTHING ELSE — the same rule Commerce's
 * composition root states. The repository is PROVIDED and NOT exported, so nothing outside
 * this bounded context can issue a query against `production_db`.
 */
@Module({
  imports: [
    ProductionPrismaModule,
    PlatformAuditModule,
    PlatformEntitlementModule,
    UserDirectoryModule,
  ],
  controllers: [BomHeaderController, BomItemController, BomChangeRequestController],
  providers: [
    // The entitlement gate, provided where Nest instantiates it. The DECLARATION is on the
    // controller; this is what makes the declaration enforceable.
    ModuleEntitlementGuard,
    // The audit envelope owner: the ONE surface through which Production writes to the
    // platform trail.
    ProductionAuditGateway,
    // Phase B2.4: the relay that drains the Production audit outbox and delivers events
    // through AUDIT_PORT. Context-local infrastructure, not a business model.
    ProductionAuditOutboxRelayService,
    // The BOM Header slice. The repository is the only writer of `BomHeader`'s own
    // columns; the service above it is this module's own application surface.
    BomHeaderRepository,
    BomHeaderService,
    // The BOM Item slice (Phase PRODUCTION-BOM-ITEM): a child of the header above, scoped
    // to one header of one tenant on every call. It shares the SAME repository layer rather
    // than reaching `production_db` itself, and it is NOT exported — same rule as the header.
    BomItemRepository,
    BomItemService,
    // The BOM Change Request slice (Phase PRODUCTION-BOM-CHANGE): a SECOND aggregate root
    // over an existing BOM. Its service injects the two repositories above — the header's,
    // to resolve and snapshot the target BOM, and the item's, to resolve and snapshot a
    // named item against THAT BOM's scope — rather than reaching `production_db` for either
    // read, so each table keeps exactly one writer and one reader boundary. Its OWN
    // repository is the only writer of `BomChangeRequest` / `BomChangeRequestItem`. Not
    // exported: nothing outside this bounded context may issue a query against
    // `production_db`.
    BomChangeRequestRepository,
    BomChangeRequestService,
  ],
  exports: [ProductionAuditGateway],
})
export class ProductionModule {}