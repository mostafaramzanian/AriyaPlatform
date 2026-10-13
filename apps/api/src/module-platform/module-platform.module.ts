import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { CryptoService } from '../common/crypto.service';
import { ModuleRegistryController } from './module-registry.controller';
import { ModuleRegistrationController } from './module-registration.controller';
import { ModuleProvisioningController } from './module-provisioning.controller';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHealthService } from './module-health.service';
import { ModuleClient } from './module-client.service';
import { ModuleHttpTransport } from './module-http.transport';
import { ModuleSweepService } from './module-sweep.service';
import { ModuleProvisioningService } from './module-provisioning.service';
import { LocalProvisioningProvider } from './local-provisioning.provider';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import { CAPABILITY_CREDENTIAL_RESOLVER } from './capability-credential.resolver';

/**
 * Phase 49M: Core Distributed Module Platform.
 *
 * A CORE capability, so it is registered in CoreAppModule and never in the CMS-only process,
 * which has no Core database and therefore no `ModuleRegistration` or `ModuleInstance` table.
 *
 * WHY EACH IMPORT IS HERE
 * -----------------------
 * PrismaModule — the registry reads and writes both new tables, and the registration controller
 *                resolves the credential row it must verify against before touching anything.
 *
 * RbacModule   — supplies `RolesGuard`, which enforces the `@Roles(...)` decorators on
 *                `ModuleRegistryController`, and `AuditService` for the mutation trail. As in
 *                49L, RBAC here IS an entry gate rather than an output filter: admitting a module
 *                to the platform is not an ordinary user capability.
 *
 * CryptoService is provided HERE rather than only in CoreAppModule so a test module importing
 * `ModulePlatformModule` alone gets a working encryption dependency. Same DI shape `AIModule` and
 * `IntegrationsModule` use, and deliberately the SAME class and the SAME
 * `AI_CONFIG_ENCRYPTION_KEY`: §20 says reuse the existing secure secret architecture, so a
 * module credential lives in the same envelope format under the same master key as the AI
 * provider credentials and the 49L webhook secret. ONE master key, ONE secret store.
 *
 * NO IntegrationsModule IMPORT, even though this phase reuses 49L's signature primitives and its
 * URL policy. Those are pure FUNCTIONS in `integration-signature.ts` and
 * `integration-url.guard.ts`, imported directly; neither is a Nest provider, so there is nothing
 * to inject and no module-level coupling. That is deliberate: 49M extends 49L's mechanisms
 * without becoming dependent on its lifecycle, and `IntegrationsModule` stays free of any
 * dependency on this one.
 *
 * NO NotificationModule: a module registering or going quiet notifies nobody in Aria today.
 * Creating an in-app notification per lifecycle transition would flood the 49E centre with
 * infrastructure noise, exactly as 49L reasoned about dispatch.
 *
 * NO BUSINESS MODULE IMPORT, and this is the load-bearing absence: there is no SupportModule, no
 * PreferencesModule, no SearchModule here, and there will never be an HRModule or FinanceModule.
 * The dependency runs the OTHER way — a business module injects `ModuleClient`. Importing a
 * business module here would put the platform in the position of knowing what a domain means,
 * which is the coupling the whole phase exists to prevent.
 *
 * `ModuleClient` IS EXPORTED; `ModuleRegistryService` IS NOT. That asymmetry is the §24/§35
 * contract made structural: a business module can CALL, and cannot reach registration,
 * credentials, admin writes or the sweep even by accident. `ModuleHealthService` is exported
 * because a future Core surface may legitimately want to display module health without being able
 * to mutate the registry.
 * ARCH-3B ADDS ONE EXPORT, AND IT IS NOT THE REGISTRY. `CAPABILITY_CREDENTIAL_RESOLVER` is a
 * string token whose interface (`capability-credential.resolver.ts`) is ONE read-only method:
 * "the plaintext credential for this `(moduleId, capability)` pair, or undefined". The identity
 * and audit transports need exactly that and nothing else, and exporting the registry to give it
 * to them would have handed every importer of this module the ability to admit modules and
 * rotate credentials. The asymmetry above is therefore unchanged, and the wiring spec still
 * asserts that the class is absent from `exports`.
 *
 * PHASE 49M-1 ADDITIONS, and what they deliberately do NOT change
 * --------------------------------------------------------------
 * `ModuleProvisioningController` + `ModuleProvisioningService` + `ProvisioningProviderRegistry` +
 * `LocalProvisioningProvider` join this module rather than forming a new one, because they operate
 * on the same two 49M tables and reuse `ModuleHealthService` and the same `PrismaService`. A
 * separate `ModuleProvisioningModule` would have had to import this one to reach the health probe,
 * and then export a service that only this module's controller uses.
 *
 * NOTHING IS ADDED TO `exports`. The provisioning service is NOT exported, for exactly the reason
 * `ModuleRegistryService` is not: a business module that could reach it could redeploy or
 * decommission another module. The control plane is an ADMIN surface, reachable only through its
 * permission-gated controller.
 *
 * NO StorageModule IMPORT. Artifacts are referenced by object KEY on `ModuleRelease` and resolved
 * only when bytes are genuinely needed; the local provider verifies references, not payloads, so it
 * has no `IStorageProvider` dependency to inject. Importing it now would be wiring for a capability
 * this phase does not exercise.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [
    ModuleRegistryController,
    ModuleRegistrationController,
    ModuleProvisioningController,
  ],
  providers: [
    ModuleHttpTransport,
    ModuleRegistryService,
    ModuleHealthService,
    ModuleClient,
    ModuleSweepService,
    CryptoService,
    // 49M-1. The provider is registered by CLASS and reached only through the registry;
    // `ModuleProvisioningService` never imports it, which is what keeps the seam neutral.
    LocalProvisioningProvider,
    ProvisioningProviderRegistry,
    ModuleProvisioningService,
    // ADR-0006 A7/A8. The capability-credential RESOLUTION seam the platform transports inject.
    // `useExisting` rather than `useClass`, so one instance serves both the registry and the
    // seam and the seam can never be satisfied by a second, divergent resolver.
    { provide: CAPABILITY_CREDENTIAL_RESOLVER, useExisting: ModuleRegistryService },
  ],
  exports: [ModuleClient, ModuleHealthService, CAPABILITY_CREDENTIAL_RESOLVER],
})
export class ModulePlatformModule {}
