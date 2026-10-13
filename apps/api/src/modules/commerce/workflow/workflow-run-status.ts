/**
 * The RUNTIME's status vocabularies: what a workflow RUN may be, and what one of its STEPS may
 * be — as values, so a transition table, a repository predicate and a spec can all name the
 * same members instead of three string literals drifting apart.
 *
 * WHY THESE BESIDE THE VERSION LIFECYCLE RATHER THAN INSIDE IT. `workflow-status.ts` owns the
 * question "may this DRAFT be published"; this module owns the other two: "what may a RUN be"
 * and "what may a STEP be". They are separate lifecycles (§5.9) — a version's status, a run's
 * status and a purchase document's status are three different facts — and one module claiming
 * two of them is how the third becomes ambiguous.
 */

/** `WorkflowInstanceStatus`, in the schema's order. */
export const WORKFLOW_INSTANCE_STATUSES = [
  'RUNNING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

/** True when `value` is a run status this platform may store. */
export function isWorkflowInstanceStatus(value: unknown): value is WorkflowInstanceStatus {
  return (
    typeof value === 'string' && (WORKFLOW_INSTANCE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The run statuses a run may never leave — and `EXPIRED` is one of them even though N ships no
 * writer for it (§18): a modelled terminal state that no scheduler reaches is still terminal,
 * and a future scheduler must not have to change what "finished" means.
 */
export const WORKFLOW_TERMINAL_INSTANCE_STATUSES = [
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

/** True when a run in this status is finished and may not be advanced or cancelled again. */
export function isWorkflowInstanceTerminal(status: WorkflowInstanceStatus): boolean {
  return (WORKFLOW_TERMINAL_INSTANCE_STATUSES as readonly string[]).includes(status);
}

/** `WorkflowStepInstanceStatus`, in the schema's order. */
export const WORKFLOW_STEP_INSTANCE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SKIPPED',
  'DELEGATED',
] as const;

export type WorkflowStepInstanceStatus = (typeof WORKFLOW_STEP_INSTANCE_STATUSES)[number];

/** True when `value` is a step status this platform may store. */
export function isWorkflowStepInstanceStatus(value: unknown): value is WorkflowStepInstanceStatus {
  return (
    typeof value === 'string' &&
    (WORKFLOW_STEP_INSTANCE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The step statuses a step may never leave: it approved, refused, or was not to be decided.
 * `DELEGATED` is deliberately NOT here — it names a handover, and N has no delegation runtime
 * (§18), so the member is stored vocabulary rather than a state this module reasons about.
 */
export const WORKFLOW_TERMINAL_STEP_INSTANCE_STATUSES = [
  'APPROVED',
  'REJECTED',
  'SKIPPED',
] as const;

/** True when a step in this status is finished and owes no decision. */
export function isWorkflowStepInstanceTerminal(status: WorkflowStepInstanceStatus): boolean {
  return (WORKFLOW_TERMINAL_STEP_INSTANCE_STATUSES as readonly string[]).includes(status);
}

/**
 * The ONE step status N's runtime writes for work still owed: `PENDING`. Spelled as a
 * constant because a conditional repository statement (`WHERE status = PENDING`) and the
 * planner's output must agree literally, and a typo there is a silent no-op that leaves a
 * decision unrecorded.
 */
export const WORKFLOW_STEP_INSTANCE_PENDING = 'PENDING' as const;

/**
 * What a person may DECIDE about a step, as a vocabulary of its own — APPROVED or REJECTED,
 * and nothing else.
 *
 * WHY IT IS EXTRACTED FROM THE STEP STATUS rather than re-declared: a decision is written AS a
 * status (`WorkflowStepInstance.decision` mirrors the step's new status), so a decision
 * vocabulary that could drift from the status vocabulary would be able to name a state the
 * column cannot hold. `Extract` makes them the same members by construction.
 */
export const WORKFLOW_STEP_DECISIONS = ['APPROVED', 'REJECTED'] as const;

export type WorkflowStepDecision = Extract<WorkflowStepInstanceStatus, 'APPROVED' | 'REJECTED'>;

/** True when `value` is a decision a step may record. */
export function isWorkflowStepDecision(value: unknown): value is WorkflowStepDecision {
  return (WORKFLOW_STEP_DECISIONS as readonly string[]).includes(value as string);
}
