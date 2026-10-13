-- Phase 49E: persistent in-app Notification Center.
--
-- Adds ONLY the Notification table and its enum. No change to User, Tenant,
-- Role/Permission/UserRole (RBAC), AuditLog/AuditDispatch, or any CMS object.
-- No email/SMS/push/campaign/template/workflow/scheduler table is created.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SYSTEM', 'SECURITY', 'ANNOUNCEMENT', 'INFORMATION');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "type" "NotificationType" NOT NULL DEFAULT 'INFORMATION',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the list query: WHERE "userId" = $1 ORDER BY "createdAt" DESC, "id" DESC.
CREATE INDEX "Notification_userId_createdAt_id_idx" ON "Notification"("userId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Serves the unread count: WHERE "userId" = $1 AND "readAt" IS NULL.
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- AddForeignKey
-- ON DELETE CASCADE: a deleted user's notifications are removed with them; they
-- are meaningless without a recipient and must never outlive the account.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounded content lengths, enforced in the database as well as in the DTO/service
-- layer, so no oversized payload can ever be persisted by any code path.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_title_len" CHECK (char_length("title") BETWEEN 1 AND 160);
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_body_len" CHECK (char_length("body") BETWEEN 1 AND 1000);
