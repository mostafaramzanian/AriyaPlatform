-- Add scheduled send support to correspondence letters

-- Extend the status enum with a future-dated state.
ALTER TYPE "LetterStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';

-- Optional: column that stores the desired future send time.
ALTER TABLE "Letter" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMPTZ;
