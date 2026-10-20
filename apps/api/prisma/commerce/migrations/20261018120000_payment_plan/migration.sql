-- PAYMENT PLAN (دستور پرداخت و رژیم پرداخت): the procurement requirements'
-- "payment instruction" — one purchase, several approved payment stages. The
-- append-only `PaymentRecord` history already answers "what was paid"; this
-- pair of tables answers "what was ORDERED to be paid, in how many stages,
-- under whose approval" — two different questions the requirements keep
-- separate (§6–§7 of the business model: staged payments, each later payment
-- needing its own approval, a partially paid case never looking closed).
--
-- ADDITIVE ONLY: TWO new enum types, TWO new tables, SEVEN new indexes, FOUR
-- foreign keys into tenant-bearing composite keys. No existing table is
-- rewritten, no data is touched, no DROP / TRUNCATE / DELETE / RENAME, no
-- ALTER COLUMN on an owned row, no other owner's names.
--
-- STRUCTURAL GUARANTEES (the rules a UNIQUE index can hold better than a
-- service read):
--   * `(tenant_id, supersedes_plan_id)` UNIQUE — at most ONE successor per
--     approved plan; two concurrent revisions cannot both supersede it.
--   * `(tenant_id, plan_id, seq)` UNIQUE — no duplicate stage number inside a
--     plan.
--   * `(tenant_id, executed_payment_id)` UNIQUE — one payment record can
--     execute at most ONE installment and one installment is executed at most
--     once: the idempotency the requirements demand for payment execution.
--
-- Verified with `prisma generate` against the extended schema before this file
-- was written; apply with `prisma migrate deploy --schema=prisma/commerce/schema.prisma`.

-- CreateEnum
CREATE TYPE "PaymentPlanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentInstallmentStatus" AS ENUM ('PENDING', 'APPROVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "committed_amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3),
    "note" VARCHAR(1000),
    "supersedes_plan_id" UUID,
    "requested_by_user_id" TEXT,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentInstallment" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "due_date" TIMESTAMPTZ(6),
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentInstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "note" VARCHAR(500),
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "executed_payment_id" UUID,
    "executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentPlan_tenant_id_purchase_document_id_created_at_idx" ON "PaymentPlan"("tenant_id", "purchase_document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_tenant_id_id_key" ON "PaymentPlan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_tenant_id_supersedes_plan_id_key" ON "PaymentPlan"("tenant_id", "supersedes_plan_id");

-- CreateIndex
CREATE INDEX "PaymentInstallment_tenant_id_plan_id_idx" ON "PaymentInstallment"("tenant_id", "plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentInstallment_tenant_id_plan_id_seq_key" ON "PaymentInstallment"("tenant_id", "plan_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentInstallment_tenant_id_executed_payment_id_key" ON "PaymentInstallment"("tenant_id", "executed_payment_id");

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_tenant_id_supersedes_plan_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_plan_id") REFERENCES "PaymentPlan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentInstallment" ADD CONSTRAINT "PaymentInstallment_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "PaymentPlan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentInstallment" ADD CONSTRAINT "PaymentInstallment_tenant_id_executed_payment_id_fkey" FOREIGN KEY ("tenant_id", "executed_payment_id") REFERENCES "PaymentRecord"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
