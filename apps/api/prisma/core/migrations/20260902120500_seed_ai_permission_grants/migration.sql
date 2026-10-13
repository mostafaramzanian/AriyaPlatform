-- Phase 49J-0: register the two AI-configuration permissions in the catalogue and
-- grant them explicitly, in the style of 20260830130000_seed_survey_permission_grants.
--
-- Why this migration exists: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from "Permission" ⨝ "RolePermission" ⨝ "Role", so a
-- permission with no catalogue row is a permission NOBODY has — every guarded AI
-- route would 403 for every caller, including SUPER_ADMIN.
--
-- Domain is ADMIN, not a new AI domain: "PermissionDomain" has no AI member and
-- adding one would be an enum change with no other member and no UI grouping to
-- justify it. `admin.ai.*` sits beside `admin.system.settings` semantically —
-- platform configuration.
--
-- Grants are deliberately narrow:
--   SUPER_ADMIN      → both (it holds the full catalogue by definition)
--   ADMIN            → both (platform administration includes AI configuration)
--   OPERATIONS_ADMIN → READ ONLY. It already holds admin.system.read/settings and
--                      needs to see which provider is live when diagnosing, but
--                      writing a provider credential is not in its remit.
--   SECURITY_ADMIN   → NEITHER. Audit/security scope. Notably NOT read either:
--                      the row set is configuration, and granting sight of it
--                      buys nothing since the credential is never returned to
--                      any caller regardless of permission.
--   every other role → NEITHER.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-surveys-manage' → 'admin-ai-manage').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-ai-manage', 'admin.ai.manage', 'Manage AI Providers', 'ADMIN', 'Configure AI providers, models and credentials'),
  ('admin-ai-read', 'admin.ai.read', 'Read AI Configuration', 'ADMIN', 'View configured AI providers and models without credentials')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes both AI permissions.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('admin.ai.manage', 'admin.ai.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching RolePermissions.ADMIN in src/auth/rbac/constants/roles.ts.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('admin.ai.manage', 'admin.ai.read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- OPERATIONS_ADMIN: read only. The absence of 'admin.ai.manage' here is the
-- decision, not an omission.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name = 'admin.ai.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. SECURITY_ADMIN / PARTNER / CUSTOMER / EMPLOYEE / VISITOR
-- hold neither permission.
