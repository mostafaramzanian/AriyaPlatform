-- Phase F1 — FINANCIAL FOUNDATION: declare Financial's ONE feature and grant it to every
-- tenant that exists at this moment, in the shape of
-- 20261002100300_seed_production_bom_feature_entitlement. Split from the registration seed
-- of 20261003160200 for the same reason every earlier pair is split: that file touches
-- membership (a registration concern), this one touches the feature level, and the FK on
-- "ModuleFeature"."moduleId" means it must run after the registration exists.
--
-- WHY THE FEATURE ROW IS SEEDED AT ALL: `FINANCIAL_FEATURE.CHECK_REQUEST` is declared
-- beside `FINANCIAL_MODULE_ID` in src/modules/financial/financial.constants.ts, and the
-- check-request controller declares
-- `@RequiresFeature(FINANCIAL_MODULE_ID, FINANCIAL_FEATURE.CHECK_REQUEST)` from its first
-- route onward. With no "ModuleFeature" row, every request would become 403
-- FEATURE_NOT_FOUND — the module provisioned and its feature not, which is exactly the
-- failure the registration seed exists to prevent, one level down. `enabled = true` says
-- the PLATFORM offers the feature; the per-tenant grant rows say which tenancies hold it.
--
-- ONE FEATURE, NOT SEVERAL. `check-request` is the only capability this phase ships:
-- read / manage / approve are questions of WHO may act within an entitled tenant
-- (20261003160100 permissions), not of whether the tenant holds the capability.
--
-- WHO READS THESE ROWS: `PlatformEntitlementService` and nothing else. Financial declares
-- the requirement and never reads "ModuleFeature" / "ModuleFeatureGrant".
--
-- IDEMPOTENT: both inserts target an existing unique key with `ON CONFLICT ... DO
-- NOTHING`, so a re-run changes nothing and an operator's own edits of `enabled` or
-- `displayName` are never rewritten. No business configuration is seeded.
--
-- THE SAME STOP-GUARD AS THE MEMBERSHIP SEED: the grant insert READS the tenant set
-- (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block at the end
-- compares what it produced against the tenant count at that moment — raising rather than
-- leaving a partial enumeration that looks complete.

-- The feature row. Slug-shaped ids in the same rule as "ModuleRegistration"."moduleId";
-- the pair (moduleId, featureId) is unique, so this row is the ONE declaration of
-- `financial`/`check-request`.
INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'financial',
  'check-request',
  'Check Request',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId", "featureId") DO NOTHING;

-- The grants: one row per tenant that exists AT THIS MOMENT — presence is the grant.
INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'financial' AND f."featureId" = 'check-request'
ON CONFLICT ("featureRowId", "tenantId") DO NOTHING;

-- The stop-guard: raises rather than warns, because a migration that warns is a migration
-- that finished.
DO $$
DECLARE
  tenant_count integer;
  grant_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO grant_count
  FROM "ModuleFeatureGrant" g
  JOIN "ModuleFeature" f ON f.id = g."featureRowId"
  WHERE f."moduleId" = 'financial' AND f."featureId" = 'check-request';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase F1 — FINANCIAL FOUNDATION: financial/check-request grant seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;
