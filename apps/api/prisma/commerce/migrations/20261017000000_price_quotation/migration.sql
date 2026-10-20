-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'RETURNED');

-- CreateTable
CREATE TABLE "PriceQuotation" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "supplier_label" VARCHAR(255),
    "quote_reference" VARCHAR(128),
    "quote_date" DATE,
    "currency" VARCHAR(3),
    "total_amount" DECIMAL(18,4),
    "attachment_ref" TEXT,
    "notes" TEXT,
    "status" "QuotationStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_user_id" TEXT NOT NULL,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PriceQuotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationLine" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "line_total" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuotationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceQuotation_tenant_document_status_idx" ON "PriceQuotation"("tenant_id", "purchase_document_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PriceQuotation_tenant_id_id_key" ON "PriceQuotation"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PriceQuotation_tenant_document_version_key" ON "PriceQuotation"("tenant_id", "purchase_document_id", "version");

-- CreateIndex
CREATE INDEX "QuotationLine_tenant_quotation_id_idx" ON "QuotationLine"("tenant_id", "quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationLine_tenant_id_id_key" ON "QuotationLine"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationLine_tenant_quotation_line_key" ON "QuotationLine"("tenant_id", "quotation_id", "line_number");

-- AddForeignKey
ALTER TABLE "PriceQuotation" ADD CONSTRAINT "PriceQuotation_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_tenant_id_quotation_id_fkey" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "PriceQuotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

