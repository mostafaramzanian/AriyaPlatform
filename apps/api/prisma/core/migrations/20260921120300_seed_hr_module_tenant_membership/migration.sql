-- Phase 54-C (D16, §45.6 migration 3): provision `hr` and enumerate every existing
-- tenant's membership explicitly. This is the ONLY file in the D16 set that writes
-- data, and it is the state-preserving act.
--
-- WHY IT MUST EXIST, AND WHY IT MUST BE APPLIED BEFORE THE HR WIRING
-- ------------------------------------------------------------------
-- The moment the entitlement gate lands, `hr` has no "ModuleRegistration" row, so
-- every HR request is `403 MODULE_NOT_FOUND` — verified: no migration in this
-- directory had ever inserted a "ModuleRegistration" row before this one. That
-- fail-closed steady state is correct for a module nobody has provisioned, but it
-- must not become the state of every EXISTING installation as a side effect of
-- adding a gate. `enabled = true` plus an explicit membership enumeration is what
-- keeps working HR working; a tenant created afterwards has no row and receives
-- nothing, which is the fail-closed direction D15 asks for.
--
-- WHY THE SCOPE IS `RESTRICTED_MEMBERS` AND NOT `RESTRICTED`
-- ----------------------------------------------------------
-- This installation has 162 tenants and the legacy `RESTRICTED` branch of
-- "ModuleRegistration_tenantScope_consistent" admits between 1 and 64 ids, so the
-- array cannot express this membership at all. It is not truncated here, HR is not
-- split across several registrations, no overflow rule is invented, and `ALL`
-- (which the frozen comment refuses on the grounds that an empty array silently
-- meaning "everyone" is how a botched write turns a restricted module into a global
-- one) is not used as a fallback. The membership is enumerated in
-- "ModuleRegistrationTenant" — presence is membership — and `tenantIds` is
-- therefore EMPTY, which the replacement CHECK requires.
--
-- WHAT IS SEEDED, AND WHAT IS DELIBERATELY NOT
-- --------------------------------------------
-- The platform's own registry, exactly as "ModuleRegistration" already is: one
-- registration row and one membership row per existing tenant. No business
-- configuration of any kind — no leave policy, no working hours, no accrual rule,
-- no employee, no request, no monetary rule and no new permission code (§39 stop
-- condition 11).
--
-- IDEMPOTENT: both inserts target an existing unique key (`ModuleRegistration.moduleId`,
-- `ModuleRegistrationTenant(registrationId, tenantId)`) with `ON CONFLICT ... DO NOTHING`,
-- so a re-run is indistinguishable from a first run and an operator who provisioned by
-- hand first is not overwritten — `DO NOTHING` cannot rewrite a live row's scope,
-- displayName or `enabled`.
--
-- THE STOP-GUARD IS DELIBERATE. The membership insert READS the tenant set
-- (`INSERT ... SELECT` over "Tenant") rather than listing it, and the block at the end
-- of this file compares what it produced against the tenant count at that moment: if a
-- bound this file depends on ever turns out to be smaller than the tenant set, it
-- RAISES AND STOPS. A partial enumeration is never left behind to look like a complete
-- one, and the direction of the failure is chosen on purpose — a spurious stop is
-- recoverable and visible, a silent truncation is neither.

-- The registration. `moduleType = 'BUSINESS'` (HR is one business module, not a Core
-- service), `protocolVersion = 1` (the platform contract version), `enabled = true`
-- (the gate must not refuse a module that worked before it existed), four character
-- columns and no credential: this module runs in-process and has no endpoint to
-- authenticate, so the secret columns stay NULL — a legal state the frozen
-- "ModuleRegistration_secret_complete" constraint already expresses.
INSERT INTO "ModuleRegistration" (
  id, "moduleId", "displayName", "moduleType", enabled, "tenantScope", "tenantIds",
  "protocolVersion", "createdAt", "updatedAt"
)
VALUES (
  gen_random_uuid()::text,
  'hr',
  'Human Resources',
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
-- `CROSS JOIN` against the single `hr` registration row is the shape that makes this
-- "read the tenant set, do not list it": the count is the tenant table's count, not a
-- literal, so the row this file produces is 162 rows here and a different number on an
-- installation with a different tenant set — and zero on one with no tenants, which is
-- not an error (the module then stays fail-closed for everyone, §45.6).
--
-- The ONE case in which membership rows can exist under a registration whose scope is
-- not `RESTRICTED_MEMBERS` is an operator who provisioned `hr` by hand before this
-- migration ran. Such rows are INERT — the resolver reads the array for a `RESTRICTED`
-- row and has no membership lookup for `ALL` — and this file does not rewrite the
-- operator's row to fit them. Nothing is deleted, and no scope is changed.
INSERT INTO "ModuleRegistrationTenant" (id, "registrationId", "tenantId")
SELECT gen_random_uuid()::text, r.id, t.id
FROM "ModuleRegistration" r
CROSS JOIN "Tenant" t
WHERE r."moduleId" = 'hr'
ON CONFLICT ("registrationId", "tenantId") DO NOTHING;

-- The stop-guard (§43.7's clause, kept as written; §43.10 gate 5, §45.8 seed gate).
-- Raises rather than warns: a migration that warns is a migration that finished.
DO $$
DECLARE
  tenant_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  SELECT count(*) INTO membership_count
  FROM "ModuleRegistrationTenant" mt
  JOIN "ModuleRegistration" r ON r.id = mt."registrationId"
  WHERE r."moduleId" = 'hr';

  IF membership_count <> tenant_count THEN
    RAISE EXCEPTION
      'Phase 54-C (D16): hr membership seed produced % rows for % tenants. Refusing to leave a partial enumeration behind.',
      membership_count, tenant_count;
  END IF;
END $$;
