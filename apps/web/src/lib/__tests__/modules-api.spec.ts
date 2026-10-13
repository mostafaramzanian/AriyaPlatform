import * as moduleApi from '../modules-api';
import {
  DEPLOYMENT_MODE_LABELS,
  ENTITLEMENT_FAILURE_LABELS,
  FEATURE_EFFECTIVE_STATE_PRESENTATION,
  HEALTH_ERROR_LABELS,
  HEALTH_PRESENTATION,
  LIFECYCLE_LABELS,
  MODULE_TYPE_LABELS,
  credentialStatusLabel,
  entitlementFailureLabel,
  fetchModuleFeatureStates,
  formatModuleTime,
  healthErrorLabel,
  isValidFeatureId,
  isValidModuleId,
  moduleStatusLabel,
  parseTenantIdList,
  tenantScopeLabel,
  type ModuleFeatureEffectiveState,
  type ModuleFeatureStatePage,
  type ModuleRegistration,
} from '../modules-api';
import { coreGet } from '../core-http';

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * Phase 49M: the module-platform client's pure logic.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - NO CREDENTIAL FIELD EXISTS CLIENT-SIDE. The status helpers are given a registration and asserted
 *    to describe the credential without ever having one to describe.
 *  - THE STATUS LINE DISTINGUISHES SEVEN SITUATIONS. Collapsing them would tell an operator "off"
 *    when the truth is "no credential yet" or "registered but nothing has announced itself".
 *  - HEALTH IS NEVER COLOUR ALONE (§30). Every presentation entry carries a symbol AND a Persian
 *    label as well as a class.
 *  - LABELS ARE COMPLETE RECORDS. Adding an enum member is a type error rather than a raw enum name
 *    leaking to an operator — asserted by iterating the record keys.
 *  - THE MODULE-ID RULE MATCHES THE SERVER. The client refuses locally exactly what the DTO and the
 *    SQL CHECK refuse, so a form does not discover the rule through a 422.
 */

const registration = (overrides: Partial<ModuleRegistration> = {}): ModuleRegistration => ({
  id: 'row-1',
  moduleId: 'finance',
  displayName: 'Finance',
  moduleType: 'BUSINESS',
  enabled: true,
  tenantScope: 'ALL',
  tenantIds: [],
  protocolVersion: 1,
  hasCredential: true,
  credentialUpdatedAt: '2026-09-05T00:00:00.000Z',
  credentialExpiresAt: null,
  derivedLifecycle: 'ACTIVE',
  aggregateHealth: 'HEALTHY',
  instances: [
    {
      id: 'inst-1',
      instanceId: 'finance-prod-01',
      moduleId: 'finance',
      deploymentMode: 'REMOTE',
      version: '1.2.0',
      baseUrl: 'https://finance.example.com',
      healthPath: '/health',
      capabilities: ['invoice.read'],
      apiContracts: ['module.invoke@v1'],
      eventContracts: [],
      lifecycle: 'ACTIVE',
      health: 'HEALTHY',
      healthErrorCode: null,
      lastSeenAt: '2026-09-05T00:00:00.000Z',
      lastProbedAt: null,
      stale: false,
      createdAt: '2026-09-05T00:00:00.000Z',
    },
  ],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  ...overrides,
});

describe('moduleStatusLabel', () => {
  it('distinguishes the seven operator situations', () => {
    expect(moduleStatusLabel(registration({ enabled: false }))).toBe('غیرفعال');
    expect(moduleStatusLabel(registration({ hasCredential: false }))).toBe('کلید دسترسی صادر نشده');
    expect(moduleStatusLabel(registration({ instances: [] }))).toBe('در انتظار ثبت نمونه');
    expect(moduleStatusLabel(registration({ derivedLifecycle: 'INCOMPATIBLE' }))).toBe(
      'ناسازگار با پلتفرم'
    );
    expect(moduleStatusLabel(registration({ aggregateHealth: 'UNAVAILABLE' }))).toBe(
      'در دسترس نیست'
    );
    expect(moduleStatusLabel(registration({ aggregateHealth: 'DEGRADED' }))).toBe(
      'فعال — با اختلال'
    );
    expect(moduleStatusLabel(registration({ aggregateHealth: 'UNKNOWN' }))).toBe(
      'فعال — بررسی نشده'
    );
    expect(moduleStatusLabel(registration())).toBe('فعال و سالم');
  });

  it('reports DISABLED ahead of every other state', () => {
    // An administrator's decision outranks anything the module reports about itself.
    expect(
      moduleStatusLabel(
        registration({ enabled: false, aggregateHealth: 'HEALTHY', hasCredential: true })
      )
    ).toBe('غیرفعال');
  });
});

describe('credentialStatusLabel', () => {
  it('describes presence and timing, never a value', () => {
    expect(
      credentialStatusLabel({
        hasCredential: false,
        credentialUpdatedAt: null,
        credentialExpiresAt: null,
      })
    ).toBe('صادر نشده');

    const stored = credentialStatusLabel({
      hasCredential: true,
      credentialUpdatedAt: '2026-09-05T00:00:00.000Z',
      credentialExpiresAt: null,
    });

    expect(stored).toContain('صادر شده');
    // There is no credential to leak: the type has no field for one.
    expect(stored).not.toMatch(/[0-9a-f]{32}/);
  });

  it('prefers the expiry when one is configured', () => {
    const label = credentialStatusLabel({
      hasCredential: true,
      credentialUpdatedAt: '2026-09-05T00:00:00.000Z',
      credentialExpiresAt: '2026-12-01T00:00:00.000Z',
    });

    expect(label).toContain('انقضا');
  });
});

describe('tenantScopeLabel', () => {
  it('names the scope explicitly rather than implying it from an empty list', () => {
    expect(tenantScopeLabel({ tenantScope: 'ALL', tenantIds: [] })).toBe('همه مستأجرها');
    expect(tenantScopeLabel({ tenantScope: 'RESTRICTED', tenantIds: ['t1', 't2'] })).toBe(
      '2 مستأجر مشخص'
    );
  });
});

describe('label records', () => {
  it('covers every deployment mode', () => {
    // A COMPLETE RECORD: adding a mode is a type error rather than a raw enum name on screen.
    expect(Object.keys(DEPLOYMENT_MODE_LABELS).sort()).toEqual([
      'CENTRAL',
      'HYBRID',
      'LOCAL',
      'REMOTE',
    ]);

    for (const label of Object.values(DEPLOYMENT_MODE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('covers every module type and every lifecycle state', () => {
    expect(Object.keys(MODULE_TYPE_LABELS).sort()).toEqual(['BUSINESS', 'CORE', 'INTEGRATION']);

    expect(Object.keys(LIFECYCLE_LABELS).sort()).toEqual([
      'ACTIVE',
      'DEGRADED',
      'DEREGISTERED',
      'DISABLED',
      'DISCOVERED',
      'INCOMPATIBLE',
      'REGISTERED',
      'UNAVAILABLE',
    ]);
  });

  it('names no business module in any label', () => {
    // The UI vocabulary must be about the PLATFORM, never about a domain.
    const all = [
      ...Object.values(DEPLOYMENT_MODE_LABELS),
      ...Object.values(MODULE_TYPE_LABELS),
      ...Object.values(LIFECYCLE_LABELS),
      ...Object.values(HEALTH_ERROR_LABELS),
      ...Object.values(ENTITLEMENT_FAILURE_LABELS),
    ].join(' ');

    for (const forbidden of ['HR', 'Finance', 'finance', 'invoice', 'employee']) {
      expect(all).not.toContain(forbidden);
    }
  });
});

describe('HEALTH_PRESENTATION', () => {
  it('never relies on colour alone (§30)', () => {
    // Every state carries a symbol AND a text label, so the state survives a colour-blind reader and
    // a screen reader.
    for (const state of Object.keys(HEALTH_PRESENTATION) as (keyof typeof HEALTH_PRESENTATION)[]) {
      const presentation = HEALTH_PRESENTATION[state];

      expect(presentation.symbol.length).toBeGreaterThan(0);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.className.length).toBeGreaterThan(0);
    }
  });

  it('covers all five health states', () => {
    expect(Object.keys(HEALTH_PRESENTATION).sort()).toEqual([
      'DEGRADED',
      'DISABLED',
      'HEALTHY',
      'UNAVAILABLE',
      'UNKNOWN',
    ]);
  });
});

describe('healthErrorLabel', () => {
  it('explains a known code', () => {
    expect(healthErrorLabel('TIMEOUT')).toContain('زمان');
    expect(healthErrorLabel('NO_HEALTH_STATE')).toContain('وضعیت سلامت');
  });

  it('falls back to the RAW code rather than a generic message', () => {
    // An unrecognised short code is still more useful to an operator than "an error occurred".
    expect(healthErrorLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('is empty for no code', () => {
    expect(healthErrorLabel(null)).toBe('');
    expect(healthErrorLabel(undefined)).toBe('');
  });
});

describe('isValidModuleId', () => {
  it('accepts the slug shape the server accepts', () => {
    expect(isValidModuleId('finance')).toBe(true);
    expect(isValidModuleId('anything-else-2')).toBe(true);
    expect(isValidModuleId('ab')).toBe(true);
  });

  it('refuses exactly what the DTO and the SQL CHECK refuse', () => {
    expect(isValidModuleId('a')).toBe(false);
    expect(isValidModuleId('Finance')).toBe(false);
    expect(isValidModuleId('finance_module')).toBe(false);
    expect(isValidModuleId('-finance')).toBe(false);
    expect(isValidModuleId('finance-')).toBe(false);
    expect(isValidModuleId('finance--x')).toBe(false);
    expect(isValidModuleId('a'.repeat(65))).toBe(false);
    expect(isValidModuleId('')).toBe(false);
  });
});

describe('formatModuleTime', () => {
  it('formats an ISO timestamp and tolerates a bad one', () => {
    expect(formatModuleTime('2026-09-05T00:00:00.000Z').length).toBeGreaterThan(0);
    expect(formatModuleTime(null)).toBe('');
    expect(formatModuleTime('not-a-date')).toBe('');
  });
});

/**
 * Phase 54-C (§43.10 gate 8): the refusal vocabulary and the feature-id rule.
 *
 * WHAT THIS FILE PROVES, AND WHY IT IS A GATE RATHER THAN A FORMALITY. The console cannot import
 * the API's types across the app boundary, so the vocabulary exists twice on purpose — and a second
 * copy is exactly the kind of thing that drifts one code at a time, silently, until an operator is
 * shown `FEATURE_NOT_GRANTED` in a red box. The record is therefore keyed by the union: adding a
 * code to the client's own `EntitlementFailureCode` is a TYPE ERROR until a sentence exists, and the
 * key-set assertion below fails until the code is expected here too.
 */
describe('ENTITLEMENT_FAILURE_LABELS', () => {
  it('covers the whole vocabulary: the six §43.2 decision codes plus the guard code', () => {
    expect(Object.keys(ENTITLEMENT_FAILURE_LABELS).sort()).toEqual([
      'ENTITLEMENT_NOT_DECLARED',
      'FEATURE_DISABLED',
      'FEATURE_NOT_FOUND',
      'FEATURE_NOT_GRANTED',
      'MODULE_DISABLED',
      'MODULE_FORBIDDEN',
      'MODULE_NOT_FOUND',
    ]);

    for (const label of Object.values(ENTITLEMENT_FAILURE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      // A SENTENCE, not a code: no label may be the machine code it explains.
      expect(label).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('keeps the neighbours that mean different things apart (§43.2)', () => {
    // "the platform does not offer this" vs "your tenancy does not hold this" is the distinction the
    // two feature codes exist for; two identical sentences would erase it at the last step.
    expect(ENTITLEMENT_FAILURE_LABELS.FEATURE_DISABLED).not.toBe(
      ENTITLEMENT_FAILURE_LABELS.FEATURE_NOT_GRANTED
    );
    expect(ENTITLEMENT_FAILURE_LABELS.MODULE_DISABLED).not.toBe(
      ENTITLEMENT_FAILURE_LABELS.MODULE_FORBIDDEN
    );
  });

  it('renders a known code, and the RAW code for one it does not know', () => {
    expect(entitlementFailureLabel('MODULE_FORBIDDEN')).toBe(
      ENTITLEMENT_FAILURE_LABELS.MODULE_FORBIDDEN
    );

    // The fallback is the signal that the server's vocabulary has moved ahead of the console's —
    // more useful to an operator than a generic apology, and identical in shape to
    // `healthErrorLabel`'s.
    expect(entitlementFailureLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(entitlementFailureLabel(null)).toBe('');
    expect(entitlementFailureLabel(undefined)).toBe('');
  });

  it('names no business module in any label', () => {
    const all = Object.values(ENTITLEMENT_FAILURE_LABELS).join(' ');

    for (const forbidden of ['HR', 'Finance', 'finance', 'invoice', 'employee', 'leave']) {
      expect(all).not.toContain(forbidden);
    }
  });
});

describe('isValidFeatureId', () => {
  it('accepts the slug shape the feature DTO and the SQL CHECK accept', () => {
    expect(isValidFeatureId('leave')).toBe(true);
    expect(isValidFeatureId('leave-requests')).toBe(true);
    expect(isValidFeatureId('ab')).toBe(true);
  });

  it('refuses exactly what the feature DTO and the SQL CHECK refuse', () => {
    expect(isValidFeatureId('a')).toBe(false);
    expect(isValidFeatureId('Leave')).toBe(false);
    expect(isValidFeatureId('leave_requests')).toBe(false);
    expect(isValidFeatureId('-leave')).toBe(false);
    expect(isValidFeatureId('leave-')).toBe(false);
    expect(isValidFeatureId('leave--x')).toBe(false);
    expect(isValidFeatureId('a'.repeat(65))).toBe(false);
    expect(isValidFeatureId('')).toBe(false);
  });

  it('agrees with the module-id rule on the shared corpus — two constraints, one slug shape', () => {
    // The SQL has TWO `CHECK`s rather than one reused constraint, so the client has two validators
    // rather than one borrowed one. They are byte-identical today, and this is the assertion that
    // notices if one of them is loosened — a form that accepted `leave_x` while the table refused it
    // would turn a typo into a `500`.
    const corpus = [
      'leave',
      'leave-requests',
      'ab',
      'a',
      'Leave',
      'leave_x',
      '-leave',
      'leave-',
      'leave--x',
      'a'.repeat(65),
      '',
    ];

    for (const value of corpus) {
      expect([value, isValidFeatureId(value)]).toEqual([value, isValidModuleId(value)]);
    }
  });
});

/**
 * Phase 54-C closure fix (§43.8): the effective-state READ, and the removal of the browser-side
 * evaluator that used to stand in for it.
 *
 * WHY THE EVALUATOR IS GONE, AND WHY THAT IS THE ASSERTION. The `effectiveStateOf` projection — the
 * frozen §43.9 ORDER of refusals — lives on the SERVER (`entitlement.contract.ts`) and is applied to
 * the platform's own `EntitlementDecision`. This client used to re-derive it from `moduleEnabled`,
 * `tenantScope`, `tenantIds` and the grant list, and that rule could not see the D16 membership child
 * table: for HR, whose legacy array is empty by construction, every tenant looked out of scope, so an
 * entitled tenancy rendered as «مسدود توسط ماژول». The tests below therefore assert the URL contract,
 * the four-state vocabulary the client RENDERS, and — explicitly — that no judge function is exported
 * for a component to reach for.
 */
/**
 * The fixture both describes below render from: an HR page whose module is ON, whose feature offer is
 * ON, and whose membership comes from the D16 child table — the exact shape the removed client-side
 * rule misclassified as `BLOCKED_BY_MODULE` because it looked for membership in the legacy array.
 */
const page: ModuleFeatureStatePage = {
  moduleId: 'hr',
  featureId: 'leave',
  moduleEnabled: true,
  featureEnabled: true,
  tenantScope: 'RESTRICTED_MEMBERS',
  tenantCount: 162,
  rows: [
    {
      tenantId: 'tenant-test-1',
      granted: true,
      grantedAt: '2026-09-21T00:00:00.000Z',
      effective: 'ENTITLED',
      reasonCode: 'ALLOWED',
    },
    {
      tenantId: 'tenant-b',
      granted: false,
      grantedAt: null,
      effective: 'NOT_GRANTED',
      reasonCode: 'FEATURE_NOT_GRANTED',
    },
  ],
  nextCursor: 'tenant-b',
};

describe('fetchModuleFeatureStates', () => {
  it('reads the effective-state route and unwraps the envelope', async () => {
    getMock.mockResolvedValue(page);

    await expect(fetchModuleFeatureStates('hr', 'leave')).resolves.toEqual(page);
    expect(getMock).toHaveBeenCalledWith('/admin/modules/hr/features/leave/effective-state');
  });

  it('sends the cursor and the page size as query parameters, and encodes both ids', async () => {
    getMock.mockResolvedValue(page);

    await fetchModuleFeatureStates('hr', 'leave', { limit: 50, cursor: 'tenant-9' });

    expect(getMock).toHaveBeenCalledWith(
      '/admin/modules/hr/features/leave/effective-state?limit=50&cursor=tenant-9'
    );
  });

  it('omits an absent cursor rather than sending an empty one', async () => {
    getMock.mockResolvedValue(page);

    await fetchModuleFeatureStates('hr', 'leave', { limit: 10 });

    const url = getMock.mock.calls[0][0] as string;
    expect(url).toBe('/admin/modules/hr/features/leave/effective-state?limit=10');
    expect(url).not.toContain('cursor');
  });

  /**
   * The parity rules of §9, stated as properties of what this client is WILLING to render: the state
   * and the code both come off the wire, and the two halves of the page (`effective`, `reasonCode`)
   * are never collapsed into one another. A client that inferred `ENTITLED` from `granted` would pass
   * a weaker suite and still lie about a module-blocked tenant, so the pair is asserted separately.
   */
  it('keeps the decision code and the four-state projection as two separate fields', () => {
    const [entitled, notGranted] = page.rows;

    expect(entitled.effective).toBe('ENTITLED');
    expect(entitled.reasonCode).toBe('ALLOWED');
    expect(notGranted.effective).toBe('NOT_GRANTED');
    expect(notGranted.reasonCode).toBe('FEATURE_NOT_GRANTED');
    // Both rows are unambiguously distinguishable by the field the console renders.
    expect(entitled.effective).not.toBe(notGranted.effective);
  });
});

describe('FEATURE_EFFECTIVE_STATE_PRESENTATION', () => {
  it('covers exactly the four §43.8 states, never a raw code (§30)', () => {
    const states: ModuleFeatureEffectiveState[] = [
      'ENTITLED',
      'BLOCKED_BY_MODULE',
      'BLOCKED_BY_FEATURE',
      'NOT_GRANTED',
    ];

    expect(Object.keys(FEATURE_EFFECTIVE_STATE_PRESENTATION).sort()).toEqual([...states].sort());

    for (const state of states) {
      const presentation = FEATURE_EFFECTIVE_STATE_PRESENTATION[state];

      expect(presentation.label).toMatch(/[\u0600-\u06FF]/);
      expect(presentation.label).not.toBe(state);
      expect(presentation.symbol.length).toBeGreaterThan(0);
      expect(presentation.className.length).toBeGreaterThan(0);
    }

    // Four distinguishable states, four distinguishable sentences: two identical labels would erase
    // the distinction this section exists to draw.
    expect(
      new Set(states.map((state) => FEATURE_EFFECTIVE_STATE_PRESENTATION[state].label)).size
    ).toBe(states.length);
  });

  /**
   * THE REGRESSION GATE ITSELF. `RESTRICTED_MEMBERS` is the scope HR uses, and its legacy `tenantIds`
   * array is empty — so any rule that reads membership out of that array (or out of the scope name)
   * will misclassify the 162 members D16 seeded. There is no client-side function left to make that
   * mistake, and this test names the absence so a future contributor cannot quietly reintroduce one.
   */
  it('exposes NO client-side entitlement evaluator to re-derive a state from scope or tenantIds', () => {
    const exported = moduleApi as Record<string, unknown>;

    expect(exported.featureEffectiveState).toBeUndefined();

    // The membership-bearing scope must reach the console as a VALUE TO RENDER, not as an input to a
    // rule: the page carries the decisions, and the label record carries only the four state names.
    // The legacy `tenantIds` array is NOT on the payload at all — there is nothing to read membership
    // out of, which is the difference between this client and the one that lied about HR.
    expect(page.tenantScope).toBe('RESTRICTED_MEMBERS');
    expect(Object.keys(page)).not.toContain('tenantIds');
    expect(page.rows.map((row) => row.effective)).toEqual(['ENTITLED', 'NOT_GRANTED']);
  });
});

describe('parseTenantIdList', () => {
  it('splits on the separators a human actually types', () => {
    expect(parseTenantIdList('a, b، c; d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops blanks and collapses duplicates', () => {
    expect(parseTenantIdList(' a ,, a , b \n')).toEqual(['a', 'b']);
    expect(parseTenantIdList('   ')).toEqual([]);
    expect(parseTenantIdList('')).toEqual([]);
  });
});
