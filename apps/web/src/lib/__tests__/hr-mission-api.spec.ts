import { coreGet, corePatch, corePost } from '../core-http';
import {
  approveMission,
  archiveMissionPolicyVersion,
  buildMissionApprovalDefinitionQuery,
  buildMissionOptionGroupQuery,
  buildMissionPolicyVersionQuery,
  buildMissionRequestQuery,
  cancelMission,
  correctMission,
  createMission,
  createMissionApprovalDefinition,
  createMissionOption,
  createMissionOptionGroup,
  createMissionPolicyVersion,
  fetchMission,
  fetchMissionApproval,
  fetchMissionApprovalDefinitions,
  fetchMissionOptionGroups,
  fetchMissionPolicyVersions,
  fetchMissions,
  fetchPendingMissionApprovals,
  publishMissionPolicyVersion,
  rejectMission,
  replaceMissionApprovalDefinitionSteps,
  resubmitMission,
  submitMission,
  submitMissionReport,
  updateMission,
  updateMissionApprovalDefinition,
  updateMissionOption,
  updateMissionOptionGroup,
  validateMissionPolicyVersion,
  type HrMissionRequest,
} from '../hr-mission-api';
import { missionRuleSetVersion } from '@/components/hr/__tests__/hr-fixtures';
import type { MissionRuleSetVersion } from '../mission-rule-set-version';

/**
 * Phase 55 Step 8A: the MISSION client's contract — every route, its URL, its body and its
 * refusals.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three of this phase's guarantees live in the CLIENT and nowhere else:
 *
 *   1. **THE FORBIDDEN FIELDS.** No body may carry `tenantId`, `actorId`, `approverId`, `projectId`
 *      or any status/decisionability fact (§2, §8, §21). The functions build the bodies, so this
 *      module is the only place that claim can be falsified.
 *   2. **THE ROUTE MAP.** A client method pointed at the wrong URL, or one that drops an id out of
 *      the path into the body, is a defect no type can catch and no server test can see.
 *   3. **THE OMITTED REASON.** An approval's `reason` is optional, so its ABSENCE must survive as
 *      an absent key rather than `reason: undefined`.
 *
 * It does NOT re-test `coreGet`/`corePost`/`corePatch` (they have their own specs) nor any server
 * projection: repeating either would make this a second, disagreeing authority.
 */
jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const OPTION_ID = '33333333-3333-4333-8333-333333333333';
const DEFINITION_ID = '44444444-4444-4444-8444-444444444444';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';

/** A minimal well-formed request; each case adjusts what it needs. */
const request = (overrides: Partial<HrMissionRequest> = {}): HrMissionRequest => ({
  id: MISSION_ID,
  status: 'DRAFT',
  submittedRevision: null,
  employee: { id: 'emp-1', employeeCode: 'E001' },
  durationMode: 'DAILY',
  locationType: 'IN_CITY',
  engagementType: 'NON_PROJECT',
  startDate: '2026-10-01',
  endDate: '2026-10-02',
  startTime: null,
  endTime: null,
  destination: null,
  description: null,
  correctionReason: null,
  rejectionReason: null,
  selections: [],
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  ...overrides,
});

/**
 * Every field no Mission body may ever carry. The list is asserted against EVERY write in this file
 * rather than only the ones where a mistake seems likely, because the failure this catches is a
 * field ADDED later for a plausible reason ("the server needs to know the tenant") that is wrong in
 * every case: the actor is derived server-side and `forbidNonWhitelisted` refuses the whole request.
 */
const FORBIDDEN_BODY_FIELDS = [
  'tenantId',
  'actorId',
  'approverId',
  'projectId',
  'project_id',
  'status',
  'submittedRevision',
  'canDecide',
  'decidableByActor',
  'revision',
  'resolvedApproverEmployeeId',
  'parallelCompletionMode',
];

/**
 * `selfApprovalMode` IS NOT ON THE LIST, and the distinction is the whole point.
 *
 * It is a REQUIRED field of `CreateMissionApprovalDefinitionDto` — an ADMINISTRATOR configuring a
 * flow states whether a requester may approve their own mission, and the server validates the value
 * against its own closed list. What is forbidden is the same word arriving on an EMPLOYEE's request
 * for a mission: a requester must not be able to tell the platform that self-approval is fine for
 * this one trip. That is a property of the REQUEST-RECORDING body, so it is asserted there rather
 * than as a blanket ban that would also forbid the administrator's legitimate configuration.
 */
const SELF_APPROVAL_ON_REQUEST_FIELDS = ['selfApprovalMode'];

/** Every write this file made, so the sweep cannot be satisfied by an empty list. */
function allBodies(): Array<Record<string, unknown>> {
  return [...postMock.mock.calls, ...patchMock.mock.calls]
    .map((call) => call[1])
    .filter((body): body is Record<string, unknown> => typeof body === 'object' && body !== null);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('the request register and its writes', () => {
  it('lists the register with an encoded filter and no invented parameters', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissions({
      employeeId: 'emp-1',
      status: 'IN_APPROVAL',
      durationMode: 'HOURLY',
      from: '2026-10-01',
      to: '2026-10-31',
      page: 2,
      pageSize: 10,
    });

    expect(getMock).toHaveBeenCalledWith(
      '/hr/missions?employeeId=emp-1&status=IN_APPROVAL&durationMode=HOURLY&from=2026-10-01&to=2026-10-31&page=2&pageSize=10'
    );
  });

  it('sends NO query at all when the caller filters nothing', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissions();

    // An absent filter is not `?page=1&pageSize=20`: the server's own default applies, and inventing
    // one here would be a second pagination policy.
    expect(getMock).toHaveBeenCalledWith('/hr/missions');
  });

  it('caps pageSize at the shared ceiling instead of passing an unbounded value', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });

    await fetchMissions({ pageSize: 100000 });

    expect(getMock).toHaveBeenCalledWith('/hr/missions?pageSize=100');
  });

  it('reads one request from its own path, with the id encoded', async () => {
    getMock.mockResolvedValue(request());

    await fetchMission('a/b?c');
    expect(getMock).toHaveBeenCalledWith('/hr/missions/a%2Fb%3Fc');

    jest.clearAllMocks();
    getMock.mockResolvedValue(request());
    await fetchMission(MISSION_ID);
    expect(getMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}`);
  });

  it('creates a draft without naming its status or its owner-actor', async () => {
    postMock.mockResolvedValue(request());

    await createMission({
      employeeId: 'emp-1',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      destination: 'Tehran',
      description: 'Client visit',
      selections: [{ optionGroupId: GROUP_ID, missionOptionId: OPTION_ID }],
    });

    // The path is the collection and NOTHING else; the body is the DTO's own fields.
    expect(postMock).toHaveBeenCalledWith('/hr/missions', {
      employeeId: 'emp-1',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      destination: 'Tehran',
      description: 'Client visit',
      selections: [{ optionGroupId: GROUP_ID, missionOptionId: OPTION_ID }],
    });
  });

  it('patches a restatement onto the request path', async () => {
    patchMock.mockResolvedValue(request());

    await updateMission(MISSION_ID, { description: 'Revised purpose' });

    expect(patchMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}`, {
      description: 'Revised purpose',
    });
  });

  it('submits with NO body, because the actor and the routing are not the client’s to name', async () => {
    postMock.mockResolvedValue(request({ status: 'IN_APPROVAL' }));

    await submitMission(MISSION_ID);

    // One argument only: a body here would be the client volunteering a status or an actor.
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/submit`);
  });

  it('resubmits the CORRECTED content in the same call that sends it', async () => {
    postMock.mockResolvedValue(request({ status: 'IN_APPROVAL', submittedRevision: 2 }));

    await resubmitMission(MISSION_ID, { description: 'Fixed', endDate: '2026-10-03' });

    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/resubmit`, {
      description: 'Fixed',
      endDate: '2026-10-03',
    });
  });

  it('cancels with the reason and nothing else', async () => {
    postMock.mockResolvedValue(request({ status: 'CANCELLED' }));

    await cancelMission(MISSION_ID, { reason: 'لغو شد' });

    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/cancel`, {
      reason: 'لغو شد',
    });
  });

  it('submits the mission report as content alone', async () => {
    postMock.mockResolvedValue({ id: 'r1' });

    await submitMissionReport(MISSION_ID, { content: 'گزارش ماموریت' });

    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/reports`, {
      content: 'گزارش ماموریت',
    });
  });

  it('keeps the two decision reasons ON the request read, nullability included', async () => {
    getMock.mockResolvedValue(
      request({
        status: 'CORRECTION_REQUIRED',
        correctionReason: 'تاریخ پایان اصلاح شود.',
        rejectionReason: null,
      })
    );

    const result = await fetchMission(MISSION_ID);

    // The employee acting on a returned request reads WHY from here — not from the approval steps,
    // which need a grant they do not hold.
    expect(result.correctionReason).toBe('تاریخ پایان اصلاح شود.');
    expect(result.rejectionReason).toBeNull();
  });
});

describe('the approval surface', () => {
  it('reads the actor’s own queue with no parameter at all', async () => {
    getMock.mockResolvedValue([request()]);

    await fetchPendingMissionApprovals();

    // The queue is resolved from the authenticated actor server-side: a query string here would be
    // the client trying to name whose queue it is reading.
    expect(getMock).toHaveBeenCalledWith('/hr/missions/approvals/pending');
  });

  it('reads the flow as { request, instance } and passes a null instance through', async () => {
    const flow = {
      id: 'inst-1',
      status: 'ACTIVE' as const,
      routingMode: 'SEQUENTIAL' as const,
      sequenceNumber: 1,
      submissionRevision: 1,
      canDecide: true,
      steps: [],
    };
    getMock.mockResolvedValue({ request: request(), instance: flow });

    const detail = await fetchMissionApproval(MISSION_ID);
    expect(getMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/approval`);
    // The SERVER's answer, rendered as received: this client computes no decisionability.
    expect(detail.instance?.canDecide).toBe(true);

    jest.clearAllMocks();
    getMock.mockResolvedValue({ request: request(), instance: null });
    // `null` is "nothing is being routed" — a state, not a missing field, and not turned into an
    // empty instance with `canDecide: false`.
    await expect(fetchMissionApproval(MISSION_ID)).resolves.toEqual({
      request: request(),
      instance: null,
    });
  });

  it('approves with a reason when one is stated', async () => {
    postMock.mockResolvedValue(request({ status: 'APPROVED' }));

    await approveMission(MISSION_ID, { reason: 'تأیید می‌کنم' });

    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/approve`, {
      reason: 'تأیید می‌کنم',
    });
  });

  it('OMITS reason on an approval that states none', async () => {
    postMock.mockResolvedValue(request({ status: 'APPROVED' }));

    await approveMission(MISSION_ID);

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    // The optional field must be ABSENT, not `undefined`: an explicit key would serialise.
    expect(body).not.toHaveProperty('reason');
  });

  it('rejects and calls CORRECTION as two different acts on two different routes', async () => {
    postMock.mockResolvedValue(request({ status: 'REJECTED' }));

    await rejectMission(MISSION_ID, { reason: 'خارج از بودجه' });
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/reject`, {
      reason: 'خارج از بودجه',
    });

    jest.clearAllMocks();
    postMock.mockResolvedValue(request({ status: 'CORRECTION_REQUIRED' }));
    await correctMission(MISSION_ID, { reason: 'ساعت شروع را اصلاح کنید' });

    // A correction is NOT a rejection: merging them would leave the employee unable to tell which
    // outcome they received.
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/${MISSION_ID}/correction`, {
      reason: 'ساعت شروع را اصلاح کنید',
    });
  });

  it('sends exactly one key on a decision, so no step identity or status travels', async () => {
    postMock.mockResolvedValue(request());

    await rejectMission(MISSION_ID, { reason: 'دلیل' });

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    // The step being decided is READ from the live flow server-side; naming one here would be the
    // client choosing which step it is deciding.
    expect(Object.keys(body)).toEqual(['reason']);
  });
});

describe('the option catalogue', () => {
  it('lists groups with the activation filter, and pages the same way', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissionOptionGroups({ active: true, page: 2, pageSize: 50 });

    // `active=false` must survive as a VALUE (the boolean filter), not be dropped for being falsy.
    expect(getMock).toHaveBeenCalledWith(
      '/hr/missions/option-groups?active=true&page=2&pageSize=50'
    );
  });

  it('sends active=false rather than omitting a deliberate filter', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissionOptionGroups({ active: false });

    expect(getMock).toHaveBeenCalledWith('/hr/missions/option-groups?active=false');
  });

  it('creates and updates a group on the catalogue paths', async () => {
    postMock.mockResolvedValue({ id: GROUP_ID });

    await createMissionOptionGroup({
      code: 'DURATION',
      label: 'مدت',
      required: true,
      sortOrder: 0,
    });
    expect(postMock).toHaveBeenCalledWith('/hr/missions/option-groups', {
      code: 'DURATION',
      label: 'مدت',
      required: true,
      sortOrder: 0,
    });

    jest.clearAllMocks();
    patchMock.mockResolvedValue({ id: GROUP_ID });
    await updateMissionOptionGroup(GROUP_ID, { label: 'مدت ماموریت', active: false });

    // The group id is in the PATH and NOT repeated in the body.
    expect(patchMock).toHaveBeenCalledWith(`/hr/missions/option-groups/${GROUP_ID}`, {
      label: 'مدت ماموریت',
      active: false,
    });
  });

  it('creates and updates an option with BOTH ids in the path', async () => {
    postMock.mockResolvedValue({ id: OPTION_ID });

    await createMissionOption(GROUP_ID, { code: 'HOURLY', label: 'ساعتی', sortOrder: 0 });
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/option-groups/${GROUP_ID}/options`, {
      code: 'HOURLY',
      label: 'ساعتی',
      sortOrder: 0,
    });

    jest.clearAllMocks();
    patchMock.mockResolvedValue({ id: OPTION_ID });
    await updateMissionOption(GROUP_ID, OPTION_ID, { label: 'ساعتی (اصلاح‌شده)' });

    // Neither id is duplicated into the body: the path IS the address.
    expect(patchMock).toHaveBeenCalledWith(
      `/hr/missions/option-groups/${GROUP_ID}/options/${OPTION_ID}`,
      { label: 'ساعتی (اصلاح‌شده)' }
    );
  });
});

describe('the approval definitions', () => {
  it('lists definitions with the status filter', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissionApprovalDefinitions({ status: 'ACTIVE', page: 1, pageSize: 20 });

    expect(getMock).toHaveBeenCalledWith(
      '/hr/missions/approval-definitions?status=ACTIVE&page=1&pageSize=20'
    );
  });

  it('creates a flow, and updates it WITHOUT re-sending the steps', async () => {
    postMock.mockResolvedValue({ id: DEFINITION_ID });

    const steps = [
      { order: 1, name: 'سرپرست', approverEmployeeId: 'emp-9', required: true },
      { order: 2, name: 'مدیر', approverEmployeeId: 'emp-10' },
    ];
    await createMissionApprovalDefinition({
      name: 'دو مرحله‌ای',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps,
    });
    expect(postMock).toHaveBeenCalledWith('/hr/missions/approval-definitions', {
      name: 'دو مرحله‌ای',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps,
    });

    jest.clearAllMocks();
    patchMock.mockResolvedValue({ id: DEFINITION_ID });
    await updateMissionApprovalDefinition(DEFINITION_ID, { status: 'INACTIVE' });

    // Steps move through their own route; a definition update that carried them would be a second
    // way to replace ordered steps.
    expect(patchMock).toHaveBeenCalledWith(`/hr/missions/approval-definitions/${DEFINITION_ID}`, {
      status: 'INACTIVE',
    });
  });

  it('replaces the ordered steps on the steps route', async () => {
    postMock.mockResolvedValue({ id: DEFINITION_ID });

    await replaceMissionApprovalDefinitionSteps(DEFINITION_ID, {
      name: 'ignored-by-the-route',
      routingMode: 'PARALLEL',
      selfApprovalMode: 'ALLOWED',
      steps: [{ order: 1, name: 'دو مدیر', approverEmployeeId: 'emp-9' }],
    });

    expect(postMock).toHaveBeenCalledWith(
      `/hr/missions/approval-definitions/${DEFINITION_ID}/steps`,
      {
        name: 'ignored-by-the-route',
        routingMode: 'PARALLEL',
        selfApprovalMode: 'ALLOWED',
        steps: [{ order: 1, name: 'دو مدیر', approverEmployeeId: 'emp-9' }],
      }
    );
  });
});

describe('the policy versions', () => {
  it('lists versions with the lifecycle filter', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchMissionPolicyVersions({ status: 'PUBLISHED', page: 3, pageSize: 20 });

    expect(getMock).toHaveBeenCalledWith(
      '/hr/missions/policy-versions?status=PUBLISHED&page=3&pageSize=20'
    );
  });

  it('authors a version with its own version number and the rule-set document as written', async () => {
    postMock.mockResolvedValue({ id: VERSION_ID });

    // A REAL `MissionRuleSetVersion`, not a throwaway object: the client now carries the shape the
    // server's validator accepts, so the spec posts a document that could actually be published.
    const configuration = missionRuleSetVersion({ version: '4' });

    await createMissionPolicyVersion({
      version: 4,
      label: 'نسخه چهارم',
      configuration,
    });

    // `configuration` is passed through as written — the client does not interpret the document, and
    // it does not strip or add a key. The SAME object is asserted, so an accidental clone-with-edit
    // would fail here rather than at the server.
    expect(postMock).toHaveBeenCalledWith('/hr/missions/policy-versions', {
      version: 4,
      label: 'نسخه چهارم',
      configuration,
    });
  });

  it('sends the typed rule-set document unchanged — every key survives the client', async () => {
    postMock.mockResolvedValue({ id: VERSION_ID });

    const configuration = missionRuleSetVersion({
      supersedes: '3',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    });
    await createMissionPolicyVersion({ version: 5, label: 'نسخه پنجم', configuration });

    const [, body] = postMock.mock.calls[0] as [string, { configuration: MissionRuleSetVersion }];
    // Deep equality against the source document: a client that dropped `effectiveTo: null` (the key
    // that says "no end date") or reordered `rules` would change the version's MEANING while still
    // passing a shallow check.
    expect(body.configuration).toEqual(configuration);
    expect(body.configuration.rules[0].actions[0].type).toBe('REQUIRED_APPROVAL_STEP');
  });

  it('reports the SERVER lifecycle flags as received, and derives none of them', async () => {
    // A DRAFT whose server answer enables ONLY validate. The client must report that verbatim: if it
    // computed the matrix from `status` it would still pass this case, which is why the flags
    // deliberately DISAGREE with the status below.
    const contradictory = {
      id: VERSION_ID,
      version: 6,
      status: 'ARCHIVED',
      ruleSetId: 'hr.mission.approval',
      configuration: missionRuleSetVersion(),
      publishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      actions: { canValidate: true, canPublish: false, canArchive: false },
    } as const;
    getMock.mockResolvedValue({ items: [contradictory], total: 1, page: 1, pageSize: 20 });

    const result = await fetchMissionPolicyVersions();

    // The client hands back what it was given, including a combination its own reading of `status`
    // would never produce. That is the whole claim: eligibility is the server's, not this client's.
    expect(result.items[0].actions).toEqual({
      canValidate: true,
      canPublish: false,
      canArchive: false,
    });
    expect(result.items[0].configuration.status).toBe('DRAFT');
  });

  it('reads the typed rule-set document off a version response without re-parsing it', async () => {
    const configuration = missionRuleSetVersion({ status: 'PUBLISHED', version: '9' });
    getMock.mockResolvedValue({
      items: [{ id: VERSION_ID, configuration }],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const result = await fetchMissionPolicyVersions();

    // The document survives the response boundary intact — including the rule's action, which is the
    // part the Mission engine reads to decide whether a request needs approval.
    expect(result.items[0].configuration.fields).toHaveLength(3);
    expect(result.items[0].configuration.rules[0].id).toBe('mission-requires-approval');
  });

  it('drives validate, publish and archive as three bodyless posts on their own paths', async () => {
    postMock.mockResolvedValue({ id: VERSION_ID });

    await validateMissionPolicyVersion(VERSION_ID);
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/policy-versions/${VERSION_ID}/validate`);

    jest.clearAllMocks();
    postMock.mockResolvedValue({ id: VERSION_ID });
    await publishMissionPolicyVersion(VERSION_ID);
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/policy-versions/${VERSION_ID}/publish`);

    jest.clearAllMocks();
    postMock.mockResolvedValue({ id: VERSION_ID });
    await archiveMissionPolicyVersion(VERSION_ID);

    // ONE argument each: the server decides what "valid" and "publishable" mean, so there is no body
    // for a client to state an opinion in.
    expect(postMock).toHaveBeenCalledWith(`/hr/missions/policy-versions/${VERSION_ID}/archive`);
  });
});

describe('the query builders', () => {
  it('emits nothing for an empty filter — never a fabricated default page', () => {
    expect(buildMissionRequestQuery()).toBe('');
    expect(buildMissionOptionGroupQuery()).toBe('');
    expect(buildMissionApprovalDefinitionQuery()).toBe('');
    expect(buildMissionPolicyVersionQuery()).toBe('');
  });

  it('caps pageSize on every builder, using the one shared ceiling', () => {
    expect(buildMissionRequestQuery({ pageSize: 5000 })).toBe('?pageSize=100');
    expect(buildMissionOptionGroupQuery({ pageSize: 5000 })).toBe('?pageSize=100');
    expect(buildMissionApprovalDefinitionQuery({ pageSize: 5000 })).toBe('?pageSize=100');
    expect(buildMissionPolicyVersionQuery({ pageSize: 5000 })).toBe('?pageSize=100');
  });

  it('encodes Persian and reserved characters rather than splicing them raw', () => {
    expect(buildMissionRequestQuery({ from: '۱۴۰۵/۰۱/۰۱' })).toBe(
      `?from=${encodeURIComponent('۱۴۰۵/۰۱/۰۱')}`
    );
    expect(buildMissionRequestQuery({ status: 'DRAFT', employeeId: 'a b&c' })).toBe(
      '?employeeId=a%20b%26c&status=DRAFT'
    );
  });
});

describe('no body ever carries a forbidden field', () => {
  it('sweeps EVERY write this file made for tenant, actor, approver and project fields', async () => {
    postMock.mockResolvedValue({ id: MISSION_ID });
    patchMock.mockResolvedValue({ id: MISSION_ID });

    // Exercise every write, so the sweep cannot pass on an empty set.
    await createMission({
      employeeId: 'emp-1',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      selections: [],
    });
    await updateMission(MISSION_ID, { description: 'x' });
    await submitMission(MISSION_ID);
    await resubmitMission(MISSION_ID, { description: 'y' });
    await cancelMission(MISSION_ID, { reason: 'z' });
    await submitMissionReport(MISSION_ID, { content: 'r' });
    await approveMission(MISSION_ID, { reason: 'a' });
    await rejectMission(MISSION_ID, { reason: 'b' });
    await correctMission(MISSION_ID, { reason: 'c' });
    await createMissionOptionGroup({ code: 'C', label: 'L' });
    await updateMissionOptionGroup(GROUP_ID, { label: 'L2' });
    await createMissionOption(GROUP_ID, { code: 'C', label: 'L' });
    await updateMissionOption(GROUP_ID, OPTION_ID, { label: 'L3' });
    await createMissionApprovalDefinition({
      name: 'n',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps: [],
    });
    await updateMissionApprovalDefinition(DEFINITION_ID, { name: 'n2' });
    await replaceMissionApprovalDefinitionSteps(DEFINITION_ID, {
      name: 'n',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps: [],
    });
    await createMissionPolicyVersion({
      version: 1,
      label: 'l',
      configuration: missionRuleSetVersion(),
    });
    await validateMissionPolicyVersion(VERSION_ID);
    await publishMissionPolicyVersion(VERSION_ID);
    await archiveMissionPolicyVersion(VERSION_ID);

    const bodies = allBodies();
    // 20 writes were made and FOUR of them are deliberately BODYLESS — `submitMission` and the
    // three policy-lifecycle posts, each of which states everything it needs in its path. So the
    // floor is 16, and writing it as 20 would assert the opposite of the design. The floor exists so
    // this sweep cannot pass on an empty set.
    expect(bodies.length).toBe(16);

    // The bodyless ones carried ONE argument, which is the other half of the same claim: no empty
    // object was sent in their place to look busy.
    const bodylessPaths = postMock.mock.calls
      .filter((call) => call[1] === undefined)
      .map((call) => call[0]);
    expect(bodylessPaths).toEqual([
      `/hr/missions/${MISSION_ID}/submit`,
      `/hr/missions/policy-versions/${VERSION_ID}/validate`,
      `/hr/missions/policy-versions/${VERSION_ID}/publish`,
      `/hr/missions/policy-versions/${VERSION_ID}/archive`,
    ]);

    for (const body of bodies) {
      for (const name of FORBIDDEN_BODY_FIELDS) {
        expect(body).not.toHaveProperty(name);
      }
    }

    // THE NARROWER RULE: an EMPLOYEE's request may not carry `selfApprovalMode`. Only the three
    // request-recording calls are checked, because the administrator's definition body legitimately
    // requires it — a blanket ban would forbid a field the server itself mandates.
    const requestBodies = postMock.mock.calls
      .filter((call) => ['/hr/missions', `/hr/missions/${MISSION_ID}/resubmit`].includes(call[0]))
      .map((call) => call[1] as Record<string, unknown>)
      .concat(patchMock.mock.calls.map((call) => call[1] as Record<string, unknown>));

    expect(requestBodies.length).toBeGreaterThanOrEqual(3);
    for (const body of requestBodies) {
      for (const name of SELF_APPROVAL_ON_REQUEST_FIELDS) {
        expect(body).not.toHaveProperty(name);
      }
    }
  });

  it('never emits a project field, because a PROJECT mission is a CLASSIFICATION not a link', async () => {
    postMock.mockResolvedValue({ id: MISSION_ID });

    // Project work travels as `selections` plus the server's own derived `engagementType`, so no
    // call needs a project id — and none may invent one.
    await createMission({
      employeeId: 'emp-1',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      selections: [{ optionGroupId: GROUP_ID, missionOptionId: OPTION_ID }],
    });

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['employeeId', 'endDate', 'selections', 'startDate']);
  });
});
