-- Phase W1: register `inventory` in the platform's module registry and
-- enumerate every existing tenant's membership, in the shape of
-- 20261003160200_seed_financial_module_tenant_membership — one registration,
-- RESTRICTED_MEMBERS with an explicit row per tenant, and the same stop-guard
-- that refuses to leave a partial enumeration behind.

INSERT INTO "ModuleRegistration" (
  id, "moduleId", "displayName", "moduleType", enabled, "tenantScope", "tenantIds",
  "protocolVersion", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text,
  'inventory',
  'Inventory',
  'BUSINESS',
  true,
  'RESTRICTED_MEMBERS',
  ARRAY[]::TEXT[],
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId") DO NOTHING;

INSERT INTO "ModuleRegistrationTenant" (id, "registrationId", "tenantId")
SELECT gen_random_uuid()::text, r.id, t.id
FROM "ModuleRegistration" r
CROSS JOIN "Tenant" t
WHERE r."moduleId" = 'inventory'
ON CONFLICT ("registrationId", "tenantId") DO NOTHING;

DO $$
DECLARE
  tenant_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO membership_count
  FROM "ModuleRegistrationTenant" mt
  JOIN "ModuleRegistration" r ON r.id = mt."registrationId"
  WHERE r."moduleId" = 'inventory';

  IF membership_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase W1: inventory membership seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      membership_count, tenant_count;
  END IF;
END $$;
