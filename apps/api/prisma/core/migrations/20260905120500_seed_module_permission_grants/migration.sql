-- Phase 49M: register the two module-platform permissions in the catalogue and
-- grant them explicitly, in the style of 20260904120500_seed_integration_permission_grants
-- (49L) and 20260902120500_seed_ai_permission_grants (49J-0).
--
-- WHY THIS MIGRATION EXISTS: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from "Permission" ⨝ "RolePermission" ⨝ "Role", so a
-- permission with no catalogue row is a permission NOBODY has — every guarded
-- module route would 403 for every caller, including SUPER_ADMIN.
--
-- Domain is ADMIN, not a new MODULES domain: "PermissionDomain" has no such member
-- and adding one would be an enum change with a single occupant and no UI grouping
-- to justify it. `admin.modules.*` sits beside `admin.integrations.*`, `admin.ai.*`
-- and `admin.system.settings` semantically — platform configuration.
--
-- TWO PERMISSIONS, NOT ONE, and the same split as 49L for the same reason: reading
-- which modules are registered and whether they are healthy is a DIAGNOSTIC
-- capability, while registering a module, enabling one, changing its tenant scope or
-- rotating its credential is PLATFORM ADMINISTRATION. Collapsing them would force
-- "can see the module list" to imply "can admit a new module to the platform".
--
-- §32 says: admin-only management, and NO module-level permissions for users in 49M.
-- Neither string below names a module, a capability or a business action — a module's
-- own business permissions are owned by that module, not by this registry.
--
-- Grants are deliberately narrow:
--   SUPER_ADMIN      → both (it holds the full catalogue by definition)
--   ADMIN            → both (platform administration includes the module registry)
--   OPERATIONS_ADMIN → READ ONLY. It already holds admin.system.read/settings,
--                      admin.ai.read and admin.integrations.read and needs to see
--                      whether a module is reachable when diagnosing; admitting a
--                      module or rotating its credential is not in its remit.
--   SECURITY_ADMIN   → NEITHER. Audit/security scope. Notably not read either: the
--                      credential is never returned to any caller regardless of
--                      permission, so sight of the row buys nothing.
--   every other role → NEITHER. A regular user must not manage the module registry.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-integrations-manage' → 'admin-modules-manage').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-modules-manage', 'admin.modules.manage', 'Manage Modules', 'ADMIN', 'Register modules, enable or disable them, set tenant scope and rotate module credentials'),
  ('admin-modules-read', 'admin.modules.read', 'Read Modules', 'ADMIN', 'View registered modules, instances, capabilities and health without credentials')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes both module permissions.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('admin.modules.manage', 'admin.modules.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching RolePermissions.ADMIN in src/auth/rbac/constants/roles.ts.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('admin.modules.manage', 'admin.modules.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- OPERATIONS_ADMIN: read only. The absence of 'admin.modules.manage' here is the
-- decision, not an omission.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name = 'admin.modules.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. SECURITY_ADMIN / PARTNER / CUSTOMER / EMPLOYEE / VISITOR hold
-- neither permission.
