-- PHASE C4-R (GAP-3): the Purchase Completion Policy, and the completion record the
-- completion act writes when it uses one.
--
-- ADDITIVE ONLY, and hand-checked against `prisma migrate diff` (the commercial
-- foundation's own header records that spelling of the workflow). Exactly two subjects:
--
--   1. `PurchaseCompletionPolicyVersion` — the tenant's versioned completion policy
--      (status uses the EXISTING `WorkflowDefinitionVersionStatus` type, so no CREATE
--      TYPE: the DRAFT → VALIDATED → PUBLISHED → ARCHIVED lifecycle is the one the
--      workflow, routing and commercial configuration rows already share);
--   2. three NULLABLE columns on `PurchaseDocument` recording C1 §29's completion
--      actor, completion timestamp, and the policy version that authorised the act —
--      the same `null → versionId` pin shape as the commercial and line-routing pins.
--
-- Nothing is dropped, renamed, made NOT NULL or defaulted: no existing row, column,
-- index or constraint changes meaning. The pre-existing `PaymentRecord.id` default that
-- `migrate diff` also reports belongs to `20260929000002_payment_history` and is NOT
-- touched here.

-- CreateTable
CREATE TABLE "PurchaseCompletionPolicyVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "WorkflowDefinitionVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "version_label" VARCHAR(64) NOT NULL,
    "allowed_from_statuses" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PurchaseCompletionPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseCompletionPolicyVersion_tenantId_id_key" ON "PurchaseCompletionPolicyVersion"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseCompletionPolicyVersion_tenantId_versionLabel_key" ON "PurchaseCompletionPolicyVersion"("tenant_id", "version_label");

-- CreateIndex
CREATE INDEX "PurchaseCompletionPolicyVersion_tenantId_status_idx" ON "PurchaseCompletionPolicyVersion"("tenant_id", "status");

-- AlterTable
ALTER TABLE "PurchaseDocument" ADD COLUMN "completed_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "PurchaseDocument" ADD COLUMN "completed_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "PurchaseDocument" ADD COLUMN "completion_policy_version_id" UUID;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_tenant_id_completion_policy_version_id_fkey" FOREIGN KEY ("tenant_id", "completion_policy_version_id") REFERENCES "PurchaseCompletionPolicyVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
