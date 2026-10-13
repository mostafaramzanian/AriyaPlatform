-- GAP-ENV-1: platform database bootstrap.
--
-- This file runs ONCE, automatically, on the first initdb of the postgres
-- container's data volume (the /docker-entrypoint-initdb.d mechanism of the
-- official PostgreSQL image). On an already-initialized volume it does NOT run —
-- an existing cluster creates any missing database with:
--
--   docker exec -i aria-erp-postgres psql -U aria_user -d aria_erp \
--     -f /docker-entrypoint-initdb.d/01-create-databases.sql
--
-- (the mount makes the same file reachable inside the container) or by piping
-- the file through psql. It is idempotent: each statement is guarded by a
-- NOT EXISTS check, so re-running it changes nothing.
--
-- WHY THE GUARDS ARE `SELECT … \gexec` AND NOT A `DO $$ … $$` BLOCK
-- -----------------------------------------------------------------
-- `CREATE DATABASE` cannot run inside a function or a transaction, so the
-- `DO $$ BEGIN IF NOT EXISTS … THEN CREATE DATABASE …; END $$;` form this file
-- used before PHASE-PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION never worked:
-- PostgreSQL rejects it with
--
--   ERROR:  CREATE DATABASE cannot be executed from a function
--   CONTEXT: PL/pgSQL function inline_code_block line 4 at SQL statement
--
-- and, because the official entrypoint runs initdb scripts with ON_ERROR_STOP=1,
-- that error aborted the whole initialisation and the container came up with
-- NONE of these databases. Every database in an existing cluster was therefore
-- created by an operator by hand, not by this file. The
-- `SELECT 'CREATE DATABASE …' WHERE NOT EXISTS (…) \gexec` form below is the
-- canonical psql idiom: the guard is evaluated by psql and `\gexec` executes the
-- emitted statement only when a row was returned. It is safe on a fresh volume
-- AND safe to re-run against an existing cluster.
--
-- Ownership contract (runtime-policy.json + ADR-0005):
--   core_db          — identity, RBAC, tenant, audit (required)
--   cms_db           — CMS content (required)
--   correspondence_db — Correspondence (required)
--   hr_db            — Human Resources (required)
--   commerce_db      — Commerce / Procurement (required)
--   production_db    — Production / BOM (required by `combined`; the Production
--                      bounded context owns its own Prisma project and migrations,
--                      exactly as Commerce does)
--   finance_db       — Financial / check requests (required by `combined`; the Financial
--                      bounded context owns its own Prisma project and migrations,
--                      exactly as Commerce and Production do)
--   observability_db — log/audit retention platform (optional; only needed when
--                      an image ships the observability client and
--                      OBSERVABILITY_ENABLED=true)
--
-- Migrations are NEVER applied here: each database is brought to its schema
-- revision by the dedicated per-owner step `npm run db:migrate:<owner>`.

SELECT 'CREATE DATABASE core_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'core_db')\gexec

SELECT 'CREATE DATABASE cms_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cms_db')\gexec

SELECT 'CREATE DATABASE correspondence_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'correspondence_db')\gexec

SELECT 'CREATE DATABASE hr_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hr_db')\gexec

SELECT 'CREATE DATABASE commerce_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'commerce_db')\gexec

-- Phase PRODUCTION-BOM-HEADER: the Production bounded context owns production_db,
-- its own Prisma project (prisma/production/schema.prisma) and its own migration
-- history, exactly as Commerce owns commerce_db. Required by the `combined`
-- runtime, which composes ProductionModule; `not-used` in `core`.
SELECT 'CREATE DATABASE production_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'production_db')\gexec

-- Phase F1 — FINANCIAL FOUNDATION: the Financial bounded context owns finance_db,
-- its own Prisma project (prisma/financial/schema.prisma) and its own migration
-- history, exactly as Commerce owns commerce_db. Required by the `combined`
-- runtime, which composes FinancialModule; `not-used` in `core`, `cms` and `future-hr`.
-- The OWNER is `financial`; the DATABASE is `finance_db`, the phase brief's name.
SELECT 'CREATE DATABASE finance_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'finance_db')\gexec

SELECT 'CREATE DATABASE observability_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'observability_db')\gexec
