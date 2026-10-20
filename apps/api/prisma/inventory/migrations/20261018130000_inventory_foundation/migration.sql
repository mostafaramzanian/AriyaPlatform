-- WAREHOUSE / INVENTORY FOUNDATION (Phase W1): initial inventory_db schema.
-- Purely additive on a fresh database: warehouses, locations, items, item units,
-- the append-only stock ledger, derived balances, transfers, issues, adjustments
-- and stock counts. No existing table is touched.

-- CreateEnum
CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "LocationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('STOCKED', 'NON_STOCKED', 'SERVICE');

-- CreateEnum
CREATE TYPE "ItemTrackingMode" AS ENUM ('NONE', 'LOT', 'SERIAL');

-- CreateEnum
CREATE TYPE "InventoryItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_TO_STOCK', 'SUPPLIER_RETURN', 'ADJUSTMENT', 'COUNT_VARIANCE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockAdjustmentReason" AS ENUM ('DAMAGE', 'EXPIRY', 'LOSS', 'FOUND', 'CORRECTION', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'POSTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "inventory_warehouses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(256) NOT NULL,
    "description" VARCHAR(1000),
    "address" VARCHAR(500),
    "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_storage_locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(256),
    "status" "LocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(256) NOT NULL,
    "description" VARCHAR(2000),
    "itemType" "ItemType" NOT NULL,
    "baseUnit" VARCHAR(32) NOT NULL,
    "trackingMode" "ItemTrackingMode" NOT NULL DEFAULT 'NONE',
    "expiryTracked" BOOLEAN NOT NULL DEFAULT false,
    "status" "InventoryItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "ratioToBase" DECIMAL(18,6) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_item_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" VARCHAR(64) NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "lotNumber" VARCHAR(64),
    "serialNumber" VARCHAR(128),
    "expiryDate" TIMESTAMP(3),
    "sourceType" VARCHAR(64) NOT NULL,
    "sourceId" VARCHAR(64) NOT NULL,
    "reversesMovementId" TEXT,
    "note" VARCHAR(500),
    "recordedByUserId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_balances" (
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" VARCHAR(64) NOT NULL DEFAULT '',
    "onHand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "blocked" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_balances_pkey" PRIMARY KEY ("tenantId","itemId","warehouseId","locationId")
);

-- CreateTable
CREATE TABLE "inventory_stock_transfers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "lotNumber" VARCHAR(64),
    "serialNumber" VARCHAR(128),
    "fromWarehouseId" TEXT NOT NULL,
    "fromLocationId" VARCHAR(64) NOT NULL DEFAULT '',
    "toWarehouseId" TEXT NOT NULL,
    "toLocationId" VARCHAR(64) NOT NULL DEFAULT '',
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "note" VARCHAR(500),
    "createdByUserId" TEXT NOT NULL,
    "dispatchedByUserId" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedByUserId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_issues" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" VARCHAR(64) NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "issuedTo" VARCHAR(128) NOT NULL,
    "lotNumber" VARCHAR(64),
    "serialNumber" VARCHAR(128),
    "note" VARCHAR(500),
    "movementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_adjustments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" VARCHAR(64) NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "reason" "StockAdjustmentReason" NOT NULL,
    "note" VARCHAR(500),
    "lotNumber" VARCHAR(64),
    "serialNumber" VARCHAR(128),
    "movementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_counts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "note" VARCHAR(500),
    "createdByUserId" TEXT NOT NULL,
    "postedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "inventory_stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock_count_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" VARCHAR(64) NOT NULL DEFAULT '',
    "expectedQty" DECIMAL(18,4) NOT NULL,
    "countedQty" DECIMAL(18,4),
    "variance" DECIMAL(18,4),
    "movementId" TEXT,

    CONSTRAINT "inventory_stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_warehouses_tenantId_status_idx" ON "inventory_warehouses"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouses_tenantId_code_key" ON "inventory_warehouses"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_warehouses_tenantId_id_key" ON "inventory_warehouses"("tenantId", "id");

-- CreateIndex
CREATE INDEX "inventory_storage_locations_tenantId_warehouseId_status_idx" ON "inventory_storage_locations"("tenantId", "warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_storage_locations_tenantId_warehouseId_code_key" ON "inventory_storage_locations"("tenantId", "warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_storage_locations_tenantId_id_key" ON "inventory_storage_locations"("tenantId", "id");

-- CreateIndex
CREATE INDEX "inventory_items_tenantId_status_itemType_idx" ON "inventory_items"("tenantId", "status", "itemType");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_tenantId_sku_key" ON "inventory_items"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_tenantId_id_key" ON "inventory_items"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_units_tenantId_itemId_unit_key" ON "inventory_item_units"("tenantId", "itemId", "unit");

-- CreateIndex
CREATE INDEX "inventory_stock_movements_tenantId_itemId_warehouseId_poste_idx" ON "inventory_stock_movements"("tenantId", "itemId", "warehouseId", "postedAt");

-- CreateIndex
CREATE INDEX "inventory_stock_movements_tenantId_warehouseId_postedAt_idx" ON "inventory_stock_movements"("tenantId", "warehouseId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_tenantId_sourceType_sourceId_kind_key" ON "inventory_stock_movements"("tenantId", "sourceType", "sourceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_tenantId_reversesMovementId_key" ON "inventory_stock_movements"("tenantId", "reversesMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_tenantId_id_key" ON "inventory_stock_movements"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_movements_tenantId_itemId_serialNumber_key" ON "inventory_stock_movements"("tenantId", "itemId", "serialNumber");

-- CreateIndex
CREATE INDEX "inventory_stock_balances_tenantId_warehouseId_idx" ON "inventory_stock_balances"("tenantId", "warehouseId");

-- CreateIndex
CREATE INDEX "inventory_stock_balances_tenantId_itemId_idx" ON "inventory_stock_balances"("tenantId", "itemId");

-- CreateIndex
CREATE INDEX "inventory_stock_transfers_tenantId_status_idx" ON "inventory_stock_transfers"("tenantId", "status");

-- CreateIndex
CREATE INDEX "inventory_stock_transfers_tenantId_fromWarehouseId_status_idx" ON "inventory_stock_transfers"("tenantId", "fromWarehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_transfers_tenantId_id_key" ON "inventory_stock_transfers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "inventory_stock_issues_tenantId_warehouseId_createdAt_idx" ON "inventory_stock_issues"("tenantId", "warehouseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_issues_tenantId_id_key" ON "inventory_stock_issues"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_issues_tenantId_movementId_key" ON "inventory_stock_issues"("tenantId", "movementId");

-- CreateIndex
CREATE INDEX "inventory_stock_adjustments_tenantId_warehouseId_createdAt_idx" ON "inventory_stock_adjustments"("tenantId", "warehouseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_adjustments_tenantId_id_key" ON "inventory_stock_adjustments"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_adjustments_tenantId_movementId_key" ON "inventory_stock_adjustments"("tenantId", "movementId");

-- CreateIndex
CREATE INDEX "inventory_stock_counts_tenantId_warehouseId_status_idx" ON "inventory_stock_counts"("tenantId", "warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_counts_tenantId_id_key" ON "inventory_stock_counts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_count_lines_tenantId_countId_itemId_locatio_key" ON "inventory_stock_count_lines"("tenantId", "countId", "itemId", "locationId");

-- AddForeignKey
ALTER TABLE "inventory_storage_locations" ADD CONSTRAINT "inventory_storage_locations_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_units" ADD CONSTRAINT "inventory_item_units_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_movements" ADD CONSTRAINT "inventory_stock_movements_tenantId_reversesMovementId_fkey" FOREIGN KEY ("tenantId", "reversesMovementId") REFERENCES "inventory_stock_movements"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_balances" ADD CONSTRAINT "inventory_stock_balances_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_balances" ADD CONSTRAINT "inventory_stock_balances_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_transfers" ADD CONSTRAINT "inventory_stock_transfers_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_transfers" ADD CONSTRAINT "inventory_stock_transfers_tenantId_fromWarehouseId_fkey" FOREIGN KEY ("tenantId", "fromWarehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_transfers" ADD CONSTRAINT "inventory_stock_transfers_tenantId_toWarehouseId_fkey" FOREIGN KEY ("tenantId", "toWarehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_issues" ADD CONSTRAINT "inventory_stock_issues_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_issues" ADD CONSTRAINT "inventory_stock_issues_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_adjustments" ADD CONSTRAINT "inventory_stock_adjustments_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_adjustments" ADD CONSTRAINT "inventory_stock_adjustments_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_counts" ADD CONSTRAINT "inventory_stock_counts_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "inventory_warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_count_lines" ADD CONSTRAINT "inventory_stock_count_lines_tenantId_countId_fkey" FOREIGN KEY ("tenantId", "countId") REFERENCES "inventory_stock_counts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_stock_count_lines" ADD CONSTRAINT "inventory_stock_count_lines_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

