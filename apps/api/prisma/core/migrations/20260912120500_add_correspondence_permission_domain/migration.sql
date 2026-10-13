-- Phase 50: register the CORRESPONDENCE domain member on PermissionDomain.
--
-- WHY THIS IS ITS OWN MIGRATION (and why the seed is a separate, later one):
-- PostgreSQL 12+ allows `ALTER TYPE ... ADD VALUE` inside a transaction, but the
-- new value CANNOT BE USED until the transaction that added it commits (SQLSTATE
-- 55P04, "unsafe use of new value"). The first version of this phase put the
-- ALTER and the permission INSERTs in ONE migration — which failed on every
-- deployment with 55P04. The enum member is therefore added HERE, committed by
-- this migration, and consumed by the INSERTs in 20260912120600.
--
-- Idempotent: IF NOT EXISTS makes a re-run a no-op.

ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'CORRESPONDENCE';
