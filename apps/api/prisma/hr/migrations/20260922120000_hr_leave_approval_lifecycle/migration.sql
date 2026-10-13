-- ===========================================================================
-- Phase 54-E — LEAVE APPROVAL LIFECYCLE
-- ===========================================================================
--
-- WHAT THIS MIGRATION ADDS, AND WHY EACH PIECE IS HERE
-- ---------------------------------------------------
--   * the two terminal REQUEST states a routed flow can reach:
--     `LeaveRequestStatus.APPROVED` and `LeaveRequestStatus.REJECTED` (§21);
--   * the status discipline that keeps `approved_at` / `rejected_at` tied to the
--     state in BOTH directions (§18.3, §21);
--   * the five approval-family tables: the flow definition, its ordered steps,
--     its effective-dated substitutions, the runtime instance and the runtime
--     step (§17);
--   * the enums those tables read: six step states, two instance states, three
--     resolution reasons and two decision values (§17.5, §18.2);
--   * the tenancy guarantee, as composite tenant-qualified foreign keys — the
--     same mechanism the rest of this database already uses, because a
--     convention would be enforced only by the writers that remember it;
--   * the ORDERING guarantee as a unique `(tenant, definition, order)` pair plus
--     a positivity check, because a gap is a step somebody meant to add (§18.4);
--   * the ONE-LIVE-FLOW-PER-REQUEST guarantee as a PARTIAL unique index (§17.2);
--   * the ONE-ACTIVE-STEP guarantee as a PARTIAL unique index (§18.4);
--   * the effective-dated substitution OVERLAP refusal as an EXCLUSION
--     constraint (§19.4) — `btree_gist`, the same remedy the attendance and
--     policy-interval guards use;
--   * the APPROVAL-HISTORY IMMUTABILITY guarantee as BEFORE UPDATE OR DELETE
--     triggers (§17.6): the spec freezes the SEMANTICS, and the mechanism is
--     storage-layer because a guarantee the module could bypass is a convention.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * it does NOT rewrite a single existing `LeaveRequest` row — the two new
--     enum members are additive, and the status CHECK is dropped and recreated
--     with the new spellings WITHOUT touching the columns it does not own;
--   * it seeds NO business policy, NO approval flow and NO approver: an
--     ungoverned tenant keeps its requests `PENDING` with no instance at all
--     (§18.5), which is the honest rendering of "no flow has been stated";
--   * it alters NO unrelated HR table — every statement below names only the
--     approval family and the request status vocabulary.
--
-- ORDER OF STATEMENTS
-- -------------------
--   Enums first (a CHECK cannot cite a value the type does not yet carry), then
--   the request-state columns and CHECK, then the tables, then their indexes and
--   the composite foreign keys, then the exclusion constraint and the
--   immutability triggers.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The two terminal REQUEST states (§21).
--
--    Both are TERMINAL and neither carries a decision of its own: the fact that
--    a request is `APPROVED` says a flow reached its last step, and WHO decided
--    it lives on that step (§17.1). `CANCELLED` already exists.
--
--    Postgres refuses to USE a value added by `ALTER TYPE ... ADD VALUE` inside
--    the same transaction that added it. Prisma runs a migration file in one
--    transaction, so the members this file's own CHECK depends on are added in
--    the block below and the CHECK that reads them is created after the
--    enum-extension block has committed — see the `COMMIT` there.
-- ---------------------------------------------------------------------------
ALTER TYPE "LeaveRequestStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "LeaveRequestStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

COMMIT;

-- ---------------------------------------------------------------------------
-- 2. The request status discipline (§18.3, §21).
--
--    The rule `LeaveRequest_cancelled_state_check` already stated for withdrawal,
--    extended to the two states a flow can now reach:
--
--        PENDING   <=> none of the three timestamps is set
--        APPROVED  <=> approved_at IS NOT NULL, the other two NULL
--        REJECTED  <=> rejected_at IS NOT NULL, the other two NULL
--        CANCELLED <=> cancelled_at IS NOT NULL, the other two NULL
--
--    "<=>" IN BOTH DIRECTIONS, deliberately. A one-way implication would let a
--    writer stamp a decision timestamp and leave the request `PENDING`, which is
--    a row whose state contradicts its own evidence — the same lie the CANCELLED
--    pairing was written to prevent.
--
--    THE TWO NEW COLUMNS ARE NULLABLE AND DEFAULT TO NULL, so NO EXISTING ROW IS
--    REWRITTEN: every row present today has all three timestamps NULL and is
--    therefore `PENDING`, which the CHECK accepts. The old constraint is dropped
--    by name and replaced by a wider one; nothing else about the table moves.
--
--    The decision FIELDS (`decidedBy`, `decisionReason`, `decidedAt`) are NOT
--    here: a request may have several steps, and a single column could say only
--    one of them (§17.1). They live on `LeaveApprovalStepInstance`.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveRequest" ADD COLUMN "approved_at" TIMESTAMPTZ(6);
ALTER TABLE "LeaveRequest" ADD COLUMN "rejected_at" TIMESTAMPTZ(6);

ALTER TABLE "LeaveRequest" DROP CONSTRAINT "LeaveRequest_cancelled_state_check";

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_state_check" CHECK (
     ("status" = 'PENDING'   AND "approved_at" IS NULL     AND "rejected_at" IS NULL     AND "cancelled_at" IS NULL)
  OR ("status" = 'APPROVED'  AND "approved_at" IS NOT NULL AND "rejected_at" IS NULL     AND "cancelled_at" IS NULL)
  OR ("status" = 'REJECTED'  AND "rejected_at" IS NOT NULL AND "approved_at" IS NULL     AND "cancelled_at" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "approved_at" IS NULL    AND "rejected_at" IS NULL)
);

-- ---------------------------------------------------------------------------
-- 3. The approval-family enums (§17.5, §18.2, §19).
--
--    SIX step states and no more. `DELEGATED`, `ESCALATED`, `EXPIRED` and
--    `ON_HOLD` are refused in writing: a substitution is the SAME step with a
--    different resolved approver (so it is a resolution REASON, not a status),
--    and there is no scheduler in these layers to reach a timeout.
-- ---------------------------------------------------------------------------
CREATE TYPE "LeaveApprovalStepStatus" AS ENUM ('PENDING', 'ACTIVE', 'APPROVED', 'REJECTED', 'SKIPPED', 'CANCELLED');

--    TWO instance states: a flow is open or it is over. A withdrawn flow has
--    still ENDED, so there is no third spelling of "over" — the REQUEST's own
--    `CANCELLED` says which way it ended, while the step rows say which steps
--    were decided.
CREATE TYPE "LeaveApprovalInstanceStatus" AS ENUM ('ACTIVE', 'COMPLETED');

--    WHY a step's resolved approver is who they are.
CREATE TYPE "LeaveApprovalResolutionReason" AS ENUM ('PRIMARY', 'SUBSTITUTE', 'NO_RESOLUTION');

--    WHAT was stated, as distinct from WHERE THE STEP STANDS. Merging the two
--    would make "this step was skipped" and "this step was decided" the same
--    kind of value, so `decision IS NULL` would stop being the single test for
--    "nobody stated anything here".
CREATE TYPE "LeaveApprovalStepDecision" AS ENUM ('APPROVED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- 4. The flow DEFINITION (§17, §18). One per policy VERSION.
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveApprovalDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveApprovalDefinition_pkey" PRIMARY KEY ("id")
);

--    The label and the display name are trimmed and non-blank. A blank name is
--    not a shorter name; it is an unnamed step on a screen an approver has to
--    act on, and the place to refuse it is here rather than at render time.
ALTER TABLE "LeaveApprovalDefinition" ADD CONSTRAINT "LeaveApprovalDefinition_name_check"
  CHECK (btrim("name") <> '' AND btrim("code") <> '');

-- ---------------------------------------------------------------------------
-- 5. The ordered STEPS of a flow (§17, §18.4, §25.3).
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveApprovalStepDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_definition_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "approver_employee_id" UUID,
    "approver_role" VARCHAR(64),
    "availability_signal" VARCHAR(64),
    "allow_self_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveApprovalStepDefinition_pkey" PRIMARY KEY ("id")
);

--    EXACTLY ONE WAY TO NAME THE APPROVER. A step names a PERSON or a ROLE, and
--    the absent column is how it says which KIND of rule it is — rather than a
--    `mode` enum that could disagree with the columns beside it (§17.3).
ALTER TABLE "LeaveApprovalStepDefinition" ADD CONSTRAINT "LeaveApprovalStepDefinition_approver_check"
  CHECK (
    ("approver_employee_id" IS NOT NULL AND "approver_role" IS NULL)
    OR ("approver_employee_id" IS NULL AND "approver_role" IS NOT NULL)
  );

--    THE ORDER IS A POSITIVE, STATED INTEGER. `1..n`, dense inside the flow.
--    Density itself is a publish-time property (a draft may be mid-edit), but a
--    non-positive position is never meaningful, so it is refused here.
ALTER TABLE "LeaveApprovalStepDefinition" ADD CONSTRAINT "LeaveApprovalStepDefinition_order_check"
  CHECK ("order" > 0);

--    `NO_RESOLUTION` IS A RESOLUTION, NOT A SIGNAL. A signal is one of the six
--    frozen tokens and is validated by name at the application boundary; this
--    CHECK refuses the two shapes no explanation could render: an empty string,
--    and the resolution reason used as if it were a signal.
ALTER TABLE "LeaveApprovalStepDefinition" ADD CONSTRAINT "LeaveApprovalStepDefinition_signal_check"
  CHECK (
    "availability_signal" IS NULL
    OR (
      btrim("availability_signal") <> ''
      AND "availability_signal" <> 'NO_RESOLUTION'
    )
  );

ALTER TABLE "LeaveApprovalStepDefinition" ADD CONSTRAINT "LeaveApprovalStepDefinition_name_check"
  CHECK (btrim("name") <> '');

-- ---------------------------------------------------------------------------
-- 6. The effective-dated SUBSTITUTION (§19).
--
--    `primary_employee_id` is DENORMALIZED on purpose: the exclusion constraint
--    below must bound the intervals for one primary without joining, and a
--    historical explanation must be able to state whose unavailability triggered
--    the replacement without reconstructing it from a step row that may since
--    have been re-pointed in a draft.
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveSubstitutionDefinition" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_step_definition_id" UUID NOT NULL,
    "primary_employee_id" UUID NOT NULL,
    "substitute_employee_id" UUID NOT NULL,
    "condition_signal" VARCHAR(64) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "stated_by_employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveSubstitutionDefinition_pkey" PRIMARY KEY ("id")
);

--    A PERSON IS NOT THEIR OWN SUBSTITUTE. Recording one would route the step to
--    the person it was just declared unavailable, which is not a substitution.
ALTER TABLE "LeaveSubstitutionDefinition" ADD CONSTRAINT "LeaveSubstitutionDefinition_distinct_check"
  CHECK ("primary_employee_id" <> "substitute_employee_id");

--    A STATED INTERVAL IS ORDERED (§19.4). A row whose `effective_to` precedes
--    its `effective_from` matches no day at all, so it would silently never
--    apply while looking like a stated rule.
ALTER TABLE "LeaveSubstitutionDefinition" ADD CONSTRAINT "LeaveSubstitutionDefinition_interval_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

--    The condition is a real signal, and never a blank string.
ALTER TABLE "LeaveSubstitutionDefinition" ADD CONSTRAINT "LeaveSubstitutionDefinition_signal_check"
  CHECK (btrim("condition_signal") <> '' AND "condition_signal" <> 'NO_RESOLUTION');

-- ---------------------------------------------------------------------------
-- 7. The runtime INSTANCE: one live flow for a request (§17.2, §18.1).
--
--    `request_start_date` / `request_end_date` / `step_count` are COPIED at
--    routing time. The range is copied because an availability answer is only
--    true about a stated range; the count is copied because "is this the LAST
--    step?" must be answered from the step rows the instance actually owns, not
--    from live configuration that may have changed since (§23).
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveApprovalInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "leave_request_id" UUID NOT NULL,
    "approval_definition_id" UUID NOT NULL,
    "status" "LeaveApprovalInstanceStatus" NOT NULL DEFAULT 'ACTIVE',
    "request_start_date" DATE NOT NULL,
    "request_end_date" DATE NOT NULL,
    "step_count" INTEGER NOT NULL,
    "routed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveApprovalInstance_pkey" PRIMARY KEY ("id")
);

--    `COMPLETED` AND ITS TIMESTAMP AGREE, IN BOTH DIRECTIONS. "Completed with no
--    timestamp" and "a timestamp on a flow that is still open" are both
--    unwritable — the coupling `LeavePolicyVersion` documents for
--    `published_at` and the Letter table documents for its own pairs.
ALTER TABLE "LeaveApprovalInstance" ADD CONSTRAINT "LeaveApprovalInstance_completed_state_check"
  CHECK (
    ("status" = 'ACTIVE'    AND "completed_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL)
  );

--    A flow has at least one step, and its range is ordered. A zero-step flow
--    would be a flow nobody can decide, which is indistinguishable on screen
--    from one that is merely waiting.
ALTER TABLE "LeaveApprovalInstance" ADD CONSTRAINT "LeaveApprovalInstance_shape_check"
  CHECK ("step_count" > 0 AND "request_end_date" >= "request_start_date");

-- ---------------------------------------------------------------------------
-- 8. The runtime STEP: who was asked, what they stated, and why (§17.3, §17.5).
--
--    THIS IS WHERE A DECISION LIVES, AND THERE IS NO OTHER PLACE. The status and
--    the decision are coupled in BOTH directions:
--
--        PENDING   / ACTIVE    / SKIPPED / CANCELLED  <=> no decision
--        APPROVED  <=> decision = 'APPROVED'
--        REJECTED  <=> decision = 'REJECTED' AND a non-blank reason
--
--    A step cannot be `APPROVED` with no decision, cannot carry a decision while
--    merely `ACTIVE`, and cannot be `REJECTED` without saying why. The service
--    refuses those shapes with a readable error; this constraint is what makes
--    them unwritable by anyone.
-- ---------------------------------------------------------------------------
CREATE TABLE "LeaveApprovalStepInstance" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_instance_id" UUID NOT NULL,
    "approval_step_definition_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "LeaveApprovalStepStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_approver_employee_id" UUID,
    "resolution_reason" "LeaveApprovalResolutionReason" NOT NULL DEFAULT 'NO_RESOLUTION',
    "resolution_signal" VARCHAR(64),
    "decision" "LeaveApprovalStepDecision",
    "decided_by_employee_id" UUID,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(6),
    "rule_version_label" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LeaveApprovalStepInstance_pkey" PRIMARY KEY ("id")
);

--    WHERE THE STEP STANDS AND WHAT WAS STATED, kept in step (§17.5).
ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_decision_check"
  CHECK (
    ("status" IN ('PENDING', 'ACTIVE', 'SKIPPED', 'CANCELLED') AND "decision" IS NULL AND "decided_at" IS NULL)
    OR ("status" = 'APPROVED' AND "decision" = 'APPROVED' AND "decided_at" IS NOT NULL)
    OR ("status" = 'REJECTED' AND "decision" = 'REJECTED' AND "decided_at" IS NOT NULL
        AND "decision_reason" IS NOT NULL AND btrim("decision_reason") <> '')
  );

--    A REFUSAL CARRIES ITS REASON; AN APPROVAL MAY CARRY ONE (§21). Stated
--    separately from the constraint above so a blank string is refused even if
--    the reason column is present but empty.
ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_reason_check"
  CHECK ("decision_reason" IS NULL OR btrim("decision_reason") <> '');

--    WHO DECIDED, IF A DECISION EXISTS. A decided step names its decider, and a
--    step that names one has been decided: a decider on a `PENDING` step is a
--    person recorded as having decided something nobody asked them.
ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_decider_check"
  CHECK (
    ("decision" IS NULL AND "decided_by_employee_id" IS NULL)
    OR ("decision" IS NOT NULL AND "decided_by_employee_id" IS NOT NULL)
  );

--    THE RESOLUTION AND ITS APPROVER AGREE (§17.3, §19.2).
--
--      PRIMARY / SUBSTITUTE  -> exactly one resolved approver, and a signal that
--                               explains which availability test produced them.
--      NO_RESOLUTION         -> NO resolved approver at all. The fail-closed
--                               spelling: nobody may decide this step, so
--                               recording an approver beside it would name
--                               somebody who is not entitled to act.
ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_resolution_check"
  CHECK (
    ("resolution_reason" IN ('PRIMARY', 'SUBSTITUTE')
       AND "resolved_approver_employee_id" IS NOT NULL
       AND "resolution_signal" IS NOT NULL
       AND btrim("resolution_signal") <> '')
    OR ("resolution_reason" = 'NO_RESOLUTION'
       AND "resolved_approver_employee_id" IS NULL)
  );

--    A step's own resolution signal is from the closed vocabulary, and never the
--    resolution reason spelled as a signal.
ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_signal_check"
  CHECK ("resolution_signal" IS NULL OR "resolution_signal" <> 'NO_RESOLUTION');

ALTER TABLE "LeaveApprovalStepInstance" ADD CONSTRAINT "LeaveApprovalStepInstance_order_check"
  CHECK ("order" > 0);

-- ---------------------------------------------------------------------------
-- 9. Indexes, including the two PARTIAL ones that carry guarantees.
-- ---------------------------------------------------------------------------

-- The composite-key targets for the same-tenant foreign keys below.
CREATE UNIQUE INDEX "LeaveApprovalDefinition_tenantId_id_key" ON "LeaveApprovalDefinition"("tenant_id", "id");
CREATE UNIQUE INDEX "LeaveApprovalStepDefinition_tenantId_id_key" ON "LeaveApprovalStepDefinition"("tenant_id", "id");
CREATE UNIQUE INDEX "LeaveSubstitutionDefinition_tenantId_id_key" ON "LeaveSubstitutionDefinition"("tenant_id", "id");
CREATE UNIQUE INDEX "LeaveApprovalInstance_tenantId_id_key" ON "LeaveApprovalInstance"("tenant_id", "id");
CREATE UNIQUE INDEX "LeaveApprovalStepInstance_tenantId_id_key" ON "LeaveApprovalStepInstance"("tenant_id", "id");

-- ONE FLOW PER VERSION (§17.2). Two live flows for one version would make
-- "which flow did this request take?" ambiguous at exactly the moment it must
-- not be.
CREATE UNIQUE INDEX "LeaveApprovalDefinition_tenantId_policyVersionId_key"
  ON "LeaveApprovalDefinition"("tenant_id", "policy_version_id");

-- The tenant's own flow label, unique inside the version it belongs to.
CREATE UNIQUE INDEX "LeaveApprovalDefinition_tenantId_policyVersionId_code_key"
  ON "LeaveApprovalDefinition"("tenant_id", "policy_version_id", "code");

-- THE ORDERING RULE (§18.4): one position, one step. The pair is what makes
-- "activate the next step" a lookup rather than a sort — and it is what stops a
-- duplicate position from making the route depend on the order rows were read.
CREATE UNIQUE INDEX "LeaveApprovalStepDefinition_tenantId_definitionId_order_key"
  ON "LeaveApprovalStepDefinition"("tenant_id", "approval_definition_id", "order");

CREATE INDEX "LeaveApprovalStepDefinition_tenantId_approverEmployeeId_idx"
  ON "LeaveApprovalStepDefinition"("tenant_id", "approver_employee_id");

-- The lookup the substitution resolver presses on: this primary's intervals.
CREATE INDEX "LeaveSubstitutionDefinition_tenantId_primaryEmployeeId_from_idx"
  ON "LeaveSubstitutionDefinition"("tenant_id", "primary_employee_id", "effective_from");

-- The register read: "this request's flows", tenant-qualified.
CREATE INDEX "LeaveApprovalInstance_tenantId_leaveRequestId_status_idx"
  ON "LeaveApprovalInstance"("tenant_id", "leave_request_id", "status");

-- THE ONE-LIVE-FLOW-PER-REQUEST GUARANTEE (§17.2), as a PARTIAL unique index.
--
-- The partiality IS the guarantee. A request may legitimately own more than one
-- instance row over its life — a withdrawn flow, then a flow opened for a
-- corrected request — but only ONE may be open at a time. A plain unique index
-- would make re-routing impossible; no index at all would let two flows run at
-- once, with two people each believing they are the decision.
CREATE UNIQUE INDEX "LeaveApprovalInstance_one_active_per_request_key"
  ON "LeaveApprovalInstance"("tenant_id", "leave_request_id")
  WHERE "status" = 'ACTIVE';

-- THE ONE-ACTIVE-STEP GUARANTEE (§18.4), also as a PARTIAL unique index.
-- "At most one ACTIVE step per instance" is the whole of sequential routing: a
-- second ACTIVE step would be a second person asked the same question at the
-- same time.
CREATE UNIQUE INDEX "LeaveApprovalStepInstance_one_active_per_instance_key"
  ON "LeaveApprovalStepInstance"("tenant_id", "approval_instance_id")
  WHERE "status" = 'ACTIVE';

-- The runtime ordering rule: one position, one step, inside one instance.
CREATE UNIQUE INDEX "LeaveApprovalStepInstance_tenantId_instanceId_order_key"
  ON "LeaveApprovalStepInstance"("tenant_id", "approval_instance_id", "order");

-- "What is waiting for this person?" — the read an approver's own queue performs.
CREATE INDEX "LeaveApprovalStepInstance_tenantId_resolvedApprover_status_idx"
  ON "LeaveApprovalStepInstance"("tenant_id", "resolved_approver_employee_id", "status");

-- ---------------------------------------------------------------------------
-- 10. The same-tenant foreign keys (§15, §49).
--
--     EVERY relation inside the approval family is proved same-tenant by a
--     COMPOSITE key that carries `tenant_id` on both ends, exactly as
--     `LeaveRequest_tenant_employee_fkey` already does for requests. A plain
--     single-column foreign key would let a step of tenant A cite the flow of
--     tenant B: the row would reference an EXISTING id, so the database would
--     accept it and only an attentive reader would notice.
--
--     ALL of them are `ON DELETE RESTRICT`. An approval family row is evidence
--     of what was asked and what was stated, and evidence is not deleted — which
--     is also why there is no `CASCADE` anywhere below.
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaveApprovalDefinition"
  ADD CONSTRAINT "LeaveApprovalDefinition_tenant_policy_version_fkey"
  FOREIGN KEY ("tenant_id", "policy_version_id") REFERENCES "LeavePolicyVersion"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepDefinition"
  ADD CONSTRAINT "LeaveApprovalStepDefinition_tenant_definition_fkey"
  FOREIGN KEY ("tenant_id", "approval_definition_id") REFERENCES "LeaveApprovalDefinition"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepDefinition"
  ADD CONSTRAINT "LeaveApprovalStepDefinition_tenant_approver_fkey"
  FOREIGN KEY ("tenant_id", "approver_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveSubstitutionDefinition"
  ADD CONSTRAINT "LeaveSubstitutionDefinition_tenant_step_fkey"
  FOREIGN KEY ("tenant_id", "approval_step_definition_id") REFERENCES "LeaveApprovalStepDefinition"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveSubstitutionDefinition"
  ADD CONSTRAINT "LeaveSubstitutionDefinition_tenant_primary_fkey"
  FOREIGN KEY ("tenant_id", "primary_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveSubstitutionDefinition"
  ADD CONSTRAINT "LeaveSubstitutionDefinition_tenant_substitute_fkey"
  FOREIGN KEY ("tenant_id", "substitute_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveSubstitutionDefinition"
  ADD CONSTRAINT "LeaveSubstitutionDefinition_tenant_stated_by_fkey"
  FOREIGN KEY ("tenant_id", "stated_by_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalInstance"
  ADD CONSTRAINT "LeaveApprovalInstance_tenant_request_fkey"
  FOREIGN KEY ("tenant_id", "leave_request_id") REFERENCES "LeaveRequest"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalInstance"
  ADD CONSTRAINT "LeaveApprovalInstance_tenant_definition_fkey"
  FOREIGN KEY ("tenant_id", "approval_definition_id") REFERENCES "LeaveApprovalDefinition"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepInstance"
  ADD CONSTRAINT "LeaveApprovalStepInstance_tenant_instance_fkey"
  FOREIGN KEY ("tenant_id", "approval_instance_id") REFERENCES "LeaveApprovalInstance"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepInstance"
  ADD CONSTRAINT "LeaveApprovalStepInstance_tenant_definition_fkey"
  FOREIGN KEY ("tenant_id", "approval_step_definition_id") REFERENCES "LeaveApprovalStepDefinition"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepInstance"
  ADD CONSTRAINT "LeaveApprovalStepInstance_tenant_resolved_approver_fkey"
  FOREIGN KEY ("tenant_id", "resolved_approver_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalStepInstance"
  ADD CONSTRAINT "LeaveApprovalStepInstance_tenant_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_employee_id") REFERENCES "Employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 11. ONE SUBSTITUTION PER PRIMARY PER DAY (§19.4), as an EXCLUSION CONSTRAINT.
--
--     "Which substitution applied on this day?" must have a single answer. Two
--     rows that both match a day would make the resolver's answer depend on row
--     order, which is the one thing a routing decision may not depend on.
--
--     The constraint is per (tenant, primary): two DIFFERENT people may of course
--     be substituted at the same time. `effective_to` is treated as INCLUSIVE —
--     the column means "the last day it is effective" (§19.4) — so the range is
--     the closed interval `[effective_from, effective_to]`, built with
--     `daterange(..., '[]')`, and an OPEN-ENDED row is unbounded above. The NULL
--     `effective_to` is made unbounded by reading it as `infinity` rather than
--     letting a NULL poison the comparison.
--
--     `btree_gist` is what lets an EQUALITY column (`tenant_id`,
--     `primary_employee_id`) sit beside a RANGE column in one exclusion
--     constraint — the same extension the attendance and policy-interval guards
--     in this database already depend on.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE "LeaveSubstitutionDefinition"
  ADD CONSTRAINT "LeaveSubstitutionDefinition_no_overlap_per_primary"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "primary_employee_id" WITH =,
    daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[]') WITH &&
  );

-- ---------------------------------------------------------------------------
-- 12. APPROVAL-HISTORY IMMUTABILITY, AT THE STORAGE LAYER (§17.6).
--
--     WHY A TRIGGER AND NOT A SERVICE RULE. The spec freezes the SEMANTICS —
--     approval history is not deletable, step history is append-only, a decided
--     step's fields are frozen — but does not name a mechanism. This repository
--     already holds the governing principle: guarantees that must survive a
--     writer bypassing the module are enforced in the DATABASE, which is why
--     `LeavePolicyVersion` has a published-immutability trigger and why the
--     interval guards are exclusion constraints. A service check alone would be
--     a convention: correct only for the writers that remember it, and silently
--     absent for a migration, a script or a future module.
--
--     The service keeps its OWN validation. It is the READABLE error boundary —
--     a typed refusal a caller can act on — but it is not the sole guarantee.
--
--     WHAT MUST REMAIN POSSIBLE. These triggers must not freeze the NORMAL
--     LIFECYCLE. Routing needs exactly these moves, and every one of them is
--     still legal afterwards:
--
--       step   PENDING -> ACTIVE -> APPROVED | REJECTED
--       step   PENDING -> SKIPPED | CANCELLED        (cascade on rejection)
--       instance ACTIVE -> COMPLETED
--
--     So the triggers refuse DELETION outright, refuse any change to the
--     HISTORICAL ROUTING FACTS of an instance, and refuse any change to a
--     DECIDED step's recorded facts — while permitting the transitions above.
-- ---------------------------------------------------------------------------

-- 12a. An INSTANCE IS NEVER DELETED AND ITS ROUTING FACTS NEVER CHANGE.
--
--      The instance row records WHICH flow decided WHICH request, over WHICH
--      requested range, with HOW MANY steps. Every one of those is a historical
--      fact fixed at routing time; a correction is a NEW instance, which is
--      precisely why `status = 'ACTIVE'` is only a PARTIAL unique key rather
--      than a permanent one.
--
--      `status` and `completed_at` ARE mutable, because reaching `COMPLETED` is
--      the one thing a live flow does; the CHECK elsewhere keeps the pair honest.
CREATE OR REPLACE FUNCTION "hr_assert_leave_approval_instance_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LeaveApprovalInstance % is approval history and cannot be deleted', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."leave_request_id" IS DISTINCT FROM OLD."leave_request_id"
     OR NEW."approval_definition_id" IS DISTINCT FROM OLD."approval_definition_id"
     OR NEW."request_start_date" IS DISTINCT FROM OLD."request_start_date"
     OR NEW."request_end_date" IS DISTINCT FROM OLD."request_end_date"
     OR NEW."step_count" IS DISTINCT FROM OLD."step_count"
     OR NEW."routed_at" IS DISTINCT FROM OLD."routed_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'LeaveApprovalInstance % records historical routing facts and cannot be rewritten', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'COMPLETED' AND NEW."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'LeaveApprovalInstance % is COMPLETED and cannot be reopened', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveApprovalInstance_history_immutable_guard"
  BEFORE UPDATE OR DELETE
  ON "LeaveApprovalInstance"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_approval_instance_immutable"();

-- 12b. A STEP IS APPEND-ONLY, AND FROZEN ONCE DECIDED.
--
--      DELETION IS NEVER LEGAL. A step row is the record of who was asked; the
--      `SKIPPED` and `CANCELLED` states exist precisely so that history is kept
--      rather than removed when a flow ends early (§18.2).
--
--      BEFORE A DECISION, the step is allowed to move and to be RESOLVED afresh:
--
--        * WITHDRAWAL CASCADES WITHOUT DECIDING ANYTHING. A withdrawn request's
--          undecided steps become `CANCELLED`, so `resolved_approver_employee_id`
--          may momentarily be NULL on a step whose predecessor resolution reason
--          was already recorded — and the resolver may write a resolution on a
--          step that is then cancelled. Refusing to UPDATE an unresolved step
--          would make withdrawal unrepresentable. What is frozen is the DECISION,
--          not the routing noise around it.
--        * `order`, `resolution_reason` and `resolution_signal` are therefore
--          mutable only while no decision exists. The moment `decision` is set,
--          this branch stops applying for good.
--
--      AFTER A DECISION, THE RECORD IS CLOSED. Every field that says what
--      happened — the position, the resolved approver, HOW they were resolved,
--      WHICH signal fired, the rule version in force, the decision, who decided,
--      why, and when — is immutable, and the status may not leave the decided
--      pair. "Who decided this, and under what?" is answered by this row forever.
--      The one write still permitted on a decided row is the system-maintained
--      `updated_at` stamp; everything else is refused.
CREATE OR REPLACE FUNCTION "hr_assert_leave_approval_step_instance_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LeaveApprovalStepInstance % is approval history and cannot be deleted', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF OLD."decision" IS NOT NULL THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."approval_instance_id" IS DISTINCT FROM OLD."approval_instance_id"
       OR NEW."approval_step_definition_id" IS DISTINCT FROM OLD."approval_step_definition_id"
       OR NEW."order" IS DISTINCT FROM OLD."order"
       OR NEW."resolved_approver_employee_id" IS DISTINCT FROM OLD."resolved_approver_employee_id"
       OR NEW."resolution_reason" IS DISTINCT FROM OLD."resolution_reason"
       OR NEW."resolution_signal" IS DISTINCT FROM OLD."resolution_signal"
       OR NEW."decision" IS DISTINCT FROM OLD."decision"
       OR NEW."decided_by_employee_id" IS DISTINCT FROM OLD."decided_by_employee_id"
       OR NEW."decision_reason" IS DISTINCT FROM OLD."decision_reason"
       OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
       OR NEW."rule_version_label" IS DISTINCT FROM OLD."rule_version_label"
       OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'LeaveApprovalStepInstance % has been decided and its record cannot be changed', OLD."id"
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."approval_instance_id" IS DISTINCT FROM OLD."approval_instance_id"
     OR NEW."approval_step_definition_id" IS DISTINCT FROM OLD."approval_step_definition_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'LeaveApprovalStepInstance % records historical routing facts and cannot be rewritten', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveApprovalStepInstance_history_immutable_guard"
  BEFORE UPDATE OR DELETE
  ON "LeaveApprovalStepInstance"
  FOR EACH ROW EXECUTE FUNCTION "hr_assert_leave_approval_step_instance_immutable"();
