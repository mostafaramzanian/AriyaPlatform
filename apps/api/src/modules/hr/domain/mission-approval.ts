/**
 * Phase 55: Mission approval step/instance vocabulary, decisionability,
 * routing and immutability rules.
 *
 * WHY NO IMPORTS
 * --------------
 * Routing is a pure function of step statuses and decisions. Keeping it
 * dependency-free lets it be unit-tested without a database or Nest container.
 *
 * SEQUENTIAL vs PARALLEL
 * ----------------------
 * `MissionRoutingMode` is configured on `MissionApprovalDefinition`. The routing
 * functions below are the only place that spelling lives, so a service cannot
 * silently treat a parallel flow as sequential.
 *
 * NO GENERIC WORKFLOW ENGINE
 * --------------------------
 * The functions below answer concrete Mission questions only. They do not
 * implement arbitrary state machines, step definitions, or approval patterns.
 */

/** Where one Mission approval STEP stands. */
export type MissionApprovalStepStatus =
  'PENDING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUIRED' | 'SKIPPED' | 'CANCELLED';

export const MISSION_APPROVAL_STEP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'APPROVED',
  'REJECTED',
  'CORRECTION_REQUIRED',
  'SKIPPED',
  'CANCELLED',
] as const;

/** Where one Mission approval INSTANCE stands. */
export type MissionApprovalInstanceStatus =
  'ACTIVE' | 'COMPLETED' | 'SUPERSEDED' | 'CORRECTION_REQUIRED' | 'REJECTED';

export const MISSION_APPROVAL_INSTANCE_STATUSES = [
  'ACTIVE',
  'COMPLETED',
  'SUPERSEDED',
  'CORRECTION_REQUIRED',
  'REJECTED',
] as const;

/** The decision a step may receive. */
export type MissionApprovalStepDecision = 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUIRED';

export const MISSION_APPROVAL_STEP_DECISIONS = [
  'APPROVED',
  'REJECTED',
  'CORRECTION_REQUIRED',
] as const;

/** How an approval definition routes its steps. */
export type MissionRoutingMode = 'SEQUENTIAL' | 'PARALLEL';

export const MISSION_ROUTING_MODES = ['SEQUENTIAL', 'PARALLEL'] as const;

/** The only parallel completion mode supported. */
export type MissionParallelCompletionMode = 'ALL_REQUIRED';

export const MISSION_PARALLEL_COMPLETION_MODE: MissionParallelCompletionMode = 'ALL_REQUIRED';

/** Whether a requester may approve their own mission. */
export type MissionSelfApprovalMode = 'NOT_ALLOWED' | 'ALLOWED';

export const MISSION_SELF_APPROVAL_MODES = ['NOT_ALLOWED', 'ALLOWED'] as const;

/** Why a resolved approver is the person it is. */
export type MissionApprovalResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';

export const MISSION_APPROVAL_RESOLUTION_REASONS = [
  'PRIMARY',
  'SUBSTITUTE',
  'NO_RESOLUTION',
] as const;

export type MissionRequestStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_APPROVAL'
  | 'CORRECTION_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export function isMissionApprovalStepStatus(value: unknown): value is MissionApprovalStepStatus {
  return (
    typeof value === 'string' &&
    (MISSION_APPROVAL_STEP_STATUSES as readonly string[]).includes(value)
  );
}

export function isMissionApprovalInstanceStatus(
  value: unknown
): value is MissionApprovalInstanceStatus {
  return (
    typeof value === 'string' &&
    (MISSION_APPROVAL_INSTANCE_STATUSES as readonly string[]).includes(value)
  );
}

export function isMissionApprovalStepDecision(
  value: unknown
): value is MissionApprovalStepDecision {
  return (
    typeof value === 'string' &&
    (MISSION_APPROVAL_STEP_DECISIONS as readonly string[]).includes(value)
  );
}

export function isMissionRoutingMode(value: unknown): value is MissionRoutingMode {
  return typeof value === 'string' && (MISSION_ROUTING_MODES as readonly string[]).includes(value);
}

export function isMissionSelfApprovalMode(value: unknown): value is MissionSelfApprovalMode {
  return (
    typeof value === 'string' && (MISSION_SELF_APPROVAL_MODES as readonly string[]).includes(value)
  );
}

export function isMissionApprovalResolutionReason(
  value: unknown
): value is MissionApprovalResolutionReason {
  return (
    typeof value === 'string' &&
    (MISSION_APPROVAL_RESOLUTION_REASONS as readonly string[]).includes(value)
  );
}

/** Only an ACTIVE step may be decided. */
export function isDecidableMissionApprovalStepStatus(status: MissionApprovalStepStatus): boolean {
  return status === 'ACTIVE';
}

export type MissionApprovalUndecidableReason =
  'NOT_RESOLVED' | 'AWAITING_OTHER' | 'SELF_APPROVAL_NOT_ALLOWED';

export type MissionApprovalDecisionabilityResult =
  | { readonly decidableByActor: true; readonly undecidableReason: null }
  | {
      readonly decidableByActor: false;
      readonly undecidableReason: MissionApprovalUndecidableReason | null;
    };

/**
 * Pure decisionability predicate.
 *
 * `resolvedApproverEmployeeId` is the person the step was resolved to, whether
 * PRIMARY or SUBSTITUTE. `requesterEmployeeId` is the employee who submitted the
 * mission; self-approval is permitted only when `selfApprovalMode` is ALLOWED.
 */
export function resolveMissionApprovalDecisionability(input: {
  deciderEmployeeId: string | null;
  resolvedApproverEmployeeId: string | null;
  requesterEmployeeId: string | null;
  selfApprovalMode: MissionSelfApprovalMode;
}): MissionApprovalDecisionabilityResult {
  if (!input.resolvedApproverEmployeeId) {
    return { decidableByActor: false, undecidableReason: 'NOT_RESOLVED' };
  }

  if (input.deciderEmployeeId !== input.resolvedApproverEmployeeId) {
    return { decidableByActor: false, undecidableReason: 'AWAITING_OTHER' };
  }

  if (
    input.requesterEmployeeId !== null &&
    input.deciderEmployeeId === input.requesterEmployeeId &&
    input.selfApprovalMode !== 'ALLOWED'
  ) {
    return { decidableByActor: false, undecidableReason: 'SELF_APPROVAL_NOT_ALLOWED' };
  }

  return { decidableByActor: true, undecidableReason: null };
}

/** Combines step-status and decisionability. */
export function mayDecideMissionApprovalStep(input: {
  deciderEmployeeId: string | null;
  resolvedApproverEmployeeId: string | null;
  requesterEmployeeId: string | null;
  selfApprovalMode: MissionSelfApprovalMode;
  stepStatus: MissionApprovalStepStatus;
}): MissionApprovalDecisionabilityResult {
  if (!isDecidableMissionApprovalStepStatus(input.stepStatus)) {
    return { decidableByActor: false, undecidableReason: null };
  }
  return resolveMissionApprovalDecisionability(input);
}

export type MissionSequentialRoutingResult = {
  readonly stepStatus: MissionApprovalStepStatus;
  readonly requestStatus: MissionRequestStatus;
  readonly instanceStatus: MissionApprovalInstanceStatus;
  readonly nextStepOrder: number | null;
  readonly cascade: 'SKIPPED' | 'CANCELLED' | null;
};

/**
 * Compute the effect of one decision in a SEQUENTIAL flow.
 *
 * APPROVE + last step  -> request APPROVED, instance COMPLETED.
 * APPROVE + not last   -> request IN_APPROVAL, instance ACTIVE, next step activated.
 * REJECT               -> request REJECTED, instance REJECTED, later steps SKIPPED.
 * CORRECTION_REQUIRED  -> request CORRECTION_REQUIRED, instance CORRECTION_REQUIRED.
 */
export function resolveSequentialRouting(input: {
  decision: MissionApprovalStepDecision;
  order: number;
  stepCount: number;
  hasNextStep: boolean;
}): MissionSequentialRoutingResult {
  const isLastStep = !input.hasNextStep || input.order >= input.stepCount - 1;

  if (input.decision === 'REJECTED') {
    return {
      stepStatus: 'REJECTED',
      requestStatus: 'REJECTED',
      instanceStatus: 'REJECTED',
      nextStepOrder: null,
      cascade: 'SKIPPED',
    };
  }

  if (input.decision === 'CORRECTION_REQUIRED') {
    return {
      stepStatus: 'CORRECTION_REQUIRED',
      requestStatus: 'CORRECTION_REQUIRED',
      instanceStatus: 'CORRECTION_REQUIRED',
      nextStepOrder: null,
      cascade: null,
    };
  }

  if (isLastStep) {
    return {
      stepStatus: 'APPROVED',
      requestStatus: 'APPROVED',
      instanceStatus: 'COMPLETED',
      nextStepOrder: null,
      cascade: null,
    };
  }

  return {
    stepStatus: 'APPROVED',
    requestStatus: 'IN_APPROVAL',
    instanceStatus: 'ACTIVE',
    nextStepOrder: input.order + 1,
    cascade: null,
  };
}

export type MissionStepState = {
  readonly order: number;
  readonly status: MissionApprovalStepStatus;
  readonly required: boolean;
};

export type MissionParallelOutcome = {
  readonly requestStatus: MissionRequestStatus;
  readonly instanceStatus: MissionApprovalInstanceStatus;
};

/**
 * Compute the overall parallel flow outcome from the current step states.
 *
 * ALL_REQUIRED semantics:
 *   - any REJECTED step  -> REJECTED
 *   - any CORRECTION_REQUIRED step -> CORRECTION_REQUIRED
 *   - every REQUIRED step APPROVED and no unresolved required steps -> APPROVED
 *   - otherwise -> IN_APPROVAL / ACTIVE
 */
export function resolveParallelOutcome(
  stepStates: readonly MissionStepState[]
): MissionParallelOutcome {
  const hasRejected = stepStates.some((s) => s.status === 'REJECTED');
  if (hasRejected) {
    return { requestStatus: 'REJECTED', instanceStatus: 'REJECTED' };
  }

  const hasCorrection = stepStates.some((s) => s.status === 'CORRECTION_REQUIRED');
  if (hasCorrection) {
    return { requestStatus: 'CORRECTION_REQUIRED', instanceStatus: 'CORRECTION_REQUIRED' };
  }

  const requiredSteps = stepStates.filter((s) => s.required);
  const allRequiredApproved = requiredSteps.every((s) => s.status === 'APPROVED');

  if (allRequiredApproved) {
    return { requestStatus: 'APPROVED', instanceStatus: 'COMPLETED' };
  }

  return { requestStatus: 'IN_APPROVAL', instanceStatus: 'ACTIVE' };
}

/** True when an instance is no longer `ACTIVE` (history, not the current flow). */
export function isMissionApprovalInstanceHistorical(
  status: MissionApprovalInstanceStatus
): boolean {
  return status !== 'ACTIVE';
}

/** Resubmission creates a new instance; the previous one remains historical. */
export function resubmissionCreatesNewMissionApprovalInstance(): true {
  return true;
}

/** Whether a step at `order` may be activated in a sequential flow. */
export function mayActivateSequentialStep(input: {
  order: number;
  activeOrder: number | null;
  pendingOrders: readonly number[];
}): boolean {
  if (input.activeOrder === null) {
    const lowestPending = [...input.pendingOrders].sort((a, b) => a - b)[0];
    return lowestPending === input.order;
  }
  return input.order === input.activeOrder + 1;
}
