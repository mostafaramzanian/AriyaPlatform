-- Phase 49J verification probe. Read-only; safe to re-run.
--
-- Confirms the four structural facts the migration promises and that the current
-- runtime state matches what is being reported:
--   1. `searchVector` is GENERATED ALWAYS (no write path may supply it);
--   2. `embedding` is `vector(1536)`;
--   3. both CHECK constraints exist;
--   4. per-source row counts and how many rows carry a vector.
\pset pager off

SELECT a.attname AS column,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attgenerated <> '' AS is_generated
FROM pg_attribute a
WHERE a.attrelid = '"SearchDocument"'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum;

SELECT conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = '"SearchDocument"'::regclass
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'SearchDocument'
ORDER BY indexname;

SELECT "sourceType"::text AS source,
       COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE "embedding" IS NOT NULL) AS with_vector,
       COUNT(*) FILTER (WHERE "embeddingModel" IS NOT NULL) AS with_model,
       COUNT(*) FILTER (WHERE "tenantId" IS NULL) AS tenant_null
FROM "SearchDocument"
GROUP BY 1
ORDER BY 1;

-- Credential state, without printing any secret material.
SELECT COUNT(*) AS provider_config_rows FROM "AIProviderConfig";
