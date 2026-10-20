-- Phase W1: register the three `inventory.*` permissions and grant them, in
-- the shape of 20261003160100_seed_financial_permission_grants.
--
--   inventory.read    — registers, balances, movements, reconciliation;
--   inventory.manage  — warehouses, locations, items/units, receipts, issues,
--                       adjustments, reversals, transfers, count data-entry;
--   inventory.approve — posting a stock count's variances.
--
-- Grants: SUPER_ADMIN and ADMIN only — opt-in per tenant policy, exactly the
-- remit every earlier business module's grant recorded. The 'INVENTORY'
-- PermissionDomain member is added by the PREVIOUS migration (55P04 rule).

INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('inventory-read',
   'inventory.read',
   'Read Inventory',
   'INVENTORY',
   'Read warehouses, locations, items, stock balances, the movement ledger and reconciliation within the tenant'),
  ('inventory-manage',
   'inventory.manage',
   'Manage Inventory',
   'INVENTORY',
   'Manage warehouses, locations, items and unit ratios; post receipts, issues, adjustments, reversals, transfers and count entries within the tenant'),
  ('inventory-approve',
   'inventory.approve',
   'Approve Inventory Variances',
   'INVENTORY',
   'Post stock-count variances — the act that writes balance-effecting ledger rows from another actor''s count within the tenant')
ON CONFLICT (name) DO NOTHING;

INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('inventory.read', 'inventory.manage', 'inventory.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('inventory.read', 'inventory.manage', 'inventory.approve')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
