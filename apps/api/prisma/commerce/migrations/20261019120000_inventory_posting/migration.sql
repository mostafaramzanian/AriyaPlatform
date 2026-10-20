-- COMMERCE → INVENTORY INTEGRATION RECORD: the durable at-least-once record
-- that joins Commerce's append-only receiving/return history to Inventory's
-- append-only stock ledger. Written in the same transaction as the receipt or
-- return evidence it was planned from; attempted after that commit; retried
-- through the integration surface — because no transaction spans the two
-- databases, "receipt committed, posting unknown" must be a stored, visible,
-- retryable state rather than a lost exception.
--
-- ADDITIVE ONLY: ONE new enum type, ONE new table, FOUR new indexes. No
-- existing table is rewritten, no data is touched, no DROP / TRUNCATE /
-- DELETE / RENAME, no ALTER COLUMN, no other owner's names.

-- CreateEnum
CREATE TYPE "InventoryPostingStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED');

-- CreateTable
CREATE TABLE "InventoryPosting" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "source_line_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "item_ref" TEXT NOT NULL,
    "item_id" UUID,
    "warehouse_id" UUID NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32) NOT NULL,
    "status" "InventoryPostingStatus" NOT NULL DEFAULT 'PENDING',
    "movement_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InventoryPosting_pkey" PRIMARY KEY ("id")
);

-- UniqueIndex: one business line posts at most once.
CREATE UNIQUE INDEX "InventoryPosting_tenant_id_kind_source_line_id_key" ON "InventoryPosting"("tenant_id", "kind", "source_line_id");

-- Index: the operational queue read — pending and failed postings.
CREATE INDEX "InventoryPosting_tenant_id_status_created_at_idx" ON "InventoryPosting"("tenant_id", "status", "created_at");

-- Index: the per-purchase-line posting read — reconciliation.
CREATE INDEX "InventoryPosting_tenant_id_purchase_line_id_idx" ON "InventoryPosting"("tenant_id", "purchase_line_id");

-- Index: the origin lookup for compensations and dispatched returns.
CREATE INDEX "InventoryPosting_tenant_id_source_line_id_idx" ON "InventoryPosting"("tenant_id", "source_line_id");
