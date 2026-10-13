/**
 * Phase 49M-1: the OPERATIONAL lifecycle state machine.
 *
 * WHY THIS IS A SEPARATE STATE MACHINE FROM 49M's `ModuleLifecycleState`
 * ---------------------------------------------------------------------
 * `ModuleInstance.lifecycle` answers "can the resolver return this instance?" and is written
 * by FOUR independent paths — self-registration, heartbeat, an admin-triggered probe, and the
 * staleness sweep. None of them knows anything about provisioning, and two of them run without
 * a human present.
 *
 * `ModuleOperationalState` answers a different question — "what has the control plane done to
 * this instance, and what may it do next?" — and is written by ONE path: a provisioning
 * execution. Merging the two would mean the sweep demoting an instance to UNAVAILABLE while an
 * upgrade is mid-flight, silently erasing the fact that an upgrade was running. So registry
 * lifecycle stays exactly as 49M left it, and operational state lives in its own 1:1 row.
 *
 * WHY A TABLE AND NOT `if` STATEMENTS
 * -----------------------------------
 * A transition rule spread across service methods is a rule nobody can read in one place, and
 * every new action adds another branch that may or may not agree with the others. Here the
 * legal graph is DATA, `canTransition` is the only reader, and a test can enumerate all
 * 9 x 9 = 81 ordered pairs and assert the exact set that is allowed. That is why this file has
 * no imports: nothing it depends on can drag a database, a clock or a network call into a
 * decision that is pure graph reachability.
 *
 * WHAT WOULD MAKE THIS FILE WRONG: exporting a function that SETS a state, accepting a state
 * from an HTTP body, or adding a transition to make a test pass. The control plane requests an
 * ACTION (`provision`, `upgrade`, `disable`…); this module decides whether the state change that
 * action implies is legal. An admin cannot assign a state directly, because no route takes one.
 */

/**
 * The operational states of ONE DEPLOYED INSTANCE.
 *
 * NINE MEMBERS, and the two absences are deliberate:
 *
 *   * NO `DISCOVERED`. 49M already derives that for the LOGICAL module — "a registration
 *     exists, no instance has ever announced itself" — and this machine is keyed by instance.
 *     A per-instance DISCOVERED could never be true: the row cannot exist until the instance
 *     does.
 *   * NO `DEGRADED`/`UNAVAILABLE`. Those are HEALTH observations, and 49M already owns them on
 *     `ModuleInstance.health`. Copying them here would create two columns that disagree the
 *     moment a probe lands during an upgrade, and an operator would have no way to tell which
 *     one was stale.
 */
export type ModuleOperationalStateValue =
  | 'REGISTERED'
  | 'PROVISIONING'
  | 'CONFIGURING'
  | 'VERIFYING'
  | 'ACTIVE'
  | 'UPDATING'
  | 'DISABLED'
  | 'FAILED'
  | 'DECOMMISSIONED';

/** Declared order, used for stable rendering. NOT a progression: see the transition table. */
export const MODULE_OPERATIONAL_STATES: readonly ModuleOperationalStateValue[] = [
  'REGISTERED',
  'PROVISIONING',
  'CONFIGURING',
  'VERIFYING',
  'ACTIVE',
  'UPDATING',
  'DISABLED',
  'FAILED',
  'DECOMMISSIONED',
];

/**
 * The state a freshly tracked instance starts in.
 *
 * REGISTERED, never ACTIVE: 49M already refuses to let a self-registration serve traffic before
 * an administrator admits it (`ModuleRegistration.enabled` defaults to false), and an
 * operational default of ACTIVE would contradict that from the other direction.
 */
export const INITIAL_OPERATIONAL_STATE: ModuleOperationalStateValue = 'REGISTERED';

/**
 * The legal transition graph.
 *
 * READ IT AS: from the key, the control plane may move to any state in the value.
 *
 *   REGISTERED     -> PROVISIONING | FAILED
 *   PROVISIONING   -> CONFIGURING  | FAILED
 *   CONFIGURING    -> VERIFYING    | FAILED
 *   VERIFYING      -> ACTIVE       | FAILED
 *   ACTIVE        <-> UPDATING
 *   ACTIVE        <-> DISABLED
 *   UPDATING       -> FAILED
 *   FAILED         -> PROVISIONING | DISABLED
 *   DISABLED       -> DECOMMISSIONED
 *   DECOMMISSIONED -> nothing (terminal)
 *
 * FOUR PROPERTIES WORTH STATING, because each is a decision rather than an accident:
 *
 * 1. THE FORWARD PATH IS LINEAR AND EVERY STEP CAN FAIL. There is no REGISTERED -> ACTIVE
 *    shortcut, so an instance cannot become ACTIVE without passing through VERIFYING — which is
 *    where the five-condition activation gate lives. A shortcut here would let a caller skip
 *    checksum and capability verification by requesting the "right" state.
 *
 * 2. `UPDATING` RETURNS ONLY TO ACTIVE OR FAILED. An upgrade that succeeds resumes service; one
 *    that fails is FAILED, from which the only ways out are a fresh attempt or DISABLED. It
 *    deliberately cannot fall back to DISABLED directly, because "the upgrade failed" and "an
 *    operator turned it off" are different facts and an operator needs to see the first one.
 *
 * 3. `FAILED` IS RECOVERABLE, and only two ways: retry (-> PROVISIONING) or give up
 *    (-> DISABLED). It cannot go straight to ACTIVE — that would be an operator declaring an
 *    unverified instance healthy — and it cannot go straight to DECOMMISSIONED, because
 *    decommissioning is destructive and must pass through the deliberate DISABLED step.
 *
 * 4. `DECOMMISSIONED` IS TERMINAL, with an empty successor list. Re-provisioning a
 *    decommissioned instance is a NEW instance with a new row, not a resurrection of one whose
 *    artifacts and configuration are already gone.
 */
const TRANSITIONS: Record<
  ModuleOperationalStateValue,
  readonly ModuleOperationalStateValue[]
> = {
  REGISTERED: ['PROVISIONING', 'FAILED'],
  PROVISIONING: ['CONFIGURING', 'FAILED'],
  CONFIGURING: ['VERIFYING', 'FAILED'],
  VERIFYING: ['ACTIVE', 'FAILED'],
  ACTIVE: ['UPDATING', 'DISABLED'],
  UPDATING: ['ACTIVE', 'FAILED'],
  DISABLED: ['ACTIVE', 'DECOMMISSIONED'],
  FAILED: ['PROVISIONING', 'DISABLED'],
  DECOMMISSIONED: [],
};

/**
 * States from which the control plane will never accept another action.
 *
 * Derived from the table rather than listed separately, so a future transition out of a
 * terminal state cannot leave this constant lying.
 */
export const TERMINAL_OPERATIONAL_STATES: readonly ModuleOperationalStateValue[] =
  MODULE_OPERATIONAL_STATES.filter((state) => TRANSITIONS[state].length === 0);

/**
 * States in which an execution is mid-flight.
 *
 * Used by the concurrency guard: a second action against an instance already in one of these
 * is refused with `EXECUTION_IN_PROGRESS` rather than queued, because two provisioning runs
 * against one instance would race on the same artifact and configuration.
 */
export const IN_FLIGHT_OPERATIONAL_STATES: readonly ModuleOperationalStateValue[] = [
  'PROVISIONING',
  'CONFIGURING',
  'VERIFYING',
  'UPDATING',
];

/** True when `value` is a declared operational state. Narrows an unknown string. */
export function isOperationalState(value: unknown): value is ModuleOperationalStateValue {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, value)
  );
}

/**
 * The successor states of one state, as a fresh array.
 *
 * COPIED, not returned by reference: the table is module-level state, and handing a caller the
 * live array would let one accidental `push` widen the machine for the whole process.
 *
 * An unknown state yields an EMPTY list rather than throwing. This function feeds the admin
 * projection, and a row holding a value this build does not know about — a rolled-back
 * deployment reading a newer row — should render "no actions available", not 500.
 */
export function allowedTransitions(
  from: ModuleOperationalStateValue,
): readonly ModuleOperationalStateValue[] {
  if (!isOperationalState(from)) return [];
  return [...TRANSITIONS[from]];
}

/**
 * THE ONLY TRANSITION DECISION IN THE PHASE.
 *
 * Own-property lookup, for the reason `IntegrationProviderRegistry.descriptor` documents:
 * `TRANSITIONS['constructor']` on a plain object literal resolves through `Object.prototype`
 * and returns a truthy non-array, which a naive `if (!allowed)` guard would pass. Routing that
 * through `isOperationalState` makes every caller prototype-safe at once.
 *
 * A SELF-TRANSITION IS REFUSED — `canTransition('ACTIVE', 'ACTIVE')` is false — because a state
 * write that changes nothing still moves `stateChangedAt`, and an idempotent retry must be
 * recognised by its `idempotencyKey`, not by silently accepting a no-op transition.
 */
export function canTransition(
  from: ModuleOperationalStateValue,
  to: ModuleOperationalStateValue,
): boolean {
  if (!isOperationalState(from) || !isOperationalState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/** True when no action will ever be accepted from this state again. */
export function isTerminalState(state: ModuleOperationalStateValue): boolean {
  return isOperationalState(state) && TRANSITIONS[state].length === 0;
}

/** True when an execution is currently mid-flight for this state. */
export function isInFlightState(state: ModuleOperationalStateValue): boolean {
  return IN_FLIGHT_OPERATIONAL_STATES.includes(state);
}

/**
 * Why a requested transition was refused. Short codes, never a sentence.
 *
 * Mirrors 49M's `CompatibilityFailure` and its five resolver failures: the admin UI renders its
 * own Persian text per code, so a message here would be a second copy that drifts.
 */
export type TransitionFailure = 'UNKNOWN_STATE' | 'TERMINAL_STATE' | 'ILLEGAL_TRANSITION';

export interface TransitionCheck {
  ok: boolean;
  failure?: TransitionFailure;
}

/**
 * `canTransition` with a REASON, for the paths that must tell an operator why.
 *
 * The order matters: an unknown state is reported as UNKNOWN_STATE rather than as an illegal
 * transition, and a terminal source as TERMINAL_STATE rather than the same generic refusal,
 * because "this instance is decommissioned" and "you cannot go from ACTIVE to VERIFYING" lead an
 * operator to completely different next steps.
 */
export function checkTransition(
  from: ModuleOperationalStateValue,
  to: ModuleOperationalStateValue,
): TransitionCheck {
  if (!isOperationalState(from) || !isOperationalState(to)) {
    return { ok: false, failure: 'UNKNOWN_STATE' };
  }

  if (TRANSITIONS[from].length === 0) {
    return { ok: false, failure: 'TERMINAL_STATE' };
  }

  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, failure: 'ILLEGAL_TRANSITION' };
  }

  return { ok: true };
}

