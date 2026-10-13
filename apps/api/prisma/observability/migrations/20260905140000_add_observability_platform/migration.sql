-- Phase 49M-2: the Core Observability / Logging / Audit platform schema.
--
-- THIS MIGRATION RUNS AGAINST observability_db, NOT core_db AND NOT cms_db. It is the
-- first migration of a THIRD Prisma project (apps/api/prisma/observability), with its
-- own `_prisma_migrations` history, exactly as 33J established for the Core/CMS split.
-- Applying it to core_db would be a mistake, not a shortcut: the whole point is that a
-- retention DELETE over millions of log rows must not compete with a login.
--
-- WHY A SEPARATE DATABASE, IN NUMBERS FROM THIS INSTALLATION:
--   core_db."AuditLog" = 35,757 rows / 17 MB over five weeks of development traffic,
--   of which 21,401 are `validation_failed` and 12,031 are `unauthorized` — 94% is the
--   high-volume, low-value stream an observability platform exists to absorb. Adding
--   per-request application logging beside identity, RBAC and business transactions
--   would share one disk, one WAL, one autovacuum budget and one connection pool.
--
-- core_db."AuditLog" IS LEFT EXACTLY AS IT IS (§51 KEEP). Nothing here reads it, copies
-- it, mirrors it or truncates it. Its three consumers — AuditService.log (writer),
-- AuditDispatcherService (RabbitMQ redelivery) and UsersService.getLoginHistory
-- (/users/me/login-history) — continue to work unchanged. This schema owns events
-- recorded from 49M-2 onward.
--
-- NO FOREIGN KEY IN THIS FILE POINTS OUTSIDE THIS DATABASE, and there are no foreign
-- keys at all: `userId`, `tenantId`, `actorId`, `moduleId` and `instanceId` are plain
-- identifiers referencing Core rows, following the DC-CMS-01 precedent. A log line must
-- survive deletion of its user; an audit row must survive deletion of what it describes.
--
-- INDEXES (§21): every read surface requires a time range, so `occurredAt` leads or
-- co-leads every composite index below. The correlation columns (`requestId`,
-- `correlationId`, `traceId`) are indexed alone because a trace lookup is an equality
-- probe with no time bound — that is the one query an operator runs without knowing
-- when the thing happened. `errorStack` and the Json columns are deliberately NOT
-- indexed: they are read when a row is opened, never searched across rows.

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'MODULE', 'SYSTEM', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGOUT', 'TOKEN_REFRESHED', 'TOKEN_REUSE_DETECTED', 'PASSWORD_CHANGED', 'AUTHENTICATION_MISSING', 'AUTHORIZATION_DENIED', 'RATE_LIMIT_EXCEEDED', 'SIGNATURE_INVALID', 'SSRF_BLOCKED', 'VALIDATION_REJECTED', 'SUSPICIOUS_PAYLOAD');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LifecycleDomain" AS ENUM ('INTEGRATION', 'MODULE', 'PROVISIONING');

-- CreateEnum
CREATE TYPE "LifecyclePhase" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'REFUSED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "ApplicationLog" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL,
    "messageCode" VARCHAR(80) NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "service" VARCHAR(64) NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "instanceRef" VARCHAR(96),
    "requestId" VARCHAR(64),
    "correlationId" VARCHAR(64),
    "traceId" VARCHAR(64),
    "spanId" VARCHAR(32),
    "userId" VARCHAR(64),
    "tenantId" VARCHAR(64),
    "httpMethod" VARCHAR(10),
    "route" VARCHAR(200),
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "moduleId" VARCHAR(64),
    "instanceId" VARCHAR(96),
    "deploymentMode" VARCHAR(16),
    "context" JSONB,
    "errorName" VARCHAR(160),
    "errorMessage" VARCHAR(1000),
    "errorStack" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" VARCHAR(120) NOT NULL,
    "resourceType" VARCHAR(80) NOT NULL,
    "resourceId" VARCHAR(200),
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "actorRole" VARCHAR(64),
    "outcome" "AuditOutcome" NOT NULL,
    "reason" VARCHAR(500),
    "tenantId" VARCHAR(64),
    "requestId" VARCHAR(64),
    "correlationId" VARCHAR(64),
    "traceId" VARCHAR(64),
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(400),
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moduleId" VARCHAR(64),
    "instanceId" VARCHAR(96),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" "SecurityEventType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "attemptedIdentifier" VARCHAR(160),
    "ipAddress" VARCHAR(64),
    "userAgent" VARCHAR(400),
    "httpMethod" VARCHAR(10),
    "route" VARCHAR(200),
    "requiredPermission" VARCHAR(120),
    "tenantId" VARCHAR(64),
    "requestId" VARCHAR(64),
    "correlationId" VARCHAR(64),
    "traceId" VARCHAR(64),
    "moduleId" VARCHAR(64),
    "instanceId" VARCHAR(96),
    "reasonCode" VARCHAR(80),
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "domain" "LifecycleDomain" NOT NULL,
    "eventType" VARCHAR(120) NOT NULL,
    "phase" "LifecyclePhase" NOT NULL,
    "outcomeCode" VARCHAR(80),
    "subjectType" VARCHAR(40) NOT NULL,
    "subjectId" VARCHAR(64),
    "subjectKey" VARCHAR(120),
    "moduleId" VARCHAR(64),
    "instanceId" VARCHAR(96),
    "requestId" VARCHAR(64),
    "correlationId" VARCHAR(64),
    "traceId" VARCHAR(64),
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "tenantId" VARCHAR(64),
    "durationMs" INTEGER,
    "attempt" INTEGER,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "category" VARCHAR(40) NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" VARCHAR(500),
    "durationMs" INTEGER,

    CONSTRAINT "RetentionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplicationLog_occurredAt_idx" ON "ApplicationLog"("occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_level_occurredAt_idx" ON "ApplicationLog"("level", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_source_occurredAt_idx" ON "ApplicationLog"("source", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_messageCode_occurredAt_idx" ON "ApplicationLog"("messageCode", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_requestId_idx" ON "ApplicationLog"("requestId");

-- CreateIndex
CREATE INDEX "ApplicationLog_correlationId_idx" ON "ApplicationLog"("correlationId");

-- CreateIndex
CREATE INDEX "ApplicationLog_traceId_idx" ON "ApplicationLog"("traceId");

-- CreateIndex
CREATE INDEX "ApplicationLog_userId_occurredAt_idx" ON "ApplicationLog"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_tenantId_occurredAt_idx" ON "ApplicationLog"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_moduleId_occurredAt_idx" ON "ApplicationLog"("moduleId", "occurredAt");

-- CreateIndex
CREATE INDEX "ApplicationLog_statusCode_occurredAt_idx" ON "ApplicationLog"("statusCode", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_occurredAt_idx" ON "AuditEvent"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_resourceId_occurredAt_idx" ON "AuditEvent"("resourceType", "resourceId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorType_occurredAt_idx" ON "AuditEvent"("actorType", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_outcome_occurredAt_idx" ON "AuditEvent"("outcome", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "AuditEvent_traceId_idx" ON "AuditEvent"("traceId");

-- CreateIndex
CREATE INDEX "AuditEvent_moduleId_occurredAt_idx" ON "AuditEvent"("moduleId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_occurredAt_idx" ON "SecurityEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_occurredAt_idx" ON "SecurityEvent"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_severity_occurredAt_idx" ON "SecurityEvent"("severity", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_succeeded_occurredAt_idx" ON "SecurityEvent"("succeeded", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_actorId_occurredAt_idx" ON "SecurityEvent"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_ipAddress_occurredAt_idx" ON "SecurityEvent"("ipAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_tenantId_occurredAt_idx" ON "SecurityEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_correlationId_idx" ON "SecurityEvent"("correlationId");

-- CreateIndex
CREATE INDEX "SecurityEvent_traceId_idx" ON "SecurityEvent"("traceId");

-- CreateIndex
CREATE INDEX "SecurityEvent_moduleId_occurredAt_idx" ON "SecurityEvent"("moduleId", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_occurredAt_idx" ON "LifecycleEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_domain_occurredAt_idx" ON "LifecycleEvent"("domain", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_domain_eventType_occurredAt_idx" ON "LifecycleEvent"("domain", "eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_phase_occurredAt_idx" ON "LifecycleEvent"("phase", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_subjectType_subjectId_occurredAt_idx" ON "LifecycleEvent"("subjectType", "subjectId", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_moduleId_occurredAt_idx" ON "LifecycleEvent"("moduleId", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_instanceId_occurredAt_idx" ON "LifecycleEvent"("instanceId", "occurredAt");

-- CreateIndex
CREATE INDEX "LifecycleEvent_correlationId_idx" ON "LifecycleEvent"("correlationId");

-- CreateIndex
CREATE INDEX "LifecycleEvent_traceId_idx" ON "LifecycleEvent"("traceId");

-- CreateIndex
CREATE INDEX "LifecycleEvent_tenantId_occurredAt_idx" ON "LifecycleEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "RetentionRun_startedAt_idx" ON "RetentionRun"("startedAt");

-- CreateIndex
CREATE INDEX "RetentionRun_category_startedAt_idx" ON "RetentionRun"("category", "startedAt");
