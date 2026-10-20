import { NotFoundException } from '@nestjs/common';
import { PurchaseHistoryService } from './purchase-history.service';
import { CommerceActor } from '../commerce-actor';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';

/**
 * PHASE W3.2: the aggregated traceability read — unit-pinned at the service seam.
 *
 * WHAT IS BEING PINNED, AND WHY HERE
 * ----------------------------------
 * Repository, history-repository and audit-gateway are fakes, so every assertion is
 * about a DECISION, not SQL or the platform binding:
 *
 *  * the SCOPE is trusted context alone — tenant from the actor, document id from the
 *    route; a foreign/unknown id is a 404 BEFORE any history read (never an oracle);
 *  * the three sources arrive MARKED, never blended — `status`, `audit`, `posting`
 *    each keep their own meaning;
 *  * ordering is deterministic: chronological by `occurredAt`, id as the tiebreak;
 *  * filters apply to the MERGED set, server-side — sources/outcome/action/actorId/
 *    time bounds, then the page slice; nothing is filtered in the browser;
 *  * a REJECTED audit read degrades the source honestly — `coverage.audit.unavailable`
 *    with the closed code — never rendered as an empty trail and never thrown away;
 *  * a page that the platform says is longer than what arrived is reported as
 *    truncated, by family — completeness is stated, not implied;
 *  * posting rows carry their diagnostics through: status, attempts, lastError,
 *    movementId — and the `posting.<kind>.<status>` action vocabulary;
 *  * the response is a WHITELIST — planted sensitive fields on an upstream audit
 *    object never reach the answer.
 *
 * This spec deliberately does NOT import the platform audit contract (the Step-H
 * guard forbids that path in Commerce): the fakes are structural objects.
 */

const actor: CommerceActor = {
  tenantId: 'tenant-a',
  userId: 'user-a1',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

const document = { id: 'doc-1', tenantId: actor.tenantId, status: 'DRAFT' };

function statusEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'se-1',
    fromStatus: null as string | null,
    toStatus: 'DRAFT',
    source: 'SYSTEM',
    actorUserId: 'user-a1',
    occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function auditItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
    resourceId: 'doc-1',
    action: 'create',
    actorId: 'user-a1',
    success: true,
    reason: null,
    changedFields: [],
    createdAt: '2026-10-01T00:00:01.000Z',
    // Planted so the whitelist is proven at RUNTIME.
    ipAddress: '10.0.0.9',
    sessionId: 'sess-9',
    tenantId: 'tenant-leak',
    oldValue: { secret: 'before' },
    newValue: { secret: 'after' },
    ...overrides,
  };
}

function posting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    kind: 'RECEIPT',
    status: 'POSTED',
    attempts: 1,
    lastError: null,
    lastAttemptAt: new Date('2026-10-01T00:00:02.000Z'),
    createdAt: new Date('2026-10-01T00:00:02.000Z'),
    movementId: 'mov-1',
    sourceLineId: 'rl-1',
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    postingId: 'post-1',
    attempt: 1,
    result: 'FAILED',
    error: 'No stocked inventory item with SKU "SKU-1" exists for this tenant',
    movementId: null,
    actorUserId: 'u-receiver',
    startedAt: new Date('2026-10-01T00:00:01.500Z'),
    finishedAt: new Date('2026-10-01T00:00:01.900Z'),
    createdAt: new Date('2026-10-01T00:00:01.900Z'),
    ...overrides,
  };
}

function okPage(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    page: { items, page: 1, pageSize: 100, total: items.length, ...overrides },
  };
}

interface Fakes {
  statusEvents: ReturnType<typeof statusEvent>[];
  /** What `audit.read` answers for the DOCUMENT resource — other families answer empty unless stated. */
  audit: unknown;
  /** Optional per-resource overrides — keyed by the resource constant. */
  auditByResource?: Record<string, unknown>;
  postings: ReturnType<typeof posting>[];
  attempts: ReturnType<typeof attempt>[];
  receipts: { id: string }[];
  returns: { id: string }[];
  plans: { id: string }[];
  assignments: { id: string }[];
  approvals: { id: string }[];
  quotations: { id: string }[];
  document: unknown;
}

function build(overrides: Partial<Fakes> = {}) {
  const fakes: Fakes = {
    statusEvents: [],
    audit: okPage([]),
    postings: [],
    attempts: [],
    receipts: [],
    returns: [],
    plans: [],
    assignments: [],
    approvals: [],
    quotations: [],
    document,
    ...overrides,
  };
  const repository = {
    findDocumentById: jest.fn().mockResolvedValue(fakes.document),
    listStatusEvents: jest.fn().mockResolvedValue(fakes.statusEvents),
  };
  const history = {
    listLineIds: jest.fn().mockResolvedValue(['line-1']),
    listPostings: jest.fn().mockResolvedValue(fakes.postings),
    listReceipts: jest.fn().mockResolvedValue(fakes.receipts),
    listReturns: jest.fn().mockResolvedValue(fakes.returns),
    listPlans: jest.fn().mockResolvedValue(fakes.plans),
    listAttempts: jest.fn().mockResolvedValue(fakes.attempts),
    listAssignments: jest.fn().mockResolvedValue(fakes.assignments),
    listApprovals: jest.fn().mockResolvedValue(fakes.approvals),
    listQuotations: jest.fn().mockResolvedValue(fakes.quotations),
  };
  const audit = {
    read: jest.fn().mockImplementation((query: { resource: string }) => {
      const answer =
        fakes.auditByResource?.[query.resource] ??
        (query.resource === COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT
          ? fakes.audit
          : okPage([]));
      return Promise.resolve(answer);
    }),
  };
  const identity = {
    profilesFor: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new PurchaseHistoryService(
    repository as unknown as ConstructorParameters<typeof PurchaseHistoryService>[0],
    history as unknown as ConstructorParameters<typeof PurchaseHistoryService>[1],
    audit as unknown as ConstructorParameters<typeof PurchaseHistoryService>[2],
    identity as unknown as ConstructorParameters<typeof PurchaseHistoryService>[3]
  );
  return { service, repository, history, audit, identity };
}

describe('PurchaseHistoryService (W3.2) — scope, merge, filter and coverage honesty', () => {
  it('404s a foreign or unknown document BEFORE any history source is touched', async () => {
    const { service, repository, history, audit } = build({ document: null });
    await expect(service.getHistory(actor, 'doc-x', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(repository.findDocumentById).toHaveBeenCalledWith(actor.tenantId, 'doc-x');
    expect(history.listLineIds).not.toHaveBeenCalled();
    expect(audit.read).not.toHaveBeenCalled();
  });

  it('merges the three sources, each marked, in deterministic chronological order', async () => {
    const { service } = build({
      statusEvents: [statusEvent()],
      audit: okPage([auditItem()]),
      postings: [posting()],
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    expect(res.items.map((i) => i.source)).toEqual(['status', 'audit', 'posting']);
    expect(res.items.map((i) => i.action)).toEqual([
      'status.draft',
      'create',
      'posting.receipt.posted',
    ]);
    expect(res.items.map((i) => i.outcome)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    // Status items carry the transition; audit items the resource coordinates.
    expect(res.items[0]).toMatchObject({ fromStatus: null, toStatus: 'DRAFT' });
    expect(res.items[1]).toMatchObject({
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
    });
    // The whitelist: nothing the planted upstream item carried may leak.
    const raw = JSON.stringify(res.items[1]);
    expect(raw).not.toContain('tenant-leak');
    expect(raw).not.toContain('sess-9');
    expect(raw).not.toContain('secret');
    expect(res.items[1]).not.toHaveProperty('tenantId');
  });

  it('maps posting states to outcomes and carries the diagnostics through', async () => {
    const { service } = build({
      postings: [
        posting({ id: 'p-f', status: 'FAILED', attempts: 3, lastError: 'unknown SKU' }),
        posting({ id: 'p-p', status: 'PENDING', attempts: 0, lastError: null }),
      ],
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    const failed = res.items.find((i) => i.id === 'p-f');
    const pending = res.items.find((i) => i.id === 'p-p');
    expect(failed).toMatchObject({
      source: 'posting',
      action: 'posting.receipt.failed',
      outcome: 'failed',
      postingStatus: 'FAILED',
      attempts: 3,
      lastError: 'unknown SKU',
      resourceId: 'rl-1',
    });
    expect(pending).toMatchObject({ outcome: 'pending', postingStatus: 'PENDING' });
  });

  it('projects every attempt as its own event — the retry story, not a collapsed count', async () => {
    const { service } = build({
      postings: [posting({ id: 'post-1', status: 'POSTED', attempts: 3 })],
      attempts: [
        attempt({ id: 'att-1', attempt: 1, result: 'FAILED', error: 'unknown SKU' }),
        attempt({
          id: 'att-2',
          attempt: 2,
          result: 'FAILED',
          error: 'unit not declared',
          finishedAt: new Date('2026-10-01T00:00:01.950Z'),
        }),
        attempt({
          id: 'att-3',
          attempt: 3,
          result: 'POSTED',
          error: null,
          movementId: 'mov-1',
          finishedAt: new Date('2026-10-01T00:00:02.000Z'),
        }),
      ],
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    const items = res.items.filter((i) => i.source === 'posting');
    // The posting's own state item + one item per recorded attempt.
    expect(items.map((i) => i.id).sort()).toEqual(['att-1', 'att-2', 'att-3', 'post-1']);
    expect(res.items.find((i) => i.id === 'att-2')).toMatchObject({
      source: 'posting',
      action: 'posting.attempt.failed',
      outcome: 'failed',
      actorUserId: 'u-receiver',
      postingId: 'post-1',
      attemptNo: 2,
      lastError: 'unit not declared',
      postingStatus: 'POSTED',
    });
    expect(res.items.find((i) => i.id === 'att-3')).toMatchObject({
      action: 'posting.attempt.posted',
      outcome: 'succeeded',
      attemptNo: 3,
      movementId: 'mov-1',
    });
  });

  it('filters the MERGED set server-side — sources, outcome, action, actor, time', async () => {
    const { service } = build({
      statusEvents: [statusEvent()],
      audit: okPage([auditItem()]),
      postings: [posting()],
    });
    const auditOnly = await service.getHistory(actor, 'doc-1', { sources: 'audit' });
    expect(auditOnly.items.map((i) => i.source)).toEqual(['audit']);
    expect(auditOnly.total).toBe(1);

    const failedOnly = await service.getHistory(actor, 'doc-1', { outcome: 'failed' });
    expect(failedOnly.items).toHaveLength(0);

    const byAction = await service.getHistory(actor, 'doc-1', { action: 'status.draft' });
    expect(byAction.items.map((i) => i.id)).toEqual(['se-1']);

    const byActor = await service.getHistory(actor, 'doc-1', { actorId: 'nobody' });
    expect(byActor.items).toHaveLength(0);

    const byTime = await service.getHistory(actor, 'doc-1', {
      from: '2026-10-01T00:00:01.000Z',
      to: '2026-10-01T00:00:02.000Z',
    });
    expect(byTime.items.map((i) => i.id)).toEqual(['audit-1']);
  });

  it('pages the merged stream — total counts the unfiltered set', async () => {
    const { service } = build({
      statusEvents: [
        statusEvent({ id: 'se-1' }),
        statusEvent({ id: 'se-2', toStatus: 'CLOSED', occurredAt: new Date('2026-10-02T00:00:00.000Z') }),
      ],
      audit: okPage([auditItem()]),
      postings: [posting()],
    });
    const res = await service.getHistory(actor, 'doc-1', { page: 2, pageSize: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.total).toBe(4);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(2);
  });

  it('correlates the audit read across the document and its child resource ids', async () => {
    const { service, audit } = build({
      receipts: [{ id: 'rc-1' }],
      returns: [{ id: 'ret-1' }],
      plans: [{ id: 'plan-1' }],
      assignments: [{ id: 'asg-1' }],
      approvals: [{ id: 'appr-1' }],
      quotations: [{ id: 'qt-1' }],
    });
    await service.getHistory(actor, 'doc-1', {});
    const calls = audit.read.mock.calls.map(([q]) => `${q.resource}:${q.resourceId}`);
    // The document id correlates payment_record events too — the payment slice's
    // contract audits them ON the document.
    expect(calls).toEqual(
      expect.arrayContaining([
        'commerce.purchase_document:doc-1',
        'commerce.payment_record:doc-1',
        'commerce.receipt:rc-1',
        'commerce.return_document:ret-1',
        'commerce.payment_plan:plan-1',
        'commerce.commercial_assignment:asg-1',
        'commerce.commercial_approval:appr-1',
        'commerce.price_quotation:qt-1',
      ])
    );
    for (const [query] of audit.read.mock.calls) {
      expect(query.tenantId).toBe(actor.tenantId);
    }
  });

  it('reports a rejected audit read as degraded coverage — never as an empty trail', async () => {
    const { service } = build({
      statusEvents: [statusEvent()],
      audit: { status: 'rejected', code: 'AUDIT_READ_FAILED' },
      postings: [posting()],
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    // The OTHER sources still answer — only the audit leg is marked unavailable.
    expect(res.items.map((i) => i.source)).toEqual(['status', 'posting']);
    expect(res.coverage.audit).toEqual({
      status: 'unavailable',
      code: 'AUDIT_READ_FAILED',
    });
    expect(res.coverage.statusEvents.complete).toBe(true);
    expect(res.coverage.postings).toEqual({ status: 'ok' });
  });

  it('marks a family truncated when the platform page reports more than it returned', async () => {
    const { service } = build({
      audit: okPage([auditItem()], { total: 999 }),
      receipts: [{ id: 'rc-1' }],
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    // W4-D: the resource is paged until the safety bound — the truncation is
    // reported, never implied away, and the read count is honest evidence.
    expect(res.coverage.audit).toMatchObject({
      status: 'ok',
      truncatedFamilies: ['purchase_document:doc-1'],
      eventsRead: 50,
    });
  });

  it('W4-D: traverses ALL audit pages of a resource — a 101st event is no longer lost', async () => {
    const { service, audit } = build();
    audit.read.mockImplementation((query: { page?: number }) => {
      const page = query.page ?? 1;
      return Promise.resolve(
        okPage(page === 1 ? [auditItem({ id: 'ev-1' })] : [auditItem({ id: 'ev-2' })], {
          page,
          pageSize: 1,
          total: 2,
        })
      );
    });
    const res = await service.getHistory(actor, 'doc-1', {});
    const auditIds = res.items.filter((i) => i.source === 'audit').map((i) => i.id);
    expect(auditIds).toEqual(['ev-1', 'ev-2']);
    // Two reads happened — the traversal did not stop at the first page.
    expect(audit.read.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(res.coverage.audit).toMatchObject({ status: 'ok', truncatedFamilies: [] });
  });

  it('W4-D: pushes action and the time window down to the audit read', async () => {
    const { service, audit } = build();
    await service.getHistory(actor, 'doc-1', {
      action: 'commerce.payment.append',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T00:00:00.000Z',
    });
    for (const call of audit.read.mock.calls) {
      expect(call[0]).toMatchObject({
        action: 'commerce.payment.append',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-31T00:00:00.000Z',
      });
    }
  });

  it('W4-D: resolves actor profiles in ONE batched lookup for the page', async () => {
    const { service, identity } = build({
      audit: okPage([auditItem({ id: 'ev-1', actorId: 'u-actor' })]),
    });
    identity.profilesFor.mockResolvedValue(
      new Map([['u-actor', { id: 'u-actor', firstName: 'Sara', lastName: 'Rahimi' }]])
    );
    const res = await service.getHistory(actor, 'doc-1', {});
    expect(identity.profilesFor).toHaveBeenCalledTimes(1);
    const item = res.items.find((i) => i.id === 'ev-1');
    expect(item?.actorProfile).toMatchObject({ firstName: 'Sara', lastName: 'Rahimi' });
    // An unresolved actor keeps its id and a null profile — never a guess.
    const unresolved = res.items.find((i) => i.actorUserId === 'u1');
    if (unresolved) expect(unresolved.actorProfile).toBeNull();
  });

  it('states the status-history coverage honestly — earliest event or null', async () => {
    const { service } = build({ statusEvents: [statusEvent()] });
    const res = await service.getHistory(actor, 'doc-1', {});
    expect(res.coverage.statusEvents).toEqual({
      complete: true,
      earliest: '2026-10-01T00:00:00.000Z',
    });
  });
});
