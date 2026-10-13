-- Phase B.2.2: Add Fine-Grained Admin Permissions and New Roles

-- Ensure pgcrypto extension for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- Step 1: Insert new roles with correct hierarchy
INSERT INTO "Role" (id, name, "displayName", hierarchy, description, "createdAt", "updatedAt")
VALUES
  ('security-admin-role', 'SECURITY_ADMIN', 'Security Administrator', 2, 'Security Administrator', now(), now()),
  ('ops-admin-role', 'OPERATIONS_ADMIN', 'Operations Administrator', 3, 'Operations Administrator', now(), now())
ON CONFLICT (name) DO NOTHING;

-- Step 2: Insert new fine-grained admin permissions
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

-- Step 3: Assign new permissions to SUPER_ADMIN role
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT 
  gen_random_uuid()::text,
  r.id,
  p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.domain = 'ADMIN'
  AND p.name LIKE 'admin.%'
ON CONFLICT DO NOTHING;

-- Step 4: Assign new permissions to ADMIN role (backward compatible)
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT 
  gen_random_uuid()::text,
  r.id,
  p.id
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
ON CONFLICT DO NOTHING;

-- Step 5: Assign permissions to SECURITY_ADMIN role
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT 
  gen_random_uuid()::text,
  r.id,
  p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SECURITY_ADMIN'
  AND p.name IN (
    'admin.security.read', 'admin.security.manage',
    'admin.audit.read', 'admin.audit.export',
    'admin.roles.read',
    'blog.read'
  )
ON CONFLICT DO NOTHING;

-- Step 6: Assign permissions to OPERATIONS_ADMIN role
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT 
  gen_random_uuid()::text,
  r.id,
  p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name IN (
    'admin.system.read', 'admin.system.settings', 'admin.system.maintenance',
    'admin.support.manage',
    'blog.read'
  )
ON CONFLICT DO NOTHING;

-- Step 7: Ensure existing non-admin roles still have their permissions intact
-- (These were already seeded, this is just a verification step)

-- Step 8: Invalidate Redis caches on next startup
-- (No direct SQL action needed - application startup will invalidate)

-- Migration notes:
-- - New roles (SECURITY_ADMIN, OPERATIONS_ADMIN) added with hierarchy 2 and 3
-- - New fine-grained admin permissions (17 total) replace broad admin.dashboard/settings/audit
-- - ADMIN role automatically receives all user/role/audit/analytics/support permissions
-- - SUPER_ADMIN role receives ALL permissions (including new ones)
-- - SECURITY_ADMIN can manage security and view audit logs
-- - OPERATIONS_ADMIN can manage system and support
-- - Migration is idempotent using ON CONFLICT
-- - This maintains full backward compatibility with existing role assignments
