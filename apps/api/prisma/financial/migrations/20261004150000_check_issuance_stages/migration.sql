-- Phase CHECK-ISSUATION: the five stage records + the process pin.
--
-- Produced from `prisma migrate diff --from-empty --to-schema-datamodel
-- prisma/financial/schema.prisma --script` (this machine, Prisma 5.x) and narrowed to
-- the delta this phase adds, so every constraint, index and column name is byte-for-byte
-- what Prisma generates — the same hand-off the F1 baseline documents.
--
-- WHAT IT CONTAINS:
--   1. the two decision enums (DocumentReviewDecision / ExecutiveDecision);
--   2. `process_key` / `process_version` on CheckRequest — the version PIN (brief §5);
--   3. `document_type` DROP NOT NULL on CheckAttachment — sections 6/7 have no type
--      picker in the source, so a NOT NULL there would force an invented vocabulary;
--   4. the five stage tables with tenant-composite FKs and one-row-per-stage uniques.
--
-- NO DATA BACKFILL BEYOND THE COLUMN DEFAULTS: the default pins every existing row to
-- v1 of the only published process — which is the truthful statement for rows that
-- predate the process declaration.

-- CreateEnum
CREATE TYPE "DocumentReviewDecision" AS ENUM ('APPROVE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "ExecutiveDecision" AS ENUM ('APPROVE', 'REJECT');

-- AlterTable: the process pin (brief §5 — every request states the version it ran under).
ALTER TABLE "CheckRequest" ADD COLUMN "process_key" VARCHAR(64) NOT NULL DEFAULT 'financial.check-issuance',
ADD COLUMN "process_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: sections 6/7 carry no «نوع سند» in the source; the upload SERVICE enforces
-- a type wherever the section's configuration declares one.
ALTER TABLE "CheckAttachment" ALTER COLUMN "document_type" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CheckAllocation" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "allocation_place" VARCHAR(500) NOT NULL,
    "balance" DECIMAL(18,0),
    "check_date" DATE,
    "check_description" VARCHAR(2000),
    "check_amount" DECIMAL(18,0) NOT NULL,
    "payable_to" VARCHAR(500),
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckDocumentReview" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "decision" "DocumentReviewDecision" NOT NULL,
    "comment" VARCHAR(2000),
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckDocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckExecutiveApproval" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "decision" "ExecutiveDecision" NOT NULL,
    "comment" VARCHAR(2000),
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckExecutiveApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIssue" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "issued_check_confirmed" BOOLEAN NOT NULL,
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckDelivery" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "delivery_completed" BOOLEAN NOT NULL,
    "recorded_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckAllocation_tenantId_id_key" ON "CheckAllocation"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckAllocation_tenantId_checkRequestId_key" ON "CheckAllocation"("tenant_id", "check_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckDocumentReview_tenantId_id_key" ON "CheckDocumentReview"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckDocumentReview_tenantId_checkRequestId_key" ON "CheckDocumentReview"("tenant_id", "check_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckExecutiveApproval_tenantId_id_key" ON "CheckExecutiveApproval"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckExecutiveApproval_tenantId_checkRequestId_key" ON "CheckExecutiveApproval"("tenant_id", "check_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIssue_tenantId_id_key" ON "CheckIssue"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIssue_tenantId_checkRequestId_key" ON "CheckIssue"("tenant_id", "check_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckDelivery_tenantId_id_key" ON "CheckDelivery"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckDelivery_tenantId_checkRequestId_key" ON "CheckDelivery"("tenant_id", "check_request_id");

-- AddForeignKey
ALTER TABLE "CheckAllocation" ADD CONSTRAINT "CheckAllocation_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckDocumentReview" ADD CONSTRAINT "CheckDocumentReview_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckExecutiveApproval" ADD CONSTRAINT "CheckExecutiveApproval_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIssue" ADD CONSTRAINT "CheckIssue_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckDelivery" ADD CONSTRAINT "CheckDelivery_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

