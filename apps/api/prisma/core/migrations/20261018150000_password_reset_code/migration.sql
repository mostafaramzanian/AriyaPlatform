-- PHASE PASSWORD-RESET-CODE
--
-- The password-reset credential becomes a SIX-DIGIT CODE delivered by email instead of a
-- link token, so the stored column is renamed to say what it holds, and an attempt counter
-- is added to bound online guessing of a six-digit secret.
--
-- "token" was never a link here in the first place: it already held a SHA-256 digest (see
-- `TokenHashService`), so no plaintext value exists to migrate. The RENAME keeps the
-- existing unique index semantics — the digest is salted with the user id, so two accounts
-- holding the same code cannot collide.
ALTER TABLE "PasswordReset" RENAME COLUMN "token" TO "codeHash";

-- Wrong-code guesses against one row. The reset path increments it and burns the row
-- (`used = true`) at the cap, so a code can be guessed online only a handful of times.
ALTER TABLE "PasswordReset" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;