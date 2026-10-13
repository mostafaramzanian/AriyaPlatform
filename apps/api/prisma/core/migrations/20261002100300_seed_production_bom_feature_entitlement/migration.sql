-- Phase PRODUCTION-BOM-HEADER: declare Production's ONE feature and grant it to every
-- tenant that exists at this moment, in the shape of
-- 20260926100300_seed_commerce_purchase_feature_entitlement. Split from the registration
-- seed of 20261002100200 for the same reason HR's and Commerce's pairs are split: that file
-- touches membership (a registration concern), this one touches the feature level, and the
-- FK on "ModuleFeature"."moduleId" means it must run after the registration exists.
--
-- WHY THE FEATURE ROW IS SEEDED AT ALL, AND WHY `enabled = true`
-- ---------------------------------------------------------------
-- The decision closure declares `PRODUCTION_FEATURE.BOM` beside `PRODUCTION_MODULE_ID` in
-- src/modules/production/production.constants.ts, and the BOM Header controller declares
-- `@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)` from its first route
-- onward. With no "ModuleFeature" row, every BOM request would become 403
-- FEATURE_NOT_FOUND — the module would be provisioned and its feature would not, which is
-- exactly the failure the registration seed above exists to prevent, one level down.
-- `enabled = true` says the PLATFORM offers the feature; the per-tenant grant row says
-- which tenancies hold it. The schema default is `false` (fail-closed at storage), so a
-- feature nobody provisions stays dark — this migration is the deliberate act that lights
-- this one.
--
-- WHY THE GRANTS ARE SEEDED FOR EVERY EXISTING TENANT
-- ---------------------------------------------------
-- The same act as the membership seed, for the reason that file records in full: with this
-- phase's own order requiring a working BOM header end to end and no admin-API path ever
-- granting a `RESTRICTED_MEMBERS` feature (a grant is a migration or nothing), withholding
-- the grant rows here would mean every BOM route refuses every tenant with no in-phase
-- remedy — "Production silently unavailable". A tenant created after this migration has
-- neither a grant nor a membership row and receives nothing until it is provisioned —
-- fail-closed, deliberately, in the direction HR's and Commerce's seeds chose.
--
-- ONE FEATURE, NOT SEVERAL. `bom` is the only feature this phase ships: read / manage /
-- approve are questions of WHO may act within an entitled tenant (20261002100100
-- permissions), not of whether the tenant holds the capability, so they are deliberately not
-- split into features that could be withheld independently of the BOM itself. Product Tree
-- is NOT a feature here: it is an external reference, and a tenant holding BOM without a
-- Product Tree contract is the normal state today (RB-1).
--
-- WHO READS THESE ROWS: `PlatformEntitlementService` and nothing else. Production declares
-- the requirement and never reads "ModuleFeature" / "ModuleFeatureGrant".
--
-- IDEMPOTENT: both inserts target an existing unique key ("ModuleFeature"(moduleId,
-- featureId), "ModuleFeatureGrant"(featureRowId, tenantId)) with `ON CONFLICT ... DO
-- NOTHING`, so a re-run changes nothing and an operator's own edits of `enabled` or
-- `displayName` are never rewritten. No business configuration is seeded: no BOM, no
-- lifecycle state, no Product Tree and no Project.
--
-- THE SAME STOP-GUARD AS THE MEMBERSHIP SEED: the grant insert READS the tenant set
-- (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block at the end
-- compares what it produced against the tenant count at that moment — raising rather than
-- leaving a partial enumeration that looks complete.

-- The feature row. Slug-shaped ids in the same rule as "ModuleRegistration"."moduleId"
-- ("ModuleFeature_featureId_format"), and the pair is unique, so this row is the ONE
-- declaration of `production`/`bom`.
INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'production',
  'bom',
  'BOM',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId", "featureId") DO NOTHING;

-- The grants: one row per tenant that exists AT THIS MOMENT — presence is the grant.
--
-- The `CROSS JOIN` over "Tenant" is what makes the tenant set READ rather than LISTED: the
-- number of rows is the tenant table's count, not a literal, so this file produces one row
-- per tenant here and a different number on another installation. Both sets are identical
-- today because every existing tenant is also a module member; a tenant created between the
-- two seed files would hold a grant without a membership row, and that is NOT a widening —
-- the module-level check refuses it first (403 MODULE_FORBIDDEN), so an unreachable grant
-- is the only thing it could be.
INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'production' AND f."featureId" = 'bom'
ON CONFLICT ("featureRowId", "tenantId") DO NOTHING;

-- The stop-guard, in the same shape as the membership seed's: raises rather than warns,
-- because a migration that warns is a migration that finished.
DO $$
DECLARE
  tenant_count integer;
  grant_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO grant_count
  FROM "ModuleFeatureGrant" g
  JOIN "ModuleFeature" f ON f.id = g."featureRowId"
  WHERE f."moduleId" = 'production' AND f."featureId" = 'bom';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase PRODUCTION-BOM-HEADER: production/bom grant seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;