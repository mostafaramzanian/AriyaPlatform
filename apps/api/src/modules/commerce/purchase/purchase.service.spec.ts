﻿import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  COMMERCE_PURCHASE_EVENT,
  PURCHASE_AUDIT_ACTION,
  PurchaseService,
  computeDocumentTotals,
} from './purchase.service';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CreatePurchaseDocumentDto,
  ListPurchaseDocumentsQueryDto,
  PurchaseLineInputDto,
  UpdatePurchaseDocumentDto,
} from './purchase.dto';
import type {
  PurchaseDocumentTotals,
  PurchaseLineWrite,
} from './purchase.repository';
import type { PurchaseDocumentStatus } from './purchase-status';
import type { PurchaseRepository } from './purchase.repository';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceActor } from '../commerce-actor';
import type { CommerceIdentityGateway } from '../commerce-identity.gateway';
import type { CommerceNotificationGateway } from '../commerce-notification.gateway';
import type { CommerceSearchSourceService } from '../search/commerce-search-source.service';
import type { CommercialLifecycleService } from '../commercial/commercial-lifecycle.service';
import type { WorkflowLineRoutingService } from '../workflow/workflow-line-routing.service';
import {
  type CommerceTransactionHandle,
  type CommerceTransactionWork,
  type CommerceUnitOfWork,
} from '../database/commerce-transaction';

/**
 * Phase C1 Step L (§5.1, §5.2, §8, §11): the purchase slice's application layer.
 *
 * WHAT IS BEING PINNED, AND WHY AT THIS SEAM
 * ------------------------------------------
 * The repository is faked and the three gateways are recorded spies, so every assertion
 * here is about a DECISION rather than about SQL: which writes happen, in what order,
 * and what is refused before anything is written. The rules that would otherwise be
 * invisible until production are each one test:
 *
 *  * the TENANT comes from the actor and is the repository's first argument, on every
 *    method — there is no shape of these calls that reads another tenant's document;
 *  * a requester id is VERIFIED against the tenant before it is stored, and never on a
 *    read (a read of a document whose requester has left must still render);
 *  * the NUMBER is never taken from a DTO, and `kind` is never taken from a client;
 *  * `lineTotal` is DERIVED, and a document whose lines are not all priced stores NULL
 *    totals rather than a sum that quietly skipped a line;
 *  * the conditional writes' `null` is a 409, not a silent success;
 *  * a `tenantId` never reaches a response body.
 */

/** One line as the repository returns it: strings, because the column is Decimal(18,4). */
function storedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    tenantId: 't1',
    purchaseDocumentId: 'd1',
    lineNumber: 1,
    lineType: 'STANDARD',
    quantity: '2.0000',
    unit: 'kg',
    unitPrice: '12.5000',
    tax: '1.2500',
    lineTotal: '25.0000',
    externalRef: null,
    itemReference: null,
    technicalDescription: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** One document as the repository returns it, including the tenant it must not leak. */
function storedDocument(
  overrides: Partial<
    Omit<PurchaseStoredDocument, 'lines' | 'requester'> & {
      /** The repository-row requester id (the serialized form has `requester`). */
      requesterId?: string;
    }
  > & {
    lines?: PurchaseStoredDocument['lines'];
  } = {}
) {
  const lines = overrides.lines ?? [storedLine()];
  return {
    id: 'd1',
    tenantId: 't1',
    documentNumber: 'PR-1405-00001',
    kind: 'PURCHASE_REQUEST',
    requesterId: 'u1',
    supplierId: null,
    currency: null,
    costCenter: null,
    status: 'DRAFT',
    subtotalAmount: '25.0000',
    taxAmount: '1.2500',
    totalAmount: '26.2500',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
    lines,
  };
}

/**
 * The `storedDocument` record, as resolved through the methods that consume
 * it: every property the harness fabricates above is read back somewhere
 * below.
 */
type PurchaseStoredDocument = Awaited<ReturnType<PurchaseService['create']>>;

/**
 * The service under test with recording fakes for the repository and the three gateways.
 *
 * WHY THE CALL LOG IS THE MOCK'S OWN `.mock.calls` AND NOT A `push` INSIDE THE
 * IMPLEMENTATION. A test that states a RETURN value (`…mockResolvedValue(document)`)
 * REPLACES the implementation — so a `push` written inside it would stop recording at
 * exactly the moment the assertion needs the recording, and the failure would look like
 * "the service never called the repository". Jest records every call on the mock itself,
 * independently of whichever implementation is installed, so reading `mock.calls` keeps
 * the two concerns apart: what the fake RETURNS is the test's to decide, what was CALLED
 * is the mock's to remember.
 *
 * There is no `jest.clearAllMocks()` anywhere in this file on purpose: the mocks are
 * built fresh per test by `build()`, and the `calls` arrays are those same arrays rather
 * than copies, so a shared reset would silently empty a log an assertion still needs.
 */
/**
 * Structural stand-ins for the real dependencies, whose BEHAVIOUR the
 * recorded spies observe: every assertion below is about which dependency was
 * called with what (tenant-first, in what order), never about a return type.
 * The doubles are therefore shaped by the real methods' own parameter lists —
 * `Parameters<...>[n]` on each production class — rather than by `any`.
 */
type RepositoryDouble = {
  [K in
    | 'createDocument'
    | 'findDocumentById'
    | 'listDocumentPage'
    | 'countByStatus'
    | 'findSpendSince'
    | 'findCostCenters'
    | 'updateEditableDocument'
    | 'markDocumentSubmittedIn'
    | 'reopenDocumentIn']: jest.Mock;
};
type IdentityDouble = {
  [K in 'assertMember' | 'profilesFor']: jest.Mock;
};
type AuditDouble = {
  [K in 'record' | 'buildOutboxPayload']: jest.Mock;
};
type NotificationDouble = {
  [K in 'publish' | 'notifyUsers']: jest.Mock;
};
type SearchDouble = {
  [K in 'projectDocument']: jest.Mock;
};
type TransactionDouble = {
  run: jest.Mock<Promise<unknown>, [CommerceTransactionWork<unknown>]>;
};
type LineRoutingDouble = {
  [K in 'routeLinesForDocument']: jest.Mock;
};
type CommercialDouble = {
  [K in 'onPurchaseSubmitted']: jest.Mock;
};

function build() {
  const repository: RepositoryDouble = {
    createDocument: jest.fn(),
    findDocumentById: jest.fn(),
    listDocumentPage: jest.fn(),
    countByStatus: jest.fn(),
    findSpendSince: jest.fn(),
    findCostCenters: jest.fn(),
    updateEditableDocument: jest.fn(),
    markDocumentSubmittedIn: jest.fn(),
    reopenDocumentIn: jest.fn(),
  };

  const identity: IdentityDouble = {
    assertMember: jest.fn(),
    profilesFor: jest.fn(),
  };

  const audit: AuditDouble = {
    record: jest.fn(),
    buildOutboxPayload: jest
      .fn()
      .mockImplementation(
        (
          actor: Parameters<CommerceAuditGateway['buildOutboxPayload']>[0],
          act: Parameters<CommerceAuditGateway['buildOutboxPayload']>[1]
        ) => ({
          // The fake mirrors the real builder's contract: the id/tenant
          // echoed, and `act` carried AS the payload. Only `actor.tenantId`
          // is read, so the double destructures nothing else.
          tenantId: actor.tenantId,
          auditId: 'outbox-audit-id',
          payload: act,
        })
      ),
  };

  const notification: NotificationDouble = {
    publish: jest.fn(),
    // GAP-9: the user-addressed surface. Recorded like every other boundary; its own
    // contract (dedupe, tenant assertion, failure policy) is pinned by
    // commerce-notification.gateway.spec.ts, so here it only has to receive the right ids.
    notifyUsers: jest.fn().mockResolvedValue(undefined),
  };

  const unitOfWork: TransactionDouble = {
    // The harness executes the work inline on a stand-in handle: the
    // brand is a TYPE-level marker, so any object the tests inspect as
    // `CommerceTransactionHandle` crosses the boundary exactly as a real
    // minted handle would — by structural identity, not by construction.
    run: jest.fn((work: CommerceTransactionWork<unknown>) =>
      work({} as CommerceTransactionHandle)
    ),
  };

  const lineRouting: LineRoutingDouble = {
    // GAP-9: the default routing resolves NO approver, which is what a document with no
    // matching routing rule really produces — so every existing submit assertion below is
    // unchanged, and a test that wants a recipient states one.
    routeLinesForDocument: jest.fn().mockResolvedValue({
      createdInstances: [],
      unroutedLineIds: [],
      pendingApproverUserIds: [],
    }),
  };

  // Step P's commercial dispatch: with no published configuration §3-A is a no-op, so
  // the DEFAULT here resolves `null` and a test that cares about the trigger overrides it.
  const commercial: CommercialDouble = {
    onPurchaseSubmitted: jest.fn().mockResolvedValue(null),
  };

  // PHASE C9 (GAP-5): the search projection push. A mock like every other boundary: the
  // service's job is to CALL it with the row it wrote, after the write succeeded — the
  // adapter's own swallow-and-log semantics are pinned by its own spec.
  const search: SearchDouble = {
    projectDocument: jest.fn().mockResolvedValue(undefined),
  };

  // The DEFAULTS, stated once here: a read that finds nothing, a page with no rows, a
  // conditional write that lost the race, a verification that passes and a requester who
  // resolves to a name. A test that needs the other answer overrides the mock it cares
  // about and leaves the rest of the arrangement alone.
  repository.createDocument.mockResolvedValue(storedDocument());
  repository.findDocumentById.mockResolvedValue(null);
  repository.listDocumentPage.mockResolvedValue([[], 0]);
  repository.countByStatus.mockResolvedValue(new Map());
  repository.findSpendSince.mockResolvedValue([]);
  repository.findCostCenters.mockResolvedValue([]);
  repository.updateEditableDocument.mockResolvedValue(null);
  repository.markDocumentSubmittedIn.mockResolvedValue(null);
  repository.reopenDocumentIn.mockResolvedValue(null);
  identity.assertMember.mockResolvedValue(undefined);
  identity.profilesFor.mockResolvedValue(
    new Map([['u1', { id: 'u1', displayName: 'Requester' }]])
  );
  audit.record.mockResolvedValue(undefined);
  notification.publish.mockResolvedValue(undefined);

  /** Every call each dependency received, as the argument list it was called with. */
  const calls = {
    createDocument: repository.createDocument.mock.calls,
    findDocumentById: repository.findDocumentById.mock.calls,
    listDocumentPage: repository.listDocumentPage.mock.calls,
    updateEditableDocument: repository.updateEditableDocument.mock.calls,
    markDocumentSubmittedIn: repository.markDocumentSubmittedIn.mock.calls,
    reopenDocumentIn: repository.reopenDocumentIn.mock.calls,
    assertMember: identity.assertMember.mock.calls,
    profilesFor: identity.profilesFor.mock.calls,
    audit: audit.record.mock.calls,
    auditOutbox: audit.buildOutboxPayload.mock.calls,
    publish: notification.publish.mock.calls,
    notifyUsers: notification.notifyUsers.mock.calls,
    projectDocument: search.projectDocument.mock.calls,
    lineRouting: lineRouting.routeLinesForDocument.mock.calls,
  };

  // Each double is method-shaped; every class carries nominal private state a
  // test double cannot (and should not) carry, so each collaborator crosses
  // this ONE boundary as its class — the recorded mocks remain the source of
  // truth for every assertion below.
  const service = new PurchaseService(
    repository as unknown as PurchaseRepository,
    identity as unknown as CommerceIdentityGateway,
    audit as unknown as CommerceAuditGateway,
    notification as unknown as CommerceNotificationGateway,
    search as unknown as CommerceSearchSourceService,
    unitOfWork as unknown as CommerceUnitOfWork,
    lineRouting as unknown as WorkflowLineRoutingService,
    commercial as unknown as CommercialLifecycleService
  );
  return {
    service,
    repository,
    identity,
    audit,
    notification,
    search,
    unitOfWork,
    lineRouting,
    commercial,
    calls,
  };
}

/**
 * A totals input the tests state by hand — hand-stated, not DTO-validated.
 * `lineTotal` and `tax` arrive as the null-or-string unions the rule reads,
 * and only the fields a totals case actually states.
 */
type TotalsInput = Partial<
  Pick<PurchaseLineWrite, 'lineNumber' | 'lineTotal' | 'tax' | 'lineType'>
>;

const totalsOf = (lines: readonly TotalsInput[]): PurchaseDocumentTotals =>
  computeDocumentTotals(lines as readonly PurchaseLineWrite[]);

const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'r1',
  correlationId: 'c1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

/**
 * A create payload the tests state by hand — hand-stated, not DTO-validated.
 * The DTO's own `PurchaseLineInputDto` is the line shape (optional fields
 * stay optional, so pricing can be unstated); the document shape follows the
 * production `CreatePurchaseDocumentDto`.
 */
type CreateInput = Omit<CreatePurchaseDocumentDto, 'lines'> & {
  lines: Array<Partial<PurchaseLineInputDto> & { lineType: PurchaseLineInputDto['lineType'] }>;
};

const created = (
  service: PurchaseService,
  actor: CommerceActor,
  dto: CreateInput
) => service.create(actor, dto as CreatePurchaseDocumentDto);

/**
 * An update payload the tests state by hand — hand-stated, not DTO-validated.
 * Lines keep the DTO's `PurchaseLineInputDto` shape (optional fields stay
 * optional); scalars follow the production `UpdatePurchaseDocumentDto`.
 */
type UpdateInput = Omit<UpdatePurchaseDocumentDto, 'lines'> & {
  lines?: Array<Partial<PurchaseLineInputDto> & { lineType: PurchaseLineInputDto['lineType'] }>;
};

const updated = (
  service: PurchaseService,
  actor: CommerceActor,
  id: string,
  dto: UpdateInput
) => service.update(actor, id, dto as UpdatePurchaseDocumentDto);

/**
 * A list query the tests state by hand — hand-stated, not DTO-validated.
 * Only the filters a list case actually states.
 */
type ListInput = Partial<ListPurchaseDocumentsQueryDto>;

const listed = (service: PurchaseService, actor: CommerceActor, query: ListInput) =>
  service.list(actor, query as ListPurchaseDocumentsQueryDto);

const ONE_LINE = { lineType: 'STANDARD' as const, quantity: 2, unitPrice: 12.5, tax: 1.25 };

describe('Phase C1 Step L — computeDocumentTotals (the stored-totals rule)', () => {
  it('sums the lines’ own totals and taxes, exactly, and adds the two', () => {
    // The assertion is on the decimal STRINGS the columns will hold: '25.0000', never 25.
    expect(
      totalsOf([
        { lineNumber: 1, lineTotal: '25.0000', tax: '1.2500' },
        { lineNumber: 2, lineTotal: '10.0000', tax: '0.5000' },
      ])
    ).toEqual({ subtotalAmount: '35.0000', taxAmount: '1.7500', totalAmount: '36.7500' });
  });

  it('states NULL for every total when ANY line is unpriced — never a partial sum', () => {
    // A sum that skipped the unpriced line would be a number claiming "these are the
    // totals" while omitting a line somebody asked for (§5.1's "not priced yet").
    expect(
      totalsOf([
        { lineNumber: 1, lineTotal: '25.0000', tax: '1.2500' },
        { lineNumber: 2, lineTotal: null, tax: null },
      ])
    ).toEqual({ subtotalAmount: null, taxAmount: null, totalAmount: null });
  });

  it('treats a HALF-stated line as unpriced, because one number is not a price', () => {
    expect(
      totalsOf([{ lineNumber: 1, lineTotal: '25.0000', tax: null }])
    ).toEqual({ subtotalAmount: null, taxAmount: null, totalAmount: null });
  });

  it('totals an all-free document as 0.0000, which is not the same as unpriced', () => {
    // Zero is a statement the lines make; NULL is the absence of one.
    expect(
      totalsOf([{ lineNumber: 1, lineTotal: '0.0000', tax: '0.0000' }])
    ).toEqual({ subtotalAmount: '0.0000', taxAmount: '0.0000', totalAmount: '0.0000' });
  });

  it('treats zero lines as unpriced rather than free', () => {
    // The DTO refuses an empty array, so this guards an INTERNAL caller that bypassed it.
    expect(computeDocumentTotals([])).toEqual({
      subtotalAmount: null,
      taxAmount: null,
      totalAmount: null,
    });
  });
});

describe('Phase C1 Step L — PurchaseService.create', () => {
  it('verifies the requester against the acting tenant BEFORE storing the id', async () => {
    const { service, calls } = build();

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    // Once an id is in `commerce_db` nothing inside that database can tell whose tenant
    // it came from — the column is opaque and carries no FK across databases.
    expect(calls.assertMember).toEqual([[actor, 'u1']]);
    expect(calls.createDocument.length).toBe(1);
    expect(calls.assertMember.length).toBe(1);
  });

  it('passes the ACTOR’S tenant as the repository’s first argument, and the only kind', async () => {
    const { service, calls } = build();

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });
    const [tenantId, data] = calls.createDocument[0];

    expect(tenantId).toBe('t1');
    // `kind` is the numbering key: it comes from the closed vocabulary, never from a DTO
    // field a client could use to start a second counter series.
    expect(data.kind).toBe('PURCHASE_REQUEST');
    expect(data.requesterId).toBe('u1');
  });

  it('derives lineTotal and the document totals instead of accepting either from a client', async () => {
    const { service, calls } = build();

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });
    const [, data] = calls.createDocument[0];

    expect(data.lines).toEqual([
      {
        lineNumber: 1,
        lineType: 'STANDARD',
        quantity: '2.0000',
        unit: null,
        unitPrice: '12.5000',
        tax: '1.2500',
        lineTotal: '25.0000',
        externalRef: null,
        itemReference: null,
        technicalDescription: null,
      },
    ]);
    expect(data.totals).toEqual({
      subtotalAmount: '25.0000',
      taxAmount: '1.2500',
      totalAmount: '26.2500',
    });
  });

  it('numbers the lines 1…n from array order, so a gap is not expressible', async () => {
    const { service, calls } = build();

    await created(service, actor, {
      requesterId: 'u1',
      lines: [
        { lineType: 'STANDARD', quantity: 1 },
        { lineType: 'SERVICE', quantity: 1 },
        { lineType: 'NON_STANDARD', quantity: 1 },
      ],
    });
    const [, data] = calls.createDocument[0];

    expect(data.lines.map((line: { lineNumber: number }) => line.lineNumber)).toEqual([1, 2, 3]);
  });

  it('stores NULL for an unpriced line and leaves the totals NULL with it', async () => {
    const { service, calls } = build();

    await created(service, actor, {
      requesterId: 'u1',
      lines: [{ lineType: 'STANDARD', quantity: 3 }],
    });
    const [, data] = calls.createDocument[0];

    // NULL unitPrice ⇒ NULL lineTotal ⇒ NULL totals: "not stated yet" all the way up.
    expect(data.lines[0]).toMatchObject({ unitPrice: null, tax: null, lineTotal: null });
    expect(data.totals).toEqual({ subtotalAmount: null, taxAmount: null, totalAmount: null });
  });

  it('records ONE audit row for the created document, taken from the row the write returned', async () => {
    const { service, calls } = build();

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    expect(calls.audit.length).toBe(1);
    const [auditActor, event] = calls.audit[0];
    expect(auditActor).toBe(actor);
    expect(event).toMatchObject({
      action: PURCHASE_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: 'd1',
      // The DATABASE's number, not one the caller sent — that is why the trail is written
      // from the returned row rather than from the intent.
      newValue: { documentNumber: 'PR-1405-00001', status: 'DRAFT', lineCount: 1 },
    });
  });

  it('emits NO event on create: the stream begins when a document enters the workflow', async () => {
    const { service, calls } = build();

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    expect(calls.publish).toEqual([]);
  });

  it('never lets the tenant reach the response body', async () => {
    const { service } = build();

    const createDoc = await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    // A client that received the tenant could put it in its next request — and would
    // still be entitled to nothing, having learned which tenant it was scoped to.
    expect(JSON.stringify(createDoc)).not.toContain('"t1"');
    expect(createDoc).not.toHaveProperty('tenantId');
  });

  it('renders the requester as an id plus a profile, and money as exact decimal strings', async () => {
    const { service } = build();

    const doc = await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    expect(doc.requester).toEqual({
      id: 'u1',
      profile: { id: 'u1', displayName: 'Requester' },
    });
    expect(doc).toMatchObject({
      documentNumber: 'PR-1405-00001',
      status: 'DRAFT',
      editable: true,
      subtotalAmount: '25.0000',
      taxAmount: '1.2500',
      totalAmount: '26.2500',
    });
    expect(doc.lines[0]).toMatchObject({
      lineNumber: 1,
      quantity: '2.0000',
      lineTotal: '25.0000',
    });
  });

  it('propagates a refused requester and writes NOTHING', async () => {
    const { service, identity, calls } = build();
    identity.assertMember.mockRejectedValueOnce(
      new BadRequestException('userId is not a member of this tenant')
    );

    // The gateway's answer is the boundary's to report; translating it here would be a
    // second decision about what "not a member" means.
    await expect(
      created(service, actor, { requesterId: 'stranger', lines: [ONE_LINE] })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.createDocument).toEqual([]);
    expect(calls.audit).toEqual([]);
    // PHASE C9: a create that never wrote must not project — the index would otherwise
    // hold a row the tenant does not.
    expect(calls.projectDocument).toEqual([]);
  });

  it('pushes the search projection ONCE, with the row the repository returned (C9)', async () => {
    const { service, repository, calls } = build();
    const stored = storedDocument();
    repository.createDocument.mockResolvedValue(stored);

    await created(service, actor, { requesterId: 'u1', lines: [ONE_LINE] });

    // AFTER the write, with the WRITTEN row — never with the intent that produced it, and
    // never a second time from any other act (title, timestamp and route are read at
    // query time; only the created number is indexable).
    expect(calls.projectDocument).toHaveLength(1);
    expect(calls.projectDocument[0][0]).toBe(stored);
  });
});

describe('Phase C1 Step L — PurchaseService.getOne', () => {
  it('reads inside the actor’s tenant, and answers 404 when that tenant holds no such id', async () => {
    const { service, calls } = build();

    await expect(service.getOne(actor, 'other-tenant-document')).rejects.toBeInstanceOf(
      NotFoundException
    );

    // NOT 403 FOR ANOTHER TENANT'S ID: the predicate is in the repository's `where`, so an
    // id from elsewhere is indistinguishable from one that does not exist — a 403 would
    // confirm the id names a real document somewhere.
    expect(calls.findDocumentById).toEqual([['t1', 'other-tenant-document']]);
  });

  it('resolves the requester’s profile ONCE and returns the projected document', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

    const found = await service.getOne(actor, 'd1');

    expect(calls.profilesFor).toEqual([[['u1']]]);
    // `editable` comes from the same function the update guard uses, so the flag a client
    // renders cannot disagree with the refusal its next PATCH receives.
    expect(found).toMatchObject({ status: 'SUBMITTED', editable: false });
  });

  it('keeps the requester id when the profile does not resolve', async () => {
    const { service, repository, identity } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    identity.profilesFor.mockResolvedValue(new Map());

    const found = await service.getOne(actor, 'd1');

    // A person who has left, or an id from a directory this module cannot read: the
    // stored FACT is still there and the caller decides how to render its absence.
    expect(found.requester).toEqual({ id: 'u1', profile: null });
  });
});

describe('Phase C1 Step L — PurchaseService.list', () => {
  it('passes the tenant, the stated filters and the resolved window to the repository', async () => {
    const { service, calls } = build();

    await listed(service, actor, {
      status: 'DRAFT',
      requesterId: 'u1',
      search: 'PR-1405',
      page: 3,
      pageSize: 10,
    });

    expect(calls.listDocumentPage).toEqual([
      [
        't1',
        { status: 'DRAFT', requesterId: 'u1', search: 'PR-1405' },
        { page: 3, pageSize: 10, skip: 20, take: 10 },
      ],
    ]);
  });

  it('clamps an oversized pageSize even when validation was bypassed', async () => {
    const { service, calls } = build();

    await listed(service, actor, { pageSize: 100000 });
    const [, , window] = calls.listDocumentPage[0];

    // The DTO bound is the CONTRACT (a 400); this is the GUARANTEE for an internal caller
    // that built its own query object.
    expect(window.take).toBe(100);
  });

  it('resolves identity in ONE batch for the page, never per row', async () => {
    const { service, repository, calls } = build();
    repository.listDocumentPage.mockResolvedValue([
      [
        storedDocument({ id: 'd1', requesterId: 'u1' }),
        storedDocument({ id: 'd2', requesterId: 'u2' }),
        storedDocument({ id: 'd3', requesterId: 'u1' }),
      ],
      3,
    ]);

    const page = await listed(service, actor, {});

    // Deduplication is the gateway's, so the service states the ids ONCE — three rows must
    // not become three round trips into another module's database.
    expect(calls.profilesFor).toEqual([[['u1', 'u2', 'u1']]]);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(page.items.map((item) => item.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('echoes the window it actually used, so a caller that sent nothing learns what it got', async () => {
    const { service } = build();

    const page = await listed(service, actor, {});

    expect(page).toMatchObject({ page: 1, pageSize: 20 });
    expect(page).not.toHaveProperty('skip');
    expect(page).not.toHaveProperty('take');
  });
});

describe('Phase C1 Step L — PurchaseService.update', () => {
  it('refuses a document that is not editable, naming the status and writing NOTHING', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

    await expect(updated(service, actor, 'd1', { supplierId: 's1' })).rejects.toBeInstanceOf(
      ConflictException
    );

    // The message is the point: "SUBMITTED" is what a caller can act on, where a bare
    // "conflict" would leave them guessing which of six statuses they are in.
    await expect(updated(service, actor, 'd1', {})).rejects.toThrow(/SUBMITTED/);
    expect(calls.updateEditableDocument).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('answers 404 for an id this tenant does not hold, before deciding anything else', async () => {
    const { service, calls } = build();

    await expect(updated(service, actor, 'elsewhere', {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(calls.findDocumentById).toEqual([['t1', 'elsewhere']]);
  });

  it('verifies a MOVED requester against the tenant, and only when the edit moves it', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.updateEditableDocument.mockResolvedValue(storedDocument({ supplierId: 's1' }));

    await updated(service, actor, 'd1', { supplierId: 's1' });
    expect(calls.assertMember).toEqual([]);

    await updated(service, actor, 'd1', { requesterId: 'u2' });
    expect(calls.assertMember).toEqual([[actor, 'u2']]);
  });

  it('sends ONLY the fields the caller stated, so two editors cannot overwrite each other', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.updateEditableDocument.mockResolvedValue(storedDocument());

    await updated(service, actor, 'd1', { supplierId: 's1' });

    // `undefined` means "not stated": the key is ABSENT from the scalars, which is what
    // tells the repository to leave the column alone rather than write a default over it.
    const [, , edit] = calls.updateEditableDocument[0];
    expect(edit.scalars).toEqual({ supplierId: 's1' });
    expect(edit.totals).toBeUndefined();
    expect(edit.lines).toBeUndefined();
    expect(Object.keys(edit)).toEqual(['scalars']);
  });

  it('sends null through as a CLEAR, which is a different instruction from an absent key', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument({ supplierId: 's1' }));
    repository.updateEditableDocument.mockResolvedValue(storedDocument({ supplierId: null }));

    await updated(service, actor, 'd1', { supplierId: null });

    const [, , edit] = calls.updateEditableDocument[0];
    expect(edit.scalars).toEqual({ supplierId: null });
  });
});

describe('Phase C1 Step L — PurchaseService.update, the parts that follow a successful write', () => {
  it('derives the totals from the RESTATED lines, so a stored total cannot describe old content', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.updateEditableDocument.mockResolvedValue(storedDocument());

    await updated(service, actor, 'd1', {
      lines: [{ lineType: 'STANDARD', quantity: 1, unitPrice: 3.5, tax: 0.25 }],
    });

    const [, , edit] = calls.updateEditableDocument[0];
    expect(edit.lines).toEqual([
      {
        lineNumber: 1,
        lineType: 'STANDARD',
        quantity: '1.0000',
        unit: null,
        unitPrice: '3.5000',
        tax: '0.2500',
        lineTotal: '3.5000',
        externalRef: null,
        itemReference: null,
        technicalDescription: null,
      },
    ]);
    expect(edit.totals).toEqual({
      subtotalAmount: '3.5000',
      taxAmount: '0.2500',
      totalAmount: '3.7500',
    });
  });

  it('reports the conflict the CONDITIONAL write refused, instead of a success it did not cause', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    // The document moved to SUBMITTED between the read and the write. `null` is the
    // repository's answer to "the predicate no longer held".
    repository.updateEditableDocument.mockResolvedValue(null);

    await expect(updated(service, actor, 'd1', { supplierId: 's1' })).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(calls.audit).toEqual([]);
  });

  it('audits `changedFields` as what the caller STATED, not as a row diff', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.updateEditableDocument.mockResolvedValue(storedDocument({ supplierId: 's1' }));

    await updated(service, actor, 'd1', { supplierId: 's1', currency: 'IRR' });
    const [, event] = calls.audit[0];

    // A diff of the row would list columns the edit never mentioned, and an operator
    // reading the trail could not then tell intent from accident.
    expect(event).toMatchObject({
      action: PURCHASE_AUDIT_ACTION.UPDATE,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: 'd1',
      changedFields: ['supplierId', 'currency'],
    });
  });

  it('emits NO event on an edit: the stream records acts, not corrections', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.updateEditableDocument.mockResolvedValue(storedDocument());

    await updated(service, actor, 'd1', { supplierId: 's1' });

    expect(calls.publish).toEqual([]);
  });
});

describe('Phase C1 Step L — PurchaseService.submit', () => {
  it('asks the transition table, and refuses every status it does not permit', async () => {
    for (const status of ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED']) {
      const { service, repository, calls } = build();
      repository.findDocumentById.mockResolvedValue(
        storedDocument({ status: status as PurchaseDocumentStatus })
      );

      await expect(service.submit(actor, 'd1')).rejects.toBeInstanceOf(ConflictException);
      expect({ status, writes: calls.markDocumentSubmittedIn.length }).toEqual({
        status,
        writes: 0,
      });
    }
  });

  it('answers 404 for an id this tenant does not hold', async () => {
    const { service, calls } = build();

    await expect(service.submit(actor, 'elsewhere')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.markDocumentSubmittedIn).toEqual([]);
  });

  it('submits a DRAFT through the tenant-scoped conditional write', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());
    repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

    const submitted = await service.submit(actor, 'd1');

    // Phase B2.3 + W3: 4th arg is the acting user (status-event provenance),
    // 5th is the outbox payload.
    expect(calls.markDocumentSubmittedIn).toEqual([
      ['t1', expect.anything(), 'd1', 'u1', expect.objectContaining({ tenantId: 't1' })],
    ]);
    // `editable` flips with the status through the same function the update guard uses,
    // so the document a client renders is the document its next PATCH will be refused on.
    expect(submitted).toMatchObject({ status: 'SUBMITTED', editable: false });
  });

  it('answers 409 when a concurrent submit won the race, rather than claiming the act', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument());

    // `null` = the conditional update matched no DRAFT. Whoever lost the race must not be
    // told they routed the document, because step N hangs off that fact.
    repository.markDocumentSubmittedIn.mockResolvedValue(null);

    await expect(service.submit(actor, 'd1')).rejects.toBeInstanceOf(ConflictException);
    expect(calls.audit).toEqual([]);
    expect(calls.publish).toEqual([]);
  });

  describe('Phase C1 Step L — PurchaseService.submit, the two streams', () => {
    it('writes the audit row with BOTH sides of the transition, from the returned row', async () => {
      const { service, repository, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

      await service.submit(actor, 'd1');
      // Phase B2.3: submit uses durable outbox, not best-effort record.
      expect(calls.audit).toEqual([]);
      const [auditActor, event] = calls.auditOutbox[0];

      expect(auditActor).toBe(actor);
      expect(event).toMatchObject({
        action: PURCHASE_AUDIT_ACTION.SUBMIT,
        resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
        resourceId: 'd1',
        oldValue: { status: 'DRAFT' },
        newValue: { status: 'SUBMITTED' },
      });
    });

    it('emits ONE workflow-entry event carrying no tenant and no approver', async () => {
      const { service, repository, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

      await service.submit(actor, 'd1');
      const [publishActor, eventName, payload] = calls.publish[0];

      expect(calls.auditOutbox.length).toBe(1);
      expect(publishActor).toBe(actor);
      expect(eventName).toBe(COMMERCE_PURCHASE_EVENT.SUBMITTED);
      // The literal is pinned as well: the name is `commerce.` + aggregate + act, spelled
      // like the audit resource, so one search spans both streams.
      expect(eventName).toBe('commerce.purchase_document.submitted');
      expect(payload).toEqual({
        documentId: 'd1',
        documentNumber: 'PR-1405-00001',
        requesterId: 'u1',
        status: 'SUBMITTED',
        lineCount: 1,
      });
    });

    it('still answers the submit when a best-effort stream fails, because the document WAS submitted', async () => {
      const { service, repository, notification } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));
      notification.publish.mockRejectedValueOnce(new Error('broker unavailable'));

      // The platform's publisher owns its own failure policy; this pins that the service
      // does not ADD a decision of its own around a write that already committed.
      await expect(service.submit(actor, 'd1')).rejects.toThrow('broker unavailable');
      expect(repository.markDocumentSubmittedIn).toHaveBeenCalledTimes(1);
    });

    it('routes NOTHING yet: step L owns the commercial lifecycle, step N owns the workflow', async () => {
      const { service, repository, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));

      await service.submit(actor, 'd1');

      // No instance, no approver, no identity check: the only writes are the status and the
      // two stream records. An `approverId` here would be step N's decision made by step L.
      expect(calls.markDocumentSubmittedIn.length).toBe(1);
      expect(calls.assertMember).toEqual([]);
      expect(calls.publish[0][2]).not.toHaveProperty('approverId');
    });
  });

  /**
   * GAP-9: the submit's USER-ADDRESSED notification.
   *
   * THE RECIPIENT IS THE TRANSITION'S, NOT THE REQUEST'S. A submit puts decision owners in
   * PENDING — line routing's new steps (`resolvedApproverId`) and the commercial activation's
   * new approvals (`approverUserId`) — and ONLY those ids may be notified. The acting user,
   * the document's requester and any permission- or role-derived audience are deliberately
   * absent: none of them is the owner of a pending decision.
   */
  describe('GAP-9 — the submit notifies the decision owners it activates', () => {
    const pending = (overrides: Record<string, unknown> = {}) => ({
      createdInstances: [],
      unroutedLineIds: [],
      pendingApproverUserIds: [],
      ...overrides,
    });

    it('notifies the union of the workflow and commercial decision owners', async () => {
      const { service, repository, lineRouting, commercial, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));
      lineRouting.routeLinesForDocument.mockResolvedValue(
        pending({ pendingApproverUserIds: ['approver-1', 'approver-2'] })
      );
      commercial.onPurchaseSubmitted.mockResolvedValue({
        activatedApprovalUserIds: ['commercial-approver'],
      });

      await service.submit(actor, 'd1');

      expect(calls.notifyUsers).toHaveLength(1);
      const [notifyActor, recipients, content] = calls.notifyUsers[0];
      expect(notifyActor).toBe(actor);
      expect(recipients).toEqual(['approver-1', 'approver-2', 'commercial-approver']);
      expect(content).toEqual({
        type: 'INFORMATION',
        title: 'سند PR-1405-00001 منتظر تأیید شماست',
        body: 'سند خرید شماره PR-1405-00001 اکنون منتظر تصمیم شماست.',
        sourceType: 'purchase-document',
        sourceId: 'd1',
      });
      // The document's OWN requester is not an audience of its own submission, and the
      // acting user is not a recipient merely because they acted.
      expect(recipients).not.toContain('u1');
      expect(recipients).not.toContain(actor.userId);
    });

    it('notifies nobody when the submit activates no decision', async () => {
      const { service, repository, lineRouting, commercial, notification, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));
      lineRouting.routeLinesForDocument.mockResolvedValue(pending());
      // No published configuration = §3-A's no-op (the mock's default already answers null).
      commercial.onPurchaseSubmitted.mockResolvedValue(null);

      await service.submit(actor, 'd1');

      // One call with an EMPTY list, which the gateway turns into no Core call at all — a
      // submit with nobody to tell must never invent a recipient (GAP-9 §2).
      expect(calls.notifyUsers).toEqual([[actor, [], expect.anything()]]);
      expect(notification.notifyUsers).toHaveBeenCalledTimes(1);
    });

    it('creates no notification when the submit lost the race', async () => {
      const { service, repository, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument({ status: 'DRAFT' }));
      repository.markDocumentSubmittedIn.mockResolvedValue(null);

      await expect(service.submit(actor, 'd1')).rejects.toBeInstanceOf(ConflictException);
      expect(calls.notifyUsers).toEqual([]);
    });

    it('creates no notification when the dispatch rolls the submit back', async () => {
      const { service, repository, lineRouting, commercial, calls } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument());
      repository.markDocumentSubmittedIn.mockResolvedValue(storedDocument({ status: 'SUBMITTED' }));
      lineRouting.routeLinesForDocument.mockResolvedValue(
        pending({ pendingApproverUserIds: ['approver-1'] })
      );
      // §3-K: a refused assignment rolls the whole submit back with it — and a notification
      // for a transition that did not commit would be a lie about the domain.
      commercial.onPurchaseSubmitted.mockRejectedValue(
        new ConflictException('COMMERCIAL_NO_ROUTE')
      );

      await expect(service.submit(actor, 'd1')).rejects.toBeInstanceOf(ConflictException);
      expect(calls.notifyUsers).toEqual([]);
      expect(calls.publish).toEqual([]);
    });
  });
});

describe('PurchaseService.summary — the home surface aggregate read', () => {
  it('scopes the spend window to the acting tenant and zero-fills an empty register', async () => {
    const { service, repository } = build();

    const summary = await service.summary(actor);

    // Tenant-first, like every other read in this repository.
    expect(repository.findSpendSince.mock.calls[0][0]).toBe('t1');
    expect(repository.countByStatus.mock.calls[0][0]).toBe('t1');
    expect(summary).toMatchObject({
      total: 0,
      submitted: 0,
      monthTotal: '0',
      previousMonthTotal: '0',
    });
    // The sparkline contract: exactly 30 daily buckets, ending today.
    expect(summary.daily).toHaveLength(30);
  });

  it('sums only live documents inside the Jalali-month windows', async () => {
    const { service, repository } = build();
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 86_400_000); // far before any window

    repository.countByStatus.mockResolvedValue(
      new Map([
        ['DRAFT', 2],
        ['SUBMITTED', 1],
      ] as Array<[string, number]>)
    );
    repository.findSpendSince.mockResolvedValue([
      // This month, live — counted.
      { createdAt: now, totalAmount: '100.0000', status: 'APPROVED' },
      // This month, CANCELLED — never spends.
      { createdAt: now, totalAmount: '999.0000', status: 'CANCELLED' },
      // This month, unpriced — contributes nothing.
      { createdAt: now, totalAmount: null, status: 'DRAFT' },
      // Before every window — only reachable if the since bound were ignored.
      { createdAt: old, totalAmount: '50.0000', status: 'APPROVED' },
    ]);

    const summary = await service.summary(actor);

    expect(summary.total).toBe(3);
    expect(summary.submitted).toBe(1);
    expect(summary.monthTotal).toBe('100.0000');
    expect(summary.previousMonthTotal).toBe('0');
    // Today's bucket carries the live amount; no other day does.
    expect(summary.daily.at(-1)).toBe(100);
    expect(summary.daily.slice(0, -1).every((v) => v === 0)).toBe(true);
  });

  it('reports per-status counts, the in-circulation total and distinct cost centers', async () => {
    const { service, repository } = build();
    repository.countByStatus.mockResolvedValue(
      new Map([
        ['DRAFT', 26],
        ['SUBMITTED', 14],
        ['APPROVED', 7],
        ['REJECTED', 1],
      ] as Array<[string, number]>)
    );
    repository.findCostCenters.mockResolvedValue(['انبار مرکزی', 'دفتر مرکزی تهران']);
    repository.findSpendSince.mockResolvedValue([
      { createdAt: new Date(), totalAmount: '30.0000', status: 'APPROVED' },
      { createdAt: new Date(), totalAmount: '20.0000', status: 'SUBMITTED' },
      // Cancelled never spends — in-circulation excludes it exactly like the months.
      { createdAt: new Date(), totalAmount: '999.0000', status: 'CANCELLED' },
      { createdAt: new Date(), totalAmount: null, status: 'DRAFT' },
    ]);

    const summary = await service.summary(actor);

    expect(summary.statusCounts).toEqual({ DRAFT: 26, SUBMITTED: 14, APPROVED: 7, REJECTED: 1 });
    expect(summary.inCirculationTotal).toBe('50.0000');
    expect(summary.costCenters).toEqual(['انبار مرکزی', 'دفتر مرکزی تهران']);
  });

  it('projects costCenter through the wire serialization', async () => {
    const { service, repository } = build();
    repository.findDocumentById.mockResolvedValue(
      storedDocument({ costCenter: 'دفتر مرکزی تهران' })
    );

    const document = await service.getOne(actor, 'd1');

    expect(document.costCenter).toBe('دفتر مرکزی تهران');
  });

  it('passes a stated costCenter into the create write', async () => {
    const { service, repository } = build();

    await service.create(actor, {
      requesterId: 'u1',
      costCenter: 'معاونت فناوری',
      lines: [{ lineType: 'STANDARD', quantity: 1, unit: 'kg' }],
    } as Parameters<typeof service.create>[1]);

    expect(repository.createDocument.mock.calls[0][1].costCenter).toBe('معاونت فناوری');
  });
});

describe('REACTIVATION (GAP-6 follow-up) — PurchaseService.reopen', () => {
  it('404s an unknown document and never reaches the repository write', async () => {
    const { service, repository } = build();
    repository.findDocumentById.mockResolvedValue(null);

    await expect(service.reopen(actor, 'missing')).rejects.toThrow(NotFoundException);
    expect(repository.reopenDocumentIn).not.toHaveBeenCalled();
  });

  it('refuses any status but REJECTED with the status named, writing nothing', async () => {
    for (const status of ['DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED', 'CLOSED'] as const) {
      const { service, repository, unitOfWork } = build();
      repository.findDocumentById.mockResolvedValue(storedDocument({ status }));

      await expect(service.reopen(actor, 'd1')).rejects.toThrow(ConflictException);
      expect(repository.reopenDocumentIn).not.toHaveBeenCalled();
      expect(unitOfWork.run).not.toHaveBeenCalled();
    }
  });

  it('moves REJECTED → DRAFT once, through the conditional write, with the reopen audit row', async () => {
    const { service, repository, calls } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument({ status: 'REJECTED' }));
    repository.reopenDocumentIn.mockResolvedValue(storedDocument({ status: 'DRAFT' }));

    const result = await service.reopen(actor, 'd1');

    // The outbox row records the act before the unit of work, with BOTH statuses.
    expect(calls.auditOutbox).toEqual([
      [
        actor,
        expect.objectContaining({
          action: PURCHASE_AUDIT_ACTION.REOPEN,
          resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
          resourceId: 'd1',
          oldValue: { status: 'REJECTED' },
          newValue: { status: 'DRAFT' },
        }),
      ],
    ]);
    // Tenant-first, inside the unit of work, carrying the outbox — one act.
    expect(calls.reopenDocumentIn[0][0]).toBe('t1');
    expect(calls.reopenDocumentIn[0][1]).toEqual({});
    expect(calls.reopenDocumentIn[0][3]).toBe('u1');
    expect(calls.reopenDocumentIn[0][4]).toEqual(
      expect.objectContaining({ auditId: 'outbox-audit-id' })
    );
    // The answer is the document as every other route projects it — no tenant on the wire.
    expect(result).toMatchObject({ id: 'd1', status: 'DRAFT', documentNumber: 'PR-1405-00001' });
    expect(result).not.toHaveProperty('tenantId');
  });

  it('answers 409 when the conditional write matches nothing — a lost reopen race is never success', async () => {
    const { service, repository } = build();
    repository.findDocumentById.mockResolvedValue(storedDocument({ status: 'REJECTED' }));
    repository.reopenDocumentIn.mockResolvedValue(null);

    await expect(service.reopen(actor, 'd1')).rejects.toThrow(ConflictException);
  });
});

