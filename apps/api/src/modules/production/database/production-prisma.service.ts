import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase PRODUCTION-BOM-HEADER: Production owns its own Prisma project/client, generated
// from prisma/production/schema.prisma into src/generated/production-client, reading
// PRODUCTION_DATABASE_URL. This is a fully independent database/connection from Core's,
// HR's, Commerce's and Correspondence's — Production must never share another owner's
// Prisma client, a migration history, or a physical foreign key with any of them.
// Precedent: CommercePrismaService (Phase C1), HrPrismaService (51-HR-1),
// CorrespondencePrismaService (50-MOD-CORR), CmsPrismaService (33J),
// ObservabilityPrismaService (49M-2).
import { PrismaClient } from '../../../generated/production-client';

/**
 * The Production database connection.
 *
 * IT DOES CONNECT EAGERLY, exactly like `PrismaService`, `HrPrismaService` and
 * `CommercePrismaService`. Production is a BUSINESS domain: if `production_db` is
 * unreachable, BOM documents cannot be read or written, so a process that booted anyway
 * would serve a surface where every request fails individually and silently. Failing
 * fast at boot is the honest behaviour.
 *
 * THE ONLY PERSISTENCE HANDLE FOR `production_db`. Controllers and services under
 * `src/modules/production/**` reach this database through the repository that is given
 * THIS service — never by constructing their own `PrismaClient`, never through Core's
 * `PrismaModule`, never through HR's, Commerce's or Correspondence's. The architecture
 * boundary spec and this module's own isolation suite assert all of it.
 *
 * WHY PRODUCTION DOES NOT REUSE ANOTHER OWNER'S PRISMA SERVICE
 * -----------------------------------------------------------
 * `tenantId`, `projectRef`, `productTreeRef`, `requesterUserId`, `approverUserId` and
 * `decidedByUserId` are PLAIN STRINGS and never foreign keys across databases:
 * PostgreSQL cannot express a FK across databases, and Production must not try to. There
 * is no Project table and no Product Tree table anywhere in this repository, so those two
 * references have nothing to point at even inside a single database (M-1 / RB-1).
 * Identity is reached through the platform user-directory contract — never through a
 * join, never through another owner's schema, never through another owner's client.
 */
@Injectable()
export class ProductionPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}