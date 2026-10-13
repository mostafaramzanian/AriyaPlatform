-- Phase F1 — FINANCIAL FOUNDATION: the finance_db baseline.
--
-- Produced by `prisma migrate diff --from-empty --to-schema-datamodel
-- prisma/financial/schema.prisma --script`, so the SQL is exactly what the schema
-- declares, and committed as this project's first migration — the same hand-off
-- every owner went through: schema lands, migration lands, `migrate deploy`
-- applies it to the operator-created `finance_db`.
--
-- OWNERSHIP: finance_db via FINANCE_DATABASE_URL. No cross-database foreign key
-- exists here: every reference is either the tenant-first key INSIDE this database
-- (CheckAttachment -> CheckRequest(tenant_id, id)) or an opaque string pointing at
-- a context this one may not read.

-- CreateEnum
CREATE TYPE "CheckIssueType" AS ENUM ('PURCHASE', 'PETTY_CASH', 'SALARY');

-- CreateEnum
CREATE TYPE "CheckPurchaseType" AS ENUM ('PROJECT', 'NON_PROJECT');

-- CreateEnum
CREATE TYPE "ManagerDecision" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CORRECTION');

-- CreateEnum
CREATE TYPE "RequesterOpinion" AS ENUM ('CONTINUE', 'CANCEL');

-- CreateEnum
CREATE TYPE "CheckDocumentType" AS ENUM ('DASTOOR_PARDAKHT', 'PISH_FACTOR', 'GOVAHI_EZAFAT', 'KART_MELLI_TAMIN_KONANDE', 'SOORATGHALME', 'SOORATGHALME_KOMISION', 'SOORATGHALME_FAZ_BANDI', 'GARARDAD', 'FACTOOR_MAHAR', 'ENGLISH_FACTOR_TRANSLATION', 'OTHER');

-- CreateTable
CREATE TABLE "CheckRequest" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "check_issue_type" "CheckIssueType" NOT NULL,
    "purchase_type" "CheckPurchaseType",
    "order_reference" VARCHAR(128),
    "project_reference" VARCHAR(128),
    "project_manager_user_id" TEXT,
    "requester_user_id" TEXT NOT NULL,
    "request_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requester_opinion" "RequesterOpinion" NOT NULL DEFAULT 'CONTINUE',
    "status" INTEGER NOT NULL DEFAULT 0,
    "manager_decision" "ManagerDecision",
    "manager_comment" VARCHAR(2000),
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckAttachment" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "check_request_id" UUID NOT NULL,
    "section" INTEGER NOT NULL DEFAULT 2,
    "document_type" "CheckDocumentType" NOT NULL,
    "description" VARCHAR(1000),
    "storage_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128) NOT NULL,
    "size" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CheckAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckRequest_tenantId_status_updatedAt_idx" ON "CheckRequest"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "CheckRequest_tenantId_requesterUserId_status_idx" ON "CheckRequest"("tenant_id", "requester_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CheckRequest_tenantId_id_key" ON "CheckRequest"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "CheckAttachment_tenantId_checkRequestId_createdAt_idx" ON "CheckAttachment"("tenant_id", "check_request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "CheckAttachment_tenantId_id_key" ON "CheckAttachment"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "CheckAttachment" ADD CONSTRAINT "CheckAttachment_tenant_id_check_request_id_fkey" FOREIGN KEY ("tenant_id", "check_request_id") REFERENCES "CheckRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

