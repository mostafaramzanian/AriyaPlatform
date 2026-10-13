-- Phase C1 Step P: the commercial foundation (contract §6 — minimum set only).
-- Generated with `prisma migrate diff --from-url <commerce_db>
-- --to-schema-datamodel prisma/commerce/schema.prisma --script`, inspected,
-- and applied with `prisma migrate deploy`. ADDITIVE ONLY: eight new types,
-- five new tables, one nullable pin column, indexes and RESTRICT foreign keys.

-- CreateEnum
CREATE TYPE "CommercialAssignmentState" AS ENUM ('ASSIGNED', 'UNASSIGNED');

-- CreateEnum
CREATE TYPE "CommercialAssignmentSource" AS ENUM ('PURCHASE_SUBMITTED', 'AFTER_DOCUMENT_WORKFLOW_APPROVED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CommercialApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CommercialApprovalActivation" AS ENUM ('NOT_REQUIRED', 'PURCHASE_SUBMITTED', 'AFTER_DOCUMENT_WORKFLOW_APPROVED');

-- CreateEnum
CREATE TYPE "CommercialApprovalApprover" AS ENUM ('LINE_COMMERCIAL_LIAISON', 'CONFIGURED_USER');

-- CreateEnum
CREATE TYPE "CommercialProjectionPolicy" AS ENUM ('DOCUMENT_WORKFLOW', 'ALL_LINES', 'DOCUMENT_WORKFLOW_AND_COMMERCIAL', 'ALL_LINES_AND_COMMERCIAL');

-- CreateEnum
CREATE TYPE "CommercialNoAssignmentBehavior" AS ENUM ('REJECT_OPERATION', 'LEAVE_UNASSIGNED');

-- CreateEnum
CREATE TYPE "CommercialMatchBehavior" AS ENUM ('HIGHEST_PRIORITY', 'AMBIGUOUS_ERROR');

-- AlterTable
ALTER TABLE "PurchaseDocument" ADD COLUMN     "commercial_configuration_version_id" UUID;

-- CreateTable
CREATE TABLE "CommercialGroup" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "liaison_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CommercialGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialConfigurationVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "WorkflowDefinitionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "version_label" VARCHAR(64) NOT NULL,
    "assignment_trigger" "WorkflowTriggerEvent" NOT NULL,
    "no_assignment_behavior" "CommercialNoAssignmentBehavior" NOT NULL,
    "match_behavior" "CommercialMatchBehavior" NOT NULL,
    "assignment_rules" JSONB NOT NULL,
    "approval_activation" "CommercialApprovalActivation" NOT NULL,
    "approval_approver" "CommercialApprovalApprover",
    "approver_user_id" TEXT,
    "applicability_condition" JSONB,
    "projection_policy" "CommercialProjectionPolicy" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CommercialConfigurationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialAssignment" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "commercial_group_id" UUID,
    "status" "CommercialAssignmentState" NOT NULL,
    "source" "CommercialAssignmentSource" NOT NULL,
    "resolved_user_id" TEXT,
    "configuration_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CommercialAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialAssignmentHistory" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "commercial_group_id" UUID,
    "status" "CommercialAssignmentState" NOT NULL,
    "source" "CommercialAssignmentSource" NOT NULL,
    "resolved_user_id" TEXT,
    "configuration_version_id" UUID,
    "actor_user_id" TEXT,
    "reason" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommercialAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialApproval" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "status" "CommercialApprovalState" NOT NULL DEFAULT 'PENDING',
    "approver" "CommercialApprovalApprover" NOT NULL,
    "approver_user_id" TEXT NOT NULL,
    "applicability_result" BOOLEAN,
    "configuration_version_id" UUID NOT NULL,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CommercialApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommercialGroup_tenantId_idx" ON "CommercialGroup"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialGroup_tenantId_id_key" ON "CommercialGroup"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialGroup_tenantId_code_key" ON "CommercialGroup"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "CommercialConfigurationVersion_tenantId_status_idx" ON "CommercialConfigurationVersion"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialConfigurationVersion_tenantId_id_key" ON "CommercialConfigurationVersion"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialConfigurationVersion_tenantId_versionLabel_key" ON "CommercialConfigurationVersion"("tenant_id", "version_label");

-- CreateIndex
CREATE INDEX "CommercialAssignment_tenantId_purchaseDocumentId_idx" ON "CommercialAssignment"("tenant_id", "purchase_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialAssignment_tenantId_purchaseLineId_key" ON "CommercialAssignment"("tenant_id", "purchase_line_id");

-- CreateIndex
CREATE INDEX "CommercialAssignmentHistory_tenantId_lineId_changedAt_idx" ON "CommercialAssignmentHistory"("tenant_id", "purchase_line_id", "changed_at");

-- CreateIndex
CREATE INDEX "CommercialApproval_tenantId_status_idx" ON "CommercialApproval"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "CommercialApproval_tenantId_purchaseDocumentId_idx" ON "CommercialApproval"("tenant_id", "purchase_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialApproval_tenantId_id_key" ON "CommercialApproval"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommercialApproval_tenantId_purchaseLineId_key" ON "CommercialApproval"("tenant_id", "purchase_line_id");

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_tenant_id_commercial_configuration_versio_fkey" FOREIGN KEY ("tenant_id", "commercial_configuration_version_id") REFERENCES "CommercialConfigurationVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialAssignment" ADD CONSTRAINT "CommercialAssignment_tenant_id_commercial_group_id_fkey" FOREIGN KEY ("tenant_id", "commercial_group_id") REFERENCES "CommercialGroup"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialAssignment" ADD CONSTRAINT "CommercialAssignment_tenant_id_configuration_version_id_fkey" FOREIGN KEY ("tenant_id", "configuration_version_id") REFERENCES "CommercialConfigurationVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialAssignmentHistory" ADD CONSTRAINT "CommercialAssignmentHistory_tenant_id_commercial_group_id_fkey" FOREIGN KEY ("tenant_id", "commercial_group_id") REFERENCES "CommercialGroup"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialAssignmentHistory" ADD CONSTRAINT "CommercialAssignmentHistory_tenant_id_configuration_versio_fkey" FOREIGN KEY ("tenant_id", "configuration_version_id") REFERENCES "CommercialConfigurationVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommercialApproval" ADD CONSTRAINT "CommercialApproval_tenant_id_configuration_version_id_fkey" FOREIGN KEY ("tenant_id", "configuration_version_id") REFERENCES "CommercialConfigurationVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

