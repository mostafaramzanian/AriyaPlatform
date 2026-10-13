-- Phase 51-HR-3: register the TWO attendance permissions in the catalogue and grant
-- them explicitly, in the style of 20260916100100_seed_hr_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so a
-- permission with no catalogue row is a permission NOBODY has — every attendance route
-- would 403 for every caller, including SUPER_ADMIN. The rows created here are what
-- make the @Roles(...) gates on AttendanceController real.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH
--   hr.attendance.read    — the register: a page of day rows, one row by id, filtered
--                           by employee, Gregorian day range and source.
--   hr.attendance.manage  — the punches: open a day (clock-in), close it (clock-out)
--                           and record the one MANUAL correction a day may carry.
--
-- TWO LEVELS, AND NO MORE — the same rule the other HR aggregates follow. Reading a
-- register and writing to it are genuinely different entitlements (an analyst needs
-- the first without the second), and a third level would be authorization theatre:
-- there is no attendance operation here that a manager may read but not write.
--
-- WHY THE AUDIT'S PROPOSED `hr.attendance.read.self` / `.read.team` ARE NOT HERE
-- -----------------------------------------------------------------------------
-- §9 of the readiness audit proposes three attendance permissions, two of them
-- scoped: "own attendance" and "reporting-subtree read". Neither is buildable in this
-- phase, and a permission nobody can be granted into a working route is exactly the
-- "*.use" theatre the Phase 50 comment in permissions.ts warns about:
--   * SELF-SERVICE needs an authoritative employee→login link. HR stores `userId` as
--     an optional, non-unique identifier and the module deliberately exposes no
--     "my own record" route on that basis (see the note in 20260916100100 and in
--     `hr-actor.ts`). Gating a route that does not exist would imply a surface that
--     is not there.
--   * TEAM SCOPE needs the reporting subtree derived server-side (risk R6, MEDIUM):
--     `managerEmployeeId` on the open employment interval is a start, not a
--     traversal, and a permission that claims subtree authority before the traversal
--     exists would be the widest kind of lie — it would be GRANTED.
-- Both arrive with their surface, in the phase that builds it.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN      -> both. Holds the full catalogue by definition; CROSS JOIN over
--                       "Permission" matches RolePermissions[SUPER_ADMIN] in
--                       src/auth/rbac/constants/roles.ts.
--   ADMIN            -> both. The tenant's HR administrator.
--   OPERATIONS_ADMIN -> NONE. System operations; not personnel administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not personnel records.
--   every other role -> NONE. Attendance access is opt-in per tenant policy, granted
--                       through the existing role-management surface.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone and
-- a re-run is a no-op. The 'HR' PermissionDomain member already exists (added by
-- 20260916100000), so no ALTER is needed here — and none may be: PostgreSQL forbids
-- USING a freshly added enum value inside the transaction that added it (SQLSTATE 55P04).

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('hr-positions-read' -> 'hr-attendance-read').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('hr-attendance-read',   'hr.attendance.read',   'Read Attendance',   'HR', 'Read the attendance register: day rows by employee, Gregorian day range and source'),
  ('hr-attendance-manage', 'hr.attendance.manage', 'Manage Attendance', 'HR', 'Record clock-in and clock-out, and record the MANUAL correction a day may carry')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the two new permissions.
-- CROSS JOIN over "Permission" matches RolePermissions[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('hr.attendance.read', 'hr.attendance.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching the tenant HR administrator remit.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('hr.attendance.read', 'hr.attendance.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.