import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase C1: Commerce owns its own Prisma project/client, generated from
// prisma/commerce/schema.prisma into src/generated/commerce-client, reading
// COMMERCE_DATABASE_URL. This is a fully independent database/connection from Core's
// and HR's (see prisma.service.ts and hr-prisma.service.ts) — Commerce must never
// share Core's or HR's Prisma client, a migration history, or a physical foreign
// key with either owner.
// Precedent: HrPrismaService (51-HR-1), CorrespondencePrismaService (50-MOD-CORR),
// CmsPrismaService (33J), ObservabilityPrismaService (49M-2).
import { PrismaClient } from '../../../generated/commerce-client';

/**
 * The Commerce database connection.
 *
 * IT DOES CONNECT EAGERLY, exactly like `PrismaService`, `HrPrismaService`,
 * `CmsPrismaService` and `CorrespondencePrismaService`. Commerce is a BUSINESS
 * domain: if `commerce_db` is unreachable, purchase documents, workflow history and
 * payment/receiving/return ledgers cannot be read or written, so a process that
 * booted anyway would serve a surface where every request fails individually and
 * silently. Failing fast at boot is the honest behaviour.
 *
 * THE ONLY PERSISTENCE HANDLE FOR commerce_db. Controllers and services under
 * `src/modules/commerce/**` reach this database through repositories that are given
 * THIS service (or, for cross-boundary reads, the platform gateways of step H) —
 * never by constructing their own `PrismaClient`, never through Core's
 * `PrismaModule`, never through HR's. The isolation regression suite asserts all of
 * it.
 *
 * WHY COMMERCE DOES NOT REUSE Core's OR HR's Prisma SERVICE
 * ---------------------------------------------------------
 * `tenantId`, `requesterId`, `employeeId` and `approverId` are PLAIN STRINGS and
 * never foreign keys across databases: PostgreSQL cannot express a FK across
 * databases, and Commerce must not try to. Identity is reached through the platform
 * identity gateway (step H), personnel through the platform contracts — never
 * through a join, never through another owner's schema, never through another
 * owner's client.
 */
@Injectable()
export class CommercePrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
