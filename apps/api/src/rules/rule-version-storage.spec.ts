import { Test } from '@nestjs/testing';
import { RuleFieldCatalogue } from './rule-condition.interface';
import { EvaluationContext } from './rule-evaluation.interface';
import { RuleSetVersion } from './rule-spec.interface';
import { RuleEngineService } from './rule-engine.service';
import { RuleRegistryService } from './rule-registry.service';
import { PureRuleEngineModule } from './pure-rule-engine.module';
import { RULE_ENGINE_SCHEMA_VERSION } from './core/rule-limits';

/**
 * §38.2 gate 2 — the **versioning gate**.
 *
 * The four claims of the gate, each asserted at the layer that owns it:
 *
 *  1. a published version cannot be edited, and the refusal comes from the **store** (not from a UI
 *     convention) — so retrying the edit cannot succeed by another route;
 *  2. editing produces a *new* version, and the published text is retained verbatim (§10.6);
 *  3. an in-flight instance keeps the version it was opened with — a pinned reference is never
 *     silently re-resolved to "latest";
 *  4. a new request routes under the newly published version, while one published version per set
 *     exists at any time (§10.4).
 *
 * The spec runs on `PureRuleEngineModule` (§6.2) rather than on `RulesModule`: the versioned engine
 * must be usable by a runtime that never instantiates the example set, and this is what proves it.
 */

const CATALOGUE: RuleFieldCatalogue = [{ name: 'days', type: 'number' }];

const CONTEXT: EvaluationContext = {
  evaluationInstant: '2024-06-01T00:00:00.000Z',
  facts: { days: 3 },
};

const SET_ID = 'hr.leave.publish';

const APPROVE_VERSION: RuleSetVersion = {
  ruleSetId: SET_ID,
  version: '1',
  status: 'DRAFT',
  schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
  fields: CATALOGUE,
  rules: [
    {
      id: 'hr.leave.publish.auto-approve',
      version: '1',
      name: 'Short requests are approved',
      priority: 10,
      condition: { field: 'days', op: 'lessThanOrEqual', value: 5 },
      actions: [{ type: 'AUTO_APPROVE' }],
    },
  ],
};

const REJECT_VERSION: RuleSetVersion = {
  ruleSetId: SET_ID,
  version: '2',
  status: 'VALIDATED',
  schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
  fields: CATALOGUE,
  supersedes: '1',
  rules: [
    {
      id: 'hr.leave.publish.auto-approve',
      version: '2',
      name: 'Short requests are refused',
      priority: 10,
      condition: { field: 'days', op: 'lessThanOrEqual', value: 5 },
      actions: [{ type: 'AUTO_REJECT', reasonCode: 'policy.short-notice' }],
    },
  ],
};

describe('§38.2 gate 2 — published versions are immutable and routing follows the publish', () => {
  let registry: RuleRegistryService;
  let engine: RuleEngineService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PureRuleEngineModule],
    }).compile();

    registry = moduleRef.get<RuleRegistryService>(RuleRegistryService);
    engine = moduleRef.get<RuleEngineService>(RuleEngineService);
  });

  it('refuses to store a version that claims to be published', () => {
    expect(() => registry.registerVersion({ ...APPROVE_VERSION, status: 'PUBLISHED' })).toThrow(
      /publish plan/
    );
    expect(registry.getPublishedVersion(SET_ID)).toBeUndefined();
  });

  it('has no published version on day one, and says so as a value', () => {
    registry.registerVersion(APPROVE_VERSION);

    const outcome = engine.evaluateLatest(SET_ID, CONTEXT);

    expect(outcome.evaluated).toBe(false);
    if (outcome.evaluated) return;
    expect(outcome.reason).toBe('RULE_SET_VERSION_NOT_EVALUABLE');
    if (outcome.reason !== 'RULE_SET_VERSION_NOT_EVALUABLE') return;
    expect(outcome.ruleSetVersion).toBeNull();
    expect(outcome.issue.code).toBe('RULE_SET_VERSION_NOT_PUBLISHABLE');
    expect(outcome.validation).toBeNull();
  });

  it('edits a draft, refuses to edit it once published, and keeps the published text verbatim', () => {
    registry.registerVersion(APPROVE_VERSION);
    registry.updateDraft({ ...APPROVE_VERSION, status: 'VALIDATED' });
    expect(registry.versionStatus(SET_ID, '1')?.status).toBe('VALIDATED');

    const published = registry.publishVersion(registry.getVersion(SET_ID, '1')!);
    expect(published.planned).toBe(true);

    const stored = registry.getVersion(SET_ID, '1');
    expect(stored?.status).toBe('PUBLISHED');

    expect(() => registry.updateDraft({ ...APPROVE_VERSION, status: 'DRAFT' })).toThrow(
      /immutable/
    );

    registry.registerVersion(REJECT_VERSION);
    const second = registry.publishVersion(REJECT_VERSION);
    expect(second.planned).toBe(true);

    const after = registry.getVersion(SET_ID, '1');
    expect(after?.status).toBe('ARCHIVED');
    /** Retained verbatim (§10.6): only the lifecycle status moved, nothing was rewritten. */
    expect({ ...after, status: stored?.status }).toEqual(stored);
  });

  it('routes a new request under the newly published version, and keeps one published version', () => {
    registry.registerVersion({ ...APPROVE_VERSION, status: 'VALIDATED' });
    expect(registry.publishVersion(registry.getVersion(SET_ID, '1')!).planned).toBe(true);

    const before = engine.evaluateLatest(SET_ID, CONTEXT);
    expect(before.evaluated).toBe(true);
    if (!before.evaluated) return;
    expect(before.result.ruleSetVersion).toBe('1');
    expect(before.result.decision).toEqual({ type: 'AUTO_APPROVE' });

    registry.registerVersion(REJECT_VERSION);
    expect(registry.publishVersion(REJECT_VERSION).planned).toBe(true);

    const after = engine.evaluateLatest(SET_ID, CONTEXT);
    expect(after.evaluated).toBe(true);
    if (!after.evaluated) return;
    expect(after.result.ruleSetVersion).toBe('2');
    expect(after.result.decision).toEqual({
      type: 'AUTO_REJECT',
      reasonCode: 'policy.short-notice',
    });

    const statuses = registry.listVersions(SET_ID).map((version) => version.status);
    expect(statuses.filter((status) => status === 'PUBLISHED')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'ARCHIVED')).toHaveLength(1);
  });

  it('keeps an in-flight pinned version readable, and refuses to decide under a non-published one', () => {
    registry.registerVersion({ ...APPROVE_VERSION, status: 'VALIDATED' });
    expect(registry.publishVersion(registry.getVersion(SET_ID, '1')!).planned).toBe(true);

    /** What an in-flight instance stores: the (set id, version) it was opened under (§10.5). */
    const openedUnder = { ruleSetId: SET_ID, version: '1' };
    const before = engine.evaluateVersion(openedUnder.ruleSetId, openedUnder.version, CONTEXT);
    expect(before.evaluated).toBe(true);

    registry.registerVersion(REJECT_VERSION);
    expect(registry.publishVersion(REJECT_VERSION).planned).toBe(true);

    /** The pinned reference still resolves to *its own* text, never to the newly published version. */
    const pinned = registry.getVersion(openedUnder.ruleSetId, openedUnder.version);
    expect(pinned?.version).toBe('1');
    expect(pinned?.rules[0].id).toBe('hr.leave.publish.auto-approve');
    expect(pinned?.rules[0].version).toBe('1');
    expect(registry.getPublishedVersion(SET_ID)?.version).toBe('2');

    /** A new decision is not taken under an archived version, and the refusal names the version. */
    const refused = engine.evaluateVersion(openedUnder.ruleSetId, openedUnder.version, CONTEXT);
    expect(refused.evaluated).toBe(false);
    if (refused.evaluated) return;
    expect(refused.reason).toBe('RULE_SET_VERSION_NOT_EVALUABLE');
    if (refused.reason !== 'RULE_SET_VERSION_NOT_EVALUABLE') return;
    expect(refused.ruleSetVersion).toBe('1');
    expect(refused.issue.code).toBe('RULE_SET_VERSION_NOT_PUBLISHABLE');
    expect(refused.validation?.valid).toBe(true);
  });

  it('refuses an unknown version, and refuses a duplicate identity', () => {
    const unknown = engine.evaluateVersion(SET_ID, '9', CONTEXT);
    expect(unknown.evaluated).toBe(false);
    if (unknown.evaluated) return;
    expect(unknown.reason).toBe('RULE_SET_VERSION_UNKNOWN');
    expect(unknown.ruleSetVersion).toBe('9');

    registry.registerVersion(APPROVE_VERSION);
    expect(() => registry.registerVersion(APPROVE_VERSION)).toThrow(/already registered/);
  });
});
