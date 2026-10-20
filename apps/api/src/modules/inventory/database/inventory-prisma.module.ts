import { Module } from '@nestjs/common';
import { INVENTORY_PRISMA_CLIENT } from '../../../health/health-tokens';
import { InventoryPrismaService } from './inventory-prisma.service';

/**
 * Phase W1: binds the Inventory Prisma client both as `InventoryPrismaService`
 * (the business handle) and under `INVENTORY_PRISMA_CLIENT` (the health-probe
 * token — binding the token is what activates the `inventory_db` probe, exactly
 * like `CommercePrismaModule` documents).
 */
@Module({
  providers: [
    InventoryPrismaService,
    { provide: INVENTORY_PRISMA_CLIENT, useExisting: InventoryPrismaService },
  ],
  exports: [InventoryPrismaService, INVENTORY_PRISMA_CLIENT],
})
export class InventoryPrismaModule {}
