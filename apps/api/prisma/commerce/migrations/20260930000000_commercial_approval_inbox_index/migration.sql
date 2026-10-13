-- PHASE C2 (GAP-1b): the pending-decision inbox's actor-scoped read.
--
-- Additive, one statement, and shaped exactly like the index step N already ships for its
-- own pending-step query (`WorkflowStepInstance_tenantId_approver_status_idx`): tenant
-- first, then the approver, then the status. `CommercialApproval` had no approver-leading
-- index, so the inbox's predicate would otherwise scan every approval of the tenant and
-- filter afterwards — correct, but a full slice read per inbox request. Nothing existing
-- changes: both prior CommercialApproval indexes keep their names and their columns.
CREATE INDEX "CommercialApproval_tenantId_approverUserId_status_idx" ON "CommercialApproval"("tenant_id", "approver_user_id", "status");
