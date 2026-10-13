import type {
  ProcessAction,
  ProcessActorPolicy,
  ProcessDefinition,
  ProcessDocumentSection,
  ProcessState,
  ProcessStep,
  ProcessTransition,
} from './process-definition.model';

/**
 * Phase CHECK-ISSUATION — PROCESS PRIMITIVES: pure queries over a `ProcessDefinition`
 * plus the published-immutability freeze. Every consumer — the owning module's service,
 * the available-actions projection, the wizard — reads the process through THESE
 * functions, so "what can happen in state N?" has one implementation instead of a
 * per-caller interpretation of the raw arrays.
 */

/** Deep-freezes a definition (and everything it contains) and returns it. */
export function freezeProcessDefinition(definition: ProcessDefinition): ProcessDefinition {
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) walk(child);
  };
  walk(definition);
  return definition;
}

/** The step that owns `state`, or `null` when the state is unknown to this process. */
export function findStepForState(
  definition: ProcessDefinition,
  state: ProcessState
): ProcessStep | null {
  return definition.steps.find((step) => step.states.includes(state)) ?? null;
}

/** Every transition leaving `state`, in declaration order. */
export function transitionsFromState(
  definition: ProcessDefinition,
  state: ProcessState
): ProcessTransition[] {
  return definition.transitions.filter((transition) => transition.fromState === state);
}

/** One action by key, or `null`. */
export function findAction(
  definition: ProcessDefinition,
  key: string
): ProcessAction | null {
  return definition.actions.find((action) => action.key === key) ?? null;
}

/** One actor policy by key, or `null`. */
export function findActorPolicy(
  definition: ProcessDefinition,
  key: string
): ProcessActorPolicy | null {
  return definition.actorPolicies.find((policy) => policy.key === key) ?? null;
}

/**
 * The catalogue entries exercisable FROM `state` — derived from the transition graph,
 * never from a step's `actions` list alone: a state whose transition is missing must
 * offer nothing, which is exactly the fail-closed shape available-actions needs.
 */
export function actionsAvailableInState(
  definition: ProcessDefinition,
  state: ProcessState
): ProcessAction[] {
  const keys = new Set(transitionsFromState(definition, state).map((t) => t.action));
  return definition.actions.filter((action) => keys.has(action.key));
}

/** Whether `state` is a declared terminal — no action exists after it, ever. */
export function isTerminalState(definition: ProcessDefinition, state: ProcessState): boolean {
  return definition.terminalStates.includes(state);
}

/** Document sections MANAGED while in `state` (upload/delete allowed there). */
export function documentSectionsForState(
  definition: ProcessDefinition,
  state: ProcessState
): ProcessDocumentSection[] {
  return definition.documentSections.filter((section) => section.states.includes(state));
}

/** Active steps in stepper order — the wizard's rendering sequence. */
export function activeStepsInOrder(definition: ProcessDefinition): ProcessStep[] {
  return definition.steps
    .filter((step) => step.active)
    .slice()
    .sort((a, b) => a.order - b.order);
}
