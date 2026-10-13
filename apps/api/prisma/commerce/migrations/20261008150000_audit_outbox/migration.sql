-- Phase B2.3: Commerce transactional audit outbox
-- Identical structure to Financial's AuditOutbox (Phase B2), context-local.

CREATE TABLE "AuditOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" TEXT NOT NULL,
    "audit_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuditOutbox_tenant_auditId_key" ON "AuditOutbox"("tenant_id", "audit_id");
CREATE INDEX "AuditOutbox_tenant_nextAt_idx" ON "AuditOutbox"("tenant_id", "next_at");
CREATE INDEX "AuditOutbox_tenant_createdAt_idx" ON "AuditOutbox"("tenant_id", "created_at");
