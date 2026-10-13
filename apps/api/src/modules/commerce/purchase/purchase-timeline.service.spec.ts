import {
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PurchaseTimelineService } from './purchase-timeline.service';
import { CommerceActor } from '../commerce-actor';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';

/**
 * PHASE C7 (GAP-7): the purchase audit-timeline application seam.
 *
 * WHAT IS BEING PINNED, AND WHY AT THIS SEAM
 * ------------------------------------------
 * The repository and the audit gateway are fakes, so every assertion here is about a
 * DECISION rather than about SQL or the platform binding:
 *
 *  * the SCOPE is built from trusted context alone — tenant from the actor, resource
 *    from the closed vocabulary, resourceId from the document the route addressed —
 *    with page/pageSize the ONLY values a request can contribute;
 *  * existence is checked TENANT-SCOPED and a foreign/unknown id is a 404 BEFORE the
 *    audit boundary is reached (the read is never an existence oracle);
 *  * a rejected read is NEVER rendered as an empty timeline: `AUDIT_READ_FAILED`
 *    becomes a 503, the other closed codes a 422, and neither becomes `items: []`;
 *  * a successful empty page IS returned honestly — `items: []` with the platform's
 *    `total`, which means "nothing recorded under this correlation", not "failed";
 *  * the projection is a WHITELIST: sensitive fields an upstream item might carry
 *    (ip, userAgent, snapshots, tenantId, …) never reach the response, whatever the
 *    object passed in contains;
 *  * page/pageSize are forwarded unchanged and the platform's `page`, `pageSize`,
 *    `total` and item ORDER are echoed back — Commerce adds no pagination convention.
 *
 * This spec deliberately does NOT import the platform audit contract (the Step-H guard
 * forbids it in Commerce specs): the fake below is a structural object, exactly as the
 * gateway's public surface accepts it.
 */

/** The acting subject: tenant and identity come from the session, never the request. */
const actor: CommerceActor = {
  tenantId: 'tenant-a',
  userId: 'user-a1',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

/** One document as `findDocumentById` returns it — only the id matters here. */
function storedDocument(id = 'doc-1') {
  return { id, tenantId: actor.tenantId, status: 'DRAFT' };
}

/** One item as the platform projects it — including fields this surface must NOT pass on. */
function platformItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
    resourceId: 'doc-1',
    action: 'create',
    actorId: 'user-a1',
    success: true,
    reason: null,
    changedFields: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    // Planted so the whitelist is proven at RUNTIME, not merely by the TypeScript type:
    // none of these may appear in a response even if an upstream object carried them.
    ipAddress: '10.0.0.9',
    userAgent: 'leaky-agent',
    sessionId: 'sess-9',
    tenantId: 'tenant-leak',
    oldValue: { secret: 'before' },
    newValue: { secret: 'after' },
    changes: ['secret'],
    ...overrides,
  };
}

function okPage(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    page: { items, page: 1, pageSize: 20, total: items.length, ...overrides },
  };
}

function build(readResult: unknown = okPage([])) {
  // The repository answers with a document BY DEFAULT so each test states only what it
  // is about: the 404 test overrides this with `null`, the rest care about the read.
  const repository = { findDocumentById: jest.fn().mockResolvedValue(storedDocument()) };
  const audit = { read: jest.fn().mockResolvedValue(readResult), record: jest.fn() };
  const service = new PurchaseTimelineService(
    repository as unknown as ConstructorParameters<typeof PurchaseTimelineService>[0],
    audit as unknown as ConstructorParameters<typeof PurchaseTimelineService>[1],
  );
  return { service, repository, audit };
}

describe('PurchaseTimelineService (C7) — scope, projection and failure semantics', () => {
  it('binds the audit query from trusted context: actor tenant, closed resource, routed id', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument('doc-7'));

    await service.getTimeline(actor, 'doc-7', {});

    expect(repository.findDocumentById).toHaveBeenCalledTimes(1);
    expect(repository.findDocumentById).toHaveBeenCalledWith(actor.tenantId, 'doc-7');
    // ONE call, and the scope fields are exactly these three — `page`/`pageSize` were
    // not stated, so they are ABSENT (the platform's defaults answer), never invented.
    expect(audit.read).toHaveBeenCalledTimes(1);
    expect(audit.read).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      resource: 'commerce.purchase_document',
      resourceId: 'doc-7',
    });
  });

  it('forwards page/pageSize exactly as the DTO validated them, and no other filter', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());

    await service.getTimeline(actor, 'doc-1', { page: 3, pageSize: 5 });

    expect(audit.read).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
      page: 3,
      pageSize: 5,
    });
    const query = audit.read.mock.calls[0][0];
    expect(Object.keys(query).sort()).toEqual([
      'page',
      'pageSize',
      'resource',
      'resourceId',
      'tenantId',
    ]);
  });

  it('answers 404 for an id this tenant does not own, and never reaches the audit port', async () => {
    const { service, repository, audit } = build();
    repository.findDocumentById.mockResolvedValue(null);

    await expect(service.getTimeline(actor, 'foreign', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(audit.read).not.toHaveBeenCalled();
  });
  it('returns a successful EMPTY page honestly: items [] with the platform total', async () => {
    const { service } = build(okPage([], { page: 2, pageSize: 10, total: 0 }));

    const answer = await service.getTimeline(actor, 'doc-1', { page: 2, pageSize: 10 });

    expect(answer).toEqual({ items: [], page: 2, pageSize: 10, total: 0 });
  });

  it('maps AUDIT_READ_FAILED to a 503 and NEVER to an empty result', async () => {
    const { service, repository } = build({ status: 'rejected', code: 'AUDIT_READ_FAILED' });
    repository.findDocumentById.mockResolvedValue(storedDocument());

    const failure = await service
      .getTimeline(actor, 'doc-1', {})
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'AUDIT_READ_FAILED',
    });
  });

  it('maps every other closed rejection code to a 422 carrying the platform code', async () => {
    const { service, repository } = build({
      status: 'rejected',
      code: 'AUDIT_READ_PAGE_INVALID',
    });
    repository.findDocumentById.mockResolvedValue(storedDocument());

    const failure = await service
      .getTimeline(actor, 'doc-1', { page: 1 })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(UnprocessableEntityException);
    expect((failure as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'AUDIT_READ_PAGE_INVALID',
    });
  });

  it('projects a WHITELIST: exactly the seven safe fields, whatever the item carries', async () => {
    const { service, repository } = build(okPage([platformItem()]));
    repository.findDocumentById.mockResolvedValue(storedDocument());

    const { items } = await service.getTimeline(actor, 'doc-1', {});

    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      'action',
      'actorId',
      'changedFields',
      'createdAt',
      'id',
      'reason',
      'success',
    ]);
    // The planted sensitive fields are gone — no ip, no agent, no session, no tenant,
    // no snapshot, no changes array, and no echoed scope either.
    expect(items[0]).not.toHaveProperty('ipAddress');
    expect(items[0]).not.toHaveProperty('userAgent');
    expect(items[0]).not.toHaveProperty('sessionId');
    expect(items[0]).not.toHaveProperty('tenantId');
    expect(items[0]).not.toHaveProperty('oldValue');
    expect(items[0]).not.toHaveProperty('newValue');
    expect(items[0]).not.toHaveProperty('changes');
    expect(items[0]).not.toHaveProperty('resource');
    expect(items[0]).not.toHaveProperty('resourceId');
  });

  it('preserves the platform item ORDER, the echoed pagination and the total', async () => {
    const items = [
      platformItem({ id: 'a', createdAt: '2026-10-01T00:00:01.000Z', action: 'create' }),
      platformItem({ id: 'b', createdAt: '2026-10-01T00:00:02.000Z', action: 'update' }),
      platformItem({ id: 'c', createdAt: '2026-10-01T00:00:03.000Z', action: 'submit' }),
    ];
    const { service, repository } = build(okPage(items, { page: 2, pageSize: 3, total: 11 }));
    repository.findDocumentById.mockResolvedValue(storedDocument());

    const answer = await service.getTimeline(actor, 'doc-1', { page: 2, pageSize: 3 });

    expect(answer.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(answer.items.map((item) => item.createdAt)).toEqual([
      '2026-10-01T00:00:01.000Z',
      '2026-10-01T00:00:02.000Z',
      '2026-10-01T00:00:03.000Z',
    ]);
    expect(answer.page).toBe(2);
    expect(answer.pageSize).toBe(3);
    expect(answer.total).toBe(11);
  });
});