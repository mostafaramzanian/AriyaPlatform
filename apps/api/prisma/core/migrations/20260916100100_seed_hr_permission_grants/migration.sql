-- Phase 51-HR-1: register the six HR permissions in the catalogue and grant them
-- explicitly, in the style of 20260912120600_seed_correspondence_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so a
-- permission with no catalogue row is a permission NOBODY has — every guarded HR route
-- would 403 for every caller, including SUPER_ADMIN. The rows created here are what make
-- the @Roles(...) gates on EmployeesController / OrganizationController /
-- PositionsController real.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH
--   hr.employees.read      / hr.employees.manage      — personnel records, employment
--                                                      history, transfer, terminate,
--                                                      rehire.
--   hr.organization.read   / hr.organization.manage   — the unit hierarchy: tree,
--                                                      summary, create, re-parent,
--                                                      rename, (de)activate.
--   hr.positions.read      / hr.positions.manage      — the position catalogue.
--
-- Two levels per aggregate, and no more. Reading personnel data and changing it are
-- genuinely different entitlements; a third level would be authorization theatre because
-- no HR operation exists that a manager may read but not write.
--
-- There is deliberately NO 'hr.use', NO per-unit scoping permission and NO
-- 'hr.employees.terminate'. Self-service (a user viewing their own record) is not built
-- by this phase: "my own record" requires an authoritative employee→login link, which the
-- module supports as `Employee.userId` but which this phase does not treat as a licence
-- to expose a route. Inventing the permission now would imply a surface that is not there.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN      -> all six. Holds the full catalogue by definition; CROSS JOIN over
--                       "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
--                       src/auth/rbac/constants/roles.ts.
--   ADMIN            -> all six. The tenant's HR administrator.
--   OPERATIONS_ADMIN -> NONE. System operations; not personnel administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not personnel records.
--   every other role -> NONE. Personnel access is opt-in per tenant policy, granted
--                       through the existing role-management surface.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone and
-- a re-run is a no-op.
--
-- NOTE: the 'HR' PermissionDomain member is added by the PREVIOUS migration
-- (20260916100000). It must not be added here: PostgreSQL forbids USING a newly added
-- enum value inside the same transaction that added it (SQLSTATE 55P04), so the ALTER and
-- these INSERTs must commit in separate transactions.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-surveys-manage' -> 'correspondence-manage' -> 'hr-employees-read').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('hr-employees-read',       'hr.employees.read',       'Read Employees',              'HR', 'Read personnel records, employment history and org placement within the tenant'),
  ('hr-employees-manage',     'hr.employees.manage',     'Manage Employees',            'HR', 'Create and update personnel records, open employment intervals, terminate and rehire'),
  ('hr-organization-read',    'hr.organization.read',    'Read Organization',           'HR', 'Read the organization unit hierarchy and its employee/position counts'),
  ('hr-organization-manage',  'hr.organization.manage',  'Manage Organization',         'HR', 'Create, re-parent, rename and (de)activate organization units'),
  ('hr-positions-read',       'hr.positions.read',       'Read Positions',              'HR', 'Read the position catalogue within the tenant'),
  ('hr-positions-manage',     'hr.positions.manage',     'Manage Positions',            'HR', 'Create, update and (de)activate positions')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the six new permissions.
-- CROSS JOIN over "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN (
    'hr.employees.read', 'hr.employees.manage',
    'hr.organization.read', 'hr.organization.manage',
    'hr.positions.read', 'hr.positions.manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all six, matching the tenant HR administrator remit.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN (
    'hr.employees.read', 'hr.employees.manage',
    'hr.organization.read', 'hr.organization.manage',
    'hr.positions.read', 'hr.positions.manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.