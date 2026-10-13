-- Phase F1 — FINANCIAL FOUNDATION: provision `financial` and enumerate every existing
-- tenant's membership explicitly, in the shape of
-- 20261002100200_seed_production_module_tenant_membership.
--
-- WHY IT MUST EXIST: the brief requires Financial to be registered as an INDEPENDENT
-- BOUNDED CONTEXT. The mechanism is `ModuleRegistration` + membership rows: `enabled =
-- true` on the registration, scope `RESTRICTED_MEMBERS` with an EMPTY `tenantIds` array,
-- one membership row per tenant that exists AT THIS MOMENT, and a stop-guard that refuses
-- to leave a partial enumeration behind. All four are reproduced here verbatim in
-- structure, exactly as HR, Commerce and Production each did in their own phase.
--
-- Financial has NO UNGATED PAST: its first gated surface (the check-request routes) is
-- what this phase ships, and membership in `RESTRICTED_MEMBERS` is deliberately NOT
-- writable through the admin API — a scope edit would be a grant decision in disguise —
-- so a migration is the only auditable way the module ever becomes resolvable for a
-- tenant. NOT seeding would leave `403 MODULE_FORBIDDEN` for everyone with no in-phase
-- path to change it: "Financial silently unavailable", which is exactly the failure the
-- brief forbids alongside "every tenant silently entitled".
--
-- WHAT IS SEEDED, AND WHAT IS DELIBERATELY NOT
-- ---------------------------------------------
-- The platform's own registry: one registration row and one membership row per existing
-- tenant. NO business configuration of any kind — no check request, no lifecycle
-- decision, no permission code (those live in 20261003160100), no bank, no cheque, no
-- purchase and no project, because none of those domains exists in this context.
--
-- IDEMPOTENT: both inserts target an existing unique key (`"ModuleRegistration"."moduleId"`,
-- `"ModuleRegistrationTenant"`(registrationId, tenantId)) with `ON CONFLICT ... DO NOTHING`,
-- so a re-run is indistinguishable from a first run and an operator who provisioned by
-- hand first is not overwritten.
--
-- THE STOP-GUARD IS DELIBERATE, for the reason HR's, Commerce's and Production's record:
-- the membership insert READS the tenant set (`INSERT ... SELECT` over `"Tenant"`) rather
-- than listing it, and the block at the end compares what it produced against the tenant
-- count at that moment: if a bound this file depends on ever turns out to be smaller than
-- the tenant set, it RAISES AND STOPS. A partial enumeration is never left behind to look
-- complete.

-- The registration. `moduleType = 'BUSINESS'` (Financial is one business module, not a
-- Core service), `protocolVersion = 1`, `enabled = true` (the gate must not refuse the
-- module its own phase is about to wire), and no credential: this module runs in-process
-- and has no endpoint to authenticate, so the secret columns stay NULL.
INSERT INTO "ModuleRegistration" (
  id, "moduleId", "displayName", "moduleType", enabled, "tenantScope", "tenantIds",
  "protocolVersion", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text,
  'financial',
  'Financial',
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
-- single `financial` registration row is the shape that makes this "read the tenant set,
-- do not list it": zero tenants produce zero rows and that is not an error (the module
-- then stays fail-closed for everyone).
INSERT INTO "ModuleRegistrationTenant" (id, "registrationId", "tenantId")
SELECT gen_random_uuid()::text, r.id, t.id
FROM "ModuleRegistration" r
CROSS JOIN "Tenant" t
WHERE r."moduleId" = 'financial'
ON CONFLICT ("registrationId", "tenantId") DO NOTHING;

-- The stop-guard, in HR's, Commerce's and Production's shape: raises rather than warns —
-- a migration that warns is a migration that finished.
DO $$
DECLARE
  tenant_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO membership_count
  FROM "ModuleRegistrationTenant" mt
  JOIN "ModuleRegistration" r ON r.id = mt."registrationId"
  WHERE r."moduleId" = 'financial';

  IF membership_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase F1 — FINANCIAL FOUNDATION: financial membership seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      membership_count, tenant_count;
  END IF;
END $$;
