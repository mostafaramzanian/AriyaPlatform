import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CheckRequestService } from './check-request.service';
import { CHECK_REQUEST_ERROR_CODES } from './check-request';

/**
 * Phase CHECK-ISSUATION — the stage actions (states 3 → 8) and the available-actions
 * projection, exercised against the SAME fakes the F1 suite uses.
 *
 * WHAT IS PINNED HERE (brief §42/§43, the service half)
 * ----------------------------------------------------
 *  1. The source's stage gates IN THE SOURCE'S ORDER: V9→V10→V11 on allocation, image-
 *     before-confirmation on issue/deliver, and the exact typed refusals each produces.
 *  2. The transition authority: a wrong state is a typed 409 and NOTHING is written; a
 *     lost race (repository `null`) is re-read and still refused.
 *  3. The decision-act rules: a machine actor is 403 (DECIDER_REQUIRED), self-approval /
 *     self-review is 403 (SELF_APPROVAL) — for manager, reviewer and presidency alike.
 *  4. The audit trail: one event per stage act with the RIGHT action name, and never an
 *     event for a refused act.
 *  5. available-actions derives from the pinned definition: labels, capabilities,
 *     terminal emptiness and the actor-policy `enabled` flag.
 */

const TENANT = 'tenant-a';
const REQUESTER = 'user-requester';
const MANAGER = 'user-manager';
const OTHER = 'user-other';

const actor = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  userId: OTHER,
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  ...overrides,
});

let seq = 0;
function row(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date('2026-10-04T08:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenantId: TENANT,
    title: 'صدور چک برای خرید غیر پروژه ای',
    checkIssueType: 'PURCHASE',
    purchaseType: 'NON_PROJECT',
    orderReference: 'ORDER-1',
    projectReference: null,
    projectManagerUserId: null,
    requesterUserId: REQUESTER,
    requestDate: now,
    requesterOpinion: 'CONTINUE',
    status: 3,
    processKey: 'financial.check-issuance',
    processVersion: 1,
    managerDecision: 'APPROVE',
    managerComment: null,
    submittedAt: now,
    decidedAt: now,
    decidedByUserId: MANAGER,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const stageRow = (request: Record<string, unknown>) => ({
  ...request,
  allocation: null,
  documentReview: null,
  executiveApproval: null,
  issue: null,
  delivery: null,
});

function buildService() {
  const repository = {
    create: jest.fn(),
    findById: jest.fn(),
    findByIdWithStages: jest.fn(),
    list: jest.fn(),
    updateEditable: jest.fn(),
    submit: jest.fn(),
    decide: jest.fn(),
    allocate: jest.fn(),
    recordDocumentReview: jest.fn(),
    recordExecutiveApproval: jest.fn(),
    confirmIssue: jest.fn(),
    completeDelivery: jest.fn(),
  };
  const attachments = {
    countByRequestSection: jest.fn().mockResolvedValue(1),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
    buildOutboxPayload: jest.fn().mockReturnValue({
      tenantId: TENANT,
      auditId: 'mock-audit-id',
      payload: {},
    }),
  };
  const directory = { findTenantMember: jest.fn().mockResolvedValue({ id: 'member' }) };

  type ServiceArgs = ConstructorParameters<typeof CheckRequestService>;
  const service = new CheckRequestService(
    repository as unknown as ServiceArgs[0],
    attachments as unknown as ServiceArgs[1],
    audit as unknown as ServiceArgs[2],
    directory as unknown as ServiceArgs[3],
  );
  return { service, repository, attachments, audit, directory };
}

/** A current row + the post-transition detail read, the standard happy-path setup. */
function happyPath(
  repository: { findById: jest.Mock; findByIdWithStages: jest.Mock },
  current: Record<string, unknown>,
  next = current,
) {
  repository.findById.mockResolvedValue(current);
  repository.findByIdWithStages.mockResolvedValue(stageRow(next));
}

describe('Phase CHECK-ISSUATION — allocate (stage 3)', () => {
  const dto = {
    allocationPlace: '  بانک ملت  ',
    balance: '5000',
    checkDate: '2026-10-10',
    checkDescription: 'شرح',
    checkAmount: '4000',
    payableTo: 'آقای X',
  };

  it('writes the six source fields, normalizes text, parses the date, and audits `allocate`', async () => {
    const { service, repository, audit } = buildService();
    const current = row({ status: 3 });
    happyPath(repository, current, row({ status: 4 }));
    repository.allocate.mockResolvedValue(row({ status: 4 }));

    await service.allocate(actor(), current.id, dto);

    expect(repository.allocate).toHaveBeenCalledWith(
      TENANT,
      current.id,
      3,
      4,
      expect.objectContaining({
        allocationPlace: 'بانک ملت',
        balance: '5000',
        checkDate: new Date('2026-10-10T00:00:00.000Z'),
        checkAmount: '4000',
        payableTo: 'آقای X',
      }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action: 'allocate',
      resource: 'financial.check-request',
      resourceId: current.id,
    });
  });

  it('V9: refuses an empty allocation place with the source gate code', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 3 }));

    const error = await service
      .allocate(actor(), 'x', { ...dto, allocationPlace: '   ' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.ALLOCATION_PLACE_REQUIRED);
    expect(repository.allocate).not.toHaveBeenCalled();
  });

  it('V11: refuses amount > balance as BigInt — and NEVER when the balance is absent', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 3 }));

    const exceed = await service
      .allocate(actor(), 'x', { ...dto, checkAmount: '5001' })
      .catch((e) => e);
    expect(exceed.getResponse().code).toBe(
      CHECK_REQUEST_ERROR_CODES.ALLOCATION_AMOUNT_EXCEEDS_BALANCE
    );

    // 18-digit precision: a JS number would round these to equal; BigInt does not.
    const big = await service
      .allocate(actor(), 'x', {
        ...dto,
        checkAmount: '999999999999999999',
        balance: '999999999999999998',
      })
      .catch((e) => e);
    expect(big.getResponse().code).toBe(
      CHECK_REQUEST_ERROR_CODES.ALLOCATION_AMOUNT_EXCEEDS_BALANCE
    );

    // Absent balance: the source skipped the comparison (parseInt('') → NaN), so the call
    // proceeds past validation.
    const current = row({ status: 3 });
    happyPath(repository, current, row({ status: 4 }));
    repository.allocate.mockResolvedValue(row({ status: 4 }));
    const ok = await service
      .allocate(actor(), current.id, { ...dto, balance: undefined })
      .then(() => true)
      .catch(() => false);
    expect(ok).toBe(true);
  });

  it('409s from any state that is not the allocation stage — and writes NOTHING', async () => {
    const { service, repository } = buildService();
    for (const status of [2, 4, 6, 8, 50]) {
      repository.findById.mockResolvedValue(row({ status }));
      const error = await service.allocate(actor(), 'x', dto).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
    }
    expect(repository.allocate).not.toHaveBeenCalled();
  });

  it('409s a LOST RACE — the conditional write returned null and the re-read names the state', async () => {
    const { service, repository } = buildService();
    const current = row({ status: 3 });
    repository.findById
      .mockResolvedValueOnce(current)
      .mockResolvedValue(row({ status: 4 }));
    repository.allocate.mockResolvedValue(null);

    const error = await service.allocate(actor(), current.id, dto).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
  });
});

describe('Phase CHECK-ISSUATION — the decision acts (review + presidency)', () => {
  it('review APPROVE → 5 with `document_review`; CORRECTION → 1 with `document_review_correction`', async () => {
    const { service, repository, audit } = buildService();

    const approveCurrent = row({ status: 4 });
    happyPath(repository, approveCurrent, row({ status: 5 }));
    repository.recordDocumentReview.mockResolvedValue(row({ status: 5 }));
    await service.reviewDocuments(actor(), approveCurrent.id, { decision: 'APPROVE', comment: 'ok' });
    expect(repository.recordDocumentReview).toHaveBeenCalledWith(
      TENANT,
      approveCurrent.id,
      4,
      5,
      expect.objectContaining({ decision: 'APPROVE', comment: 'ok', recordedByUserId: OTHER }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({ action: 'document_review' });

    const correctionCurrent = row({ status: 4 });
    happyPath(repository, correctionCurrent, row({ status: 1 }));
    repository.recordDocumentReview.mockResolvedValue(row({ status: 1 }));
    await service.reviewDocuments(actor(), correctionCurrent.id, { decision: 'CORRECTION' });
    expect(repository.recordDocumentReview).toHaveBeenLastCalledWith(
      TENANT,
      correctionCurrent.id,
      4,
      1,
      expect.objectContaining({ decision: 'CORRECTION', comment: null }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[1][1]).toMatchObject({
      action: 'document_review_correction',
    });
  });

  it('review from a wrong state 409s and writes NOTHING', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const error = await service
      .reviewDocuments(actor(), 'x', { decision: 'APPROVE' })
      .catch((e) => e);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
    expect(repository.recordDocumentReview).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).not.toHaveBeenCalled();
  });

  it('a MACHINE actor cannot decide — DECIDER_REQUIRED, nothing written', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 4 }));

    const review = await service
      .reviewDocuments(actor({ userId: null }), 'x', { decision: 'APPROVE' })
      .catch((e) => e);
    expect(review).toBeInstanceOf(ForbiddenException);
    expect(review.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DECIDER_REQUIRED);
    expect(repository.recordDocumentReview).not.toHaveBeenCalled();

    const executive = await service
      .executiveDecision(actor({ userId: null }), 'x', { decision: 'APPROVE' })
      .catch((e) => e);
    expect(executive.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DECIDER_REQUIRED);
    expect(repository.recordExecutiveApproval).not.toHaveBeenCalled();
  });

  it('self-review and self-approval fail closed — SELF_APPROVAL for the requester', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 4 }));

    const selfReview = await service
      .reviewDocuments(actor({ userId: REQUESTER }), 'x', { decision: 'APPROVE' })
      .catch((e) => e);
    expect(selfReview).toBeInstanceOf(ForbiddenException);
    expect(selfReview.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL);

    repository.findById.mockResolvedValue(row({ status: 5 }));
    const selfExecutive = await service
      .executiveDecision(actor({ userId: REQUESTER }), 'x', { decision: 'APPROVE' })
      .catch((e) => e);
    expect(selfExecutive.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL);
    expect(repository.recordExecutiveApproval).not.toHaveBeenCalled();
  });

  it('presidency APPROVE → 6 and REJECT → 50 with the right audit verbs', async () => {
    const { service, repository, audit } = buildService();

    const approveCurrent = row({ status: 5 });
    happyPath(repository, approveCurrent, row({ status: 6 }));
    repository.recordExecutiveApproval.mockResolvedValue(row({ status: 6 }));
    await service.executiveDecision(actor(), approveCurrent.id, { decision: 'APPROVE' });
    expect(repository.recordExecutiveApproval).toHaveBeenCalledWith(
      TENANT,
      approveCurrent.id,
      5,
      6,
      expect.objectContaining({ decision: 'APPROVE' }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({ action: 'executive_approve' });

    const rejectCurrent = row({ status: 5 });
    happyPath(repository, rejectCurrent, row({ status: 50 }));
    repository.recordExecutiveApproval.mockResolvedValue(row({ status: 50 }));
    await service.executiveDecision(actor(), rejectCurrent.id, { decision: 'REJECT' });
    expect(repository.recordExecutiveApproval).toHaveBeenLastCalledWith(
      TENANT,
      rejectCurrent.id,
      5,
      50,
      expect.objectContaining({ decision: 'REJECT' }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[1][1]).toMatchObject({ action: 'executive_reject' });
  });
});

describe('Phase CHECK-ISSUATION — issue (stage 6) and deliver (stage 7)', () => {
  it('issue: the IMAGE gate runs FIRST — no section-6 document means 409, even with confirmed=true', async () => {
    const { service, repository, attachments, audit } = buildService();
    const current = row({ status: 6 });
    repository.findById.mockResolvedValue(current);
    attachments.countByRequestSection.mockResolvedValue(0);

    const error = await service.issue(actor(), current.id, { confirmed: true }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.ISSUE_IMAGE_REQUIRED);
    // The source checked the grid before the checkbox — so does this.
    expect(attachments.countByRequestSection).toHaveBeenCalledWith(TENANT, current.id, 6);
    expect(repository.confirmIssue).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).not.toHaveBeenCalled();
  });

  it('issue: with the image present but confirmed=false → 400 ISSUE_CONFIRMATION_REQUIRED', async () => {
    const { service, repository, attachments } = buildService();
    repository.findById.mockResolvedValue(row({ status: 6 }));
    attachments.countByRequestSection.mockResolvedValue(1);

    const error = await service.issue(actor(), 'x', { confirmed: false }).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.ISSUE_CONFIRMATION_REQUIRED);
    expect(repository.confirmIssue).not.toHaveBeenCalled();
  });

  it('issue: image + confirmation → 6 → 7 with `issue` audited and the row recorded', async () => {
    const { service, repository, attachments, audit } = buildService();
    const current = row({ status: 6 });
    happyPath(repository, current, row({ status: 7 }));
    attachments.countByRequestSection.mockResolvedValue(2);
    repository.confirmIssue.mockResolvedValue(row({ status: 7 }));

    await service.issue(actor(), current.id, { confirmed: true });

    expect(repository.confirmIssue).toHaveBeenCalledWith(
      TENANT,
      current.id,
      6,
      7,
      expect.objectContaining({ confirmed: true, recordedByUserId: OTHER }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({ action: 'issue' });
  });

  it('deliver: the RECEIPT gate runs first; confirmed=false is 400; success lands terminal 8', async () => {
    const { service, repository, attachments, audit } = buildService();

    const atDelivery = row({ status: 7 });
    repository.findById.mockResolvedValue(atDelivery);
    attachments.countByRequestSection.mockResolvedValue(0);
    const missing = await service
      .deliver(actor(), atDelivery.id, { completed: true })
      .catch((e) => e);
    expect(missing.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DELIVERY_RECEIPT_REQUIRED);
    expect(attachments.countByRequestSection).toHaveBeenCalledWith(TENANT, atDelivery.id, 7);

    attachments.countByRequestSection.mockResolvedValue(1);
    const unconfirmed = await service.deliver(actor(), 'x', { completed: false }).catch((e) => e);
    expect(unconfirmed.getResponse().code).toBe(
      CHECK_REQUEST_ERROR_CODES.DELIVERY_CONFIRMATION_REQUIRED
    );

    const current = row({ status: 7 });
    happyPath(repository, current, row({ status: 8 }));
    repository.completeDelivery.mockResolvedValue(row({ status: 8 }));
    await service.deliver(actor(), current.id, { completed: true });
    expect(repository.completeDelivery).toHaveBeenCalledWith(
      TENANT,
      current.id,
      7,
      8,
      expect.objectContaining({ confirmed: true }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({ action: 'deliver' });
  });

  it('TERMINAL states refuse every stage action — 8 and 50 are dead ends', async () => {
    const { service, repository } = buildService();
    for (const status of [8, 50]) {
      repository.findById.mockResolvedValue(row({ status }));
      const issue = await service.issue(actor(), 'x', { confirmed: true }).catch((e) => e);
      expect(issue).toBeInstanceOf(ConflictException);
      const deliver = await service.deliver(actor(), 'x', { completed: true }).catch((e) => e);
      expect(deliver).toBeInstanceOf(ConflictException);
    }
    expect(repository.confirmIssue).not.toHaveBeenCalled();
    expect(repository.completeDelivery).not.toHaveBeenCalled();
  });

  it('404s a foreign/absent row before any gate runs', async () => {
    const { service, repository, attachments } = buildService();
    repository.findById.mockResolvedValue(null);

    await expect(service.issue(actor(), 'x', { confirmed: true })).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(attachments.countByRequestSection).not.toHaveBeenCalled();
  });
});

describe('Phase CHECK-ISSUATION — availableActions + the detail projection', () => {
  it('lists the pinned definition\'s actions for the row\'s state, with labels and capabilities', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const result = await service.availableActions(actor(), 'x');
    expect(result).toMatchObject({
      processKey: 'financial.check-issuance',
      processVersion: 1,
      state: 2,
      terminal: false,
      step: { key: 'manager-review', title: 'تایید مدیر', order: 2 },
    });
    expect(result.actions.map((action) => action.action).sort()).toEqual([
      'approve',
      'reject',
      'request-correction',
    ]);
    for (const action of result.actions) {
      expect(action.enabled).toBe(true);
      expect(action.reason).toBeNull();
      expect(action.permission).toBe('financial.check.approve');
    }
  });

  it('marks self-approval DISABLED with the stable reason — the requester sees the block', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const result = await service.availableActions(actor({ userId: REQUESTER }), 'x');
    for (const action of result.actions) {
      expect(action.enabled).toBe(false);
      expect(action.reason).toBe('SELF_APPROVAL');
    }
  });

  it('is EMPTY at both terminal states — the wizard has nothing to offer after 8 or 50', async () => {
    const { service, repository } = buildService();
    for (const status of [8, 50]) {
      repository.findById.mockResolvedValue(row({ status }));
      const result = await service.availableActions(actor(), 'x');
      expect(result.terminal).toBe(true);
      expect(result.actions).toEqual([]);
    }
  });

  it('offers the stage actions with their own capabilities — allocate/review/issue/deliver', async () => {
    const { service, repository } = buildService();
    const expectations: Array<[number, string, string]> = [
      [3, 'allocate', 'financial.check.allocate'],
      [4, 'document-review', 'financial.check.review'],
      [6, 'issue', 'financial.check.issue'],
      [7, 'deliver', 'financial.check.deliver'],
    ];
    for (const [status, actionKey, permission] of expectations) {
      repository.findById.mockResolvedValue(row({ status }));
      const result = await service.availableActions(actor(), 'x');
      const action = result.actions.find((candidate) => candidate.action === actionKey)!;
      expect({ status, permission: action.permission }).toEqual({ status, permission });
    }
  });

  it('builds the detail projection: process step + stage records, Decimals as strings, dates as YYYY-MM-DD', async () => {
    const { service, repository } = buildService();
    const current = row({ status: 4 });
    repository.findByIdWithStages.mockResolvedValue({
      ...stageRow(current),
      allocation: {
        id: 'allocation-1',
        tenantId: TENANT,
        checkRequestId: current.id,
        allocationPlace: 'بانک ملت',
        balance: { toString: () => '5000' },
        checkDate: new Date('2026-10-10T00:00:00.000Z'),
        checkDescription: null,
        checkAmount: { toString: () => '4000' },
        payableTo: null,
        recordedByUserId: OTHER,
        createdAt: new Date('2026-10-04T09:00:00.000Z'),
        updatedAt: new Date('2026-10-04T09:00:00.000Z'),
      },
    });

    const detail = await service.getOne(actor(), current.id);
    expect(detail.process).toMatchObject({
      processKey: 'financial.check-issuance',
      processVersion: 1,
      terminal: false,
      step: { key: 'document-review' },
    });
    expect(detail.stages.allocation).toMatchObject({
      allocationPlace: 'بانک ملت',
      balance: '5000',
      checkAmount: '4000',
      checkDate: '2026-10-10',
    });
    expect(detail.stages.documentReview).toBeNull();
    expect(detail.stages.issue).toBeNull();
  });
});
