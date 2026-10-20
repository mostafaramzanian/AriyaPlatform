import { Module } from '@nestjs/common';
import { NotificationModule } from '../../notifications/notification.module';
import { RbacModule } from '../../auth/rbac/rbac.module';
import { StorageModule } from '../../storage/storage.module';
import { PlatformAuditModule } from '../../platform/audit/platform-audit.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { PlatformSearchSourceModule } from '../../platform/search-source/platform-search-source.module';
import { UserDirectoryModule } from '../../platform/user-directory/user-directory.module';
import { PureRuleEngineModule } from '../../rules/pure-rule-engine.module';
import { CommerceAuditGateway } from './commerce-audit.gateway';
import { CommerceAuditOutboxRelayService } from './commerce-audit-outbox-relay.service';
import { CommerceIdentityGateway } from './commerce-identity.gateway';
import { CommerceNotificationGateway } from './commerce-notification.gateway';
import { CommerceSearchSourceService } from './search/commerce-search-source.service';
import { CommercePrismaModule } from './database/commerce-prisma.module';
import { CommerceUnitOfWork } from './database/commerce-transaction';
import { CommercialController } from './commercial/commercial.controller';
import { CommercialConfigurationRepository } from './commercial/commercial-configuration.repository';
import { CommercialConfigurationService } from './commercial/commercial-configuration.service';
import { CommercialLifecycleRepository } from './commercial/commercial-lifecycle.repository';
import { CommercialLifecycleService } from './commercial/commercial-lifecycle.service';
import { CommercialLiaisonResolver } from './commercial/commercial-liaison';
import { PurchaseController } from './purchase/purchase.controller';
import { PurchaseRepository } from './purchase/purchase.repository';
import { PurchaseService } from './purchase/purchase.service';
import { PurchaseTimelineService } from './purchase/purchase-timeline.service';
import { PurchaseHistoryService } from './purchase/purchase-history.service';
import { PurchaseHistoryRepository } from './purchase/purchase-history.repository';
import { PurchaseCompletionPolicyController } from './completion/purchase-completion-policy.controller';
import { PurchaseCompletionPolicyRepository } from './completion/purchase-completion-policy.repository';
import { PurchaseCompletionPolicyService } from './completion/purchase-completion-policy.service';
import { PurchaseCompletionService } from './completion/purchase-completion.service';
import { PaymentHistoryController } from './payment/payment-history.controller';
import { PaymentHistoryRepository } from './payment/payment-history.repository';
import { PaymentHistoryService } from './payment/payment-history.service';
import { PaymentPlanController } from './payment-plan/payment-plan.controller';
import { PaymentPlanRepository } from './payment-plan/payment-plan.repository';
import { PaymentPlanService } from './payment-plan/payment-plan.service';
import { ReceivingHistoryController } from './receiving/receiving-history.controller';
import { ReceivingHistoryRepository } from './receiving/receiving-history.repository';
import { ReceivingHistoryService } from './receiving/receiving-history.service';
import { ReturnHistoryController } from './returns/return-history.controller';
import { ReturnHistoryRepository } from './returns/return-history.repository';
import { ReturnHistoryService } from './returns/return-history.service';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryPostingFacade } from '../inventory/integration/inventory-posting.facade';
import { INVENTORY_POSTING_PORT } from './integration/inventory-posting.port';
import { InventoryPostingRepository } from './integration/inventory-posting.repository';
import { CommerceOrderReferenceFacade } from './integration/purchase-order-reference.facade';
import { InventoryIntegrationService } from './integration/inventory-integration.service';
import { InventoryPostingController } from './integration/inventory-posting.controller';
import { WorkflowConfigurationController } from './workflow/workflow-configuration.controller';
import { WorkflowConfigurationRepository } from './workflow/workflow-configuration.repository';
import { WorkflowConfigurationService } from './workflow/workflow-configuration.service';
import { WorkflowExecutionRepository } from './workflow/workflow-execution.repository';
import { WorkflowExecutionService } from './workflow/workflow-execution.service';
import { WorkflowLineRoutingConfigurationService } from './workflow/workflow-line-routing-configuration.service';
import { WorkflowLineRoutingRepository } from './workflow/workflow-line-routing.repository';
import { WorkflowLineRoutingService } from './workflow/workflow-line-routing.service';
import { WorkflowLineRoutingController } from './workflow/workflow-line-routing.controller';
import { WorkflowExecutionController } from './workflow/workflow-execution.controller';
import { PendingDecisionsController } from './pending/pending-decisions.controller';
import { PendingDecisionsService } from './pending/pending-decisions.service';
import { QuotationController } from './quotation/quotation.controller';
import { QuotationRepository } from './quotation/quotation.repository';
import { QuotationService } from './quotation/quotation.service';
import { SupplierController } from './supplier/supplier.controller';
import { SupplierRepository } from './supplier/supplier.repository';
import { SupplierService } from './supplier/supplier.service';

/**
 * Phase C1: Commerce — the procurement bounded context — as an INDEPENDENT business
 * module.
 *
 * WHAT "INDEPENDENT" MEANS HERE, CONCRETELY
 * ----------------------------------------
 * Commerce owns `commerce_db` through `COMMERCE_DATABASE_URL`, its own Prisma project
 * (`prisma/commerce/schema.prisma`), its own generated client
 * (`src/generated/commerce-client`), its own migration history
 * (`prisma/commerce/migrations`) and its own data-access layer. There is NO foreign
 * key between `commerce_db` and `core_db`, and there cannot be: PostgreSQL does not
 * express one across databases, which is exactly why purchase history and the Core
 * user lifecycle are independent facts.
 *
 * Precedent for every mechanism here: `src/modules/hr/**` (51-HR-1) for the module
 * shell, the owned client and the tenancy discipline; `src/modules/correspondence/**`
 * (50-MOD-CORR) for composition-root registration.
 *
 * COMPOSITION. Registered in `app.module.ts` — the combined composition root — and
 * deliberately NOT in `CoreAppModule` (gate G5): the Core-only deployable boots with
 * zero Commerce knowledge, reaches none of Commerce's tables and ships no Commerce
 * client. `architecture-boundaries.spec.ts` derives which roots may name this module
 * from the DATASOURCE POLICY, never from a hand-written runtime list.
 *
 * DEPENDENCIES TODAY, each for a concrete reason and none "for symmetry"
 * --------------------------------------------------------------------
 *  - `CommercePrismaModule`: the module's OWN database. Core's `PrismaModule` and
 *    HR's `HrPrismaModule` are deliberately ABSENT — the architecture boundary spec
 *    and the isolation suite fail the build if either appears under this directory.
 *  - `UserDirectoryModule`, `PlatformAuditModule` and `NotificationModule` (step H):
 *    the three platform capabilities this module is allowed to use, each imported for
 *    the ONE gateway that consumes it — `CommerceIdentityGateway` reads identity
 *    (§I7), `CommerceAuditGateway` writes the trail (§I8), `CommerceNotificationGateway`
 *    emits events (§I9). The modules are IMPORTED, never re-exported: handing another
 *    module a re-exported platform module would publish Commerce's route into the
 *    platform, which is not this module's to give.
 *  - `PlatformEntitlementModule` + `ModuleEntitlementGuard` (step J): the entitlement
 *    gate, wired exactly as HR wires it (§14-F). The guard is PROVIDED here because
 *    Nest instantiates a guard in the module that declares it, and the module import
 *    is what supplies the `ENTITLEMENT_PORT` that instantiation resolves against —
 *    `PlatformEntitlementModule` exports the port and nothing else, so importing it is
 *    not a way for Commerce to ask the entitlement question for itself. No Commerce
 *    service, gateway or repository references either of them; the first Commerce
 *    controller (step L) will declare the REQUIREMENT, never the decision.
 *
 * The remaining platform surfaces join this import list exactly when the step that
 * creates their SINGLE Commerce-side consumer lands, never earlier and never by
 * convention: `PureRuleEngineModule` still arrives with workflow condition evaluation
 * (step M); `PlatformEntitlementModule` joined WITH its consumer-facing guard in step J,
 * after which every Commerce controller carries `@RequiresModule(COMMERCE_MODULE_ID)`
 * from its first route onward. Each is a §9 cross-boundary contract consumed through
 * its port — never a direct reach into another module's database, and never a
 * duplicate of a platform capability.
 *
 * NO QUEUE (gate I19), AND A BOUNDARY THAT MOVED ON PURPOSE (3.3).
 * C1's boundary is synchronous domain work with one exception: 
 * `CommerceAuditOutboxRelayService` (Phase B2.3) uses `setInterval` to poll the local
 * `AuditOutbox` table and deliver durable audit events through `AUDIT_PORT`. This relay
 * is the same pattern Financial adopted in Phase B2, context-local. Nothing here is
 * time-triggered and no queue, worker or scheduler exists.
 *
 * STORAGE / UPLOAD ARRIVED WITH ITS SINGLE CONSUMER (GAP-6 follow-up 3.3, explicitly
 * owner-authorized): the procurement workflow requires the scanned quotation document to
 * be a REAL uploaded artifact, not a reference string, so the earlier "NO STORAGE, NO
 * UPLOAD" clause was revised deliberately — not bypassed. The revision's exact shape:
 * `StorageModule` is imported here, `IStorageProvider` is injected into exactly ONE
 * provider (`QuotationService`), and the only routes are
 * `POST/GET commerce/price-quotations/:id/attachment` — object-first writes with
 * cleanup on a failed row, short-lived signed download URLs, the storage key never on
 * the wire. Adding a second consumer requires the same deliberate documentation and
 * gate update; nothing else in Commerce may reach storage.
 *
 * NOT YET IN THIS SHELL BEFORE STEP L: controllers, services and repositories arrive
 * with the domain steps behind this file, and step L is the first of them. The purchase
 * slice (`purchase/`) now registers `PurchaseController`, `PurchaseService` and
 * `PurchaseRepository` here — repositories are PROVIDED and NOT EXPORTED, exactly as
 * HR's are: nothing outside this module issues a query against `commerce_db`, the
 * services above the repositories are the module's published surface, and `tenantId` is
 * the FIRST parameter of every repository method. The slice's own files are one folder
 * (`purchase/`), its pure rules (`purchase-status.ts`, `purchase-money.ts`,
 * `purchase-number.ts`) have no dependencies at all, and the schema fact it needed —
 * `PurchaseDocumentCounter`, the numbering table step K deliberately deferred — arrived
 * as its own additive migration rather than as an edit to the baseline.
 * Permissions landed with step J as the `commerce.*` namespace registered in `core_db`
 * by Core migrations 20260926100000/20260926100100: the permission catalogue and module
 * entitlement remain Core/platform-owned (§10), so this module never seeds, stores or
 * resolves them itself.
 *
 * THE EXPORTED SURFACE IS THE THREE GATEWAYS, AND NOTHING ELSE
 * ------------------------------------------------------------
 * Repositories are provided and NOT exported (C1); no service, no DTO and no platform
 * module is exported either — nothing outside this bounded context consumes them, and
 * re-exporting a platform module would publish Commerce's route into the platform for
 * every other module to inherit. The gateways ARE exported because they are this
 * module's declared boundary surface under §I7–§I9: identity reads, audit writes and
 * event emission leave Commerce only here. HR exports `HrIdentityGateway` and
 * `HrAuditGateway` for the same reason; Commerce additionally exports
 * `CommerceNotificationGateway` because §I9 names it a boundary in its own right,
 * and — PHASE W2-C — `CommerceOrderReferenceFacade`, the narrow resolution seam
 * the neutral `purchase-order-reference` bridge module consumes for Financial's
 * check-request validation. It is a facade, not a repository or service, so the
 * export still publishes no Commerce data path.
 * Structural DI is what makes an exported gateway a meaningful claim rather than a
 * formality: any file in this module can write `@Inject(USER_DIRECTORY)` and still
 * type-check, so the assertion that these three are the ONLY consumers is a test
 * (`commerce-gateways.spec.ts`), not something the compiler can enforce.
 */
@Module({
  imports: [
    CommercePrismaModule,
    UserDirectoryModule,
    PlatformAuditModule,
    PlatformEntitlementModule,
    NotificationModule,
    // GAP-6 follow-up 3.3 (owner-authorized I19 boundary revision): the platform's
    // object-storage seam, reached EXACTLY the way Financial/Correspondence reach it
    // (StorageModule → 'IStorageProvider' → MinioProvider) and consumed by exactly
    // ONE provider — QuotationService's attachment upload/download — never
    // re-exported, never imported by a repository or gateway. The module header
    // records why the boundary moved and what still holds.
    StorageModule,
    PureRuleEngineModule,
    // PHASE C9 (GAP-5): the platform's GLOBAL SEARCH SOURCE seam (P-SEARCH-SOURCE). It is
    // imported for exactly ONE consumer — `CommerceSearchSourceService`, the module's
    // registration with `SEARCH_SOURCE_PORT` — and it is the ONE-WAY direction the
    // platform contract fixes: Commerce depends on a platform capability, the platform
    // never depends on Commerce. The port token is the only thing this import supplies;
    // the index (`SearchDocument`, `core_db`) stays unreachable from here by construction.
    PlatformSearchSourceModule,
    // PHASE C9 (GAP-5): `RbacModule` supplies the `PermissionSource` the search source's
    // authorization asks — the SAME seam `RolesGuard` consults for every
    // `@Roles(Permissions.COMMERCE_READ)` route, so the search rule is the module's
    // existing read rule and not a second permission source. Precedent: `HrModule`
    // imports `RbacModule` for its own `hr.*` permission gates; nothing here reads RBAC
    // tables or resolves roles itself.
    RbacModule,
    // PHASE W2-B (owner-mandated purchase↔inventory integration): Inventory's
    // module is imported for exactly ONE export — `InventoryPostingFacade`,
    // the narrow posting surface bound to `INVENTORY_POSTING_PORT` below.
    // The direction is one-way (Commerce asks, Inventory owns its database),
    // and importing the MODULE — never its Prisma service or repositories —
    // is what keeps every stock effect inside the inventory-owned boundary.
    InventoryModule,
  ],
  controllers: [
    PurchaseController,
    WorkflowConfigurationController,
    CommercialController,
    PaymentHistoryController,
    PaymentPlanController,
    // Step R's receiving routes: the same `commerce/purchase-documents` path,
    // because a receipt has no meaning apart from the document it receives
    // against. Three routes, no fourth — no PATCH/PUT/DELETE exists (R7).
    ReceivingHistoryController,
    // Step S's return routes: the same path again, because a return has no
    // meaning apart from the document it returned from. SIX routes, no
    // seventh — no PATCH/PUT/DELETE, no cancel and no reverse-return exists
    // (S-D4, contract §7).
    ReturnHistoryController,
    // PHASE C2 (GAP-1): §11's workflow-execution routes — READ, DECIDE, CANCEL — over the
    // runtime step N built. Registered beside the configuration controller for the same
    // reason it lives in this module: the routes are Commerce's own surface, the services
    // they delegate to are already provided here, and no second Nest module exists (or is
    // wanted) for one bounded context's routes.
    WorkflowExecutionController,
    // PHASE C2 (GAP-1b): the session-scoped pending-decision inbox — a VIEW across the
    // workflow and commercial decision systems, which is why it belongs to neither slice's
    // controller; it resolves the actor from the request exactly like every other list route.
    PendingDecisionsController,
    // PHASE C3 (GAP-2): the line-routing CONFIGURATION routes — list, read, open a DRAFT,
    // publish — over the capability step O built. Registered here for exactly the reason
    // every other controller is: the routes are Commerce's own surface and the service they
    // delegate to is already provided below, so no second Nest module (and no second
    // composition point) exists for one bounded context's configuration.
    WorkflowLineRoutingController,
    // PHASE C4-R (GAP-3): the PURCHASE COMPLETION POLICY routes — list, read, open a DRAFT,
    // edit a DRAFT, validate, publish, archive — registered the same way and for the same
    // reason. The COMPLETION ACT itself is not a second controller: its one route
    // (`POST commerce/purchase-documents/:id/close`) belongs to the document collection and
    // lives on `PurchaseController`, which delegates to the completion service below.
    PurchaseCompletionPolicyController,
    // PHASE GAP-6: the PRICE QUOTATION routes — list a document's quotation trail,
    // record one version, decide the pending one. Registered the same way and for the
    // same reason as every other controller: the routes are Commerce's own surface and
    // the service they delegate to is provided below, so no second Nest module exists
    // for one bounded context's price-evidence loop.
    QuotationController,
    // SUPPLIER MASTER DATA: the directory's seven routes under
    // `commerce/suppliers` — reads under `commerce.read`, the two writes and the
    // SENSITIVE BANKING projection under `commerce.supplier.manage` (the seventh
    // Commerce permission, seeded by core migration
    // 20261017140100_seed_commerce_supplier_permission).
    SupplierController,
    // PHASE W2-B: the integration's operational surface — the posting queue
    // read and the retry act (two routes, under `commerce/inventory-postings`).
    InventoryPostingController,
  ],
  providers: [
    ModuleEntitlementGuard,
    CommerceIdentityGateway,
    CommerceAuditGateway,
    CommerceNotificationGateway,
    // PHASE C9 (GAP-5): the module's ONE search surface. It registers itself with
    // `SEARCH_SOURCE_PORT` in its constructor (the port's own contract: registration is
    // composition and a malformed registration must fail the boot), it is pushed a
    // projection by `PurchaseService.create`, and it answers the platform's batched
    // authorization question from `commerce_db`. PROVIDED and NOT exported — like every
    // other Commerce provider, and like the gateways above it is the module's own
    // boundary surface rather than an API another module calls.
    CommerceSearchSourceService,
    CommerceUnitOfWork,
    // Step L's domain slice. PROVIDED here and NOT exported: nothing outside this
    // bounded context issues a query against `commerce_db`, and the services above the
    // repositories are this module's own application surface rather than a published
    // API for other modules to call. HR's module registers its slices the same way —
    // one composition root per bounded context, no per-slice Nest module, which is also
    // what keeps the provider graph free of a module cycle (a nested `PurchaseModule`
    // would have to import CommerceModule to reach the gateways that CommerceModule
    // provides).
    PurchaseRepository,
    PurchaseService,
    // Step M's configuration slice, registered the same way and for the same reasons: the
    // repository is PROVIDED and NOT exported, and the service above it is this module's own
    // application surface. Step M owns CONFIGURATION only — no `WorkflowInstance` is created,
    // no condition is evaluated, and no `PurchaseDocument` row is touched by any of these
    // statements (§20, §21) — so nothing here consumes the notification gateway either: an
    // event nobody acts on yet would be a payload with no reader.
    WorkflowConfigurationRepository,
    WorkflowConfigurationService,
    // Step N/O execution and routing slices. N owns the workflow execution foundation; O
    // extends it to line-level routing. The same Rule Engine (§6.2) is imported above.
    WorkflowExecutionRepository,
    WorkflowExecutionService,
    WorkflowLineRoutingRepository,
    WorkflowLineRoutingConfigurationService,
    WorkflowLineRoutingService,
    // Step P's commercial slice, registered the same way and for the same reasons: the
    // two repositories are PROVIDED and NOT exported (nothing outside this bounded
    // context issues a query against `commerce_db`), and the two services above them
    // are this module's own application surface. P owns Commercial Groups, liaison
    // resolution, line assignment with its append-only history, Commercial Approval
    // and the ONE `PurchaseDocument` projection writer — a separate lifecycle from the
    // workflow's, which is why it sits beside the workflow providers rather than
    // inside them. No new Nest module: `CommerceModule` stays the single composition
    // point, no Core registration, Commerce DB only.
    CommercialLiaisonResolver,
    CommercialConfigurationRepository,
    CommercialConfigurationService,
    CommercialLifecycleRepository,
    CommercialLifecycleService,
    // Step Q's payment-history slice, registered the same way and for the same reasons:
    // the repository is PROVIDED and NOT exported (nothing outside this bounded context
    // issues a query against `commerce_db`), and the service above it is this module's
    // own application surface. Q owns APPEND-ONLY `PaymentRecord` rows and the read-time
    // payment status projection — an INDEPENDENT dimension (§5.11–§5.13), so no
    // workflow, commercial or receiving provider is reached from this slice, it needs
    // only the audit gateway for §I8's one row per write, and Q8 publishes no event.
    PaymentHistoryRepository,
    PaymentHistoryService,
    // The payment-instruction slice (دستور پرداخت / رژیم پرداخت): the
    // repository is PROVIDED and NOT exported, like every Commerce repository,
    // and the service orchestrates plan/stage transitions plus execution —
    // which appends through the SAME `PaymentRecord` table the payment
    // history owns, inside one unit of work, so an installment and its money
    // event can never commit apart.
    PaymentPlanRepository,
    PaymentPlanService,
    // Step R's receiving-history slice, registered the same way and for the same
    // reasons: the repository is PROVIDED and NOT exported (nothing outside this
    // bounded context issues a query against `commerce_db`), and the service above
    // it is this module's own application surface. R owns APPEND-ONLY `Receipt` /
    // `ReceiptLine` rows and the read-time receiving status projection — an
    // INDEPENDENT lifecycle (R6, §3-I) that mutates no `PurchaseDocument`, no
    // `WorkflowInstance`, no commercial row and no `PaymentRecord`, so no
    // commercial/payment/workflow provider is reached from this slice, it needs
    // only the audit gateway for §I8's one row per write, and R20 publishes no
    // event: this module's notification gateway gains no receiving caller.
    ReceivingHistoryRepository,
    ReceivingHistoryService,
    // Step S's return-history slice, registered the same way and for the same
    // reasons: the repository is PROVIDED and NOT exported (nothing outside
    // this bounded context issues a query against `commerce_db`), and the
    // service above it is this module's own application surface. S owns the
    // APPEND-ONLY `ReturnDocument` / `ReturnLine` / `ReturnLifecycleTransition`
    // rows and the read-time return-state projection — a CHILD lifecycle (S-D2)
    // that mutates no `PurchaseDocument`, no `WorkflowInstance`, no commercial
    // row, no `Receipt` / `ReceiptLine` and no `PaymentRecord`. Its ONE
    // cross-slice dependency is Q's `PaymentHistoryService`, provided above in
    // this same composition root, which the refund calls through the public
    // service surface only (§4-E) — Q stays payment-history owner, and this
    // module's notification gateway still gains no return caller (no event).
    ReturnHistoryRepository,
    ReturnHistoryService,
    // PHASE C2 (GAP-1b): the inbox service, provided in this composition root like every
    // other Commerce service — its dependencies (the two repositories plus PurchaseRepository
    // for display joins) are all provided above, so no import or export is added and the
    // exported surface stays the three gateways.
    PendingDecisionsService,
    // PHASE C4-R (GAP-3): the completion slice, registered the same way and for the same
    // reasons. `PurchaseCompletionPolicyRepository` is PROVIDED and NOT exported (it owns
    // `PurchaseCompletionPolicyVersion` and nothing else), `PurchaseCompletionPolicyService`
    // is the configuration surface the seven `completion-policies` routes delegate to, and
    // `PurchaseCompletionService` is THE completion act — the ONE service that may move a
    // `PurchaseDocument` to `CLOSED`, reading the published policy through the repository
    // above and writing through `PurchaseRepository` (which stays the document's only
    // writer, so no second writer exists for an owned model). It changes NO other lifecycle:
    // no payment, receipt, return or workflow row is touched by completion (C1 §29).
    PurchaseCompletionPolicyRepository,
    PurchaseCompletionPolicyService,
    PurchaseCompletionService,
    // PHASE GAP-6: the price-quotation slice, registered like every other Commerce
    // slice. `QuotationRepository` is PROVIDED and NOT exported (it owns
    // `PriceQuotation` / `QuotationLine` and reads the parent document only — the
    // payment/receiving cross-slice READ seam), and `QuotationService` is this
    // module's own application surface behind the three `price-quotations` routes.
    // Quotations are a CHILD lifecycle: this module's only new writes are the two
    // quotation tables and the audit outbox; no other lifecycle is touched.
    QuotationRepository,
    QuotationService,
    // SUPPLIER MASTER DATA: `SupplierRepository` is PROVIDED and NOT exported (it
    // owns `Supplier` alone, plus the two cross-slice READ seams — purchase
    // documents and quotations that NAME a supplier — which observe but never
    // write the other slices' models). `SupplierService` is this module's own
    // application surface behind the seven `commerce/suppliers` routes.
    // `QuotationService` also consumes `SupplierRepository` (the application-layer
    // cross-slice convention `commercial-lifecycle.service.ts` establishes with
    // `PurchaseRepository`) to validate a quotation's optional `supplierId`
    // against the tenant's own directory rows.
    SupplierRepository,
    SupplierService,
    // PHASE C7 (GAP-7): the purchase audit-timeline read, registered like every other
    // Commerce service — its dependencies (PurchaseRepository and the audit gateway,
    // both provided above) are already in this composition root, so no import and no
    // export is added. It is PROVIDED and NOT exported: the timeline is this module's
    // own application surface, reached through `PurchaseController`, and nothing
    // outside the bounded context holds a reference to the audit read.
    PurchaseTimelineService,
    // PHASE W3.2: the aggregated traceability read — repository + service,
    // read-only over Commerce rows plus the platform audit port.
    PurchaseHistoryRepository,
    PurchaseHistoryService,
    // Phase B2.3: the Commerce audit outbox relay — drains `AuditOutbox` rows and
    // delivers them through `AUDIT_PORT` to `core_db."AuditLog"`. Uses `setInterval`
    // (the ONE exception to C1's "no timer" boundary — same pattern as Financial B2).
    CommerceAuditOutboxRelayService,
    // PHASE W2-B: the Commerce→Inventory integration slice. The repository is
    // the sole writer of `InventoryPosting` (the durable at-least-once record);
    // the service plans postings inside the receipt/return units of work and
    // attempts them post-commit through the port — bound here to Inventory's
    // exported facade, so the ONLY way Commerce reaches stock is the
    // inventory-owned provider. `useExisting` — no adapter class to drift.
    InventoryPostingRepository,
    InventoryIntegrationService,
    { provide: INVENTORY_POSTING_PORT, useExisting: InventoryPostingFacade },
    // PHASE W2-C: the order-reference resolution Financial's check-request
    // consumes through `PurchaseOrderReferencePort`. Provided AND exported —
    // the ONLY non-gateway export — so the neutral bridge module
    // (`modules/purchase-order-reference/`) can bind it without Financial ever
    // importing a Commerce file itself.
    CommerceOrderReferenceFacade,
  ],
  // The exported surface is the three gateways PLUS the one W2-C facade the
  // bridge module binds; repositories, services and clients stay internal.
  exports: [
    CommerceIdentityGateway,
    CommerceAuditGateway,
    CommerceNotificationGateway,
    CommerceOrderReferenceFacade,
  ],
})
export class CommerceModule {}
