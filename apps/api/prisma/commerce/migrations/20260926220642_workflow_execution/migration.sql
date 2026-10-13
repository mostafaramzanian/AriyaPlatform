-- Phase C1 step N: the configurable workflow execution vocabulary (§5.5–§5.8;
-- see docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md).
--
-- WHY THIS MIGRATION EXISTS, AND WHY IT IS ADDITIVE
-- -------------------------------------------------
-- Steps K/L/M shipped the workflow CONFIGURATION tables and declared the runtime
-- tables. Step N makes them EXECUTE, and execution needs five facts no column
-- could express before: which trigger event a version answers, how the
-- candidates for that trigger are ranked, the version's own selection
-- condition, how a parallel group completes, and what a false step condition
-- does. Every statement below is ADD-ONLY: three enum types, four nullable
-- columns on "WorkflowDefinitionVersion" and one nullable column on
-- "WorkflowStep". No column is altered, dropped or back-filled, no constraint is
-- rewritten and no index is touched — so this file is safe on a database that
-- has already run the baseline and the L counter migration, and K/L/M history
-- stays untouched.
--
-- WHY THE COLUMNS ARE NULLABLE
-- ----------------------------
-- A DRAFT is authored INCREMENTALLY: §5.5 keeps "incomplete" a state an
-- administrator may occupy, and it is the publish pipeline — not the table —
-- that demands a version be executable. Completeness is enforced exactly where
-- it becomes a promise, at /validate and /publish, with named refusals
-- (WORKFLOW_TRIGGER_MISSING, WORKFLOW_JOIN_POLICY_MISSING,
-- WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING, WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED,
-- WORKFLOW_ACTOR_SOURCE_UNSUPPORTED, WORKFLOW_LINE_SCOPE_UNSUPPORTED …), together
-- with the two null-as-neutral readings the contract records: `selection_priority
-- IS NULL` reads as rank 0 at selection time, and `selection_condition IS NULL`
-- is the unconditional candidate.
--
-- WHY NO CHECK CONSTRAINTS AND NO PARTIAL INDEX
-- ---------------------------------------------
-- Every new rule is a property of the WHOLE version ("a version with a PARALLEL
-- step must state parallel_join_policy", "a step that states a condition must
-- state its false behaviour", "BLOCKED is refused"), not of one row, so it
-- belongs to the publish pipeline that can see the version — stated and tested
-- there rather than duplicated as a per-row CHECK a correct publication path
-- could not satisfy. The enum types are the database's half of the same
-- contract: a value outside the C1 vocabulary — QUORUM, MAJORITY, an unmodelled
-- actor policy — cannot be stored at all, on a DRAFT or otherwise, so the
-- "closed vocabulary" claims the schema makes are true for a database inspected
-- long after the writer is gone.

-- Example reading of one new field, for a reviewer of the database rather than the
-- repository: after this migration, `WorkflowDefinitionVersion.trigger_event` is the
-- only thing that says "a submitted purchase may run this flow", so the ACTIVE RULES
-- of one tenancy are answerable in SQL without reading a migration or a service:
--
--   SELECT v."workflow_definition_id", v.version_label, v.selection_priority
--     FROM "WorkflowDefinitionVersion" v
--    WHERE v.tenant_id = $1
--      AND v.status = 'PUBLISHED'
--      AND v.trigger_event = 'PURCHASE_SUBMITTED'
--    ORDER BY COALESCE(v.selection_priority, 0) DESC;
--
-- (That query is documentation, not runtime: selection is a Rule Engine decision that
-- reads the candidate set through the repository and ranks it through the engine — a
-- SQL ORDER BY could only ever re-implement §12.1 partially.)

-- CreateEnum
CREATE TYPE "WorkflowTriggerEvent" AS ENUM ('PURCHASE_SUBMITTED');

-- CreateEnum
CREATE TYPE "WorkflowParallelJoinPolicy" AS ENUM ('ALL', 'ANY');

-- CreateEnum
CREATE TYPE "WorkflowConditionFalseBehavior" AS ENUM ('SKIPPED', 'BLOCKED', 'TERMINATED');

-- AlterTable
ALTER TABLE "WorkflowDefinitionVersion" ADD COLUMN     "parallel_join_policy" "WorkflowParallelJoinPolicy",
ADD COLUMN     "selection_condition" JSONB,
ADD COLUMN     "selection_priority" INTEGER,
ADD COLUMN     "trigger_event" "WorkflowTriggerEvent";

-- AlterTable
ALTER TABLE "WorkflowStep" ADD COLUMN     "on_condition_false" "WorkflowConditionFalseBehavior";
