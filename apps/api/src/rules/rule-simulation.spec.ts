import { Test } from '@nestjs/testing';
import { RuleFieldCatalogue } from './rule-condition.interface';
import {
  EvaluationContext,
  RULE_SIMULATION_BANNER,
  RULE_SIMULATION_MODE,
} from './rule-evaluation.interface';
import { RuleSetVersion } from './rule-spec.interface';
import { RuleEngineService } from './rule-engine.service';
import { RuleRegistryService } from './rule-registry.service';
import { PureRuleEngineModule } from './pure-rule-engine.module';
import { RULE_ENGINE_SCHEMA_VERSION } from './core/rule-limits';

/**
 * §38.2 gate 9 — the **simulation gate** (§14).
 *
 * The gate exists because "preview" is where a policy engine most easily becomes two engines: a
 * simplified evaluator for the preview and the real one for the decision. The assertions below refuse
 * that — a simulation is the real engine (same validation, same ordering, same match history), its
 * answer is labelled so a screenshot cannot be mistaken for a decision (§14.5), and it changes
 * nothing, because there is nothing it *could* change: the engine holds values, not data (§9.1, D12).
 */

const SET_ID = 'hr.leave.allowance';

const CATALOGUE: RuleFieldCatalogue = [
  { name: 'employmentType', type: 'enum', enumValues: ['PERMANENT', 'CONTRACT'] },
  {
    name: 'sickRequests',
    type: 'collection',
    maxSize: 50,
    itemFields: [{ name: 'leaveTypeRef', type: 'string' }],
  },
];

const CONTEXT: EvaluationContext = {
  evaluationInstant: '2024-06-01T00:00:00.000Z',
  facts: {
    employmentType: 'CONTRACT',
    sickRequests: [
      { leaveTypeRef: 'SICK' },
      { leaveTypeRef: 'SICK' },
      { leaveTypeRef: 'SICK' },
      { leaveTypeRef: 'ANNUAL' },
    ],
  },
};

const VERSION: RuleSetVersion = {
  ruleSetId: SET_ID,
  version: '1',
  status: 'PUBLISHED',
  schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
  fields: CATALOGUE,
  rules: [
    {
      id: 'hr.leave.allowance.contract-sick',
      version: '1',
      name: 'Contract sick limit',
      priority: 30,
      condition: {
        all: [
          { field: 'employmentType', op: 'equals', value: 'CONTRACT' },
          {
            count: {
              over: 'sickRequests',
              where: [{ field: 'leaveTypeRef', op: 'equals', value: 'SICK' }],
              op: 'greaterThanOrEqual',
              value: 3,
            },
          },
        ],
      },
      actions: [
        {
          type: 'LIMIT_REFUSAL',
          limitRef: 'limit.contract.sick',
          countingBasis: 'REQUEST_COUNT',
          maximum: 3,
          windowStart: '2024-01-01',
          windowEnd: '2024-12-31',
        },
      ],
    },
  ],
};

describe('§38.2 gate 9 — a simulation is the real engine, labelled, and applies nothing', () => {
  let registry: RuleRegistryService;
  let engine: RuleEngineService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PureRuleEngineModule],
    }).compile();

    registry = moduleRef.get<RuleRegistryService>(RuleRegistryService);
    engine = moduleRef.get<RuleEngineService>(RuleEngineService);
  });

  it('answers with the real decision and labels it as a simulation', () => {
    registry.registerVersion({ ...VERSION, status: 'VALIDATED' });
    expect(registry.publishVersion(registry.getVersion(SET_ID, '1')!).planned).toBe(true);

    const outcome = engine.simulateVersion(SET_ID, '1', CONTEXT);
    expect(outcome.evaluated).toBe(true);
    if (!outcome.evaluated) return;

    const simulation = outcome.result;
    const real = engine.evaluateSync(VERSION, CONTEXT);

    expect(simulation.mode).toBe(RULE_SIMULATION_MODE);
    expect(simulation.banner).toBe(RULE_SIMULATION_BANNER);
    expect(simulation.wouldApply).toEqual(real.decisionActions);
    expect(simulation.decision).toEqual(real.decision);
    expect(simulation.status).toBe(real.status);
    expect(simulation.winningRule).toEqual(real.winningRule);
    expect(simulation.matchHistory).toEqual(real.matchHistory);
    expect(simulation.explanationText).toBe(real.explanationText);
    expect(simulation.validation).toEqual(real.validation);
    expect(simulation.observedCounts).toEqual([{ over: 'sickRequests', count: 3 }]);

    /** §14.5: the label travels in the response, so the payload itself cannot read as a decision. */
    expect(JSON.stringify(simulation)).toContain(RULE_SIMULATION_BANNER);
    expect(JSON.stringify(real)).not.toContain(RULE_SIMULATION_BANNER);
  });

  it('changes nothing in the store', () => {
    registry.registerVersion({ ...VERSION, status: 'VALIDATED' });
    expect(registry.publishVersion(registry.getVersion(SET_ID, '1')!).planned).toBe(true);

    const before = registry.listVersions(SET_ID);
    const statusBefore = registry.versionStatus(SET_ID, '1');

    expect(engine.simulateVersion(SET_ID, '1', CONTEXT).evaluated).toBe(true);
    expect(engine.simulateSync(VERSION, CONTEXT).status).toBe('DECIDED');

    expect(registry.listVersions(SET_ID)).toEqual(before);
    expect(registry.versionStatus(SET_ID, '1')).toEqual(statusBefore);
  });

  it('simulates a draft as a value, while a draft may not decide', () => {
    const draft: RuleSetVersion = { ...VERSION, status: 'DRAFT' };
    registry.registerVersion(draft);

    const simulated = engine.simulateSync(draft, CONTEXT);
    expect(simulated.mode).toBe('SIMULATION');
    expect(simulated.decision).toEqual(VERSION.rules[0].actions[0]);

    /** Simulating is not deciding: the draft still may not stand for a business decision (§10.3). */
    const latest = engine.evaluateLatest(SET_ID, CONTEXT);
    expect(latest.evaluated).toBe(false);
    if (latest.evaluated) return;
    expect(latest.reason).toBe('RULE_SET_VERSION_NOT_EVALUABLE');

    /** A draft is simulated as the value it is; asking the store to simulate it as policy is refused. */
    const byId = engine.simulateVersion(SET_ID, '1', CONTEXT);
    expect(byId.evaluated).toBe(false);
    if (byId.evaluated) return;
    expect(byId.reason).toBe('RULE_SET_VERSION_NOT_EVALUABLE');
    if (byId.reason !== 'RULE_SET_VERSION_NOT_EVALUABLE') return;
    expect(byId.issue.code).toBe('RULE_SET_VERSION_NOT_PUBLISHABLE');

    expect(registry.versionStatus(SET_ID, '1')?.status).toBe('DRAFT');
  });

  it('refuses an unknown version as a typed outcome, never as an exception', () => {
    const outcome = engine.simulateVersion(SET_ID, '9', CONTEXT);

    expect(outcome.evaluated).toBe(false);
    if (outcome.evaluated) return;
    expect(outcome.reason).toBe('RULE_SET_VERSION_UNKNOWN');
    expect(outcome.ruleSetVersion).toBe('9');
  });
});
