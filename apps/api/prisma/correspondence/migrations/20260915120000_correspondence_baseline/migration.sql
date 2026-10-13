-- CreateEnum
CREATE TYPE "LetterStatus" AS ENUM ('DRAFT', 'READY_TO_SEND', 'SCHEDULED', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LetterUrgency" AS ENUM ('NORMAL', 'IMPORTANT', 'URGENT', 'CRITICAL');

-- CreateEnum
CREATE TYPE "LetterClassification" AS ENUM ('NORMAL', 'CONFIDENTIAL', 'SECRET');

-- CreateEnum
CREATE TYPE "LetterRecipientKind" AS ENUM ('TO', 'CC', 'BCC');

-- CreateEnum
CREATE TYPE "LetterRecipientState" AS ENUM ('DELIVERED', 'VIEWED', 'READ', 'ACTION_REQUIRED', 'REFERRED', 'ACTED');

-- CreateEnum
CREATE TYPE "ReferralLevel" AS ENUM ('NORMAL', 'INFORM', 'REVIEW', 'DECIDE', 'EXECUTE', 'FINAL_APPROVE');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'VIEWED', 'ACTED');

-- CreateEnum
CREATE TYPE "LetterTrackingEventType" AS ENUM ('CREATED', 'SENT', 'VIEWED', 'READ', 'REFERRED', 'REFERRAL_ACTED', 'CLASSIFICATION_CHANGED', 'ARCHIVED', 'UNARCHIVED');

-- CreateTable
CREATE TABLE "Letter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "letterNumber" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "category" TEXT,
    "urgency" "LetterUrgency" NOT NULL DEFAULT 'NORMAL',
    "classification" "LetterClassification" NOT NULL DEFAULT 'NORMAL',
    "status" "LetterStatus" NOT NULL DEFAULT 'DRAFT',
    "letterDate" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "senderId" TEXT NOT NULL,
    "senderRemovedAt" TIMESTAMP(3),
    "sendKey" TEXT,
    "readyAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastSendAttemptAt" TIMESTAMP(3),
    "lastSendError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "signatureId" TEXT,

    CONSTRAINT "Letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterNumberCounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LetterNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterRecipient" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "kind" "LetterRecipientKind" NOT NULL DEFAULT 'TO',
    "state" "LetterRecipientState" NOT NULL DEFAULT 'DELIVERED',
    "deliveredAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "actedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterReferral" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "tenantId" TEXT,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "urgency" "LetterUrgency" NOT NULL DEFAULT 'NORMAL',
    "level" "ReferralLevel" NOT NULL DEFAULT 'NORMAL',
    "instruction" TEXT,
    "isConfidential" BOOLEAN NOT NULL DEFAULT false,
    "removeFromInbox" BOOLEAN NOT NULL DEFAULT false,
    "clientKey" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "viewedAt" TIMESTAMP(3),
    "actedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterTrackingEvent" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "type" "LetterTrackingEventType" NOT NULL,
    "actorId" TEXT,
    "recipientUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterTrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterAttachment" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterSignature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterTempAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterTempAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveFolder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LetterArchive" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folderId" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "LetterArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Letter_sendKey_key" ON "Letter"("sendKey");

-- CreateIndex
CREATE UNIQUE INDEX "Letter_signatureId_key" ON "Letter"("signatureId");

-- CreateIndex
CREATE INDEX "Letter_tenantId_senderId_createdAt_id_idx" ON "Letter"("tenantId", "senderId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Letter_tenantId_status_createdAt_id_idx" ON "Letter"("tenantId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Letter_tenantId_letterNumber_idx" ON "Letter"("tenantId", "letterNumber");

-- CreateIndex
CREATE INDEX "Letter_senderId_idx" ON "Letter"("senderId");

-- CreateIndex
CREATE UNIQUE INDEX "Letter_tenantId_letterNumber_key" ON "Letter"("tenantId", "letterNumber");

-- CreateIndex
CREATE UNIQUE INDEX "LetterNumberCounter_tenantId_year_key" ON "LetterNumberCounter"("tenantId", "year");

-- CreateIndex
CREATE INDEX "LetterRecipient_userId_deliveredAt_id_idx" ON "LetterRecipient"("userId", "deliveredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "LetterRecipient_letterId_kind_idx" ON "LetterRecipient"("letterId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LetterRecipient_letterId_userId_key" ON "LetterRecipient"("letterId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LetterReferral_clientKey_key" ON "LetterReferral"("clientKey");

-- CreateIndex
CREATE INDEX "LetterReferral_letterId_createdAt_id_idx" ON "LetterReferral"("letterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LetterReferral_toUserId_status_createdAt_id_idx" ON "LetterReferral"("toUserId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "LetterReferral_fromUserId_createdAt_id_idx" ON "LetterReferral"("fromUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "LetterTrackingEvent_letterId_createdAt_id_idx" ON "LetterTrackingEvent"("letterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LetterAttachment_letterId_createdAt_idx" ON "LetterAttachment"("letterId", "createdAt");

-- CreateIndex
CREATE INDEX "LetterTempAttachment_uploadedBy_createdAt_idx" ON "LetterTempAttachment"("uploadedBy", "createdAt");

-- CreateIndex
CREATE INDEX "ArchiveFolder_ownerId_parentId_idx" ON "ArchiveFolder"("ownerId", "parentId");

-- CreateIndex
CREATE INDEX "LetterArchive_userId_folderId_archivedAt_id_idx" ON "LetterArchive"("userId", "folderId", "archivedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LetterArchive_letterId_userId_key" ON "LetterArchive"("letterId", "userId");

-- AddForeignKey
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "LetterSignature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterTrackingEvent" ADD CONSTRAINT "LetterTrackingEvent_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterAttachment" ADD CONSTRAINT "LetterAttachment_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveFolder" ADD CONSTRAINT "ArchiveFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ArchiveFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterArchive" ADD CONSTRAINT "LetterArchive_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ArchiveFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterArchive" ADD CONSTRAINT "LetterArchive_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- CHECK constraints and the dispatcher's partial index (Phase 50-MOD-CORR).
--
-- These are NOT expressible in schema.prisma (Prisma has no CHECK support and no
-- partial-index support), which is why they are declared here and documented in the
-- model docstrings — the same split the Core migrations already use for 49I's
-- "Reminder_pending_dueAt_idx" and 49H's cardinality checks.
--
-- They are part of the BASELINE rather than a follow-up migration because this
-- database is created by this phase: there is no earlier state to correct, and a
-- fresh database that lacked them would be born weaker than the one it replaces.
-- ============================================================================

-- Letter: bounded text, and the forward-only lifecycle as a database fact.
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_subject_len" CHECK (char_length("subject") BETWEEN 1 AND 255);
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_bodyHtml_len" CHECK (char_length("bodyHtml") BETWEEN 1 AND 200000);
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_category_len" CHECK ("category" IS NULL OR char_length("category") BETWEEN 1 AND 100);

-- ============================================================================
-- THE D1 CORRECTION.
--
-- Core's constraint (20260912120000_add_correspondence) listed only four statuses and
-- 20260914130000_add_scheduled_send added SCHEDULED to the ENUM without extending this
-- CHECK. The result was a state the enum allowed and the table refused: every attempt to
-- schedule a letter failed with a check-constraint violation, proven live against
-- core_db before this extraction (UPDATE ... SET status='SCHEDULED' → violated
-- Letter_status_timestamps, rolled back). The SCHEDULED branch below is therefore not a
-- refinement of the old rule but its missing half.
--
-- The invariant is unchanged in spirit — status and its timestamps agree, a sent letter
-- carries a number, and only DRAFT/READY_TO_SEND/SCHEDULED rows carry none:
--   * SCHEDULED is COMMITTED AND READY (`readyAt` set — exactly what the service's
--     scheduling branch writes) but not sent, so it carries no number and no sentAt;
--   * `scheduledAt` must be present, otherwise the state has no clock and no dispatcher
--     could ever find the letter.
-- ============================================================================
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_status_timestamps" CHECK (
  ("status" = 'DRAFT' AND "readyAt" IS NULL AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NULL)
  OR ("status" = 'READY_TO_SEND' AND "readyAt" IS NOT NULL AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NULL)
  OR ("status" = 'SCHEDULED' AND "readyAt" IS NOT NULL AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NULL AND "scheduledAt" IS NOT NULL)
  OR ("status" = 'SENT' AND "sentAt" IS NOT NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NOT NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "sentAt" IS NULL AND "letterNumber" IS NULL)
);

-- A dispatcher claim count can never go negative.
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_sendAttempts_non_negative" CHECK ("sendAttempts" >= 0);

-- ============================================================================
-- THE D8/D9 DISPATCHER INDEX.
--
-- The due scan is `status = 'SCHEDULED' AND "scheduledAt" <= now() AND "sendAttempts" < MAX`.
-- Without this index it is a sequential scan of every letter the organization ever wrote,
-- re-run every 30 seconds. It is PARTIAL because only SCHEDULED rows can be due — terminal
-- rows (SENT/CANCELLED) must not occupy the index at all, which is also what keeps it
-- small on a table that accumulates history forever.
-- ============================================================================
CREATE INDEX "Letter_scheduled_due_idx" ON "Letter" ("scheduledAt") WHERE "status" = 'SCHEDULED';

-- LetterNumberCounter
ALTER TABLE "LetterNumberCounter" ADD CONSTRAINT "LetterNumberCounter_year_range" CHECK ("year" BETWEEN 1300 AND 1500);
ALTER TABLE "LetterNumberCounter" ADD CONSTRAINT "LetterNumberCounter_counter_positive" CHECK ("counter" >= 0);

-- LetterRecipient
ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_state_delivered" CHECK (
  ("state" = 'DELIVERED') OR ("deliveredAt" IS NOT NULL)
);

-- LetterReferral
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_users_differ" CHECK ("fromUserId" <> "toUserId");
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_instruction_len" CHECK ("instruction" IS NULL OR char_length("instruction") BETWEEN 1 AND 2000);
-- Forward-only referral status as a database fact.
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_status_timestamps" CHECK (
  ("status" = 'PENDING' AND "actedAt" IS NULL AND "completedAt" IS NULL)
  OR ("status" = 'VIEWED' AND "viewedAt" IS NOT NULL AND "actedAt" IS NULL AND "completedAt" IS NULL)
  OR ("status" = 'ACTED' AND "actedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "completedAt" >= "actedAt")
);

-- The fixed hard ceiling, matching MessagingAttachment/MediaService (10 MB).
ALTER TABLE "LetterAttachment" ADD CONSTRAINT "LetterAttachment_size_ceiling" CHECK ("size" BETWEEN 1 AND 10485760);
ALTER TABLE "LetterAttachment" ADD CONSTRAINT "LetterAttachment_fileName_len" CHECK (char_length("fileName") BETWEEN 1 AND 200);

-- ArchiveFolder
ALTER TABLE "ArchiveFolder" ADD CONSTRAINT "ArchiveFolder_name_len" CHECK (char_length("name") BETWEEN 1 AND 100);

