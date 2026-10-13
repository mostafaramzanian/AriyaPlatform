-- Phase 49F: Internal Messaging.
--
-- Adds ONLY the four messaging tables and one enum. No change to User columns
-- (only new inbound foreign keys), Tenant, Role/Permission/UserRole (RBAC),
-- AuditLog/AuditDispatch, Notification, or any CMS object. No queue/transport
-- state table is created.

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
    "tenantId" TEXT,
    "name" TEXT,
    "createdBy" TEXT NOT NULL,
    "directKey" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMember" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    -- Nullable: an attachment is uploaded and stored BEFORE the message exists,
    -- then bound when the send commits. An unbound row is inert (no read reaches
    -- it, because every read starts from a message).
    "messageId" TEXT,
    "conversationId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Deterministic 1:1 dedupe: two users can never own two parallel direct
-- conversations, even under a concurrent double create (the second insert
-- violates this constraint and is resolved by re-reading the existing row).
CREATE UNIQUE INDEX "Conversation_directKey_key" ON "Conversation"("directKey");

-- CreateIndex
-- Serves the conversation rail: tenant-scoped, newest activity first.
CREATE INDEX "Conversation_tenantId_lastMessageAt_id_idx" ON "Conversation"("tenantId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Conversation_createdBy_idx" ON "Conversation"("createdBy");

-- CreateIndex
-- One membership row per user per conversation.
CREATE UNIQUE INDEX "ConversationMember_conversationId_userId_key" ON "ConversationMember"("conversationId", "userId");

-- CreateIndex
-- Leads with userId: "list my conversations" and "am I a member" are the hot queries.
CREATE INDEX "ConversationMember_userId_conversationId_idx" ON "ConversationMember"("userId", "conversationId");

-- CreateIndex
-- Send idempotency: a retried send with the same clientMessageId cannot insert twice.
CREATE UNIQUE INDEX "Message_conversationId_senderId_clientMessageId_key" ON "Message"("conversationId", "senderId", "clientMessageId");

-- CreateIndex
-- Serves the message page: WHERE conversationId ORDER BY createdAt DESC, id DESC.
CREATE INDEX "Message_conversationId_createdAt_id_idx" ON "Message"("conversationId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
-- Serves the claim check: "this pending attachment, mine, in this conversation".
CREATE INDEX "MessageAttachment_uploadedBy_conversationId_idx" ON "MessageAttachment"("uploadedBy", "conversationId");

-- CreateIndex
CREATE INDEX "MessageAttachment_conversationId_idx" ON "MessageAttachment"("conversationId");

-- AddForeignKey
-- ON DELETE CASCADE throughout: a conversation is meaningless without its
-- creator, a membership without its user, a message without its sender, and an
-- attachment without its message.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounded content, enforced in the database as well as in the DTO/service layer,
-- so no oversized or blank payload can be persisted by any code path.
ALTER TABLE "Message" ADD CONSTRAINT "Message_body_len" CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_name_len" CHECK ("name" IS NULL OR char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_size_bounds" CHECK ("size" > 0 AND "size" <= 10485760);

-- A DIRECT conversation is never named and must carry a dedupe key; a GROUP is
-- named and must not. Prisma cannot express this, so it lives here.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_shape" CHECK (
  ("type" = 'DIRECT' AND "name" IS NULL AND "directKey" IS NOT NULL)
  OR ("type" = 'GROUP' AND "directKey" IS NULL)
);
