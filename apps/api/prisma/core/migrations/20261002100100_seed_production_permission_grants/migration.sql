-- Phase PRODUCTION-BOM-HEADER: register the three `production.*` permissions in the
-- catalogue and grant them explicitly, in the style of
-- 20260926100100_seed_commerce_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so a
-- permission with no catalogue row is a permission NOBODY has — every guarded Production
-- route would 403 for every caller, including SUPER_ADMIN. The rows created here are what
-- will make the `@Roles(...)` gates on the Production controllers real rather than
-- authorization theatre.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH: the decision closure's §17.3 list, no more.
--
--   production.bom.read    — the BOM list and detail routes;
--   production.bom.manage  — create, edit-while-draft, submit (the authorship remit);
--   production.bom.approve — approve, reject, request-correction (the DECIDING remit).
--
-- The names are the closure's own, and the three are deliberately split the way
-- `commerce.read` / `commerce.manage` / `commerce.approve` are split: reading a register
-- is not authoring it, and authoring it is not deciding it. Deliberately ABSENT (the
-- decision, not an omission): a fourth string — no `production.config`, no per-project,
-- per-product-tree or per-state scoping — because no route in this phase asks for one,
-- and a permission with no route that would gate on it claims authority before it exists.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN -> all three. Holds the full catalogue by definition; CROSS JOIN over
--                  "Permission" matches RolePermissions[SUPER_ADMIN] in
--                  src/auth/rbac/constants/roles.ts, the shape every earlier grant
--                  migration used.
--   ADMIN       -> all three. The tenant's administrator; the shape the HR and Commerce
--                  grants established for a business module's remit.
--   OPERATIONS_ADMIN -> NONE. System operations; not BOM administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not BOM approval.
--   every other role  -> NONE. BOM access is opt-in per tenant policy, granted through the
--                        existing role-management surface.
--
-- PERMISSION ≠ ENTITLEMENT: these rows answer "may this USER act", never "may this TENANT
-- hold the module". The tenant-side question is answered only by
-- "ModuleRegistration"/"ModuleFeature" rows (20261002100200 and 20261002100300), and no
-- row written here touches those tables. Holding all three strings still refuses a request
-- whose tenancy is not entitled — the §5 two-layer model.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone and
-- a re-run is a no-op.
--
-- NOTE: the 'PRODUCTION' PermissionDomain member is added by the PREVIOUS migration
-- (20261002100000). It must not be added here: PostgreSQL forbids USING a newly added enum
-- value inside the same transaction that added it (SQLSTATE 55P04), so the ALTER and these
-- INSERTs must commit in separate transactions.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('commerce-read' -> 'production-bom-read'); the `name` column is the unique identity
-- these inserts conflict on.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('production-bom-read',
   'production.bom.read',
   'Read Production BOM',
   'PRODUCTION',
   'Read BOM headers and their lifecycle within the tenant'),
  ('production-bom-manage',
   'production.bom.manage',
   'Manage Production BOM',
   'PRODUCTION',
   'Create, edit while draft and submit BOM headers within the tenant'),
  ('production-bom-approve',
   'production.bom.approve',
   'Approve Production BOM',
   'PRODUCTION',
   'Record the approval, rejection or correction decision on a BOM header within the tenant')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the three new permissions.
-- CROSS JOIN over "Permission" matches RolePermissions[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('production.bom.read', 'production.bom.manage', 'production.bom.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all three, matching the tenant administrator remit the HR and Commerce grants
-- established.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('production.bom.read', 'production.bom.manage', 'production.bom.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.