import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase 50-MOD-CORR: Correspondence owns its own Prisma project/client, generated
// from prisma/correspondence/schema.prisma into src/generated/correspondence-client,
// reading CORRESPONDENCE_DATABASE_URL. This is a fully independent
// database/connection from Core's (see prisma.service.ts) — Correspondence must
// never share Core's Prisma client, a migration history, or a physical foreign key
// with Core. Precedent: CmsPrismaService (33J), ObservabilityPrismaService (49M-2).
import { PrismaClient } from '../../../generated/correspondence-client';

/**
 * The correspondence database connection.
 *
 * IT DOES CONNECT EAGERLY, unlike `ObservabilityPrismaService` and exactly like
 * `PrismaService`/`CmsPrismaService`. Correspondence is a BUSINESS domain: if its
 * database is unreachable, letters cannot be drafted, sent, read or archived, so a
 * process that boots anyway would serve a surface where every request fails
 * individually and silently. Failing fast at boot is the honest behaviour — the same
 * call Core makes for `core_db`.
 */
@Injectable()
export class CorrespondencePrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}