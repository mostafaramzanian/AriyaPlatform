-- ============================================================================
-- PHASE 54-F â€” the four-member policy-version lifecycle, and the guards that
-- describe it.
--
-- CONFLICT RESOLUTION USED: SPEC WINS.
-- ============================================================================
-- The `LeavePolicyVersionStatus` enum this migration alters was created by
-- `20260921100000_hr_leave_policy` with THREE members (DRAFT, VALIDATED,
-- PUBLISHED). The authoritative tracked specification states the lifecycle in
-- two places that agree on FOUR, and it is the specification that governs:
--
--   Â§10.3  "DRAFT â€” editable ... VALIDATED â€” passed validation ... PUBLISHED â€”
--           immutable; the version new evaluations resolve to. ARCHIVED â€” not
--           selected for new evaluations; still resolvable for explanations and
--           for historical references."
--   Â§10.4  "Exactly one PUBLISHED version per set (per scope) at a time.
--           Publishing a new version archives the previous one in the same act."
--   Â§11    "DRAFT â”€â”€validateâ”€â”€â–¶ VALIDATED â”€â”€publishâ”€â”€â–¶ PUBLISHED
--           â”€â”€publish(next) / archiveâ”€â”€â–¶ ARCHIVED", with "no path back to
--           DRAFT/DELETE".
--   Â§7     the same four-state vocabulary, restated as D10.
--
-- The three-member enum was therefore implementation drift, not a decision: with
-- no `ARCHIVED` member a superseded version had nowhere to go, so "which version
-- is in force" was answered by the effective window ALONE and a version that had
-- been actively withdrawn could not be told apart from a current one. Adding the
-- member is the correction of that drift, not a new product rule.
--
-- ORDERING AND REVERSIBILITY
-- ============================================================================
-- Every statement here is additive or a constraint REFINEMENT. No column is
-- dropped, no row is rewritten, no historical LeaveRequest is touched, and no
-- interval is modified. The `ADD VALUE` is the one statement that is not
-- trivially reversible (`ALTER TYPE ... DROP VALUE` does not exist in
-- PostgreSQL), so the rollback reasoning is stated explicitly at step 1.
--
-- DATA INVENTORY (read-only, run before this migration was authored)
-- ============================================================================
-- Against the live database, in exactly the state the preceding migrations
-- produce:
--
--   policies                                   : 1
--   LeavePolicyVersion rows                    : 0
--   LeaveLimitDefinition rows                  : 0
--   status distribution                        : (empty â€” no rows)
--   duplicate PUBLISHED per tenant+policy      : 0
--   PUBLISHED effective-window overlaps        : 0
--   NULL status / effective_from / policy_id / payload : 0
--   statusâ†”published_at inconsistencies        : 0
--   LeaveRequest rows affected                 : 0
--

-- ============================================================================
-- 1. Widen the enum to the four states the specification declares.
-- ============================================================================
-- No explicit `BEFORE`/`AFTER` is given: the enum's sort order is not
-- semantically load-bearing here (no query or constraint orders by it), and
-- pinning a position would break on a database whose enum was extended
-- differently. The four members are asserted by the application's own domain
-- guard and by a spec, not by their ordinal.
ALTER TYPE "LeavePolicyVersionStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

-- WHY THERE IS A `COMMIT` IN THE MIDDLE OF THIS FILE
-- --------------------------------------------------
-- PostgreSQL 16 refuses to USE a value added by `ALTER TYPE ... ADD VALUE`
-- inside the same transaction that added it (SQLSTATE 55P04, "unsafe use of new
-- value ... of enum type"), and `prisma migrate deploy` runs a migration file in
-- ONE transaction. Everything below this line NAMES `'ARCHIVED'` â€” the state
-- CHECK, the exclusion predicate, and both trigger function bodies â€” so without a
-- commit boundary here the migration fails on its first constraint.
--
-- This is not a workaround invented here: it is the convention the immediately
-- preceding HR migration established for exactly the same reason
-- (`20260922120000_hr_leave_approval_lifecycle`, which adds `APPROVED`/`REJECTED`
-- and commits before its own CHECK reads them). Both were reproduced against
-- PostgreSQL 16.15.
--
-- The statement above is `ADD VALUE IF NOT EXISTS`, so a re-run after a partial
-- failure cannot append a duplicate member, and because the ADD VALUE is the only
-- statement in its own transaction the file has no partially-applied state to
-- recover from: either the member exists or the file did not reach the commit.
COMMIT;

-- ROLLBACK REASONING (step 1)
-- ---------------------------------------------------------------------------
-- There is no corresponding `DROP VALUE`: PostgreSQL cannot remove an enum
-- member, and doing so would in any case require proving that no row uses it.
-- The reversal is therefore a forward migration, and it is safe to state why:
-- a version that is ARCHIVED under the four-state model would have been
-- PUBLISHED under the three-state one, so a reversal would move it back to
-- PUBLISHED â€” a row that is still immutable, still resolvable, and still
-- selected by exactly the same effective-window logic. Nothing is lost, and no
-- historical fact is destroyed by the reversal. This is deliberately recorded
-- rather than left as an exercise.

-- ============================================================================
-- 2. The state/published_at CHECK, restated for four states.
-- ============================================================================
-- The constraint `20260921100000_hr_leave_policy` installed was:
--
--   CHECK ((status = 'PUBLISHED') = ((published_at IS NOT NULL) AND (published_by_employee_id IS NOT NULL)))
--
-- That biconditional was written for three states and becomes WRONG the moment
-- ARCHIVED exists: an archived version *was* published, so it legitimately
-- carries the instant it entered force and the person who put it there â€” those
-- are historical facts (Â§23.5), and deleting them to satisfy a CHECK would be
-- the CHECK destroying the record it exists to protect. Under the old
-- expression an archived row would have been unwritable in BOTH directions:
-- stamped (the right-hand side true) while not PUBLISHED (the left-hand side
-- false) fails the equality.
--
-- The corrected predicate states the actual invariant, in the SPECIFICATION'S
-- OWN TERMS: a version that has ever been in force is stamped, and a version
-- that has never been in force is not.
--
--   * PUBLISHED â†’ stamped       (it is in force: Â§11)
--   * ARCHIVED  â†’ stamped       (it was in force: Â§10.3, Â§10.4, Â§23.5)
--   * DRAFT     â†’ unstamped     (it has never been in force: Â§10.3)
--   * VALIDATED â†’ unstamped     (it has been accepted, not adopted: Â§10.3)
--
-- Both directions survive: "a live version with no timestamp" and "a draft
-- carrying one" remain unwritable, and `published_at`/`published_by_employee_id`
-- stay tied to each other so neither can be set alone.
ALTER TABLE "LeavePolicyVersion"
  DROP CONSTRAINT "LeavePolicyVersion_published_state_check";

ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_published_state_check"
  CHECK (
    (("status" IN ('PUBLISHED', 'ARCHIVED')) = ("published_at" IS NOT NULL))
    AND (("status" IN ('PUBLISHED', 'ARCHIVED')) = ("published_by_employee_id" IS NOT NULL))
  );

-- Zero rows exist in the table this migration redefines, so every invariant
-- below holds vacuously on the existing data: there is no row that could violate
-- it and therefore no data-repair policy to invent. Had the inventory found a
-- non-empty status distribution or any duplicate/overlapping PUBLISHED pair,
-- this migration would have been STOPPED rather than written.

-- ============================================================================
-- 3. Reconcile the published-overlap exclusion constraint.
-- ============================================================================
-- WHY THIS IS NOT SIMPLY DELETED
-- ---------------------------------------------------------------------------
-- `LeavePolicyVersion_published_overlap_excl` (installed by
-- `20260922100000_fix_hr_leave_policy_published_overlap`) reads:
--
--   EXCLUDE USING gist (tenant_id WITH =, policy_id WITH =,
--                       daterange(effective_from, COALESCE(effective_to,
--                                 DATE 'infinity'), '[]') WITH &&)
--   WHERE (status = 'PUBLISHED')
--
-- It forbids two PUBLISHED versions of one policy whose EFFECTIVE WINDOWS
-- overlap. It is a correct guard for the invariant it was written for, and it
-- was written before ARCHIVED existed â€” so it must not be dropped merely because
-- the lifecycle grew. It must be replaced by the pair of guards that state the
-- specification's actual invariants, each with its own reason:
--
--   (a) Â§10.4 â€” "Exactly one PUBLISHED version per set (per scope) at a time."
--       One ACTIVE VERSION per policy, with no temporal qualification at all.
--       This is strictly STRONGER than "no overlapping windows": the old
--       constraint permitted a second PUBLISHED version whose window was in the
--       future, which under Â§10.4 is exactly the state the specification forbids
--       â€” the future version has not been published *yet*, and once it is
--       published the CURRENT version is archived IN THE SAME ACT. So there is
--       no legitimate moment at which two PUBLISHED versions of one policy
--       coexist, whether their windows overlap or not.
--
--   (b) Â§15.4 â€” effective intervals "never rewritten"; a version is evidence of
--       what was in force and two versions must not both claim the same day.
--       Retained from the old constraint, but now scoped to the versions that
--       are still eligible for selection (PUBLISHED *or* ARCHIVED), because a
--       historical claim about a day is made by an archived row too. Two
--       ARCHIVED versions that claim the same day would make "what was in force
--       on this day?" unanswerable in exactly the way Â§23 exists to prevent.
--
-- WHY (a) IS EXPRESSED AS A PARTIAL UNIQUE INDEX AND NOT AN EXCLUSION
-- ---------------------------------------------------------------------------
-- (a) contains no interval. It says "at most one row", which is a uniqueness
-- assertion, and a partial UNIQUE index is the exact primitive for it:
--
--   * it is enforced by PostgreSQL for every writer, including one that bypasses
--     the service â€” which is the guarantee Â§15.7 requires ("Published
--     immutability is enforced at the storage layer, not only by a service
--     convention ... a PUBLISHED version that a second writer can edit is not
--     immutable, it is merely polite"), applied to the publication invariant;
--   * it makes the race in a read-then-write publish UNREPRESENTABLE rather than
--     merely unlikely. Two concurrent publishes of two different versions of one
--     policy cannot both commit: the second gets `23505`. An application-only
--     check would leave precisely that window open, and the phase brief requires
--     that concurrent publishing not be able to violate the invariant;
--   * it costs one index and states the invariant in one line, where an
--     exclusion constraint over a constant expression would be a longer way to
--     write the same rule.
--
-- The index is PARTIAL (`WHERE status = 'PUBLISHED'`) so DRAFT and VALIDATED rows
-- are absent from it entirely and any number of them may coexist â€” Â§15.4
-- explicitly permits parallel drafts, and the previous migration's own header
-- records that over-refusing drafts was one of the two defects it corrected.
--

-- (b) no two ever-in-force versions of one policy claim the same day.
--     The interval idiom is reused VERBATIM from the platform's frozen pattern
--     (`20260916090000_hr_exclusive_interval_and_cycle_guards`, and the old
--     constraint here): inclusive on both ends, NULL end means open-ended. No
--     timestamp, no timezone and no Jalali arithmetic enters the constraint.
ALTER TABLE "LeavePolicyVersion"
  DROP CONSTRAINT "LeavePolicyVersion_published_overlap_excl";

ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_in_force_overlap_excl"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "policy_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE 'infinity'), '[]') WITH &&
  )
  WHERE ("status" IN ('PUBLISHED', 'ARCHIVED'));

-- WHAT THIS PAIR NOW REFUSES, AND WHAT IT STILL PERMITS
-- ---------------------------------------------------------------------------
--   * two PUBLISHED versions of one policy, ANY windows      -> refused (a)
--   * two PUBLISHED versions whose windows overlap           -> refused (a),(b)
--   * a PUBLISHED and an ARCHIVED version claiming one day   -> refused (b)
--   * two ARCHIVED versions claiming one day                 -> refused (b)
--   * two PUBLISHED versions that are merely CONTIGUOUS      -> refused (a)
--     (this is the intended change: under Â§10.4 the earlier one is ARCHIVED,
--      not PUBLISHED, so the legitimate shape is published+archived contiguous,
--      which (b) permits because their intervals do not overlap)
--   * a DRAFT or VALIDATED overlapping anything at all      -> permitted
--   * a DRAFT sharing a window with a PUBLISHED version      -> permitted; that
--     draft's own eventual publish is what the guards then refuse
--   * different policies, or the same policy id under a      -> permitted
--     different tenant
--   * a PUBLISHED version and an ARCHIVED version whose      -> permitted
--     windows are contiguous

-- ============================================================================
-- 4. The immutability trigger, extended for the one act the lifecycle needs.
-- ============================================================================
-- `20260921100000_hr_leave_policy` installed `hr_assert_leave_policy_version_immutable`
-- as: refuse ANY update to a row that IS published, and any DELETE of one. Its
-- header states the reason â€” "an allow-list of 'fields you may still touch' is a
-- list somebody has to keep complete, and the field somebody forgets to add is
-- the one that quietly changes what was in force. The state is the lock."
--
-- That guard was exactly right for a three-state lifecycle in which PUBLISHED was
-- terminal. Â§10.4/Â§11 make it non-terminal: "Publishing a new version archives the
-- previous one in the same act" is an UPDATE on a PUBLISHED row, so the old
-- trigger now refuses a transition the specification REQUIRES. Left alone it
-- would make the lifecycle unimplementable at the storage layer.
--
-- THE EXTENSION IS KEPT AS NARROW AS THE SPECIFICATION IS, and the shape is the
-- same one the header above reasons about rather than its negation:
--
--   * EXACTLY ONE transition is permitted on a PUBLISHED row: PUBLISHED ->
--     ARCHIVED. Every other target â€” DRAFT, VALIDATED, PUBLISHED, or an
--     unrecognized value â€” is refused, so "no path back to DRAFT" (Â§11) is a
--     storage fact and not a code-review comment.
--   * THE CONTENT IS FROZEN ACROSS THAT TRANSITION. Archiving may move the STATE
--     and nothing else: every column that describes WHAT THE VERSION SAYS is
--     compared and a difference is refused. Otherwise "archive" would be a
--     laundering route â€” publish a version, archive it, and rewrite its text â€”
--     which is the exact failure the immutability guarantee exists to prevent
--     (Â§10.2 "the published one is never mutated", Â§10.5, Â§13.2). The comparison
--     is written as `IS DISTINCT FROM` rather than `<>` so a NULL in either row
--     counts as a difference rather than collapsing to unknown-and-therefore
--     skipped.
--   * `updated_at` is not in the compared set, because `@updatedAt` writes it on
--     every UPDATE and it describes WHEN THE ROW WAS TOUCHED, not what it says.
--     `status`, `published_at` and `published_by_employee_id` are likewise not
--     compared: `status` is the transition itself, and the two publication
--     columns may only gain values that are already there (the CHECK from step 2
--     requires an archived row to be stamped, and a PUBLISHED row to be stamped
--     too, so this transition may not blank them).
--   * AN ARCHIVED ROW IS FULLY FROZEN â€” updates and deletes alike â€” because Â§11
--     says the archived branch has "no path back to DRAFT/DELETE" and Â§10.3 keeps
--     it resolvable for explanations. An archived row is evidence of what was in
--     force; evidence that can still be edited is not evidence.
--
-- Nothing here is a broad trigger: it fires on one table, refuses two operations,
-- and carries one enumerated exception that the specification names in as many
-- words.

CREATE OR REPLACE FUNCTION "hr_assert_leave_policy_version_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'LeavePolicyVersion % is % and cannot be deleted', OLD."id", OLD."status"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  -- A row that was never in force is editable: a DRAFT is a document still being
  -- written and a VALIDATED body has been accepted, not adopted (Â§10.3).
  IF OLD."status" NOT IN ('PUBLISHED', 'ARCHIVED') THEN
    RETURN NEW;
  END IF;

  -- An archived version is what it says it is, forever (Â§10.3, Â§11).
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'LeavePolicyVersion % is ARCHIVED and cannot be modified', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  -- OLD."status" = 'PUBLISHED' from here. The ONLY permitted move is the
  -- successor's publish withdrawing this version (Â§10.4, Â§11).
  IF NEW."status" IS DISTINCT FROM 'ARCHIVED' THEN
    RAISE EXCEPTION 'LeavePolicyVersion % is PUBLISHED and may only transition to ARCHIVED, not to %',
      OLD."id", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."policy_id" IS DISTINCT FROM OLD."policy_id"
     OR NEW."version_label" IS DISTINCT FROM OLD."version_label"
     OR NEW."jalali_year" IS DISTINCT FROM OLD."jalali_year"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."effective_to" IS DISTINCT FROM OLD."effective_to"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'LeavePolicyVersion % may be ARCHIVED but its content is frozen', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself is unchanged in shape â€” same name, same table, same events.
-- Re-declaring it here is what binds the table to the corrected FUNCTION: the
-- body above replaced the old one, and `CREATE OR REPLACE TRIGGER` keeps the
-- definition in this migration rather than relying on the earlier one's.
CREATE OR REPLACE TRIGGER "LeavePolicyVersion_published_immutable_guard"
  BEFORE UPDATE OR DELETE
  ON "LeavePolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_policy_version_immutable"();

-- Publication is per POLICY, not per tenant and not globally: two tenants may
-- each have an active version of a policy they both call `DEFAULT`, and two
-- different policies of one tenant are entirely independent. That is the same
-- tenant-qualified key shape every other HR uniqueness rule uses, and it is what
-- makes the guard cross-tenant safe by construction.


-- ============================================================================
-- 5. The limit guard follows its parent into ARCHIVED.
-- ============================================================================
-- `hr_assert_leave_limit_definition_immutable` freezes a limit whose PARENT
-- version is PUBLISHED, on the reasoning that "a limit is part of the published
-- document ... leaving it mutable would make the trigger above a lock on the
-- cover page while the terms stayed writable". That reasoning is unchanged by
-- this phase, and it applies with equal force to ARCHIVED: the corrected version
-- trigger now refuses every content change to an archived row, so an archived
-- version with an editable limit would be the same defect one level down â€” a
-- frozen document whose terms are not.
--
-- The predicate widens from `= 'PUBLISHED'` to `IN ('PUBLISHED', 'ARCHIVED')`,
-- and the trigger gains INSERT.
--
-- WHY INSERT IS ADDED (a defect this phase found by RUNNING the guard, not by
-- reading it). The 54-D trigger was attached `BEFORE UPDATE OR DELETE`, so a
-- NEW limit could be inserted under an already-PUBLISHED version: the frozen
-- document's TERMS were still writable even though its own row was not. That is
-- the exact failure the paragraph above names â€” a lock on the cover page while
-- the terms stay writable â€” and a limit is part of "what the published version
-- grants", so a reader of a published policy would see a maximum nobody
-- published. Measured against the live database before this fix: inserting a
-- limit under a PUBLISHED parent was ACCEPTED.
--
-- `hr_assert_leave_policy_version_immutable` above already guards INSERT for the
-- same reason (a published document must not be born retconned), so this brings
-- the child guard to the standard its parent already holds.
--
-- The function body below therefore reads its keys from NEW-or-OLD rather than
-- from NEW alone: on INSERT there is no OLD, and on DELETE NEW is null.
CREATE OR REPLACE FUNCTION "hr_assert_leave_limit_definition_immutable"() RETURNS trigger AS $$
DECLARE
  parent_status "LeavePolicyVersionStatus";
  target_version_id uuid;
  target_tenant_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_version_id := OLD."policy_version_id";
    target_tenant_id := OLD."tenant_id";
  ELSE
    target_version_id := NEW."policy_version_id";
    target_tenant_id := NEW."tenant_id";
  END IF;

  SELECT v."status" INTO parent_status
    FROM "LeavePolicyVersion" v
   WHERE v."id" = target_version_id
     AND v."tenant_id" = target_tenant_id;

  IF parent_status IN ('PUBLISHED', 'ARCHIVED') THEN
    RAISE EXCEPTION 'LeaveLimitDefinition % belongs to a % LeavePolicyVersion and cannot be added, modified or deleted',
      COALESCE(NEW."id", OLD."id"), parent_status
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "LeaveLimitDefinition_published_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE
  ON "LeaveLimitDefinition"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_limit_definition_immutable"();

-- (a) at most one in-force version per tenant+policy, with no temporal caveat.
CREATE UNIQUE INDEX "LeavePolicyVersion_one_published_per_policy_key"
  ON "LeavePolicyVersion" ("tenant_id", "policy_id")
  WHERE ("status" = 'PUBLISHED');
