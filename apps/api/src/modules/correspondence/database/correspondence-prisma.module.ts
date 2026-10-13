import { Module } from '@nestjs/common';
import { CorrespondencePrismaService } from './correspondence-prisma.service';
import { CORRESPONDENCE_PRISMA_CLIENT } from '../../../health/health-tokens';

/**
 * Phase 50-MOD-CORR: the Correspondence module's own database connection.
 *
 * Mirrors `CmsPrismaModule` (33J) exactly. Correspondence owns
 * `correspondence_db` through `CORRESPONDENCE_DATABASE_URL` and its own generated
 * client; Core's `PrismaModule` is never imported by this module or by anything
 * under `src/modules/correspondence/**`, which the §25 isolation spec asserts.
 */
@Module({
  providers: [
    CorrespondencePrismaService,
    { provide: CORRESPONDENCE_PRISMA_CLIENT, useExisting: CorrespondencePrismaService },
  ],
  exports: [CorrespondencePrismaService, CORRESPONDENCE_PRISMA_CLIENT],
})
export class CorrespondencePrismaModule {}