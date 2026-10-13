import { Module } from '@nestjs/common';
import { ObservabilityPrismaService } from './observability-prisma.service';
import { OBSERVABILITY_PRISMA_CLIENT } from '../health/health-tokens';

/**
 * Phase 49M-2: the observability database connection, as a module.
 *
 * Mirrors `CmsPrismaModule` exactly — one provider, exported — because that is the shape
 * 33J established for a second independent Prisma project and this is simply the third.
 *
 * IT IS DELIBERATELY NOT `@Global()`. Only `ObservabilityModule` imports it, and every
 * other capability reaches observability through the narrow emit services rather than
 * through the client. A global provider would let any service write directly into the log
 * tables, bypassing redaction, the message-code allowlist and the drop policy.
 */
@Module({
  providers: [
    ObservabilityPrismaService,
    { provide: OBSERVABILITY_PRISMA_CLIENT, useExisting: ObservabilityPrismaService },
  ],
  exports: [ObservabilityPrismaService, OBSERVABILITY_PRISMA_CLIENT],
})
export class ObservabilityPrismaModule {}
