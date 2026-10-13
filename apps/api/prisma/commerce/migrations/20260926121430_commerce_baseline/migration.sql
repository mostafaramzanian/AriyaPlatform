-- CreateEnum
CREATE TYPE "PurchaseLineType" AS ENUM ('STANDARD', 'NON_STANDARD', 'SERVICE');

-- CreateEnum
CREATE TYPE "PurchaseDocumentKind" AS ENUM ('PURCHASE_REQUEST');

-- CreateEnum
CREATE TYPE "PurchaseDocumentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WorkflowDefinitionVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowStepExecutionMode" AS ENUM ('SEQUENTIAL', 'PARALLEL', 'CONDITIONAL');

-- CreateEnum
CREATE TYPE "WorkflowActorSource" AS ENUM ('REQUESTER_MANAGER', 'GROUP_MANAGER', 'COMMERCIAL_LIAISON', 'CONFIGURED_USER', 'CONFIGURED_ROLE', 'RULE_RESOLVER');

-- CreateEnum
CREATE TYPE "WorkflowSubjectType" AS ENUM ('PURCHASE_DOCUMENT', 'PURCHASE_LINE');

-- CreateEnum
CREATE TYPE "WorkflowInstanceStatus" AS ENUM ('RUNNING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WorkflowScopeType" AS ENUM ('DOCUMENT', 'LINE');

-- CreateEnum
CREATE TYPE "WorkflowStepInstanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'DELEGATED');

-- CreateEnum
CREATE TYPE "WorkflowStepDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "PurchaseDocument" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "document_number" VARCHAR(64) NOT NULL,
    "kind" "PurchaseDocumentKind" NOT NULL DEFAULT 'PURCHASE_REQUEST',
    "status" "PurchaseDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "requester_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "currency" VARCHAR(3),
    "subtotal_amount" DECIMAL(18,4),
    "tax_amount" DECIMAL(18,4),
    "total_amount" DECIMAL(18,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PurchaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseLine" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "line_type" "PurchaseLineType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(32),
    "unit_price" DECIMAL(18,4),
    "tax" DECIMAL(18,4),
    "line_total" DECIMAL(18,4),
    "external_ref" VARCHAR(128),
    "item_reference" TEXT,
    "technical_description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDefinitionVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "workflow_definition_id" UUID NOT NULL,
    "version_label" VARCHAR(64) NOT NULL,
    "status" "WorkflowDefinitionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowDefinitionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "workflow_definition_version_id" UUID NOT NULL,
    "step_key" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "execution_mode" "WorkflowStepExecutionMode" NOT NULL DEFAULT 'SEQUENTIAL',
    "ordering" INTEGER NOT NULL,
    "parallel_group" VARCHAR(64),
    "condition" JSONB,
    "actor_source" "WorkflowActorSource",
    "actor_user_id" TEXT,
    "actor_role_code" VARCHAR(128),
    "actor_rule" JSONB,
    "thresholds" JSONB,
    "line_filters" JSONB,
    "configuration" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "workflow_definition_version_id" UUID NOT NULL,
    "subject_type" "WorkflowSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "status" "WorkflowInstanceStatus" NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStepInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "workflow_instance_id" UUID NOT NULL,
    "workflow_step_id" UUID NOT NULL,
    "scope_type" "WorkflowScopeType" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "status" "WorkflowStepInstanceStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_approver_id" TEXT,
    "decision" "WorkflowStepDecision",
    "decision_comment" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(6),
    "condition_result" BOOLEAN,
    "condition_input_snapshot" JSONB,
    "condition_rule_set_id" VARCHAR(128),
    "condition_rule_version" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowStepInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseDocument_tenantId_status_createdAt_idx" ON "PurchaseDocument"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "PurchaseDocument_tenantId_requesterId_status_idx" ON "PurchaseDocument"("tenant_id", "requester_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocument_tenantId_id_key" ON "PurchaseDocument"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocument_tenantId_documentNumber_key" ON "PurchaseDocument"("tenant_id", "document_number");

-- CreateIndex
CREATE INDEX "PurchaseLine_tenantId_lineType_idx" ON "PurchaseLine"("tenant_id", "line_type");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseLine_tenantId_id_key" ON "PurchaseLine"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseLine_tenantId_documentId_lineNumber_key" ON "PurchaseLine"("tenant_id", "purchase_document_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_tenantId_id_key" ON "WorkflowDefinition"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_tenantId_code_key" ON "WorkflowDefinition"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "WorkflowDefinitionVersion_tenantId_status_idx" ON "WorkflowDefinitionVersion"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinitionVersion_tenantId_id_key" ON "WorkflowDefinitionVersion"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinitionVersion_tenantId_definitionId_version_key" ON "WorkflowDefinitionVersion"("tenant_id", "workflow_definition_id", "version_label");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_tenantId_id_key" ON "WorkflowStep"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_tenantId_versionId_stepKey_key" ON "WorkflowStep"("tenant_id", "workflow_definition_version_id", "step_key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_tenantId_versionId_ordering_key" ON "WorkflowStep"("tenant_id", "workflow_definition_version_id", "ordering");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_subject_status_idx" ON "WorkflowInstance"("tenant_id", "subject_type", "subject_id", "status");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_status_updatedAt_idx" ON "WorkflowInstance"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_tenantId_id_key" ON "WorkflowInstance"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_approver_status_idx" ON "WorkflowStepInstance"("tenant_id", "resolved_approver_id", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepInstance_tenantId_instanceId_status_idx" ON "WorkflowStepInstance"("tenant_id", "workflow_instance_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepInstance_tenantId_id_key" ON "WorkflowStepInstance"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepInstance_tenantId_instanceId_stepId_key" ON "WorkflowStepInstance"("tenant_id", "workflow_instance_id", "workflow_step_id");

-- AddForeignKey
ALTER TABLE "PurchaseLine" ADD CONSTRAINT "PurchaseLine_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDefinitionVersion" ADD CONSTRAINT "WorkflowDefinitionVersion_tenant_id_workflow_definition_id_fkey" FOREIGN KEY ("tenant_id", "workflow_definition_id") REFERENCES "WorkflowDefinition"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_tenant_id_workflow_definition_version_id_fkey" FOREIGN KEY ("tenant_id", "workflow_definition_version_id") REFERENCES "WorkflowDefinitionVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowInstance" ADD CONSTRAINT "WorkflowInstance_tenant_id_workflow_definition_version_id_fkey" FOREIGN KEY ("tenant_id", "workflow_definition_version_id") REFERENCES "WorkflowDefinitionVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_tenant_id_workflow_instance_id_fkey" FOREIGN KEY ("tenant_id", "workflow_instance_id") REFERENCES "WorkflowInstance"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_tenant_id_workflow_step_id_fkey" FOREIGN KEY ("tenant_id", "workflow_step_id") REFERENCES "WorkflowStep"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
