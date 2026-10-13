-- Phase B2 — AUDIT DURABILITY: transactional outbox for durable audit delivery.
--
-- The outbox row is written in the SAME transaction as the business state
-- mutation, so they commit or roll back together. A relay service reads pending
-- rows and writes them through AUDIT_PORT to core_db."AuditLog".

CREATE TABLE "AuditOutbox" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "audit_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditOutbox_pkey" PRIMARY KEY ("id")
);

-- Idempotency key: one outbox row per logical audit event.
CREATE UNIQUE INDEX "AuditOutbox_auditId_key" ON "AuditOutbox"("audit_id");

-- Relay polling: next pending rows ordered by scheduled time.
CREATE INDEX "AuditOutbox_nextAt_idx" ON "AuditOutbox"("next_at");

-- Tenant-scoped reads (observability / cleanup).
CREATE INDEX "AuditOutbox_tenantId_idx" ON "AuditOutbox"("tenant_id");
