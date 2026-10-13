-- Phase 51-HR-3A: the leave REQUEST and the leave-TYPE catalogue — `hr_db`.
--
-- WHAT THIS MIGRATION CREATES, AND WHAT IT REFUSES TO CREATE
-- ---------------------------------------------------------
-- Two tables and one enum:
--
--   LeaveType     the tenant's OWN catalogue: `code`, `name` and a lifecycle
--                 (ACTIVE / INACTIVE — the existing `HrRecordStatus`, reused rather than
--                 duplicated, because "may be used now while remaining addressable" is
--                 exactly a catalogue entry's lifecycle).
--   LeaveRequest  one employee, one type of the SAME tenant, an inclusive
--                 `start_date`..`end_date` range, a stated `reason` and a status.
--   LeaveRequestStatus  TWO members: PENDING and CANCELLED.
--
-- WHY THERE IS NO APPROVED / REJECTED MEMBER, AND NO `approver_id` COLUMN
-- ----------------------------------------------------------------------
-- No authoritative approval rule exists in this repository. The readiness audit
-- (`docs/reports/PHASE_51-HR_READINESS_AUDIT.md` §9) sketches `hr.leave.approve` as
-- "approve/reject FOR THE REPORTING SUBTREE", and the reporting subtree is a
-- server-side traversal that does not exist — the module already refused that same
-- kind of permission in writing (`20260918130000_seed_hr_attendance_permission_grants`:
-- "a permission that claims subtree authority before the traversal exists would be the
-- widest kind of lie — it would be GRANTED"). A decision state nobody can legitimately
-- write is not a placeholder; it is a lie with a column name.
--
-- So this phase implements the ONE transition that needs no new policy at all:
-- PENDING -> CANCELLED, by the operator who holds the tenant's leave permission, through
-- the ordinary HR authorization model. `APPROVED` / `REJECTED` arrive in a later phase
-- with their authority, their transition table, their permission and its Core seed row —
-- all in ONE change, which is the maintenance contract written into the schema section
-- header and into `src/modules/hr/domain/leave-status.ts`.
--
-- WHY THE TYPE CATALOGUE GETS NO SEED DATA
-- ---------------------------------------
-- This migration inserts NOTHING. Which leave kinds an organization grants, and what
-- each one entitles a person to, is that organization's own policy: a taxonomy invented
-- here would be worn as a default by every tenant that did not replace it, and a default
-- that affects somebody's pay is not a convenience. The tenant names its own types
-- through the module's catalogue endpoints.

--
-- WHAT IS DELIBERATELY ABSENT, EACH BECAUSE IT IS A POLICY NOT YET DECIDED
-- ----------------------------------------------------------------------
--   * no balance / entitlement / accrual / carry-over column (§13);
--   * no half-day, hourly or minute granularity — a request is a whole-day range;
--   * no overlap constraint. "Leave must not overlap another leave" is audit §13's
--     PROPOSAL; a constraint installed before that rule is agreed would refuse legitimate
--     rows (a corrected request, a re-recorded range) in the name of a policy nobody
--     approved. The ranges are stored RAW so the rule can be evaluated later against real
--     data, and a later migration can add the constraint with a deliberate backfill
--     decision instead of an accidental one;
--   * no workday or holiday arithmetic, and no stored `duration_days`;
--   * no Jalali `date_key`: a leave RANGE spans months, so one day key would have to pick
--     an end of it and then disagree with the other. Jalali rendering is derived at the
--     boundary by `calendar/jalali.util`;
--   * no attendance column, trigger or path into `Attendance`. Deciding leave must never
--     mutate or delete a punch; the two domains meet in a READER, not here;
--   * no Core identity column, no `tenant`/`role`/`permission` table, and no audit table.
--     §49 keeps ONE trail, in the Core database, written through the platform audit
--     contract.
--
-- THE SIX GUARANTEES POSTGRES HOLDS, NOT THE SERVICE
-- --------------------------------------------------
--   1. SAME-TENANT EMPLOYEE. `LeaveRequest_tenant_employee_fkey` is a composite key over
--      `(tenant_id, employee_id)` pointing at `Employee(tenant_id, id)`.
--   2. SAME-TENANT LEAVE TYPE. `LeaveRequest_tenant_leave_type_fkey` is a composite key
--      over `(tenant_id, leave_type_id)` pointing at `LeaveType(tenant_id, id)`. A bare
--      uuid foreign key would let one tenant's request cite another tenant's type, and no
--      service-side check can make that impossible for the NEXT writer.
--   3. THE RANGE IS ORDERED. `LeaveRequest_period_check` refuses `end_date < start_date`.
--      The service refuses the same thing with a 400 before it writes, so this is not the
--      caller's error message — it is the guarantee that no future writer, migration or
--      manual `UPDATE` can leave an inverted range in the register. A single-day request
--      is legal and is the ordinary case.
--   4. A REQUEST STATES WHY. `LeaveRequest_reason_check` refuses a blank reason (after
--      trimming), because a request nobody can act on and nobody can audit is not a
--      request. `LeaveType_name_check` refuses a blank catalogue name for the same reason:
--      a type that renders as nothing cannot be chosen.
--   5. THE STATUS AND ITS TIMESTAMP AGREE, BOTH WAYS.
--      `LeaveRequest_cancelled_state_check` is `(status = 'CANCELLED') = (cancelled_at IS
--      NOT NULL)`, so a CANCELLED row with no timestamp AND a PENDING row carrying one are
--      both unwritable. This is the discipline the Letter table documents for its own
--      status/timestamp pairs, and it is what makes "when was this withdrawn?" a question
--      the row can always answer.
--   6. A CODE IS A CODE. `LeaveType_code_check` restates the normalization contract
--      `Employee.employeeCode` documents — Latin uppercase, letters/digits and `. _ / -`,
--      1…64 characters — so a hand-written row cannot invent a spelling no normaliser
--      would ever produce and no lookup would ever match.
--
-- `ON DELETE RESTRICT`, NOT CASCADE. Deleting an employee — or a Core identity, which no
-- foreign key can even express here — must never erase leave history (§10), and a leave
-- TYPE that has ever been requested cannot be removed out from under its own rows, which
-- is why retirement is a STATUS. `ON UPDATE CASCADE` keeps the composite keys consistent
-- if a tenant or an id ever changes, matching every other HR foreign key.
--
-- This is the FIRST migration that mentions leave, so it creates the enum, the two
-- tables, the indexes and the constraints outright. It is applied by
-- `npm run prisma:migrate:hr` against `hr_db` alone; the permission rows the routes are
-- gated on live in the OTHER database and are seeded by a Core migration of their own.

-- ---------------------------------------------------------------------------
-- 1. The two states a request can be in — and only two.
--
--    A closed enum with exactly the members a WRITER can produce. `APPROVED` and
--    `REJECTED` are absent deliberately (see the header): an enum member that no code
--    path can reach is a promise this table does not keep, and adding a member later —
--    with its CHECK and its transition table in the SAME migration — is cheaper and
--    safer than removing one that rows already carry.
-- ---------------------------------------------------------------------------
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- 2. The tenant's own leave-type catalogue.
--
--    `status` is the EXISTING `HrRecordStatus` (ACTIVE / INACTIVE), reused rather than
--    duplicated: it already means "may be used now, while remaining addressable for
--    everything that cites it", which is exactly a catalogue entry's lifecycle.
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveType" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "HrRecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- Tenant-aware code uniqueness: two tenants may each own `ANNUAL`, one tenant may not
-- own two. `LeaveType_tenantId_id_key` exists only to be the TARGET of the composite
-- foreign key below; no query uses it alone.
CREATE UNIQUE INDEX "LeaveType_tenantId_code_key" ON "LeaveType"("tenant_id", "code");

CREATE UNIQUE INDEX "LeaveType_tenantId_id_key" ON "LeaveType"("tenant_id", "id");

-- Deterministic catalogue ordering and the "active types only" read the request form
-- issues.
CREATE INDEX "LeaveType_tenantId_status_code_idx" ON "LeaveType"("tenant_id", "status", "code");

-- `code` is the tenant's own key for a leave kind, and it is spelled the way every HR
-- code is spelled. Restating the contract in the database is what stops a hand-written
-- row from inventing a spelling no normaliser would produce and no lookup would match.
ALTER TABLE "LeaveType"
  ADD CONSTRAINT "LeaveType_code_check"
  CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._/-]{0,63}$');

-- A catalogue entry that renders as nothing cannot be chosen, so a blank name is refused
-- here as well as in the DTO. `btrim` so whitespace is not a name.
ALTER TABLE "LeaveType"
  ADD CONSTRAINT "LeaveType_name_check"
  CHECK (length(btrim("name")) > 0);

-- ---------------------------------------------------------------------------
-- 3. The leave request itself.
--
--    `start_date` / `end_date` are DATE — a request is a claim about CALENDAR DAYS, and
--    an instant would make the stored day depend on the caller's timezone. Both bounds
--    are INCLUSIVE, and `end_date = start_date` is the ordinary single-day request.
--
--    `cancelled_at` is nullable because PENDING is the state a row is BORN in; the CHECK
--    below ties it to `status` in both directions.
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveRequest" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- The composite-key target for the two same-tenant foreign keys below; no query uses it
-- alone.
CREATE UNIQUE INDEX "LeaveRequest_tenantId_id_key" ON "LeaveRequest"("tenant_id", "id");

-- The register read: the tenant's requests in a state, earliest day first.
CREATE INDEX "LeaveRequest_tenantId_status_startDate_idx"
  ON "LeaveRequest"("tenant_id", "status", "start_date");

-- "This person's requests", tenant-qualified so ONE index serves both the per-person read
-- and the tenant-wide one.
CREATE INDEX "LeaveRequest_tenantId_employeeId_startDate_idx"
  ON "LeaveRequest"("tenant_id", "employee_id", "start_date");

-- "What has been asked for of this type" — the read a later report groups by.
CREATE INDEX "LeaveRequest_tenantId_leaveTypeId_startDate_idx"
  ON "LeaveRequest"("tenant_id", "leave_type_id", "start_date");

-- ---------------------------------------------------------------------------
-- 4. SAME-TENANT EVERYTHING — guarantees 1 and 2.
--
--    Composite keys, exactly like the ones guarding `Attendance` and the employment
--    graph: a request can only name an employee AND a leave type of ITS OWN tenant, and
--    that is true for a writer that bypasses `LeaveService` entirely. A bare uuid foreign
--    key would let one tenant's request cite another tenant's type.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_tenant_employee_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "Employee" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_tenant_leave_type_fkey"
  FOREIGN KEY ("tenant_id", "leave_type_id")
  REFERENCES "LeaveType" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. The CHECKs — guarantees 3, 4 and 5 (the catalogue's two are declared with it above).
-- ---------------------------------------------------------------------------

-- An inverted range is not a request. `end_date = start_date` IS one, and is the ordinary
-- single-day case.
ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_period_check"
  CHECK ("end_date" >= "start_date");

-- A request states WHY. `btrim` so a reason of spaces is not a reason — the same rule
-- `Attendance_manual_reason_check` applies to a correction.
ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_reason_check"
  CHECK (length(btrim("reason")) > 0);

-- The status and its timestamp agree in BOTH directions: no CANCELLED row without a
-- withdrawal instant, and no instant on a row that is still pending. This is what makes
-- "when was this withdrawn?" a question the row can always answer, and it is the shape
-- the Letter table documents for its own status/timestamp pairs.
ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_cancelled_state_check"
  CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));