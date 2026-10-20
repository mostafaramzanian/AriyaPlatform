-- SUPPLIER MASTER DATA (procurement requirements, "module 7": بانک اطلاعات
-- تأمین‌کنندگان) — the supplier directory the business requirements name: a
-- reusable, tenant-scoped register of sellers with identity, contact and
-- banking facts, selectable from purchase and quotation entry and reportable
-- on its own.
--
-- WHY THIS MIGRATION EXISTS AT ALL: before it, a "supplier" was a free-text
-- `supplierLabel` on a quotation and an opaque string on a purchase document —
-- no reuse, no history, no duplicate control, and banking details nowhere to
-- keep safely. The requirements require a directory with exact-identity
-- duplicate prevention and restricted banking access.
--
-- ADDITIVE ONLY, in the style of 20261017000000_price_quotation: TWO new enum
-- types, ONE new table, THREE new indexes on it, ONE nullable column added to
-- `PriceQuotation` and ONE index on that column. No existing table is rewritten,
-- no data is touched, no DROP / TRUNCATE / DELETE / ALTER COLUMN / RENAME, no
-- other owner's names, no cross-database reference. `Supplier` deliberately
-- declares NO foreign keys — every reference to it (purchase documents'
-- `supplier_id`, quotations' new `supplier_id`) keeps the C1 header's
-- opaque-string convention, and the service answers referential questions with
-- a tenant-scoped existence check.
--
-- The new column on `PriceQuotation` is NULLABLE (the C4 provenance rule): a
-- quotation recorded before this migration, or one whose seller is not (yet) a
-- directory row, simply carries NULL — nothing historical is rewritten.
--
-- Verified with `prisma generate` against the extended schema before this file
-- was written; apply with `prisma migrate deploy --schema=prisma/commerce/schema.prisma`.

-- CreateEnum
CREATE TYPE "SupplierEntityType" AS ENUM ('INDIVIDUAL', 'LEGAL');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "entity_type" "SupplierEntityType" NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "company_name" VARCHAR(255),
    "national_code" VARCHAR(10),
    "sheba_number" VARCHAR(26),
    "card_number" VARCHAR(16),
    "bank_name" VARCHAR(128),
    "address" VARCHAR(1000),
    "phone" VARCHAR(32),
    "email" VARCHAR(255),
    "notes" VARCHAR(2000),
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenant_id_id_key" ON "Supplier"("tenant_id", "id");

-- CreateIndex
-- ONE supplier per national code per tenant — the structural duplicate
-- refusal; NULLs do not collide (PostgreSQL's default NULLS DISTINCT).
CREATE UNIQUE INDEX "Supplier_tenant_id_national_code_key" ON "Supplier"("tenant_id", "national_code");

-- CreateIndex
CREATE INDEX "Supplier_tenant_id_status_name_idx" ON "Supplier"("tenant_id", "status", "name");

-- AlterTable
ALTER TABLE "PriceQuotation" ADD COLUMN "supplier_id" UUID;

-- CreateIndex
CREATE INDEX "PriceQuotation_tenant_id_supplier_id_idx" ON "PriceQuotation"("tenant_id", "supplier_id");
