/**
 * Phase 54-E (§19, §20): the APPROVER-AVAILABILITY vocabulary — the closed set of signals a
 * policy may name, and the three that are REFUSED — plus the self-approval rule.
 *
 * WHY THE SET IS CLOSED, AND WHY THAT IS A DATABASE FACT AND NOT A CONVENTION
 * -------------------------------------------------------------------------
 * §20 freezes the availability tokens precisely so that an explanation rendered from an old
 * step row stays TRUE. If a signal could be invented at publish time, a historical step could
 * cite a signal that no longer means anything, and the row would read as though it had been
 * decided for a reason nobody can state any more. The vocabulary is therefore a constant that
 * the migration's CHECK, the publish validation and the resolver ALL press on.
 *
 * WHY THE THREE REFUSED SIGNALS ARE NAMED HERE RATHER THAN OMITTED
 * ---------------------------------------------------------------
 * A signal that is merely absent from the usable list produces the message "unknown signal",
 * which is the SAME message a typo produces. Naming the three refusals lets the refusal say
 * WHAT was refused and WHY, which is the difference between an author fixing their policy and
 * an author guessing. Each one is refused for a stated architectural reason, not for taste.
 *
 * WHY THIS FILE HAS NO IMPORTS: same rule as `leave-approval-status.ts`.
 */

/**
 * The SIX usable availability signals — the complete list, and the only list (§20).
 *
 *   NO_LINKED_USER      — the configured approver has no Core login (`Employee.userId` is
 *                         null). Knowable from `hr_db` alone.
 *   NOT_TENANT_MEMBER   — the approver's linked login is not a member of this tenant. Read
 *                         through `HrIdentityGateway` (§19/§20), never by HR touching Core.
 *   EMPLOYEE_INACTIVE   — the approver's own HR record is not `ACTIVE`.
 *   NOT_EMPLOYED_ON_DATE— no employment interval of the approver covers the requested range.
 *   ACTIVE_SUBSTITUTION — an effective, exclusive substitution names this approver as its
 *                         primary for the requested date.
 *   ON_APPROVED_LEAVE   — the approver has an APPROVED leave request covering the range. This
 *                         signal is only answerable because 54-E ADDS the APPROVED state; it
 *                         could not have been evaluated before, which is why it is part of this
 *                         phase rather than a later one.
 *
 * `NOT_EMPLOYED_ON_DATE` is a DATE-bounded fact and `ON_APPROVED_LEAVE` is a RANGE-covering
 * fact: both are evaluated against the REQUESTED RANGE, which is why the instance snapshots
 * that range at routing time (§17) — an explanation must cite the days it actually asked about.
 */
export const LEAVE_APPROVER_AVAILABILITY_SIGNALS = [
  'NO_LINKED_USER',
  'NOT_TENANT_MEMBER',
  'EMPLOYEE_INACTIVE',
  'NOT_EMPLOYED_ON_DATE',
  'ACTIVE_SUBSTITUTION',
  'ON_APPROVED_LEAVE',
] as const;

export type LeaveApproverAvailabilitySignal = (typeof LEAVE_APPROVER_AVAILABILITY_SIGNALS)[number];

/**
 * The availability signals REFUSED by this phase, each with the reason it is refused.
 *
 * A RECORD RATHER THAN A BARE LIST, so the refusal message can state the reason: an author who
 * named one of these gets an explanation, not a generic "invalid".
 *
 *   INACTIVE_USER        — requires answering "is this LOGIN disabled?" from the Core identity
 *                          directory. HR's `USER_DIRECTORY` projection does not expose a
 *                          disabled flag, and widening that projection to invent one would let
 *                          HR read Core account state it has no business deciding with.
 *                          `EMPLOYEE_INACTIVE` already covers the HR-side fact honestly.
 *   STANDALONE_DELEGATION— a delegation with no primary. Availability asks "may the PRIMARY be
 *                          used, or must the SUBSTITUTE?", which presupposes a primary; a
 *                          standalone delegate is a routing model, not an availability signal,
 *                          and admitting it here would make the substitution table two
 *                          different things at once.
 *   MANUAL_AVAILABILITY  — "somebody decided the approver is unavailable today" with no
 *                          recorded fact behind it. A manual flag is exactly how an
 *                          explanation stops being reproducible: two readers of the same old
 *                          step would disagree about what was true, because the only record is
 *                          a person's assertion.
 */
export const REFUSED_LEAVE_APPROVER_AVAILABILITY_SIGNALS = {
  INACTIVE_USER:
    'INACTIVE_USER needs a disabled-login fact the HR identity projection does not expose; EMPLOYEE_INACTIVE covers the HR-side fact instead.',
  STANDALONE_DELEGATION:
    'STANDALONE_DELEGATION names a delegation without a primary, which is a routing model rather than an availability signal.',
  MANUAL_AVAILABILITY:
    'MANUAL_AVAILABILITY is an unbacked assertion, so an explanation citing it is not reproducible.',
} as const;

/** The refusals above, as a list — for the publish validator and the tests. */
export const REFUSED_LEAVE_APPROVER_AVAILABILITY_SIGNAL_LIST = [
  'INACTIVE_USER',
  'STANDALONE_DELEGATION',
  'MANUAL_AVAILABILITY',
] as const;

/**
 * Why a signal name is not usable, or `null` when it is. THE one answer to "may a policy name
 * this?" — used by the publish validator, not by the runtime resolver.
 *
 * A KNOWN-BUT-REFUSED SIGNAL IS DISTINGUISHED FROM AN UNKNOWN ONE, deliberately. Both are
 * refused, but only the first has a reason worth stating to the author, and collapsing them
 * would make a typo indistinguishable from a considered refusal in the response.
 */
export function explainUnusableAvailabilitySignal(name: string): string | null {
  if ((LEAVE_APPROVER_AVAILABILITY_SIGNALS as readonly string[]).includes(name)) {
    return null;
  }

  const refusal =
    REFUSED_LEAVE_APPROVER_AVAILABILITY_SIGNALS[
      name as keyof typeof REFUSED_LEAVE_APPROVER_AVAILABILITY_SIGNALS
    ];

  if (refusal) {
    return `${name} is refused: ${refusal}`;
  }

  return `"${name}" is not an availability signal; the vocabulary is closed and contains exactly: ${LEAVE_APPROVER_AVAILABILITY_SIGNALS.join(', ')}.`;
}

/** True for a value that is one of the six usable signals. */
export function isLeaveApproverAvailabilitySignal(
  value: unknown
): value is LeaveApproverAvailabilitySignal {
  return (
    typeof value === 'string' &&
    (LEAVE_APPROVER_AVAILABILITY_SIGNALS as readonly string[]).includes(value)
  );
}

/**
 * SELF-APPROVAL — the rule, and the absence of a default (§19.6). NO GLOBAL FLAG EXISTS.
 *
 * WHAT §19 ACTUALLY FREEZES
 * -------------------------
 * "the primary/substitute may not be resolved to the requester UNLESS THE POLICY STATES IT".
 * That sentence is a rule about a POLICY FIELD, not a platform preference, and this constant
 * reflects it exactly: an instance is resolvable to its own requester only when the configured
 * policy literally says so. There is deliberately NO `DEFAULT_LEAVE_SELF_APPROVAL` exported
 * from this file — and none anywhere else — because a platform-wide default would silently
 * choose a side:
 *
 *   * defaulting to ALLOW is the dangerous direction: a tenant that never thought about
 *     self-approval would get a flow in which the requester decides their own leave, and
 *     nothing in their configuration said so;
 *   * defaulting to DENY would be a PRODUCT policy — an invented rule — which is the same
 *     class of fabrication as seeding a default leave policy nobody approved (§15.8).
 *
 * SO THE ABSENCE OF AN EXPLICIT STATEMENT IS NON-RESOLVABLE, NOT "ALLOWED" AND NOT "DENIED AS A
 * PRODUCT RULE". The requester is simply not eligible to be the resolved approver, which means
 * the step becomes `NO_RESOLUTION` and BLOCKS. Blocking is the honest rendering of "nobody
 * stated who should decide this": it asks a human to state a policy, rather than quietly
 * approving or quietly refusing somebody's leave.
 */
export const LEAVE_SELF_APPROVAL_REQUIRES_EXPLICIT_POLICY = true;

/**
 * Whether the requester may become their own resolved approver, given what the policy states.
 *
 * `policyPermitsSelfApproval` is the CONFIGURED value — `LeaveApprovalStepDefinition
 * .allow_self_approval` — and is passed in explicitly so that a caller cannot reach "allowed"
 * by forgetting to say anything. `null` and `undefined` are ABSENT, not `false`: both are
 * treated as "the policy did not state it" and therefore as non-resolvable, which is the same
 * answer §19.6 gives.
 *
 * This is a pure two-input function on purpose. The rule is testable without a database, a
 * container or a request, which is what makes it a rule rather than a hope.
 */
export function mayResolveToRequester(
  policyPermitsSelfApproval: boolean | null | undefined
): boolean {
  return policyPermitsSelfApproval === true;
}
