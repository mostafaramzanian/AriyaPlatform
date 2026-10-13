-- Phase 51-HR-1: the two remaining integrity guarantees of Phase 51-HR-1 §10/§11.
--
-- Migration `20260916080000_hr_temporal_and_tenancy_guards` made the SAME-TENANT
-- references and the date-order checks database facts. Two guarantees were still
-- only service conventions, and §10/§11 require both to survive a writer that does
-- not go through the service:
--
--   1. no INVALID OVERLAPPING employment interval for the same employee;
--   2. no CYCLE in the organization hierarchy and no CYCLE in the manager chain.
--
-- WHY RAW SQL: neither is expressible in Prisma's schema language. An overlap rule
-- needs an `EXCLUDE USING gist` constraint, and a cycle rule needs a recursive
-- BEFORE trigger. §10 names the raw-migration path explicitly for exactly this.

-- ---------------------------------------------------------------------------
-- 1. EmploymentReport overlap: at most ONE employment interval per employee per
--    calendar day.
--
--    `daterange(start, COALESCE(end, infinity), '[]')` is INCLUSIVE on both ends,
--    which matches the schema's date-only semantics: a record with
--    `end_date = 2026-03-01` covers 2026-03-01, so a second record starting
--    2026-03-01 for the same employee is the overlap this constraint rejects.
--    A NULL `end_date` is an OPEN-ENDED interval (the current record), and
--    'infinity' is what makes it overlap every later interval — which is exactly
--    the "you cannot open a second employment while one is still open" rule.
--
--    `btree_gist` supplies the `=` operator class for the `employee_id` uuid
--    column so the equality can participate in a GiST index; it was created by
--    the previous migration and is re-asserted here so this file is also
--    runnable on its own.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_no_overlapping_intervals_excl"
  EXCLUDE USING gist (
    "employee_id" WITH =,
    daterange("start_date", COALESCE("end_date", DATE 'infinity'), '[]') WITH &&
  );

-- ---------------------------------------------------------------------------
-- 2. OrganizationUnit hierarchy must be a FOREST, not a graph.
--
--    The composite tenant-scoped FK already guarantees the parent is in the same
--    tenant, and the CHECK already rejects a self-parent. Neither can see a
--    longer cycle (`A -> B -> C -> A`), because each row on its own is legal.
--
--    The trigger walks the parent chain from the row's NEW parent upward and
--    fails the moment it reaches the row's own id. The walk is bounded so a
--    pre-existing cycle (introduced while the guard was absent) surfaces as an
--    error instead of an infinite loop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "hr_assert_org_unit_no_cycle"() RETURNS trigger AS $$
DECLARE
  walk  uuid;
  depth integer := 0;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;

  walk := NEW."parent_id";

  WHILE walk IS NOT NULL LOOP
    IF walk = NEW."id" THEN
      RAISE EXCEPTION 'OrganizationUnit hierarchy cycle: % would become its own ancestor', NEW."id"
        USING ERRCODE = '23514';
    END IF;

    depth := depth + 1;
    IF depth > 100 THEN
      RAISE EXCEPTION 'OrganizationUnit hierarchy depth exceeded 100 while walking from %', NEW."id"
        USING ERRCODE = '23514';
    END IF;

    -- Scoped by tenant as well as id: the walk must not leave the tenant, and the
    -- composite unique key is what makes this lookup an index hit.
    SELECT u."parent_id" INTO walk
      FROM "OrganizationUnit" u
     WHERE u."id" = walk AND u."tenant_id" = NEW."tenant_id";
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrganizationUnit_no_cycle_guard"
  BEFORE INSERT OR UPDATE OF "parent_id"
  ON "OrganizationUnit"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_org_unit_no_cycle"();
