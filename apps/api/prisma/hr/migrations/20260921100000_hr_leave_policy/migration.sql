-- Phase 54-D Step 1: the tenant's stated leave POLICY — `hr_db`.
--
-- WHAT THIS MIGRATION CREATES
-- ---------------------------
-- Three tables and three enums:
--
--   LeavePolicy             the stable identity of one tenant's policy: `code`, `name`.
--                           NO dates and NO status — see below.
--   LeavePolicyVersion      one authored body (DRAFT / VALIDATED / PUBLISHED), effective-dated,
--                           carrying the publication decision (`published_at`,
--                           `published_by_employee_id`) and the validated `payload`.
--   LeaveLimitDefinition    a typed limit belonging to ONE version: the leave type it counts, an
--                           optional employment-type scope, a `maximum`, the MANDATORY
--                           `counting_basis`, the period and its RESOLVED `window_start`/
--                           `window_end`, the `consumes_states` set, and its own effective
--                           interval.
--   LeavePolicyVersionStatus  DRAFT | VALIDATED | PUBLISHED.
--   LeaveCountingBasis        REQUEST_COUNT | DAY_COUNT.
--   LeaveLimitPeriodKind      YEAR (the only period in this phase).
--
-- WHY A POLICY IS NOT A COLUMN ON LeaveType, AND WHY THE VERSION CARRIES THE DATES
-- ------------------------------------------------------------------------------
-- A leave type says what a request may ask FOR; a policy says what the organization GRANTS.
-- Folding the second into the first would make every catalogue edit a policy change. And
-- effectiveness belongs to the VERSION, not to the policy: a `status` or an `effective_from` on
-- `LeavePolicy` would be a SECOND answer to "which version is in force", and two answers to that
-- question is how one of them becomes wrong.
--
-- WHY THERE IS NO APPROVAL MACHINERY, NO BALANCE AND NO COUNTER HERE
-- ----------------------------------------------------------------
--   * no `LeaveApprovalInstance` / step / approver table (§18 belongs to the approval phase, and
--     a table with no producer is a table no test can falsify — the reasoning this repository
--     already records for `HrDocumentCounter`);
--   * no balance, entitlement, accrual, carry-over, encashment or `duration_days`: §16 states
--     that a limit is TYPED POLICY DATA THAT IS EVALUATED, never a stored counter. The COUNT a
--     limit meets is derived from stored requests at evaluation time and handed to the engine as
--     a number. Nothing in these tables is incremented;
--   * no `APPROVED` / `REJECTED` member is added to `LeaveRequestStatus`. A limit cannot consume
--     a state the request lifecycle cannot reach, so that member arrives with the enforcer.
--
-- WHY NOTHING IS SEEDED
-- ---------------------
-- This migration inserts NOTHING — no policy, no version, no limit (§15.8). Until a tenant
-- states a policy the honest rendering is "no policy has been stated", not a default policy
-- nobody approved. The same refusal the leave-type catalogue records, for the same reason.
--
-- WHY RAW SQL FOR THREE OF THE GUARANTEES
-- ---------------------------------------
-- Prisma's schema language cannot express an `EXCLUDE USING gist` constraint, a trigger, or a
-- `CHECK` that constrains an ARRAY column. §15.4/§15.5 and §37.6 require all three, so they are
-- written here in raw SQL — the path §10 names explicitly for exactly this, and the path
-- `20260916090000_hr_exclusive_interval_and_cycle_guards` already took for the employment
-- overlap rule and the organisation cycle guard.

-- ===========================================================================
-- 1. The three enums.
-- ===========================================================================
CREATE TYPE "LeavePolicyVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED');
CREATE TYPE "LeaveCountingBasis" AS ENUM ('REQUEST_COUNT', 'DAY_COUNT');
CREATE TYPE "LeaveLimitPeriodKind" AS ENUM ('YEAR');

-- ===========================================================================
-- 2. LeavePolicy — the stable identity.
-- ===========================================================================
CREATE TABLE "LeavePolicy" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- Two tenants may each own `DEFAULT`; one tenant may not own two.
CREATE UNIQUE INDEX "LeavePolicy_tenantId_code_key" ON "LeavePolicy"("tenant_id", "code");
-- The composite-key target the two child tables point at.
CREATE UNIQUE INDEX "LeavePolicy_tenantId_id_key" ON "LeavePolicy"("tenant_id", "id");
-- The catalogue read.
CREATE INDEX "LeavePolicy_tenantId_code_idx" ON "LeavePolicy"("tenant_id", "code");

-- ===========================================================================
-- 3. LeavePolicyVersion — one authored body, effective-dated.
-- ===========================================================================
CREATE TABLE "LeavePolicyVersion" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "version_label" VARCHAR(64) NOT NULL,
    "jalali_year" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" "LeavePolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_employee_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeavePolicyVersion_pkey" PRIMARY KEY ("id")
);

-- One tenant does not label two versions of one policy the same.
CREATE UNIQUE INDEX "LeavePolicyVersion_tenantId_policyId_versionLabel_key"
  ON "LeavePolicyVersion"("tenant_id", "policy_id", "version_label");
-- The composite-key target for the limit's two tenant-qualified foreign keys.
CREATE UNIQUE INDEX "LeavePolicyVersion_tenantId_id_key"
  ON "LeavePolicyVersion"("tenant_id", "id");
-- The version catalogue read, and the index the overlap pre-check uses.
CREATE INDEX "LeavePolicyVersion_tenantId_policyId_effectiveFrom_idx"
  ON "LeavePolicyVersion"("tenant_id", "policy_id", "effective_from");
-- "Which version of this policy occupies this state".
CREATE INDEX "LeavePolicyVersion_tenantId_policyId_status_idx"
  ON "LeavePolicyVersion"("tenant_id", "policy_id", "status");

-- ===========================================================================
-- 4. LeaveLimitDefinition — a typed limit inside ONE version.
-- ===========================================================================
CREATE TABLE "LeaveLimitDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "employment_type" "EmploymentType",
    "maximum" INTEGER NOT NULL,
    "counting_basis" "LeaveCountingBasis" NOT NULL,
    "period" "LeaveLimitPeriodKind" NOT NULL,
    "jalali_year" INTEGER NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "consumes_states" "LeaveRequestStatus"[],
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveLimitDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveLimitDefinition_tenantId_id_key"
  ON "LeaveLimitDefinition"("tenant_id", "id");
-- The read the evaluator performs.
CREATE INDEX "LeaveLimitDefinition_tenantId_policyVersionId_leaveTypeId_idx"
  ON "LeaveLimitDefinition"("tenant_id", "policy_version_id", "leave_type_id");
-- The reconciliation read.

-- ===========================================================================
-- 5. SAME-TENANT EVERYTHING — the composite foreign keys.
--
--    Exactly the shape `LeaveRequest_tenant_employee_fkey` /
--    `LeaveRequest_tenant_leave_type_fkey` already demonstrate: a version can only name a
--    policy of ITS OWN tenant, a limit only a version and a leave type of ITS OWN tenant, and
--    that stays true for a writer that bypasses the service layer entirely. A bare uuid foreign
--    key would let one tenant's policy cite another tenant's leave type.
--
--    RESTRICT everywhere: a published document is evidence of what was in force on a day, and
--    evidence is not deleted. Deleting is not a lifecycle this schema offers (§15.5).
-- ===========================================================================
ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id")
  REFERENCES "LeavePolicy" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_tenant_publisher_fkey"
  FOREIGN KEY ("tenant_id", "published_by_employee_id")
  REFERENCES "Employee" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_tenant_policy_version_fkey"
  FOREIGN KEY ("tenant_id", "policy_version_id")
  REFERENCES "LeavePolicyVersion" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The SECOND anchor: the limit is tied to the policy as well as to the version, so a limit
-- whose `policy_id` disagreed with its version's policy would have to satisfy both keys at once
-- and could not be written.
ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id")
  REFERENCES "LeavePolicy" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_tenant_leave_type_fkey"
  FOREIGN KEY ("tenant_id", "leave_type_id")
  REFERENCES "LeaveType" ("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- 6. The CHECKs.
-- ===========================================================================

-- VERSION 6a. An inverted effective interval is not an interval. A closed version always
-- carries a real end date; `effective_to IS NULL` is the OPEN-ENDED current version and the
-- only meaning NULL is allowed to have here — the same date-only discipline
-- `EmploymentRecord`'s own CHECK applies.
ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_effective_period_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- VERSION 6b. The status and its publication facts agree in BOTH directions: no PUBLISHED row
-- without a publisher and an instant, and no publication instant on a row that is still
-- DRAFT or VALIDATED. This is what makes "who put this in force, and when?" a question the row
-- can always answer — the shape the Letter table and `LeaveRequest_cancelled_state_check`
-- document for their own status/timestamp pairs.
ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_published_state_check"
  CHECK (
    ("status" = 'PUBLISHED') = ("published_at" IS NOT NULL AND "published_by_employee_id" IS NOT NULL)
  );

-- LIMIT 6c. A maximum of zero is not a limit, it is a prohibition; stating one as the other
-- would make "no leave of this kind" indescribable in the vocabulary that describes every
-- other cap. Negative maximums are nonsense in either reading.
ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_maximum_positive_check"
  CHECK ("maximum" > 0);

-- LIMIT 6d. `window_start <= window_end` — an inverted counting window is unwritable.
-- `window_start = window_end` IS valid, and is the single-day window.
ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_window_period_check"
  CHECK ("window_end" >= "window_start");

-- LIMIT 6e. The effective interval, the same rule as the version's.
ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_effective_period_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- LIMIT 6f. `consumes_states` is REQUIRED and has NO DEFAULT (§16.4). "Does a pending request
-- consume the limit?" is a policy question, so the policy author states it and the engine never
-- guesses: a limit with an empty or absent state set would silently count everything or
-- nothing, and a limit that consumes NO state is met by nobody forever.
--
-- The three cases are written out rather than using `COALESCE(cardinality(x), 0) > 0` because
-- an ARRAY column also accepts a NULL in the array's ELEMENTS, and `ARRAY[NULL]::"LeaveRequestStatus"[]`
-- passes a naive cardinality test while naming no state at all. `array_position(..., NULL) IS
-- NULL` is what makes "no NULL element", and it is spelled with whitespace so the literal
-- datatype is resolved by the array cast rather than by an untyped literal.
--
-- The order also matters: PostgreSQL evaluates the conjuncts left to right and short-circuits,
-- so `IS NULL` is decided before `array_position` is reached.
ALTER TABLE "LeaveLimitDefinition"
  ADD CONSTRAINT "LeaveLimitDefinition_consumes_states_non_empty_check"
  CHECK (
    "consumes_states" IS NOT NULL
    AND cardinality("consumes_states") > 0
    AND array_position("consumes_states", NULL ) IS NULL
  );

-- ===========================================================================
-- 7. The overlap guard — §15.4 and §37.6.
--
--    §15.4 refuses two versions "of the same scope" whose effective intervals overlap, and
--    §37.6 names the scope explicitly: "the persistence layer refuses a second PUBLISHED
--    version for the same scope and effective interval (a uniqueness/exclusion rule, not a
--    'last write wins')".
--
--    WHAT "THE SAME SCOPE" IS, AND WHY IT IS A DERIVED COLUMN RATHER THAN `policy_id` ALONE
--    ------------------------------------------------------------------------------------
--    Each version belongs to one policy, so the equality side of the constraint is
--    `(tenant_id, policy_id)` — the same-tenant pair every other HR guarantee uses. The scope is
--    what turns the remaining overlap test into the rule §37.6 states, and it is derived from
--    `status` by a GENERATED column:
--
--      authoring_scope =
--        'AUTHORING'                   when status is DRAFT or VALIDATED
--        'PUBLISHED:' || id            when status is PUBLISHED
--
--    The consequence is exactly the frozen reading:
--
--      * SEVERAL DRAFTS may be drawn up for one overlapping interval. That is what drafting IS,
--        and a constraint that refused it would make "prepare two options and choose one"
--        unwritable;
--      * a DRAFT may overlap a PUBLISHED version, because authoring a successor begins while the
--        predecessor is still in force — the ordinary case, not an edge case;
--      * TWO PUBLISHED VERSIONS of one policy can never overlap, because each carries its own
--        `id` in the scope and the equality side therefore cannot match. §37.6 is this sentence.
--
--    WHY THE COLUMN IS GENERATED RATHER THAN TRIGGER-MAINTAINED
--    --------------------------------------------------------
--    A generated column cannot drift from the status it is derived from, and a writer that
--    bypasses the service cannot forget to maintain it. Storing it in a plain column would make
--    the guarantee depend on a convention — precisely what §15.7 says is not a guarantee.
--
--    IMMUTABILITY OF THE DERIVATION: because `id` is the primary key and immutable, a PUBLISHED
--    row's scope is fixed. Republishing the same version in place is refused by the immutability
--    trigger below; the SAME version merely changing status would change its scope, so the
--    trigger is what makes this derivation monotone rather than merely clever.
--
--    `daterange(effective_from, COALESCE(effective_to, 'infinity'), '[]')` is INCLUSIVE on both
--    ends, matching the schema's date-only semantics: a version ending 2027-03-20 covers
--    2027-03-20, so a successor starting 2027-03-20 is the overlap this constraint rejects. A
--    NULL `effective_to` is an OPEN-ENDED interval, and 'infinity' is what makes it overlap
--    every later interval. This is the same daterange idiom
--    `20260916090000_hr_exclusive_interval_and_cycle_guards` uses for employment intervals.
--
--    `btree_gist` supplies the `=` operator class for the text columns so an equality can
--    participate in a GiST index. It was created by an earlier migration and is re-asserted here
--    so this file is also runnable on its own.
-- ===========================================================================
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "LeavePolicyVersion"
  ADD COLUMN "authoring_scope" TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN "status" = 'PUBLISHED' THEN 'PUBLISHED:' || "id"::text
      ELSE 'AUTHORING'
    END
  ) STORED;

ALTER TABLE "LeavePolicyVersion"
  ADD CONSTRAINT "LeavePolicyVersion_scope_no_overlap_excl"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "policy_id" WITH =,
    "authoring_scope" WITH =,
    daterange("effective_from", COALESCE("effective_to", DATE 'infinity'), '[]') WITH &&
  );

-- ===========================================================================
-- 8. Published immutability — §15.7.
--
--    "Published immutability is enforced at the storage layer, not only by a service
--    convention — the precedent is `hr_org_unit_no_cycle_guard` (a trigger/constraint refusal
--    for a writer that bypasses the service). A PUBLISHED version that a second writer can edit
--    is not immutable, it is merely polite."
--
--    The trigger refuses ANY update to a row that IS published, and any DELETE of one. It does
--    not enumerate the columns it protects, and that is deliberate: an allow-list of "fields you
--    may still touch" is a list somebody has to keep complete, and the field somebody forgets to
--    add is the one that quietly changes what was in force. The state is the lock (§37.7).
--
--    WHAT REMAINS LEGAL ON A PUBLISHED ROW: nothing, including the transition INTO the state.
--    The transition `VALIDATED -> PUBLISHED` arrives as an UPDATE on a row that was NOT yet
--    PUBLISHED, which this trigger permits; once `NEW.status = 'PUBLISHED'` the row is frozen
--    for every later writer. Publishing a correction therefore means publishing the NEXT
--    version, which is exactly what keeps an explanation rendered from an old row true forever.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "hr_assert_leave_policy_version_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'PUBLISHED' THEN
      RAISE EXCEPTION 'LeavePolicyVersion % is PUBLISHED and cannot be deleted', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'LeavePolicyVersion % is PUBLISHED and cannot be modified', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeavePolicyVersion_published_immutable_guard"
  BEFORE UPDATE OR DELETE
  ON "LeavePolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_policy_version_immutable"();

-- ---------------------------------------------------------------------------
-- 8b. The SAME refusal for a limit whose PARENT version is published.
--
--    A limit is part of the published document (§15.6), so leaving it mutable would make the
--    trigger above a lock on the cover page while the terms stayed writable — the guarantee
--    would be real about the wrong object. The parent's state is read inside the trigger, in
--    the same transaction, so there is no window in which a version publishes and a limit is
--    still editable.
--
--    A limit CAN be deleted while its version is a draft: a draft is a document still being
--    written, and no decision cites it. INSERT is never refused — the only way to add a limit
--    to a PUBLISHED version would be to publish that version again, which the parent trigger
--    already forbids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "hr_assert_leave_limit_definition_immutable"() RETURNS trigger AS $$
DECLARE
  parent_status "LeavePolicyVersionStatus";
BEGIN
  SELECT v."status" INTO parent_status
    FROM "LeavePolicyVersion" v
   WHERE v."id" = COALESCE(NEW."policy_version_id", OLD."policy_version_id")
     AND v."tenant_id" = COALESCE(NEW."tenant_id", OLD."tenant_id");

  IF parent_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'LeaveLimitDefinition % belongs to a PUBLISHED LeavePolicyVersion and cannot be modified or deleted',
      COALESCE(NEW."id", OLD."id")
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveLimitDefinition_published_immutable_guard"
  BEFORE UPDATE OR DELETE
  ON "LeaveLimitDefinition"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_limit_definition_immutable"();
