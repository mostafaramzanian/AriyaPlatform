import { coreGet, corePost } from '../core-http';
import {
  approveLeaveRequest,
  fetchLeaveApproval,
  leaveApprovalInstanceStatusLabel,
  leaveApprovalInstanceStatusTone,
  leaveApprovalResolutionReasonLabel,
  leaveApprovalStepStatusLabel,
  leaveApprovalStepStatusTone,
  leaveUndecidableReasonLabel,
  rejectLeaveRequest,
  type HrLeaveApprovalInstance,
} from '../hr-leave-approval-api';

/**
 * Phase 54-J (§2, §7, §8, §16): the leave DECISION client's contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three of this phase's guarantees live in the client and nowhere else:
 *
 *   1. **THE FORBIDDEN FIELDS.** Neither write body may carry `tenantId`, `actorId`, `approverId`,
 *      `employeeId`, any status, `decidableByActor` or `undecidableReason` (§2, §8). The functions
 *      build the bodies, so the property belongs to THIS module — which makes this the only place
 *      the claim can be falsified.
 *   2. **THE OMITTED REASON.** The approve DTO's `reason` is optional. A client that sent
 *      `reason: undefined` would serialise an explicit key; the absence is therefore asserted.
 *   3. **THE `null` FLOW.** An ungoverned request has NO flow, and the server says so with `null`
 *      (§18.5). The client must pass that through rather than fabricate an empty instance.
 *
 * It does not re-test `coreGet`/`corePost` (they have their own specs) nor the server's projection:
 * repeating either here would make this file a second, disagreeing authority.
 */
jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

/** A minimal well-formed instance; each case adjusts what it needs. */
const instance = (overrides: Partial<HrLeaveApprovalInstance> = {}): HrLeaveApprovalInstance => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leaveRequestId: REQUEST_ID,
  status: 'ACTIVE',
  stepCount: 1,
  requestStartDate: '2026-01-05',
  requestEndDate: '2026-01-06',
  steps: [],
  decidableByActor: true,
  undecidableReason: null,
  ...overrides,
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('the read (§7)', () => {
  it('reads the flow from the request-scoped route', async () => {
    getMock.mockResolvedValue(instance());

    await fetchLeaveApproval(REQUEST_ID);

    expect(getMock).toHaveBeenCalledWith(`/hr/leave-requests/${REQUEST_ID}/approval`);
  });

  it('passes a `null` flow through instead of inventing an empty instance', async () => {
    getMock.mockResolvedValue(null);

    await expect(fetchLeaveApproval(REQUEST_ID)).resolves.toBeNull();
  });

  it('encodes the id rather than splicing it into the path raw', async () => {
    getMock.mockResolvedValue(null);

    await fetchLeaveApproval('a/b?c');

    expect(getMock).toHaveBeenCalledWith('/hr/leave-requests/a%2Fb%3Fc/approval');
  });
});

describe('the writes (§2, §8)', () => {
  it('approves the request-scoped route', async () => {
    postMock.mockResolvedValue(instance());

    await approveLeaveRequest(REQUEST_ID, { reason: 'تأیید می‌کنم' });

    expect(postMock).toHaveBeenCalledWith(`/hr/leave-requests/${REQUEST_ID}/approve`, {
      reason: 'تأیید می‌کنم',
    });
  });

  it('rejects the request-scoped route with the stated reason', async () => {
    postMock.mockResolvedValue(instance({ status: 'COMPLETED' }));

    await rejectLeaveRequest(REQUEST_ID, { reason: 'روزهای پرکار' });

    expect(postMock).toHaveBeenCalledWith(`/hr/leave-requests/${REQUEST_ID}/reject`, {
      reason: 'روزهای پرکار',
    });
  });

  it('NEVER sends an identity, a status or a server-owned decision fact', async () => {
    postMock.mockResolvedValue(instance());

    await approveLeaveRequest(REQUEST_ID, { reason: 'ok' });
    await rejectLeaveRequest(REQUEST_ID, { reason: 'no' });

    const forbidden = [
      'tenantId',
      'actorId',
      'approverId',
      'employeeId',
      'status',
      'requestStatus',
      'instanceStatus',
      'stepStatus',
      // THE TWO A1 ADDED: they are RESPONSE facts the server computes, so a client that echoed
      // them back would be supplying its own authorization answer (§8).
      'decidableByActor',
      'undecidableReason',
    ];

    for (const call of postMock.mock.calls) {
      const body = call[1] as Record<string, unknown>;
      for (const name of forbidden) {
        expect(body).not.toHaveProperty(name);
      }
    }
  });

  it('OMITS reason on an approval that states none, so the optional field stays absent', async () => {
    postMock.mockResolvedValue(instance());

    await approveLeaveRequest(REQUEST_ID);

    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('reason');
  });
});

describe('the Persian vocabulary', () => {
  it('names every instance status and never falls back to the raw token', () => {
    // Built from code points so the assertion is exact: Persian ZWNJ placement is not something a
    // hand-typed literal can be trusted with, and a test that "looks right" while asserting a
    // different string would be worse than no test.
    const completed = String.fromCharCode(
      0x067e,
      0x0627,
      0x06cc,
      0x0627,
      0x0646,
      0x06cc,
      0x0627,
      0x0641,
      0x062a,
      0x0647
    );

    expect(leaveApprovalInstanceStatusLabel('ACTIVE')).toBe('در جریان');
    expect(leaveApprovalInstanceStatusLabel('COMPLETED')).toBe(completed);
  });

  it('names every step status', () => {
    expect(leaveApprovalStepStatusLabel('PENDING')).toBe('در انتظار');
    expect(leaveApprovalStepStatusLabel('ACTIVE')).toBe('در نوبت تصمیم');
    expect(leaveApprovalStepStatusLabel('APPROVED')).toBe('تأییدشده');
    expect(leaveApprovalStepStatusLabel('REJECTED')).toBe('ردشده');
    expect(leaveApprovalStepStatusLabel('SKIPPED')).toBe('عبورکرده');
    expect(leaveApprovalStepStatusLabel('CANCELLED')).toBe('لغوشده');
  });

  it('names every resolution reason', () => {
    expect(leaveApprovalResolutionReasonLabel('PRIMARY')).toBe('جانشین اصلی');
    expect(leaveApprovalResolutionReasonLabel('SUBSTITUTE')).toBe('جانشین موقت');
    expect(leaveApprovalResolutionReasonLabel('NO_RESOLUTION')).toBe('بدون جانشین');
  });

  it('explains the two refusal reasons, and gives NO sentence for `null`', () => {
    // The decider word as the module writes it, built from code points so ZWNJ placement cannot
    // drift between the assertion and the implementation.
    const decider = String.fromCharCode(
      0x062a,
      0x0635,
      0x0645,
      0x06cc,
      0x0645,
      0x06af,
      0x06cc,
      0x0631,
      0x0646,
      0x062f,
      0x0647
    );

    expect(leaveUndecidableReasonLabel('NOT_RESOLVED')).toContain(decider);
    expect(leaveUndecidableReasonLabel('AWAITING_OTHER')).toContain('کاربر دیگری');
    // `null` is the server naming NO refusal, so the helper must not invent one (§7.3).
    expect(leaveUndecidableReasonLabel(null)).toBeNull();
  });

  it('tones a recorded decision and stays muted on everything undecided', () => {
    expect(leaveApprovalInstanceStatusTone('ACTIVE')).toBe('ok');
    expect(leaveApprovalInstanceStatusTone('COMPLETED')).toBe('muted');

    expect(leaveApprovalStepStatusTone('APPROVED')).toBe('ok');
    expect(leaveApprovalStepStatusTone('REJECTED')).toBe('danger');
    expect(leaveApprovalStepStatusTone('CANCELLED')).toBe('danger');
    expect(leaveApprovalStepStatusTone('PENDING')).toBe('muted');
    expect(leaveApprovalStepStatusTone('ACTIVE')).toBe('muted');
    expect(leaveApprovalStepStatusTone('SKIPPED')).toBe('muted');
  });
});
