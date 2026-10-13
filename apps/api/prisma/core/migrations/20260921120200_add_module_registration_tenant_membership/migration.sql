-- Phase 54-C (D16, §45.4 items 2 and 3, §45.5, §45.6 migration 2): the
-- authoritative membership source for an `RESTRICTED_MEMBERS` registration.
--
-- Adds ONE table, its unique key, its index and TWO foreign keys, and replaces ONE
-- constraint on "ModuleRegistration" — with the *same name*, so the constraint a
-- reader greps for (`ModuleRegistration_tenantScope_consistent`) is still the
-- constraint that exists. No column is added to any existing table: the two
-- back-relations §45.5 names (`tenantMembers` on "ModuleRegistration",
-- `moduleMemberships` on "Tenant") are Prisma relation fields only, so no existing
-- row is rewritten and there is no `ALTER ... ADD COLUMN` in this file.
--
-- WHY A CHILD TABLE RATHER THAN A BIGGER ARRAY
-- --------------------------------------------
-- The legacy array is bounded at 64 by a frozen CHECK, and raising that bound would
-- change the meaning of every existing `RESTRICTED` row. The child table answers the
-- other way round: `RESTRICTED` keeps its bound and its meaning for every module that
-- is not `RESTRICTED_MEMBERS` — not raised, not removed, not re-scoped — and a module
-- whose membership is enumerated explicitly says so in its own scope. There is
-- therefore exactly one membership source per registration: `ALL` has none (the scope
-- is the answer), `RESTRICTED` reads the array, `RESTRICTED_MEMBERS` reads this table.
--
-- PRESENCE IS MEMBERSHIP. One row = this tenant is entitled to this module. There is
-- no `enabled` column for the same reason "ModuleFeatureGrant" has none: a second
-- state on a membership row is what makes "member but disabled" storable and forces
-- the resolver to decide which state wins. Absence is not-membership, and it is
-- fail-closed — a tenant created after provisioning has no row and receives nothing.
--
-- WHY THE TENANT ID IS STORED HERE WHEN THE REGISTRY REFUSES TO STORE IDS ELSEWHERE
-- --------------------------------------------------------------------------------
-- `ModuleRegistryService` deliberately reports a COUNT, never the ids, for the legacy
-- array. This table is the exception and the exception is its purpose: it exists to
-- record which customers are entitled, so the tenant id is the row's subject rather
-- than a piece of exposure.
--
-- DELIBERATELY ABSENT: no "ModuleRegistrationTenant" actor column (who provisioned is
-- in "AuditLog", the rule "ModuleRegistration" and "IntegrationConfig" follow), no
-- operator endpoint or UI for editing these rows (§45.9 keeps provisioning an operator
-- act against a Core-owned table), and no billing/subscription/pricing/metering
-- column of any kind.
--
-- ADDITIVE EXCEPT FOR ONE CONSTRAINT REPLACEMENT, WHICH WIDENS AND NARROWS NOTHING.
-- The `DROP CONSTRAINT` below is the only `DROP` in this amendment: every row that
-- satisfied the frozen constraint satisfies the replacement, because the two original
-- branches are copied verbatim and a third branch is added. No data is destroyed, no
-- accepted set is narrowed, and no `DROP TABLE`/`DELETE`/`TRUNCATE` appears here.

CREATE TABLE "ModuleRegistrationTenant" (
    "id" TEXT NOT NULL,

    -- The registration whose membership this row enumerates. CASCADE: a membership
    -- row is meaningless without its module, the same reasoning the internal
    -- "ModuleInstance" -> "ModuleRegistration" FK records.
    "registrationId" TEXT NOT NULL,

    -- A real tenant, by foreign key, not by convention. §24's cross-database FK
    -- prohibition is untouched: "Tenant" is `core_db`'s own registry.
    "tenantId" TEXT NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleRegistrationTenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleRegistrationTenant_tenantId_idx" ON "ModuleRegistrationTenant"("tenantId");

-- CreateIndex
-- The unique key makes "the same tenant cannot hold the same module twice" a database
-- fact rather than a convention (D16-13), and makes the provisioning migration
-- idempotent: its insert targets this key with `ON CONFLICT ... DO NOTHING`.
CREATE UNIQUE INDEX "ModuleRegistrationTenant_registrationId_tenantId_key"
  ON "ModuleRegistrationTenant"("registrationId", "tenantId");

-- AddForeignKey
-- CASCADE on both parents, the repository's own convention for this parent and for
-- "Tenant"-referencing rows (§45.5 inspects the live semantics before choosing it:
-- `ModuleInstance` -> `ModuleRegistration` is CASCADE, `Lead` -> `Tenant` is CASCADE,
-- while the two `RESTRICT`s in the core schema protect a machine-identity record
-- rather than a row about a tenant). The accepted consequence is stated rather than
-- buried: deleting a tenant removes its membership rows, and a tenant re-created under
-- a new id starts UNENTITLED — the same fail-closed direction as the rest of this layer.
ALTER TABLE "ModuleRegistrationTenant" ADD CONSTRAINT "ModuleRegistrationTenant_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "ModuleRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModuleRegistrationTenant" ADD CONSTRAINT "ModuleRegistrationTenant_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- The one constraint replacement: ModuleRegistration_tenantScope_consistent
-- ============================================================================
--
-- SAME NAME, THREE BRANCHES, NOTHING NARROWED. The ALL branch and the
-- `RESTRICTED ... BETWEEN 1 AND 64` branch below are byte-identical to the frozen
-- constraint of 20260905120000 (L164-L168); one branch is added. Three consequences,
-- each the reason this is safe:
--   * every row that satisfied the old constraint satisfies this one, so no live row
--     can fail validation when this runs and nothing is rewritten;
--   * the legacy cap is untouched — not raised to 128, not removed — so `RESTRICTED`
--     keeps its meaning for every module that is not `RESTRICTED_MEMBERS`;
--   * "restricted to nobody" stays UNREPRESENTABLE for `RESTRICTED` (a zero-length
--     array is still rejected) and becomes representable only as an
--     `RESTRICTED_MEMBERS` row with zero membership rows — exactly the fail-closed
--     state, never a state that silently means "everyone".
--
-- The added branch exists so that a row cannot carry TWO membership sources at once: an
-- `RESTRICTED_MEMBERS` row with a non-empty `tenantIds` would hold one enumerated set in
-- the child table and another in the array, and the resolver would have to decide which
-- wins. Requiring the array to be empty keeps "one membership source per row" a
-- database fact. The replacement is a DROP + ADD under the same name, so the constraint
-- a reader greps for is still the constraint that exists.
ALTER TABLE "ModuleRegistration" DROP CONSTRAINT "ModuleRegistration_tenantScope_consistent";

ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_tenantScope_consistent"
  CHECK (
    ("tenantScope" = 'ALL' AND coalesce(array_length("tenantIds", 1), 0) = 0)
    OR ("tenantScope" = 'RESTRICTED' AND coalesce(array_length("tenantIds", 1), 0) BETWEEN 1 AND 64)
    OR ("tenantScope" = 'RESTRICTED_MEMBERS' AND coalesce(array_length("tenantIds", 1), 0) = 0)
  );
