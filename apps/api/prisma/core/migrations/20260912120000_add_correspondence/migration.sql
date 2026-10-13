-- Phase 50: Official Correspondence / مکاتبات اداری.
--
-- Adds ONLY the correspondence tables and enums, in the style of
-- 20260830120000_add_surveys_participation. No change to User columns (only new
-- inbound foreign keys), Tenant, RBAC tables (the three new correspondence
-- permissions live in 20260912120500_seed_correspondence_permission_grants),
-- AuditLog/AuditDispatch, Notification, Conversation/Message (49F), Ticket* (49G),
-- Survey* (49H) or Reminder (49I). Core schema only: nothing here touches
-- `aria_erp` or `cms_db`.

-- CreateEnum
-- Canonical lifecycle. A sent letter never becomes "read" for everyone — that state
-- is per-recipient (LetterRecipient.state) — which is why there is deliberately no
-- RECEIVED/VIEWED member here.
CREATE TYPE "LetterStatus" AS ENUM ('DRAFT', 'READY_TO_SEND', 'SENT', 'CANCELLED');

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
-- The canonical letter. letterNumber is NULL on drafts and minted at send.
CREATE TABLE "Letter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "letterNumber" TEXT,
    "subject" TEXT NOT NULL,
    -- SERVER-SANITIZED rich text; the service never stores raw client HTML.
    "bodyHtml" TEXT NOT NULL,
    "category" TEXT,
    "urgency" "LetterUrgency" NOT NULL DEFAULT 'NORMAL',
    "classification" "LetterClassification" NOT NULL DEFAULT 'NORMAL',
    "status" "LetterStatus" NOT NULL DEFAULT 'DRAFT',
    -- تاریخ نامه, canonical instant at 00:00 Asia/Tehran converted server-side.
    "letterDate" TIMESTAMP(3),
    "senderId" TEXT NOT NULL,
    -- "حذف از لیست" for the sender's own outgoing view. Never deletes the letter.
    "senderRemovedAt" TIMESTAMP(3),
    -- Idempotency key for the SEND operation (UNIQUE).
    "sendKey" TEXT,
    "readyAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Per-(tenant, Jalali-year) numbering counter, allocated atomically at send.
CREATE TABLE "LetterNumberCounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LetterNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- One addressed recipient of one letter; UNIQUE per (letter, user).
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
    -- Remove from MY inbox. Never deletes the letter.
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Referral / ارجاع. Immutable history; transitions only.
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
    -- حذف از کارتابل پس از ارجاع: the referrer's own recipient row is removed in
    -- the same transaction as the referral insert.
    "removeFromInbox" BOOLEAN NOT NULL DEFAULT false,
    -- Idempotency/replay guard (UNIQUE).
    "clientKey" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "viewedAt" TIMESTAMP(3),
    "actedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LetterReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Append-only operational trace.
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
-- Letter attachment metadata; bytes live in MinIO via IStorageProvider.
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
-- Personal archive folder (پوشه بایگانی), self-referencing tree.
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
-- One user's personal archive entry for one letter; UNIQUE per (letter, user).
CREATE TABLE "LetterArchive" (
    "id" TEXT NOT NULL,
    "letterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folderId" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- An unarchive is a visible state, not a forgotten history.
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "LetterArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the tenant-scoped sent list (newest first) and "my drafts".
CREATE INDEX "Letter_tenantId_senderId_createdAt_idx" ON "Letter"("tenantId", "senderId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Serves the status facet on tenant-scoped lists.
CREATE INDEX "Letter_tenantId_status_createdAt_idx" ON "Letter"("tenantId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Letter_tenantId_letterNumber_idx" ON "Letter"("tenantId", "letterNumber");

-- CreateIndex
CREATE INDEX "Letter_senderId_idx" ON "Letter"("senderId");

-- CreateIndex
-- Serves the inbox: my rows, newest delivery first.
CREATE INDEX "LetterRecipient_userId_deliveredAt_idx" ON "LetterRecipient"("userId", "deliveredAt" DESC, "id" DESC);

-- CreateIndex
-- Serves per-letter recipient projection and BCC privacy filtering.
CREATE INDEX "LetterRecipient_letterId_kind_idx" ON "LetterRecipient"("letterId", "kind");

-- CreateIndex
-- Serves the referral history read (all referrals of one letter, oldest first).
CREATE INDEX "LetterReferral_letterId_createdAt_idx" ON "LetterReferral"("letterId", "createdAt", "id");

-- CreateIndex
-- Serves the target's cartable.
CREATE INDEX "LetterReferral_toUserId_status_idx" ON "LetterReferral"("toUserId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "LetterReferral_fromUserId_createdAt_idx" ON "LetterReferral"("fromUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Serves the tracking timeline (one letter's events, chronological).
CREATE INDEX "LetterTrackingEvent_letterId_createdAt_idx" ON "LetterTrackingEvent"("letterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LetterAttachment_letterId_createdAt_idx" ON "LetterAttachment"("letterId", "createdAt");

-- CreateIndex
-- Serves the folder tree read.
CREATE INDEX "ArchiveFolder_ownerId_parentId_idx" ON "ArchiveFolder"("ownerId", "parentId");

-- CreateIndex
-- Serves the archive page: my entries, per folder, not unarchived.
CREATE INDEX "LetterArchive_userId_folderId_idx" ON "LetterArchive"("userId", "folderId", "archivedAt" DESC, "id" DESC);

-- CreateUniqueIndex
-- A letter number is minted at most once per (tenant, year) sequence; the pair is
-- the business key. NULL (draft) rows are naturally outside this key.
CREATE UNIQUE INDEX "Letter_tenantId_letterNumber_key" ON "Letter"("tenantId", "letterNumber");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "LetterNumberCounter_tenantId_year_key" ON "LetterNumberCounter"("tenantId", "year");

-- CreateUniqueIndex
-- A user appears ONCE per letter with ONE kind; "TO and also CC" collapses to TO.
CREATE UNIQUE INDEX "LetterRecipient_letterId_userId_key" ON "LetterRecipient"("letterId", "userId");

-- CreateUniqueIndex
-- Replayed/refetched referral creates cannot mint a second identical row.
CREATE UNIQUE INDEX "LetterReferral_clientKey_key" ON "LetterReferral"("clientKey");

-- CreateUniqueIndex
-- A retried send with the same idempotency key cannot mint a second SENT row.
CREATE UNIQUE INDEX "Letter_sendKey_key" ON "Letter"("sendKey");

-- CreateUniqueIndex
-- Re-archiving moves the entry instead of duplicating it.
CREATE UNIQUE INDEX "LetterArchive_letterId_userId_key" ON "LetterArchive"("letterId", "userId");

-- AddForeignKey
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterReferral" ADD CONSTRAINT "LetterReferral_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterTrackingEvent" ADD CONSTRAINT "LetterTrackingEvent_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL: removing a user never deletes the letter's trace.
ALTER TABLE "LetterTrackingEvent" ADD CONSTRAINT "LetterTrackingEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterAttachment" ADD CONSTRAINT "LetterAttachment_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterAttachment" ADD CONSTRAINT "LetterAttachment_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveFolder" ADD CONSTRAINT "ArchiveFolder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE: deleting a parent folder deletes its subfolders (the service only offers
-- deletion for empty folders, so in practice nothing reaches the constraint).
ALTER TABLE "ArchiveFolder" ADD CONSTRAINT "ArchiveFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ArchiveFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterArchive" ADD CONSTRAINT "LetterArchive_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LetterArchive" ADD CONSTRAINT "LetterArchive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL: deleting a folder must not destroy the archived letters' entries.
ALTER TABLE "LetterArchive" ADD CONSTRAINT "LetterArchive_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ArchiveFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints ---------------------------------------------------------

ALTER TABLE "Letter" ADD CONSTRAINT "Letter_subject_len" CHECK (char_length("subject") BETWEEN 1 AND 255);
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_bodyHtml_len" CHECK (char_length("bodyHtml") BETWEEN 1 AND 200000);
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_category_len" CHECK ("category" IS NULL OR char_length("category") BETWEEN 1 AND 100);

-- Forward-only lifecycle as a database fact: timestamps agree with status, a sent
-- letter carries a number, and only DRAFT/READY_TO_SEND rows carry none.
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_status_timestamps" CHECK (
  ("status" = 'DRAFT' AND "readyAt" IS NULL AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NULL)
  OR ("status" = 'READY_TO_SEND' AND "readyAt" IS NOT NULL AND "sentAt" IS NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NULL)
  OR ("status" = 'SENT' AND "sentAt" IS NOT NULL AND "cancelledAt" IS NULL AND "letterNumber" IS NOT NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "sentAt" IS NULL AND "letterNumber" IS NULL)
);

ALTER TABLE "LetterNumberCounter" ADD CONSTRAINT "LetterNumberCounter_year_range" CHECK ("year" BETWEEN 1300 AND 1500);
ALTER TABLE "LetterNumberCounter" ADD CONSTRAINT "LetterNumberCounter_counter_positive" CHECK ("counter" >= 0);

ALTER TABLE "LetterRecipient" ADD CONSTRAINT "LetterRecipient_state_delivered" CHECK (
  ("state" = 'DELIVERED') OR ("deliveredAt" IS NOT NULL)
);

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

ALTER TABLE "ArchiveFolder" ADD CONSTRAINT "ArchiveFolder_name_len" CHECK (char_length("name") BETWEEN 1 AND 100);