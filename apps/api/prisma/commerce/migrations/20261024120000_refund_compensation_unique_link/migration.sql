-- PHASE W4-D: one compensation row settles AT MOST ONE refunded return
-- transition. The W4-B column links a REFUNDED transition to the exact
-- `PaymentRecord` that settled it; without uniqueness a single ledger row
-- could be claimed by two transitions and the same money counted twice by
-- the closure evaluator. The partial unique index covers only non-null
-- links — legacy and non-refund transitions keep their NULLs.
--
-- Existing-data safety: the column was added by 20261023120000 one step
-- earlier; rows carrying it can only exist where the service wrote them,
-- and the service writes each transition's OWN fresh compensation id, so
-- duplicates cannot already exist. The migration deliberately contains no
-- DELETE or UPDATE — financial history is append-only.
CREATE UNIQUE INDEX "ReturnLifecycleTransition_tenant_id_refund_compensation_key"
  ON "ReturnLifecycleTransition"("tenant_id", "refund_compensation_payment_id")
  WHERE "refund_compensation_payment_id" IS NOT NULL;
