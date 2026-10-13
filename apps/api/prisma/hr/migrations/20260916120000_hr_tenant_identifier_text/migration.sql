-- Phase 51-HR-2: the HR tenant identifier must be TEXT, because the PLATFORM's tenant
-- identifier is text.
--
-- WHAT WAS WRONG
-- --------------
-- `20260916063713_hr_baseline` created `tenant_id` as UUID in all four HR tables. Core
-- owns the tenant identifier, in Core's own tenant table, and that column is TEXT — it is
-- not a uuid: the platform's own seeded tenant is literally `tenant-test-1`. The
-- correspondence module (50-MOD-CORR), which is the precedent this module was written
-- against, stores `tenantId` as TEXT in all seven of its tables for exactly this reason.
--
-- The consequence was not theoretical. `RequestContextService` resolves the actor's
-- tenant from the authenticated principal, so an HR request made by a member of
-- `tenant-test-1` carried `tenantId = 'tenant-test-1'` into `WHERE tenant_id = $1`, and
-- PostgreSQL rejected it with 22P02 (`invalid input syntax for type uuid`). Every HR
-- route — reads included — returned a 500 for every tenant whose identifier is not
-- uuid-shaped, while the same code worked for tenants that happened to have uuid
-- identifiers. A tenant-identity mismatch that only some tenants can observe is the
-- worst shape a tenancy bug can have.
--
-- Found by Phase 51-HR-2's real-activation pass: the phase's own browser journey logs in
-- as the platform's seeded administrator (`admin@localhost`, tenant `tenant-test-1`) and
-- calls the HR API, which is the exact combination the uuid column could not serve.
--
-- WHY THE FIX IS A WIDENING CAST, NOT A REWRITE
-- --------------------------------------------
-- `uuid::text` is lossless and total: every value that satisfied the uuid column becomes
-- its canonical text form, and every value the platform can produce is now storable. No
-- HR row is rewritten, no tenant is remapped, no identifier changes — after this
-- migration the same tenant simply has the same identifier in a column that can hold it.
--
-- The cast cannot fail and cannot lose data. The four tables were also empty when this
-- ran (HR shipped in 51-HR-1 and nothing had written to `hr_db` yet), but the migration
-- does not rely on that: it is correct on a populated database too.
--
-- WHAT ELSE HAD TO MOVE WITH IT
-- -----------------------------
-- PostgreSQL refuses to change the type of a column that participates in a foreign key,
-- so the six SAME-TENANT composite foreign keys from
-- `20260916080000_hr_temporal_and_tenancy_guards` are dropped and re-added with byte-
-- identical definitions (`ON DELETE RESTRICT ON UPDATE CASCADE`). The unique indexes
-- those foreign keys point at are rebuilt automatically by the type change and keep
-- their names, so the composite keys still prove same-tenant references — the guarantee
-- is unchanged, only the column type it is expressed on.
--
-- The EXCLUDE overlap constraint, the three CHECK constraints and the
-- `OrganizationUnit_no_cycle_guard` trigger do not reference `tenant_id` (the trigger's
-- lookup compares `u."tenant_id" = NEW."tenant_id"`, which is text = text after this
-- migration), so they are deliberately left untouched.

-- THE SAME REPRESENTATION QUESTION APPLIES TO `Employee.user_id`
-- --------------------------------------------------------------
-- `Employee.userId` holds a Core identity id, and that column is TEXT as well: the
-- platform's seeded administrator is literally `super-admin-user`. HR's own contract
-- requires a UUID v4 for `userId` (`@IsUUID('4')` in `CreateEmployeeDto`), so TODAY no API
-- call can store a non-uuid id there and this ALTER fixes NO observed failure — the
-- sentences above about a 500 on the write path are deliberately not repeated here,
-- because nothing exercised it.
--
-- It is made in the same migration because the two columns are ONE decision: HR stores the
-- PLATFORM's identifiers, so it must store them in the platform's representation. Leaving
-- the Core reference uuid-shaped while the tenant beside it is text would make the type of
-- an identifier depend on whether its value happens to look like a uuid — and the next id
-- HR has to store (a Core id, a legacy personnel code, a tenant code) has no such
-- guarantee. The cast is lossless; `user_id` carries no foreign key (deliberately, §14),
-- so only its ordinary index is rebuilt.

-- ---------------------------------------------------------------------------
-- 1. Drop the six same-tenant foreign keys (they are re-added below).
-- ---------------------------------------------------------------------------
ALTER TABLE "OrganizationUnit" DROP CONSTRAINT "OrganizationUnit_tenant_parent_fkey";
ALTER TABLE "Position" DROP CONSTRAINT "Position_tenant_unit_fkey";
ALTER TABLE "EmploymentRecord" DROP CONSTRAINT "EmploymentRecord_tenant_employee_fkey";
ALTER TABLE "EmploymentRecord" DROP CONSTRAINT "EmploymentRecord_tenant_manager_fkey";
ALTER TABLE "EmploymentRecord" DROP CONSTRAINT "EmploymentRecord_tenant_unit_fkey";
ALTER TABLE "EmploymentRecord" DROP CONSTRAINT "EmploymentRecord_tenant_position_fkey";

-- ---------------------------------------------------------------------------
-- 2. Widen the tenant identifier to TEXT on every HR table that carries one.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrganizationUnit"
  ALTER COLUMN "tenant_id" TYPE TEXT USING "tenant_id"::text;
ALTER TABLE "Position"
  ALTER COLUMN "tenant_id" TYPE TEXT USING "tenant_id"::text;
ALTER TABLE "EmploymentRecord"
  ALTER COLUMN "tenant_id" TYPE TEXT USING "tenant_id"::text;
ALTER TABLE "Employee"
  ALTER COLUMN "tenant_id" TYPE TEXT USING "tenant_id"::text;
-- The Core identity reference, in Core's own representation (see the header).
ALTER TABLE "Employee"
  ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::text;

-- ---------------------------------------------------------------------------
-- 3. Restore the same-tenant foreign keys, verbatim.
--
--    These are the real cross-tenant guarantee: a position cannot name a unit of
--    another tenant, and an interval cannot name an employee, manager, unit or position
--    of another tenant — enforced by PostgreSQL, not by a service convention.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrganizationUnit"
  ADD CONSTRAINT "OrganizationUnit_tenant_parent_fkey"
  FOREIGN KEY ("tenant_id", "parent_id")
  REFERENCES "OrganizationUnit" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Position"
  ADD CONSTRAINT "Position_tenant_unit_fkey"
  FOREIGN KEY ("tenant_id", "organization_unit_id")
  REFERENCES "OrganizationUnit" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

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