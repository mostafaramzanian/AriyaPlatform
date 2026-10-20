-- Phase W1: declare Inventory's ONE feature (`stock`) and grant it to every
-- tenant that exists at this moment, in the shape of
-- 20261003160300_seed_financial_check_request_feature_entitlement — feature
-- row first, then one grant per tenant, with the same stop-guard.

INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'inventory',
  'stock',
  'Stock Management',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId", "featureId") DO NOTHING;

INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'inventory' AND f."featureId" = 'stock'
ON CONFLICT ("featureRowId", "tenantId") DO NOTHING;

DO $$
DECLARE
  tenant_count integer;
  grant_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO grant_count
  FROM "ModuleFeatureGrant" g
  JOIN "ModuleFeature" f ON f.id = g."featureRowId"
  WHERE f."moduleId" = 'inventory' AND f."featureId" = 'stock';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase W1: inventory feature seed produced % grants for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;
