-- Phase PRODUCTION-BOM-CHANGE: the CHANGE REQUEST aggregate — «ثبت درخواست تغییر BOM» —
-- added as its OWN migration so the two applied migrations
-- (`20261002220459_production_baseline`, `20261003120000_production_bom_item`) stay
-- history rather than being rewritten. `production-schema.spec.ts` reads each of them as
-- the artifact it was; this is what the schema grew to on top of them.
--
-- WHERE IT COMES FROM
-- -------------------
-- `BomEdit.txt` (the form «ثبت درخواست تغییر BOM»), its list `تغییر Bom` and its detail
-- list `جزئیات تغییر Bom`. Nothing else in the supplied material writes these two tables,
-- and NOTHING HERE WRITES `BomHeader` OR `BomItem`: approving a change request does not
-- mutate the BOM in any supplied script, so `Apply Change` is DEFERRED and this migration
-- contains no trigger, no function and no default that could perform one.
--
-- WHY THE FOREIGN KEYS ARE SAME-DATABASE AND RESTRICT
-- ---------------------------------------------------
-- Three composite, tenant-first FKs — `(tenant_id, bom_id)` → `BomHeader`, and
-- `(tenant_id, change_request_id)` / `(tenant_id, bom_item_id)` →
-- `BomChangeRequest` / `BomItem` — each referencing a UNIQUE pair the owning table already
-- declares. That makes THREE facts database-level rather than service-level promises: a
-- request can never be attached to another tenant's BOM, a detail can never be attached to
-- another tenant's request, and a detail can never name another tenant's item.
--
-- `ON DELETE RESTRICT` throughout is deliberate. The header has no delete route, so nothing
-- should ever remove a BOM that holds reviewed change requests; and an item named by a
-- request must not be hard-deletable while that request exists, because the request's
-- evidence would vanish with it. If a delete route is ever added, the database refuses
-- rather than silently destroying an approval's trail.
--
-- THERE IS STILL NO CROSS-DATABASE REFERENCE. Nothing here names another owner's database,
-- an extension or a foreign table: `project_ref`, `product_tree_ref` and the three user-id
-- columns are opaque STRING columns (CF-1 / RB-1).
--
-- WHAT IS DELIBERATELY *NOT* INVENTED
-- -----------------------------------
--  * NO `total` column. The source computes `original + delta` in a display script and
--    never stores it; a persisted total would be a second, authoritative-looking answer to
--    a question the source answers on screen only.
--  * NO minimum, maximum or positivity CHECK on the two deltas. The source's `> 0` and
--    `isNaN` checks are COMMENTED OUT, and a decrease is the point of the field's name —
--    `NULL` means "not stated", `0` means "stated as no change", and both are legal.
--  * NO `inactive` / `deactivated_at` column on `BomItem` and NO state column for it. The
--    source proves the change TYPE «غیر فعال سازی» exists and nothing more, so the schema
--    does not pretend to know what approval would write.
--  * NO duplicated `idBomChange` column. The source wrote BOTH `IdBomChangeStack` and
--    `idBomChange` with the same request id; one column is the fact, two would be a way for
--    the two to disagree.

-- CreateEnum
CREATE TYPE "BomChangeType" AS ENUM ('QUANTITY_CHANGE', 'DEACTIVATE');

-- CreateTable
CREATE TABLE "BomChangeRequest" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bom_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "project_ref" VARCHAR(128) NOT NULL,
    "product_tree_ref" VARCHAR(128) NOT NULL,
    "requester_user_id" TEXT NOT NULL,
    "approver_user_id" TEXT,
    "status" "BomStatus" NOT NULL DEFAULT 'DRAFT',
    "manager_opinion" "ManagerOpinion",
    "notes" VARCHAR(2000),
    "request_date" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BomChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomChangeRequestItem" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "change_request_id" UUID NOT NULL,
    "bom_item_id" UUID NOT NULL,
    "change_type" "BomChangeType" NOT NULL,
    "original_drawing_coefficient" INTEGER NOT NULL,
    "original_spare_coefficient" INTEGER NOT NULL,
    "drawing_coefficient_delta" INTEGER,
    "spare_coefficient_delta" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BomChangeRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BomChangeRequest_tenantId_bomId_idx" ON "BomChangeRequest"("tenant_id", "bom_id");

-- CreateIndex
CREATE INDEX "BomChangeRequest_tenantId_status_idx" ON "BomChangeRequest"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BomChangeRequest_tenantId_id_key" ON "BomChangeRequest"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "BomChangeRequestItem_tenantId_changeRequestId_idx" ON "BomChangeRequestItem"("tenant_id", "change_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "BomChangeRequestItem_tenantId_id_key" ON "BomChangeRequestItem"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BomChangeRequestItem_tenantId_changeRequestId_bomItemId_key" ON "BomChangeRequestItem"("tenant_id", "change_request_id", "bom_item_id");

-- AddForeignKey
ALTER TABLE "BomChangeRequest" ADD CONSTRAINT "BomChangeRequest_tenant_id_bom_id_fkey" FOREIGN KEY ("tenant_id", "bom_id") REFERENCES "BomHeader"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomChangeRequestItem" ADD CONSTRAINT "BomChangeRequestItem_tenant_id_change_request_id_fkey" FOREIGN KEY ("tenant_id", "change_request_id") REFERENCES "BomChangeRequest"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BomChangeRequestItem" ADD CONSTRAINT "BomChangeRequestItem_tenant_id_bom_item_id_fkey" FOREIGN KEY ("tenant_id", "bom_item_id") REFERENCES "BomItem"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- THE APPROVER INVARIANT, stated in the database rather than trusted to application
-- arithmetic — the SAME move `BomHeader_submitted_requires_approver` already makes, on the
-- SAME lifecycle, for the same reason: an invariant that lives only in the service is an
-- invariant a second caller can violate.
--
-- WHAT IT FORBIDS: a request that has LEFT the editable state without naming an approver.
-- The approver is snapshotted at submit, so "SUBMITTED and nobody was asked" is not a state
-- the domain permits — and a row in it would be a routing decision that no history could
-- explain. The service already refuses the transition; this is what makes the refusal
-- retroactively provable from the storage side too.
--
-- WHY IT IS NOT IN `schema.prisma`: Prisma has no representation for a CHECK constraint. It
-- is declared here, exactly as the header's is, so `prisma migrate diff` reports it as a
-- known, documented difference rather than as drift somebody forgot to model.
ALTER TABLE "BomChangeRequest"
  ADD CONSTRAINT "BomChangeRequest_submitted_requires_approver"
  CHECK ("status" = 'DRAFT' OR "approver_user_id" IS NOT NULL);
