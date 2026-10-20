-- SUPPLIER DIRECTORY permission: register `commerce.supplier.manage` in the
-- catalogue and grant it, in the style of
-- 20260926100100_seed_commerce_permission_grants and
-- 20261002100100_seed_production_permission_grants.
--
-- WHY THIS MIGRATION EXISTS AT ALL: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard
-- resolves a caller's permissions from the "Permission" + "RolePermission" +
-- "Role" tables, so a permission with no catalogue row is a permission NOBODY
-- has — every supplier-manage route would 403 for every caller, including
-- SUPER_ADMIN. This row is what makes the `@Roles(Permissions.COMMERCE_SUPPLIER_MANAGE)`
-- gates on the supplier controller real rather than authorization theatre.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH:
--
--   commerce.supplier.manage — create and update supplier directory rows, and
--                              read the SENSITIVE BANKING projection (SHEBA,
--                              card, national code, bank name) of one supplier.
--
-- WHY A SEVENTH COMMERCE PERMISSION RATHER THAN REUSING `commerce.commercial.manage`:
-- the supplier directory is a reusable master register whose banking fields the
-- business requirements explicitly ring-fence; folding that remit into the
-- quotation/assignment permission would hand every commercial actor the keys to
-- supplier bank details. The split mirrors how Production separated read from
-- manage and Financial its check stages: reading the directory (`commerce.read`)
-- is not administering it, and administering it is not reading banking data.
--
-- GRANTS ARE NARROW:
--   SUPER_ADMIN -> the permission. Holds the full catalogue by definition
--                  (the shape every earlier grant migration used).
--   ADMIN       -> the permission. The tenant's administrator; the shape the
--                  HR and Commerce grants established for a business module's
--                  remit.
--   every other role -> NONE. Supplier administration is opt-in per tenant
--                  policy, granted through the existing role-management surface.
--
-- PERMISSION ≠ ENTITLEMENT: these rows answer "may this USER act", never "may
-- this TENANT hold the module" — the two-layer model. Holding this string still
-- refuses a request whose tenancy is not entitled to the commerce module.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op. The 'COMMERCE' PermissionDomain member already
-- exists (20260926100100), so no enum change happens here — PostgreSQL would
-- anyway forbid USING a newly added enum value inside the transaction that
-- added it (SQLSTATE 55P04).

-- Permission catalogue row. The id follows the existing hyphenated convention
-- ('commerce-read' -> 'commerce-supplier-manage'); the `name` column is the
-- unique identity the insert conflicts on.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('commerce-supplier-manage',
   'commerce.supplier.manage',
   'Manage Commerce Suppliers',
   'COMMERCE',
   'Create and update the tenant supplier directory, and read supplier banking details, within the tenant')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN grant. `id` follows the convention every earlier grant
-- migration used (20261004160000): gen_random_uuid()::text.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name = 'commerce.supplier.manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN grant.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name = 'commerce.supplier.manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
