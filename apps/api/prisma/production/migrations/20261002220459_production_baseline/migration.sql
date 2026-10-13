-- CreateEnum
CREATE TYPE "BomStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ManagerOpinion" AS ENUM ('APPROVED', 'REJECTED', 'NEEDS_CORRECTION');

-- CreateTable
CREATE TABLE "BomHeader" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "project_ref" VARCHAR(128) NOT NULL,
    "product_tree_ref" VARCHAR(128) NOT NULL,
    "requester_user_id" TEXT NOT NULL,
    "approver_user_id" TEXT,
    "status" "BomStatus" NOT NULL DEFAULT 'DRAFT',
    "manager_opinion" "ManagerOpinion",
    "comments" VARCHAR(2000),
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BomHeader_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomHeader_tenantId_status_updatedAt_idx" ON "BomHeader"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "BomHeader_tenantId_approverUserId_status_idx" ON "BomHeader"("tenant_id", "approver_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BomHeader_tenantId_id_key" ON "BomHeader"("tenant_id", "id");

-- THE APPROVER INVARIANT (M-5b), stated in the database rather than trusted to
-- application arithmetic — the same move `PurchaseDocumentCounter`'s `counter >= 0`
-- CHECK makes, and the same reason: an invariant that lives only in the service is an
-- invariant a second caller can violate.
--
-- WHAT IT FORBIDS: a document that has LEFT the editable state without naming an
-- approver. M-5b snapshots the approver at submit, so "SUBMITTED and nobody was asked"
-- is not a state the domain permits — and a row in it would be a routing decision that
-- reference_id-free history could never explain. The service already refuses the
-- transition; this constraint is what makes the refusal retroactively provable.
--
-- WHY IT IS NOT IN `schema.prisma`: Prisma has no representation for a CHECK constraint.
-- It is declared here, in the migration, exactly as the Commerce counter's CHECK is, so
-- `prisma migrate diff` reports it as a known, documented difference rather than as drift
-- somebody forgot to model.
ALTER TABLE "BomHeader"
  ADD CONSTRAINT "BomHeader_submitted_requires_approver"
  CHECK ("status" = 'DRAFT' OR "approver_user_id" IS NOT NULL);
