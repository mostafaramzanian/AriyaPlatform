-- Phase 54-C (D14): the two Core-owned entitlement tables, §43.3 and §43.7.
--
-- Adds TWO tables, their indexes, their CHECKs and THREE foreign keys. No column
-- is added to any existing table: the two back-relations §43.3 names
-- (`features` on "ModuleRegistration", `featureGrants` on "Tenant") are Prisma
-- relation fields only, so there is no ALTER on "ModuleRegistration" or "Tenant"
-- anywhere in this file and no existing row is rewritten (§39 stop condition 11).
--
-- WHY BOTH TABLES ARE CORE'S, AND NOT HR'S
-- ---------------------------------------
-- The answer to "may this tenancy use this feature?" can only be given by whoever
-- owns the registration. A business module that could read a grant table would be
-- deciding its own entitlement, which is the coupling §43.6 forbids, so the two
-- tables live beside "ModuleRegistration" in `core_db` and the only reader in the
-- tree is `PlatformEntitlementService` (§43.4). HR declares what it needs to know
-- (`@RequiresFeature`) and Core states whether it is so.
--
-- WHY FEATURES ARE ROWS RATHER THAN ENUM MEMBERS
-- ----------------------------------------------
-- A feature registered as an enum member would make every business vocabulary
-- addition a Core type change, and would invite `if (feature === LEAVE)`
-- branching in Core — the mistake the ModuleType enum's own comment refuses for
-- modules. A feature therefore exists when a row exists, exactly as a module does.
--
-- THE DEFAULTED BOOLEAN IS THE FAIL-CLOSED DIRECTION
-- --------------------------------------------------
-- `enabled` defaults to FALSE on the feature row, the same default
-- "ModuleRegistration.enabled" carries, so a declared feature is OFF until an
-- operator turns it on. The storage default is the fail-closed rule, not a service
-- convention: a row inserted by a migration or by hand is dark until deliberately
-- lit.
--
-- ADDITIVE ONLY. `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT` and nothing
-- else: no DROP, no DELETE, no ALTER of an existing object, no data backfill and
-- no seed row. A rollback is two DROP TABLEs.

-- ============================================================================
-- TABLE: ModuleFeature  (a feature a module DECLARES)
-- ============================================================================
--
-- Keyed by `moduleId`, NOT by `ModuleRegistration.id`, and that is a deliberate
-- choice about the read that has to be fast: the decision path asks
-- "is (moduleId, featureId) declared?" on every request that carries a feature id,
-- and keying by the registration's surrogate id would make that a join or a second
-- lookup. `moduleId` is itself UNIQUE on the registration, so this FK is exact —
-- one registration per moduleId by construction — and the lookup is covered by
-- "ModuleFeature_moduleId_featureId_key" alone.
CREATE TABLE "ModuleFeature" (
    "id" TEXT NOT NULL,

    -- The module that declares it. CASCADE: a feature of a module that no longer
    -- exists is not a fact about anything, the same reasoning the internal
    -- "ModuleInstance" -> "ModuleRegistration" FK already records.
    "moduleId" TEXT NOT NULL,

    -- Stable feature identity inside the module (e.g. `leave`). Slug shape and
    -- length enforced below, in the same rule the registration's own `moduleId`
    -- uses, because both are read by the same resolver.
    "featureId" TEXT NOT NULL,

    -- Operator-facing label. Presentation only; nothing resolves by it, which is
    -- why it may be renamed without moving a grant.
    "displayName" TEXT NOT NULL,

    -- FALSE means the PLATFORM does not offer this feature yet — distinct from
    -- "your tenancy does not hold it", which is the absence of a grant row.
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleFeature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleFeature_moduleId_idx" ON "ModuleFeature"("moduleId");

-- CreateIndex
-- The unique key is what makes the provisioning migration idempotent
-- (`ON CONFLICT ("moduleId", "featureId") DO NOTHING`) and what makes "the same
-- module cannot declare the same feature twice" a database fact.
CREATE UNIQUE INDEX "ModuleFeature_moduleId_featureId_key" ON "ModuleFeature"("moduleId", "featureId");

-- Same slug rule as "ModuleRegistration_moduleId_format", deliberately copied
-- rather than invented: the DTO protects the HTTP surface, this protects the table
-- from a direct write installing an id the resolver and the audit trail would
-- disagree about. Lower-case alphanumeric with single internal hyphens, 2-64 chars.
ALTER TABLE "ModuleFeature" ADD CONSTRAINT "ModuleFeature_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

ALTER TABLE "ModuleFeature" ADD CONSTRAINT "ModuleFeature_featureId_format"
  CHECK ("featureId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("featureId") BETWEEN 2 AND 64);

ALTER TABLE "ModuleFeature" ADD CONSTRAINT "ModuleFeature_displayName_bounded"
  CHECK (char_length("displayName") BETWEEN 1 AND 120);

-- AddForeignKey
ALTER TABLE "ModuleFeature" ADD CONSTRAINT "ModuleFeature_moduleId_fkey"
  FOREIGN KEY ("moduleId") REFERENCES "ModuleRegistration"("moduleId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- TABLE: ModuleFeatureGrant  (PRESENCE IS THE GRANT)
-- ============================================================================
--
-- ONE ROW = THIS TENANCY HOLDS THIS FEATURE. There is no `enabled` column and no
-- `revokedAt`: a two-state column on a grant table is what makes "granted but
-- disabled" and "disabled but present" storable, and the decision would then have
-- to define which one wins. Revocation is the row's deletion, which is also what
-- makes revocation auditable at a glance (§43.8 writes the audit action).
--
-- No actor column: who granted or revoked is in "AuditLog", following the rule
-- "ModuleRegistration" and "IntegrationConfig" already follow — deleting an
-- administrator must not cascade away platform configuration.
CREATE TABLE "ModuleFeatureGrant" (
    "id" TEXT NOT NULL,

    -- Points at the FEATURE ROW, not at the (moduleId, featureId) pair: one row is
    -- one grant of one feature, and the tenant side is the discriminator.
    "featureRowId" TEXT NOT NULL,

    -- A real tenant, by foreign key, not by convention. §24's cross-database FK
    -- prohibition is untouched: "Tenant" is `core_db`'s own registry.
    "tenantId" TEXT NOT NULL,

    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleFeatureGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModuleFeatureGrant_tenantId_idx" ON "ModuleFeatureGrant"("tenantId");

-- CreateIndex
-- The decision's own lookup key: "may THIS tenant use THIS feature?" is answered
-- by one index-covered unique probe, and it cannot return more than one row.
CREATE UNIQUE INDEX "ModuleFeatureGrant_featureRowId_tenantId_key" ON "ModuleFeatureGrant"("featureRowId", "tenantId");

-- AddForeignKey
-- CASCADE on both parents. For the feature row it is the reasoning above; for the
-- tenant it is §43.3's stated rule — a statement about a tenant must not outlive
-- the tenant it is about — and it is also the convention this repository already
-- uses for "Tenant"-referencing rows ("Lead" -> CASCADE).
ALTER TABLE "ModuleFeatureGrant" ADD CONSTRAINT "ModuleFeatureGrant_featureRowId_fkey"
  FOREIGN KEY ("featureRowId") REFERENCES "ModuleFeature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModuleFeatureGrant" ADD CONSTRAINT "ModuleFeatureGrant_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
