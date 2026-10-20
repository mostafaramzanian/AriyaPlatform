import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: Inventory owns its own Prisma
// project/client, generated from prisma/inventory/schema.prisma into
// src/generated/inventory-client, reading INVENTORY_DATABASE_URL. Independent
// of every other owner's database — Inventory must never share another
// owner's Prisma client, migration history, or physical foreign key.
// Precedent: FinancialPrismaService (Phase F1).
import { PrismaClient } from '../../../generated/inventory-client';

/**
 * The Inventory database connection — the ONLY persistence handle for
 * `inventory_db`. Eager connect, exactly like every other business datasource:
 * if `inventory_db` is unreachable, stock cannot be read or posted and booting
 * anyway would serve a surface where every request fails silently.
 *
 * `tenantId`, `recordedByUserId` and `sourceType`/`sourceId` are PLAIN STRINGS,
 * never foreign keys across databases: PostgreSQL cannot express a FK across
 * databases and Inventory must not try to.
 */
@Injectable()
export class InventoryPrismaService
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
