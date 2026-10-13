-- Phase 55: declare HR's Mission feature and grant it to every existing tenant.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `HR_FEATURE.MISSION` is the id the Mission controller declares with
-- `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.MISSION)`. Without a matching
-- `ModuleFeature` row, every Mission request would become `403 FEATURE_NOT_FOUND`.
-- This migration lights that feature for existing tenants, mirroring the leave
-- feature seed (Phase 54-C).
--
-- The grant is presence-only and state-preserving: a re-run changes nothing, and
-- an operator's own edits to `enabled` are never overwritten.

INSERT INTO "ModuleFeature" (id, "moduleId", "featureId", "displayName", enabled, "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'hr',
  'mission',
  'Mission',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId", "featureId") DO NOTHING;

INSERT INTO "ModuleFeatureGrant" (id, "featureRowId", "tenantId", "grantedAt")
SELECT gen_random_uuid()::text, f.id, t.id, CURRENT_TIMESTAMP
FROM "ModuleFeature" f
CROSS JOIN "Tenant" t
WHERE f."moduleId" = 'hr' AND f."featureId" = 'mission'
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
  WHERE f."moduleId" = 'hr' AND f."featureId" = 'mission';

  IF grant_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase 55: hr/mission grant seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      grant_count, tenant_count;
  END IF;
END $$;
