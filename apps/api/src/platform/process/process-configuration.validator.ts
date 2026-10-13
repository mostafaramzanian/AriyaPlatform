import type { ProcessDefinition } from './process-definition.model';

/**
 * Phase CHECK-ISSUATION — PROCESS CONFIGURATION VALIDATION (brief §8): an incoherent
 * process definition is UNPUBLISHABLE, and an unpublished process cannot be pinned,
 * served or executed.
 *
 * WHY A PURE FUNCTION AND NOT A NEST LIFECYCLE HOOK
 * -------------------------------------------------
 * Every rule below must be answerable three times — in the owning module's startup
 * assertion, in the definition's unit tests, and (eventually) in an administration
 * surface's publish screen — and none of the three may need a container, a database or
 * a clock to run. `assertProcessPublishable` is the throwing wrapper; callers that want
 * issues as data (an admin screen's "validation result", a report) call
 * `validateProcessConfiguration` directly.
 *
 * THE FULL CODE LIST LIVES ON EACH RULE BELOW. What this validator deliberately does
 * NOT check, because these are CODE-owned (brief §6) and a configuration must not be
 * able to argue with them: tenant scoping, authentication, permission ENFORCEMENT (the
 * route's `@Roles`), self-approval refusal execution, concurrency, atomicity, audit,
 * terminal-state enforcement at runtime.
 */

/** The capability shape the repo's catalogue uses (`financial.check.read`, …). */
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]+)+$/;

export interface ProcessConfigurationIssue {
  /** Stable machine code — the report/API spells it, never re-derives it. */
  readonly code: string;
  /** Where and what — human-readable, safe to surface in an admin validation panel. */
  readonly detail: string;
}

function issue(code: string, detail: string): ProcessConfigurationIssue {
  return { code, detail };
}

/** Every distinct state referenced anywhere in the definition. */
function allReferencedStates(definition: ProcessDefinition): number[] {
  const states = new Set<number>();
  for (const step of definition.steps) for (const state of step.states) states.add(state);
  for (const transition of definition.transitions) {
    states.add(transition.fromState);
    states.add(transition.toState);
  }
  for (const state of definition.terminalStates) states.add(state);
  for (const section of definition.documentSections)
    for (const state of section.states) states.add(state);
  for (const step of definition.steps)
    for (const field of step.fields) {
      for (const state of field.states) states.add(state);
      for (const state of field.editableStates) states.add(state);
    }
  return [...states];
}

/**
 * Validates a definition and returns EVERY issue — never fail-fast, so one run reports
 * the whole configuration rather than only the first thing that went wrong.
 */
export function validateProcessConfiguration(
  definition: ProcessDefinition
): ProcessConfigurationIssue[] {
  const issues: ProcessConfigurationIssue[] = [];

  // --- header --------------------------------------------------------------
  if (definition.processKey.trim().length === 0) {
    issues.push(issue('INVALID_PROCESS_KEY', 'processKey must be a non-empty string.'));
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    issues.push(
      issue('INVALID_VERSION', `version must be an integer ≥ 1 (got ${definition.version}).`)
    );
  }
  if (definition.steps.length === 0) {
    issues.push(issue('EMPTY_STEPS', 'a process must declare at least one step.'));
  }
  if (definition.status !== 'draft' && definition.status !== 'published') {
    issues.push(
      issue('INVALID_STATUS', `status must be 'draft' or 'published' (got ${definition.status}).`)
    );
  }

  // --- steps ---------------------------------------------------------------
  const stepKeys = new Set<string>();
  const stepOrders = new Set<number>();
  const stateOwner = new Map<number, string>();
  for (const step of definition.steps) {
    if (stepKeys.has(step.key)) {
      issues.push(issue('DUPLICATE_STEP_KEY', `step key "${step.key}" is declared twice.`));
    }
    stepKeys.add(step.key);
    if (stepOrders.has(step.order)) {
      issues.push(
        issue('DUPLICATE_STEP_ORDER', `step order ${step.order} is claimed by more than one step.`)
      );
    }
    stepOrders.add(step.order);
    if (step.states.length === 0) {
      issues.push(issue('STEP_HAS_NO_STATES', `step "${step.key}" owns no state.`));
    }
    for (const state of step.states) {
      const owner = stateOwner.get(state);
      if (owner !== undefined) {
        issues.push(
          issue(
            'STATE_OWNED_BY_MULTIPLE_STEPS',
            `state ${state} belongs to both "${owner}" and "${step.key}".`
          )
        );
      } else {
        stateOwner.set(state, step.key);
      }
    }
    for (const actionKey of step.actions) {
      if (!definition.actions.some((action) => action.key === actionKey)) {
        issues.push(
          issue('UNKNOWN_ACTION', `step "${step.key}" offers unknown action "${actionKey}".`)
        );
      }
    }
    const fieldNames = new Set<string>();
    for (const field of step.fields) {
      if (fieldNames.has(field.field)) {
        issues.push(
          issue('DUPLICATE_FIELD_POLICY', `step "${step.key}" declares field "${field.field}" twice.`)
        );
      }
      fieldNames.add(field.field);
      for (const state of field.editableStates) {
        if (!field.states.includes(state)) {
          issues.push(
            issue(
              'INVALID_FIELD_POLICY',
              `field "${field.field}" of step "${step.key}" is editable in state ${state} but not visible there.`
            )
          );
        }
      }
    }
  }

  // --- every referenced state must exist in some step ----------------------
  const knownStates = new Set<number>(stateOwner.keys());
  for (const state of allReferencedStates(definition)) {
    if (!knownStates.has(state)) {
      issues.push(issue('UNKNOWN_STATE', `state ${state} is referenced but no step owns it.`));
    }
  }

  // --- actor policies ------------------------------------------------------
  const policyKeys = new Set<string>();
  for (const policy of definition.actorPolicies) {
    if (policyKeys.has(policy.key)) {
      issues.push(issue('DUPLICATE_ACTOR_POLICY', `actor policy "${policy.key}" is declared twice.`));
    }
    policyKeys.add(policy.key);

    if (policy.kind === 'PERMISSION') {
      if (!policy.permission || !PERMISSION_PATTERN.test(policy.permission)) {
        issues.push(
          issue(
            'INVALID_ACTOR_POLICY',
            `actor policy "${policy.key}" is PERMISSION-kind but carries no capability-shaped permission.`
          )
        );
      }
    } else if (policy.kind === 'USER') {
      if (!policy.userId || policy.userId.trim().length === 0) {
        issues.push(
          issue(
            'INVALID_ACTOR_POLICY',
            `actor policy "${policy.key}" is USER-kind but carries no userId.`
          )
        );
      }
    } else if (policy.kind !== 'REQUESTER') {
      issues.push(
        issue(
          'INVALID_ACTOR_POLICY',
          `actor policy "${policy.key}" has unknown kind "${String(policy.kind)}".`
        )
      );
    }
  }

  // --- actions -------------------------------------------------------------
  const actionKeys = new Set<string>();
  for (const action of definition.actions) {
    if (actionKeys.has(action.key)) {
      issues.push(issue('DUPLICATE_ACTION', `action "${action.key}" is declared twice.`));
    }
    actionKeys.add(action.key);
    if (action.label.trim().length === 0) {
      issues.push(issue('INVALID_ACTION_LABEL', `action "${action.key}" has an empty label.`));
    }
    if (!PERMISSION_PATTERN.test(action.permission)) {
      issues.push(
        issue(
          'INVALID_PERMISSION',
          `action "${action.key}" declares "${action.permission}", which is not capability-shaped.`
        )
      );
    }
    if (!policyKeys.has(action.actorPolicy)) {
      issues.push(
        issue(
          'UNKNOWN_ACTOR_POLICY',
          `action "${action.key}" references unknown actor policy "${action.actorPolicy}".`
        )
      );
    }
  }

  // --- transitions ---------------------------------------------------------
  const seenPairs = new Set<string>();
  const outgoing = new Map<number, number>();
  const actionHasTransition = new Set<string>();
  for (const transition of definition.transitions) {
    const pair = `${transition.action}@${transition.fromState}`;
    if (seenPairs.has(pair)) {
      issues.push(
        issue(
          'DUPLICATE_TRANSITION',
          `action "${transition.action}" declares two moves out of state ${transition.fromState}.`
        )
      );
    }
    seenPairs.add(pair);
    actionHasTransition.add(transition.action);

    if (!actionKeys.has(transition.action)) {
      issues.push(
        issue(
          'UNKNOWN_ACTION',
          `transition references unknown action "${transition.action}".`
        )
      );
    }
    if (definition.terminalStates.includes(transition.fromState)) {
      issues.push(
        issue(
          'TRANSITION_FROM_TERMINAL',
          `state ${transition.fromState} is terminal but "${transition.action}" leaves it.`
        )
      );
    }
    outgoing.set(transition.fromState, (outgoing.get(transition.fromState) ?? 0) + 1);

    // The step owning the FROM state must OFFER the action — otherwise the wizard shows
    // a step whose button the state cannot press, or hides one it can.
    const ownerKey = stateOwner.get(transition.fromState);
    const owner = definition.steps.find((step) => step.key === ownerKey);
    if (owner && !owner.actions.includes(transition.action)) {
      issues.push(
        issue(
          'ACTION_NOT_OFFERED_BY_STEP',
          `step "${owner.key}" does not offer "${transition.action}", which its state ${transition.fromState} requires.`
        )
      );
    }
  }

  for (const action of definition.actions) {
    if (!actionHasTransition.has(action.key)) {
      issues.push(
        issue('ACTION_WITHOUT_TRANSITION', `action "${action.key}" has no transition — a button that does nothing.`)
      );
    }
  }
  for (const step of definition.steps) {
    for (const actionKey of step.actions) {
      const leavesFromOwnState = definition.transitions.some(
        (transition) =>
          transition.action === actionKey && step.states.includes(transition.fromState)
      );
      if (!leavesFromOwnState) {
        issues.push(
          issue(
            'STEP_ACTION_WITHOUT_TRANSITION',
            `step "${step.key}" offers "${actionKey}" but none of its states can perform it.`
          )
        );
      }
    }
  }

  // --- terminals: every dead end must be DECLARED --------------------------
  for (const state of knownStates) {
    const terminal = definition.terminalStates.includes(state);
    const hasOutgoing = (outgoing.get(state) ?? 0) > 0;
    if (terminal && hasOutgoing) continue; // already reported as TRANSITION_FROM_TERMINAL
    if (!terminal && !hasOutgoing) {
      issues.push(
        issue(
          'UNDECLARED_TERMINAL_STATE',
          `state ${state} has no outgoing transition but is not declared terminal.`
        )
      );
    }
  }

  // --- reachability: every state of every ACTIVE step is enterable ----------
  // Entry = the first active step's states that NO transition enters (the process's
  // natural starting points). Seeding with the whole first step instead would make a
  // "returned for correction" state reachable by fiat even if its correction
  // transition vanished — the graph must PROVE it, not the step list.
  const hasIncoming = new Set(
    definition.transitions.map((transition) => transition.toState)
  );
  const firstStep = definition.steps
    .filter((step) => step.active)
    .sort((a, b) => a.order - b.order)[0];
  const naturalEntries = firstStep ? firstStep.states.filter((state) => !hasIncoming.has(state)) : [];
  const entryStates =
    naturalEntries.length > 0 ? naturalEntries : firstStep ? [...firstStep.states] : [];
  const reachable = new Set<number>(entryStates);
  const frontier = [...entryStates];
  while (frontier.length > 0) {
    const current = frontier.pop() as number;
    for (const transition of definition.transitions) {
      if (transition.fromState === current && !reachable.has(transition.toState)) {
        reachable.add(transition.toState);
        frontier.push(transition.toState);
      }
    }
  }
  for (const step of definition.steps) {
    if (!step.active) continue;
    const unreachable = step.states.filter((state) => !reachable.has(state));
    if (unreachable.length > 0) {
      issues.push(
        issue(
          'UNREACHABLE_STEP',
          `step "${step.key}" owns state(s) [${unreachable.join(', ')}] no transition can enter.`
        )
      );
    }
  }

  // --- document sections ---------------------------------------------------
  const sectionNumbers = new Set<number>();
  const sectionKeys = new Set<string>();
  for (const section of definition.documentSections) {
    if (sectionNumbers.has(section.section)) {
      issues.push(
        issue('DUPLICATE_DOCUMENT_SECTION', `section ${section.section} is declared twice.`)
      );
    }
    sectionNumbers.add(section.section);
    if (sectionKeys.has(section.key)) {
      issues.push(
        issue('DUPLICATE_DOCUMENT_SECTION', `section key "${section.key}" is declared twice.`)
      );
    }
    sectionKeys.add(section.key);
    if (section.states.length === 0) {
      issues.push(
        issue(
          'INVALID_DOCUMENT_POLICY',
          `section ${section.section} manages no state — nothing could ever upload to it.`
        )
      );
    }
    if (section.allowedDocumentTypes !== null) {
      if (section.allowedDocumentTypes.length === 0) {
        issues.push(
          issue(
            'INVALID_DOCUMENT_POLICY',
            `section ${section.section} has an empty type vocabulary; use null for "no type picker".`
          )
        );
      }
      if (new Set(section.allowedDocumentTypes).size !== section.allowedDocumentTypes.length) {
        issues.push(
          issue(
            'INVALID_DOCUMENT_POLICY',
            `section ${section.section} repeats a document type in its vocabulary.`
          )
        );
      }
      if (section.allowedDocumentTypes.some((type) => type.trim().length === 0)) {
        issues.push(
          issue(
            'INVALID_DOCUMENT_POLICY',
            `section ${section.section} contains an empty document type.`
          )
        );
      }
    }
    if (!PERMISSION_PATTERN.test(section.permission)) {
      issues.push(
        issue(
          'INVALID_PERMISSION',
          `section ${section.section} declares "${section.permission}", which is not capability-shaped.`
        )
      );
    }
    for (const actionKey of section.requiredForActions) {
      if (!actionKeys.has(actionKey)) {
        issues.push(
          issue(
            'INVALID_DOCUMENT_POLICY',
            `section ${section.section} requires documents for unknown action "${actionKey}".`
          )
        );
      }
    }
  }

  // --- bounded extension: STRING values only --------------------------------
  for (const [key, value] of Object.entries(definition.extension ?? {})) {
    if (typeof value !== 'string') {
      issues.push(
        issue(
          'INVALID_EXTENSION',
          `extension "${key}" carries a non-string value; extension metadata is scalar-only.`
        )
      );
    }
  }

  return issues;
}

/**
 * The publish gate (brief §8): throws with the FULL issue list when the definition may
 * not be published — wrong status or any configuration issue. A thrown gate at module
 * init / registration time is deliberate: a broken configuration must stop the process
 * from existing, not wait for the first request to misbehave.
 */
export function assertProcessPublishable(definition: ProcessDefinition): void {
  const issues = validateProcessConfiguration(definition);
  if (definition.status !== 'published') {
    issues.unshift({
      code: 'NOT_PUBLISHED',
      detail: `process "${definition.processKey}" v${definition.version} is '${definition.status}' — only published versions are served or pinned.`,
    });
  }
  if (issues.length > 0) {
    const rendered = issues.map((item) => `${item.code}: ${item.detail}`).join('\n  - ');
    throw new Error(`Process configuration is not publishable:\n  - ${rendered}`);
  }
}



