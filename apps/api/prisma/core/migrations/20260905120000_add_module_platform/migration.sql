-- Phase 49M: Core Distributed Module Platform.
--
-- Adds TWO tables and FIVE enums. No change to any existing table's columns,
-- constraints or indexes. The ONLY foreign key is INTERNAL to this phase
-- ("ModuleInstance" -> "ModuleRegistration"); nothing here references "User",
-- "Tenant" or any business table.
--
-- WHY THE ONE FK EXISTS HERE WHEN 49L DELIBERATELY HAD NONE: 49L's `actorId`
-- pointed at a person, and delivery history must outlive the administrator who
-- triggered it. An instance, by contrast, is meaningless without its logical
-- module — it cannot be resolved, health-checked or called — so CASCADE is the
-- correct semantics rather than a hazard.
--
-- Nothing here touches "Tenant", Role/Permission/RolePermission/UserRole (RBAC),
-- "AuditLog"/"AuditDispatch", "Notification" (49E), "Conversation"/"Message"
-- (49F), "Ticket*" (49G), "Survey*" (49H), "Reminder" (49I), "AIProviderConfig"
-- (49J-0), "SearchDocument" (49J), "UserPreference" (49K) or
-- "IntegrationConfig"/"AutomationExecution" (49L). Core schema only: nothing
-- here touches `cms_db`.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: no DROP, no ALTER of an existing column, no
-- data backfill and no seed row. Every column is either NOT NULL WITH A DEFAULT
-- or nullable, so both tables are complete the moment they are created and a
-- rollback is two DROP TABLEs plus five DROP TYPEs.
--
-- WHAT IS DELIBERATELY NOT CREATED HERE, and why:
--   * no "HR"/"Finance"/"Employee"/"Invoice" anything — 49M builds the platform,
--     never a business module, and a table named after a domain would be the
--     first hard-coded assumption;
--   * no shared/federated business table and no cross-module view — §3 forbids
--     coupling modules through databases, so Core has no place to hold another
--     module's rows even accidentally;
--   * no "ModuleSyncCursor"/"ModuleConflict"/"ModuleProvisioningJob" — §36/§37/§38
--     ask for EXTENSION POINTS, which are types in
--     src/module-platform/module-foundations.ts, not tables;
--   * no "ModuleRoute"/"ModuleMeshPolicy" — no service mesh (§3);
--   * no separate "ModuleCredential" table: one active shared secret per module
--     lives in three columns on the registration, exactly as 49L's webhook secret
--     lives on "IntegrationConfig". A credential HISTORY table would persist
--     superseded secrets, which is strictly worse than not keeping them.

-- ============================================================================
-- ENUMS
-- ============================================================================

-- CreateEnum
-- What KIND of module this is — never WHERE it runs. BUSINESS is ONE member
-- rather than one per domain: an enum with HR/FINANCE members would make adding
-- a module a schema migration and would invite `if (module === HR)` branching,
-- which is precisely what this phase exists to prevent.
CREATE TYPE "ModuleType" AS ENUM ('CORE', 'BUSINESS', 'INTEGRATION');

-- CreateEnum
-- WHERE an instance is deployed. A DEPLOYMENT decision, never a domain decision:
-- the same logical module may be LOCAL today and REMOTE next month with no change
-- to any business contract. Only the transport layer reads this value.
CREATE TYPE "ModuleDeploymentMode" AS ENUM ('LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID');

-- CreateEnum
-- Instance lifecycle, closed at seven members:
--   REGISTERED   -> authenticated and recorded, not yet serving
--   ACTIVE       -> registered, compatible, enabled, resolvable
--   DEGRADED     -> serving with reduced capability
--   UNAVAILABLE  -> known but not answering (stale heartbeat or failed probe)
--   DISABLED     -> an administrator turned it off; no transport is attempted
--   DEREGISTERED -> announced its own shutdown, or was removed (terminal)
--   INCOMPATIBLE -> declared a protocol/contract this Core cannot speak (§18)
--
-- No DISCOVERED member: that is a DERIVED state of the LOGICAL module ("a
-- registration exists, no instance has ever announced itself"), computed on read.
-- As a column it would be permanently stale for every row that has an instance.
CREATE TYPE "ModuleLifecycleState" AS ENUM (
  'REGISTERED', 'ACTIVE', 'DEGRADED', 'UNAVAILABLE', 'DISABLED', 'DEREGISTERED', 'INCOMPATIBLE'
);

-- CreateEnum
-- Last OBSERVED health. UNKNOWN is the honest pre-observation value and is never
-- treated as HEALTHY; a 200 with no declared state resolves to DEGRADED, because
-- §13 forbids equating "it answered" with "it is well".
CREATE TYPE "ModuleHealthState" AS ENUM ('HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'DISABLED', 'UNKNOWN');

-- CreateEnum
-- Which tenants a module may be resolved for. TWO members rather than "an empty
-- list means every tenant": an empty array that silently means ALL is the shape in
-- which a botched write turns a restricted module into a global one.
CREATE TYPE "ModuleTenantScope" AS ENUM ('ALL', 'RESTRICTED');

-- ============================================================================
-- TABLE: ModuleRegistration  (the LOGICAL module)
-- ============================================================================
--
-- Everything a module could LIE ABOUT to gain trust lives here and is written only
-- by the permission-gated admin API: `enabled`, `tenantScope`, `tenantIds` and the
-- credential. Everything a module legitimately reports about itself lives on
-- "ModuleInstance" instead.
--
-- THERE IS NO `baseUrl` COLUMN ON THIS TABLE, and that is the deployment-agnostic
-- requirement made structural: an endpoint belongs to a running instance, so a
-- logical module cannot carry one, and moving a module between LOCAL and REMOTE
-- never touches this row.
CREATE TABLE "ModuleRegistration" (
    "id" TEXT NOT NULL,

    -- Stable, immutable logical identity (e.g. `finance`). UNIQUE index below.
    "moduleId" TEXT NOT NULL,

    "displayName" TEXT NOT NULL,

    "moduleType" "ModuleType" NOT NULL DEFAULT 'BUSINESS',

    -- Default FALSE so a self-registration cannot start receiving traffic before an
    -- administrator admits it (§7: no trusted status without admission).
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    "tenantScope" "ModuleTenantScope" NOT NULL DEFAULT 'ALL',
    "tenantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- Platform protocol version this module was admitted under. Compared on every
    -- registration; a mismatch yields INCOMPATIBLE rather than partial activation.
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,

    -- AES-256-GCM envelope for the module's shared HMAC secret, reusing
    -- CryptoService and AI_CONFIG_ENCRYPTION_KEY (49J-0, reused by 49L). THREE
    -- columns because GCM needs all three both to decrypt and to authenticate;
    -- ciphertext alone would make tampering undetectable. Nullable as a set: a
    -- registration may exist before its credential is issued, and registration then
    -- refuses to authenticate rather than accepting an unsigned announcement.
    "secretCiphertext" TEXT,
    "secretIv" TEXT,
    "secretAuthTag" TEXT,
    "secretUpdatedAt" TIMESTAMP(3),

    -- NULL means "no expiry configured" and is never read as "expired".
    "secretExpiresAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModuleRegistration_moduleId_key" ON "ModuleRegistration"("moduleId");

-- The admin list read: by type, then name.
CREATE INDEX "ModuleRegistration_moduleType_displayName_idx"
  ON "ModuleRegistration"("moduleType", "displayName");

-- Slug shape, enforced in SQL as well as in the DTO. The DTO protects the HTTP
-- surface; this protects the table from a direct write installing an id that the
-- resolver, the signature canonicalisation and the audit trail would all disagree
-- about. Lower-case alphanumeric with single internal hyphens, 2-64 chars.
ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_displayName_bounded"
  CHECK (char_length("displayName") BETWEEN 1 AND 120);

-- The pair invariant: ALL must carry an EMPTY tenant list and RESTRICTED must carry
-- a non-empty one. Without this, "RESTRICTED to nobody" (a module nothing can
-- resolve, with no error to explain why) and "ALL with a stale leftover list" are
-- both storable, and the second is the dangerous one — a later change of scope
-- would silently re-apply a list somebody forgot about.
ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_tenantScope_consistent"
  CHECK (
    ("tenantScope" = 'ALL' AND coalesce(array_length("tenantIds", 1), 0) = 0)
    OR ("tenantScope" = 'RESTRICTED' AND coalesce(array_length("tenantIds", 1), 0) BETWEEN 1 AND 64)
  );

-- Bounded so a direct write cannot install a protocol version the code has never
-- heard of and then have registration silently accept it.
ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_protocolVersion_bounded"
  CHECK ("protocolVersion" BETWEEN 1 AND 100);

-- The three GCM columns are meaningful only TOGETHER. All-NULL (no credential yet)
-- and all-present (credential issued) are the only legal states; two of three would
-- decrypt to garbage or throw at the first authenticated registration.
ALTER TABLE "ModuleRegistration" ADD CONSTRAINT "ModuleRegistration_secret_complete"
  CHECK (
    ("secretCiphertext" IS NULL AND "secretIv" IS NULL AND "secretAuthTag" IS NULL)
    OR ("secretCiphertext" IS NOT NULL AND "secretIv" IS NOT NULL AND "secretAuthTag" IS NOT NULL)
  );

-- ============================================================================
-- TABLE: ModuleInstance  (ONE DEPLOYED INSTANCE)
-- ============================================================================
--
-- The only place a network location exists. A module writes this row about itself
-- through the authenticated registration route; an administrator never types an
-- endpoint here, which is half the §40 SSRF answer (the other half is the URL policy
-- applied on write AND before every call).
--
-- SEVERAL ROWS PER `moduleId` ARE LEGAL BY CONSTRUCTION (§12): `instanceId` is the
-- unique key and `moduleId` is only indexed, so `finance-prod-01` and
-- `finance-prod-02` coexist without any model change. This phase does not implement
-- load balancing; it merely refuses to make it impossible.
CREATE TABLE "ModuleInstance" (
    "id" TEXT NOT NULL,

    "registrationId" TEXT NOT NULL,

    -- Stable identity of THIS deployment. Globally unique, so two modules cannot
    -- claim one instance identity, and re-announcement upserts on it.
    "instanceId" TEXT NOT NULL,

    -- Denormalised from the parent, safe because `moduleId` is immutable. It exists so
    -- resolution — which reads by LOGICAL id — does not need a join on the hot path.
    "moduleId" TEXT NOT NULL,

    -- DEPLOYMENT metadata, not domain data. Only the transport layer reads it.
    "deploymentMode" "ModuleDeploymentMode" NOT NULL,

    "version" TEXT NOT NULL,

    -- Origin only. NULLABLE for the one honest case: a LOCAL in-process instance has
    -- no URL, and the resolver refuses a transport-requiring instance without one
    -- rather than inventing `http://localhost`.
    "baseUrl" TEXT,
    "healthPath" TEXT NOT NULL DEFAULT '/health',

    -- Declared by the module, matched by Core, never parsed. TEXT[] rather than child
    -- tables: these lists are read as a whole for one instance and are never filtered,
    -- sorted or joined on, so three join tables would add three write paths for no
    -- query. The same reasoning "UserPreference"."navFavorites" (49K) follows.
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apiContracts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eventContracts" TEXT[] DEFAULT ARRAY[]::TEXT[],

    "lifecycle" "ModuleLifecycleState" NOT NULL DEFAULT 'REGISTERED',

    -- UNKNOWN, never HEALTHY: an instance that has registered and never been probed
    -- must not be resolvable as healthy.
    "health" "ModuleHealthState" NOT NULL DEFAULT 'UNKNOWN',

    -- Short internal code only. Never an upstream body: those echo request content and
    -- occasionally credential fragments, and this column reaches the admin UI.
    "healthErrorCode" TEXT,

    "lastSeenAt" TIMESTAMP(3),
    "lastProbedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModuleInstance_instanceId_key" ON "ModuleInstance"("instanceId");

-- The resolver's predicate: candidates for one logical module, most recently seen
-- first. `lifecycle` is second because the resolver filters on it before ordering.
CREATE INDEX "ModuleInstance_moduleId_lifecycle_lastSeenAt_idx"
  ON "ModuleInstance"("moduleId", "lifecycle", "lastSeenAt" DESC);

-- The staleness sweep. PARTIAL — Prisma cannot express the WHERE, so the schema
-- declares a plain index and this migration narrows it: terminal rows (DISABLED,
-- DEREGISTERED, INCOMPATIBLE, UNAVAILABLE) can never become stale, so keeping them
-- out means the sweep scans only rows it could actually act on. Same technique the
-- 49L retry index uses.
CREATE INDEX "ModuleInstance_lastSeenAt_idx"
  ON "ModuleInstance"("lastSeenAt")
  WHERE "lifecycle" IN ('REGISTERED', 'ACTIVE', 'DEGRADED');

-- AddForeignKey
-- CASCADE, unlike anything in 49L: an instance of a module that no longer exists is
-- unresolvable by definition, so it must not survive its parent as an orphan the
-- resolver would have to filter out on every read.
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "ModuleRegistration"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Same slug rule as the registration, applied to the instance id, plus the same rule
-- for the denormalised `moduleId` — a direct write must not be able to point an
-- instance at a logical id the format check would have rejected upstream.
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_instanceId_format"
  CHECK ("instanceId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("instanceId") BETWEEN 2 AND 96);

ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

-- Strict semantic version. `latest`, `v2`, `2`, `1.2` and '' are all refused: a
-- version string nothing can compare is worse than no version at all, and the
-- compatibility check in §18 compares majors.
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_version_format"
  CHECK ("version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$');

-- Root-relative health path. Refuses a scheme or an authority outright, so the path
-- cannot relocate the request even before `buildModuleUrl` re-checks the origin.
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_healthPath_relative"
  CHECK ("healthPath" ~ '^/[A-Za-z0-9._~/-]*$' AND char_length("healthPath") BETWEEN 1 AND 300);

-- Bounded declaration lists. The DTO validates each ENTRY's shape; these bound the
-- COUNT, so a direct write cannot store a 10,000-entry capability list that every
-- discovery read would then have to serialise.
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_capabilities_bounded"
  CHECK (coalesce(array_length("capabilities", 1), 0) <= 64);

ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_apiContracts_bounded"
  CHECK (coalesce(array_length("apiContracts", 1), 0) <= 32);

ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_eventContracts_bounded"
  CHECK (coalesce(array_length("eventContracts", 1), 0) <= 64);

-- A REMOTE, CENTRAL or HYBRID instance MUST have an endpoint: it is off-box, so there
-- is no other way to reach it, and an ACTIVE row without one would be a resolution
-- that fails at call time instead of at registration time. LOCAL may legitimately
-- have none (in-process transport).
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_remote_requires_baseUrl"
  CHECK ("deploymentMode" = 'LOCAL' OR "baseUrl" IS NOT NULL);



