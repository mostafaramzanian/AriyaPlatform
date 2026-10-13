-- Phase 49I: Personal Reminders (Calendar).
--
-- Adds ONE table and no enum. No change to User columns (only a new inbound
-- foreign key), Tenant, Role/Permission/UserRole (RBAC), AuditLog/AuditDispatch,
-- Notification (49E), Conversation/Message (49F), Ticket* (49G) or Survey* (49H).
-- Core schema only: nothing here touches `aria_erp` or `cms_db`.
--
-- NOT created, deliberately: "CalendarEvent", "CalendarParticipant", "Holiday".
-- A personal reminder has one owner and no participants; Iranian holiday data has
-- no authoritative source in this repository and the approved contract forbids
-- fabricating one; organization/department events need a membership edge Core does
-- not have. See the schema comment above `model Reminder` for the full reasoning.
--
-- NO new permission row and NO new grant: creating and reading one's own reminder
-- is an ordinary authenticated-user capability, enforced by ownership in
-- ReminderService, exactly as notifications (49E) and conversations (49F) are.
-- Inventing 'calendar.reminders' would imply a revocable-per-role model this phase
-- does not build.

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Snapshot of the owner's tenant, mirroring "Notification"."tenantId".
    -- Nullable because "User"."tenantId" is nullable.
    "tenantId" TEXT,
    "title" TEXT NOT NULL,
    "note" TEXT,
    -- Canonical, timezone-aware instant. The Jalali date and the wall-clock time
    -- the user typed are never stored: they are resolved in Asia/Tehran before the
    -- insert. timestamptz semantics come from Prisma's TIMESTAMP(3) convention,
    -- used by every existing Core table.
    "dueAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    -- Delivery claim and delivery proof in one column. See the partial index and
    -- the schema comment: the dispatcher claims a row with a conditional UPDATE
    -- ... WHERE "deliveredAt" IS NULL, so exactly-once delivery needs no queue,
    -- lock or job table.
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves both owner-facing reads: the selected-day list (userId + half-open dueAt
-- range) and the bounded upcoming list (userId + dueAt >= now ORDER BY dueAt).
CREATE INDEX "Reminder_userId_dueAt_idx" ON "Reminder"("userId", "dueAt");

-- CreateIndex
-- Declared to match the Prisma model. The dispatcher does NOT rely on it; see the
-- partial index below, which is the one its scan actually uses.
CREATE INDEX "Reminder_enabled_deliveredAt_dueAt_idx" ON "Reminder"("enabled", "deliveredAt", "dueAt");

-- CreateIndex
-- The dispatcher's index, and the reason the due scan stays cheap at 1000
-- concurrent users: it contains ONLY rows that can still fire. A delivered or
-- disabled reminder leaves the index entirely, so the index size tracks the
-- pending backlog rather than the table. Prisma cannot express a partial index, so
-- it is declared here and documented in the model.
CREATE INDEX "Reminder_pending_dueAt_idx" ON "Reminder"("dueAt")
  WHERE "enabled" AND "deliveredAt" IS NULL;

-- AddForeignKey
-- Cascade: a reminder is personal, so deleting the owner deletes it. Same rule as
-- "Notification"."userId".
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounds enforced in the database as well as in the DTO, in the style of
-- "Notification_title_len" / "Notification_body_len". A NULL note is allowed; a
-- present-but-blank one is not, so "no note" has exactly one representation.
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_title_len" CHECK (char_length("title") BETWEEN 1 AND 160);
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_note_len" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);

-- An all-day reminder is anchored to the start of its Jalali day in Asia/Tehran,
-- which is 20:30Z or 19:30Z depending on the offset in force. The exact minute is
-- therefore not assertable in SQL without hardcoding an offset — which the contract
-- forbids — so no CHECK is declared for it. The invariant is enforced at the one
-- place that owns the conversion (jalaliWallTimeToInstant, hour/minute = 0) and is
-- covered by unit and E2E tests instead of a constraint that would silently encode
-- +03:30 into the schema.
