-- Phase 49H: register the two survey permissions in the catalogue and grant them
-- explicitly, in the style of 20260828093000_seed_admin_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves
-- a caller's permissions from the "Permission" ⟕ "RolePermission" ⟕ "Role" tables,
-- so a permission with no catalogue row is a permission NOBODY has — every
-- guarded survey route would 403 for every caller, including SUPER_ADMIN.
--
-- Grants are deliberately narrow, and are NOT "every ADMIN gets everything":
--   SUPER_ADMIN      → both (it holds the full catalogue by definition)
--   ADMIN            → both (authors surveys and reads results)
--   OPERATIONS_ADMIN → NEITHER. It manages support and system operations; nothing
--                      in its documented remit is survey authorship, and results
--                      contain participant answers.
--   SECURITY_ADMIN   → NEITHER. Audit/security scope, not survey content.
--   every other role → NEITHER.
--
-- PARTICIPATION IS NOT GATED BY EITHER PERMISSION. Answering a published survey
-- in one's own tenant is an authenticated-user capability, enforced by tenant
-- scope + survey status in SurveysService, not by a grant. That is why no
-- 'surveys.participate' row is created: inventing one would imply a
-- revocable-per-role participation model this phase does not build.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-support-manage' → 'admin-surveys-manage').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-surveys-manage', 'admin.surveys.manage', 'Manage Surveys', 'ADMIN', 'Create, edit, publish and close surveys'),
  ('admin-surveys-results', 'admin.surveys.results', 'Read Survey Results', 'ADMIN', 'Read aggregated survey results')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes both survey permissions.
-- CROSS JOIN over "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migration did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('admin.surveys.manage', 'admin.surveys.results')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: both, matching RolePermissions.ADMIN.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('admin.surveys.manage', 'admin.surveys.results')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.
