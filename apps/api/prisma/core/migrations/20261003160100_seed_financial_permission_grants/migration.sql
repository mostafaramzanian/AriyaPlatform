-- Phase F1 — FINANCIAL FOUNDATION: register the three `financial.check.*` permissions in
-- the catalogue and grant them explicitly, in the style of
-- 20261002100100_seed_production_permission_grants.
--
-- WHY THIS MIGRATION EXISTS: RolesGuard resolves a caller's permissions from the
-- "Permission" + "RolePermission" + "Role" tables, so a permission string that only lives
-- in src/auth/rbac/constants/permissions.ts is a permission NOBODY has — every guarded
-- Financial route would 403 for every caller, including SUPER_ADMIN. The rows created
-- here are what make the `@Roles(...)` gates on the Financial controllers real rather
-- than authorization theatre.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH: the Preflight §14 list, no more.
--
--   financial.check.read    — the register, one request, its timeline, its attachments;
--   financial.check.manage  — create, edit while draft/returned, submit, attachments;
--   financial.check.approve — approve, reject, request-correction.
--
-- Deliberately ABSENT (the decision, not an omission): no allocation, document-review,
-- executive-approval, issuance or delivery string — every one of those gates a stage
-- that F1 does not implement, and a permission with no route that would gate on it
-- claims authority before it exists.
--
-- GRANTS ARE NARROW:
--   SUPER_ADMIN -> all three. Holds the full catalogue by definition; the CROSS JOIN over
--                  "Permission" matches RolePermissions[SUPER_ADMIN] in
--                  src/auth/rbac/constants/roles.ts, the shape every earlier grant used.
--   ADMIN       -> all three. The tenant's administrator; the shape HR's, Commerce's and
--                  Production's grants established for a business module's remit.
--   every other role -> NONE. Financial access is opt-in per tenant policy, granted
--                  through the existing role-management surface. No manual SUPER_ADMIN
--                  bypass exists anywhere — the standard authorization path is the only
--                  one.
--
-- PERMISSION ≠ ENTITLEMENT: these rows answer "may this USER act", never "may this TENANT
-- hold the module". The tenant-side question is answered only by
-- "ModuleRegistration" / "ModuleFeature" rows (20261003160200 and 20261003160300), and no
-- row written here touches those tables.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone and
-- a re-run is a no-op.
--
-- NOTE: the 'FINANCIAL' PermissionDomain member is added by the PREVIOUS migration
-- (20261003160000). It must not be added here: PostgreSQL forbids USING a newly added enum
-- value inside the same transaction that added it (SQLSTATE 55P04).

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('production-bom-read' -> 'financial-check-read'); the `name` column is the unique
-- identity these inserts conflict on.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('financial-check-read',
   'financial.check.read',
   'Read Financial Check Requests',
   'FINANCIAL',
   'Read check requests, their lifecycle, their timeline and their attachments within the tenant'),
  ('financial-check-manage',
   'financial.check.manage',
   'Manage Financial Check Requests',
   'FINANCIAL',
   'Create, edit while requester-owned, submit check requests and manage their attachments within the tenant'),
  ('financial-check-approve',
   'financial.check.approve',
   'Approve Financial Check Requests',
   'FINANCIAL',
   'Record the approve, reject or request-correction decision on a check request within the tenant')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the three new permissions.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('financial.check.read', 'financial.check.manage', 'financial.check.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all three, matching the tenant administrator remit HR's, Commerce's and
-- Production's grants established.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('financial.check.read', 'financial.check.manage', 'financial.check.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.
