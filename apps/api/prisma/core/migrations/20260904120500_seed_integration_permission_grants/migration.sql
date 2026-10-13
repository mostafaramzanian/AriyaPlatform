-- Phase 49L: register the two integration-configuration permissions in the
-- catalogue and grant them explicitly, in the style of
-- 20260902120500_seed_ai_permission_grants (49J-0).
--
-- WHY THIS MIGRATION EXISTS: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from "Permission" ⨝ "RolePermission" ⨝ "Role", so a
-- permission with no catalogue row is a permission NOBODY has — every guarded
-- integration route would 403 for every caller, including SUPER_ADMIN.
--
-- Domain is ADMIN, not a new INTEGRATIONS domain: "PermissionDomain" has no such
-- member and adding one would be an enum change with a single occupant and no UI
-- grouping to justify it. `admin.integrations.*` sits beside `admin.ai.*` and
-- `admin.system.settings` semantically — platform configuration.
--
-- TWO PERMISSIONS, NOT ONE, mirroring the 49J-0 split for the same reason:
-- reading which automation endpoint is live is a diagnostic capability, while
-- writing one — and with it a shared HMAC secret and an outbound destination —
-- is platform administration. Collapsing them would force "can see the
-- integration" to imply "can repoint it and rotate its secret".
--
-- Grants are deliberately narrow:
--   SUPER_ADMIN      → both (it holds the full catalogue by definition)
--   ADMIN            → both (platform administration includes automation)
--   OPERATIONS_ADMIN → READ ONLY. It already holds admin.system.read/settings and
--                      admin.ai.read and needs to see whether automation is
--                      reaching the engine when diagnosing; changing an outbound
--                      destination is not in its remit.
--   SECURITY_ADMIN   → NEITHER. Audit/security scope. Notably not read either:
--                      the secret is never returned to any caller regardless of
--                      permission, so sight of the row buys nothing.
--   every other role → NEITHER. A regular user must not manage global integration
--                      credentials (§28).
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-ai-manage' → 'admin-integrations-manage').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-integrations-manage', 'admin.integrations.manage', 'Manage Integrations', 'ADMIN', 'Configure automation integrations, endpoints and webhook secrets'),
  ('admin-integrations-read', 'admin.integrations.read', 'Read Integrations', 'ADMIN', 'View configured integrations and automation execution status without secrets')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes both integration permissions.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('admin.integrations.manage', 'admin.integrations.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching RolePermissions.ADMIN in src/auth/rbac/constants/roles.ts.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('admin.integrations.manage', 'admin.integrations.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- OPERATIONS_ADMIN: read only. The absence of 'admin.integrations.manage' here is
-- the decision, not an omission.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name = 'admin.integrations.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. SECURITY_ADMIN / PARTNER / CUSTOMER / EMPLOYEE / VISITOR
-- hold neither permission.
