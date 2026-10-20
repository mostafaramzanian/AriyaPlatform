-- PHASE W2-C: `PurchaseDocument.status_changed_at` — the authoritative
-- state-entry instant the pending-aging report reads.
--
-- ADDITIVE AND NULLABLE: existing rows cannot be rewritten with an invented
-- instant, so the column is nullable and backfilled with the best honest
-- approximation the table already holds — `completed_at` for CLOSED rows
-- (the recorded completion instant IS the entry into CLOSED), `created_at`
-- for every other status (the row's creation is the floor of any later
-- entry; claiming more would fabricate precision the history never stored).
-- From the moment this migration runs, every conditional status statement
-- writes the column in the same `UPDATE` as the status itself, so new
-- transitions are exact.
ALTER TABLE "PurchaseDocument" ADD COLUMN "status_changed_at" TIMESTAMPTZ(6);

UPDATE "PurchaseDocument"
SET "status_changed_at" = COALESCE("completed_at", "created_at");
