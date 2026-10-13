-- Phase 49M-1: module provisioning control plane and operational lifecycle.
--
-- Adds FOUR tables and FIVE enums. NO change to any existing table's columns,
-- constraints or indexes: no ALTER of an existing column, no DROP, no data
-- backfill, no seed row. Rollback is four DROP TABLEs plus five DROP TYPEs.
--
-- WHY THERE IS NO ALTER TO "ModuleInstance" OR "ModuleRegistration"
-- ----------------------------------------------------------------
-- 49M's `lifecycle` column is written by FOUR independent paths — self
-- registration, heartbeat, an admin-triggered probe, and the unattended
-- staleness sweep — and is asserted by 13 existing spec files. Operational
-- state is written by ONE path: a provisioning execution. Putting the second
-- writer on the same row would let the sweep demote an instance that was
-- mid-upgrade, silently erasing the fact that an upgrade was running. So
-- "ModuleOperationalStatus" is a 1:1 CHILD table, and both facts survive:
-- the sweep may say UNAVAILABLE while this says UPDATING, which is not a
-- contradiction but the actual situation.
--
-- WHAT IS DELIBERATELY NOT CREATED HERE, and why:
--   * no container/VM/pod/cluster descriptor column — the audit found no
--     docker, dockerode, kube, k8s, ssh, terraform, ansible or nomad client
--     among the 65 dependencies, so a column describing one would describe a
--     capability this system does not have;
--   * no command, script, args or entrypoint column — `child_process`,
--     `execFile`, `execSync` and `spawn(` return ZERO hits across all 267 API
--     source files, and a column is how that would stop being true;
--   * no `url`, `host` or `port` on "ProvisioningTarget" — a stored URL is a
--     stored SSRF target that no policy check can re-validate at use time;
--   * no artifact BYTES — MinIO via `IStorageProvider` already exists, and a
--     bytea column would put every module build into the WAL and every backup;
--   * no secret VALUE anywhere — `credentialRef` is a NAME resolved at use
--     time against the one envelope store 49J-0/49L/49M share;
--   * no new permission and no grant seed — `admin.modules.read` and
--     `admin.modules.manage` already exist and already cover these routes.

-- ============================================================================
-- ENUMS
-- ============================================================================

-- CreateEnum
-- WHERE the control plane may act. TWO members, both drivable today. There is
-- no CONTAINER_HOST, no VM and no KUBERNETES because zero clients exist to
-- drive them, and an enum member with nothing behind it lets an operator save
-- a target the registry cannot resolve — the same reasoning "IntegrationKey"
-- uses for having exactly one member. REMOTE_AGENT is declared and DEFERRED:
-- it resolves to no provider, which normalises to PROVIDER_UNAVAILABLE.
CREATE TYPE "ProvisioningTargetType" AS ENUM ('LOCAL_SERVER', 'REMOTE_AGENT');

-- CreateEnum
-- Whether a release may be deployed. DEPRECATED can still be rolled back TO;
-- WITHDRAWN can never be deployed again, which is why the two are separate —
-- a release withdrawn for a security reason must not remain a legal rollback
-- target.
CREATE TYPE "ModuleReleaseStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'WITHDRAWN');

-- CreateEnum
-- Operational state of ONE DEPLOYED INSTANCE. Nine members, mirroring
-- src/module-platform/module-operational-state.ts exactly.
--
-- The TRANSITION TABLE lives in that file and NOT here: Postgres can enforce
-- that a value is one of nine, and cannot enforce that ACTIVE is reachable
-- only from VERIFYING, UPDATING or DISABLED. Splitting the rule across both
-- would give two partial answers instead of one whole one.
--
-- No DISCOVERED member: 49M derives that for the LOGICAL module, and this is
-- keyed by instance, where it could never be true — the row cannot exist
-- before the instance does. No DEGRADED/UNAVAILABLE either: those are health
-- observations and already live on "ModuleInstance"."health", and a second
-- copy would disagree with the first the moment a probe lands mid-upgrade.
CREATE TYPE "ModuleOperationalState" AS ENUM (
  'REGISTERED', 'PROVISIONING', 'CONFIGURING', 'VERIFYING', 'ACTIVE',
  'UPDATING', 'DISABLED', 'FAILED', 'DECOMMISSIONED'
);

-- CreateEnum
-- Lifecycle of one EXECUTION. Same five-state shape as 49L's
-- "AutomationStatus", because a request that is accepted, claimed, and then
-- finishes one of three ways is the honest description of asynchronous work.
CREATE TYPE "ProvisioningExecutionStatus" AS ENUM (
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);

-- CreateEnum
-- WHICH operation an execution performs: one member per provider method that
-- CHANGES something. `validateTarget` — the tenth method on
-- `IModuleProvisioningProvider` — has no member here on purpose: it is a
-- read-only pre-flight check, so an execution row for it would be history
-- with no effect to audit.
--
-- Deliberately NOT reusing 49M's `ModuleProvisioningStep`
-- (REGISTER/AUTHENTICATE/VERIFY/ACTIVATE): that union describes the four steps
-- 49M already performs MANUALLY, and conflating the two would make
-- `remainingProvisioningSteps` appear to describe an execution it knows
-- nothing about.
CREATE TYPE "ProvisioningAction" AS ENUM (
  'PROVISION', 'CONFIGURE', 'VERIFY', 'ACTIVATE', 'STOP', 'RESTART',
  'UPGRADE', 'ROLLBACK', 'DECOMMISSION'
);

-- ============================================================================
-- TABLE: ModuleRelease  (WHAT would be deployed)
-- ============================================================================
--
-- THE ARTIFACT IS A REFERENCE, NEVER BYTES. "artifactKey" is a MinIO object key
-- resolved through the existing `IStorageProvider`, which already issues
-- short-lived signed URLs. There is no "artifactUrl" column: a stored URL is a
-- destination an operator typed that no policy check can re-validate at use
-- time, while a key is resolved against one configured bucket.
CREATE TABLE "ModuleRelease" (
    "id" TEXT NOT NULL,

    "registrationId" TEXT NOT NULL,

    -- Denormalised copy of the parent's immutable `moduleId`, mirroring the ONE
    -- denormalisation 49M allows on "ModuleInstance", and safe for the same reason.
    "moduleId" TEXT NOT NULL,

    -- Same semver CHECK as "ModuleInstance"."version", so the two are comparable
    -- by `compareModuleVersions`. `latest` cannot be stored: a version nothing can
    -- order makes upgrade and rollback the same operation.
    "version" TEXT NOT NULL,

    "artifactKey" TEXT NOT NULL,

    -- Both NOT NULL: a checksum with no declared algorithm is unverifiable, and an
    -- artifact with no checksum cannot be proven to be the one that was published.
    "checksumAlgorithm" TEXT NOT NULL DEFAULT 'SHA-256',
    "checksum" TEXT NOT NULL,

    -- Compared against what is actually fetched, so a truncated download fails
    -- before the digest pass rather than during it.
    "artifactBytes" INTEGER NOT NULL,

    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "apiContracts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- DRAFT, so publishing is a deliberate act. Same shape as
    -- "ModuleRegistration"."enabled" defaulting to false.
    "releaseStatus" "ModuleReleaseStatus" NOT NULL DEFAULT 'DRAFT',

    "notes" TEXT,

    -- Plain column, NOT a foreign key — the rule 49L's `actorId` follows: deleting
    -- a user must not cascade away deployment history.
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per module per version: a second row for the same version would make
-- "deploy 1.2.0" ambiguous, with the checksum as the only distinguishing fact.
CREATE UNIQUE INDEX "ModuleRelease_moduleId_version_key"
  ON "ModuleRelease"("moduleId", "version");

-- The admin list read: deployable releases for one module, newest first.
CREATE INDEX "ModuleRelease_moduleId_releaseStatus_createdAt_idx"
  ON "ModuleRelease"("moduleId", "releaseStatus", "createdAt" DESC);

-- AddForeignKey
-- CASCADE, matching 49M's single FK: a release of a module that no longer exists
-- cannot be deployed, so it is not history worth keeping as an orphan.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "ModuleRegistration"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Same slug rule as 49M, applied to the denormalised logical id.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

-- Identical to "ModuleInstance_version_format", restated so a release version and
-- an instance version are guaranteed comparable.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_version_format"
  CHECK ("version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$');

-- Root-RELATIVE object key. Refuses a scheme, an authority and parent-directory
-- traversal outright, so the key cannot relocate the fetch even before the storage
-- provider resolves it against its configured bucket.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_artifactKey_relative"
  CHECK (
    "artifactKey" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND "artifactKey" NOT LIKE '%..%'
    AND char_length("artifactKey") BETWEEN 3 AND 400
  );

-- Only algorithms this codebase can actually compute, with a digest shape that
-- matches. A checksum column that accepts anything is a checksum nobody verifies.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_checksumAlgorithm_known"
  CHECK ("checksumAlgorithm" IN ('SHA-256', 'SHA-512'));

ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_checksum_format"
  CHECK (
    ("checksumAlgorithm" = 'SHA-256' AND "checksum" ~ '^[0-9a-f]{64}$')
    OR ("checksumAlgorithm" = 'SHA-512' AND "checksum" ~ '^[0-9a-f]{128}$')
  );

-- A zero-byte artifact is not a deployment, and an unbounded one is a disk-fill
-- vector.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_artifactBytes_bounded"
  CHECK ("artifactBytes" > 0);

ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_protocolVersion_positive"
  CHECK ("protocolVersion" >= 1);

-- Bounded declaration lists, the same counts 49M uses for its equivalent columns.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_apiContracts_bounded"
  CHECK (coalesce(array_length("apiContracts", 1), 0) <= 32);

ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_requiredCapabilities_bounded"
  CHECK (coalesce(array_length("requiredCapabilities", 1), 0) <= 64);

ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_notes_bounded"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);

-- Anything past DRAFT must record WHEN it was published: "published, timestamp
-- unknown" is not a state an operator can reason about during an incident.
ALTER TABLE "ModuleRelease" ADD CONSTRAINT "ModuleRelease_published_has_timestamp"
  CHECK ("releaseStatus" = 'DRAFT' OR "publishedAt" IS NOT NULL);

-- ============================================================================
-- TABLE: ProvisioningTarget  (WHERE the control plane may act)
-- ============================================================================
--
-- THERE IS NO "url", NO "host", NO "port" AND NO "command" COLUMN, and that
-- absence is the design made structural. A LOCAL_SERVER target is the machine
-- this API process already runs on — it needs no address, because "here" is not
-- a destination. A REMOTE_AGENT target names a CONFIGURED agent by key; the
-- address behind that key lives in environment configuration where the existing
-- SSRF policy can validate it, not in a row an administrator typed. The
-- probe-arbitrary-host anti-pattern is therefore unexpressible rather than
-- merely refused.
CREATE TABLE "ProvisioningTarget" (
    "id" TEXT NOT NULL,

    -- Stable slug an operator refers to, e.g. `local-primary`. UNIQUE index below:
    -- two targets with one name is an ambiguity that surfaces as "which machine
    -- did that deploy touch?".
    "targetKey" TEXT NOT NULL,

    "displayName" TEXT NOT NULL,

    "targetType" "ProvisioningTargetType" NOT NULL,

    -- NAME of a credential, resolved at use time against the one envelope store
    -- 49J-0/49L/49M share. Never a secret value.
    "credentialRef" TEXT,

    -- Default FALSE, matching "ModuleRegistration"."enabled": a newly created
    -- target does not become a deployment destination until an admin says so.
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    -- 1 makes the safe case automatic — two simultaneous deploys to one machine
    -- race on the same filesystem — and an operator with real capacity can raise it.
    "maxConcurrentExecutions" INTEGER NOT NULL DEFAULT 1,

    -- Result of the last `validateTarget` pre-flight, as a short CODE rather than
    -- a message, so the admin UI can explain an unusable target without re-running
    -- a check on every page render.
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationCode" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisioningTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningTarget_targetKey_key"
  ON "ProvisioningTarget"("targetKey");

-- The selection read: usable targets of one type.
CREATE INDEX "ProvisioningTarget_targetType_enabled_idx"
  ON "ProvisioningTarget"("targetType", "enabled");

-- Same slug rule as every other identifier in the platform.
ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_targetKey_format"
  CHECK ("targetKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("targetKey") BETWEEN 2 AND 96);

ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_displayName_bounded"
  CHECK (char_length("displayName") BETWEEN 1 AND 120);

-- A credential REFERENCE, not a credential. The shape rules out anything that
-- could be mistaken for a value: no spaces, no punctuation beyond `.`/`_`/`-`,
-- and a 128-character ceiling.
ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_credentialRef_format"
  CHECK (
    "credentialRef" IS NULL
    OR ("credentialRef" ~ '^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$'
        AND char_length("credentialRef") BETWEEN 2 AND 128)
  );

-- A REMOTE_AGENT with no credential reference could only ever fail at connect
-- time, and a LOCAL_SERVER needs none because it crosses no boundary. Enforced
-- as a PAIR, the same technique "ModuleRegistration_tenantScope_consistent" and
-- "ModuleInstance_remote_requires_baseUrl" use.
ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_remote_requires_credentialRef"
  CHECK ("targetType" = 'LOCAL_SERVER' OR "credentialRef" IS NOT NULL);

-- Bounded concurrency. Zero would make the target permanently unusable while
-- appearing enabled, which is worse than disabling it.
ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_maxConcurrentExecutions_bounded"
  CHECK ("maxConcurrentExecutions" BETWEEN 1 AND 16);

-- Short code, never a message: this column is rendered in the admin UI.
ALTER TABLE "ProvisioningTarget" ADD CONSTRAINT "ProvisioningTarget_lastValidationCode_format"
  CHECK ("lastValidationCode" IS NULL OR "lastValidationCode" ~ '^[A-Z][A-Z0-9_]{2,63}$');

-- ============================================================================
-- TABLE: ModuleProvisioningExecution  (ONE operation, request to outcome)
-- ============================================================================
--
-- MODELLED ON 49L's "AutomationExecution", and the reuse is the point: the same
-- UNIQUE "idempotencyKey", the same "attemptCount"/"errorCode" pair, the same
-- "nextAttemptAt"-goes-NULL-when-terminal idiom, and the same claimable partial
-- index. Retries and concurrency inherit a pattern that already has passing
-- specs rather than getting a second, subtly different one.
--
-- WHY THIS TABLE EXISTS: an action returns 202 with an execution id, because
-- holding an HTTP request open across a download, a digest pass and a health
-- probe converts an operator's browser timeout into an unknown deployment
-- state. The row IS the answer to "what happened?", which is why it is not
-- deleted on success.
CREATE TABLE "ModuleProvisioningExecution" (
    "id" TEXT NOT NULL,

    "registrationId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,

    -- NULL for a first PROVISION, where the instance does not exist yet — the
    -- honest case, not an oversight.
    "instanceId" TEXT,

    -- SNAPSHOT of the instance's business identity, e.g. `finance-prod-01`. NEVER
    -- nulled, so history stays readable after the FK above is SET NULL: "STOP on
    -- finance-prod-01" is still an answer, while a bare NULL is not.
    --
    -- IT ALSO CARRIES THE CONSTRAINT THE FK CANNOT. Requiring the FK to be present
    -- for every non-PROVISION action would make deleting an instance impossible,
    -- because the SET NULL would violate that very CHECK — so the requirement is
    -- expressed against this column, which nothing ever clears.
    "instanceKey" TEXT,

    -- NULL for actions that install nothing (STOP, RESTART, DECOMMISSION).
    "releaseId" TEXT,

    "targetId" TEXT NOT NULL,

    "action" "ProvisioningAction" NOT NULL,
    "status" "ProvisioningExecutionStatus" NOT NULL DEFAULT 'PENDING',

    -- The operational state this execution drives TOWARD, validated by
    -- `canTransition` before the row is created. Stored so a reader can see the
    -- intent even after the attempt failed.
    "targetState" "ModuleOperationalState" NOT NULL,

    -- `<moduleId>:<action>:<releaseVersion|->:<requestKey>`, materialised so a
    -- repeated submit is a no-op enforced by the DATABASE rather than by a
    -- read-then-write race. The single most important constraint in this table:
    -- without it, a double-clicked "Upgrade" is two concurrent deployments.
    "idempotencyKey" TEXT NOT NULL,

    -- NULL is its own bucket and is never read as "any tenant".
    "tenantId" TEXT,

    -- Plain column, NOT a foreign key, for the reason 49L states.
    "actorId" TEXT,

    -- Carried from `RequestContextService`, never regenerated.
    "correlationId" TEXT,

    "attemptCount" INTEGER NOT NULL DEFAULT 0,

    -- NULL means "not retryable", set for every terminal status, which is what
    -- keeps the claim index small instead of scanning completed history.
    "nextAttemptAt" TIMESTAMP(3),

    -- Which provider step was in progress. `module-foundations.ts` already gives
    -- the reason for per-step outcomes: "failed" is useless at 3am, "failed at
    -- VERIFY" is not.
    "failedStep" TEXT,

    -- Short internal code. NEVER an upstream body or a filesystem path: this
    -- column is rendered in the admin UI.
    "errorCode" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleProvisioningExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModuleProvisioningExecution_idempotencyKey_key"
  ON "ModuleProvisioningExecution"("idempotencyKey");

-- The claim pass's only predicate. PARTIAL — Prisma cannot express the WHERE, so
-- the schema declares a plain index and this migration narrows it: terminal rows
-- have a NULL "nextAttemptAt" and are not in the index at all. Same technique as
-- 49L's retry index and 49M's staleness index.
CREATE INDEX "ModuleProvisioningExecution_status_nextAttemptAt_idx"
  ON "ModuleProvisioningExecution"("status", "nextAttemptAt")
  WHERE "nextAttemptAt" IS NOT NULL;

-- The concurrency guard: is something already in flight for this instance?
-- PARTIAL on the two non-terminal statuses, which is all the guard ever asks about.
CREATE INDEX "ModuleProvisioningExecution_instanceId_status_idx"
  ON "ModuleProvisioningExecution"("instanceId", "status")
  WHERE "status" IN ('PENDING', 'RUNNING');

-- The admin history read: newest first for one module.
CREATE INDEX "ModuleProvisioningExecution_moduleId_createdAt_id_idx"
  ON "ModuleProvisioningExecution"("moduleId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
-- CASCADE to the logical module, matching "ModuleRelease" and 49M's own FK.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_registrationId_fkey"
  FOREIGN KEY ("registrationId") REFERENCES "ModuleRegistration"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, deliberately NOT cascade: the history of HOW an instance was deployed
-- must survive that instance being removed. This is the exact opposite of the
-- argument for cascading "ModuleInstance" itself, because an instance row is a
-- live address while an execution row is a permanent record.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_instanceId_fkey"
  FOREIGN KEY ("instanceId") REFERENCES "ModuleInstance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL so a withdrawn release cannot erase the record of having been deployed.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "ModuleRelease"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- RESTRICT, the only one in the phase: deleting a target that has executions would
-- destroy the only record of WHICH MACHINE was touched, so the delete is refused
-- and the operator must disable the target instead.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "ProvisioningTarget"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_idempotencyKey_bounded"
  CHECK (char_length("idempotencyKey") BETWEEN 8 AND 300);

-- Bounded attempts, matching "AutomationExecution_attemptCount_bounded" in spirit:
-- the service enforces the ceiling, and the database refuses the absurd.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_attemptCount_bounded"
  CHECK ("attemptCount" >= 0 AND "attemptCount" <= 100);

-- Short codes only, never a message or a path.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_errorCode_format"
  CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{2,63}$');

ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_failedStep_format"
  CHECK ("failedStep" IS NULL OR "failedStep" ~ '^[A-Z][A-Z0-9_]{2,31}$');

-- A terminal status must have a completion time, and a non-terminal one must not:
-- "SUCCEEDED, finished never" and "PENDING, already finished" are both states an
-- operator cannot act on, and both are how a half-written update looks.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_terminal_has_completedAt"
  CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "completedAt" IS NOT NULL)
    OR ("status" IN ('PENDING', 'RUNNING') AND "completedAt" IS NULL)
  );

-- A terminal execution is never retryable. This is what keeps the claim index
-- confined to live work rather than growing with completed history.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_terminal_not_retryable"
  CHECK ("status" IN ('PENDING', 'RUNNING') OR "nextAttemptAt" IS NULL);

-- A FAILED execution must say WHY. Silent failure is the one outcome an operator
-- can do nothing with, and the per-step reasoning above exists precisely to avoid it.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_failed_has_errorCode"
  CHECK ("status" <> 'FAILED' OR "errorCode" IS NOT NULL);

-- Every action except PROVISION acts on an EXISTING instance, so it must name one.
-- PROVISION is the sole case where the instance does not exist yet.
--
-- Asserted against "instanceKey" (the immutable snapshot) and NOT against the
-- "instanceId" FK: the FK is SET NULL when an instance is deleted, so testing it
-- here would make deleting any instance with history impossible — the delete would
-- violate this very constraint.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_nonprovision_requires_instance"
  CHECK ("action" = 'PROVISION' OR "instanceKey" IS NOT NULL);

-- A named instance must be a valid instance id, same slug rule as 49M's
-- "ModuleInstance_instanceId_format".
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_instanceKey_format"
  CHECK (
    "instanceKey" IS NULL
    OR ("instanceKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("instanceKey") BETWEEN 2 AND 96)
  );

-- A live FK implies the snapshot: an execution cannot point at an instance row while
-- claiming not to know which instance it was.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_fk_implies_key"
  CHECK ("instanceId" IS NULL OR "instanceKey" IS NOT NULL);

-- An action that INSTALLS something must name the release it installs. UPGRADE and
-- ROLLBACK without a release would be an instruction to change the running version
-- to an unspecified one.
ALTER TABLE "ModuleProvisioningExecution" ADD CONSTRAINT "ModuleProvisioningExecution_install_requires_release"
  CHECK ("action" NOT IN ('PROVISION', 'UPGRADE', 'ROLLBACK') OR "releaseId" IS NOT NULL);

-- ============================================================================
-- TABLE: ModuleOperationalStatus  (1:1 with ModuleInstance)
-- ============================================================================
--
-- THE LOAD-BEARING TABLE OF THIS PHASE, and a separate one rather than columns on
-- "ModuleInstance" for the reason stated in the header: four unattended writers
-- already share that row, and this has exactly one.
--
-- The transition rule is NOT here. Postgres can enforce that a value is one of
-- nine; it cannot enforce that ACTIVE is reachable only from VERIFYING, UPDATING
-- or DISABLED. That lives in src/module-platform/module-operational-state.ts,
-- where a test enumerates all 81 ordered pairs and asserts the 16 legal ones.
CREATE TABLE "ModuleOperationalStatus" (
    "id" TEXT NOT NULL,

    -- UNIQUE index below — not merely indexed — so a second operational row for one
    -- instance is impossible rather than unlikely. Two rows would make "what state
    -- is this in?" unanswerable.
    "instanceRowId" TEXT NOT NULL,

    "moduleId" TEXT NOT NULL,

    -- REGISTERED, never ACTIVE: 49M already refuses to let a self-registration serve
    -- traffic before an administrator admits it, and an operational default of ACTIVE
    -- would contradict that from the other direction.
    "operationalState" "ModuleOperationalState" NOT NULL DEFAULT 'REGISTERED',

    -- When the state last CHANGED — not when the row was last touched. Distinct from
    -- "updatedAt" on purpose: "how long has this been FAILED?" is a question about the
    -- state, and "updatedAt" moves on every unrelated write.
    "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Plain columns, NOT foreign keys: execution history is pruned on a retention
    -- schedule while state must outlive it, and a state row that vanished because its
    -- execution aged out would be far worse than an opaque id.
    "lastExecutionId" TEXT,
    "currentReleaseId" TEXT,

    -- Same semver CHECK as the release and the instance, so all three are comparable
    -- by `compareModuleVersions` at the upgrade/rollback ordering gate.
    "currentVersion" TEXT,

    -- NULL means no rollback is available — the honest answer for a first deployment,
    -- and never a silent fallback to "the previous row I happened to find".
    "previousVersion" TEXT,

    "lastErrorCode" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleOperationalStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModuleOperationalStatus_instanceRowId_key"
  ON "ModuleOperationalStatus"("instanceRowId");

-- The admin list read, and the concurrency guard's lookup of in-flight instances.
CREATE INDEX "ModuleOperationalStatus_moduleId_operationalState_idx"
  ON "ModuleOperationalStatus"("moduleId", "operationalState");

-- AddForeignKey
-- CASCADE: operational state about an instance that no longer exists has no subject.
ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_instanceRowId_fkey"
  FOREIGN KEY ("instanceRowId") REFERENCES "ModuleInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_moduleId_format"
  CHECK ("moduleId" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("moduleId") BETWEEN 2 AND 64);

ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_currentVersion_format"
  CHECK ("currentVersion" IS NULL OR "currentVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$');

ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_previousVersion_format"
  CHECK ("previousVersion" IS NULL OR "previousVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$');

ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_lastErrorCode_format"
  CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{2,63}$');

-- An ACTIVE instance is running SOMETHING, so it must say which version. Without
-- this, "active at unknown version" would be a legal row, and the ordering gate
-- would have nothing to compare an upgrade against.
ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_active_has_version"
  CHECK ("operationalState" <> 'ACTIVE' OR "currentVersion" IS NOT NULL);

-- A FAILED state must carry the code that explains it, mirroring the same rule on
-- the execution row.
ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_failed_has_errorCode"
  CHECK ("operationalState" <> 'FAILED' OR "lastErrorCode" IS NOT NULL);

-- A rollback target that equals what is running is not a rollback target. Storing
-- it would let the UI offer a rollback that `checkRollbackOrder` must then refuse.
ALTER TABLE "ModuleOperationalStatus" ADD CONSTRAINT "ModuleOperationalStatus_previous_differs_from_current"
  CHECK (
    "previousVersion" IS NULL
    OR "currentVersion" IS NULL
    OR "previousVersion" <> "currentVersion"
  );

