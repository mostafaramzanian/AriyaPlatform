import { Module } from '@nestjs/common';
import { PlatformAuditModule } from '../../platform/audit/platform-audit.module';
import { PlatformEntitlementModule } from '../../platform/entitlement/platform-entitlement.module';
import { ModuleEntitlementGuard } from '../../platform/entitlement/module-entitlement.guard';
import { InventoryPrismaModule } from './database/inventory-prisma.module';
import { InventoryUnitOfWork } from './database/inventory-transaction';
import { InventoryAuditGateway } from './inventory-audit.gateway';
import { WarehouseController } from './warehouse/warehouse.controller';
import { WarehouseService } from './warehouse/warehouse.service';
import { WarehouseRepository } from './warehouse/warehouse.repository';
import { ItemController } from './item/item.controller';
import { ItemService } from './item/item.service';
import { ItemRepository } from './item/item.repository';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';
import { StockRepository } from './stock/stock.repository';
import { InventoryPostingFacade } from './integration/inventory-posting.facade';

/**
 * Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: the Inventory bounded context.
 *
 * Its own database (`inventory_db`), its own Prisma client, its own unit of
 * work, its own audit gateway — the same ownership shape every other business
 * module carries. Cross-module references (a Commerce receipt, a purchase
 * document) are opaque `sourceType`/`sourceId` strings by design: no
 * cross-database foreign key exists and none is invented here.
 */
@Module({
  imports: [InventoryPrismaModule, PlatformAuditModule, PlatformEntitlementModule],

  controllers: [WarehouseController, ItemController, StockController],
  providers: [
    // The entitlement gate, provided where Nest instantiates it. The
    // DECLARATION is on the controllers; this is what makes it enforceable.
    ModuleEntitlementGuard,
    InventoryUnitOfWork,
    InventoryAuditGateway,
    WarehouseService,
    WarehouseRepository,
    ItemService,
    ItemRepository,
    StockService,
    StockRepository,
    // Phase W2-B: the narrow cross-context seam Commerce binds against —
    // `INVENTORY_POSTING_PORT`. Exported so CommerceModule can `useExisting`
    // it; nothing here grants Commerce any access to repositories or Prisma.
    InventoryPostingFacade,
  ],
  exports: [StockService, InventoryPrismaModule, InventoryPostingFacade],
})
export class InventoryModule {}
