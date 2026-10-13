-- Phase C1 step J: declare Commerce's ONE feature and grant it to every tenant that
-- exists at this moment, in the shape of
-- 20260921120400_seed_hr_leave_feature_entitlement. Split from the registration seed of
-- 20260926100200 for the same reason HR's pair is split: that file touches membership
-- (a registration concern), this one touches the feature level, and the FK on
-- "ModuleFeature"."moduleId" means it must run after the registration exists.
--
-- WHY THE FEATURE ROW IS SEEDED AT ALL, AND WHY `enabled = true`
-- -------------------------------------------------------------
-- G13 declares `COMMERCE_FEATURE` beside `COMMERCE_MODULE_ID` in
-- src/modules/commerce/commerce.constants.ts, and the purchase controllers (C1 step L)
-- will declare `@RequiresFeature('commerce', 'purchase')` from their first route onward.
-- With no "ModuleFeature" row, every purchase request would become 403 FEATURE_NOT_FOUND
-- — the module would be provisioned and its feature would not, which is exactly the
-- failure the registration seed above exists to prevent, one level down. `enabled = true`
-- says the PLATFORM offers the feature; the per-tenant grant row says which tenancies
-- hold it. The schema default is `false` (fail-closed at storage), so a feature nobody
-- provisions stays dark — this migration is the deliberate act that lights this one.
--
-- WHY THE GRANTS ARE SEEDED FOR EVERY EXISTING TENANT
-- ---------------------------------------------------
-- The same act as the membership seed, for the reason that file records in full: with
-- C1's own §21 order requiring purchase end-to-end behavior and no admin-API path ever
-- granting a `RESTRICTED_MEMBERS` feature (a grant is a migration or nothing, §45.4),
-- withholding the grant rows here would mean every purchase route refuses every tenant
-- with no in-phase remedy — "Commerce silently unavailable". A tenant created after this
-- migration has neither a grant nor a membership row and receives nothing until it is
-- provisioned — fail-closed, deliberately, in the direction HR's seed chose.
--
-- ONE FEATURE, NOT SEVERAL. `purchase` is the only C1 feature: workflow configuration
-- and the commercial acts are questions of WHO may act within an entitled tenant (§10
-- permissions), not of whether the tenant holds the capability, so they are deliberately
-- not split into features that could be withheld independently of purchases.
--
-- WHO READS THESE ROWS: `PlatformEntitlementService` and nothing else (§43.4). Commerce
-- declares the requirement and never reads "ModuleFeature" / "ModuleFeatureGrant".
--
-- IDEMPOTENT: both inserts target an existing unique key ("ModuleFeature"(moduleId,
-- featureId), "ModuleFeatureGrant"(featureRowId, tenantId)) with `ON CONFLICT ... DO
-- NOTHING`, so a re-run changes nothing and an operator's own edits of `enabled` or
-- `displayName` are never rewritten. No business configuration is seeded: no purchase, no
-- workflow definition, no step, no commercial rule.
--
-- THE SAME STOP-GUARD AS THE MEMBERSHIP SEED: the grant insert READS the tenant set
-- (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block at the end
-- compares what it produced against the tenant count at that moment — raising rather than
-- leaving a partial enumeration that looks complete.

-- The feature row. Slug-shaped ids in the same rule as "ModuleRegistration"."moduleId"
-- ("ModuleFeature_featureId_format"), and the pair is unique, so this row is the one
-- declaration of `commerce`/`purchase`.
INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'commerce',
  'purchase',
  'Purchase',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId", "featureId") DO NOTHING;

-- The grants: one row per tenant that exists AT THIS MOMENT — presence is the grant.
--
-- The `CROSS JOIN` over "Tenant" is what makes the tenant set READ rather than LISTED:
-- the number of rows is the tenant table's count, not a literal, so this file produces
-- one row per tenant here and a different number on another installation. Both sets are
-- identical today because every existing tenant is also a module member; a tenant
-- created between the two seed files would hold a grant without a membership row, and
-- that is NOT a widening — the module-level check refuses it first (403
-- MODULE_FORBIDDEN), so an unreachable grant is the only thing it could be.
INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'commerce' AND f."featureId" = 'purchase'
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
  WHERE f."moduleId" = 'commerce' AND f."featureId" = 'purchase';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase C1 step J: commerce/purchase grant seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;