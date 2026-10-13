-- Phase C1 Step R: append-only receiving history (§5.16, contract R1–R10).
-- Generated with `prisma migrate diff --from-url <commerce_db>
-- --to-schema-datamodel prisma/commerce/schema.prisma --script`, inspected by
-- hand (no DROP / TRUNCATE / DELETE, no other owner's names, every index and
-- all four foreign keys tenant-leading), then `prisma validate`, `prisma
-- generate` and `prisma migrate status` before the suite runs. ADDITIVE ONLY:
-- TWO tables — no existing table is rewritten, no data is touched, and the
-- 20260929000002 migration stays exactly as it was applied.
--
-- NOTE, DELIBERATELY EXCLUDED: the raw diff also proposed
-- `ALTER TABLE "PaymentRecord" ALTER COLUMN "id" DROP DEFAULT;` — pre-existing
-- drift between the applied Q migration and the schema, NOT introduced by R
-- and NOT R's to repair. This migration touches only Receipt/ReceiptLine.

-- CreateTable
CREATE TABLE "Receipt" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiver_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptLine" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receipt_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "reverses_receipt_line_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Receipt_tenant_id_purchase_document_id_created_at_idx" ON "Receipt"("tenant_id", "purchase_document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_tenant_id_id_key" ON "Receipt"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "ReceiptLine_tenant_id_receipt_id_idx" ON "ReceiptLine"("tenant_id", "receipt_id");

-- CreateIndex
CREATE INDEX "ReceiptLine_tenant_id_purchase_line_id_idx" ON "ReceiptLine"("tenant_id", "purchase_line_id");

-- CreateIndex
CREATE INDEX "ReceiptLine_tenant_id_reverses_receipt_line_id_idx" ON "ReceiptLine"("tenant_id", "reverses_receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptLine_tenant_id_id_key" ON "ReceiptLine"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_tenant_id_receipt_id_fkey" FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "Receipt"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_tenant_id_purchase_line_id_fkey" FOREIGN KEY ("tenant_id", "purchase_line_id") REFERENCES "PurchaseLine"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptLine" ADD CONSTRAINT "ReceiptLine_tenant_id_reverses_receipt_line_id_fkey" FOREIGN KEY ("tenant_id", "reverses_receipt_line_id") REFERENCES "ReceiptLine"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
