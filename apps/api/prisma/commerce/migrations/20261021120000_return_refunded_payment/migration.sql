-- PHASE W3.1 (confirmed closure rule): `ReturnLifecycleTransition` gains
-- `refunded_payment_id` — on the `REFUNDED` row only, the `PaymentRecord` the
-- refund settled (the payment whose compensating row Q appended in the same
-- transaction). This is the persisted link between a resolved return and its
-- financial settlement: the closure evaluator subtracts the refunded
-- payments' amounts from the document total to get the NET payable, instead
-- of guessing which payment compensations belong to returns.
--
-- NO BACKFILL, DELIBERATELY: returns refunded before this migration have no
-- recorded link, and none is inferred — the evaluator treats such a document
-- conservatively (the payment projection decides unaided), never fabricates.
ALTER TABLE "ReturnLifecycleTransition"
    ADD COLUMN "refunded_payment_id" UUID;
