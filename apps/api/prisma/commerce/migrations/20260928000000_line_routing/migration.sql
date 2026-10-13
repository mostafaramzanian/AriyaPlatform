-- CreateEnum
CREATE TYPE "WorkflowLineRoutingNoRouteBehavior" AS ENUM ('REJECT_OPERATION', 'LEAVE_UNROUTED');

-- CreateEnum
CREATE TYPE "WorkflowLineRoutingMatchBehavior" AS ENUM ('HIGHEST_PRIORITY', 'AMBIGUOUS_ERROR');

-- CreateEnum
CREATE TYPE "WorkflowLineRoutingAggregationPolicy" AS ENUM ('ALL_APPROVED', 'INDEPENDENT');

-- AlterEnum
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'AFTER_DOCUMENT_WORKFLOW_APPROVED';

-- CreateTable
CREATE TABLE "WorkflowLineRoutingVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "WorkflowDefinitionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "version_label" VARCHAR(64) NOT NULL,
    "trigger" "WorkflowTriggerEvent" NOT NULL,
    "no_route_behavior" "WorkflowLineRoutingNoRouteBehavior" NOT NULL,
    "multiple_match_behavior" "WorkflowLineRoutingMatchBehavior" NOT NULL,
    "aggregation_policy" "WorkflowLineRoutingAggregationPolicy" NOT NULL,
    "route_rules" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowLineRoutingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowLineRoutingVersion_tenantId_status_trigger_idx" ON "WorkflowLineRoutingVersion"("tenant_id", "status", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowLineRoutingVersion_tenantId_versionLabel_key" ON "WorkflowLineRoutingVersion"("tenant_id", "version_label");

