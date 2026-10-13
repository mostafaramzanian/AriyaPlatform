import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase F1 — FINANCIAL FOUNDATION: Financial owns its own Prisma project/client,
// generated from prisma/financial/schema.prisma into src/generated/financial-client,
// reading FINANCE_DATABASE_URL. This is a fully independent database/connection from
// Core's, HR's, Commerce's, Correspondence's and Production's — Financial must never
// share another owner's Prisma client, a migration history, or a physical foreign key
// with any of them.
// Precedent: ProductionPrismaService (PRODUCTION-BOM-HEADER), CommercePrismaService
// (Phase C1), HrPrismaService (51-HR-1), CorrespondencePrismaService (50-MOD-CORR),
// CmsPrismaService (33J), ObservabilityPrismaService (49M-2).
import { PrismaClient } from '../../../generated/financial-client';

/**
 * The Financial database connection.
 *
 * IT DOES CONNECT EAGERLY, exactly like `PrismaService`, `HrPrismaService`,
 * `CommercePrismaService` and `ProductionPrismaService`. Financial is a BUSINESS domain:
 * if `finance_db` is unreachable, check requests cannot be read or written, so a process
 * that booted anyway would serve a surface where every request fails individually and
 * silently. Failing fast at boot is the honest behaviour.
 *
 * THE ONLY PERSISTENCE HANDLE FOR `finance_db`. Controllers and services under
 * `src/modules/financial/**` reach this database through the repositories that are given
 * THIS service — never by constructing their own `PrismaClient`, never through Core's
 * `PrismaModule`, never through HR's, Commerce's, Correspondence's or Production's.
 *
 * WHY FINANCIAL DOES NOT REUSE ANOTHER OWNER'S PRISMA SERVICE
 * ----------------------------------------------------------
 * `tenantId`, `requesterUserId`, `projectManagerUserId`, `projectReference`,
 * `orderReference` and `decidedByUserId` are PLAIN STRINGS and never foreign keys across
 * databases: PostgreSQL cannot express a FK across databases, and Financial must not try
 * to. There is no Project table and no Purchase Order table anywhere in this repository,
 * so those two references have nothing to point at even inside a single database;
 * identity is reached through the platform user-directory contract — never through a
 * join, never through another owner's schema, never through another owner's client.
 */
@Injectable()
export class FinancialPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
