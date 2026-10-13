import { coreGet, corePost } from './core-http';

/**
 * Phase 54-J (§2, §7, §8): the WEB CLIENT for the leave DECISION surface — `GET
 * /hr/leave-requests/:id/approval`, `POST :id/approve` and `POST :id/reject`.
 *
 * WHY THIS IS A SECOND FILE RATHER THAN MORE OF `hr-api.ts`
 * --------------------------------------------------------
 * `hr-api.ts` is the REGISTER: what was asked for, over which days, and whether it still stands.
 * A decision is a different act by a different grant on a different object — the live approval
 * INSTANCE — and `hr-api.ts` predates the decision routes entirely. Keeping the flow in its own
 * file is the same division the server keeps between `LeaveService` (the request) and
 * `LeaveApprovalService` (the flow), so this file reads as ONE contract: three routes, two of them
 * writes gated by `hr.leave.approve`.
 *
 * WHAT THE CLIENT SENDS, AND WHY IT IS ALMOST NOTHING (§2)
 * -------------------------------------------------------
 * The two bodies carry `reason` and nothing else. NO `tenantId`, NO `actorId`, NO `approverId`, NO
 * `employeeId`, NO `requestStatus`, NO `instanceStatus`, NO `stepStatus` and — the point of the A1
 * correction — NO `decidableByActor` and NO `undecidableReason`. The first group is identities and
 * states a caller must never choose (`ApproveLeaveRequestDto`'s header is explicit: the decider is
 * the ACTOR and the step is READ from the live flow), and the last two are SERVER-owned RESPONSE
 * facts. Sending them back would be a client handing the server a fact only the server computes,
 * which is exactly the second authorization model §8 forbids.
 *
 * WHAT THE CLIENT RECOMPUTES: NOTHING (§3, §5)
 * --------------------------------------------
 * `decidableByActor` arrives on the response and is rendered as it arrives. There is no employee-id
 * comparison here, no self-approval inference, no label parsing and no re-derivation of step or
 * instance state — `attachDecisionability` already ran the ONE shared predicate server-side, and
 * the POST routes re-run it before mutating, so the field is advisory presentation state and the
 * write remains the final authority. A screen that "calculated" its own answer would disagree with
 * the server that actually decides.
 */

// ---------------------------------------------------------------------------
// Vocabulary — the CLOSED lists the domain declares (§17 of the platform spec)
// ---------------------------------------------------------------------------

/**
 * Where ONE approval instance stands — exactly two members, mirroring
 * `LeaveApprovalInstanceStatus` on the server. Not widened to `string`: a value outside this union
 * is a contract defect, and a renderer asked to handle a fifth state would need a word for a state
 * the domain cannot produce.
 */
export type HrLeaveApprovalInstanceStatus = 'ACTIVE' | 'COMPLETED';

/**
 * Where ONE approval step stands — exactly six members, mirroring `LeaveApprovalStepStatus`.
 * The frozen §17 vocabulary; there is deliberately no `DELEGATED`, `ESCALATED` or `EXPIRED`.
 */
export type HrLeaveApprovalStepStatus =
  'PENDING' | 'ACTIVE' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'CANCELLED';

/** WHY a step's resolved approver is the person it is — `LeaveApprovalResolutionReason`. */
export type HrLeaveApprovalResolutionReason = 'PRIMARY' | 'SUBSTITUTE' | 'NO_RESOLUTION';

/**
 * Why the server reports `decidableByActor: false` — `LeaveApprovalUndecidableReason`, exactly the
 * two members A1 fixed. `null` is a THIRD, meaningful value: the flow has no step being asked (a
 * COMPLETED instance, or an empty one), which is already stated by `instance.status` rather than
 * by a reason (§7.3 — no refusal category the domain does not need).
 */
export type HrLeaveUndecidableReason = 'NOT_RESOLVED' | 'AWAITING_OTHER' | null;

/** The decision the live step records: `APPROVED` or `REJECTED`, or nothing has been decided. */
export type HrLeaveStepDecision = 'APPROVED' | 'REJECTED' | null;

// ---------------------------------------------------------------------------
// The response — ONE flat instance, and its steps as flat scalar rows
// ---------------------------------------------------------------------------

/**
 * One step row EXACTLY as `serializeInstance` spreads it: the sixteen scalar columns of
 * `LeaveApprovalStepInstance` and NOTHING else.
 *
 * THE ABSENCE OF THE TWO RELATION LABELS IS THE CONTRACT (§5). `findLiveInstance` does not include
 * `STEP_LABEL`, so `resolvedApproverEmployee` and `decidedByEmployee` are not on this read — which
 * is why this screen renders `resolvedApproverEmployeeId` / `decidedByEmployeeId` as the IDs they
 * are and invents no approver NAME. Adding an `include` would be a response widening needing
 * review, not a type this file may quietly assume.
 *
 * `tenantId`, `createdAt` and `updatedAt` are declared as OPTIONAL PRE-EXISTING pass-throughs (§6):
 * the row spread has always carried them, this phase neither broadens nor reinterprets them, and no
 * code in the web client may read, forward or authorize with them.
 */
export interface HrLeaveApprovalStep {
  id: string;
  approvalInstanceId: string;
  approvalStepDefinitionId: string;
  /** Position in the flow, 1-based; the ordered list the screen renders comes from it. */
  order: number;
  status: HrLeaveApprovalStepStatus;
  /** The person who was ASKED. Shown as an ID because this read carries no relation label. */
  resolvedApproverEmployeeId: string | null;
  resolutionReason: HrLeaveApprovalResolutionReason;
  /** The typed availability outcome that travelled WITH the resolution reason. */
  resolutionSignal: string | null;
  decision: HrLeaveStepDecision;
  decidedByEmployeeId: string | null;
  decisionReason: string | null;
  /** ISO instant, or `null` while the step is undecided — `null` is a state, not a gap. */
  decidedAt: string | null;
  /** The rule version in force when this step was routed (§17.5). */
  ruleVersionLabel: string | null;
  /** PRE-EXISTING pass-through from the row spread — never read, never sent (§6). */
  tenantId?: string;
  /** PRE-EXISTING pass-through — see above. */
  createdAt?: string;
  /** PRE-EXISTING pass-through — see above. */
  updatedAt?: string;
}

/**
 * The live approval INSTANCE as `GET :id/approval` returns it after A1's §5 strip.
 *
 * `tenantId`, `approvalDefinitionId`, `createdAt` and `updatedAt` are DELETED on the server, so
 * they are deliberately NOT members of this type: a screen that wrote `flow.tenantId` would not
 * compile, which is the type stating the strip rather than a comment claiming it. The `null`
 * return of the endpoint — an ungoverned request has no flow (§18.5) — is modelled by the return
 * type of `fetchLeaveApproval`, because `null` is the whole absence of this object rather than one
 * of its fields.
 */
export interface HrLeaveApprovalInstance {
  id: string;
  leaveRequestId: string;
  status: HrLeaveApprovalInstanceStatus;
  /** The snapshotted number of steps — a count, never a list length a client computed. */
  stepCount: number;
  /** The request's FIRST day, `YYYY-MM-DD`, as the serializer emits a `@db.Date` column. */
  requestStartDate: string;
  /** The request's LAST day, `YYYY-MM-DD`, inclusive. */
  requestEndDate: string;
  steps: HrLeaveApprovalStep[];
  /**
   * SERVER-owned advisory presentation state (A1 §7): may THIS actor decide the step currently
   * being asked? Computed from the same pure predicate the write path re-runs, so the UI may show
   * Approve/Reject when it is `true` and must withhold them when it is not — while the POST route
   * remains the final authority either way.
   */
  decidableByActor: boolean;
  /**
   * WHY the answer above is `false` — the two-word vocabulary, or `null` when there is no step
   * being asked at all. Rendered as the server's own sentence; never re-derived in the browser.
   */
  undecidableReason: HrLeaveUndecidableReason;
}

// ---------------------------------------------------------------------------
// The writes — the two bodies, and the calls that send them
// ---------------------------------------------------------------------------

/**
 * Body of `POST /hr/leave-requests/:id/approve`. ONE optional field, and the optionality is the
 * whole DTO: `reason` is a free-text note the approver MAY attach, so the caller may omit it
 * entirely or send it blank, and either way the step is approved.
 */
export interface ApproveLeaveRequestInput {
  /** Optional note recorded on the step. Omitted when undefined — never sent as `null`. */
  reason?: string;
}

/**
 * Body of `POST /hr/leave-requests/:id/reject`. `reason` is REQUIRED here and NON-BLANK, mirroring
 * `RejectLeaveRequestDto`: a rejection that says nothing leaves the requester with no ground to
 * appeal and no explanation to act on, so the field is mandatory in the type AND validated on the
 * server. The UI enforces non-blank before calling; the server enforces it again.
 */
export interface RejectLeaveRequestInput {
  /** Required, non-blank explanation for the rejection. */
  reason: string;
}

/**
 * Reads the live approval flow for one leave request — `GET /hr/leave-requests/:id/approval`,
 * gated on `hr.leave.read`.
 *
 * Resolves to `null` for an UNGOVERNED request: the server answers `null` when the tenant has no
 * applicable approval definition, and this function passes that absence through instead of turning
 * it into an empty instance. `null` and "an ACTIVE flow with zero steps" are different facts, and a
 * caller that collapsed them could not tell "no approval is required" from "approval exists but is
 * broken" — §18.5 keeps them apart.
 *
 * Read-only: nothing here mutates, and the returned `decidableByActor` is rendered as received.
 */
export async function fetchLeaveApproval(
  leaveRequestId: string
): Promise<HrLeaveApprovalInstance | null> {
  return coreGet<HrLeaveApprovalInstance | null>(
    `/hr/leave-requests/${encodeURIComponent(leaveRequestId)}/approval`
  );
}

/**
 * Approves the step the live flow is currently asking — `POST /hr/leave-requests/:id/approve`,
 * gated on `hr.leave.approve`.
 *
 * Sends AT MOST `reason`. The decider is the authenticated actor and the step is READ from the live
 * instance server-side, so there is nothing else a client could or should name: no approver id, no
 * step id, no instance status. Resolves to the UPDATED instance so the caller renders the server's
 * new truth rather than a locally guessed one.
 */
export async function approveLeaveRequest(
  leaveRequestId: string,
  input: ApproveLeaveRequestInput = {}
): Promise<HrLeaveApprovalInstance> {
  return corePost<HrLeaveApprovalInstance>(
    `/hr/leave-requests/${encodeURIComponent(leaveRequestId)}/approve`,
    input
  );
}

/**
 * Rejects the step the live flow is currently asking — `POST /hr/leave-requests/:id/reject`,
 * gated on `hr.leave.approve`.
 *
 * Sends `reason` and nothing else; the server rejects a blank one (`RejectLeaveRequestDto`), which
 * is why callers must collect a non-blank explanation before invoking this. Resolves to the UPDATED
 * instance.
 */
export async function rejectLeaveRequest(
  leaveRequestId: string,
  input: RejectLeaveRequestInput
): Promise<HrLeaveApprovalInstance> {
  return corePost<HrLeaveApprovalInstance>(
    `/hr/leave-requests/${encodeURIComponent(leaveRequestId)}/reject`,
    input
  );
}

// ---------------------------------------------------------------------------
// Persian presentation — the ONE place a status becomes words on this screen
// ---------------------------------------------------------------------------

/**
 * Total map from instance status to its Persian label, so the compiler reports a missing entry the
 * day the union grows. The label states the FLOW's position, not the request's: a COMPLETED flow
 * has finished its routing, which is not the same fact as the request being approved.
 */
const INSTANCE_STATUS_LABELS: Record<HrLeaveApprovalInstanceStatus, string> = {
  ACTIVE: 'در جریان',
  COMPLETED: 'پایانیافته',
};

/** Total map from step status to its Persian label — six members, no fallback branch. */
const STEP_STATUS_LABELS: Record<HrLeaveApprovalStepStatus, string> = {
  PENDING: 'در انتظار',
  ACTIVE: 'در نوبت تصمیم',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
  SKIPPED: 'عبورکرده',
  CANCELLED: 'لغوشده',
};

/** Total map from resolution reason to the Persian phrase naming WHY this approver was chosen. */
const RESOLUTION_REASON_LABELS: Record<HrLeaveApprovalResolutionReason, string> = {
  PRIMARY: 'جانشین اصلی',
  SUBSTITUTE: 'جانشین موقت',
  NO_RESOLUTION: 'بدون جانشین',
};

/**
 * The Persian sentence for the SERVER's refusal code — rendered verbatim, never re-derived. Both
 * members are stated as facts about the FLOW ("waiting for someone else"), not as accusations about
 * the reader, because `decidableByActor: false` also covers a plain permission gap.
 */
const UNDECIDABLE_REASON_LABELS: Record<'NOT_RESOLVED' | 'AWAITING_OTHER', string> = {
  NOT_RESOLVED: 'برای این مرحله تصمیمگیرندهای تعیین نشده است.',
  AWAITING_OTHER: 'این مرحله در نوبت تصمیم کاربر دیگری است.',
};

/** The Persian label for an instance status. */
export function leaveApprovalInstanceStatusLabel(status: HrLeaveApprovalInstanceStatus): string {
  return INSTANCE_STATUS_LABELS[status];
}

/** The Persian label for a step status. */
export function leaveApprovalStepStatusLabel(status: HrLeaveApprovalStepStatus): string {
  return STEP_STATUS_LABELS[status];
}

/** The Persian phrase for why a step's approver is who it is. */
export function leaveApprovalResolutionReasonLabel(
  reason: HrLeaveApprovalResolutionReason
): string {
  return RESOLUTION_REASON_LABELS[reason];
}

/**
 * The Persian sentence explaining `decidableByActor: false`. `null` means the server named no
 * refusal at all (no step is being asked), so the function returns `null` and the caller renders
 * its own state-based message instead of this vocabulary inventing a reason.
 */
export function leaveUndecidableReasonLabel(reason: HrLeaveUndecidableReason): string | null {
  return reason === null ? null : UNDECIDABLE_REASON_LABELS[reason];
}

/** The tone token the shared `HrBadge` understands — `HrTone`, kept structurally identical here so
 * this module stays free of a `components` import. */
export type HrLeaveApprovalTone = 'ok' | 'muted' | 'danger';

/** Tone for an instance status: a decision still to be made is the loud one. */
export function leaveApprovalInstanceStatusTone(
  status: HrLeaveApprovalInstanceStatus
): HrLeaveApprovalTone {
  return status === 'ACTIVE' ? 'ok' : 'muted';
}

/**
 * Tone for a step status, chosen for the DECISION each row records: approved is green, rejected and
 * cancelled are red, and the three states that record no decision are muted — nothing has happened
 * yet, so nothing should shout.
 */
export function leaveApprovalStepStatusTone(
  status: HrLeaveApprovalStepStatus
): HrLeaveApprovalTone {
  switch (status) {
    case 'APPROVED':
      return 'ok';
    case 'REJECTED':
    case 'CANCELLED':
      return 'danger';
    case 'PENDING':
    case 'ACTIVE':
    case 'SKIPPED':
      return 'muted';
  }
}
