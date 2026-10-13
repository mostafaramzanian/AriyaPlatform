/**
 * Phase C1 Step P (§3-D/§3-E, P4, P6, P11, P12): the commercial slice's OWN
 * vocabularies — as VALUES and pure functions, exactly the way
 * `purchase-status.ts` states the purchase lifecycle and `workflow-run-status.ts`
 * states the runtime's.
 *
 * WHY A PURE MODULE AND NOT CONSTANTS INSIDE A SERVICE
 * ---------------------------------------------------
 * Five different readers must agree on each list below: the DTO validates against it
 * (a 400 for an invented value, never a database error), the service decides whether an
 * act is legal, the pure planner interprets the engine's outcome against it, the schema
 * declares the matching `enum`, and a spec pins all of them together. A list re-typed
 * inside a service is how "activation NOT_REQUIRED never creates a record" and
 * "activation NOT_REQUIRED is a valid value" end up disagreeing.
 *
 * NOTHING HERE MAY GROW WITHOUT THE CONTRACT (§3-E, "recorded here before coding").
 * Every tuple below is CLOSED: it mirrors an enum in `prisma/commerce/schema.prisma`,
 * and `commercial-status.spec.ts` reads that schema as TEXT and fails when the two
 * drift apart — no import can do that, because the schema is not a module.
 *
 * THIS FILE HAS NO DEPENDENCIES AT ALL. No NestJS, no Prisma, no repository, no
 * gateway, no clock — which is what lets every rule here be tested exhaustively.
 * `WORKFLOW_VERSION_STATUSES` is the one value it borrows, because the commercial
 * configuration version REUSES the established Aria version lifecycle (§6) rather than
 * declaring a second one.
 */

import { WORKFLOW_VERSION_STATUSES } from '../workflow/workflow-status';
import type { WorkflowVersionStatus } from '../workflow/workflow-status';

/**
 * The state of the CURRENT assignment row (§3-C, P5/P6).
 *
 * `UNASSIGNED` is the explicit `LEAVE_UNASSIGNED` outcome: the line is identifiable as
 * unassigned BY STATE, never by an absent row and never by a silent null (P6).
 */
export const COMMERCIAL_ASSIGNMENT_STATES = ['ASSIGNED', 'UNASSIGNED'] as const;

export type CommercialAssignmentState = (typeof COMMERCIAL_ASSIGNMENT_STATES)[number];

/** True when `value` is a state this database may store. */
export function isCommercialAssignmentState(value: unknown): value is CommercialAssignmentState {
  return (
    typeof value === 'string' && (COMMERCIAL_ASSIGNMENT_STATES as readonly string[]).includes(value)
  );
}

/**
 * Provenance of the current row (§3-E, P4).
 *
 * The first two members ARE `WorkflowTriggerEvent` values — timing comes from the
 * existing closed event vocabulary and never from an invented one. `MANUAL` names the
 * explicit API operation (§3-H), not a trigger event, which is precisely why it is NOT
 * a member of `WorkflowTriggerEvent` and must not be offered as a configuration choice.
 *
 * `commercial-status.spec.ts` asserts the first two equal `WORKFLOW_TRIGGER_EVENTS`
 * exactly, so a new runtime event cannot appear here first.
 */
export const COMMERCIAL_ASSIGNMENT_TRIGGERS = [
  'PURCHASE_SUBMITTED',
  'AFTER_DOCUMENT_WORKFLOW_APPROVED',
] as const;

export type CommercialAssignmentTrigger = (typeof COMMERCIAL_ASSIGNMENT_TRIGGERS)[number];

/** Provenance of a stored assignment row: a trigger, or the manual operation. */
export const COMMERCIAL_ASSIGNMENT_SOURCES = [...COMMERCIAL_ASSIGNMENT_TRIGGERS, 'MANUAL'] as const;

export type CommercialAssignmentSource = (typeof COMMERCIAL_ASSIGNMENT_SOURCES)[number];

export function isCommercialAssignmentTrigger(
  value: unknown
): value is CommercialAssignmentTrigger {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_ASSIGNMENT_TRIGGERS as readonly string[]).includes(value)
  );
}

export function isCommercialAssignmentSource(value: unknown): value is CommercialAssignmentSource {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_ASSIGNMENT_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * The commercial approval lifecycle (§3-E, P12) — its OWN state, never aliased to
 * `WorkflowStepInstance.decision`. The decision is terminal in P: a correction flow
 * that re-activates a rejected record needs a re-activation model P does not have (§11).
 */
export const COMMERCIAL_APPROVAL_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export type CommercialApprovalState = (typeof COMMERCIAL_APPROVAL_STATES)[number];

/** The only decision vocabulary — `Extract` keeps it from drifting from the states. */
export const COMMERCIAL_APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;

export type CommercialApprovalDecision = Extract<CommercialApprovalState, 'APPROVED' | 'REJECTED'>;

export function isCommercialApprovalDecision(value: unknown): value is CommercialApprovalDecision {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_APPROVAL_DECISIONS as readonly string[]).includes(value)
  );
}

/** True when the record still owes a decision — the only state a decision may be written from. */
export function isCommercialApprovalPending(status: unknown): boolean {
  return status === 'PENDING';
}

/**
 * WHEN commercial approval activates (§3-E, P12, P4).
 *
 * `NOT_REQUIRED` is this step's closed member; the other two are the existing
 * `WorkflowTriggerEvent` values, so activation timing can never name an event the
 * runtime does not have.
 */
export const COMMERCIAL_APPROVAL_ACTIVATIONS = [
  'NOT_REQUIRED',
  ...COMMERCIAL_ASSIGNMENT_TRIGGERS,
] as const;

export type CommercialApprovalActivation = (typeof COMMERCIAL_APPROVAL_ACTIVATIONS)[number];

export function isCommercialApprovalActivation(
  value: unknown
): value is CommercialApprovalActivation {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_APPROVAL_ACTIVATIONS as readonly string[]).includes(value)
  );
}

/**
 * HOW an approver resolves (§3-E, P10) — closed at the two EXECUTABLE resolutions.
 *
 * `REQUESTER_MANAGER` and `GROUP_MANAGER` are deliberately absent: no platform contract
 * makes them executable, and §7.7 refuses an unsupported resolver rather than
 * substituting one (§11 records that as a deferred item).
 */
export const COMMERCIAL_APPROVAL_APPROVERS = [
  'LINE_COMMERCIAL_LIAISON',
  'CONFIGURED_USER',
] as const;

export type CommercialApprovalApprover = (typeof COMMERCIAL_APPROVAL_APPROVERS)[number];

export function isCommercialApprovalApprover(value: unknown): value is CommercialApprovalApprover {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_APPROVAL_APPROVERS as readonly string[]).includes(value)
  );
}

/**
 * The configured `PurchaseDocument` projection policy (§3-F, P11).
 *
 * The VOCABULARY (`DRAFT…CLOSED`) is architectural and is NOT configurable: this policy
 * decides when `SUBMITTED → APPROVED` is written. No member writes `CLOSED` — §3-F's
 * "APPROVED never becomes CLOSED automatically" is a property of the closed set, not of
 * a comment.
 */
export const COMMERCIAL_PROJECTION_POLICIES = [
  'DOCUMENT_WORKFLOW',
  'ALL_LINES',
  'DOCUMENT_WORKFLOW_AND_COMMERCIAL',
  'ALL_LINES_AND_COMMERCIAL',
] as const;

export type CommercialProjectionPolicy = (typeof COMMERCIAL_PROJECTION_POLICIES)[number];

export function isCommercialProjectionPolicy(value: unknown): value is CommercialProjectionPolicy {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_PROJECTION_POLICIES as readonly string[]).includes(value)
  );
}

/**
 * What a line with NO matching rule becomes (§3-D, P6) — same vocabulary shape as O's
 * no-route behaviour, so the two configured edge cases read the same way.
 */
export const COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS = ['REJECT_OPERATION', 'LEAVE_UNASSIGNED'] as const;

export type CommercialNoAssignmentBehavior = (typeof COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)[number];

export function isCommercialNoAssignmentBehavior(
  value: unknown
): value is CommercialNoAssignmentBehavior {
  return (
    typeof value === 'string' &&
    (COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS as readonly string[]).includes(value)
  );
}

/** How a line matching MORE THAN ONE assignment rule resolves (§3-D). */
export const COMMERCIAL_MATCH_BEHAVIORS = ['HIGHEST_PRIORITY', 'AMBIGUOUS_ERROR'] as const;

export type CommercialMatchBehavior = (typeof COMMERCIAL_MATCH_BEHAVIORS)[number];

export function isCommercialMatchBehavior(value: unknown): value is CommercialMatchBehavior {
  return (
    typeof value === 'string' && (COMMERCIAL_MATCH_BEHAVIORS as readonly string[]).includes(value)
  );
}

/**
 * The version lifecycle the commercial configuration version REUSES (§6): the
 * established Aria `DRAFT → VALIDATED → PUBLISHED → ARCHIVED`. Re-exported rather than
 * re-declared — a second tuple would be a second answer to "what may a version be".
 */
export const COMMERCIAL_CONFIGURATION_STATUSES = WORKFLOW_VERSION_STATUSES;

export type CommercialConfigurationStatus = WorkflowVersionStatus;

/**
 * The document states in which MANUAL assignment is refused (§3-H) — the terminal
 * commercial states. `DRAFT`, `SUBMITTED` and `APPROVED` remain assignable, because a
 * document still in play may have its commercial responsibility corrected.
 */
export const COMMERCIAL_MANUAL_ASSIGNMENT_FORBIDDEN_DOCUMENT_STATUSES = [
  'REJECTED',
  'CANCELLED',
  'CLOSED',
] as const;

export function isCommercialManualAssignmentForbidden(status: string): boolean {
  return (COMMERCIAL_MANUAL_ASSIGNMENT_FORBIDDEN_DOCUMENT_STATUSES as readonly string[]).includes(
    status
  );
}
