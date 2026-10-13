/**
 * Phase 54-F (§10.3, §10.4, §11, D10): the LEAVE POLICY VERSION lifecycle — the four states a
 * version can be in, and the transitions the frozen specification permits between them.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `domain/leave-status.ts` exists because "may this request be withdrawn?" is decided by two
 * strings and a rule that needs a container in order to be TESTED will not be tested. The same
 * argument applies to a policy version's lifecycle, and it is stronger here: publishing is the act
 * that puts rules IN FORCE, so the set of legal moves must be readable in one sitting rather than
 * discovered across a service, a DTO and a migration.
 *
 * WHY IT IMPORTS NOTHING
 * ----------------------
 * `hr-application-boundaries.spec.ts` asserts mechanically that every non-spec file under
 * `domain/` has zero import specifiers. This file obeys that rule rather than being an exception to
 * it, which is why the Prisma enum `LeavePolicyVersionStatus` is NOT imported: the domain states
 * what the DOMAIN means by a lifecycle state, and the application layer reconciles the two
 * spellings — exactly as `leave-status.ts` states `PENDING`/`CANCELLED` without importing the
 * Prisma enum that also carries them, and as `leave-policy.ts` states the counting bases without
 * importing the engine's `RuleCountingBasis`.
 *
 * THE FOUR STATES, AND WHY `ARCHIVED` EXISTS AT ALL
 * ------------------------------------------------
 * The frozen specification states the lifecycle in two places that agree (§10.3 and the §11
 * diagram):
 *
 *   DRAFT     — authored, not yet checked. Editable while it stays here.
 *   VALIDATED — passed validation (typed, conflict-free, no unknown fields). Still NOT the version
 *               new decisions use until published: the state records that the body was ACCEPTED,
 *               not that it was ADOPTED (§10.3).
 *   PUBLISHED — immutable; the version new evaluations resolve to (§10.3).
 *   ARCHIVED  — not selected for new evaluations; still resolvable for explanations and for
 *               historical references (§10.3).
 *
 * `ARCHIVED` is NOT a synonym for "published but its effective window has passed". The
 * specification is explicit that a superseded version is taken OUT of selection by the act of
 * publishing its successor — "Publishing a new version archives the previous one in the same act"
 * (§10.4) — while §11's diagram writes the whole lifecycle as
 * `PUBLISHED ──publish(next) / archive──▶ ARCHIVED` and adds "no path back to DRAFT/DELETE".
 *
 * SO TWO DIFFERENT FACTS ARE CARRIED BY TWO DIFFERENT COLUMNS, and collapsing them would lose one:
 *
 *   * `status` answers "is this version eligible to be SELECTED for a new evaluation?"
 *   * `effectiveFrom`/`effectiveTo` answer "on which days is it in force?" (§11: "effectiveFrom/
 *     effectiveTo decide which version applies *now*").
 *
 * A version that is PUBLISHED but whose window has ended is a configuration a tenant is still
 * allowed to state (a forward-dated successor is published before it becomes effective, and the
 * predecessor must keep governing until the boundary). It is SELECTABLE-if-matched and it simply
 * does not match the day being asked about. A version that is ARCHIVED was WITHDRAWN from
 * selection by a later publish, and no day makes it selectable again. Those are different
 * questions and this file keeps them apart.
 *
 * WHY THE TRANSITION TABLE IS DATA RATHER THAN A CHAIN OF `if`s
 * -----------------------------------------------------------
 * A chain of `if`s states the legal moves implicitly: the transitions it forgot are indistinguishable
 * from the transitions that are forbidden, and both look like "no code path does it". A table makes
 * the permitted moves exhaustively enumerable, so `isLeavePolicyVersionTransitionAllowed` answers
 * the question for EVERY pair — including the pairs nobody thought about — and a spec can assert the
 * table's contents rather than sampling cases.
 */

/**
 * The four lifecycle states, in the order the specification declares them (§10.3, §11).
 *
 * The ORDER MATTERS for exactly one reason: it is the order a UI renders the lifecycle in and the
 * order this file's own spec walks. It is NOT a numeric authority — nothing here compares states
 * with `<`, because "is `ARCHIVED` greater than `DRAFT`?" is not a question the specification
 * answers, and inventing an answer is how a lifecycle grows an accidental precedence rule.
 */
export const LEAVE_POLICY_VERSION_STATUSES = [
  'DRAFT',
  'VALIDATED',
  'PUBLISHED',
  'ARCHIVED',
] as const;

/** One lifecycle state. */
export type LeavePolicyVersionStatus = (typeof LEAVE_POLICY_VERSION_STATUSES)[number];

/** True for a value that is one of the four states — used to validate stored configuration. */
export function isLeavePolicyVersionStatus(value: unknown): value is LeavePolicyVersionStatus {
  return (
    typeof value === 'string' &&
    (LEAVE_POLICY_VERSION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Every legal transition, stated as data.
 *
 * WHY A TABLE AND NOT A CHAIN OF `if`s
 * ------------------------------------
 * See the file header: a chain of `if`s makes the transitions it FORGOT indistinguishable from the
 * transitions it FORBIDS — both are simply "no code path does it", and neither is reviewable. A
 * table lets `isLeavePolicyVersionTransitionAllowed` answer the question for every ORDERED PAIR of
 * the four states, including the twelve pairs nobody thought about, and lets a spec enumerate the
 * permitted set exactly rather than sampling a few cases.
 *
 * THE PERMITTED SET IS EXACTLY:
 *
 *   DRAFT     → VALIDATED   the check that accepts a well-formed body (§10.3)
 *   VALIDATED → PUBLISHED   the act that puts it in force (§10.4, §11)
 *   PUBLISHED → ARCHIVED    the successor's publish, which withdraws this one (§10.4, §11)
 *
 * AND EVERYTHING ELSE IS REFUSED, which is where the frozen specification's own prohibitions land:
 *
 *   * DRAFT → PUBLISHED is ABSENT because §11 writes the lifecycle as
 *     `DRAFT ──validate──▶ VALIDATED ──publish──▶ PUBLISHED`: publishing an unchecked version would
 *     skip the one gate that makes "publish is validated" true. `Validated` there is not decoration.
 *   * VALIDATED → ARCHIVED is ABSENT: a version that was never in force cannot be withdrawn from
 *     force, so archiving one would create an `ARCHIVED` row whose history reads as though it had
 *     governed something.
 *   * ARCHIVED → anything is ABSENT, and §11 says so twice: the diagram ends the archived branch
 *     with "no path back to DRAFT/DELETE". An archived version is evidence of what was in force;
 *     reviving it would rewrite what a historical evaluation resolved to (§10.5, §23).
 *   * Any `X → X` self-transition is ABSENT except where it is genuinely idempotent — and none of
 *     the four is, which is why the table also refuses it. Re-publishing a PUBLISHED version would
 *     have to either be a no-op (so the caller's intent had no effect) or a rewrite (which §10.2
 *     forbids outright: "the published one is never mutated").
 *
 * WHY THE TABLE IS KEYED BY STATE AND NOT BY `Set<string>`
 * ---------------------------------------------
 * `Readonly<Record<LeavePolicyVersionStatus, readonly LeavePolicyVersionStatus[]>>` makes the table
 * TOTAL BY TYPE: adding a fifth state to `LEAVE_POLICY_VERSION_STATUSES` fails to compile until its
 * row is stated here, so a new state cannot be added while silently inheriting "no transitions",
 * which is the shape a `Partial<Record<...>>` would have let through.
 */
export const LEAVE_POLICY_VERSION_TRANSITIONS: Readonly<
  Record<LeavePolicyVersionStatus, readonly LeavePolicyVersionStatus[]>
> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['PUBLISHED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Whether a version may move from `from` to `to`.
 *
 * RETURNS A BOOLEAN RATHER THAN THROWING, so the same function serves the service (which turns a
 * `false` into a 409 with a message naming both states) and a spec (which asserts the whole table at
 * once). A thrower would have to be caught to enumerate the refusals, which is how a spec ends up
 * testing only the happy path.
 *
 * AN UNKNOWN STATE IS NOT A REFUSAL — IT IS AN ABSENT ANSWER. `null` is returned when either
 * argument is not one of the four states, and that is deliberately NOT `false`: `false` means "this
 * move is forbidden by the lifecycle", while `null` means "there is no such state to move from or
 * to". A caller that collapsed the two would report a stored row carrying an unrecognized status as
 * "an illegal transition", which hides a data defect behind a lifecycle rule.
 */
export function isLeavePolicyVersionTransitionAllowed(from: unknown, to: unknown): boolean | null {
  if (!isLeavePolicyVersionStatus(from) || !isLeavePolicyVersionStatus(to)) {
    return null;
  }

  return LEAVE_POLICY_VERSION_TRANSITIONS[from].includes(to);
}
