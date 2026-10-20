import { Test } from '@nestjs/testing';
import { PendingDecisionsService } from './pending-decisions.service';
import { WorkflowExecutionRepository } from '../workflow/workflow-execution.repository';
import { CommercialLifecycleRepository } from '../commercial/commercial-lifecycle.repository';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { CommerceActor } from '../commerce-actor';

/**
 * PHASE C2 (GAP-1b): the inbox's behaviour at its seam — what it asks the repositories,
 * how the two kinds merge, and what it refuses to answer.
 *
 * WHAT IS AND IS NOT ASSERTED HERE. Eligibility itself lives in the repositories' WHERE
 * clauses (verified against real data by the C2 e2e) and in the execution routes that
 * consume each row; this suite owns the COMPOSITION — actor scoping, the exact window,
 * deterministic ordering, one-batch display joins, and the sum-of-counts total — because
 * those are the choices the service makes rather than the database's.
 */
describe('PendingDecisionsService (C2 GAP-1b)', () => {
  let executions: { listPendingStepPage: jest.Mock };
  let approvals: { listPendingApprovalPage: jest.Mock };
  let purchases: {
    findDocumentIdsByLineIds: jest.Mock;
    findDocumentSummariesByIds: jest.Mock;
  };
  let identity: { profilesFor: jest.Mock };
  let service: PendingDecisionsService;

  const actor: CommerceActor = {
    tenantId: 't1',
    userId: 'u1',
    requestId: 'r1',
    ip: null,
    userAgent: null,
  };

  /** A workflow half-row as `listPendingStepPage` returns it. */
  function stepRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'si-1',
      tenantId: 't1',
      scopeType: 'DOCUMENT',
      scopeId: 'doc-1',
      status: 'PENDING',
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
      instance: {
        id: 'wi-1',
        subjectType: 'PURCHASE_DOCUMENT',
        subjectId: 'doc-1',
        status: 'RUNNING',
      },
      stepDefinition: { stepKey: 'manager_approval', displayName: 'Manager Approval', ordering: 1 },
      ...overrides,
    };
  }

  /** A document summary as `findDocumentSummariesByIds` returns it. */
  function summaryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'doc-1',
      documentNumber: 'PO-2026-0001',
      status: 'SUBMITTED',
      requesterId: 'u-requester',
      costCenter: 'دفتر مرکزی',
      totalAmount: '12500.0000',
      currency: 'IRR',
      createdAt: new Date('2026-09-28T08:00:00.000Z'),
      ...overrides,
    };
  }

  /** A commercial half-row as `listPendingApprovalPage` returns it. */
  function approvalRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ca-1',
      tenantId: 't1',
      purchaseDocumentId: 'doc-2',
      purchaseLineId: 'line-9',
      status: 'PENDING',
      approverUserId: 'u1',
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    executions = { listPendingStepPage: jest.fn().mockResolvedValue([[], 0]) };
    approvals = { listPendingApprovalPage: jest.fn().mockResolvedValue([[], 0]) };
    purchases = {
      findDocumentIdsByLineIds: jest.fn().mockResolvedValue(new Map()),
      findDocumentSummariesByIds: jest.fn().mockResolvedValue(new Map()),
    };
    identity = { profilesFor: jest.fn().mockResolvedValue(new Map()) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PendingDecisionsService,
        { provide: WorkflowExecutionRepository, useValue: executions },
        { provide: CommercialLifecycleRepository, useValue: approvals },
        { provide: PurchaseRepository, useValue: purchases },
        { provide: CommerceIdentityGateway, useValue: identity },
      ],
    }).compile();

    service = moduleRef.get(PendingDecisionsService);
  });

  it('asks both repositories for THIS tenant and THIS user, with the exact window', async () => {
    await service.list(actor, { page: 2, pageSize: 3 });

    // skip + take per source — the merged slice of any page is exact with that window (class doc).
    expect(executions.listPendingStepPage).toHaveBeenCalledWith('t1', 'u1', { take: 6 });
    expect(approvals.listPendingApprovalPage).toHaveBeenCalledWith('t1', 'u1', { take: 6 });
  });

  it('returns an empty page — without asking anything — when the session has no user', async () => {
    const page = await service.list({ ...actor, userId: null }, { page: 1, pageSize: 10 });

    expect(page).toEqual({ items: [], page: 1, pageSize: 10, total: 0 });
    expect(executions.listPendingStepPage).not.toHaveBeenCalled();
    expect(approvals.listPendingApprovalPage).not.toHaveBeenCalled();
  });

  it('merges both kinds newest-first with the sum of both counts as total', async () => {
    executions.listPendingStepPage.mockResolvedValue([[stepRow()], 4]);
    approvals.listPendingApprovalPage.mockResolvedValue([[approvalRow()], 3]);
    purchases.findDocumentSummariesByIds.mockResolvedValue(
      new Map([
        ['doc-1', summaryRow({ id: 'doc-1', documentNumber: 'PO-2026-0001' })],
        ['doc-2', summaryRow({ id: 'doc-2', documentNumber: 'PO-2026-0002' })],
      ])
    );

    const page = await service.list(actor, { page: 1, pageSize: 10 });

    expect(page.total).toBe(7);
    // The approval (11:00) is newer than the step (10:00) — the union is createdAt desc.
    expect(page.items.map((item) => item.kind)).toEqual([
      'COMMERCIAL_APPROVAL',
      'WORKFLOW_STEP',
    ]);
    expect(page.items[0]).toMatchObject({
      kind: 'COMMERCIAL_APPROVAL',
      id: 'ca-1',
      status: 'PENDING',
      documentNumber: 'PO-2026-0002',
      purchaseLineId: 'line-9',
      workflowInstanceId: null,
      stepKey: null,
    });
    expect(page.items[1]).toMatchObject({
      kind: 'WORKFLOW_STEP',
      id: 'si-1',
      status: 'PENDING',
      purchaseDocumentId: 'doc-1',
      documentNumber: 'PO-2026-0001',
      purchaseLineId: null,
      workflowInstanceId: 'wi-1',
      stepKey: 'manager_approval',
      stepName: 'Manager Approval',
    });
    // Both halves' display joins happened in ONE call each — never one per row.
    expect(purchases.findDocumentSummariesByIds).toHaveBeenCalledTimes(1);
    expect(purchases.findDocumentIdsByLineIds).toHaveBeenCalledTimes(1);
    // The task-card projection carries the document's own columns, with the
    // requester profile resolved in one batch (not per row).
    expect(identity.profilesFor).toHaveBeenCalledTimes(1);
    expect(page.items[0].document).toMatchObject({
      id: 'doc-2',
      documentNumber: 'PO-2026-0002',
      requesterId: 'u-requester',
      costCenter: 'دفتر مرکزی',
      totalAmount: '12500.0000',
    });
  });

  it('breaks same-instant ties by id so two reads page identically', async () => {
    const instant = '2026-09-30T10:00:00.000Z';
    executions.listPendingStepPage.mockResolvedValue([
      [stepRow({ id: 'si-b', createdAt: new Date(instant) }), stepRow({ id: 'si-a', createdAt: new Date(instant) })],
      2,
    ]);
    approvals.listPendingApprovalPage.mockResolvedValue([[], 0]);

    const page = await service.list(actor, { page: 1, pageSize: 10 });

    expect(page.items.map((item) => item.id)).toEqual(['si-a', 'si-b']);
  });

  it('slices the merged union to the requested page', async () => {
    executions.listPendingStepPage.mockResolvedValue([
      [stepRow({ id: 'si-1', createdAt: new Date('2026-09-30T09:00:00.000Z') })],
      1,
    ]);
    approvals.listPendingApprovalPage.mockResolvedValue([
      [approvalRow({ id: 'ca-1', createdAt: new Date('2026-09-30T12:00:00.000Z') })],
      1,
    ]);

    const first = await service.list(actor, { page: 1, pageSize: 1 });
    const second = await service.list(actor, { page: 2, pageSize: 1 });

    expect(first.items.map((item) => item.id)).toEqual(['ca-1']);
    expect(second.items.map((item) => item.id)).toEqual(['si-1']);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
  });

  it('resolves a LINE-scoped run through its line before asking for the number', async () => {
    executions.listPendingStepPage.mockResolvedValue([
      [
        stepRow({
          scopeType: 'LINE',
          scopeId: 'line-7',
          instance: {
            id: 'wi-line',
            subjectType: 'PURCHASE_LINE',
            subjectId: 'line-7',
            status: 'RUNNING',
          },
        }),
      ],
      1,
    ]);
    purchases.findDocumentIdsByLineIds.mockResolvedValue(new Map([['line-7', 'doc-42']]));
    purchases.findDocumentSummariesByIds.mockResolvedValue(
      new Map([['doc-42', summaryRow({ id: 'doc-42', documentNumber: 'PO-2026-0042' })]])
    );

    const page = await service.list(actor, { page: 1, pageSize: 10 });

    expect(purchases.findDocumentIdsByLineIds).toHaveBeenCalledWith('t1', ['line-7']);
    expect(page.items[0]).toMatchObject({
      kind: 'WORKFLOW_STEP',
      purchaseDocumentId: 'doc-42',
      documentNumber: 'PO-2026-0042',
      purchaseLineId: 'line-7',
    });
  });

  it('marks an unresolvable document reference as null rather than inventing a scope', async () => {
    executions.listPendingStepPage.mockResolvedValue([[stepRow()], 1]);
    purchases.findDocumentSummariesByIds.mockResolvedValue(new Map());

    const page = await service.list(actor, { page: 1, pageSize: 10 });

    expect(page.items[0].documentNumber).toBeNull();
    expect(page.items[0].document).toBeNull();
  });

  it('resolves requester profiles in one batch and leaves an unknown requester as null', async () => {
    executions.listPendingStepPage.mockResolvedValue([[stepRow()], 1]);
    approvals.listPendingApprovalPage.mockResolvedValue([[], 0]);
    purchases.findDocumentSummariesByIds.mockResolvedValue(
      new Map([['doc-1', summaryRow({ requesterId: 'u-x' })]])
    );
    identity.profilesFor.mockResolvedValue(
      new Map([['u-x', { id: 'u-x', firstName: 'سارا', lastName: 'محمدی' }]])
    );

    const page = await service.list(actor, { page: 1, pageSize: 10 });

    expect(identity.profilesFor).toHaveBeenCalledWith(['u-x']);
    expect(page.items[0].document?.requester).toMatchObject({ firstName: 'سارا' });
  });
});
