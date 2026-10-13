-- Phase C1 Step Q: append-only payment history (§5.14, §I16, contract §5).
-- Generated with `prisma migrate diff --from-url <commerce_db>
-- --to-schema-datamodel prisma/commerce/schema.prisma --script`, inspected by
-- hand (no DROP / TRUNCATE / DELETE, no other owner's names, every index and
-- both foreign keys tenant-leading), then `prisma validate`, `prisma generate`
-- and `prisma migrate status` before the suite runs. ADDITIVE ONLY: ONE enum
-- and ONE table — no existing table is rewritten, no data is touched, and the
-- 20260929000001 migration stays exactly as it was applied.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'PETTY_CASH', 'CHECK');

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3),
    "method" "PaymentMethod" NOT NULL,
    "payment_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payer_ref" VARCHAR(128),
    "payee_ref" VARCHAR(128),
    "invoice_ref" VARCHAR(128),
    "external_reference" VARCHAR(128),
    "reverses_payment_id" UUID,
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_tenant_id_id_key" ON "PaymentRecord"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_tenant_id_reverses_payment_id_key" ON "PaymentRecord"("tenant_id", "reverses_payment_id");

-- CreateIndex
CREATE INDEX "PaymentRecord_tenant_id_purchase_document_id_created_at_idx" ON "PaymentRecord"("tenant_id", "purchase_document_id", "created_at");

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenant_id_reverses_payment_id_fkey" FOREIGN KEY ("tenant_id", "reverses_payment_id") REFERENCES "PaymentRecord"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
