import { coreGet, corePost } from '../core-http';
import {
  HR_LEAVE_LIMIT_RULE_SET_ID,
  fetchEffectiveLeavePolicy,
  fetchLeavePolicy,
  fetchLeavePolicyVersion,
  fetchPublishedLeavePolicyVersion,
  hrLeavePolicyVersionStatusLabel,
  hrLeavePolicyVersionStatusMeaning,
  hrSimulationDecisionLabel,
  simulateLeavePolicyVersion,
  type HrLeavePolicySimulationRequest,
} from '../hr-leave-policy-api';

/**
 * Phase 54-I (§12, §13, §14, §27): the leave-policy simulation CLIENT's contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two of this phase's guarantees live in the client and nowhere else, so they need a test at the
 * client's own boundary rather than inside a component:
 *
 *   1. **THE FORBIDDEN FIELDS.** The simulation body must not carry `level`, `evidenceLevel`, `role`,
 *      `permission` or `tenantId` (§27.2, §25.7, §33.8). `simulateLeavePolicyVersion` builds the body
 *      itself, so the guarantee is a property of THIS function — which means asserting it here is the
 *      only place the claim can actually be falsified.
 *   2. **THE OMITTED VERSION.** The server branches on the PRESENCE of `versionId` to tell "the
 *      effective published configuration" from "this exact version" (§14, Choice 1B). A client that
 *      sent `versionId: undefined` would serialise an explicit key and collapse that distinction, so
 *      the ABSENCE is asserted rather than the value.
 *
 * WHAT IT DOES NOT DO: it does not re-test `coreGet`/`corePost` (they have their own specs), and it
 * does not re-test the server's projection. Those own their rules; repeating them here would make this
 * file a second, disagreeing authority on decisions it does not make.
 */
jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;

const POLICY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

/** A minimal well-formed request; each case adjusts one member. */
const request = (
  overrides: Partial<HrLeavePolicySimulationRequest> = {}
): HrLeavePolicySimulationRequest => ({
  ruleSetId: HR_LEAVE_LIMIT_RULE_SET_ID,
  context: { leaveTypeId: 'lt-1' },
  ...overrides,
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('the simulation request body (§14, §27.2, §33.8)', () => {
  it('sends the rule-set constant the server validates against', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(POLICY_ID, request());

    expect(postMock).toHaveBeenCalledWith(
      `/hr/leave-policies/${POLICY_ID}/simulate`,
      expect.objectContaining({ ruleSetId: 'hr.leave.limit' })
    );
  });

  it('NEVER sends a client-chosen evidence level, role, permission or tenant', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(POLICY_ID, request());

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;

    // THE FIVE FORBIDDEN NAMES. Their ABSENCE is the fix 54-I made: a caller cannot name its own
    // disclosure, and tenancy is resolved from the actor (§24.1).
    for (const forbidden of ['level', 'evidenceLevel', 'role', 'permission', 'tenantId']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('OMITS versionId rather than sending it undefined, so the server can tell the two apart', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(POLICY_ID, request());

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;

    // ABSENCE, not `undefined`: the server branches on presence to distinguish "what governs now?"
    // from "this exact version" (§14, Choice 1B).
    expect(body).not.toHaveProperty('versionId');
  });

  it('sends versionId when the operator explicitly chose a version', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(POLICY_ID, request({ versionId: VERSION_ID }));

    expect(postMock.mock.calls[0][1]).toMatchObject({ versionId: VERSION_ID });
  });

  it('omits every unstated optional member, including the whole subject', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(POLICY_ID, request());

    const body = postMock.mock.calls[0][1] as { context: Record<string, unknown> };

    expect(body).not.toHaveProperty('evaluationInstant');
    expect(body).not.toHaveProperty('subject');
    expect(body.context).toEqual({ leaveTypeId: 'lt-1' });
  });

  it('forwards every stated optional member unchanged', async () => {
    postMock.mockResolvedValue({});

    await simulateLeavePolicyVersion(
      POLICY_ID,
      request({
        versionId: VERSION_ID,
        evaluationInstant: '2026-06-01T00:00:00.000Z',
        context: {
          leaveTypeId: 'lt-1',
          employmentType: 'CONTRACT',
          requestedFrom: '2026-03-01',
          requestedTo: '2026-03-03',
        },
        subject: { employeeId: 'emp-1' },
      })
    );

    expect(postMock.mock.calls[0][1]).toEqual({
      ruleSetId: 'hr.leave.limit',
      versionId: VERSION_ID,
      evaluationInstant: '2026-06-01T00:00:00.000Z',
      context: {
        leaveTypeId: 'lt-1',
        employmentType: 'CONTRACT',
        requestedFrom: '2026-03-01',
        requestedTo: '2026-03-03',
      },
      subject: { employeeId: 'emp-1' },
    });
  });

  it('returns the server response UNTOUCHED, never reshaped or recomputed', async () => {
    /**
     * THE PROJECTION IS THE SERVER'S (§27.2), so the client's only correct behaviour is to pass it
     * through. An identity assertion is used rather than spot checks precisely because the failure this
     * prevents is a client that "helpfully" adds a derived field or fills a withheld one in.
     */
    const response = {
      ruleSetId: 'hr.leave.limit',
      banner: 'SIMULATION — NO DATA CHANGED',
      explanation: { orderingBasis: null, failedLeaves: [] },
    };
    postMock.mockResolvedValue(response);

    const result = await simulateLeavePolicyVersion(POLICY_ID, request());

    expect(result).toBe(response);
  });
});

describe('the policy reads (§12, §15.4)', () => {
  it('resolves WHICH POLICY GOVERNS a leave type on a day — the surface entry point', async () => {
    getMock.mockResolvedValue({ policy: null, version: null, limits: [], undecidableLimits: [] });

    await fetchEffectiveLeavePolicy({ leaveTypeId: 'lt-1', asOf: '2026-03-01' });

    const [path] = getMock.mock.calls[0];
    expect(path).toContain('/hr/leave-policies/effective');
    expect(path).toContain('leaveTypeId=lt-1');
    expect(path).toContain('asOf=2026-03-01');
  });

  it('OMITS unstated query members rather than sending them blank', async () => {
    getMock.mockResolvedValue({});

    await fetchEffectiveLeavePolicy({ leaveTypeId: 'lt-1' });

    const [path] = getMock.mock.calls[0];
    // A blank `asOf=` would reach a `Matches(HR_ISO_DATE_PATTERN)` validator and 400, so absence is
    // the only correct encoding of "the server's today".
    expect(path).toBe('/hr/leave-policies/effective?leaveTypeId=lt-1');
    expect(path).not.toContain('asOf');
    expect(path).not.toContain('employmentType');
    expect(path).not.toContain('includeArchived');
  });

  it('sends includeArchived only when the operator asked the HISTORICAL question', async () => {
    getMock.mockResolvedValue({});

    await fetchEffectiveLeavePolicy({ leaveTypeId: 'lt-1', includeArchived: true });

    expect(getMock.mock.calls[0][0]).toContain('includeArchived=true');
  });

  it('fetches one policy by id', async () => {
    getMock.mockResolvedValue({});

    await fetchLeavePolicy(POLICY_ID);

    expect(getMock).toHaveBeenCalledWith(`/hr/leave-policies/${POLICY_ID}`);
  });

  it('fetches one version WITH its limits (the historical-resolution read)', async () => {
    getMock.mockResolvedValue({});

    await fetchLeavePolicyVersion(POLICY_ID, VERSION_ID);

    expect(getMock).toHaveBeenCalledWith(`/hr/leave-policies/${POLICY_ID}/versions/${VERSION_ID}`);
  });

  it('fetches the version in force for a policy', async () => {
    getMock.mockResolvedValue({});

    await fetchPublishedLeavePolicyVersion(POLICY_ID);

    expect(getMock).toHaveBeenCalledWith(`/hr/leave-policies/${POLICY_ID}/published`);
  });
});

describe('the labels (§27.7, §32.2, §32.3)', () => {
  it('names all four lifecycle states, and none of them as a fifth', () => {
    expect(hrLeavePolicyVersionStatusLabel('DRAFT')).toBe('پیش‌نویس');
    expect(hrLeavePolicyVersionStatusLabel('VALIDATED')).toBe('اعتبارسنجی‌شده');
    expect(hrLeavePolicyVersionStatusLabel('PUBLISHED')).toBe('منتشرشده');
    expect(hrLeavePolicyVersionStatusLabel('ARCHIVED')).toBe('بایگانی‌شده');
  });

  it('states each state CONSEQUENCE, so a label is never a bare name (§30.4)', () => {
    // Only the published state is described as governing; the archived one explicitly is not.
    expect(hrLeavePolicyVersionStatusMeaning('PUBLISHED')).toContain('تصمیم‌های جدید');
    expect(hrLeavePolicyVersionStatusMeaning('ARCHIVED')).toContain('تصمیم جدیدی');
    expect(hrLeavePolicyVersionStatusMeaning('DRAFT')).toContain('اعمال نمی‌شود');
    expect(hrLeavePolicyVersionStatusMeaning('VALIDATED')).toContain('انتشار');
  });

  it('renders the decision as a word, and NONE is NOT an approval (§14.5)', () => {
    expect(hrSimulationDecisionLabel('NONE')).toContain('رد نمی‌کند');
    expect(hrSimulationDecisionLabel({ type: 'LIMIT_REFUSAL' })).toContain('سقف مجاز');
    // An unrecognized shape says so rather than inventing a verdict.
    expect(hrSimulationDecisionLabel({ type: 'SOMETHING_ELSE' })).toContain('در دسترس نیست');
    expect(hrSimulationDecisionLabel(undefined)).toContain('در دسترس نیست');
  });
});
