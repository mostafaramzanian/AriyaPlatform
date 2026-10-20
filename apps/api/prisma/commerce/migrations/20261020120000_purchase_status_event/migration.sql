-- PHASE W3: `PurchaseStatusEvent` — the append-only purchase status
-- transition history. `status_changed_at` records only the LATEST entry;
-- this table records every transition so status durations can be
-- reconstructed honestly.
--
-- NO BACKFILL, DELIBERATELY: existing documents have no recoverable
-- transition sequence — `status_changed_at` is one instant, `created_at` is
-- creation, and any "history" built from them would be fabricated. Complete
-- history is therefore available FROM the moment this migration is applied;
-- pre-existing documents simply have no rows before their next transition.
CREATE TYPE "PurchaseStatusEventSource" AS ENUM ('LIFECYCLE');

CREATE TABLE "PurchaseStatusEvent" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "from_status" "PurchaseDocumentStatus",
    "to_status" "PurchaseDocumentStatus" NOT NULL,
    "source" "PurchaseStatusEventSource" NOT NULL DEFAULT 'LIFECYCLE',
    "actor_user_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseStatusEvent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PurchaseStatusEvent" ADD CONSTRAINT "PurchaseStatusEvent_tenant_id_purchase_document_id_fkey" FOREIGN KEY ("tenant_id", "purchase_document_id") REFERENCES "PurchaseDocument"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PurchaseStatusEvent_tenant_id_id_key" ON "PurchaseStatusEvent"("tenant_id", "id");

CREATE INDEX "PurchaseStatusEvent_tenant_id_document_occurred_idx" ON "PurchaseStatusEvent"("tenant_id", "purchase_document_id", "occurred_at", "id");
