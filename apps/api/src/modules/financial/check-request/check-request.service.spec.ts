import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { UserDirectoryContract } from '../../../platform/user-directory/user-directory.contract';
import type { FinancialAuditGateway } from '../financial-audit.gateway';
import type { CheckAttachmentRepository } from './check-attachment.repository';
import type { CheckRequestRepository } from './check-request.repository';
import { CheckRequestService } from './check-request.service';
import type { CreateCheckRequestDto } from './check-request.dto';
import { CHECK_REQUEST_ERROR_CODES } from './check-request';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckRequest application surface.
 *
 * WHAT IS PINNED HERE, one fact per test, deliberately:
 *  1. THE REQUESTER IS FORCED from the actor — a forged wire field cannot exist (the DTO
 *     has none) and a machine context is refused.
 *  2. THE SOURCE'S VALIDATION CHAIN V1–V5 in the source's own order, each as a typed code.
 *  3. THE SERVER-GENERATED TITLE and the V7 conditional clearing, including on the PATCH
 *     merge — a client cannot keep a salary request's order reference by omission.
 *  4. THE TENANT FIRST: every repository call receives `actor.tenantId`; a foreign row is
 *     a 404 indistinguishable from a missing one.
 *  5. THE TRANSITION GUARDS and the typed 409s, plus the self-approval refusal and the
 *     "no human actor" refusal.
 *  6. THE AUDIT TRAIL: exactly one event per successful write, carrying the transition.
 *  7. THE TIMELINE: bound server-side to (tenant, financial.check-request, row id), a
 *     platform rejection as 503/422 — never an empty page.
 */

const TENANT = 'tenant-a';
const REQUESTER = 'user-requester';
const MANAGER = 'user-manager';

const actor = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  userId: REQUESTER,
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  ...overrides,
});

const managerActor = (overrides: Record<string, unknown> = {}) =>
  actor({ userId: MANAGER, ...overrides });

let seq = 0;
function row(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date('2026-10-03T08:00:00.000Z');
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
    status: 0,
    // The process pin every row carries (brief §5) — the service resolves the step,
    // available actions and stage gates through it, so fixtures state it honestly.
    processKey: 'financial.check-issuance',
    processVersion: 1,
    managerDecision: null,
    managerComment: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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
  // The stage gate reads section evidence through the ATTACHMENT repository (the table's
  // one writer) — phase CHECK-ISSUATION added it as the service's fourth dependency.
  const attachments = {
    countByRequestSection: jest.fn().mockResolvedValue(0),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
    // Phase B2.1: compliance-critical mutations call buildOutboxPayload instead of record.
    buildOutboxPayload: jest.fn().mockReturnValue({
      tenantId: TENANT,
      auditId: 'mock-audit-id',
      payload: {},
    }),
  };
  const directory = { findTenantMember: jest.fn().mockResolvedValue({ id: 'member' }) };
  // W2-C: the order-reference port — resolves every stated reference by default;
  // individual tests override `resolve` to exercise the rejection path.
  const orderReferences: { resolve: jest.Mock } = {
    resolve: jest.fn(async (_tenantId: string, orderReference: string) => ({
      orderReference,
      projectReference: null,
      displayName: orderReference,
    })),
  };

  const service = new CheckRequestService(
    repository as unknown as CheckRequestRepository,
    attachments as unknown as CheckAttachmentRepository,
    audit as unknown as FinancialAuditGateway,
    directory as unknown as UserDirectoryContract,
    orderReferences
  );
  return { service, repository, attachments, audit, directory, orderReferences };
}

describe('Phase F1 — CheckRequestService.create', () => {
  it('forces requesterUserId from the ACTOR and generates the title server-side', async () => {
    const { service, repository, audit } = buildService();
    repository.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      row({ ...data, tenantId })
    );

    const view = await service.create(actor(), {
      checkIssueType: 'PURCHASE',
      purchaseType: 'NON_PROJECT',
      orderReference: 'ORDER-9',
    });

    expect(repository.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        requesterUserId: REQUESTER,
        title: 'صدور چک برای خرید غیر پروژه ای',
        orderReference: 'ORDER-9',
      })
    );
    expect(view.requesterUserId).toBe(REQUESTER);
    expect(view.status).toBe(0);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'create',
      resource: 'financial.check-request',
    });
  });

  it('refuses a machine context with no requester (V6)', async () => {
    const { service, repository } = buildService();
    await expect(
      service.create(actor({ userId: null }), { checkIssueType: 'SALARY' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('applies the source’s validation chain V1–V5 in order, with typed codes', async () => {
    const { service, repository } = buildService();

    const expectCode = async (dto: CreateCheckRequestDto, code: string) => {
      const error = await service.create(actor(), dto).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().code).toBe(code);
    };

    await expectCode(
      { checkIssueType: 'PURCHASE' },
      CHECK_REQUEST_ERROR_CODES.PURCHASE_TYPE_REQUIRED
    );
    await expectCode(
      { checkIssueType: 'PURCHASE', purchaseType: 'PROJECT' },
      CHECK_REQUEST_ERROR_CODES.PROJECT_REQUIRED
    );
    await expectCode(
      { checkIssueType: 'PURCHASE', purchaseType: 'PROJECT', projectReference: 'P-1' },
      CHECK_REQUEST_ERROR_CODES.ORDER_REFERENCE_REQUIRED
    );
    await expectCode(
      {
        checkIssueType: 'PURCHASE',
        purchaseType: 'PROJECT',
        projectReference: 'P-1',
        orderReference: 'O-1',
      },
      CHECK_REQUEST_ERROR_CODES.PROJECT_MANAGER_REQUIRED
    );
    // A تنخواه does NOT require a purchase type (the source only demands it for خرید) —
    // and a تنخواه with no purchase type is therefore accepted.
    repository.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      row({ ...data, tenantId })
    );
    await expect(service.create(actor(), { checkIssueType: 'PETTY_CASH' })).resolves.toBeTruthy();
  });

  it('rejects a PURCHASE order reference that resolves to nothing — typed code, nothing written (W2-C)', async () => {
    const { service, repository, orderReferences } = buildService();
    orderReferences.resolve.mockResolvedValue(null);

    const error = await service
      .create(actor(), {
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: 'PR-0000-foreign',
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.ORDER_REFERENCE_UNKNOWN);
    expect(orderReferences.resolve).toHaveBeenCalledWith(TENANT, 'PR-0000-foreign');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('does NOT consult the order port for non-PURCHASE types or an absent reference', async () => {
    const { service, repository, orderReferences } = buildService();
    repository.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      row({ ...data, tenantId })
    );

    await service.create(actor(), { checkIssueType: 'PETTY_CASH' });
    await service.create(actor(), { checkIssueType: 'SALARY' });

    expect(orderReferences.resolve).not.toHaveBeenCalled();
  });

  it('clears for حقوق: orderReference, purchaseType and projectReference (V7)', async () => {
    const { service, repository } = buildService();
    repository.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      row({ ...data, tenantId })
    );

    await service.create(actor(), {
      checkIssueType: 'SALARY',
      purchaseType: 'PROJECT',
      orderReference: 'O-1',
      projectReference: 'P-1',
    });

    expect(repository.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        orderReference: null,
        purchaseType: null,
        projectReference: null,
        title: 'صدور چک برای حقوق',
      })
    );
  });

  it('clears for تنخواه: ONLY the order reference (V7)', async () => {
    const { service, repository } = buildService();
    repository.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      row({ ...data, tenantId })
    );

    await service.create(actor(), {
      checkIssueType: 'PETTY_CASH',
      purchaseType: 'PROJECT',
      orderReference: 'O-1',
      projectReference: 'P-1',
      projectManagerUserId: MANAGER,
    });

    expect(repository.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        orderReference: null,
        purchaseType: 'PROJECT',
        projectReference: 'P-1',
        title: 'صدور چک برای تنخواه پروژه ای',
      })
    );
  });

  it('membership-checks the project manager BEFORE storing, tenant-scoped', async () => {
    const { service, repository, directory } = buildService();
    directory.findTenantMember.mockResolvedValue(null);

    const error = await service
      .create(actor(), {
        checkIssueType: 'PURCHASE',
        purchaseType: 'PROJECT',
        orderReference: 'O-1',
        projectReference: 'P-1',
        projectManagerUserId: MANAGER,
      })
      .catch((e) => e);

    expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, MANAGER);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.PROJECT_MANAGER_NOT_MEMBER);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('Phase F1 — CheckRequestService.update', () => {
  it('404s a row of another tenant — existence never leaks', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(null);

    await expect(
      service.update(actor(), 'x', { purchaseType: 'NON_PROJECT' })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findById).toHaveBeenCalledWith(TENANT, 'x');
  });

  it('409s once the manager owns the row (state 2), naming the current state', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const error = await service
      .update(actor(), 'x', { purchaseType: 'NON_PROJECT' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
    expect(repository.updateEditable).not.toHaveBeenCalled();
  });

  it('refuses an empty patch — a no-op must not reach the trail', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 0 }));

    await expect(service.update(actor(), 'x', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.updateEditable).not.toHaveBeenCalled();
  });

  it('re-applies the V7 clearing to the MERGED facts and rebuilds the title', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(
      row({
        status: 1,
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: 'O-1',
      })
    );
    repository.updateEditable.mockImplementation(
      async (tenantId: string, id: string, data: Record<string, unknown>) =>
        row({ id, tenantId, status: 1, ...data })
    );

    await service.update(actor(), 'x', { checkIssueType: 'SALARY' });

    expect(repository.updateEditable).toHaveBeenCalledWith(
      TENANT,
      'x',
      expect.objectContaining({
        checkIssueType: 'SALARY',
        purchaseType: null,
        orderReference: null,
        projectReference: null,
        title: 'صدور چک برای حقوق',
      })
    );
  });

  it('409s when the conditional write loses a race, re-reading the CURRENT status', async () => {
    const { service, repository } = buildService();
    repository.findById
      .mockResolvedValueOnce(row({ status: 1 }))
      .mockResolvedValueOnce(row({ status: 2 }));
    repository.updateEditable.mockResolvedValue(null);

    const error = await service
      .update(actor(), 'x', { requesterOpinion: 'CANCEL' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().message).toContain('state 2');
  });
});

describe('Phase F1 — CheckRequestService.submit', () => {
  it('routes {0,1} → 2 through the conditional repository write and audits ONE submit', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(row({ status: 0 }));
    repository.submit.mockResolvedValue(row({ status: 2 }));

    const view = await service.submit(actor(), 'x');

    // Phase B2.1: submit now uses the durable outbox path — buildOutboxPayload is
    // called instead of record, and the outbox payload is passed to the repository.
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action: 'submit',
      resource: 'financial.check-request',
      oldValue: { status: 0 },
      changedFields: ['status'],
    });
    expect(repository.submit).toHaveBeenCalledWith(
      TENANT, 'x', 0, expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(view.status).toBe(2);
  });

  it('re-validates the STORED facts at submit (the source validates on forward too)', async () => {
    const { service, repository } = buildService();
    // A خرید that lost its order reference must not reach the manager.
    repository.findById.mockResolvedValue(
      row({
        status: 1,
        checkIssueType: 'PURCHASE',
        purchaseType: 'NON_PROJECT',
        orderReference: null,
      })
    );

    const error = await service.submit(actor(), 'x').catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.ORDER_REFERENCE_REQUIRED);
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it('409s a double submit — only the requester-owned states can be submitted', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const error = await service.submit(actor(), 'x').catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
  });
});

describe('Phase F1 — CheckRequestService.decide', () => {
  const decideOk = (expected: 'APPROVE' | 'REJECT' | 'REQUEST_CORRECTION') => async () => {
    const { service, repository, audit } = buildService();
    const landing = expected === 'APPROVE' ? 3 : expected === 'REJECT' ? 50 : 1;
    repository.findById.mockResolvedValue(row({ status: 2 }));
    repository.decide.mockResolvedValue(
      row({
        status: landing,
        managerDecision: expected,
        decidedByUserId: MANAGER,
        decidedAt: new Date(),
      })
    );

    const view = await service.decide(managerActor(), 'x', expected, { comment: 'ok' });

    // Phase B2.1: decide now uses the durable outbox path.
    expect(repository.decide).toHaveBeenCalledWith(
      TENANT,
      'x',
      2,
      expect.objectContaining({
        status: landing,
        managerDecision: expected,
        decidedByUserId: MANAGER,
      }),
      expect.objectContaining({ tenantId: TENANT, auditId: 'mock-audit-id' }),
    );
    expect(view.managerDecision).toBe(expected);
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action:
        expected === 'APPROVE'
          ? 'approve'
          : expected === 'REJECT'
            ? 'reject'
            : 'request_correction',
      resource: 'financial.check-request',
      oldValue: { status: 2 },
    });
    return { service, repository, audit };
  };

  it('APPROVE lands state 3 and records the decision — and NOTHING downstream runs', async () => {
    const { repository } = await decideOk('APPROVE')();
    // Exactly ONE repository write: state 3 has no allocation, no issuance and no
    // queue — the brief's §12 defers all of it.
    expect(repository.decide).toHaveBeenCalledTimes(1);
    expect(repository.decide.mock.calls[0][3]).toMatchObject({ status: 3 });
  });

  it('REJECT lands state 50 (terminal)', async () => {
    const { repository } = await decideOk('REJECT')();
    expect(repository.decide.mock.calls[0][3]).toMatchObject({ status: 50 });
  });

  it('REQUEST_CORRECTION returns state 1 — the requester re-owns it (§7.4)', async () => {
    const { repository } = await decideOk('REQUEST_CORRECTION')();
    expect(repository.decide.mock.calls[0][3]).toMatchObject({ status: 1 });
  });

  it('refuses self-approval fail-closed — the requester cannot decide their own request', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    const error = await service
      .decide(actor({ userId: REQUESTER }), 'x', 'APPROVE', {})
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('refuses a machine context with no human actor (fail-closed)', async () => {
    const { service, repository } = buildService();
    repository.findById.mockResolvedValue(row({ status: 2 }));

    await expect(
      service.decide(actor({ userId: null }), 'x', 'APPROVE', {})
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('409s every decision from a state that is not MANAGER_REVIEW', async () => {
    const { service, repository } = buildService();
    for (const status of [0, 1, 3, 50]) {
      repository.findById.mockResolvedValue(row({ status }));
      const error = await service.decide(managerActor(), 'x', 'APPROVE', {}).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT);
    }
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('409s a double decision — the conditional write loses and the trail stays single', async () => {
    const { service, repository, audit } = buildService();
    repository.findById
      .mockResolvedValueOnce(row({ status: 2 }))
      .mockResolvedValueOnce(row({ status: 3 }));
    repository.decide.mockResolvedValue(null);

    const error = await service.decide(managerActor(), 'x', 'APPROVE', {}).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    // Phase B2.1: buildOutboxPayload is called before the repository write, but when the
    // repository returns null (conflict), the outbox payload is never committed. The
    // old best-effort record() is no longer called for compliance-critical mutations.
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('Phase F1 — CheckRequestService.getOne / list', () => {
  it('resolves one row tenant-scoped (with its stage records) and 404s a foreign id', async () => {
    const { service, repository } = buildService();
    // Phase CHECK-ISSUATION: getOne reads the row through `findByIdWithStages`, so the
    // DETAIL view can carry the process pin and the five stage records in ONE
    // tenant-scoped read.
    repository.findByIdWithStages.mockResolvedValue({
      ...row(),
      allocation: null,
      documentReview: null,
      executiveApproval: null,
      issue: null,
      delivery: null,
    });

    await expect(service.getOne(actor(), 'x')).resolves.toBeTruthy();
    expect(repository.findByIdWithStages).toHaveBeenCalledWith(TENANT, 'x');

    repository.findByIdWithStages.mockResolvedValue(null);
    await expect(service.getOne(actor(), 'y')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists the ACTOR tenant only, clamping the window to the module ceiling', async () => {
    const { service, repository } = buildService();
    repository.list.mockResolvedValue({ items: [row()], total: 1 });

    const page = await service.list(actor(), { page: 999, pageSize: 5000, status: 2 });

    expect(repository.list).toHaveBeenCalledWith(TENANT, expect.objectContaining({ status: 2 }));
    expect(page.page).toBe(999);
    expect(page.pageSize).toBe(100); // FINANCIAL_MAX_PAGE_SIZE — clamped, not silently passed
    expect(page.items[0]).not.toHaveProperty('storageKey');
  });
});

describe('Phase F1 — CheckRequestService.getTimeline', () => {
  it('binds (tenant, resource, row id, page) server-side and projects a 7-field whitelist', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(row({ id: '11111111-1111-4111-8111-111111111111' }));
    audit.read.mockResolvedValue({
      status: 'ok',
      page: {
        items: [
          {
            id: 'audit-1',
            action: 'submit',
            actorId: REQUESTER,
            success: true,
            reason: null,
            changedFields: ['status'],
            createdAt: '2026-10-03T08:00:00.000Z',
            // Fields the projection must NOT leak:
            tenantId: TENANT,
            ip: '10.0.0.1',
            userAgent: 'leak',
            newValue: { secret: true },
          },
        ],
        page: 2,
        pageSize: 10,
        total: 1,
      },
    });

    const timeline = await service.getTimeline(actor(), '11111111-1111-4111-8111-111111111111', {
      page: 2,
      pageSize: 10,
    });

    expect(audit.read).toHaveBeenCalledWith({
      tenantId: TENANT,
      resource: 'financial.check-request',
      resourceId: '11111111-1111-4111-8111-111111111111',
      page: 2,
      pageSize: 10,
    });
    expect(Object.keys(timeline.items[0]).sort()).toEqual([
      'action',
      'actorId',
      'changedFields',
      'createdAt',
      'id',
      'reason',
      'success',
    ]);
    expect(timeline.page).toBe(2);
    expect(timeline.total).toBe(1);
  });

  it('answers an EMPTY trail with an empty page — nothing recorded is not a failure', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(row());
    audit.read.mockResolvedValue({
      status: 'ok',
      page: { items: [], page: 1, pageSize: 20, total: 0 },
    });

    const timeline = await service.getTimeline(actor(), 'x', {});
    expect(timeline.items).toEqual([]);
    expect(timeline.total).toBe(0);
  });

  it('maps AUDIT_READ_FAILED to a 503 and every other rejection to a 422 — never an empty page', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(row());
    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_FAILED' });
    await expect(service.getTimeline(actor(), 'x', {})).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );

    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_PAGE_INVALID' });
    await expect(service.getTimeline(actor(), 'x', {})).rejects.toBeInstanceOf(
      UnprocessableEntityException
    );
  });

  it('404s before touching the audit port for a foreign row', async () => {
    const { service, repository, audit } = buildService();
    repository.findById.mockResolvedValue(null);

    await expect(service.getTimeline(actor(), 'x', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.read).not.toHaveBeenCalled();
  });
});
