-- Phase 54-C (D14, §43.7): declare HR's ONE feature and grant it to every tenant that
-- exists at this moment. Split from the registration seed of
-- 20260921120300_seed_hr_module_tenant_membership for the same reason the D16 set is
-- split: that file touches membership (a D16 concern), this one touches the feature
-- level (a D14 concern), and the FK on "ModuleFeature.moduleId" means it must run after
-- the registration exists.
--
-- WHY THE FEATURE ROW IS SEEDED AT ALL, AND WHY `enabled = true`
-- -------------------------------------------------------------
-- The HR wiring puts `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)` on the Leave
-- controllers (§43.6). With no "ModuleFeature" row, every Leave request would become
-- `403 FEATURE_NOT_FOUND` — the module would be provisioned and its feature would not,
-- which is exactly the failure the registration seed above exists to prevent, one level
-- down. `enabled = true` says the PLATFORM offers the feature; the per-tenant grant row
-- says which tenancies hold it. The schema default is `false` (fail-closed at storage),
-- so a feature nobody provisions stays dark — this migration is the deliberate act that
-- lights this one.
--
-- WHY THE GRANTS ARE SEEDED FOR EVERY EXISTING TENANT
-- ---------------------------------------------------
-- State-preserving, and the same argument the membership seed makes: today HR Leave has
-- no gate at all, so every existing tenant can use it, and the gate must not take that
-- away. A tenant created after this migration has neither a grant nor a membership row
-- and receives nothing until it is provisioned — fail-closed, deliberately.
--
-- WHO READS THESE ROWS: `PlatformEntitlementService` and nothing else (§43.4). HR
-- declares the requirement and never reads `ModuleFeature` / `ModuleFeatureGrant`.
--
-- IDEMPOTENT: both inserts target an existing unique key (`ModuleFeature(moduleId,
-- featureId)`, `ModuleFeatureGrant(featureRowId, tenantId)`) with `ON CONFLICT ... DO
-- NOTHING`, so a re-run changes nothing and an operator's own edits to `enabled` or
-- `displayName` are never rewritten. No business configuration is seeded: no leave type,
-- no policy, no accrual rule, no working-hours record, no employee, no request.
--
-- THE SAME STOP-GUARD AS THE MEMBERSHIP SEED: the grant insert READS the tenant set
-- (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block at the end
-- compares what it produced against the tenant count at that moment — raising rather
-- than leaving a partial enumeration that looks complete.

-- The feature row. Slug-shaped ids in the same rule as `ModuleRegistration.moduleId`
-- ("ModuleFeature_featureId_format"), and the pair is unique, so this row is the one
-- declaration of `hr`/`leave`.
INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'hr',
  'leave',
  'Leave',
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
-- that is NOT a widening — the module-level check refuses it first
-- (`403 MODULE_FORBIDDEN`), so an unreachable grant is the only thing it could be.
INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'hr' AND f."featureId" = 'leave'
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
  WHERE f."moduleId" = 'hr' AND f."featureId" = 'leave';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase 54-C (D14): hr/leave grant seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;
