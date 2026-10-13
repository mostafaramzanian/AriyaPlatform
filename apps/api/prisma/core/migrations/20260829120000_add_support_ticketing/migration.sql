-- Phase 49G: Core Support / Ticketing.
--
-- Adds ONLY the five ticketing tables and three enums. No change to User
-- columns (only new inbound foreign keys), Tenant, Role/Permission/UserRole
-- (RBAC — 49G introduces NO new permission), AuditLog/AuditDispatch,
-- Notification, Conversation/Message (49F), or any CMS object. Core schema
-- only: nothing here touches `aria_erp` or `cms_db`.

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('BUG', 'SUPPORT', 'SUGGESTION', 'CRITICISM', 'COMPLAINT', 'FEATURE_REQUEST');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
-- Forward-only lifecycle. CLOSED is terminal: there is no reopen transition, so
-- no column models a reopen count or a previous-status pointer.
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_REQUESTER', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    -- Server-generated, non-sequential. UNIQUE, so a concurrent double create
    -- cannot mint the same number twice.
    "trackingNumber" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "type" "TicketType" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- Agent-only free-text label. Not an enum: no code branches on it.
    "category" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketComment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- Agent-only note. Requester reads filter these out server-side.
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    -- Nullable: an attachment is uploaded and stored BEFORE the comment exists,
    -- then bound when the comment commits. Unlike messaging, the ticket already
    -- exists, so an unbound row is still a legitimate ticket-level attachment.
    "commentId" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Append-only: no update or delete path exists for these rows.
CREATE TABLE "TicketStatusHistory" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    -- Null only for the synthetic first row recording creation at NEW.
    "fromStatus" "TicketStatus",
    "toStatus" "TicketStatus" NOT NULL,
    "changedById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSatisfaction" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSatisfaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_trackingNumber_key" ON "Ticket"("trackingNumber");

-- CreateIndex
-- Serves the agent queue: tenant-scoped, newest first.
CREATE INDEX "Ticket_tenantId_createdAt_id_idx" ON "Ticket"("tenantId", "createdAt" DESC, "id" DESC);

-- CreateIndex
-- Serves "my tickets" for a requester, and an agent's own workload.
CREATE INDEX "Ticket_requesterId_createdAt_id_idx" ON "Ticket"("requesterId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_createdAt_id_idx" ON "Ticket"("assigneeId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_tenantId_status_idx" ON "Ticket"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Ticket_tenantId_type_idx" ON "Ticket"("tenantId", "type");

-- CreateIndex
-- Serves the comment page: WHERE ticketId ORDER BY createdAt DESC, id DESC.
CREATE INDEX "TicketComment_ticketId_createdAt_id_idx" ON "TicketComment"("ticketId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "TicketComment_authorId_idx" ON "TicketComment"("authorId");

-- CreateIndex
CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");

-- CreateIndex
CREATE INDEX "TicketAttachment_commentId_idx" ON "TicketAttachment"("commentId");

-- CreateIndex
-- Serves the claim check: "this pending attachment, mine, on this ticket".
CREATE INDEX "TicketAttachment_uploadedBy_ticketId_idx" ON "TicketAttachment"("uploadedBy", "ticketId");

-- CreateIndex
CREATE INDEX "TicketStatusHistory_ticketId_createdAt_id_idx" ON "TicketStatusHistory"("ticketId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "TicketStatusHistory_changedById_idx" ON "TicketStatusHistory"("changedById");

-- CreateIndex
-- At most one satisfaction record per ticket.
CREATE UNIQUE INDEX "TicketSatisfaction_ticketId_key" ON "TicketSatisfaction"("ticketId");

-- CreateIndex
CREATE INDEX "TicketSatisfaction_submittedById_idx" ON "TicketSatisfaction"("submittedById");

-- AddForeignKey
-- CASCADE from the requester (a ticket is meaningless without the person who
-- filed it) but SET NULL from the assignee: deleting an agent must never delete
-- the tickets they happened to be working on.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: a file survives the loss of the comment it was quoted
-- in and remains a ticket-level attachment.
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TicketComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketStatusHistory" ADD CONSTRAINT "TicketStatusHistory_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketStatusHistory" ADD CONSTRAINT "TicketStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketSatisfaction" ADD CONSTRAINT "TicketSatisfaction_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketSatisfaction" ADD CONSTRAINT "TicketSatisfaction_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounded content, enforced in the database as well as in the DTO/service
-- layer, so no oversized or blank payload can be persisted by any code path.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subject_len" CHECK (char_length("subject") BETWEEN 1 AND 160);
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_body_len" CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_category_len" CHECK ("category" IS NULL OR char_length("category") BETWEEN 1 AND 80);

-- Shape of the tracking number, so no path can introduce a value the lookup
-- route would never match.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_trackingNumber_shape" CHECK ("trackingNumber" ~ '^TK-[0-9A-Z]{10}$');

-- Self-assignment is meaningless for a support workflow.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignee_not_requester" CHECK ("assigneeId" IS NULL OR "assigneeId" <> "requesterId");

-- Terminal timestamps exist only in the states that produce them. Prisma cannot
-- express either invariant, so both live here.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolved_requires_status" CHECK (
  ("resolvedAt" IS NULL AND "status" NOT IN ('RESOLVED', 'CLOSED'))
  OR ("resolvedAt" IS NOT NULL AND "status" IN ('RESOLVED', 'CLOSED'))
);
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_closed_requires_status" CHECK (
  ("closedAt" IS NULL AND "status" <> 'CLOSED')
  OR ("closedAt" IS NOT NULL AND "status" = 'CLOSED')
);

ALTER TABLE "TicketComment" ADD CONSTRAINT "TicketComment_body_len" CHECK (char_length("body") BETWEEN 1 AND 4000);

ALTER TABLE "TicketStatusHistory" ADD CONSTRAINT "TicketStatusHistory_note_len" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
-- A history row must record an actual change.
ALTER TABLE "TicketStatusHistory" ADD CONSTRAINT "TicketStatusHistory_is_a_change" CHECK ("fromStatus" IS NULL OR "fromStatus" <> "toStatus");

ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_size_bounds" CHECK ("size" > 0 AND "size" <= 10485760);

ALTER TABLE "TicketSatisfaction" ADD CONSTRAINT "TicketSatisfaction_rating_bounds" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "TicketSatisfaction" ADD CONSTRAINT "TicketSatisfaction_comment_len" CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 1000);


