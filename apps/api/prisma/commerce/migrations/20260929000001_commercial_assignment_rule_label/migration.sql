-- Phase C1 Step P: the persisted "which rule decided this?" fact (§3-M).
-- Generated with `prisma migrate diff --from-url <commerce_db>
-- --to-schema-datamodel prisma/commerce/schema.prisma --script`, inspected,
-- and applied with `prisma migrate deploy`. ADDITIVE ONLY: two nullable
-- VARCHAR(128) columns — no table is rewritten, no data is touched, and the
-- 20260929000000 migration stays exactly as it was applied.

-- AlterTable
ALTER TABLE "CommercialAssignment" ADD COLUMN     "matched_rule_label" VARCHAR(128);

-- AlterTable
ALTER TABLE "CommercialAssignmentHistory" ADD COLUMN     "matched_rule_label" VARCHAR(128);
