import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { CryptoService } from '../common/crypto.service';
import { OpenAIProvider } from './openai.provider';
import { AzureOpenAIProvider } from './azure-openai.provider';
import { ClaudeProvider } from './claude.provider';
import { LocalLLMProvider } from './local-llm.provider';
import { AIProviderRegistry } from './ai-provider.registry';
import { AIRuntimeResolver } from './ai-runtime.resolver';
import { AIConfigService } from './ai-config.service';
import { AIConfigController } from './ai-config.controller';

/**
 * Phase 49J-0 turned this module into the AI configuration platform.
 * Phase AI-ARCH-HARDENING (§9/§10) adds the runtime RESOLUTION layer and keeps the
 * EXECUTION seam OUT of it: consumers do not import this module — they import
 * `PlatformAIModule` (`src/platform/ai/`), which binds the AI gateway over this
 * control plane. `AIConfigService` configures, `AIRuntimeResolver` resolves,
 * `AIGateway` executes.
 *
 * WHY EACH IMPORT IS HERE (§24, re-audited this phase)
 * ----------------------------------------------------
 * PrismaModule — `AIConfigService` reads/writes `AIProviderConfig`; the resolver
 *                reads the enabled default row. AI configuration is a Core-owned
 *                administrative capability, so Core persistence is the correct
 *                dependency rather than a fabricated separation.
 * RbacModule   — for `AuditService`, and only for it: AI configuration mutations are
 *                audited through the same (legacy) producer every Core module uses,
 *                so the existing audit actions and payloads survive unchanged.
 *                `RolesGuard` — once cited here as a reason — is NOT one: it is
 *                registered globally via `APP_GUARD` at the composition roots
 *                (`app.module.ts`, `core-app.module.ts`), so this module does not
 *                need RbacModule to have `@Roles(...)` enforced.
 *
 * THE `'IAIProvider'` DI TOKEN IS REMOVED. It pointed at the env-configured
 * OpenAIProvider instance and had zero remaining consumers (verified
 * repository-wide: no `@Inject('IAIProvider')` exists). Keeping it would have
 * preserved a second, credential-blind way to reach a provider beside the gateway —
 * exactly the parallel abstraction §25/§42 close out.
 *
 * CryptoService is provided HERE rather than only in AppModule/CoreAppModule so
 * that a test module importing AIModule alone gets a working encryption
 * dependency. It is the same DI shape RbacModule uses for AuditService.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [AIConfigController],
  providers: [
    OpenAIProvider,
    AzureOpenAIProvider,
    ClaudeProvider,
    LocalLLMProvider,
    AIProviderRegistry,
    AIRuntimeResolver,
    AIConfigService,
    CryptoService,
  ],
  exports: [
    OpenAIProvider,
    AzureOpenAIProvider,
    ClaudeProvider,
    LocalLLMProvider,
    AIProviderRegistry,
    AIRuntimeResolver,
    AIConfigService,
  ],
})
export class AIModule {}

