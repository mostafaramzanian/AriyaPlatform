-- Phase W4-B: repeated partial refunds + the explicit refund→compensation link.
--
-- 1. The old (tenant_id, reverses_payment_id) UNIQUE made "one compensation per
--    payment" structural — and made a second legitimate partial refund
--    impossible. It is replaced by a plain read index; the cumulative cap moves
--    to `compensate`'s `SELECT … FOR UPDATE` on the original payment row.
DROP INDEX "PaymentRecord_tenant_id_reverses_payment_id_key";
CREATE INDEX "PaymentRecord_tenant_id_reverses_payment_id_idx" ON "PaymentRecord"("tenant_id", "reverses_payment_id");

-- 2. The refund names its actual COMPENSATION row, not just the original
--    payment — the link the closure evaluator reads so a manual compensation
--    of the same payment is never folded into a return's refund.
ALTER TABLE "ReturnLifecycleTransition" ADD COLUMN "refund_compensation_payment_id" UUID;
CREATE INDEX "ReturnTransition_tenant_id_refund_compensation_payment_id_idx" ON "ReturnLifecycleTransition"("tenant_id", "refund_compensation_payment_id");
ALTER TABLE "ReturnLifecycleTransition" ADD CONSTRAINT "ReturnTransition_tenant_id_refund_compensation_fkey" FOREIGN KEY ("tenant_id", "refund_compensation_payment_id") REFERENCES "PaymentRecord"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. LEGACY BACKFILL — unambiguous ONLY: a REFUNDED transition whose named
--    payment has EXACTLY ONE compensation row can name it as the refund's row.
--    Anything else stays NULL — unknown is honest, a guessed link is not.
UPDATE "ReturnLifecycleTransition" t
SET "refund_compensation_payment_id" = c."id"
FROM "PaymentRecord" c
WHERE c."tenant_id" = t."tenant_id"
  AND c."reverses_payment_id" = t."refunded_payment_id"
  AND t."state" = 'REFUNDED'
  AND t."refunded_payment_id" IS NOT NULL
  AND (
    SELECT COUNT(*) FROM "PaymentRecord" c2
    WHERE c2."tenant_id" = t."tenant_id"
      AND c2."reverses_payment_id" = t."refunded_payment_id"
  ) = 1;
