import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { CryptoService } from '../common/crypto.service';
import { IntegrationController } from './integration.controller';
import { IntegrationCallbackController } from './integration-callback.controller';
import { IntegrationService } from './integration.service';
import { AutomationService } from './automation.service';
import { AutomationRetryService } from './automation-retry.service';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import { N8nIntegrationProvider } from './n8n-integration.provider';

/**
 * Phase 49L: Core Automation & Integration Platform.
 *
 * A CORE capability, so it is registered in CoreAppModule and never in the CMS-only
 * process, which has no Core database and therefore no `IntegrationConfig` or
 * `AutomationExecution` table.
 *
 * WHY EACH IMPORT IS HERE
 * -----------------------
 * PrismaModule — the service reads and writes both new tables, and the callback
 *                controller resolves the config and execution rows it must verify
 *                against before touching anything.
 *
 * RbacModule   — supplies `RolesGuard`, which enforces the `@Roles(...)` decorators on
 *                `IntegrationController`, and `AuditService` for the mutation trail.
 *                Unlike 49J and 49K, RBAC here IS an entry gate rather than an output
 *                filter: managing a global outbound destination is not an ordinary
 *                user capability.
 *
 * CryptoService is provided HERE rather than only in CoreAppModule so a test module
 * importing `IntegrationsModule` alone gets a working encryption dependency. It is
 * the same DI shape `AIModule` uses, and it is deliberately the SAME class and the
 * SAME `AI_CONFIG_ENCRYPTION_KEY`: §15 forbids a second secret store, so the webhook
 * secret lives in the same envelope format under the same master key as the AI
 * provider credentials.
 *
 * NO NotificationModule: a delivered automation event notifies nobody in Aria. The
 * external workflow may send an email or a message, but that is the engine's job, and
 * creating an in-app notification per dispatch would flood the 49E centre with
 * infrastructure noise.
 *
 * NO SupportModule / MessagingModule / SurveysModule / CalendarModule, and that is
 * the important one. This module has no inbound dependency on any business capability
 * — the dependency runs the OTHER way: `SupportService` injects `AutomationService`.
 * Importing them here would create a cycle and would put integration code in the
 * position of deciding what a business event means.
 *
 * `AutomationService` IS EXPORTED; `IntegrationService` IS NOT. That asymmetry is the
 * §3 contract made structural: a business module can emit, and cannot reach
 * configuration, secrets, the provider registry or the retry pass even by accident.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [IntegrationController, IntegrationCallbackController],
  providers: [
    N8nIntegrationProvider,
    IntegrationProviderRegistry,
    IntegrationService,
    AutomationService,
    AutomationRetryService,
    CryptoService,
  ],
  exports: [AutomationService],
})
export class IntegrationsModule {}
