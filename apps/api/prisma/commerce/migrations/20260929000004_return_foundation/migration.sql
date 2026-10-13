-- Phase C1 Step S: the append-only return child lifecycle (§5.17, contract
-- S-D1..S-D5, §6, §14).
--
-- Generated with `prisma migrate diff --from-schema-datamodel <pre-S schema>
-- --to-schema-datamodel prisma/commerce/schema.prisma --script`, then INSPECTED
-- by hand: no DROP / TRUNCATE / DELETE, no ALTER of any existing table (the
-- three virtual back-relations on PurchaseDocument / PurchaseLine / ReceiptLine
-- produce NO DDL — R's and Q's tables stay byte-for-byte as applied), no
-- other owner's names, no cross-database reference. ADDITIVE ONLY: ONE enum
-- and THREE tables — ReturnDocument, ReturnLine, ReturnLifecycleTransition —
-- with every index leading `tenant_id`, every foreign key composite
-- `(tenant_id, <fk>) -> parent(tenant_id, id)`, and ON DELETE / ON UPDATE both
-- RESTRICT (§14: lifecycle rows are never cascade-deleted, and an id a
-- lifecycle points at is never rewritten).
--
-- HAND-ADDED, DELIBERATELY (§14): the `CHECK ("quantity" > 0)` on ReturnLine.
-- Prisma cannot express a CHECK in the schema, but §14 requires the strongest
-- construct the engine offers for S-D1's positivity half at the database
-- level (the cumulative cap itself is cross-row and needs §9's serialization
-- boundary plus the §13 tests). A future `migrate diff` against the live
-- database may propose dropping this CHECK as schema drift — the same
-- recorded-drift posture R's migration documents for PaymentRecord's default —
-- and, like that one, it is not this step's to reconcile.
--
-- NOT CREATED HERE (each refusal recorded by contract §6): no
-- ReturnDocument.status/state column, no updatedAt on any of the three tables,
-- no number/series/counter/RMA, no warehouse/stock/financial column, no
-- many-to-many ReturnLine<->ReceiptLine bridge, no Commerce audit table.

-- CreateEnum
CREATE TYPE "ReturnState" AS ENUM ('REQUESTED', 'APPROVED', 'RECEIVED_BACK', 'REFUNDED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReturnDocument" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "requested_by_user_id" TEXT,
    "reason" TEXT NOT NULL,
    "replacement_required" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnLine" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "return_document_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnLine_pkey" PRIMARY KEY ("id"),

    -- S-D1's positivity half, stated where no application code can bypass it:
    -- a return line may never carry a zero or negative quantity.
    CONSTRAINT "ReturnLine_quantity_positive_check" CHECK ("quantity" > 0)
);

-- CreateTable
CREATE TABLE "ReturnLifecycleTransition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "return_document_id" UUID NOT NULL,
    "state" "ReturnState" NOT NULL,
    "actor_user_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnLifecycleTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnDocument_tenant_id_purchase_document_id_created_at_idx" ON "ReturnDocument"("tenant_id", "purchase_document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnDocument_tenant_id_id_key" ON "ReturnDocument"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ReturnLine_tenant_id_return_document_id_idx" ON "ReturnLine"("tenant_id", "return_document_id");

-- CreateIndex
CREATE INDEX "ReturnLine_tenant_id_receipt_line_id_idx" ON "ReturnLine"("tenant_id", "receipt_line_id");

-- CreateIndex
CREATE INDEX "ReturnLine_tenant_id_purchase_line_id_idx" ON "ReturnLine"("tenant_id", "purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLine_tenant_id_id_key" ON "ReturnLine"("tenant_id", "id");

-- CreateIndex (name shortened to fit PostgreSQL's 63-byte identifier cap;
-- the COLUMNS are exactly contract §6's `(tenant_id, return_document_id, created_at)`)
CREATE INDEX "ReturnTransition_tenant_id_return_document_id_created_at_idx" ON "ReturnLifecycleTransition"("tenant_id", "return_document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLifecycleTransition_tenant_id_id_key" ON "ReturnLifecycleTransition"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "ReturnDocument" ADD CONSTRAINT "ReturnDocument_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenant_id_return_document_id_fkey" FOREIGN KEY ("tenant_id", "return_document_id") REFERENCES "ReturnDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenant_id_purchase_line_id_fkey" FOREIGN KEY ("tenant_id", "purchase_line_id") REFERENCES "PurchaseLine"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenant_id_receipt_line_id_fkey" FOREIGN KEY ("tenant_id", "receipt_line_id") REFERENCES "ReceiptLine"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLifecycleTransition" ADD CONSTRAINT "ReturnLifecycleTransition_tenant_id_return_document_id_fkey" FOREIGN KEY ("tenant_id", "return_document_id") REFERENCES "ReturnDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
