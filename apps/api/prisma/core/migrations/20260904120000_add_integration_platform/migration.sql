-- Phase 49L: Core Automation & Integration Platform.
--
-- Adds TWO tables and TWO enums. No change to any existing table's columns,
-- constraints or indexes, and no foreign key into one either: unlike 49E
-- ("Notification"), 49I ("Reminder") and 49K ("UserPreference"), neither table
-- here references "User". Delivery history must survive deletion of the
-- administrator who triggered it, so `actorId` is a plain column — the same rule
-- "Notification"."sourceId" already follows.
--
-- Nothing here touches "Tenant", Role/Permission/RolePermission/UserRole (RBAC),
-- "AuditLog"/"AuditDispatch", "Notification" (49E), "Conversation"/"Message"
-- (49F), "Ticket*" (49G), "Survey*" (49H), "Reminder" (49I), "AIProviderConfig"
-- (49J-0), "SearchDocument" (49J) or "UserPreference" (49K). Core schema only:
-- nothing here touches `cms_db`.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: no DROP, no ALTER of an existing column, no
-- data backfill and no seed row. Every column is either NOT NULL WITH A DEFAULT
-- or nullable, so both tables are complete the moment they are created and a
-- rollback is two DROP TABLEs plus two DROP TYPEs.
--
-- WHAT IS DELIBERATELY NOT CREATED HERE: "Workflow", "WorkflowNode",
-- "WorkflowGraph", "AutomationEngine" and any generic event store. The external
-- automation engine owns the workflow definition; a copy in Aria would be a
-- second source of truth for a graph this system never executes. There is also
-- no queue table — retry state is `attemptCount` + `nextAttemptAt` on the
-- execution row, following the "AuditDispatch" precedent.

-- ============================================================================
-- ENUMS
-- ============================================================================

-- CreateEnum
-- ONE member, because src/integrations contains ONE adapter
-- (N8nIntegrationProvider). A speculative second member would let an
-- administrator store a configuration the provider registry cannot resolve,
-- turning a successful save into a runtime failure on first dispatch. Same rule
-- "AIProviderKey" follows for the four AI providers that actually exist.
CREATE TYPE "IntegrationKey" AS ENUM ('N8N');

-- CreateEnum
-- The delivery lifecycle, closed at six members:
--   PENDING   -> row created, no attempt has completed
--   SENT      -> engine returned 2xx but reported no outcome
--   ACCEPTED  -> engine acknowledged with an external execution reference
--   RETRYING  -> an attempt failed and attemptCount is below maxAttempts
--   COMPLETED -> a signed callback reported success  (terminal)
--   FAILED    -> attempts exhausted or a callback reported failure (terminal)
--
-- No SKIPPED member: when an integration is absent or disabled nothing was
-- promised, so no row is written at all rather than a row no retry pass will
-- ever claim.
CREATE TYPE "AutomationStatus" AS ENUM (
  'PENDING', 'SENT', 'ACCEPTED', 'RETRYING', 'COMPLETED', 'FAILED'
);

-- ============================================================================
-- TABLE: IntegrationConfig
-- ============================================================================
--
-- PLATFORM-GLOBAL, with no "tenantId", for the same reason "AIProviderConfig"
-- has none: the endpoint and the shared secret are the operator's own
-- infrastructure, not tenant content. A per-tenant column would imply tenants
-- may register their own outbound destinations, which is an SSRF surface this
-- phase deliberately does not build.
CREATE TABLE "IntegrationConfig" (
    "id" TEXT NOT NULL,

    -- One row per integration, enforced by a UNIQUE index below. Every read
    -- resolves by this key rather than by id.
    "integration" "IntegrationKey" NOT NULL,

    -- Origin, e.g. `http://localhost:5678`. Re-validated against the SSRF guard
    -- immediately before EVERY dispatch, not only on write: the
    -- allow-private-targets policy is environment configuration and can change
    -- without this row changing.
    "baseUrl" TEXT NOT NULL,

    -- Webhook path, stored separately so the origin can be validated on its own
    -- and a path can never smuggle a scheme or an authority past the guard.
    "webhookPath" TEXT NOT NULL,

    -- Default FALSE so creating a row cannot silently start sending live events
    -- to a half-built workflow.
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,

    -- AES-256-GCM envelope for the HMAC shared secret, reusing CryptoService and
    -- AI_CONFIG_ENCRYPTION_KEY (Phase 49J-0). THREE columns because GCM needs all
    -- three both to decrypt and to authenticate; ciphertext alone would make
    -- tampering undetectable. Nullable as a set: a row may exist before its
    -- secret is generated, and dispatch refuses to sign without one rather than
    -- sending an unsigned event.
    "secretCiphertext" TEXT,
    "secretIv" TEXT,
    "secretAuthTag" TEXT,
    "secretUpdatedAt" TIMESTAMP(3),

    -- Last connection-test outcome. Constrained to two values below rather than
    -- free text, because a free-text column here would end up holding an upstream
    -- error string — exactly what must never be persisted or displayed.
    "lastTestStatus" TEXT,
    "lastTestedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConfig_integration_key" ON "IntegrationConfig"("integration");

-- Bounds are restated in SQL as well as in the DTO. The DTO protects the HTTP
-- surface; these protect the table from a direct SQL write installing an
-- unbounded timeout or an effectively-infinite retry count.
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_timeoutMs_bounded"
  CHECK ("timeoutMs" BETWEEN 1000 AND 60000);

ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_maxAttempts_bounded"
  CHECK ("maxAttempts" BETWEEN 1 AND 5);

ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_lastTestStatus_allowed"
  CHECK ("lastTestStatus" IS NULL OR "lastTestStatus" IN ('SUCCESS', 'FAILURE'));

-- The secret envelope is all-or-nothing. A row holding ciphertext without its IV
-- or tag is undecryptable, and the failure would surface at dispatch time as an
-- unexplained 500 rather than at write time.
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_secret_complete"
  CHECK (
    ("secretCiphertext" IS NULL AND "secretIv" IS NULL AND "secretAuthTag" IS NULL)
    OR ("secretCiphertext" IS NOT NULL AND "secretIv" IS NOT NULL AND "secretAuthTag" IS NOT NULL)
  );

-- ============================================================================
-- TABLE: AutomationExecution
-- ============================================================================
--
-- Minimal NORMALIZED metadata for one outbound event. What is deliberately NOT
-- stored: the payload, the engine's execution log, node-level detail, request or
-- response bodies, headers, and the signature. Persisting the payload would
-- undo the data minimisation the envelope exists to enforce, and persisting the
-- signature would store a credential-derived value.
CREATE TABLE "AutomationExecution" (
    "id" TEXT NOT NULL,

    "integration" "IntegrationKey" NOT NULL,

    -- The envelope's own identifiers, plus the contract fields a reader needs to
    -- interpret a delivery WITHOUT the payload.
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "source" TEXT NOT NULL,

    -- `<integration>:<eventId>:v<version>`, materialised so idempotency is
    -- enforced by a UNIQUE INDEX rather than by a read-then-write race in the
    -- service. A repeated trigger collides here and returns the existing row.
    "idempotencyKey" TEXT NOT NULL,

    -- Snapshot of the triggering context's tenant. NULL is its own bucket and is
    -- never widened to "any tenant": every read applies the caller's tenant
    -- predicate unconditionally, including when it is null.
    "tenantId" TEXT,

    -- NOT a foreign key, on purpose. Deleting the administrator who triggered an
    -- automation must not cascade away delivery history, and there is no
    -- authorization decision anywhere that reads this column.
    "actorId" TEXT,

    -- Ties Aria request -> envelope -> outbound request -> callback -> this row.
    "correlationId" TEXT,

    "status" "AutomationStatus" NOT NULL DEFAULT 'PENDING',

    -- The engine's own execution id, when it reports one. Opaque and
    -- display-only: nothing in Aria resolves it against the engine's database.
    "externalExecutionId" TEXT,

    "attemptCount" INTEGER NOT NULL DEFAULT 0,

    -- NULL means "not retryable", which is what every terminal state sets. That
    -- is also what keeps the partial retry index below small.
    "nextAttemptAt" TIMESTAMP(3),

    -- Short internal code only (TIMEOUT / HTTP_5xx / UNREACHABLE /
    -- CALLBACK_FAILED). Never an upstream body: those echo request content and
    -- occasionally credential fragments.
    "errorCode" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- THE idempotency guarantee. Enforced here rather than in the service because two
-- concurrent triggers for the same event would otherwise both pass a `findFirst`
-- check and both insert.
CREATE UNIQUE INDEX "AutomationExecution_idempotencyKey_key"
  ON "AutomationExecution"("idempotencyKey");

-- CreateIndex
-- Callback resolution: the external engine echoes back the integration and the
-- event id, so that pair must resolve to exactly one row.
CREATE UNIQUE INDEX "AutomationExecution_integration_eventId_key"
  ON "AutomationExecution"("integration", "eventId");

-- CreateIndex
-- PARTIAL, which Prisma cannot express in schema.prisma: terminal rows have
-- `nextAttemptAt` NULL and are therefore absent from the index entirely. The
-- retry pass scans the pending backlog rather than the whole delivery history —
-- the same shape as "Reminder_pending_dueAt_idx" (49I).
CREATE INDEX "AutomationExecution_retryable_idx"
  ON "AutomationExecution"("status", "nextAttemptAt")
  WHERE "nextAttemptAt" IS NOT NULL;

-- CreateIndex
-- The admin list read: newest first inside the caller's tenant. `id` breaks ties
-- so pagination is deterministic, matching the "Notification" list index (49E).
CREATE INDEX "AutomationExecution_tenantId_createdAt_id_idx"
  ON "AutomationExecution"("tenantId", "createdAt" DESC, "id" DESC);

-- Attempts can never be negative, and the version is a positive integer. Both are
-- asserted here as well as in code because a direct SQL write bypasses the DTO.
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_attemptCount_bounded"
  CHECK ("attemptCount" >= 0 AND "attemptCount" <= 5);

ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_eventVersion_positive"
  CHECK ("eventVersion" >= 1);

-- A terminal state must not remain retryable. Without this, a COMPLETED row with
-- a stale `nextAttemptAt` would keep being claimed by the retry pass and could
-- redeliver an event whose workflow already ran.
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_terminal_not_retryable"
  CHECK (
    "status" NOT IN ('COMPLETED', 'FAILED') OR "nextAttemptAt" IS NULL
  );


