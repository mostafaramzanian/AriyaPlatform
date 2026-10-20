-- Phase W3: the append-only attempt history of every InventoryPosting.
-- The posting row keeps the CURRENT state; this table keeps the WHOLE
-- story — every ledger call, its result, the sanitized refusal, the
-- movement it produced, the acting user, and the attempt interval.

-- Composite ownership key the attempt rows foreign-key into.
CREATE UNIQUE INDEX "InventoryPosting_tenant_id_id_key" ON "InventoryPosting"("tenant_id", "id");

CREATE TABLE "InventoryPostingAttempt" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "posting_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" VARCHAR(24) NOT NULL,
    "error" TEXT,
    "movement_id" UUID,
    "actor_user_id" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryPostingAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryPostingAttempt_tenant_id_id_key" ON "InventoryPostingAttempt"("tenant_id", "id");
CREATE UNIQUE INDEX "InventoryPostingAttempt_tenant_id_posting_id_attempt_key" ON "InventoryPostingAttempt"("tenant_id", "posting_id", "attempt");
CREATE INDEX "InventoryPostingAttempt_tenant_id_posting_id_idx" ON "InventoryPostingAttempt"("tenant_id", "posting_id");

ALTER TABLE "InventoryPostingAttempt" ADD CONSTRAINT "InventoryPostingAttempt_tenant_id_posting_id_fkey" FOREIGN KEY ("tenant_id", "posting_id") REFERENCES "InventoryPosting"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
