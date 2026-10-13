import { Module } from '@nestjs/common';
import { AIModule } from '../../ai/ai.module';
import { AI_GATEWAY } from './ai-gateway.contract';
import { AIGateway } from './ai-gateway.service';

/**
 * Phase AI-ARCH-HARDENING (§10/§30): the platform's AI seam, and the module that
 * owns the binding.
 *
 * WHY THIS IS A PLATFORM MODULE AND NOT PART OF `AIModule`
 * --------------------------------------------------------
 * `AIModule` is the CONTROL PLANE: configuration CRUD, audit, the admin controller.
 * A consumer that imported it would acquire the configuration service, the registry
 * and the provider classes — everything this phase exists to keep out of business
 * code. This module imports `AIModule` for its OWN use and exports ONLY the gateway
 * token, the same shape `PlatformAuditModule` established for the audit port and
 * `PlatformSearchSourceModule` for the search-source port.
 *
 * WHAT A CONSUMER GETS: `AI_GATEWAY` — typed as `AIGatewayContract` — and nothing
 * else. No provider instance, no credential, no Prisma handle, no capability matrix.
 * The eventual Reporting module depends on this module the way Search does today.
 *
 * `useExisting` rather than `useClass`: ONE gateway instance serves the token, so a
 * future internal consumer (a health probe, say) cannot bind a second, divergent one.
 */
@Module({
  imports: [AIModule],
  providers: [
    AIGateway,
    { provide: AI_GATEWAY, useExisting: AIGateway },
  ],
  exports: [AI_GATEWAY],
})
export class PlatformAIModule {}
