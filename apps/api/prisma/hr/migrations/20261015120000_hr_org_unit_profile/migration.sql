-- Org-chart profile fields on OrganizationUnit.
--
-- The /admin/hr/organization screen renders a per-unit detail card (سرپرست,
-- موقعیت استقرار، سقف بودجه، مسئولیت اصلی) and an عملیاتی/ستادی legend. All
-- columns are nullable with defaults where needed, so existing rows migrate
-- cleanly and a unit remains valid with only code/name/parent.

CREATE TYPE "OrganizationUnitKind" AS ENUM ('OPERATIONAL', 'STAFF');

ALTER TABLE "OrganizationUnit"
    ADD COLUMN "kind" "OrganizationUnitKind" NOT NULL DEFAULT 'OPERATIONAL',
    ADD COLUMN "manager_name" VARCHAR(200),
    ADD COLUMN "location" VARCHAR(200),
    ADD COLUMN "monthly_budget" DECIMAL(20, 0),
    ADD COLUMN "responsibility" VARCHAR(500);
