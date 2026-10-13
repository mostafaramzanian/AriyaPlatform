-- Phase C1 step J: provision `commerce` and enumerate every existing tenant's
-- membership explicitly, in the shape of 20260921120300_seed_hr_module_tenant_membership.
--
-- WHY IT MUST EXIST, AND WHY IT IS SHAPED LIKE HR'S
-- --------------------------------------------------
-- C1 §10: "Commerce module entitlement must use the existing entitlement mechanism", G13:
-- "Use the same proven module/feature entitlement pattern as HR", §17: "Use the real HR
-- migration precedent." The mechanism is "ModuleRegistration" + membership rows, and the
-- pattern's properties are: `enabled = true` on the registration, scope
-- `RESTRICTED_MEMBERS` with an EMPTY `tenantIds` array, one membership row per tenant
-- that exists AT THIS MOMENT, and a stop-guard that refuses to leave a partial
-- enumeration behind. All four are reproduced here verbatim in structure.
--
-- THE DIFFERENCE FROM HR, STATED HONESTLY
-- ----------------------------------------
-- HR's seed was state-preserving: HR Leave had no gate, every tenant could use it, and
-- the gate had to not take that away. Commerce has no ungated past — its first gated
-- surface (C1 step L) does not exist yet at the moment this migration runs. What makes
-- enumeration nonetheless the RIGHT act rather than a guess is that C1 contains no OTHER
-- admission path: membership in `RESTRICTED_MEMBERS` is deliberately NOT writable through
-- the admin API (§45.4 item 5 — a scope edit would be a grant decision in disguise), so a
-- migration is the only auditable way the module ever becomes resolvable for a tenant,
-- while C1's §21 order requires end-to-end purchase behavior on real tenants. The two
-- failure directions are thus weighed explicitly: seeding makes existing tenants able to
-- use Commerce once its routes land (new tenants stay fail-closed, with no row and
-- nothing granted), while NOT seeding would leave `403 MODULE_FORBIDDEN` for everyone
-- with no in-phase path to change it — "Commerce silently unavailable", which the step
-- brief forbids alongside "every tenant silently entitled". The choice is recorded HERE
-- rather than left implicit in an empty table.
--
-- WHAT IS SEEDED, AND WHAT IS DELIBERATELY NOT
-- --------------------------------------------
-- The platform's own registry, exactly as "ModuleRegistration" already is: one
-- registration row and one membership row per existing tenant. No business configuration
-- of any kind — no purchase, no workflow definition, no commercial rule, no approval
-- matrix and no permission code (those live in 20260926100100).
--
-- IDEMPOTENT: both inserts target an existing unique key ("ModuleRegistration"."moduleId",
-- "ModuleRegistrationTenant"(registrationId, tenantId)) with `ON CONFLICT ... DO NOTHING`,
-- so a re-run is indistinguishable from a first run and an operator who provisioned by
-- hand first is not overwritten — `DO NOTHING` cannot rewrite a live row's scope,
-- displayName or `enabled`.
--
-- THE STOP-GUARD IS DELIBERATE, for the reason HR's records: the membership insert READS
-- the tenant set (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block
-- at the end compares what it produced against the tenant count at that moment: if a bound
-- this file depends on ever turns out to be smaller than the tenant set, it RAISES AND
-- STOPS. A partial enumeration is never left behind to look like a complete one.

-- The registration. `moduleType = 'BUSINESS'` (Commerce is one business module, not a
-- Core service), `protocolVersion = 1` (the platform contract version), `enabled = true`
-- (the gate must not refuse the module its own phase is about to wire), four character
-- columns and no credential: this module runs in-process and has no endpoint to
-- authenticate, so the secret columns stay NULL — a legal state the frozen
-- "ModuleRegistration_secret_complete" constraint already expresses.
INSERT INTO "ModuleRegistration" (
  id, "moduleId", "displayName", "moduleType", enabled, "tenantScope", "tenantIds",
  "protocolVersion", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text,
  'commerce',
  'Commerce',
  'BUSINESS',
  true,
  'RESTRICTED_MEMBERS',
  ARRAY[]::TEXT[],
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("moduleId") DO NOTHING;

-- The membership: one row per tenant that exists AT THIS MOMENT.
--
-- `CROSS JOIN` against the single `commerce` registration row is the shape that makes this
-- "read the tenant set, do not list it": the count is the tenant table's count, not a
-- literal, so the row this file produces is N rows here and a different number on an
-- installation with a different tenant set — and zero on one with no tenants, which is
-- not an error (the module then stays fail-closed for everyone).
INSERT INTO "ModuleRegistrationTenant" (id, "registrationId", "tenantId")
SELECT gen_random_uuid()::text, r.id, t.id
FROM "ModuleRegistration" r
CROSS JOIN "Tenant" t
WHERE r."moduleId" = 'commerce'
ON CONFLICT ("registrationId", "tenantId") DO NOTHING;

-- The stop-guard, in HR's shape: raises rather than warns — a migration that warns is a
-- migration that finished.
DO $$
DECLARE
  tenant_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO membership_count
  FROM "ModuleRegistrationTenant" mt
  JOIN "ModuleRegistration" r ON r.id = mt."registrationId"
  WHERE r."moduleId" = 'commerce';

  IF membership_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase C1 step J: commerce membership seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      membership_count, tenant_count;
  END IF;
END $$;