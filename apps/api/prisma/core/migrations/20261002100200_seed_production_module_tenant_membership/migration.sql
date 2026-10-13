-- Phase PRODUCTION-BOM-HEADER: provision `production` and enumerate every existing tenant's
-- membership explicitly, in the shape of 20260926100200_seed_commerce_module_tenant_membership.
--
-- WHY IT MUST EXIST, AND WHY IT IS SHAPED LIKE COMMERCE'S AND HR'S
-- ----------------------------------------------------------------
-- The brief requires Production to be registered as an INDEPENDENT BOUNDED CONTEXT. The
-- mechanism is `ModuleRegistration` + membership rows, and the pattern's properties are:
-- `enabled = true` on the registration, scope `RESTRICTED_MEMBERS` with an EMPTY
-- `tenantIds` array, one membership row per tenant that exists AT THIS MOMENT, and a
-- stop-guard that refuses to leave a partial enumeration behind. All four are reproduced
-- here verbatim in structure.
--
-- Production has NO UNGATED PAST: its first gated surface (the BOM Header routes) is what
-- this phase ships, and membership in `RESTRICTED_MEMBERS` is deliberately NOT writable
-- through the admin API — a scope edit would be a grant decision in disguise — so a
-- migration is the only auditable way the module ever becomes resolvable for a tenant.
-- NOT seeding would leave `403 MODULE_FORBIDDEN` for everyone with no in-phase path to
-- change it: "Production silently unavailable", which is exactly the failure the brief
-- forbids alongside "every tenant silently entitled". The choice is recorded HERE rather
-- than left implicit in an empty table.
--
-- WHAT IS SEEDED, AND WHAT IS DELIBERATELY NOT
-- ---------------------------------------------
-- The platform's own registry: one registration row and one membership row per existing
-- tenant. NO business configuration of any kind — no BOM, no lifecycle decision, no
-- permission code (those live in 20261002100100), no Product Tree and no Project, because
-- neither domain exists and Production must not own either.
--
-- IDEMPOTENT: both inserts target an existing unique key (`"ModuleRegistration"."moduleId"`,
-- `"ModuleRegistrationTenant"`(registrationId, tenantId)) with `ON CONFLICT ... DO NOTHING`,
-- so a re-run is indistinguishable from a first run and an operator who provisioned by
-- hand first is not overwritten — `DO NOTHING` cannot rewrite a live row's scope,
-- displayName or `enabled`.
--
-- THE STOP-GUARD IS DELIBERATE, for the reason HR's and Commerce's record: the membership
-- insert READS the tenant set (`INSERT ... SELECT` over `"Tenant"`) rather than listing it,
-- and the block at the end compares what it produced against the tenant count at that
-- moment: if a bound this file depends on ever turns out to be smaller than the tenant set,
-- it RAISES AND STOPS. A partial enumeration is never left behind to look complete.

-- The registration. `moduleType = 'BUSINESS'` (Production is one business module, not a
-- Core service), `protocolVersion = 1` (the platform contract version), `enabled = true`
-- (the gate must not refuse the module its own phase is about to wire), four character
-- columns and no credential: this module runs in-process and has no endpoint to
-- authenticate, so the secret columns stay NULL.
INSERT INTO "ModuleRegistration" (
  id, "moduleId", "displayName", "moduleType", enabled, "tenantScope", "tenantIds",
  "protocolVersion", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text,
  'production',
  'Production',
  'BUSINESS',
  true,
  'RESTRICTED_MEMBERS',
  ARRAY[]::TEXT[],
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId") DO NOTHING;

-- The membership: one row per tenant that exists AT THIS MOMENT. `CROSS JOIN` against the
-- single `production` registration row is the shape that makes this "read the tenant set,
-- do not list it": the count is the tenant table's count, not a literal, so the row this
-- file produces is N rows here and a different number on an installation with a different
-- tenant set — and zero on one with no tenants, which is not an error (the module then
-- stays fail-closed for everyone).
INSERT INTO "ModuleRegistrationTenant" (id, "registrationId", "tenantId")
SELECT gen_random_uuid()::text, r.id, t.id
FROM "ModuleRegistration" r
CROSS JOIN "Tenant" t
WHERE r."moduleId" = 'production'
ON CONFLICT ("registrationId", "tenantId") DO NOTHING;

-- The stop-guard, in HR's and Commerce's shape: raises rather than warns — a migration
-- that warns is a migration that finished.
DO $$
DECLARE
  tenant_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO membership_count
  FROM "ModuleRegistrationTenant" mt
  JOIN "ModuleRegistration" r ON r.id = mt."registrationId"
  WHERE r."moduleId" = 'production';

  IF membership_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase PRODUCTION-BOM-HEADER: production membership seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      membership_count, tenant_count;
  END IF;
END $$;