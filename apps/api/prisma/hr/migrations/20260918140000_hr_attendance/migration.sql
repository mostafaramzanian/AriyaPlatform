-- Phase 51-HR-3: the attendance register — `Attendance` in `hr_db`.
--
-- WHAT THIS MIGRATION CREATES, AND WHAT IT REFUSES TO CREATE
-- ---------------------------------------------------------
-- One table: ONE ROW PER EMPLOYEE PER WORK DAY, holding the day's punch window
-- (`clock_in` → `clock_out`), the day it belongs to (`work_date` in the Gregorian
-- calendar, `date_key` in the Jalali calendar), the SOURCE that produced it
-- (`DEVICE` = the punch, `MANUAL` = an operator's correction) and, for a
-- correction, the operator's sanitized `reason`.
--
-- Deliberately ABSENT, each for a reason recorded in `prisma/hr/schema.prisma`:
--   * no day `status` (present/late/absent/leave/mission/holiday/weekend) — §13
--     requires it to be COMPUTED from the punch window, the shift and the calendar,
--     so a stored column would be a second answer that can disagree with the facts
--     it came from;
--   * no `shift_id`, `overtime_minutes`, `late_minutes`, `worked_minutes` — every
--     one is derived (§13/§14) and every one needs a shift and a calendar that do
--     not exist yet;
--   * no Core identity column, no `tenant`/`user`/`role` table, no audit table.
--     §49 keeps ONE trail, in the Core database; HR writes to it through the platform
--     audit contract and never to its own tables.
--
-- THE THREE GUARANTEES POSTGRES HOLDS, NOT THE SERVICE
-- ---------------------------------------------------
--   1. SAME-TENANT EMPLOYEE. `Attendance_tenant_employee_fkey` is a composite key
--      over `(tenant_id, employee_id)` pointing at `Employee(tenant_id, id)` —
--      exactly the shape of the six composite keys that already guard the employment
--      graph. A row can therefore only name an employee of ITS OWN tenant, and that
--      is true for a writer that bypasses `AttendanceService` entirely. It is
--      written here (rather than created as a plain FK and converted afterwards, the
--      way `20260916080000_hr_temporal_and_tenancy_guards` had to do it) because
--      this table has no earlier history to preserve.
--   2. A DAY CANNOT CLOSE BEFORE IT OPENS. `Attendance_punch_order_check` refuses
--      `clock_out <= clock_in`. The service refuses the same thing with a 400 before
--      it writes, so this is not the caller's error message — it is the guarantee
--      that no future writer, migration or manual `UPDATE` can leave a negative day
--      in the register.
--   3. A CORRECTION STATES WHY. `Attendance_manual_reason_check` refuses a `MANUAL`
--      row with no `reason`, and `Attendance_date_key_check` refuses a `date_key`
--      that is not `YYYY/MM/DD`. The first is §13's "MANUAL source rows carrying
--      actor + sanitized reason + audit event": the reason is part of what a
--      correction IS, not a nice-to-have field. The second is the format half of
--      "`date_key` is derived by `jalali.util`", so a hand-written row cannot invent
--      a spelling that no report grouping would ever match.
--
-- `ON DELETE RESTRICT`, NOT CASCADE. Deleting an employee — or a Core identity, which
-- no foreign key can even express here — must never erase attendance history (§10).
-- `ON UPDATE CASCADE` keeps the composite key consistent if a tenant or employee id
-- ever changes, matching every other HR foreign key.
--
-- This is the FIRST migration that mentions `Attendance`, so it creates the enum,
-- the table, the indexes and the constraints outright. It is applied by
-- `npm run prisma:migrate:hr` against `hr_db` alone; the permission rows the routes are
-- gated on live in the OTHER database and are seeded by a Core migration of their own.

-- ---------------------------------------------------------------------------
-- 1. The source enum. Two members — the punch and the correction (§13). A third
--    (a device id, an import batch, a self-service marker) is deliberately not
--    declared: no code path can produce it, and an enum member nothing writes is a
--    promise the register does not keep.
-- ---------------------------------------------------------------------------
CREATE TYPE "AttendanceSource" AS ENUM ('DEVICE', 'MANUAL');

-- ---------------------------------------------------------------------------
-- 2. The register.
-- ---------------------------------------------------------------------------
CREATE TABLE "Attendance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "date_key" VARCHAR(10) NOT NULL,
    "clock_in" TIMESTAMPTZ(6) NOT NULL,
    "clock_out" TIMESTAMPTZ(6),
    "source" "AttendanceSource" NOT NULL DEFAULT 'DEVICE',
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. Identity and access paths.
--
--    `Attendance_tenantId_employeeId_workDate_source_key` IS the row's identity:
--    one day, one employee, one source. It is what turns a repeated clock-in into a
--    409 rather than a second row, and what makes a correction an idempotent UPSERT
--    (create the MANUAL row once, then SET it) with no read-then-write race.
--
--    `Attendance_tenantId_id_key` exists only to be the TARGET of the composite
--    foreign key below; no query uses it alone.
--
--    The two indexes are the two reads §13 names: the Jalali-month register
--    (`(tenant_id, date_key)`) and the per-person register
--    (`(tenant_id, employee_id, date_key)`).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Attendance_tenantId_employeeId_workDate_source_key"
  ON "Attendance"("tenant_id", "employee_id", "work_date", "source");

CREATE UNIQUE INDEX "Attendance_tenantId_id_key" ON "Attendance"("tenant_id", "id");

CREATE INDEX "Attendance_tenantId_dateKey_idx" ON "Attendance"("tenant_id", "date_key");

CREATE INDEX "Attendance_tenantId_employeeId_dateKey_idx"
  ON "Attendance"("tenant_id", "employee_id", "date_key");

-- ---------------------------------------------------------------------------
-- 4. SAME-TENANT employee — guarantee 1 above.
-- ---------------------------------------------------------------------------
ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_tenant_employee_fkey"
  FOREIGN KEY ("tenant_id", "employee_id")
  REFERENCES "Employee" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. The three CHECKs — guarantees 2 and 3 above.
-- ---------------------------------------------------------------------------
ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_punch_order_check"
  CHECK ("clock_out" IS NULL OR "clock_out" > "clock_in");

ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_manual_reason_check"
  CHECK ("source" <> 'MANUAL' OR "reason" IS NOT NULL);

-- `YYYY/MM/DD`, Latin digits — the exact wire format `formatJalaliDateKey` emits and
-- `parseJalaliDateKey` accepts. Enforced here because the format is what makes
-- "group by the Jalali month" a string prefix operation, and because a `date_key`
-- that no parser can read is data no report can ever surface.
ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_date_key_check"
  CHECK ("date_key" ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}$');