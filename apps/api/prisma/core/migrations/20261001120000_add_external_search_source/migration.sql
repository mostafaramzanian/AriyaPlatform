-- Phase P-SEARCH-SOURCE: the storage half of the Platform Search Source contract.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Global Search (49J) can only index what lives in `"SearchDocument"`, and its
-- `"sourceType"` vocabulary was Core's own eight sources. An independent bounded
-- context (Commerce first) owns its data in ANOTHER database, so the platform
-- cannot project its rows itself — the source must CONTRIBUTE a searchable
-- projection through a platform contract. That contract needs two things the
-- schema did not have:
--
--   1. A source-type marker for contributed rows (`EXTERNAL`);
--   2. A place to record WHICH contributing source a row belongs to
--      (`"sourceKey"`), because entity ids are source-owned: two bounded contexts
--      may both project an entity `abc`, and the historical
--      (`sourceType`, `sourceId`) unique key would silently collapse them into
--      one row.
--
-- WHY `ALTER TYPE ... ADD VALUE` IS ITS OWN STATEMENT, FIRST
-- ----------------------------------------------------------
-- PostgreSQL 12+ allows `ALTER TYPE ... ADD VALUE` inside a transaction, but the
-- new value CANNOT BE USED until the transaction that added it commits (SQLSTATE
-- 55P04). This migration only ADDS it — nothing here inserts or compares against
-- `'EXTERNAL'` — so the deployment cannot hit that error; the platform's ingest
-- path starts using the value after this migration is committed. The same
-- reasoning is recorded in 20260926100000_add_commerce_permission_domain, which
-- learned it the same way.
--
-- WHY THE UNIQUE INDEX IS REPLACED RATHER THAN ADDED TO
-- -----------------------------------------------------
-- A unique index is not additive when its KEY changes: the old
-- `("sourceType", "sourceId")` index would keep rejecting a second external
-- source's row for the same entity id (both rows share `sourceType = 'EXTERNAL'`),
-- so the two cannot coexist and the old index must go. This is a DDL-only change
-- — no row is read, rewritten or deleted — and the replacement index is a
-- SUPERSET of the old key for platform rows, where `"sourceKey"` is `''`:
-- uniqueness there is exactly what it was.
--
-- WHY `"sourceKey"` IS `NOT NULL DEFAULT ''` AND NOT NULLABLE
-- -----------------------------------------------------------
-- A nullable column in the unique key would be WORSE THAN USELESS: PostgreSQL
-- treats NULLs as distinct in unique indexes, so every platform row (all NULL)
-- would become "unique" against every other, and the upsert the indexer relies on
-- would silently start allowing duplicate projections. `''` is the sentinel for
-- "platform-owned source; identity is `sourceType` alone", it is written
-- explicitly by every write path, and `ADD COLUMN ... DEFAULT ''` is a
-- metadata-only operation in PostgreSQL 11+ (no table rewrite).
--
-- WHAT IS NOT HERE
-- ----------------
-- No new table, no per-module table, no dropped column, no data migration. The
-- table stays Core-owned and `"SearchDocument"` stays a cache: external rows are
-- re-authorized through their owning bounded context on every query, exactly as
-- platform rows are re-authorized through `SearchAuthorizer`.

ALTER TYPE "SearchSourceType" ADD VALUE IF NOT EXISTS 'EXTERNAL';

ALTER TABLE "SearchDocument" ADD COLUMN "sourceKey" TEXT NOT NULL DEFAULT '';

DROP INDEX "SearchDocument_sourceType_sourceId_key";

CREATE UNIQUE INDEX "SearchDocument_sourceType_sourceKey_sourceId_key"
  ON "SearchDocument"("sourceType", "sourceKey", "sourceId");
