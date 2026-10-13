-- ============================================================================
-- PHASE 54-D CORRECTIVE MIGRATION — the published-version overlap guard.
--
-- WHY THIS MIGRATION EXISTS
-- ============================================================================
-- `20260921100000_hr_leave_policy` intended to enforce §15.4/§37.6:
--
--   "the persistence layer refuses a second PUBLISHED version for the same scope
--    and effective interval"
--
-- It did not enforce it. Its constraint was:
--
--   EXCLUDE USING gist (
--     tenant_id WITH =,
--     policy_id WITH =,
--     authoring_scope WITH =,          -- GENERATED: 'PUBLISHED:' || id WHEN PUBLISHED
--     daterange(effective_from, COALESCE(effective_to, DATE 'infinity'), '[]') WITH &&
--   )
--
-- For a PUBLISHED row the scope embeds the row's OWN `id`, and `id` is unique by
-- construction. Two distinct rows therefore always carry distinct scope values, the
-- equality term can never match, and the `&&` interval term is never reached. The
-- exclusion was a tautology: it refused nothing.
--
-- The same derivation also over-refused in the other direction — every non-PUBLISHED
-- state collapsed to the single scope 'AUTHORING', so two DRAFT versions of one policy
-- could not coexist, which §15.4 explicitly permits.
--
-- Both defects were reproduced against a database in exactly the state this repository's
-- migrations produce, on PostgreSQL 16.15:
--
--   * a second PUBLISHED version, same tenant, same policy, overlapping interval
--     -> ACCEPTED (should be refused)
--   * a second DRAFT version, same tenant, same policy, overlapping interval
--     -> REFUSED with 23P01 (should be accepted)
--
-- The defect was reachable through a direct INSERT and through the ordinary publish
-- transition, so no service-layer convention closed it.
--
-- THE CORRECTED PREDICATE
-- ============================================================================
-- The scope of a published version is its POLICY, not its row identity. Writing that as
-- a stored scope column cannot work: the scope would have to be `policy_id` for published
-- rows and row-unique for drafts, and no single stored value expresses "row-unique"
-- without a second collision class. PostgreSQL does not need that dodge — a partial
-- exclusion constraint states the rule directly, and drafts are simply absent from the
-- index:
--
--   * PUBLISHED rows with the same tenant+policy and overlapping inclusive intervals
--     -> refused (23P01)
--   * two PUBLISHED rows that are merely CONTIGUOUS (one ends 2025-12-31, the next starts
--     2026-01-01) -> accepted
--   * DRAFT rows overlapping anything at all, including each other -> accepted
--   * a DRAFT sharing an interval with a PUBLISHED row -> accepted, and that draft's own
--     eventual DRAFT -> PUBLISHED transition is what the constraint then refuses
--   * rows in any non-PUBLISHED state -> accepted (the index ignores them entirely)
--   * different policies, or the same policy id under a different tenant -> accepted
--
-- The interval expression is the platform's frozen idiom, reused verbatim from
-- `20260916090000_hr_exclusive_interval_and_cycle_guards`: `daterange(start,
-- COALESCE(end, DATE 'infinity'), '[]')`, INCLUSIVE on both ends, so a NULL end is
-- open-ended and overlaps every later interval. No timestamp, no timezone, no Jalali
-- arithmetic enters the constraint.
--
-- WHY NOT `UNIQUE (tenant_id, policy_id, effective_from, effective_to)`
-- --------------------------------------------------------------------------
-- That catches only an EXACTLY equal interval. `[2026-01-01, 2026-12-31]` and
-- `[2026-06-01, 2027-03-31]` are both currently in force and would both be accepted.
-- Measured on PostgreSQL 16.15: identical-interval pairs are refused, non-identical
-- overlapping pairs are ACCEPTED, so a UNIQUE does not express the invariant.
--
-- WHY `authoring_scope` IS DROPPED IN THIS SAME MIGRATION
-- ============================================================================

-- 1. Retire the defective exclusion constraint.
ALTER TABLE "LeavePolicyVersion"
  DROP CONSTRAINT "LeavePolicyVersion_scope_no_overlap_excl";

-- 2. Enforce the invariant that was intended: at most one in-force PUBLISHED version per
--    tenant and policy. `WHERE ("status" = 'PUBLISHED')` is a partial exclusion constraint,
--    so drafts never enter the index and are free to overlap.
ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_published_overlap_excl"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "policy_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE 'infinity'), '[]') WITH &&
  )
  WHERE ("status" = 'PUBLISHED');

-- 3. Drop the now-unused generated scope column (only possible after step 1).
ALTER TABLE "LeavePolicyVersion"
  DROP COLUMN "authoring_scope";

-- The corrected constraint needs no derived column, and `authoring_scope` has no reader
-- left anywhere. A dependency scan found it in:
--
--   * this repository's historical migration (the definition being replaced here)
--   * throwaway probe scripts — not application code
--
-- and NOWHERE else: not in `prisma/hr/schema.prisma` (the Prisma client never modelled
-- it, so there is no model change to make), not in `src/`, not in any test or e2e spec.
-- It was a raw-SQL generated column invisible to the application, so it is dead schema,
-- not a public surface. Dropping it here is what keeps the schema honest: after this
-- migration the live table has exactly the columns the Prisma schema declares.
--
-- ORDER MATTERS
-- ============================================================================
-- The old constraint is dropped FIRST. It carries a GiST index over `authoring_scope`, and
-- PostgreSQL refuses to drop a column that an index still depends on, so the column can
-- only go once the constraint that uses it is gone.
--
-- This migration is purely additive in intent and preserves every existing valid row: it
-- drops no data, rewrites no interval, and changes no status. It was applied to a database
-- with zero `LeavePolicyVersion` rows. On a database that already contains two overlapping
-- PUBLISHED versions for one tenant+policy this migration will FAIL at step 2 rather than
-- silently discard history — that is deliberate, and the conflicting rows must be resolved
-- as a product decision first.
-- ============================================================================
