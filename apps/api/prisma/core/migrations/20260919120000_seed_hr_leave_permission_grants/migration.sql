-- Phase 51-HR-3A: register the TWO leave permissions in the catalogue and grant them
-- explicitly, in the style of 20260918130000_seed_hr_attendance_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so a
-- permission with no catalogue row is a permission NOBODY has — every leave route would
-- 403 for every caller, including SUPER_ADMIN. The rows created here are what make the
-- @Roles(...) gates on LeaveController and LeaveTypesController real.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH
--   hr.leave.read    — the leave register and the leave-type catalogue: a page of
--                      requests, one request by id, a page of types, one type by id.
--   hr.leave.manage  — record a request, restate or withdraw a PENDING one, and create,
--                      rename or retire a leave type.
--
-- TWO LEVELS, AND NO MORE — the same rule the other HR aggregates follow. Reading leave
-- and changing it are genuinely different entitlements (an analyst needs the first
-- without the second), and a third level would be authorization theatre: there is no
-- leave operation here that a manager may read but not write.
--
-- ONE PAIR COVERS BOTH AGGREGATES, DELIBERATELY. `LeaveType` is the catalogue the
-- request must name, so "who may record a leave request" and "who may state which leave
-- kinds exist" are the same administrative role — a tenant that appointed two different
-- people to those two jobs does not exist yet, and inventing `hr.leave_types.manage`
-- before it does would be a permission granted into nothing.
--
-- WHY THERE IS NO `hr.leave.approve` HERE
-- ---------------------------------------
-- The readiness audit (§9) proposes `hr.leave.approve` as "approve/reject for the
-- reporting subtree", and §19 of the phase brief names it as the candidate. It is
-- deliberately ABSENT, for exactly the reason recorded in
-- 20260918130000_seed_hr_attendance_permission_grants when the same kind of permission
-- was refused for attendance:
--   * NO APPROVAL RULE EXISTS in this repository, and the authority the audit names is a
--     REPORTING SUBTREE that is not derived anywhere. `managerEmployeeId` on the open
--     employment interval is a start, not a traversal (risk R6, MEDIUM), and a permission
--     that claims subtree authority before the traversal exists would be the widest kind
--     of lie — it would be GRANTED;
--   * there is no APPROVED / REJECTED state for it to gate (see the LeaveRequestStatus
--     enum), so the permission would gate an empty set of operations.
-- It arrives with its surface: the decision state, its transition table, its CHECK and
-- its permission, in ONE change, in the phase that builds approval.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN      -> both. Holds the full catalogue by definition; CROSS JOIN over
--                       "Permission" matches RolePermissions[SUPER_ADMIN] in
--                       src/auth/rbac/constants/roles.ts.
--   ADMIN            -> both. The tenant's HR administrator.
--   OPERATIONS_ADMIN -> NONE. System operations; not personnel administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not personnel records.
--   every other role -> NONE. Leave access is opt-in per tenant policy, granted through
--                       the existing role-management surface.
--
-- Idempotent (ON CONFLICT DO NOTHING) so the Core database can be rebuilt from migrations
-- alone and a re-run is a no-op. The 'HR' PermissionDomain member already exists (added by
-- 20260916100000), so no ALTER is needed here — and none may be: PostgreSQL forbids USING
-- a freshly added enum value inside the transaction that added it (SQLSTATE 55P04).

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('hr-attendance-read' -> 'hr-leave-read').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('hr-leave-read',   'hr.leave.read',   'Read Leave',   'HR', 'Read leave requests and the tenant leave-type catalogue'),
  ('hr-leave-manage', 'hr.leave.manage', 'Manage Leave', 'HR', 'Record, restate and withdraw leave requests, and maintain the leave-type catalogue')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the two new permissions.
-- CROSS JOIN over "Permission" matches RolePermissions[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('hr.leave.read', 'hr.leave.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching the tenant HR administrator remit.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('hr.leave.read', 'hr.leave.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.