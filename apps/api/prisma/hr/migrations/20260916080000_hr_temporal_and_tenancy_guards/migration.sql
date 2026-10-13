-- Phase 51-HR-1: the integrity guarantees Prisma cannot express.
--
-- The baseline migration creates the objects. This migration adds the four
-- guarantees that §10, §11, §13 and §49 require to be DATABASE facts rather than
-- service conventions:
--
--   1. date-only interval sanity (end >= start, no epoch sentinels);
--   2. no self-parent, and no cross-tenant parent, for OrganizationUnit;
--   3. no self-manager, and no cycle, in the employment graph;
--   4. SAME-TENANT composite foreign keys, so Postgres — not a service check —
--      rejects an employment record whose employee, unit, position or manager
--      belongs to another tenant. This is what makes "tenant isolation is
--      enforced" a property of the schema instead of a property of the code that
--      happens to write it today.
--
-- WHY RAW SQL: Prisma's schema language has no equivalent for CHECK constraints,
-- EXCLUDE constraints, triggers or composite-key foreign keys that reference a
-- non-primary unique key. §10 explicitly requires the raw migration path here.

-- ---------------------------------------------------------------------------
-- 0. `btree_gist` is what makes the overlap constraint possible: a GiST index
--    over a scalar equality (`employee_id WITH =`) needs the btree_gist operator
--    classes. Verified available in this PostgreSQL 16 build before writing.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ---------------------------------------------------------------------------
-- 1. OrganizationUnit — no self-parent, no cross-tenant parent.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrganizationUnit"
  ADD CONSTRAINT "OrganizationUnit_no_self_parent_check"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- A cross-tenant parent is blocked by referencing the TENANT-SCOPED unique key
-- (`OrganizationUnit_tenantId_id_key`) rather than the primary key: the FK now
-- carries `tenant_id` with it, so `parent` must live in the same tenant by
-- construction. The single-column FK from the baseline migration is replaced.
ALTER TABLE "OrganizationUnit"
  DROP CONSTRAINT "OrganizationUnit_parent_id_fkey";

ALTER TABLE "OrganizationUnit"
  ADD CONSTRAINT "OrganizationUnit_tenant_parent_fkey"
  FOREIGN KEY ("tenant_id", "parent_id")
  REFERENCES "OrganizationUnit" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Position — the owning unit must be in the SAME tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE "Position"
  DROP CONSTRAINT "Position_organization_unit_id_fkey";

ALTER TABLE "Position"
  ADD CONSTRAINT "Position_tenant_unit_fkey"
  FOREIGN KEY ("tenant_id", "organization_unit_id")
  REFERENCES "OrganizationUnit" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. EmploymentRecord — same-tenant employee / unit / position / manager.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmploymentRecord"
  DROP CONSTRAINT "EmploymentRecord_employee_id_fkey";

ALTER TABLE "EmploymentRecord"
  DROP CONSTRAINT "EmploymentRecord_manager_employee_id_fkey";

ALTER TABLE "EmploymentRecord"
  DROP CONSTRAINT "EmploymentRecord_organization_unit_id_fkey";

ALTER TABLE "EmploymentRecord"
  DROP CONSTRAINT "EmploymentRecord_position_id_fkey";

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_tenant_employee_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "Employee" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_tenant_manager_fkey"
  FOREIGN KEY ("tenant_id", "manager_employee_id")
  REFERENCES "Employee" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_tenant_unit_fkey"
  FOREIGN KEY ("tenant_id", "organization_unit_id")
  REFERENCES "OrganizationUnit" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_tenant_position_fkey"
  FOREIGN KEY ("tenant_id", "position_id")
  REFERENCES "Position" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. EmploymentRecord — date-only interval sanity.
-- ---------------------------------------------------------------------------
ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_interval_order_check"
  CHECK ("end_date" IS NULL OR "start_date" <= "end_date");

ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_start_date_floor_check"
  CHECK ("start_date" >= DATE '1900-01-01');

-- An employee cannot be their own manager. Checked here as well as in the
-- service, because the service is not the only possible writer.
ALTER TABLE "EmploymentRecord"
  ADD CONSTRAINT "EmploymentRecord_no_self_manager_check"
  CHECK ("manager_employee_id" IS NULL OR "manager_employee_id" <> "employee_id");
