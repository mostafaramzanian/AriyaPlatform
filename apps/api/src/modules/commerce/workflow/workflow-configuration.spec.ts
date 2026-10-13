import {
  WORKFLOW_CONFIGURATION_REFUSALS,
  WORKFLOW_MAX_REPORTED_ISSUES,
  validateWorkflowVersionConfiguration,
} from './workflow-configuration';
import type {
  WorkflowConfigurationFacts,
  WorkflowConfigurationIssue,
  WorkflowConfigurationLevel,
  WorkflowConfigurationRefusal,
  WorkflowConfigurationReport,
  WorkflowStepConfigurationShape,
  WorkflowVersionConfigurationShape,
} from './workflow-configuration';

/**
 * Phase C1 Step M (§5.6–§5.8, §6, §11): the RULES a version's configuration is judged by, exercised
 * through the ONE entry point both the authoring writes and the two lifecycle gates call.
 *
 * WHY THE FACTS ARE STUBBED AND THE WALKS ARE NOT REIMPLEMENTED
 * ------------------------------------------------------------
 * Two of the rules arrive through the injected `WorkflowConfigurationFacts` — the platform's own
 * unsafe-payload scan and the condition tree walk — and both are STUBBED here: their vocabularies
 * belong to the engine (and `workflow-condition.spec.ts` covers the walk's own grammar), while this
 * file's subject is what the validator does WITH a finding. Stubbing them also makes the seam
 * visible in both directions: a stub that never fires proves the rule it feeds is reachable only
 * through it.
 *
 * THE LEVELS ARE PINNED AS A DIFFERENCE, NOT AS TWO LISTS: `DRAFT` differs from `PUBLISH` in exactly
 * the two completeness rules (a version may be empty, and a step may lack an actor source), and
 * every other test below is asserted at the level where it is a refusal. A rule that drifted to
 * "checked at publish only" would fail the DRAFT assertion, which is where a draft's author would
 * discover it — at the write, not at the gate.
 */

/** Both borrowed walks stubbed, and overridable one at a time. */
function facts(overrides: Partial<WorkflowConfigurationFacts> = {}): WorkflowConfigurationFacts {
  return {
    conditionIssues: () => [],
    unsafePayload: () => null,
    ruleSetIssues: () => ({ selection: [], activation: [] }),
    ...overrides,
  };
}

/** One step that is valid at DRAFT with nothing but the three required columns. */
function step(
  overrides: Partial<WorkflowStepConfigurationShape> = {}
): WorkflowStepConfigurationShape {
  return {
    stepKey: 'check-budget',
    displayName: 'Check budget',
    mandatory: true,
    executionMode: 'SEQUENTIAL',
    ordering: 1,
    ...overrides,
  };
}

/** One version that owns a candidate step set. */
function versionShape(
  steps: readonly WorkflowStepConfigurationShape[],
  overrides: Partial<WorkflowVersionConfigurationShape> = {}
): WorkflowVersionConfigurationShape {
  return {
    workflowDefinitionId: 'd1',
    workflowDefinitionVersionId: 'v1',
    workflowDefinitionCode: 'standard-purchase',
    versionLabel: 'v1',
    triggerEvent: 'PURCHASE_SUBMITTED',
    parallelJoinPolicy: null,
    selectionPriority: null,
    selectionCondition: null,
    steps,
    ...overrides,
  };
}

/** One report, from the one entry point, over a candidate set. */
function inspect(
  steps: readonly WorkflowStepConfigurationShape[],
  level: WorkflowConfigurationLevel,
  overrides: Partial<WorkflowConfigurationFacts> = {}
): WorkflowConfigurationReport {
  return validateWorkflowVersionConfiguration(versionShape(steps), level, facts(overrides));
}

const refusals = (report: WorkflowConfigurationReport): WorkflowConfigurationRefusal[] =>
  report.issues.map((issue) => issue.refusal);

const issueFor = (
  report: WorkflowConfigurationReport,
  refusal: WorkflowConfigurationRefusal
): WorkflowConfigurationIssue | undefined =>
  report.issues.find((issue) => issue.refusal === refusal);

describe('Phase C1 Step M — a step’s identity and position (§5.6)', () => {
  it('accepts the minimal DRAFT step, and says so in a report that is valid and complete', () => {
    const report = inspect([step()], 'DRAFT');

    expect(report).toEqual({ valid: true, level: 'DRAFT', issues: [], truncated: false });
  });

  it('refuses a key that is empty after trimming, and a display name that is too', () => {
    expect(refusals(inspect([step({ stepKey: '   ' })], 'DRAFT'))).toEqual(['STEP_KEY_MISSING']);
    expect(refusals(inspect([step({ displayName: ' ' })], 'DRAFT'))).toEqual([
      'STEP_DISPLAY_NAME_MISSING',
    ]);
  });

  it('refuses a key or a name past its column, at BOTH levels', () => {
    // The PUBLISH rows carry an actor source so the only refusal under test is the length one: a
    // second, unrelated refusal (a missing source) would make the assertion describe two changes.
    const perLevel = {
      DRAFT: () => step(),
      PUBLISH: () => step({ actorSource: 'CONFIGURED_USER' as const, actorUserId: 'u1' }),
    } as const;

    for (const level of ['DRAFT', 'PUBLISH'] as const) {
      const base = perLevel[level]();
      expect({
        level,
        refused: refusals(inspect([{ ...base, stepKey: 'k'.repeat(65) }], level)),
      }).toEqual({ level, refused: ['STEP_KEY_TOO_LONG'] });
      expect({
        level,
        refused: refusals(inspect([{ ...base, displayName: 'n'.repeat(201) }], level)),
      }).toEqual({ level, refused: ['STEP_DISPLAY_NAME_TOO_LONG'] });
    }
  });

  it('refuses a position that is not an integer, and one below the floor, as DIFFERENT refusals', () => {
    expect(refusals(inspect([step({ ordering: 1.5 })], 'DRAFT'))).toEqual([
      'STEP_ORDERING_NOT_AN_INTEGER',
    ]);
    expect(refusals(inspect([step({ ordering: 0 })], 'DRAFT'))).toEqual([
      'STEP_ORDERING_NOT_POSITIVE',
    ]);
  });

  it('refuses a mode outside §5.6’s three members — and does NOT pile a second finding on it', () => {
    // The mode-dependent rules need a readable mode; reporting "a PARALLEL step needs a branch
    // label" about a step whose mode nobody can read would be a second, misleading finding.
    const report = inspect(
      [step({ executionMode: 'PARALEL' as never, parallelGroup: 'branch-a' })],
      'DRAFT'
    );

    expect(refusals(report)).toEqual(['STEP_EXECUTION_MODE_UNSUPPORTED']);
  });
});

describe('Phase C1 Step M — the mode-dependent rules (§5.6, §5.7)', () => {
  it('requires a branch label for PARALLEL, and refuses one past its column', () => {
    expect(refusals(inspect([step({ executionMode: 'PARALLEL' })], 'DRAFT'))).toEqual([
      'STEP_PARALLEL_GROUP_MISSING',
    ]);
    expect(
      refusals(
        inspect([step({ executionMode: 'PARALLEL', parallelGroup: 'g'.repeat(65) })], 'DRAFT')
      )
    ).toEqual(['STEP_PARALLEL_GROUP_TOO_LONG']);
  });

  it('accepts a PARALLEL step with its label, and refuses a label outside a parallel group', () => {
    expect(
      refusals(inspect([step({ executionMode: 'PARALLEL', parallelGroup: 'branch-a' })], 'DRAFT'))
    ).toEqual([]);

    // "NULL for steps outside a parallel group": a label here names a group this step is not in,
    // so it is a stated setting nothing reads.
    for (const executionMode of ['SEQUENTIAL', 'CONDITIONAL'] as const) {
      const report = inspect(
        [
          step({
            executionMode,
            parallelGroup: 'branch-a',
            ...(executionMode === 'CONDITIONAL' ? { condition: { field: 'amount' } } : {}),
          }),
        ],
        'DRAFT'
      );

      expect({ executionMode, refused: refusals(report) }).toEqual({
        executionMode,
        refused: ['STEP_PARALLEL_GROUP_UNEXPECTED'],
      });
    }
  });

  it('requires a condition for CONDITIONAL, and refuses one no other mode evaluates', () => {
    expect(refusals(inspect([step({ executionMode: 'CONDITIONAL' })], 'DRAFT'))).toEqual([
      'STEP_CONDITION_REQUIRED',
    ]);

    for (const executionMode of ['SEQUENTIAL', 'PARALLEL'] as const) {
      const report = inspect(
        [
          step({
            executionMode,
            condition: { field: 'amount' },
            ...(executionMode === 'PARALLEL' ? { parallelGroup: 'branch-a' } : {}),
          }),
        ],
        'DRAFT'
      );

      expect({ executionMode, refused: refusals(report) }).toEqual({
        executionMode,
        refused: ['STEP_CONDITION_UNEXPECTED'],
      });
    }
  });

  it('turns each finding of the borrowed walk into ONE refusal, carrying the path it reported', () => {
    // The walk is a stub on purpose: what is pinned here is that a finding becomes a
    // `STEP_CONDITION_INVALID` whose `path` locates it INSIDE the condition — so an administrator
    // fixing a tree is told where the defect is rather than that something is wrong.
    const report = inspect(
      [step({ executionMode: 'CONDITIONAL', condition: { all: [] } })],
      'DRAFT',
      { conditionIssues: () => [{ path: 'all[0].field', reason: 'unknown node kind' }] }
    );

    expect(report.issues).toEqual([
      {
        refusal: 'STEP_CONDITION_INVALID',
        stepKey: 'check-budget',
        path: 'condition.all[0].field',
        detail: 'unknown node kind',
      },
    ]);
  });

  it('walks a RULE_RESOLVER’s actor rule with the SAME borrowed walk, under its own path', () => {
    const report = inspect(
      [step({ actorSource: 'RULE_RESOLVER', actorRule: { field: 'amount' } })],
      'DRAFT',
      { conditionIssues: () => [{ path: 'op', reason: 'unknown operator' }] }
    );

    expect(report.issues).toEqual([
      {
        refusal: 'STEP_CONDITION_INVALID',
        stepKey: 'check-budget',
        path: 'actorRule.op',
        detail: 'unknown operator',
      },
    ]);
  });
});

describe('Phase C1 Step M — the actor rules (§5.8)', () => {
  it('refuses the three sources that are not executable in C1 N, at PUBLISH', () => {
    for (const actorSource of [
      'REQUESTER_MANAGER',
      'GROUP_MANAGER',
      'COMMERCIAL_LIAISON',
    ] as const) {
      expect({
        actorSource,
        refused: refusals(inspect([step({ actorSource })], 'PUBLISH')),
      }).toEqual({
        actorSource,
        refused: ['WORKFLOW_ACTOR_SOURCE_UNSUPPORTED'],
      });
    }
  });

  it('requires the ONE parameter each configurable source is resolved by', () => {
    // The pairing comes from `WORKFLOW_ACTOR_SOURCE_PARAMETERS`; the expectation states it
    // independently, so flipping a pair in the map fails here rather than at runtime.
    const cases = [
      ['CONFIGURED_USER', 'actorUserId'],
      ['CONFIGURED_ROLE', 'actorRoleCode'],
    ] as const;

    for (const [actorSource, parameter] of cases) {
      const report = inspect([step({ actorSource })], 'DRAFT');
      expect({ actorSource, refused: refusals(report), path: report.issues[0]?.path }).toEqual({
        actorSource,
        refused: ['STEP_ACTOR_PARAMETER_MISSING'],
        path: parameter,
      });
    }
  });

  it('counts a BLANK parameter as missing, and accepts each parameter beside its own source', () => {
    expect(
      refusals(inspect([step({ actorSource: 'CONFIGURED_USER', actorUserId: '  ' })], 'DRAFT'))
    ).toEqual(['STEP_ACTOR_PARAMETER_MISSING']);

    expect(
      refusals(inspect([step({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1' })], 'DRAFT'))
    ).toEqual([]);
    expect(
      refusals(
        inspect([step({ actorSource: 'CONFIGURED_ROLE', actorRoleCode: 'ROLE_BUYER' })], 'DRAFT')
      )
    ).toEqual([]);
    expect(
      refusals(inspect([step({ actorSource: 'RULE_RESOLVER', actorRule: {} })], 'DRAFT'))
    ).toEqual([]);
  });

  it('refuses a parameter a different source resolves by — nobody should have to guess which of the two was meant', () => {
    expect(
      refusals(inspect([step({ actorSource: 'REQUESTER_MANAGER', actorUserId: 'u1' })], 'DRAFT'))
    ).toEqual(['STEP_ACTOR_PARAMETER_UNEXPECTED']);
    expect(
      refusals(
        inspect(
          [step({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1', actorRoleCode: 'ROLE' })],
          'DRAFT'
        )
      )
    ).toEqual(['STEP_ACTOR_PARAMETER_UNEXPECTED']);
  });

  it('refuses a source outside the vocabulary, and any parameter stated beside NO source', () => {
    expect(refusals(inspect([step({ actorSource: 'EVERYONE' as never })], 'DRAFT'))).toEqual([
      'STEP_ACTOR_SOURCE_UNSUPPORTED',
    ]);
    expect(refusals(inspect([step({ actorUserId: 'u1' })], 'DRAFT'))).toEqual([
      'STEP_ACTOR_PARAMETER_UNEXPECTED',
    ]);
  });

  it('ALLOWS an absent source while authoring and REFUSES it at publish — the levels differ here', () => {
    // §5.8's one completeness difference: the schema says `actorSource` "is NULLABLE because a
    // DRAFT version may be incomplete", and a version whose actor is unresolved cannot decide.
    expect(inspect([step()], 'DRAFT').valid).toBe(true);
    expect(refusals(inspect([step()], 'PUBLISH'))).toEqual(['STEP_ACTOR_SOURCE_MISSING']);
  });
});

describe('Phase C1 Step M — the named payloads (§5.6, §6)', () => {
  it('takes each payload as a JSON OBJECT when present, and refuses an array or a scalar', () => {
    expect(refusals(inspect([step({ thresholds: [] })], 'DRAFT'))).toEqual([
      'STEP_THRESHOLDS_NOT_AN_OBJECT',
    ]);
    expect(refusals(inspect([step({ lineFilters: 'category' })], 'DRAFT'))).toEqual([
      'STEP_LINE_FILTERS_NOT_AN_OBJECT',
    ]);
    expect(refusals(inspect([step({ configuration: 5 })], 'DRAFT'))).toEqual([
      'STEP_CONFIGURATION_NOT_AN_OBJECT',
    ]);
  });

  it('accepts ANY object a tenant states, because no vocabulary for these is invented', () => {
    const report = inspect(
      [
        step({
          thresholds: { cash: 1000 },
          lineFilters: { category: 'IT' },
          configuration: { visibleFields: ['amount', 'supplier'] },
        }),
      ],
      'DRAFT'
    );

    expect(report.valid).toBe(true);
  });

  it('bounds §6’s visibleFields to a list of non-blank names, and reads an empty list as “nothing visible”', () => {
    expect(
      refusals(inspect([step({ configuration: { visibleFields: 'amount' } })], 'DRAFT'))
    ).toEqual(['STEP_VISIBLE_FIELDS_INVALID']);
    expect(
      refusals(inspect([step({ configuration: { visibleFields: ['amount', ' '] } })], 'DRAFT'))
    ).toEqual(['STEP_VISIBLE_FIELDS_INVALID']);

    // AN EMPTY LIST IS A STATEMENT, NOT A DEFECT: the rule bounds the count and refuses blank
    // names, and "show none of them" is a configuration an author may state.
    expect(refusals(inspect([step({ configuration: { visibleFields: [] } })], 'DRAFT'))).toEqual(
      []
    );
    expect(
      refusals(inspect([step({ configuration: { visibleFields: ['amount'] } })], 'DRAFT'))
    ).toEqual([]);
  });

  it('reports the platform’s payload scan as ONE refusal, at the path it named', () => {
    const report = inspect([step()], 'DRAFT', {
      unsafePayload: () => ({ path: 'displayName', reason: 'a control character' }),
    });

    expect(report.issues).toEqual([
      {
        refusal: 'STEP_PAYLOAD_UNSAFE',
        stepKey: 'check-budget',
        path: 'displayName',
        detail: 'a control character',
      },
    ]);
  });
});

describe('Phase C1 Step M — the set-level rules (§11, §34)', () => {
  it('allows an EMPTY draft and refuses an empty publication', () => {
    expect(inspect([], 'DRAFT')).toEqual({
      valid: true,
      level: 'DRAFT',
      issues: [],
      truncated: false,
    });

    // §11: a configuration with no steps routes nothing to nobody, so the publication gate refuses
    // a structurally invalid workflow rather than making it what purchases are governed by.
    expect(refusals(inspect([], 'PUBLISH'))).toEqual(['VERSION_HAS_NO_STEPS']);
  });

  it('reports a duplicated key ONCE, naming the key, however many steps state it', () => {
    const report = inspect(
      [step({ ordering: 1 }), step({ stepKey: 'other', ordering: 2 }), step({ ordering: 3 })],
      'DRAFT'
    );

    expect(refusals(report)).toEqual(['STEP_KEY_DUPLICATED']);
    expect(report.issues[0]).toEqual({
      refusal: 'STEP_KEY_DUPLICATED',
      stepKey: 'check-budget',
      detail: 'stated by 2 steps',
    });
  });

  it('reports a duplicated position ONCE, naming the position', () => {
    const report = inspect(
      [
        step({ stepKey: 'a', ordering: 2 }),
        step({ stepKey: 'b', ordering: 2 }),
        step({ stepKey: 'c', ordering: 2 }),
      ],
      'DRAFT'
    );

    expect(refusals(report)).toEqual(['STEP_ORDERING_DUPLICATED']);
    expect(issueFor(report, 'STEP_ORDERING_DUPLICATED')).toEqual({
      refusal: 'STEP_ORDERING_DUPLICATED',
      path: 'ordering',
      detail: 'position 2 is stated by 3 steps',
    });
  });

  it('echoes the LEVEL it was checked at, because the two are different claims about one body', () => {
    expect(inspect([step()], 'DRAFT').level).toBe('DRAFT');
    expect(inspect([step({ actorSource: 'REQUESTER_MANAGER' })], 'PUBLISH').level).toBe('PUBLISH');
  });

  it('reports EVERY defect rather than the first, and BOUNDS the report rather than the payload', () => {
    const broken = Array.from({ length: WORKFLOW_MAX_REPORTED_ISSUES + 6 }, (_, index) =>
      step({ stepKey: `step-${index + 1}`, displayName: ' ', ordering: index + 1 })
    );

    const report = inspect(broken, 'DRAFT');

    expect(report.issues.length).toBe(WORKFLOW_MAX_REPORTED_ISSUES);
    expect(report.truncated).toBe(true);
    expect(report.valid).toBe(false);
    // Each reported issue is about ONE broken step and carries that step's own key, so a truncated
    // report is still actionable for the sixty-four it does describe.
    expect(report.issues.every((issue) => issue.refusal === 'STEP_DISPLAY_NAME_MISSING')).toBe(
      true
    );
    expect(report.issues.every((issue) => typeof issue.stepKey === 'string')).toBe(true);
  });

  it('says `truncated: false` when the bound was not reached — a short list must not read as clipped', () => {
    const almost = Array.from({ length: WORKFLOW_MAX_REPORTED_ISSUES - 1 }, (_, index) =>
      step({ stepKey: `step-${index + 1}`, displayName: ' ', ordering: index + 1 })
    );

    const report = inspect(almost, 'DRAFT');

    expect(report.issues.length).toBe(WORKFLOW_MAX_REPORTED_ISSUES - 1);
    expect(report.truncated).toBe(false);
  });

  it('states its vocabulary ONCE: no repeat, and every refusal emitted here is a member', () => {
    expect(new Set(WORKFLOW_CONFIGURATION_REFUSALS).size).toBe(
      WORKFLOW_CONFIGURATION_REFUSALS.length
    );

    // Non-vacuity: the members the tests above rely on must be present, so the vocabulary cannot be
    // emptied without this suite noticing.
    expect(WORKFLOW_CONFIGURATION_REFUSALS).toEqual(
      expect.arrayContaining([
        'STEP_KEY_MISSING',
        'STEP_KEY_DUPLICATED',
        'STEP_ORDERING_DUPLICATED',
        'STEP_ACTOR_SOURCE_MISSING',
        'STEP_ACTOR_PARAMETER_MISSING',
        'STEP_PAYLOAD_UNSAFE',
        'STEP_CONDITION_INVALID',
        'VERSION_HAS_NO_STEPS',
      ])
    );

    // Every refusal one messy version produces is a member of the closed set — the property a spec
    // enumerating the vocabulary exists for.
    const messy = [
      step({
        stepKey: ' ',
        displayName: ' ',
        ordering: 0,
        executionMode: 'CONDITIONAL',
        actorUserId: 'u1',
        thresholds: [],
      }),
      step({ stepKey: 'dup', ordering: 1, actorSource: 'EVERYONE' as never, lineFilters: 5 }),
      step({
        stepKey: 'dup',
        ordering: 1,
        actorSource: 'RULE_RESOLVER',
        actorRule: { field: 'x' },
        configuration: { visibleFields: 'x' },
      }),
    ];
    const report = inspect(messy, 'DRAFT', {
      conditionIssues: () => [{ path: 'op', reason: 'unknown operator' }],
      unsafePayload: () => ({ path: 'thresholds', reason: 'a payload shape' }),
    });

    expect(report.valid).toBe(false);
    expect(report.issues.length).toBeGreaterThan(6);
    for (const issue of report.issues) {
      expect({
        refusal: issue.refusal,
        member: WORKFLOW_CONFIGURATION_REFUSALS.includes(issue.refusal),
      }).toEqual({ refusal: issue.refusal, member: true });
    }
  });
});
