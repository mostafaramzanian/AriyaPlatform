/**
 * Phase C1 Step S (contract S-D2, §4-A): the return lifecycle's TWO rules and
 * nothing else — the transition MATRIX and the read-time PROJECTION. The
 * `payment-status.ts` / `receiving-status.ts` precedent, applied to a history
 * rather than to a sum.
 *
 * WHY THIS FILE IS PURE, AND STAYS THAT WAY
 * ------------------------------------------
 * No Prisma, no HTTP, no Nest imports, no clock, no side effects: it takes
 * immutable transition rows and answers. That is what makes the matrix
 * exhaustively testable (every one of the 5×5 pairs is one assertion) and what
 * keeps "which transitions are legal" from being re-typed in a service where a
 * typo would silently authorise a path the contract forbids. There is no
 * SECOND rule engine anywhere in the slice: commands ask `canTransition`, the
 * view asks `projectReturnState`, and both read the same frozen table.
 *
 * THE MATRIX (S-D2) — these four paths, and ONLY these:
 *
 *     REQUESTED     -> APPROVED
 *     REQUESTED     -> REJECTED
 *     APPROVED      -> RECEIVED_BACK
 *     RECEIVED_BACK -> REFUNDED
 *
 * `REJECTED` and `REFUNDED` are TERMINAL: no path out, no reverse path, no
 * correction transition (S-D4 — C1-S has no undo). Every state has exactly one
 * incoming edge, which is why the stored `state` alone names the command that
 * produced a row and no redundant command column exists (contract §6).
 *
 * THE PROJECTION (§4-A): order the return's transition rows by
 * `(createdAt ASC, id ASC)` — the deterministic ordering R uses for receipt
 * history — and answer the state of the LAST row. An empty history cannot
 * exist for a persisted return (creating the return writes `REQUESTED` in the
 * same transaction as the document and its lines), so an empty input is
 * REFUSED rather than defaulted: a silent `REQUESTED` would be a state no row
 * ever stated. An impossible history — first row not `REQUESTED`, a pair the
 * matrix does not allow — is refused with the same determinism: it can only
 * arrive from a bug, and a bug that projects a fabricated state is worse than
 * one that throws.
 *
 * NO `eval`, NO `new Function`, NO dynamic dispatch: the matrix is a frozen
 * record, the projection is a sort and a walk.
 */

/** The five §5.17 states, in the specification's order — frozen, closed. */
export const RETURN_STATES = [
  'REQUESTED',
  'APPROVED',
  'RECEIVED_BACK',
  'REFUNDED',
  'REJECTED',
] as const;

/** One return state. Structurally identical to the schema's `ReturnState`. */
export type ReturnState = (typeof RETURN_STATES)[number];

/**
 * The whole matrix: for each state, the states it may move TO. Readable as
 * edges, exhaustively testable as a record, and impossible to extend without
 * editing this table — which is exactly the point: a fifth allowed path is a
 * contract amendment, not a code change.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ReturnState, readonly ReturnState[]>> = {
  REQUESTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['RECEIVED_BACK'],
  RECEIVED_BACK: ['REFUNDED'],
  REFUNDED: [],
  REJECTED: [],
};

/** Is `from -> to` one of S-D2's four allowed paths? Everything else is false. */
export function canTransition(from: ReturnState, to: ReturnState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * The legal SOURCES of a target state — the `<sources>` half of §10's exact
 * `invalid_transition` message. Every state has exactly one incoming edge
 * (S-D2), so this is a single-element set today; the reduction is written
 * generally so the message stays correct if the contract ever amends the
 * matrix, rather than hard-coding one word per command beside each command.
 */
export function legalTransitionSources(to: ReturnState): readonly ReturnState[] {
  return RETURN_STATES.filter((from) => canTransition(from, to));
}

/**
 * One immutable transition row, as the repository returns it. `state` is the
 * generated client's enum — a string union structurally identical to
 * `ReturnState`, so this module never imports the generated client (the
 * persistence-boundary scan would refuse that import in a pure file).
 */
export interface ReturnTransitionRow {
  readonly id: string;
  readonly state: ReturnState;
  readonly createdAt: Date;
}

/**
 * The current state of a return: sort by `(createdAt, id)`, validate the
 * chain, answer the LAST row's state.
 *
 * THE SORT IS THE ORDER (§4-A). Callers hand rows in whatever order the
 * database returned them; the projection owns the deterministic
 * `(createdAt ASC, id ASC)` order — including the `id` tie-break, because two
 * rows CAN share a millisecond and a total order is the whole promise. The id
 * comparison is the string order of UUIDs: the same bytes every time, so the
 * same answer every time.
 *
 * THE CHAIN IS VALIDATED, NOT ASSUMED. First row `REQUESTED` (creation wrote
 * it), every adjacent pair inside the matrix (commands checked it before they
 * appended), nothing after a terminal state (the matrix has no edge out).
 * Sorting FIRST means the validation judges the true sequence even when rows
 * arrive shuffled, so "impossible history" is judged deterministically rather
 * than by an accident of storage order.
 */
export function projectReturnState(transitions: readonly ReturnTransitionRow[]): ReturnState {
  if (transitions.length === 0) {
    throw new Error(
      'A persisted return has at least one transition (creation writes REQUESTED); an empty history has no state.'
    );
  }

  const ordered = [...transitions].sort((left, right) => {
    const byInstant = left.createdAt.getTime() - right.createdAt.getTime();
    if (byInstant !== 0) return byInstant;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  if (ordered[0].state !== 'REQUESTED') {
    throw new Error(
      `An impossible return history: its first transition is ${ordered[0].state}, not REQUESTED.`
    );
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1].state;
    const to = ordered[index].state;
    if (!canTransition(from, to)) {
      throw new Error(
        `An impossible return history: ${from} -> ${to} is not an allowed transition.`
      );
    }
  }

  return ordered[ordered.length - 1].state;
}
