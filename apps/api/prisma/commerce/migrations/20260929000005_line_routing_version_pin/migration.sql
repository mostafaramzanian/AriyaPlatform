-- Phase C1 O4 remediation: pin WorkflowLineRoutingVersion on PurchaseDocument.
-- ADDITIVE ONLY: tenant-first unique target on WorkflowLineRoutingVersion and
-- nullable line_routing_version_id on PurchaseDocument with composite FK.

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowLineRoutingVersion_tenantId_id_key" ON "WorkflowLineRoutingVersion"("tenant_id", "id");

-- AlterTable
ALTER TABLE "PurchaseDocument" ADD COLUMN "line_routing_version_id" UUID;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_tenant_id_line_routing_version_id_fkey" FOREIGN KEY ("tenant_id", "line_routing_version_id") REFERENCES "WorkflowLineRoutingVersion"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
