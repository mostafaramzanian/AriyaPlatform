-- CreateEnum
CREATE TYPE "MissionDurationMode" AS ENUM ('HOURLY', 'DAILY');

-- CreateEnum
CREATE TYPE "MissionLocationType" AS ENUM ('IN_CITY', 'OUT_OF_CITY');

-- CreateEnum
CREATE TYPE "MissionEngagementType" AS ENUM ('PROJECT', 'NON_PROJECT');

-- CreateEnum
CREATE TYPE "MissionRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_APPROVAL', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MissionRoutingMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "MissionParallelCompletionMode" AS ENUM ('ALL_REQUIRED');

-- CreateEnum
CREATE TYPE "MissionApprovalInstanceStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'SUPERSEDED', 'CORRECTION_REQUIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MissionApprovalStepStatus" AS ENUM ('PENDING', 'ACTIVE', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MissionApprovalResolutionReason" AS ENUM ('PRIMARY', 'SUBSTITUTE', 'NO_RESOLUTION');

-- CreateEnum
CREATE TYPE "MissionApprovalStepDecision" AS ENUM ('APPROVED', 'REJECTED', 'CORRECTION_REQUIRED');

-- CreateEnum
CREATE TYPE "MissionSelfApprovalMode" AS ENUM ('NOT_ALLOWED', 'ALLOWED');

-- CreateEnum
CREATE TYPE "MissionApprovalDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MissionPolicyVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "MissionOptionGroup" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionOptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionOption" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "option_group_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionRequest" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" UUID NOT NULL,
    "status" "MissionRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "duration_mode" "MissionDurationMode" NOT NULL,
    "location_type" "MissionLocationType" NOT NULL,
    "engagement_type" "MissionEngagementType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_time" VARCHAR(8),
    "end_time" VARCHAR(8),
    "destination" VARCHAR(300),
    "description" VARCHAR(2000),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submitted_revision" INTEGER,
    "correction_reason" VARCHAR(500),
    "rejection_reason" VARCHAR(500),
    "approved_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionRequestOptionSelection" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mission_request_id" UUID NOT NULL,
    "option_group_id" UUID NOT NULL,
    "mission_option_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionRequestOptionSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionApprovalDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "routing_mode" "MissionRoutingMode" NOT NULL DEFAULT 'SEQUENTIAL',
    "parallel_completion_mode" "MissionParallelCompletionMode" NOT NULL DEFAULT 'ALL_REQUIRED',
    "self_approval_mode" "MissionSelfApprovalMode" NOT NULL DEFAULT 'NOT_ALLOWED',
    "status" "MissionApprovalDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "rule_set_id" VARCHAR(128) NOT NULL DEFAULT 'hr.mission.approval',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionApprovalDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionApprovalDefinitionStep" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_definition_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "approver_employee_id" UUID,
    "approver_role" VARCHAR(128),
    "required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionApprovalDefinitionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionApprovalInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mission_request_id" UUID NOT NULL,
    "approval_definition_id" UUID NOT NULL,
    "submission_revision" INTEGER NOT NULL,
    "sequence_number" INTEGER NOT NULL DEFAULT 1,
    "status" "MissionApprovalInstanceStatus" NOT NULL DEFAULT 'ACTIVE',
    "routing_mode" "MissionRoutingMode" NOT NULL,
    "parallel_completion_mode" "MissionParallelCompletionMode" NOT NULL,
    "self_approval_mode" "MissionSelfApprovalMode" NOT NULL,
    "rule_set_id" VARCHAR(128) NOT NULL DEFAULT 'hr.mission.approval',
    "rule_version_id" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionApprovalInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionApprovalStepInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_instance_id" UUID NOT NULL,
    "approval_step_definition_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "MissionApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_approver_employee_id" UUID,
    "resolution_reason" "MissionApprovalResolutionReason" NOT NULL DEFAULT 'NO_RESOLUTION',
    "resolution_signal" VARCHAR(64),
    "decision" "MissionApprovalStepDecision",
    "decided_by_employee_id" UUID,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionApprovalStepInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionReport" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "mission_request_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "content" VARCHAR(4000) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionPolicyVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "MissionPolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "rule_set_id" VARCHAR(128) NOT NULL DEFAULT 'hr.mission.approval',
    "configuration" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MissionPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MissionOptionGroup_tenantId_active_sortOrder_idx" ON "MissionOptionGroup"("tenant_id", "active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "MissionOptionGroup_tenantId_id_key" ON "MissionOptionGroup"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionOptionGroup_tenantId_code_key" ON "MissionOptionGroup"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "MissionOption_tenantId_groupId_active_sortOrder_idx" ON "MissionOption"("tenant_id", "option_group_id", "active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "MissionOption_tenantId_id_key" ON "MissionOption"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionOption_tenantId_groupId_code_key" ON "MissionOption"("tenant_id", "option_group_id", "code");

-- CreateIndex
CREATE INDEX "MissionRequest_tenantId_employeeId_status_idx" ON "MissionRequest"("tenant_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "MissionRequest_tenantId_status_updatedAt_idx" ON "MissionRequest"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "MissionRequest_tenantId_id_key" ON "MissionRequest"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "MissionRequestOptionSelection_tenantId_requestId_idx" ON "MissionRequestOptionSelection"("tenant_id", "mission_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionRequestOptionSelection_tenantId_id_key" ON "MissionRequestOptionSelection"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionRequestOptionSelection_tenantId_requestId_groupId_key" ON "MissionRequestOptionSelection"("tenant_id", "mission_request_id", "option_group_id");

-- CreateIndex
CREATE INDEX "MissionApprovalDefinition_tenantId_status_idx" ON "MissionApprovalDefinition"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalDefinition_tenantId_id_key" ON "MissionApprovalDefinition"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalDefinition_tenantId_name_key" ON "MissionApprovalDefinition"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "MissionApprovalDefinitionStep_tenantId_approverEmployeeId_idx" ON "MissionApprovalDefinitionStep"("tenant_id", "approver_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalDefinitionStep_tenantId_id_key" ON "MissionApprovalDefinitionStep"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalDefinitionStep_tenantId_definitionId_order_key" ON "MissionApprovalDefinitionStep"("tenant_id", "approval_definition_id", "order");

-- CreateIndex
CREATE INDEX "MissionApprovalInstance_tenantId_requestId_status_idx" ON "MissionApprovalInstance"("tenant_id", "mission_request_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalInstance_tenantId_id_key" ON "MissionApprovalInstance"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalInstance_tenantId_requestId_revision_key" ON "MissionApprovalInstance"("tenant_id", "mission_request_id", "submission_revision");

-- CreateIndex
CREATE INDEX "MissionApprovalStepInstance_tenantId_approver_status_idx" ON "MissionApprovalStepInstance"("tenant_id", "resolved_approver_employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalStepInstance_tenantId_id_key" ON "MissionApprovalStepInstance"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionApprovalStepInstance_tenantId_instanceId_order_key" ON "MissionApprovalStepInstance"("tenant_id", "approval_instance_id", "order");

-- CreateIndex
CREATE INDEX "MissionReport_tenantId_employeeId_idx" ON "MissionReport"("tenant_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionReport_tenantId_id_key" ON "MissionReport"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionReport_tenantId_requestId_key" ON "MissionReport"("tenant_id", "mission_request_id");

-- CreateIndex
CREATE INDEX "MissionPolicyVersion_tenantId_ruleSetId_status_idx" ON "MissionPolicyVersion"("tenant_id", "rule_set_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MissionPolicyVersion_tenantId_id_key" ON "MissionPolicyVersion"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MissionPolicyVersion_tenantId_version_key" ON "MissionPolicyVersion"("tenant_id", "version");

-- AddForeignKey
ALTER TABLE "MissionOption" ADD CONSTRAINT "MissionOption_tenant_id_option_group_id_fkey" FOREIGN KEY ("tenant_id", "option_group_id") REFERENCES "MissionOptionGroup"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRequest" ADD CONSTRAINT "MissionRequest_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "Employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRequestOptionSelection" ADD CONSTRAINT "MissionRequestOptionSelection_tenant_id_mission_request_id_fkey" FOREIGN KEY ("tenant_id", "mission_request_id") REFERENCES "MissionRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRequestOptionSelection" ADD CONSTRAINT "MissionRequestOptionSelection_tenant_id_option_group_id_fkey" FOREIGN KEY ("tenant_id", "option_group_id") REFERENCES "MissionOptionGroup"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRequestOptionSelection" ADD CONSTRAINT "MissionRequestOptionSelection_tenant_id_mission_option_id_fkey" FOREIGN KEY ("tenant_id", "mission_option_id") REFERENCES "MissionOption"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalDefinitionStep" ADD CONSTRAINT "MissionApprovalDefinitionStep_tenant_id_approval_definitio_fkey" FOREIGN KEY ("tenant_id", "approval_definition_id") REFERENCES "MissionApprovalDefinition"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalDefinitionStep" ADD CONSTRAINT "MissionApprovalDefinitionStep_tenant_id_approver_employee__fkey" FOREIGN KEY ("tenant_id", "approver_employee_id") REFERENCES "Employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalInstance" ADD CONSTRAINT "MissionApprovalInstance_tenant_id_mission_request_id_fkey" FOREIGN KEY ("tenant_id", "mission_request_id") REFERENCES "MissionRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalInstance" ADD CONSTRAINT "MissionApprovalInstance_tenant_id_approval_definition_id_fkey" FOREIGN KEY ("tenant_id", "approval_definition_id") REFERENCES "MissionApprovalDefinition"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalStepInstance" ADD CONSTRAINT "MissionApprovalStepInstance_tenant_id_approval_instance_id_fkey" FOREIGN KEY ("tenant_id", "approval_instance_id") REFERENCES "MissionApprovalInstance"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalStepInstance" ADD CONSTRAINT "MissionApprovalStepInstance_tenant_id_approval_step_defini_fkey" FOREIGN KEY ("tenant_id", "approval_step_definition_id") REFERENCES "MissionApprovalDefinitionStep"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalStepInstance" ADD CONSTRAINT "MissionApprovalStepInstance_tenant_id_resolved_approver_em_fkey" FOREIGN KEY ("tenant_id", "resolved_approver_employee_id") REFERENCES "Employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionApprovalStepInstance" ADD CONSTRAINT "MissionApprovalStepInstance_tenant_id_decided_by_employee__fkey" FOREIGN KEY ("tenant_id", "decided_by_employee_id") REFERENCES "Employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionReport" ADD CONSTRAINT "MissionReport_tenant_id_mission_request_id_fkey" FOREIGN KEY ("tenant_id", "mission_request_id") REFERENCES "MissionRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionReport" ADD CONSTRAINT "MissionReport_tenant_id_employee_id_fkey" FOREIGN KEY ("tenant_id", "employee_id") REFERENCES "Employee"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
