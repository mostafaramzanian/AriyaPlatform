-- Phase 49I-1: official Iranian occasions & holidays reference data (Core).
--
-- Additive only. Adds ONE table and ONE enum, touches nothing else: no change
-- to Reminder, Notification, Ticket*, Survey* or the RBAC rows. A re-run on a
-- schema that already has the table is a no-op via the idempotent guard at the
-- bottom; the seed rows themselves live in the FOLLOWING migration
-- (seed_calendar_occasions_1405) so the schema and the dataset can be applied
-- and reviewed independently.
--
-- WHY A TABLE (NOT A CODE MAP): see the schema comment above `model
-- CalendarOccasion`. Reference data in this repository is seeded by migration
-- (the RBAC Permission catalogue is the precedent); the 49I-1 contract forbids
-- component-local holiday lists and a new Jalali year must be a new dataset,
-- not a code change.
--
-- FRIDAY IS NOT ENCODED HERE: the weekly Friday closure is derived at render
-- time from the day's weekday. Row(s) here carry `isHoliday` only for the real
-- published closures, so a Friday that is also e.g. Ashura will be BOTH a
-- normal Friday and a holiday via the day's rows + weekday, never via a fake
-- "جمعه" record.

-- CreateEnum
CREATE TYPE "OccasionCategory" AS ENUM ('NATIONAL', 'RELIGIOUS', 'INTERNATIONAL', 'OTHER');

-- CreateTable
CREATE TABLE "CalendarOccasion" (
    "id" TEXT NOT NULL,
    -- Canonical Jalali date in the wire form YYYY/MM/DD (Latin digits).
    "jalaliDate" VARCHAR(10) NOT NULL,
    -- Integer components, kept so a month view is ONE indexed range scan
    -- (jm = ? AND jy = ?) instead of one query per day.
    "jy" INTEGER NOT NULL,
    "jm" INTEGER NOT NULL,
    "jd" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isHoliday" BOOLEAN NOT NULL DEFAULT false,
    "category" "OccasionCategory" NOT NULL DEFAULT 'OTHER',
    -- Provenance: which published calendar and which Jalali year.
    "source" TEXT NOT NULL,
    "sourceYear" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarOccasion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The month-view range scan (49I-1: one bounded date-range query per calendar view).
CREATE INDEX "CalendarOccasion_jy_jm_idx" ON "CalendarOccasion"("jy", "jm");

-- CreateIndex
-- Provenance rollover: retire the whole previous year by (source, sourceYear).
CREATE INDEX "CalendarOccasion_source_sourceYear_idx" ON "CalendarOccasion"("source", "sourceYear");

-- CreateIndex
-- Cheap "was that day working" when only the flag matters.
CREATE INDEX "CalendarOccasion_jy_jm_isHoliday_idx" ON "CalendarOccasion"("jy", "jm", "isHoliday");

-- CreateIndex
-- Identity: one published occasion is one fact. This is what makes a re-run of
-- the seed a no-op and what makes a genuinely duplicate insert fail loudly.
CREATE UNIQUE INDEX "CalendarOccasion_jalaliDate_source_title_key" ON "CalendarOccasion"("jalaliDate", "source", "title");

-- Bounds enforced in the database as well, matching the existing CHECK style
-- ("Notification_title_len"). jy matches the API window (1300..1500) the
-- jalali.util contract already clamps to; a date outside it is a typo, not data.
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_jy_range" CHECK ("jy" BETWEEN 1300 AND 1500);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_jm_range" CHECK ("jm" BETWEEN 1 AND 12);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_jd_range" CHECK ("jd" BETWEEN 1 AND 31);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_jalaliDate_len" CHECK (char_length("jalaliDate") = 10);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_title_len" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_source_len" CHECK (char_length("source") BETWEEN 1 AND 64);
ALTER TABLE "CalendarOccasion" ADD CONSTRAINT "CalendarOccasion_description_len" CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 300);

-- The seed lives in the next migration. Kept separate so schema/migration
-- review sees the data decision on its own.