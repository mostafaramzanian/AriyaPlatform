-- Phase 49H: Core Surveys / Participation.
--
-- Adds ONLY the five survey tables and two enums. No change to User columns
-- (only new inbound foreign keys), Tenant, Role/Permission/UserRole (RBAC grants
-- for the four new survey permissions live in their own follow-up migration, in
-- the style of 20260828093000_seed_admin_permission_grants),
-- AuditLog/AuditDispatch, Notification, Conversation/Message (49F), or Ticket*
-- (49G). Core schema only: nothing here touches `aria_erp` or `cms_db`.

-- CreateEnum
-- Forward-only lifecycle. CLOSED is terminal: there is no reopen transition, so
-- no column models a reopen count or a previous-status pointer.
CREATE TYPE "SurveyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TEXT', 'RATING');

-- CreateTable
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "SurveyStatus" NOT NULL DEFAULT 'DRAFT',
    -- Changes ONLY what results expose. The respondent is always recorded on
    -- SurveyResponse.userId, because duplicate prevention is a UNIQUE
    -- constraint and that is not expressible without storing identity.
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    -- Optional availability window, honoured only while status is PUBLISHED.
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    -- Set on first arrival at PUBLISHED / CLOSED. Never cleared.
    "publishedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyQuestion" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "text" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    -- 1-based, UNIQUE per survey.
    "order" INTEGER NOT NULL,
    -- MULTIPLE_CHOICE only; a CHECK keeps it NULL for every other type.
    "maxSelections" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Snapshot of the respondent's tenant at submission time.
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyAnswer" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    -- Exactly one of the three value columns is populated; see the
    -- SurveyAnswer_one_value CHECK below.
    "optionId" TEXT,
    "textValue" TEXT,
    "ratingValue" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the tenant-scoped list (newest first) and the status facet. The trailing
-- id keeps the cursor total, so keyset pagination cannot skip or repeat a row
-- when two surveys share a createdAt.
CREATE INDEX "Survey_tenantId_createdAt_id_idx" ON "Survey"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Survey_tenantId_status_createdAt_id_idx" ON "Survey"("tenantId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Survey_createdById_idx" ON "Survey"("createdById");

-- CreateIndex
CREATE INDEX "SurveyQuestion_surveyId_order_idx" ON "SurveyQuestion"("surveyId", "order");

-- CreateIndex
-- Two questions can never claim the same slot.
CREATE UNIQUE INDEX "SurveyQuestion_surveyId_order_key" ON "SurveyQuestion"("surveyId", "order");

-- CreateIndex
CREATE INDEX "SurveyOption_questionId_order_idx" ON "SurveyOption"("questionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyOption_questionId_order_key" ON "SurveyOption"("questionId", "order");

-- CreateIndex
CREATE INDEX "SurveyResponse_surveyId_createdAt_id_idx" ON "SurveyResponse"("surveyId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "SurveyResponse_userId_idx" ON "SurveyResponse"("userId");

-- CreateIndex
-- THE duplicate-participation arbiter. Two concurrent submissions cannot both
-- succeed: the loser gets a 23505 unique violation, which the service maps to a
-- 409. The application-level "already responded?" pre-check is a friendlier
-- error path, never the guarantee.
CREATE UNIQUE INDEX "SurveyResponse_surveyId_userId_key" ON "SurveyResponse"("surveyId", "userId");

-- CreateIndex
CREATE INDEX "SurveyAnswer_responseId_questionId_idx" ON "SurveyAnswer"("responseId", "questionId");

-- CreateIndex
-- Serves the aggregate: WHERE "questionId" = $1 GROUP BY "optionId".
CREATE INDEX "SurveyAnswer_questionId_optionId_idx" ON "SurveyAnswer"("questionId", "optionId");

-- CreateIndex
-- Answer cardinality, database-enforced. Prisma cannot express a partial index,
-- so these two are hand-written and must be preserved by any future migration.
--
-- (1) A choice answer may name a given option at most once inside a response, so
--     a MULTIPLE_CHOICE submission cannot double-count one option to skew the
--     aggregate.
CREATE UNIQUE INDEX "SurveyAnswer_choice_unique"
  ON "SurveyAnswer"("responseId", "questionId", "optionId")
  WHERE "optionId" IS NOT NULL;

-- CreateIndex
-- (2) A non-choice answer (TEXT / RATING) may appear at most once per question
--     inside a response.
CREATE UNIQUE INDEX "SurveyAnswer_scalar_unique"
  ON "SurveyAnswer"("responseId", "questionId")
  WHERE "optionId" IS NULL;

-- AddCheckConstraint
-- Bounded, non-empty plain text. The DTO enforces the same bounds; this is the
-- floor that holds even if a caller reaches the database by another path.
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_title_len" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_description_len" CHECK ("description" IS NULL OR char_length("description") <= 2000);

-- An availability window must be a real interval, not an inverted one.
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_window_order" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

-- A survey that has never been published cannot carry a publication or closure
-- timestamp, and a closed one cannot predate its own publication. This is what
-- makes the forward-only lifecycle a database fact rather than a service habit.
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_status_timestamps" CHECK (
  ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "closedAt" IS NULL)
  OR ("status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL AND "closedAt" IS NULL)
  OR ("status" = 'CLOSED' AND "publishedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "closedAt" >= "publishedAt")
);

ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_text_len" CHECK (char_length("text") BETWEEN 1 AND 500);
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_order_positive" CHECK ("order" >= 1);

-- maxSelections is meaningful only for MULTIPLE_CHOICE; every other shape must
-- leave it NULL rather than carry a number nothing reads.
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_max_selections_scope" CHECK (
  ("type" = 'MULTIPLE_CHOICE' AND ("maxSelections" IS NULL OR "maxSelections" >= 1))
  OR ("type" <> 'MULTIPLE_CHOICE' AND "maxSelections" IS NULL)
);

ALTER TABLE "SurveyOption" ADD CONSTRAINT "SurveyOption_label_len" CHECK (char_length("label") BETWEEN 1 AND 200);
ALTER TABLE "SurveyOption" ADD CONSTRAINT "SurveyOption_order_positive" CHECK ("order" >= 1);

-- Exactly one value column is populated, so an answer row can never be ambiguous
-- about which kind of answer it is.
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_one_value" CHECK (
  (CASE WHEN "optionId" IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN "textValue" IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN "ratingValue" IS NOT NULL THEN 1 ELSE 0 END) = 1
);
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_text_len" CHECK ("textValue" IS NULL OR char_length("textValue") BETWEEN 1 AND 2000);

-- The fixed 1..5 scale the UI renders, matching TicketSatisfaction_rating_bounds.
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_rating_range" CHECK ("ratingValue" IS NULL OR "ratingValue" BETWEEN 1 AND 5);


-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyOption" ADD CONSTRAINT "SurveyOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "SurveyQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "SurveyResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "SurveyQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, not CASCADE: an option that has been answered cannot be deleted out
-- from under the aggregate.
ALTER TABLE "SurveyAnswer" ADD CONSTRAINT "SurveyAnswer_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "SurveyOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


