-- Phase C1 step L: the purchase document numbering counter (§5.1).
--
-- WHY THIS MIGRATION EXISTS, AND WHY IT IS ADDITIVE
-- -------------------------------------------------
-- Step K's schema header recorded the numbering DECISION and deliberately deferred
-- the table: "The first step that MINTS numbers brings the counter, its CHECK and its
-- concurrency spec together." Step L is the first Commerce writer that inserts a
-- `PurchaseDocument`, and `PurchaseDocument.document_number` is NOT NULL, so no create
-- is expressible without minting one. Nothing already applied is touched: one table,
-- one unique index, one CHECK, no ALTER of an existing table and no data movement —
-- so this file is safe on a database that has already run the baseline.
--
-- THE CONCURRENCY SPECIFICATION (one statement, no read-then-write)
-- -----------------------------------------------------------------
--   INSERT INTO "PurchaseDocumentCounter" ("id","tenant_id","kind","jalali_year","counter")
--   VALUES (gen_random_uuid(), $tenant, $kind::"PurchaseDocumentKind", $jalaliYear, 1)
--   ON CONFLICT ("tenant_id","kind","jalali_year")
--   DO UPDATE SET "counter" = "PurchaseDocumentCounter"."counter" + 1
--   RETURNING "counter"
--
-- executed INSIDE the transaction that inserts the document. Postgres serialises the
-- conflicting insert against a concurrent one, so two creates in one tenant/kind/year
-- cannot receive the same sequence number — and because allocation is in the creating
-- transaction, a create that rolls back never burns a number. `counter` is the LAST
-- number handed out and is never decremented; the CHECK below keeps that meaning true
-- for a database inspected long after the writer is gone.
--
-- NUMBERS ARE NEVER CLIENT-SUPPLIED AND NEVER RANDOM. The format is the formatter's
-- (`purchase-number.ts`), the Jalali year is computed server-side from the create
-- instant, and the sequence comes from this row alone. Unique per
-- (tenant, document_number) on "PurchaseDocument" is what makes the whole scheme
-- answerable: two documents in one tenant can never share a number, whatever went
-- wrong elsewhere.

-- CreateTable
CREATE TABLE "PurchaseDocumentCounter" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "PurchaseDocumentKind" NOT NULL,
    "jalali_year" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseDocumentCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocumentCounter_tenantId_kind_jalaliYear_key" ON "PurchaseDocumentCounter"("tenant_id", "kind", "jalali_year");

-- CheckConstraint
-- Hand-written because Prisma cannot express a CHECK, and §16 states invariants in the
-- database rather than in application arithmetic: a counter that could go negative
-- would make "the last number handed out" a statement no reader could rely on.
ALTER TABLE "PurchaseDocumentCounter" ADD CONSTRAINT "PurchaseDocumentCounter_counter_nonnegative" CHECK ("counter" >= 0);
