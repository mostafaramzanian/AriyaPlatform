-- Phase PRODUCTION-BOM-ITEM: the BOM ITEM child table, added as its OWN migration so the
-- applied baseline (`20261002220459_production_baseline`) stays history rather than being
-- rewritten. `production-schema.spec.ts` still reads the baseline as "exactly BomHeader";
-- this migration is what the schema grew to on top of it.
--
-- WHY THE FOREIGN KEY IS SAME-DATABASE AND RESTRICT (not CASCADE)
-- ----------------------------------------------------------------
-- The referenced pair is `BomHeader("tenant_id","id")` — the composite tenant-first unique
-- key the baseline already declared precisely so a child table could reference it. That
-- makes "an item belongs to a header of the SAME tenant" a database fact rather than a
-- service-layer promise: an INSERT naming another tenant's `bom_id` fails here even if a
-- repository bug ever skipped the tenant predicate.
--
-- `ON DELETE RESTRICT` is deliberate. The header has no delete route, so nothing should
-- ever remove a BOM that holds reviewed items; if a delete route is added later the
-- database refuses to orphan items instead of silently destroying an approval's evidence.
--
-- THERE IS STILL NO CROSS-DATABASE REFERENCE. Nothing here names another owner's database,
-- an extension or a foreign table: `projectRef`, `productTreeRef` and the supplier suggestion
-- are opaque STRING columns (CF-1 / RB-1).
--
-- LEGACY / DEFERRED COLUMNS ARE CREATED NULLABLE AND RULE-LESS: `standard_part_code`
-- (Product Tree Code generation is DEFERRED — RB-1-P), `legacy_part_code`,
-- `legacy_item_state`, `legacy_manager_opinion` and the five derived consumption
-- coefficients all have NO writer and NO formula in the source, so no constraint that
-- would invent one is added here.

-- CreateEnum
CREATE TYPE "BomPartType" AS ENUM ('STRUCTURAL', 'STANDARD');

-- CreateEnum
CREATE TYPE "BomControlPlan" AS ENUM ('PRESENT', 'ABSENT');

-- CreateTable
CREATE TABLE "BomItem" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bom_id" UUID NOT NULL,
    "project_ref" VARCHAR(128) NOT NULL,
    "product_tree_ref" VARCHAR(128) NOT NULL,
    "part_name" VARCHAR(200) NOT NULL,
    "industry_part_name" VARCHAR(200),
    "standard_part_code" VARCHAR(128),
    "part_type" "BomPartType" NOT NULL,
    "specifications" VARCHAR(2000),
    "manufacturer" VARCHAR(200),
    "material" VARCHAR(200) NOT NULL,
    "measurement_unit" VARCHAR(64) NOT NULL,
    "drawing_consumption_coefficient" INTEGER NOT NULL,
    "spare_consumption_coefficient" INTEGER NOT NULL,
    "suggested_supplier" VARCHAR(200),
    "suggested_supplier_price" DECIMAL(18,2),
    "control_plan" "BomControlPlan",
    "notes" VARCHAR(2000),
    "legacy_part_code" VARCHAR(128),
    "legacy_item_state" INTEGER,
    "legacy_manager_opinion" "ManagerOpinion",
    "legacy_consumption_total_coefficient" INTEGER,
    "legacy_consumption_in_drawing_on_order" INTEGER,
    "legacy_consumption_spare_test_on_order" INTEGER,
    "legacy_consumption_in_drawing_purchased" INTEGER,
    "legacy_consumption_spare_test_purchased" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BomItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomItem_tenantId_bomId_idx" ON "BomItem"("tenant_id", "bom_id");

-- CreateIndex
CREATE INDEX "BomItem_tenantId_bomId_createdAt_idx" ON "BomItem"("tenant_id", "bom_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "BomItem_tenantId_id_key" ON "BomItem"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "BomItem" ADD CONSTRAINT "BomItem_tenant_id_bom_id_fkey" FOREIGN KEY ("tenant_id", "bom_id") REFERENCES "BomHeader"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
