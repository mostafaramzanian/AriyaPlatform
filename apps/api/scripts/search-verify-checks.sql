-- Phase 49J: CHECK constraints on the source tables the search e2e fixture writes to.
-- Read before writing the fixture, so its text satisfies the DB bounds rather than
-- discovering them through a failed insert.
SELECT c.conrelid::regclass AS table, c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'c'
  AND c.conrelid IN (
    '"Ticket"'::regclass,
    '"TicketComment"'::regclass,
    '"Survey"'::regclass,
    '"Conversation"'::regclass,
    '"Message"'::regclass,
    '"Notification"'::regclass,
    '"Reminder"'::regclass
  )
ORDER BY 1, 2;
