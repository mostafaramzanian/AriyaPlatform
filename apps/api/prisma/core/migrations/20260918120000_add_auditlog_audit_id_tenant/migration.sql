-- Phase ARCH-3B (Decision A): the safe, NARROWED AuditLog migration.
--
-- WHAT THIS MIGRATION IS NOT. It is not the migration that was attempted and blocked.
-- The blocked version tried to make "tenantId" NOT NULL, which required a deterministic
-- tenant for all 36,489 historical rows. Only 557 of them (1.53%) have provable tenant
-- evidence, so the proof failed — correctly. Making the column NOT NULL at this point
-- would have meant INVENTING a tenant for 35,932 rows, i.e. fabricating history in the one
-- table an auditor reads. Decision A therefore authorises exactly the following, and
-- nothing else:
--
--   1. add "auditId" (nullable first);
--   2. backfill it DETERMINISTICALLY as "auditId" := "id" — true for every existing row
--      because "id" is already UNIQUE (the primary key), so no guess is involved;
--   3. verify count and distinctness (both asserted below, in-transaction);
--   4. add the UNIQUE constraint on "auditId";
--   5. DROP UNIQUE("requestId") and replace it with a plain index;
--   6. add "tenantId" as NULLABLE and DO NOT backfill it.
--
-- NOT DONE HERE, ON PURPOSE: "tenantId" NOT NULL, an index on "tenantId", any inference
-- of a tenant from "requestId"/"resourceType"/"correlationId", any disposal or rewrite of
-- historical rows, and any change to "AuditDispatch" (§5: its "auditId" keeps its
-- historical meaning of "AuditLog"."id" and is not reinterpreted).
--
-- READ COMMITTED + THIS FILE'S OWN LOCKING. The migration runs as one transaction
-- (prisma migrate deploy wraps each file), and the three DDL statements below take ACCESS
-- EXCLUSIVE locks as they run, so a concurrent insert cannot slip in between the backfill
-- and the NOT NULL/UNIQUE steps and produce a row with a NULL "auditId". That is why
-- "auditId" can be declared NOT NULL here even though it is added nullable: the backfill and
-- the constraint are separated by nothing that could admit a new row.

-- ── 1. The producer-owned event identity, added NULLABLE ─────────────────────────────
ALTER TABLE "AuditLog" ADD COLUMN "auditId" TEXT;

-- ── 2. Deterministic backfill: one row's id IS its auditId ──────────────────────────
UPDATE "AuditLog" SET "auditId" = "id" WHERE "auditId" IS NULL;

-- ── 3. Proof, in-transaction: every row populated and every value distinct ───────────
-- A migration that adds UNIQUE("auditId") without this check would fail later with a
-- constraint error naming no rows. These two DO blocks fail FIRST and say which case it is.
DO $$
DECLARE
  total_rows   bigint;
  populated    bigint;
BEGIN
  SELECT count(*) INTO total_rows FROM "AuditLog";
  SELECT count(*) INTO populated FROM "AuditLog" WHERE "auditId" IS NOT NULL;

  IF populated <> total_rows THEN
    RAISE EXCEPTION 'ARCH-3B aborted: auditId populated % of % AuditLog rows',
      populated, total_rows;
  END IF;
END $$;

DO $$
DECLARE
  populated    bigint;
  distinct_ids bigint;
BEGIN
  SELECT count(*) INTO populated FROM "AuditLog";
  SELECT count(DISTINCT "auditId") INTO distinct_ids FROM "AuditLog";

  IF distinct_ids <> populated THEN
    RAISE EXCEPTION 'ARCH-3B aborted: % auditId values are not distinct across % rows',
      populated - distinct_ids, populated;
  END IF;
END $$;

-- ── 4. "auditId" becomes the NOT NULL, UNIQUE event identity ────────────────────────
ALTER TABLE "AuditLog" ALTER COLUMN "auditId" SET NOT NULL;
CREATE UNIQUE INDEX "AuditLog_auditId_key" ON "AuditLog"("auditId");

-- ── 5. "requestId" stops being an identity and becomes correlation ──────────────────
-- The unique index is what forced one audit row per request; it is dropped and replaced by
-- a NON-unique index so "every event of this request" stays an index scan.
DROP INDEX "AuditLog_requestId_key";
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- ── 6. "tenantId", NULLABLE, and deliberately NOT backfilled ────────────────────────
-- 36,489 legacy-historical rows: 557 have provable tenant evidence and 35,932 do not.
-- No value is written here. A row with "tenantId" IS NULL is a LEGACY-HISTORICAL record,
-- not a current platform audit record; the "platform.audit@v1" consumer rejects a new
-- event that omits the tenant, so the absence of a value can never be produced by the new
-- write path.
ALTER TABLE "AuditLog" ADD COLUMN "tenantId" TEXT;