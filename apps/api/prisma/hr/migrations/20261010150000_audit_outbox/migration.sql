-- Phase B2.5: HR transactional audit outbox for durable delivery.
--
-- The table is a delivery buffer, NOT a second audit trail. HR-local durable-required
-- events are written here atomically with the business mutation, then relayed to
-- the platform audit trail through AUDIT_PORT asynchronously.

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

-- Tenant-first unique: one outbox row per event identity per tenant.
CREATE UNIQUE INDEX "HrAuditOutbox_tenant_auditId_key" ON "AuditOutbox"("tenant_id", "audit_id");

-- Tenant-first poll: the relay fetches due rows for all tenants.
CREATE INDEX "HrAuditOutbox_tenant_nextAt_idx" ON "AuditOutbox"("tenant_id", "next_at");

-- Tenant-first age: diagnostic queries on event age.
CREATE INDEX "HrAuditOutbox_tenant_createdAt_idx" ON "AuditOutbox"("tenant_id", "created_at");
