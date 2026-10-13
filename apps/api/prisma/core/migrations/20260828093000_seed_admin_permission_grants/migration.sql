-- Phase 49D-1: make the fine-grained ADMIN permission catalogue and its role
-- grants reproducible on the Core datasource.
--
-- Background: prisma/migrations/20260729_add_fine_grained_admin_permissions
-- belongs to the legacy single-datasource history (prisma/schema.prisma /
-- DATABASE_URL) and was never part of prisma/core/migrations. It therefore never
-- ran against core_db: the 17 ADMIN permission rows had been inserted by hand at
-- some point, but the RolePermission grants had not. The result was that
-- `admin.users.read` — the gate on GET /users/directory and GET /users/:id — was
-- granted to no role at all, so RolesGuard denied every caller.
--
-- This migration re-states both halves (catalogue + grants) as idempotent
-- INSERT ... ON CONFLICT DO NOTHING so the Core database can be rebuilt from
-- migrations alone. It grants nothing that
-- src/auth/rbac/constants/{permissions,roles}.ts does not already declare for
-- the role: no new permission is invented here, and no role gains a permission
-- outside its documented set.

-- Permission catalogue (ADMIN domain). Ids match the legacy migration so a
-- database that already has these rows is left untouched.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-users-read', 'admin.users.read', 'Read Users', 'ADMIN', 'Read user information'),
  ('admin-users-create', 'admin.users.create', 'Create Users', 'ADMIN', 'Create new users'),
  ('admin-users-update', 'admin.users.update', 'Update Users', 'ADMIN', 'Update user information'),
  ('admin-users-delete', 'admin.users.delete', 'Delete Users', 'ADMIN', 'Delete users'),
  ('admin-roles-read', 'admin.roles.read', 'Read Roles', 'ADMIN', 'Read role information'),
  ('admin-roles-assign', 'admin.roles.assign', 'Assign Roles', 'ADMIN', 'Assign roles to users'),
  ('admin-roles-remove', 'admin.roles.remove', 'Remove Roles', 'ADMIN', 'Remove roles from users'),
  ('admin-roles-permissions', 'admin.roles.permissions', 'Manage Role Permissions', 'ADMIN', 'Manage role permissions'),
  ('admin-system-read', 'admin.system.read', 'Read System Info', 'ADMIN', 'Read system information'),
  ('admin-system-settings', 'admin.system.settings', 'Modify System Settings', 'ADMIN', 'Modify system settings'),
  ('admin-system-maintenance', 'admin.system.maintenance', 'System Maintenance', 'ADMIN', 'Perform system maintenance'),
  ('admin-audit-read', 'admin.audit.read', 'Read Audit Logs', 'ADMIN', 'Read audit logs'),
  ('admin-audit-export', 'admin.audit.export', 'Export Audit Logs', 'ADMIN', 'Export audit logs'),
  ('admin-security-read', 'admin.security.read', 'Read Security Settings', 'ADMIN', 'Read security settings'),
  ('admin-security-manage', 'admin.security.manage', 'Manage Security', 'ADMIN', 'Manage security settings'),
  ('admin-analytics-read', 'admin.analytics.read', 'Read Analytics', 'ADMIN', 'Read analytics data'),
  ('admin-support-manage', 'admin.support.manage', 'Manage Support', 'ADMIN', 'Manage support tickets')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: every permission in the catalogue. Matches
-- ROLE_PERMISSIONS[SUPER_ADMIN] in src/auth/rbac/constants/roles.ts, which is
-- the full set.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: user/role/audit/analytics/support management, exactly the list the
-- legacy migration used.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN (
    'admin.users.read', 'admin.users.create', 'admin.users.update', 'admin.users.delete',
    'admin.roles.read', 'admin.roles.assign', 'admin.roles.remove', 'admin.roles.permissions',
    'admin.audit.read',
    'admin.analytics.read',
    'admin.support.manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- SECURITY_ADMIN
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SECURITY_ADMIN'
  AND p.name IN (
    'admin.security.read', 'admin.security.manage',
    'admin.audit.read', 'admin.audit.export',
    'admin.roles.read',
    'blog.read'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- OPERATIONS_ADMIN
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name IN (
    'admin.system.read', 'admin.system.settings', 'admin.system.maintenance',
    'admin.support.manage',
    'blog.read'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
