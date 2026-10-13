import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase 51-HR-1: HR owns its own Prisma project/client, generated from
// prisma/hr/schema.prisma into src/generated/hr-client, reading HR_DATABASE_URL.
// This is a fully independent database/connection from Core's (see
// prisma.service.ts) — HR must never share Core's Prisma client, a migration
// history, or a physical foreign key with Core.
// Precedent: CorrespondencePrismaService (50-MOD-CORR), CmsPrismaService (33J),
// ObservabilityPrismaService (49M-2).
import { PrismaClient } from '../../../generated/hr-client';

/**
 * The HR database connection.
 *
 * IT DOES CONNECT EAGERLY, exactly like `PrismaService`, `CmsPrismaService` and
 * `CorrespondencePrismaService`. HR is a BUSINESS domain: if `hr_db` is
 * unreachable, personnel records cannot be read or written, so a process that
 * booted anyway would serve a surface where every request fails individually and
 * silently. Failing fast at boot is the honest behaviour.
 *
 * WHY HR DOES NOT REPLACE Core's `PrismaService`
 * ---------------------------------------------
 * `Employee.userId` holds a Core `"User".id`, but it is a PLAIN STRING and never a
 * foreign key: PostgreSQL cannot express a FK across databases, and HR must not try
 * to. Core identity is reached through `UserDirectoryContract`
 * (`src/platform/user-directory/`), which is an allowlisted read port — never a
 * join, never Core's schema, never Core's client.
 */
@Injectable()
export class HrPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
