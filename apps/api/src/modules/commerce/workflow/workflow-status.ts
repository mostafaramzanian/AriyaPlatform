/**
 * Phase C1 Step M (§5.5, §6, gate I20): the WORKFLOW VERSION lifecycle — the four states
 * a configuration version can be in, and the transitions the specification permits
 * between them — as PURE data and pure functions.
 *
 * WHY A PURE MODULE AND NOT CONSTANTS INSIDE THE SERVICE
 * -----------------------------------------------------
 * The vocabulary below is the same four strings `prisma/commerce/schema.prisma` declares
 * as `WorkflowDefinitionVersionStatus`, and three callers must agree on it: the DTO
 * validates against it (a 400 for an unknown status, never a database error), the service
 * decides whether a version's content may still change and whether a transition is legal,
 * and the wire projection states the status back. A rule re-typed in the service is how
 * "a DRAFT is editable" and "a VALIDATED version may not be edited" both end up true.
 *
 * `domain/leave-policy-version.ts` in HR is the DIRECT precedent, adopted deliberately
 * rather than paralleled: `commerce-schema.spec.ts` already asserts that the schema's
 * `WorkflowDefinitionVersionStatus` and HR's policy-version enum are the same four
 * members, and the schema's own note on this model says its version label was "taken from
 * the HR precedent deliberately: two owners must not drift on what a version is". A
 * lifecycle that agreed on the members but disagreed on the EDGES would drift in exactly
 * the place that note forbids.
 *
 * THIS FILE HAS NO DEPENDENCIES AT ALL — no NestJS, no Prisma, no generated client, no
 * clock — like `purchase-status.ts` beside it this module owns, and for the same reason:
 * `workflow-status.spec.ts` reads the Prisma schema as TEXT and fails if the two
 * spellings ever diverge, which no import could do, because the schema is not a module.
 */

/**
 * The four states of a version's lifecycle, in the schema's order (§5.5).
 *
 * DRAFT     — authored; the only state in which the version's content may be changed.
 * VALIDATED — passed the completeness check. Records that the body was ACCEPTED, not that
 *             it was ADOPTED: it is still not the version a purchase is routed by.
 * PUBLISHED — in force and IMMUTABLE. This is the state §5.9's pin can cite.
 * ARCHIVED  — withdrawn from selection by the publication of a successor; still readable,
 *             because it is the evidence of what governed a running purchase.
 *
 * `ARCHIVED` IS NOT "PUBLISHED BUT OUT OF DATE", and `PUBLISHED` is not "VALIDATED but
 * live" — the two are separate facts: a published version stays the version a running
 * purchase is pinned to until that purchase completes.
 */
export const WORKFLOW_VERSION_STATUSES = ['DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED'] as const;

export type WorkflowVersionStatus = (typeof WORKFLOW_VERSION_STATUSES)[number];

/**
 * Whether an arbitrary value — a row's status read from the database, a query filter, a
 * caller's argument — is one of the four states.
 *
 * WHY A GUARD IS EXPORTED AND NOT JUST THE TUPLE. `isWorkflowVersionTransitionAllowed`
 * below must tell "this move is forbidden" from "there is no such state", and only a
 * narrowing predicate can answer that without a cast. A service handed a stored status
 * outside the vocabulary has a data defect to report, not a lifecycle rule to apply, and
 * collapsing the two would hide the defect behind a 409.
 */
export function isWorkflowVersionStatus(value: unknown): value is WorkflowVersionStatus {
  return (WORKFLOW_VERSION_STATUSES as readonly unknown[]).includes(value);
}

/**
 * The statuses in which a version's CONTENT may still be changed — ONE member.
 *
 * WHY ONLY `DRAFT`, and why `VALIDATED` is deliberately excluded even though nothing
 * about it is immutable yet: the status RECORDS that a check was passed, and an edit made
 * after that check would silently discard the verdict the row is advertising — the version
 * would still read VALIDATED while no longer being validated. The alternative reading
 * ("VALIDATED is editable, and saving returns it to DRAFT") would need a backwards edge
 * the lifecycle does not have, and would make "the version was validated" true only until
 * somebody touched it. A change after validation is a NEW version, which is what §6
 * states: "Configuration changes create new immutable versions."
 *
 * The tuple exists so the rule has ONE definition: the service asks
 * `isWorkflowVersionEditable`, and the wire projection's `editable` flag is the same
 * function, so the flag a client renders can never disagree with the guard that refuses
 * its next step edit.
 */
export const WORKFLOW_VERSION_EDITABLE_STATUSES = ['DRAFT'] as const;

export type WorkflowVersionEditableStatus = (typeof WORKFLOW_VERSION_EDITABLE_STATUSES)[number];

/** Whether a version in this status may still have its configuration changed. */
export function isWorkflowVersionEditable(
  status: WorkflowVersionStatus
): status is WorkflowVersionEditableStatus {
  return (WORKFLOW_VERSION_EDITABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The permitted moves, as a TOTAL table over the four states.
 *
 * THE PERMITTED SET IS EXACTLY (matching the HR lifecycle member for member, and with
 * the edges §5.5's one-way door implies):
 *
 *   DRAFT     → VALIDATED   the check that accepts a complete configuration
 *   VALIDATED → PUBLISHED   the act that puts the configuration in force (§5.5)
 *   PUBLISHED → ARCHIVED    the withdrawal of a version that was in force
 *
 * AND EVERYTHING ELSE IS REFUSED, which is where the specification's own prohibitions
 * land:
 *
 *   * DRAFT → PUBLISHED is ABSENT: publishing an unchecked version would skip the one gate
 *     that makes "a published version is a validated version" true.
 *   * VALIDATED → ARCHIVED is ABSENT: a version that was never in force cannot be
 *     withdrawn from force, and an ARCHIVED row whose history read as though it had
 *     governed a purchase would be a false record.
 *   * ARCHIVED → anything is ABSENT: an archived version is the evidence of what governed
 *     a purchase under it, and reviving it would rewrite that history.
 *   * Any `X → X` self-transition is ABSENT: none of the four repeats idempotently — a
 *     second publish of a PUBLISHED version would have to be either a no-op (so the
 *     caller's intent had no effect) or a rewrite of a published version, which §5.5
 *     forbids outright.
 *
 * The table is keyed by state and NOT a `Set<string>` so that it is TOTAL BY TYPE: adding
 * a fifth member to `WORKFLOW_VERSION_STATUSES` fails to compile until its row is stated
 * here, instead of silently inheriting "no transitions".
 */
export const WORKFLOW_VERSION_TRANSITIONS: Readonly<
  Record<WorkflowVersionStatus, readonly WorkflowVersionStatus[]>
> = Object.freeze({
  DRAFT: Object.freeze(['VALIDATED'] as const),
  VALIDATED: Object.freeze(['PUBLISHED'] as const),
  PUBLISHED: Object.freeze(['ARCHIVED'] as const),
  ARCHIVED: Object.freeze([] as const),
});

/**
 * Whether a version may move from `from` to `to`.
 *
 * RETURNS A BOOLEAN RATHER THAN THROWING, so the same function serves the service (which
 * turns a `false` into a 409 naming both states) and a spec (which asserts the whole table
 * at once). A thrower would have to be caught to enumerate the refusals, which is how a
 * spec ends up testing only the happy path.
 *
 * AN UNKNOWN STATE IS NOT A REFUSAL — IT IS AN ABSENT ANSWER. `null` is returned when
 * either argument is not one of the four states, deliberately NOT `false`: `false` means
 * "the lifecycle forbids this move", while `null` means "there is no such state to move
 * from or to". A caller that collapsed the two would report a row carrying an
 * unrecognized status as "an illegal transition", hiding a data defect behind a rule.
 */
export function isWorkflowVersionTransitionAllowed(from: unknown, to: unknown): boolean | null {
  if (!isWorkflowVersionStatus(from) || !isWorkflowVersionStatus(to)) {
    return null;
  }

  return WORKFLOW_VERSION_TRANSITIONS[from].includes(to);
}

/**
 * The states a version must currently be in for `to` to be reachable — DERIVED from the
 * table above rather than stated a second time.
 *
 * WHY IT EXISTS: a refusal has to say what WOULD have been acceptable ("only a VALIDATED
 * version may be published; this version is DRAFT"), and a service that spelled
 * `'VALIDATED'` into its own message would be the second place the lifecycle is written
 * down. Reading the requirement off the table means the message cannot outlive the rule it
 * describes.
 */
export function workflowVersionSourcesFor(to: WorkflowVersionStatus): WorkflowVersionStatus[] {
  return WORKFLOW_VERSION_STATUSES.filter((from) =>
    WORKFLOW_VERSION_TRANSITIONS[from].includes(to)
  );
}
