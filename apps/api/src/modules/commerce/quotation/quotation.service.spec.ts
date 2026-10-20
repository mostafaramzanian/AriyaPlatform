import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import type { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceUnitOfWork } from '../database/commerce-transaction';
import { QUOTATION_AUDIT_ACTION, COMMERCE_MAX_ATTACHMENT_BYTES, QUOTATION_FAILURE } from './quotation.constants';
import { QuotationVersionConflictError } from './quotation.repository';
import { QuotationService } from './quotation.service';

/**
 * PHASE GAP-6: the quotation service at the seam where it decides — recording
 * fakes for the repositories, a spy for the audit gateway. Pinned: the named
 * refusals, tenant-first arguments, server-derived actor/version, exact money,
 * and the outbox travelling inside the unit of work.
 */
const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'u-actor',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

const documentFacts = (status = 'SUBMITTED') => ({
  id: 'd1',
  status,
  documentNumber: 'PR-1405-00001',
  requesterId: 'u-requester',
});

function storedQuotation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    tenantId: 't1',
    purchaseDocumentId: 'd1',
    version: 1,
    // NOT the acting user: separation of duties refuses the recorder deciding
    // their own quotation, so the default fixture must be somebody else.
    createdByUserId: 'u-recorder',
    quoteReference: 'PF-1',
    quoteDate: new Date('2026-10-01'),
    currency: 'IRR',
    totalAmount: '1200.0000',
    attachmentRef: null,
    notes: null,
    status: 'PENDING',
    decidedByUserId: null,
    decidedAt: null,
    decisionComment: null,
    createdAt: new Date('2026-10-02'),
    updatedAt: new Date('2026-10-02'),
    lines: [],
    purchaseDocument: documentFacts(),
    ...overrides,
  };
}

type QuotationRepositoryLike = ConstructorParameters<typeof QuotationService>[0];

function build() {
  const repository = {
    findDocument: jest.fn(),
    findPendingByDocument: jest.fn(),
    listByDocument: jest.fn(),
    findQuotationById: jest.fn(),
    createQuotation: jest.fn(),
    decideQuotationIn: jest.fn(),
    attachAttachmentRefIn: jest.fn(),
  };
  const audit = {
    buildOutboxPayload: jest.fn().mockImplementation((_actor: CommerceActor, act: unknown) => ({
      tenantId: 't1',
      auditId: 'outbox-audit-id',
      payload: act,
    })),
  };
  const notification = {
    notifyUsers: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const unitOfWork = {
    run: jest.fn(async (fn: (tx: unknown) => unknown) => fn('tx-handle')),
  };
  // GAP-6 follow-up 3.3: the storage double — every call captured, uploads succeed
  // unless a test overrides them.
  const storage = {
    upload: jest.fn().mockResolvedValue('key'),
    getUrl: jest.fn().mockResolvedValue('signed://commerce/t1/price-quotations/q1/scan.png'),
    delete: jest.fn().mockResolvedValue(true),
  };
  // SUPPLIER MASTER DATA: the optional `supplierId` existence check's double.
  // Existing tests state no `supplierId`, so the default answer never fires;
  // the new supplier-validation test overrides it.
  const suppliers = {
    findSupplierById: jest.fn(),
  };
  const service = new QuotationService(
    repository as unknown as QuotationRepositoryLike,
    audit as unknown as CommerceAuditGateway,
    unitOfWork as unknown as CommerceUnitOfWork,
    notification as unknown as CommerceNotificationGateway,
    storage,
    suppliers as never
  );
  return { service, repository, audit, notification, unitOfWork, storage, suppliers };
}

const expectConflict = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ response: expect.objectContaining({ code }) });

describe('GAP-6 list — the document-scoped trail read', () => {
  it('404s an unknown or foreign document before touching the quotation table', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(null);

    await expect(service.list(actor, 'missing')).rejects.toThrow(NotFoundException);
    expect(repository.findDocument).toHaveBeenCalledWith('t1', 'missing');
    expect(repository.listByDocument).not.toHaveBeenCalled();
  });

  it('returns the document facts and every version, projecting money as exact strings', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(documentFacts('APPROVED'));
    repository.listByDocument.mockResolvedValue([
      storedQuotation({
        totalAmount: '5.0000',
        lines: [
          { id: 'l1', lineNumber: 1, description: 'x', quantity: '2.0000', unitPrice: '2.5000', lineTotal: '5.0000' },
        ],
      }),
    ]);

    const result = await service.list(actor, 'd1');

    expect(repository.listByDocument).toHaveBeenCalledWith('t1', 'd1');
    expect(result.document).toEqual({ id: 'd1', status: 'APPROVED' });
    expect(result.items[0].totalAmount).toBe('5.0000');
    // No CONFIRMED quotation in this trail → nothing to route on, honestly null.
    expect(result.paymentRouting).toEqual({
      basis: 'confirmedQuotationTotal',
      cashMaxAmount: '30000000.0000',
      classification: null,
      sourceQuotationId: null,
    });
    expect(result.items[0].lines[0]).toEqual({
      id: 'l1',
      lineNumber: 1,
      description: 'x',
      quantity: '2.0000',
      unitPrice: '2.5000',
      lineTotal: '5.0000',
    });
  });
});

describe('GAP-6 create — guards first, then one atomic versioned insert', () => {
  it('404s an unknown document', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(null);

    await expect(service.create(actor, { purchaseDocumentId: 'missing' })).rejects.toThrow(
      NotFoundException
    );
  });

  it('refuses CLOSED and CANCELLED documents with the named 409, writing nothing', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const { service, repository, unitOfWork } = build();
      repository.findDocument.mockResolvedValue(documentFacts(status));

      await expectConflict(
        service.create(actor, { purchaseDocumentId: 'd1' }),
        QUOTATION_FAILURE.DOCUMENT_NOT_OPEN
      );
      expect(unitOfWork.run).not.toHaveBeenCalled();
    }
  });

  it('refuses a second live price: a PENDING quotation already exists', async () => {
    const { service, repository, unitOfWork } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue({ id: 'q0', version: 1 });

    await expectConflict(
      service.create(actor, { purchaseDocumentId: 'd1' }),
      QUOTATION_FAILURE.PENDING_EXISTS
    );
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('refuses stating BOTH itemised lines and a stated total — 400, not a silent pick', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);

    await expect(
      service.create(actor, {
        purchaseDocumentId: 'd1',
        totalAmount: 100,
        lines: [{ description: 'x', quantity: 1, unitPrice: 1 }],
      })
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a machine context outright: price evidence records a person', async () => {
    const { service } = build();
    await expect(
      service.create({ ...actor, userId: null }, { purchaseDocumentId: 'd1' })
    ).rejects.toThrow(ForbiddenException);
  });

  it('itemised mode: derives every line total and the total, and builds the outbox by created id', async () => {
    const { service, repository, audit, unitOfWork } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    repository.createQuotation.mockImplementation(
      async (_tenantId: string, _data: unknown, _lines: unknown, buildOutbox: (id: string) => unknown) => {
        // The builder is what lets the audit name the row it addressed.
        buildOutbox('q-new');
        return storedQuotation({ id: 'q-new' });
      }
    );

    const result = await service.create(actor, {
      purchaseDocumentId: 'd1',
      supplierLabel: 'فروشنده',
      currency: 'IRR',
      lines: [
        { description: 'سنسور', quantity: 3, unitPrice: 0.1 },
        { description: 'برش پلیت', quantity: 1, unitPrice: 100 },
      ],
    });

    const [tenantId, data, lines] = repository.createQuotation.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(data.purchaseDocumentId).toBe('d1');
    expect(data.createdByUserId).toBe('u-actor');
    expect(lines).toEqual([
      { lineNumber: 1, description: 'سنسور', quantity: '3.0000', unitPrice: '0.1000', lineTotal: '0.3000' },
      { lineNumber: 2, description: 'برش پلیت', quantity: '1.0000', unitPrice: '100.0000', lineTotal: '100.0000' },
    ]);
    // The stored total is the DERIVED sum, never the client's arithmetic.
    expect(String(repository.createQuotation.mock.calls[0][1].totalAmount)).toBe('100.3000');
    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(audit.buildOutboxPayload).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: QUOTATION_AUDIT_ACTION.CREATED,
        resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
        resourceId: 'q-new',
      })
    );
    expect(result.id).toBe('q-new');
    expect(result.status).toBe('PENDING');
  });

  it('scan-only mode: stores the stated total, and no-total stores NULL — never zero', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    repository.createQuotation.mockResolvedValue(storedQuotation({ totalAmount: '8000000.0000' }));

    await service.create(actor, { purchaseDocumentId: 'd1', totalAmount: 8_000_000 });
    expect(String(repository.createQuotation.mock.calls[0][1].totalAmount)).toBe('8000000.0000');

    await service.create(actor, { purchaseDocumentId: 'd1' });
    expect(repository.createQuotation.mock.calls[1][1].totalAmount).toBeNull();
  });

  it('translates the repository version collision into the named 409', async () => {
    const { service, repository } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    repository.createQuotation.mockRejectedValue(new QuotationVersionConflictError());

    await expectConflict(
      service.create(actor, { purchaseDocumentId: 'd1' }),
      QUOTATION_FAILURE.VERSION_CONFLICT
    );
  });

  it('passes the unit-of-work handle through to the repository — one transaction', async () => {
    const { service, repository, unitOfWork } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    repository.createQuotation.mockResolvedValue(storedQuotation());

    await service.create(actor, { purchaseDocumentId: 'd1' });
    expect(repository.createQuotation.mock.calls[0][4]).toBe('tx-handle');
    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
  });
});

describe('GAP-6 decide — one conditional PENDING move, one 409 on a race', () => {
  // ITEMISED by default: a scan-only quotation (no lines, no attachment) may not be
  // CONFIRMed — the scan-attachment rule — so the decide fixtures carry the evidence
  // their assertions assume. Scan-only cases are built explicitly with `lines: []`.
  const ITEMISED_LINE = {
    id: 'l1',
    lineNumber: 1,
    description: 'x',
    quantity: '1.0000',
    unitPrice: '10.0000',
    lineTotal: '10.0000',
  };
  const pendingQuotation = (overrides: Record<string, unknown> = {}) =>
    storedQuotation({ purchaseDocument: documentFacts(), lines: [ITEMISED_LINE], ...overrides });

  it('404s an unknown or foreign quotation', async () => {
    const { service, repository } = build();
    repository.findQuotationById.mockResolvedValue(null);

    await expect(service.decide(actor, 'missing', { decision: 'CONFIRM' })).rejects.toThrow(
      NotFoundException
    );
  });

  it('refuses a decision once the document left circulation', async () => {
    const { service, repository } = build();
    repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ purchaseDocument: documentFacts('CLOSED') })
    );

    await expectConflict(
      service.decide(actor, 'q1', { decision: 'CONFIRM' }),
      QUOTATION_FAILURE.DOCUMENT_NOT_OPEN
    );
  });

  it('refuses a second decision on an already-decided quotation', async () => {
    const { service, repository } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation({ status: 'CONFIRMED' }));

    await expectConflict(
      service.decide(actor, 'q1', { decision: 'CONFIRM' }),
      QUOTATION_FAILURE.ALREADY_DECIDED
    );
  });

  it('requires the reason for a RETURNED decision — 400, nothing written', async () => {
    const { service, repository, unitOfWork } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());

    await expectConflict(
      service.decide(actor, 'q1', { decision: 'RETURN' }),
      QUOTATION_FAILURE.RETURN_REASON_REQUIRED
    );
    await expectConflict(
      service.decide(actor, 'q1', { decision: 'RETURN', comment: '   ' }),
      QUOTATION_FAILURE.RETURN_REASON_REQUIRED
    );
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('CONFIRMs without a comment, recording the server actor, instant and audit row', async () => {
    const { service, repository, audit } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ status: 'CONFIRMED', decidedByUserId: 'u-actor' })
    );

    const result = await service.decide(actor, 'q1', { decision: 'CONFIRM' });

    const [tenantId, id, decision, outbox, tx] = repository.decideQuotationIn.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(id).toBe('q1');
    expect(decision.status).toBe('CONFIRMED');
    expect(decision.decidedByUserId).toBe('u-actor');
    expect(decision.decidedAt).toBeInstanceOf(Date);
    expect(decision.decisionComment).toBeNull();
    expect(outbox).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          action: QUOTATION_AUDIT_ACTION.DECIDED,
          resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
          resourceId: 'q1',
          oldValue: { status: 'PENDING' },
          newValue: expect.objectContaining({ status: 'CONFIRMED' }),
        }),
      })
    );
    expect(tx).toBe('tx-handle');
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('CONFIRMED');
  });

  it('RETURNs with the trimmed reason, and a racing loser is the named 409', async () => {
    const { service, repository } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ status: 'RETURNED', decisionComment: 'مدل سنسور اشتباه است' })
    );

    await service.decide(actor, 'q1', { decision: 'RETURN', comment: ' مدل سنسور اشتباه است ' });
    expect(repository.decideQuotationIn.mock.calls[0][2]).toMatchObject({
      status: 'RETURNED',
      decisionComment: 'مدل سنسور اشتباه است',
    });

    // The conditional write matched nothing: someone else decided it first.
    const racing = build();
    racing.repository.findQuotationById.mockResolvedValue(pendingQuotation());
    racing.repository.decideQuotationIn.mockResolvedValue(null);

    await expectConflict(
      racing.service.decide(actor, 'q1', { decision: 'CONFIRM' }),
      QUOTATION_FAILURE.WRITE_CONFLICT
    );
  });

  it('refuses a machine context before reading anything', async () => {
    const { service, repository } = build();
    await expect(
      service.decide({ ...actor, userId: null }, 'q1', { decision: 'CONFIRM' })
    ).rejects.toThrow(ForbiddenException);
    expect(repository.findQuotationById).not.toHaveBeenCalled();
  });
});

describe('GAP-6 follow-up — separation of duties and notifications', () => {
  // Itemised by default for the same reason the decide suite is: CONFIRM on a
  // scan-only quotation without its scan is the named 409 (see the rule's own test).
  const ITEMISED_LINE = {
    id: 'l1',
    lineNumber: 1,
    description: 'x',
    quantity: '1.0000',
    unitPrice: '10.0000',
    lineTotal: '10.0000',
  };
  const pendingQuotation = (overrides: Record<string, unknown> = {}) =>
    storedQuotation({ purchaseDocument: documentFacts(), lines: [ITEMISED_LINE], ...overrides });

  it('refuses the recorder deciding their own quotation — named 409, nothing written', async () => {
    const { service, repository, unitOfWork } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation({ createdByUserId: 'u-actor' }));

    await expectConflict(
      service.decide(actor, 'q1', { decision: 'CONFIRM' }),
      QUOTATION_FAILURE.SELF_DECISION
    );
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('a different decision-maker proceeds — the rule narrows, never widens, the permission', async () => {
    const { service, repository } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation({ createdByUserId: 'u-recorder' }));
    repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ status: 'CONFIRMED', createdByUserId: 'u-recorder' })
    );

    const result = await service.decide(actor, 'q1', { decision: 'CONFIRM' });
    expect(result.status).toBe('CONFIRMED');
  });

  it('create notifies the document requester, excluding the actor, as price-quotation evidence', async () => {
    const { service, repository, notification } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    repository.createQuotation.mockResolvedValue(
      storedQuotation({ id: 'q-new', createdByUserId: 'u-actor' })
    );

    await service.create(actor, { purchaseDocumentId: 'd1', totalAmount: 100 });

    expect(notification.notifyUsers).toHaveBeenCalledTimes(1);
    const [notifActor, recipients, content] = notification.notifyUsers.mock.calls[0];
    expect(notifActor).toEqual(actor);
    expect(recipients).toEqual(['u-requester']);
    expect(content).toEqual(
      expect.objectContaining({
        type: 'INFORMATION',
        sourceType: 'price-quotation',
        sourceId: 'q-new',
        title: expect.stringContaining('PR-1405-00001'),
      })
    );
  });

  it('CONFIRM notifies the recorder and the requester; RETURN notifies the recorder with the reason', async () => {
    const confirming = build();
    confirming.repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ createdByUserId: 'u-recorder' })
    );
    confirming.repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ status: 'CONFIRMED', createdByUserId: 'u-recorder' })
    );

    await confirming.service.decide(actor, 'q1', { decision: 'CONFIRM' });

    expect(confirming.notification.notifyUsers).toHaveBeenCalledTimes(1);
    const [, confirmRecipients, confirmContent] =
      confirming.notification.notifyUsers.mock.calls[0];
    expect(confirmRecipients).toEqual(['u-recorder', 'u-requester']);
    expect(confirmContent.title).toContain('تأیید شد');

    const returning = build();
    returning.repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ createdByUserId: 'u-recorder' })
    );
    returning.repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ status: 'RETURNED', createdByUserId: 'u-recorder' })
    );

    await returning.service.decide(actor, 'q1', {
      decision: 'RETURN',
      comment: 'مدل اشتباه است',
    });

    expect(returning.notification.notifyUsers).toHaveBeenCalledTimes(1);
    const [, returnRecipients, returnContent] = returning.notification.notifyUsers.mock.calls[0];
    expect(returnRecipients).toEqual(['u-recorder']);
    expect(returnContent.title).toContain('برگشت داده شد');
    expect(returnContent.body).toContain('مدل اشتباه است');
  });

  it('routes from the LATEST CONFIRMED total — CASH at or below the ceiling, NON_CASH above', async () => {
    const buildWithConfirmed = (totalAmount: string) => {
      const harness = build();
      harness.repository.findDocument.mockResolvedValue(documentFacts());
      harness.repository.listByDocument.mockResolvedValue([
        storedQuotation({ status: 'CONFIRMED', totalAmount }),
      ]);
      return harness;
    };

    const cash = buildWithConfirmed('250000.0000');
    const cashResult = await cash.service.list(actor, 'd1');
    expect(cashResult.paymentRouting).toEqual(
      expect.objectContaining({
        classification: 'CASH',
        cashMaxAmount: '30000000.0000',
        sourceQuotationId: 'q1',
      })
    );

    const nonCash = buildWithConfirmed('80000000.0000');
    const nonCashResult = await nonCash.service.list(actor, 'd1');
    expect(nonCashResult.paymentRouting.classification).toBe('NON_CASH');
  });
});

describe('GAP-6 follow-up 3.3 — scan attachment: upload, download, and the scan-only confirm gate', () => {
  const pendingQuotation = (overrides: Record<string, unknown> = {}) =>
    storedQuotation({ purchaseDocument: documentFacts(), ...overrides });
  const scanFile = {
    originalname: 'scan.png',
    mimetype: 'image/png',
    size: 128,
    buffer: Buffer.from('png-bytes'),
  };

  it('refuses confirming a scan-only quotation without its scan — named 409, nothing written', async () => {
    const { service, repository, unitOfWork } = build();
    repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ lines: [], attachmentRef: null })
    );

    await expectConflict(
      service.decide(actor, 'q1', { decision: 'CONFIRM' }),
      QUOTATION_FAILURE.SCAN_ATTACHMENT_REQUIRED
    );
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('a scan-only quotation WITH its scan confirms; RETURN stays possible without one', async () => {
    const { service, repository } = build();
    const withScan = {
      lines: [],
      attachmentRef: 'commerce/t1/price-quotations/q1/1-scan.png',
    };
    repository.findQuotationById.mockResolvedValue(pendingQuotation(withScan));
    repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ ...withScan, status: 'CONFIRMED' })
    );
    const confirmed = await service.decide(actor, 'q1', { decision: 'CONFIRM' });
    expect(confirmed.status).toBe('CONFIRMED');

    // The correction loop is never blocked by a missing scan: RETURN needs only its reason.
    const returning = build();
    returning.repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ lines: [], attachmentRef: null })
    );
    returning.repository.decideQuotationIn.mockResolvedValue(
      pendingQuotation({ lines: [], status: 'RETURNED' })
    );
    await returning.service.decide(actor, 'q1', { decision: 'RETURN', comment: 'reason' });
    expect(returning.repository.decideQuotationIn).toHaveBeenCalledTimes(1);
  });

  it('upload validates everything before storage: machine, 404, decided, file, size, type', async () => {
    const { service, repository, storage, unitOfWork } = build();

    await expect(
      service.uploadAttachment({ ...actor, userId: null }, 'q1', scanFile)
    ).rejects.toThrow(ForbiddenException);
    expect(repository.findQuotationById).not.toHaveBeenCalled();

    repository.findQuotationById.mockResolvedValue(null);
    await expect(service.uploadAttachment(actor, 'q1', scanFile)).rejects.toThrow(
      NotFoundException
    );

    repository.findQuotationById.mockResolvedValue(pendingQuotation({ status: 'CONFIRMED' }));
    await expectConflict(
      service.uploadAttachment(actor, 'q1', scanFile),
      QUOTATION_FAILURE.ALREADY_DECIDED
    );

    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    await expectConflict(
      service.uploadAttachment(actor, 'q1', undefined),
      QUOTATION_FAILURE.FILE_REQUIRED
    );
    await expectConflict(
      service.uploadAttachment(actor, 'q1', {
        ...scanFile,
        size: COMMERCE_MAX_ATTACHMENT_BYTES + 1,
      }),
      QUOTATION_FAILURE.FILE_TOO_LARGE
    );
    await expectConflict(
      service.uploadAttachment(actor, 'q1', { ...scanFile, mimetype: 'text/html' }),
      QUOTATION_FAILURE.FILE_TYPE_NOT_ALLOWED
    );

    // Through ALL of that, nothing touched storage or the unit of work.
    expect(storage.upload).not.toHaveBeenCalled();
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('upload writes the object first, binds it in the unit of work, and projects booleans — never the key', async () => {
    const { service, repository, storage, audit } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    repository.attachAttachmentRefIn.mockImplementation(
      async (_tenantId: string, _id: string, ref: string) => pendingQuotation({ attachmentRef: ref })
    );

    const result = await service.uploadAttachment(actor, 'q1', scanFile);

    const [key, bytes, mime] = storage.upload.mock.calls[0];
    expect(key).toMatch(/^commerce\/t1\/price-quotations\/q1\/.+scan\.png$/);
    expect(bytes).toBe(scanFile.buffer);
    expect(mime).toBe('image/png');

    const [tenantId, id, ref, outbox, tx] = repository.attachAttachmentRefIn.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(id).toBe('q1');
    expect(ref).toBe(key);
    expect(outbox).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          action: QUOTATION_AUDIT_ACTION.ATTACHMENT_UPLOADED,
          resource: COMMERCE_AUDIT_RESOURCE.PRICE_QUOTATION,
          resourceId: 'q1',
        }),
      })
    );
    expect(tx).toBe('tx-handle');
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ hasAttachment: true, attachmentDownloadable: true });
    expect(JSON.stringify(result)).not.toContain('commerce/');
  });

  it('a storage failure is a typed 500 and writes NOTHING to the row', async () => {
    const { service, repository, storage, unitOfWork } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    storage.upload.mockRejectedValue(new Error('storage down'));

    await expectConflict(
      service.uploadAttachment(actor, 'q1', scanFile),
      QUOTATION_FAILURE.STORAGE_UPLOAD_FAILED
    );
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('a lost race deletes the just-written object and answers the named 409', async () => {
    const { service, repository, storage } = build();
    repository.findQuotationById.mockResolvedValue(pendingQuotation());
    repository.attachAttachmentRefIn.mockResolvedValue(null); // a concurrent decision won

    await expectConflict(
      service.uploadAttachment(actor, 'q1', scanFile),
      QUOTATION_FAILURE.WRITE_CONFLICT
    );
    expect(storage.delete).toHaveBeenCalledTimes(1);
    const [writtenKey] = storage.upload.mock.calls[0];
    expect(storage.delete).toHaveBeenCalledWith(writtenKey);
  });

  it('replacing deletes the PREVIOUS object best-effort — but never an external reference', async () => {
    const { service, repository, storage } = build();
    repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ attachmentRef: 'commerce/t1/price-quotations/q1/old.png' })
    );
    repository.attachAttachmentRefIn.mockImplementation(
      async (_t: string, _id: string, ref: string) => pendingQuotation({ attachmentRef: ref })
    );
    await service.uploadAttachment(actor, 'q1', scanFile);
    expect(storage.delete).toHaveBeenCalledWith('commerce/t1/price-quotations/q1/old.png');

    const external = build();
    external.repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ attachmentRef: 'org://their-storage/quote-9' })
    );
    external.repository.attachAttachmentRefIn.mockImplementation(
      async (_t: string, _id: string, ref: string) => pendingQuotation({ attachmentRef: ref })
    );
    await external.service.uploadAttachment(actor, 'q1', scanFile);
    expect(external.storage.delete).not.toHaveBeenCalled();
  });

  it('download resolves an internal key to a signed URL and refuses everything else by name', async () => {
    const { service, repository, storage } = build();

    repository.findQuotationById.mockResolvedValue(null);
    await expect(service.attachmentDownload(actor, 'missing')).rejects.toThrow(NotFoundException);

    repository.findQuotationById.mockResolvedValue(pendingQuotation({ attachmentRef: null }));
    await expectConflict(
      service.attachmentDownload(actor, 'q1'),
      QUOTATION_FAILURE.ATTACHMENT_NOT_RESOLVABLE
    );

    repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ attachmentRef: 'org://their-storage/quote-9' })
    );
    await expectConflict(
      service.attachmentDownload(actor, 'q1'),
      QUOTATION_FAILURE.ATTACHMENT_NOT_RESOLVABLE
    );
    expect(storage.getUrl).not.toHaveBeenCalled();

    repository.findQuotationById.mockResolvedValue(
      pendingQuotation({ attachmentRef: 'commerce/t1/price-quotations/q1/1-scan.png' })
    );
    const answer = await service.attachmentDownload(actor, 'q1');
    expect(answer.url).toMatch(/^signed:\/\//);
    expect(answer.fileName).toBe('1-scan.png');
    expect(storage.getUrl).toHaveBeenCalledWith(
      'commerce/t1/price-quotations/q1/1-scan.png',
      expect.objectContaining({ expirySeconds: 300 })
    );
    // The answer is EXACTLY a url + a name: the raw key is not a field of it —
    // the signed URL is the platform's own short-lived, credential-bearing form.
    expect(Object.keys(answer).sort()).toEqual(['fileName', 'url']);
  });
});

describe('SUPPLIER DIRECTORY link — supplierId is validated, never trusted', () => {
  it('refuses a supplierId that names no supplier of this tenant', async () => {
    const { service, repository, suppliers, unitOfWork } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    suppliers.findSupplierById.mockResolvedValue(null);

    await expectConflict(
      service.create(actor, { purchaseDocumentId: 'd1', supplierId: 'no-such' }),
      QUOTATION_FAILURE.SUPPLIER_UNKNOWN
    );
    // Tenant-scoped existence check through the OWNING slice's repository.
    expect(suppliers.findSupplierById).toHaveBeenCalledWith('t1', 'no-such');
    expect(unitOfWork.run).not.toHaveBeenCalled();
  });

  it('stores the VALIDATED supplier id beside the label, and skips the check when absent', async () => {
    const { service, repository, suppliers } = build();
    repository.findDocument.mockResolvedValue(documentFacts());
    repository.findPendingByDocument.mockResolvedValue(null);
    suppliers.findSupplierById.mockResolvedValue({ id: 's1' });
    repository.createQuotation.mockResolvedValue(storedQuotation({ id: 'q-new' }));

    await service.create(actor, {
      purchaseDocumentId: 'd1',
      supplierLabel: 'فروشنده',
      supplierId: '11111111-1111-4111-8111-111111111111',
    });
    expect(repository.createQuotation.mock.calls[0][1]).toMatchObject({
      supplierLabel: 'فروشنده',
      supplierId: '11111111-1111-4111-8111-111111111111',
    });

    // No supplierId → no directory lookup at all (the scan-only / legacy path).
    suppliers.findSupplierById.mockClear();
    await service.create(actor, { purchaseDocumentId: 'd1' });
    expect(suppliers.findSupplierById).not.toHaveBeenCalled();
    expect(repository.createQuotation.mock.calls[1][1]).toMatchObject({ supplierId: null });
  });
});


