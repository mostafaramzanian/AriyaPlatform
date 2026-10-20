import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle, CommerceUnitOfWork } from '../database/commerce-transaction';
import type { PaymentHistoryService } from '../payment/payment-history.service';
import type { ReturnHistoryRepository } from './return-history.repository';
import {
  ReturnHistoryService,
  RETURN_AUDIT_ACTION,
  RETURN_FAILURE,
} from './return-history.service';
import { CreateReturnDto, RefundReturnDto, ReturnDecisionDto } from './return.dto';

/**
 * Phase C1 Step S (contract §13): the return lifecycle's application layer,
 * with the repository faked and the audit gateway a recorded spy, so every
 * assertion is about a DECISION rather than about SQL:
 *
 *  * the TENANT is the repository's FIRST argument on every call, and
 *    `tenantId` never reaches a response body (§4-G);
 *  * every write path runs in ONE unit of work whose FIRST statement is the
 *    row LOCK — before any receipt-history or return-history read (§9, the
 *    two falsifiable stand-ins R's suite applies to R's §3-H);
 *  * the invariant `alreadyReturned + requested <= netReceived` is exact
 *    `Decimal(18,4)` arithmetic: equality ACCEPTED, one `0.0001` over
 *    REFUSED with §10's exact message, nothing written, nothing audited
 *    (S-D1);
 *  * `netReceived` is R's signed history (compensating lines subtract),
 *    `alreadyReturned` is cumulative across return documents with ONLY
 *    `REJECTED` excluded (§4-C);
 *  * multi-line creation is ALL-OR-NOTHING (§9);
 *  * the four commands run the matrix FIRST — refusals mutate nothing and
 *    name the legal sources (§8/§10);
 *  * REFUND invokes Q BEFORE the append, through Q's public surface, and a
 *    Q failure answers `refund_compensation_failed` with NO `REFUNDED` row
 *    and NO S audit (§4-E);
 *  * every 409 refusal carries §10's exact code token in its object payload
 *    (`over_return`, `invalid_transition`, `line_reference_mismatch`,
 *    `refund_compensation_failed`; the fifth, `invalid_origin`, is reserved
 *    and unreachable — the scoped 404 answers first);
 *  * exactly ONE audit row per successful operation, on
 *    `COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT`, AFTER the commit — zero for
 *    reads and zero for refusals (§11).
 *
 * The `build()` helper constructs fresh fakes per test (the Q/R/P
 * precedent): what a fake RETURNS is the test's to decide, what was CALLED
 * is `mock.calls`' to remember, and no shared reset can empty a log an
 * assertion still needs.
 */

const ACTOR: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const RETURN_ID = '22222222-2222-4222-8222-222222222222';
const PURCHASE_LINE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PURCHASE_LINE_ID = '44444444-4444-4444-8444-444444444444';
const RECEIPT_LINE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_RECEIPT_LINE_ID = '66666666-6666-4666-8666-666666666666';
const PAYMENT_ID = '77777777-7777-4777-8777-777777777777';
const TRANSITION_ID = '88888888-8888-4888-8888-888888888888';
const APPENDED_TRANSITION_ID = '99999999-9999-4999-8999-999999999999';

const T0 = new Date('2026-09-29T10:00:00.000Z');
const T1 = new Date('2026-09-29T10:00:01.000Z');
const T2 = new Date('2026-09-29T10:00:02.000Z');
/** The clock of a just-appended row — strictly after every stored fixture row. */
const T3 = new Date('2026-09-29T10:00:03.000Z');

/** One receipt line as `listReceiptLines` returns it (R's signed history). */
function receiptLine(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_LINE_ID,
    purchaseLineId: PURCHASE_LINE_ID,
    quantity: '100.0000',
    reversesReceiptLineId: null,
    createdAt: T1,
    ...overrides,
  };
}

/** One lifecycle transition row. */
function transition(state: string, createdAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSITION_ID,
    state,
    actorUserId: 'u1',
    reason: null,
    createdAt,
    ...overrides,
  };
}

/** One return line as stored. */
function returnLine(overrides: Record<string, unknown> = {}) {
  return {
    id: RETURN_ID,
    purchaseLineId: PURCHASE_LINE_ID,
    receiptLineId: RECEIPT_LINE_ID,
    quantity: '10.0000',
    createdAt: T1,
    ...overrides,
  };
}

/** One return document with its history — defaults to a fresh REQUESTED row. */
function storedReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: RETURN_ID,
    tenantId: 't1',
    purchaseDocumentId: DOCUMENT_ID,
    reason: 'damaged on arrival',
    replacementRequired: false,
    requestedByUserId: 'u1',
    createdAt: T0,
    lines: [returnLine()],
    transitions: [transition('REQUESTED', T0)],
    ...overrides,
  };
}

interface CreatedReturnData {
  purchaseDocumentId: string;
  reason: string;
  replacementRequired: boolean;
  requestedByUserId: string;
  lines: Array<Record<string, unknown>>;
  requestedTransition: { actorUserId: string };
}

/** The document a create's append returns — built from what the service wrote. */
function createdReturn(data: CreatedReturnData) {
  return {
    id: RETURN_ID,
    tenantId: 't1',
    purchaseDocumentId: data.purchaseDocumentId,
    reason: data.reason,
    replacementRequired: data.replacementRequired,
    requestedByUserId: data.requestedByUserId,
    createdAt: T0,
    lines: data.lines.map((line, index) => ({
      id: `${RETURN_ID}-line-${index}`,
      ...line,
      createdAt: T0,
    })),
    transitions: [
      {
        id: TRANSITION_ID,
        state: 'REQUESTED',
        actorUserId: data.requestedTransition.actorUserId,
        reason: null,
        createdAt: T0,
      },
    ],
  };
}

/** The service with recording fakes — the repository's FULL surface, nothing more. */
/**
 * The handle the fake unit of work mints — a NAMED value on purpose: the refund must
 * forward THIS one to Q (§4-E's one act, two writes, and Step U's fix for the 500 a
 * second connection caused), so an assertion naming it is a falsifiable claim.
 */
const TX_HANDLE = { mintedBy: 'returns-unit-of-work' } as unknown as CommerceTransactionHandle;

interface AuditAct {
  action: string;
  resource: string;
  resourceId: string;
}

type AuditActCall = [unknown, AuditAct];

function build() {
  type RepositoryMocks = {
    readReturnHistory: jest.Mock;
    lockDocumentForReturn: jest.Mock;
    listPurchaseLines: jest.Mock;
    listReceiptLines: jest.Mock;
    listReturnDocuments: jest.Mock;
    findReturnDocument: jest.Mock;
    appendReturn: jest.Mock;
    appendTransition: jest.Mock;
  };
  const repository: RepositoryMocks = {
    readReturnHistory: jest.fn().mockResolvedValue([{ id: DOCUMENT_ID }, []]),
    lockDocumentForReturn: jest.fn().mockResolvedValue({ id: DOCUMENT_ID }),
    listPurchaseLines: jest.fn().mockResolvedValue([{ id: PURCHASE_LINE_ID, lineNumber: 1 }]),
    listReceiptLines: jest.fn().mockResolvedValue([receiptLine()]),
    listReturnDocuments: jest.fn().mockResolvedValue([]),
    findReturnDocument: jest.fn().mockResolvedValue(storedReturn()),
    appendReturn: jest.fn().mockImplementation(
      async (
        _tenantId: string,
        _tx: CommerceTransactionHandle,
        data: CreatedReturnData
      ) => createdReturn(data)
    ),
    appendTransition: jest.fn().mockImplementation(
      async (
        _tenantId: string,
        _tx: CommerceTransactionHandle,
        data: { returnDocumentId: string; state: string; actorUserId: string; reason: string | null }
      ) => ({
        id: APPENDED_TRANSITION_ID,
        returnDocumentId: data.returnDocumentId,
        state: data.state,
        actorUserId: data.actorUserId,
        reason: data.reason,
        createdAt: T3,
      })
    ),
  };
  const audit = {
    record: jest.fn(),
    buildOutboxPayload: jest.fn().mockImplementation((_actor: CommerceActor, act: unknown) => ({
      tenantId: 't1',
      auditId: 'outbox-audit-id',
      payload: act,
    })),
  };
  const unitOfWork = {
    run: jest.fn(async (work: (tx: CommerceTransactionHandle) => Promise<unknown>) =>
      work(TX_HANDLE)
    ),
  };
  const payments: { compensate: jest.Mock } = {
    compensate: jest.fn().mockResolvedValue({ id: PAYMENT_ID }),
  };

  const inventoryIntegration = {
    planReturnDispatchPostings: jest.fn().mockResolvedValue([]),
    attemptPostings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new ReturnHistoryService(
      repository as unknown as ReturnHistoryRepository,
      audit as unknown as CommerceAuditGateway,
      unitOfWork as unknown as CommerceUnitOfWork,
      payments as unknown as PaymentHistoryService,
      inventoryIntegration as never
    ),
    repository,
    audit,
    unitOfWork,
    payments,
    inventoryIntegration,
  };
}

/** A minimal but complete create DTO — each test states only its deltas. */
function createDto(overrides: Record<string, unknown> = {}): CreateReturnDto {
  return {
    reason: 'damaged on arrival',
    replacementRequired: false,
    lines: [{ purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 10 }],
    ...overrides,
  } as CreateReturnDto;
}

/** Run an op that must be REFUSED, and return the thrown error for exact checks. */
async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to be refused, but it succeeded');
}

/** The §10 code token S answered — read the way the exception filter reads it. */
function failureCode(error: Error): unknown {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? (body as { code: unknown }).code
    : undefined;
}

/** Every repository call's first argument — the tenant-first rule, mechanically. */
function firstArgsOf(repository: Record<string, jest.Mock>): unknown[] {
  return Object.values(repository)
    .filter((fn) => typeof fn === 'function' && Array.isArray(fn.mock?.calls))
    .flatMap((fn) => fn.mock.calls.map((call: unknown[]) => call[0]));
}

describe('C1 step S — the read: whole history, projected, unpaged, silent (§4-F, §11)', () => {
  it('renders every return oldest-first with the projected state and exact decimal strings', async () => {
    const { service, repository, audit } = build();
    const newer = storedReturn({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: T2,
      lines: [returnLine({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: '2.5000' })],
      transitions: [
        transition('REQUESTED', T0),
        transition('APPROVED', T1, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      ],
    });
    const older = storedReturn({ id: RETURN_ID, createdAt: T0 });
    repository.readReturnHistory.mockResolvedValue([{ id: DOCUMENT_ID }, [newer, older]]);

    const result = await service.list(ACTOR, DOCUMENT_ID);

    // Oldest first — the whole history, unpaged (§4-F), never a page envelope.
    expect(result.returns.map((ret) => ret.id)).toEqual([RETURN_ID, newer.id]);
    expect(result.returns[0].state).toBe('REQUESTED');
    expect(result.returns[1].state).toBe('APPROVED');
    // The response's OWN fields, stated explicitly: no tenantId, no
    // purchaseDocumentId — the route already names the document (§7).
    expect(Object.keys(result.returns[1]).sort()).toEqual(
      [
        'createdAt',
        'id',
        'lines',
        'reason',
        'replacementRequired',
        'requestedByUserId',
        'state',
        'transitions',
      ].sort()
    );
    // Quantity is the stored Decimal(18,4) STRING, never a number.
    expect(result.returns[1].lines[0].quantity).toBe('2.5000');
    expect(result.returns[1].lines[0].receiptLineId).toBe(RECEIPT_LINE_ID);
    // Reads audit NOTHING (§11), and the tenant is the first argument (§4-G).
    expect(audit.record).not.toHaveBeenCalled();
    expect(repository.readReturnHistory).toHaveBeenCalledWith('t1', DOCUMENT_ID);
  });

  it('404s an unknown or foreign document before anything else, auditing nothing (§10)', async () => {
    const { service, repository, audit } = build();
    repository.readReturnHistory.mockResolvedValue([null, []]);

    const error = await refusal(() => service.list(ACTOR, DOCUMENT_ID));

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('Purchase document not found');
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('C1 step S — create: lock first, proven origin, tenant always first (§9, §10, §4-G)', () => {
  it('acquires the PurchaseDocument lock BEFORE any receipt or return history read', async () => {
    const { service, repository, unitOfWork } = build();
    await service.create(ACTOR, DOCUMENT_ID, createDto());

    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    const lock = order(repository.lockDocumentForReturn);
    expect(order(repository.listPurchaseLines)).toBeGreaterThan(lock);
    expect(order(repository.listReceiptLines)).toBeGreaterThan(lock);
    expect(order(repository.listReturnDocuments)).toBeGreaterThan(lock);
    expect(order(repository.appendReturn)).toBeGreaterThan(lock);
  });

  it('404s an unknown document at the lock — no history read, no write, no audit', async () => {
    const { service, repository, audit } = build();
    repository.lockDocumentForReturn.mockResolvedValue(null);

    const error = await refusal(() => service.create(ACTOR, DOCUMENT_ID, createDto()));

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('Purchase document not found');
    expect(repository.listReceiptLines).not.toHaveBeenCalled();
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s a purchase line the document does not own — a UUID elsewhere proves nothing', async () => {
    const { service, repository, audit } = build();
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            { purchaseLineId: OTHER_PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 1 },
          ],
        })
      )
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('Purchase line not found');
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("404s a receipt line outside this document (scoped by document AND tenant, R's rule)", async () => {
    const { service, repository, audit } = build();
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            {
              purchaseLineId: PURCHASE_LINE_ID,
              receiptLineId: OTHER_RECEIPT_LINE_ID,
              quantity: 1,
            },
          ],
        })
      )
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('Receipt line not found');
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('409s line_reference_mismatch when both references exist in scope but contradict (S-D5)', async () => {
    const { service, repository, audit } = build();
    // The OTHER purchase line IS owned by this document, and the receipt line
    // exists — but the receipt line belongs to a DIFFERENT purchase line.
    repository.listPurchaseLines.mockResolvedValue([
      { id: PURCHASE_LINE_ID, lineNumber: 1 },
      { id: OTHER_PURCHASE_LINE_ID, lineNumber: 2 },
    ]);
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            {
              purchaseLineId: OTHER_PURCHASE_LINE_ID,
              receiptLineId: RECEIPT_LINE_ID,
              quantity: 1,
            },
          ],
        })
      )
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe("Return line's receipt line does not belong to its purchase line");
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('passes the tenant as the FIRST argument of EVERY repository call (§4-G)', async () => {
    const { service, repository } = build();
    await service.create(ACTOR, DOCUMENT_ID, createDto());
    const args = firstArgsOf(repository).filter((value) => value !== undefined);
    expect(args.length).toBeGreaterThanOrEqual(5); // non-vacuity: the scan saw real calls
    expect(args).toEqual(args.map(() => 't1'));
  });
});

describe('C1 step S — the quantity invariant: exact, cumulative, all-or-nothing (S-D1, §4-C, §9)', () => {
  it('ACCEPTS the exact boundary — received 100, already 0, requested 100 (equality is valid)', async () => {
    const { service, repository, audit } = build();
    await service.create(
      ACTOR,
      DOCUMENT_ID,
      createDto({
        lines: [
          { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 100 },
        ],
      })
    );

    expect(repository.appendReturn).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("REFUSES one 0.0001 over with §10's exact message — no document, no lines, no transition, no audit", async () => {
    const { service, repository, audit } = build();
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            {
              purchaseLineId: PURCHASE_LINE_ID,
              receiptLineId: RECEIPT_LINE_ID,
              quantity: 100.0001,
            },
          ],
        })
      )
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'Return quantity exceeds the net received quantity of its receipt line: ' +
        'net received 100.0000, already returned 0.0000, requested 100.0001'
    );
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('counts CUMULATIVELY across return documents — only REJECTED stops counting (§4-C)', async () => {
    const { service, repository, audit } = build();
    // 60 REQUESTED + 30 REFUNDED + 50 REJECTED: the sum is 90, never 140.
    repository.listReturnDocuments.mockResolvedValue([
      storedReturn({ lines: [returnLine({ quantity: '60.0000' })] }),
      storedReturn({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        lines: [returnLine({ quantity: '30.0000' })],
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
          transition('RECEIVED_BACK', T1, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
          transition('REFUNDED', T2, { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
        ],
      }),
      storedReturn({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        lines: [returnLine({ quantity: '50.0000' })],
        transitions: [
          transition('REQUESTED', T0),
          transition('REJECTED', T1, { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
        ],
      }),
    ]);

    // 90 already returned + 10 requested = 100 = net: the boundary PASSES.
    await service.create(
      ACTOR,
      DOCUMENT_ID,
      createDto({
        lines: [{ purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 10 }],
      })
    );
    expect(repository.appendReturn).toHaveBeenCalledTimes(1);

    // …and 90 + 11 refuses, NAMING 90 — the cumulative figure, not any single row.
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 11 },
          ],
        })
      )
    );
    expect(error.message).toBe(
      'Return quantity exceeds the net received quantity of its receipt line: ' +
        'net received 100.0000, already returned 90.0000, requested 11.0000'
    );
    expect(audit.record).toHaveBeenCalledTimes(1); // only the successful create
  });

  it("derives netReceived from R's signed history — a compensating receipt line subtracts (§4-C)", async () => {
    const { service, repository } = build();
    repository.listReceiptLines.mockResolvedValue([
      receiptLine(),
      receiptLine({
        id: OTHER_RECEIPT_LINE_ID,
        quantity: '-20.0000',
        reversesReceiptLineId: RECEIPT_LINE_ID,
      }),
    ]);

    // 100 − 20 = 80: the exact boundary against the NET figure.
    await service.create(
      ACTOR,
      DOCUMENT_ID,
      createDto({
        lines: [{ purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 80 }],
      })
    );
    expect(repository.appendReturn).toHaveBeenCalledTimes(1);

    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 81 },
          ],
        })
      )
    );
    expect(error.message).toBe(
      'Return quantity exceeds the net received quantity of its receipt line: ' +
        'net received 80.0000, already returned 0.0000, requested 81.0000'
    );
  });

  it('sums duplicate entries of the SAME receipt line FIRST — splitting cannot smuggle an over-return', async () => {
    const { service, repository } = build();
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 60 },
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 50 },
          ],
        })
      )
    );

    expect(error.message).toBe(
      'Return quantity exceeds the net received quantity of its receipt line: ' +
        'net received 100.0000, already returned 0.0000, requested 110.0000'
    );
    expect(repository.appendReturn).not.toHaveBeenCalled();
  });

  it('is Decimal(18,4) exact — 33.3333 + 66.6667 passes though a float sum would exceed 100', async () => {
    const { service, repository } = build();
    repository.listReturnDocuments.mockResolvedValue([
      storedReturn({ lines: [returnLine({ quantity: '33.3333' })] }),
    ]);

    // 33.3333 + 66.6667 = 100.0000 EXACTLY: a float sum
    // (100.00000000000001) would wrongly refuse this equality — the
    // scaled-bigint arithmetic must accept it.
    await service.create(
      ACTOR,
      DOCUMENT_ID,
      createDto({
        lines: [
          { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 66.6667 },
        ],
      })
    );
    expect(repository.appendReturn).toHaveBeenCalledTimes(1);

    // One ten-thousandth more is over — no tolerance in either direction.
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 66.6668 },
          ],
        })
      )
    );
    expect(error.message).toContain('already returned 33.3333, requested 66.6668');
  });

  it('refuses the WHOLE document when any one line violates — one bad line, zero rows (§9)', async () => {
    const { service, repository, audit } = build();
    repository.listReceiptLines.mockResolvedValue([
      receiptLine(),
      receiptLine({
        id: OTHER_RECEIPT_LINE_ID,
        purchaseLineId: OTHER_PURCHASE_LINE_ID,
        quantity: '5.0000',
      }),
    ]);
    repository.listPurchaseLines.mockResolvedValue([
      { id: PURCHASE_LINE_ID, lineNumber: 1 },
      { id: OTHER_PURCHASE_LINE_ID, lineNumber: 2 },
    ]);

    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            // Line 1 is well within its cap…
            { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 10 },
            // …line 2 exceeds its net received 5.
            {
              purchaseLineId: OTHER_PURCHASE_LINE_ID,
              receiptLineId: OTHER_RECEIPT_LINE_ID,
              quantity: 6,
            },
          ],
        })
      )
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain(
      'net received 5.0000, already returned 0.0000, requested 6.0000'
    );
    // ALL-OR-NOTHING: the good line is NOT written either.
    expect(repository.appendReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('C1 step S — create: one atomic append, requester server-derived, one audit (§8, §11, §4-B)', () => {
  it('writes document + lines + the INITIAL REQUESTED transition in ONE append', async () => {
    const { service, repository } = build();
    await service.create(
      ACTOR,
      DOCUMENT_ID,
      createDto({
        reason: '   padded reason   ',
        lines: [
          { purchaseLineId: PURCHASE_LINE_ID, receiptLineId: RECEIPT_LINE_ID, quantity: 10 },
          {
            purchaseLineId: PURCHASE_LINE_ID,
            receiptLineId: RECEIPT_LINE_ID,
            quantity: 2.5,
          },
        ],
      })
    );

    expect(repository.appendReturn).toHaveBeenCalledTimes(1);
    const [tenantId, tx, data] = repository.appendReturn.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(tx).toBeDefined(); // the handle, inside the unit of work
    expect(data.purchaseDocumentId).toBe(DOCUMENT_ID);
    expect(data.reason).toBe('padded reason'); // stored TRIMMED (§4-B's 1…500 after trim)
    expect(data.replacementRequired).toBe(false);
    // The requester is the ACTOR's user — never a payload field (§4-B/§16).
    expect(data.requestedByUserId).toBe('u1');
    expect(data.requestedTransition.actorUserId).toBe('u1');
    // Both entries survive as lines, exact decimal strings.
    expect(data.lines).toEqual([
      {
        purchaseLineId: PURCHASE_LINE_ID,
        receiptLineId: RECEIPT_LINE_ID,
        quantity: '10.0000',
      },
      {
        purchaseLineId: PURCHASE_LINE_ID,
        receiptLineId: RECEIPT_LINE_ID,
        quantity: '2.5000',
      },
    ]);
  });

  it('takes a NULL requester from the actor for a machine context — still never from a payload', async () => {
    const { service, repository } = build();
    const machine: CommerceActor = { ...ACTOR, userId: null };
    await service.create(machine, DOCUMENT_ID, createDto());
    expect(repository.appendReturn.mock.calls[0][2].requestedByUserId).toBeNull();
  });

  it('audits exactly once, AFTER the commit, on RETURN_DOCUMENT with action create (§11)', async () => {
    const { service, audit, unitOfWork } = build();
    await service.create(ACTOR, DOCUMENT_ID, createDto());

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [actor, act] = audit.record.mock.calls[0];
    expect(actor).toEqual(ACTOR);
    expect(act.action).toBe(RETURN_AUDIT_ACTION.CREATE);
    expect(act.resource).toBe(COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT);
    expect(act.resourceId).toBe(RETURN_ID);
    expect(act.newValue).toEqual({ state: 'REQUESTED', transitionId: TRANSITION_ID });
    expect(act.reason).toBe('damaged on arrival');
    // AFTER the commit: the unit of work completed before the gateway ran —
    // a rolled-back write can never leave a "success" trail row.
    expect(unitOfWork.run.mock.invocationCallOrder[0]).toBeLessThan(
      audit.record.mock.invocationCallOrder[0]
    );
  });

  it('projects the response state from the written history, with no tenantId in the body (§7)', async () => {
    const { service } = build();
    const view = await service.create(ACTOR, DOCUMENT_ID, createDto());

    expect(view.state).toBe('REQUESTED');
    expect(view.transitions).toEqual([
      {
        id: TRANSITION_ID,
        state: 'REQUESTED',
        actorUserId: 'u1',
        reason: null,
        createdAt: T0,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('tenantId');
    expect(JSON.stringify(view)).not.toContain('purchaseDocumentId');
  });
});

describe('C1 step S — the four lifecycle commands: matrix first, one row, one audit (§8, §10, §11)', () => {
  it('approve: locks first, appends APPROVED, audits once, returns the projected view', async () => {
    const { service, repository, audit, unitOfWork } = build();
    const dto: ReturnDecisionDto = { reason: 'supplier agreed' };

    const view = await service.approve(ACTOR, DOCUMENT_ID, RETURN_ID, dto);

    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(repository.lockDocumentForReturn)).toBeLessThan(
      order(repository.findReturnDocument)
    );
    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    expect(repository.appendTransition).toHaveBeenCalledTimes(1);
    const [tenantId, , transitionData] = repository.appendTransition.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(transitionData).toEqual({
      returnDocumentId: RETURN_ID,
      state: 'APPROVED',
      actorUserId: 'u1',
      reason: 'supplier agreed',
      refundedPaymentId: null,
      refundCompensationPaymentId: null,
    });
    expect(view.state).toBe('APPROVED');
    expect(view.transitions).toHaveLength(2); // the original row, plus this one
    // Phase B2.3: durable events use buildOutboxPayload, not record.
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action: RETURN_AUDIT_ACTION.APPROVE,
      resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
      resourceId: RETURN_ID,
      oldValue: { state: 'REQUESTED' },
      newValue: { state: 'APPROVED' },
      reason: 'supplier agreed',
    });
    // The outbox payload is passed to the repository's appendTransition.
    const outboxArg = repository.appendTransition.mock.calls[0][3];
    expect(outboxArg).toBeDefined();
    expect(outboxArg.tenantId).toBe('t1');
  });

  it('refuses approve from REJECTED with the exact invalid_transition message, mutating NOTHING', async () => {
    const { service, repository, audit } = build();
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [transition('REQUESTED', T0), transition('REJECTED', T1)],
      })
    );

    const error = await refusal(() =>
      service.approve(ACTOR, DOCUMENT_ID, RETURN_ID, new ReturnDecisionDto())
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'Only a return in REQUESTED may be approved; this return is REJECTED'
    );
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).not.toHaveBeenCalled();
  });

  it('reject from REQUESTED writes REJECTED and audits reject; a second reject hits the terminal refusal', async () => {
    const { service, repository, audit } = build();
    await service.reject(ACTOR, DOCUMENT_ID, RETURN_ID, { reason: 'wrong items' });
    expect(repository.appendTransition.mock.calls[0][2].state).toBe('REJECTED');
    expect(audit.buildOutboxPayload.mock.calls[0][1].action).toBe(RETURN_AUDIT_ACTION.REJECT);

    // The return is now terminal — nothing comes out of REJECTED (S-D2).
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [transition('REQUESTED', T0), transition('REJECTED', T1)],
      })
    );
    const error = await refusal(() =>
      service.reject(ACTOR, DOCUMENT_ID, RETURN_ID, new ReturnDecisionDto())
    );
    expect(error.message).toBe(
      'Only a return in REQUESTED may be rejected; this return is REJECTED'
    );
    expect(repository.appendTransition).toHaveBeenCalledTimes(1); // only the first
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
  });

  it('receive-back refused from REQUESTED names APPROVED as the only legal source', async () => {
    const { service, repository, audit } = build();
    const error = await refusal(() => service.receiveBack(ACTOR, DOCUMENT_ID, RETURN_ID));

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'Only a return in APPROVED may be received back; this return is REQUESTED'
    );
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s an unknown/foreign/other-document return with the ONE message, writing nothing (§7, §10)', async () => {
    const { service, repository, audit } = build();
    repository.findReturnDocument.mockResolvedValue(null);

    const error = await refusal(() =>
      service.approve(ACTOR, DOCUMENT_ID, RETURN_ID, new ReturnDecisionDto())
    );

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe('Return document not found');
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('locks the document BEFORE loading the return — the same hinge as create, even on a refusal', async () => {
    const { service, repository } = build();
    // The default fixture is REQUESTED, so receive-back is refused — the
    // LOCK and the scoped load still happen, in that order (§9).
    await refusal(() => service.receiveBack(ACTOR, DOCUMENT_ID, RETURN_ID));

    expect(repository.lockDocumentForReturn).toHaveBeenCalledTimes(1);
    expect(repository.findReturnDocument).toHaveBeenCalledTimes(1);
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(repository.lockDocumentForReturn)).toBeLessThan(
      order(repository.findReturnDocument)
    );
  });

  it('receive-back from APPROVED appends RECEIVED_BACK with NO reason — the body states nothing (§7)', async () => {
    const { service, repository, audit } = build();
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        ],
      })
    );

    const view = await service.receiveBack(ACTOR, DOCUMENT_ID, RETURN_ID);

    expect(repository.appendTransition.mock.calls[0][2]).toEqual({
      returnDocumentId: RETURN_ID,
      state: 'RECEIVED_BACK',
      actorUserId: 'u1',
      reason: null,
      refundedPaymentId: null,
      refundCompensationPaymentId: null,
    });
    expect(view.state).toBe('RECEIVED_BACK');
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action: RETURN_AUDIT_ACTION.RECEIVE_BACK,
      resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
      oldValue: { state: 'APPROVED' },
      newValue: { state: 'RECEIVED_BACK' },
    });
    expect(audit.buildOutboxPayload.mock.calls[0][1].reason).toBeNull();
  });
});

describe('C1 step S — refund: Q first, then REFUNDED — the §4-E boundary, exactly', () => {
  /** A return whose projection is RECEIVED_BACK — refund's only legal source. */
  function receivedBackReturn() {
    return storedReturn({
      transitions: [
        transition('REQUESTED', T0),
        transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        transition('RECEIVED_BACK', T2, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      ],
    });
  }

  it("invokes Q's compensation BEFORE appending — and only then writes REFUNDED + one audit", async () => {
    const { service, repository, payments, audit } = build();
    repository.findReturnDocument.mockResolvedValue(receivedBackReturn());

    const view = await service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, {
      paymentId: PAYMENT_ID,
      reason: 'goods returned to supplier',
    } as RefundReturnDto);

    // The EXACT Q boundary: the established PaymentHistoryService surface,
    // with the actor, the return's ORIGIN document, the stated paymentId and
    // the reason — S never touches PaymentRecord itself.
    expect(payments.compensate).toHaveBeenCalledTimes(1);
    expect(payments.compensate).toHaveBeenCalledWith(
      ACTOR,
      DOCUMENT_ID,
      PAYMENT_ID,
      { reason: 'goods returned to supplier' },
      TX_HANDLE // Q's INSERT joins S's transaction: the handle is forwarded, not dropped
    );
    // Q ran BEFORE the append (§4-E's ordering), inside the same unit of work.
    expect(payments.compensate.mock.invocationCallOrder[0]).toBeLessThan(
      repository.appendTransition.mock.invocationCallOrder[0]
    );
    expect(repository.appendTransition.mock.calls[0][2]).toEqual({
      returnDocumentId: RETURN_ID,
      state: 'REFUNDED',
      actorUserId: 'u1',
      reason: 'goods returned to supplier',
      // W3.1/W4-B: the funded payment AND the exact compensation row both ride
      // the REFUNDED row — the links the closure evaluator reads.
      refundedPaymentId: '77777777-7777-4777-8777-777777777777',
      refundCompensationPaymentId: '77777777-7777-4777-8777-777777777777',
    });
    expect(view.state).toBe('REFUNDED');
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).toHaveBeenCalledTimes(1);
    expect(audit.buildOutboxPayload.mock.calls[0][1]).toMatchObject({
      action: RETURN_AUDIT_ACTION.REFUND,
      resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
      oldValue: { state: 'RECEIVED_BACK' },
      newValue: { state: 'REFUNDED' },
    });
  });

  it('W4: a stated refund amount is forwarded to Q — the partial figure rides the compensation', async () => {
    const { service, repository, payments } = build();
    repository.findReturnDocument.mockResolvedValue(receivedBackReturn());

    await service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, {
      paymentId: PAYMENT_ID,
      amount: 20,
      reason: 'partial refund for 2 of 10 units',
    } as RefundReturnDto);

    expect(payments.compensate).toHaveBeenCalledWith(
      ACTOR,
      DOCUMENT_ID,
      PAYMENT_ID,
      { amount: 20, reason: 'partial refund for 2 of 10 units' },
      TX_HANDLE
    );
  });

  it('maps ANY Q refusal to refund_compensation_failed — NO transition, NO REFUNDED, NO S audit', async () => {
    const { service, repository, payments, audit } = build();
    repository.findReturnDocument.mockResolvedValue(receivedBackReturn());
    payments.compensate.mockRejectedValue(
      new Error('The payment already has a compensating row: abc')
    );

    const error = await refusal(() =>
      service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, { paymentId: PAYMENT_ID } as RefundReturnDto)
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'Refund compensation failed: The payment already has a compensating row: abc'
    );
    // The return stays RECEIVED_BACK: no row, no projection, no trail (§4-E.3).
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).not.toHaveBeenCalled();
  });

  it('runs the matrix BEFORE Q — an invalid source state never reaches the payment boundary', async () => {
    const { service, repository, payments, audit } = build();
    // Still REQUESTED: refund's only legal source is RECEIVED_BACK.
    const error = await refusal(() =>
      service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, { paymentId: PAYMENT_ID } as RefundReturnDto)
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'Only a return in RECEIVED_BACK may be refunded; this return is REQUESTED'
    );
    expect(payments.compensate).not.toHaveBeenCalled();
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.buildOutboxPayload).not.toHaveBeenCalled();
  });

  it('404s an unknown return BEFORE Q is ever asked to compensate anything', async () => {
    const { service, repository, payments, audit } = build();
    repository.findReturnDocument.mockResolvedValue(null);

    const error = await refusal(() =>
      service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, { paymentId: PAYMENT_ID } as RefundReturnDto)
    );

    expect(error.message).toBe('Return document not found');
    expect(payments.compensate).not.toHaveBeenCalled();
    expect(repository.appendTransition).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('passes an EMPTY Q payload when no reason is stated — Q decides its own defaults (§7)', async () => {
    const { service, repository, payments } = build();
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
          transition('RECEIVED_BACK', T2, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
        ],
      })
    );

    await service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, {
      paymentId: PAYMENT_ID,
    } as RefundReturnDto);

    expect(payments.compensate).toHaveBeenCalledWith(ACTOR, DOCUMENT_ID, PAYMENT_ID, {}, TX_HANDLE);
  });
});

describe('C1 step S — audit vocabulary and silence (§11)', () => {
  it('is exactly the five contract actions — no sixth, no other spelling', () => {
    expect(RETURN_AUDIT_ACTION).toEqual({
      CREATE: 'create',
      APPROVE: 'approve',
      REJECT: 'reject',
      RECEIVE_BACK: 'receive_back',
      REFUND: 'refund',
    });
    // The contract's own record, key by key (§11 quotes this shape).
    expect(Object.values(RETURN_AUDIT_ACTION)).toHaveLength(5);
  });

  it('records ONE row per successful operation, all on RETURN_DOCUMENT; reads record none', async () => {
    const { service, repository, audit } = build();

    // A read: silent (§11).
    await service.list(ACTOR, DOCUMENT_ID);

    // Then all five successful writes, each from a legal source state.
    await service.create(ACTOR, DOCUMENT_ID, createDto()); // -> create
    await service.approve(ACTOR, DOCUMENT_ID, RETURN_ID, new ReturnDecisionDto()); // -> approve
    await service.reject(ACTOR, DOCUMENT_ID, RETURN_ID, new ReturnDecisionDto()); // -> reject
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        ],
      })
    );
    await service.receiveBack(ACTOR, DOCUMENT_ID, RETURN_ID); // -> receive_back
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
          transition('RECEIVED_BACK', T2, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
        ],
      })
    );
    await service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, {
      paymentId: PAYMENT_ID,
    } as RefundReturnDto); // -> refund

    // Phase B2.3: create uses best-effort audit.record; transitions use buildOutboxPayload.
    const recordActs = (audit.record.mock.calls as AuditActCall[]).map(([, act]) => act);
    expect(recordActs).toHaveLength(1); // only create
    expect(recordActs[0].action).toBe('create');

    const outboxActs = (audit.buildOutboxPayload.mock.calls as AuditActCall[]).map(
      ([, act]) => act
    );
    expect(outboxActs).toHaveLength(4); // approve, reject, receive_back, refund

    const allActions = [...recordActs, ...outboxActs].map((act) => act.action).sort();
    expect(allActions).toEqual(
      ['approve', 'create', 'receive_back', 'reject', 'refund'].sort()
    );
    const allActs = [...recordActs, ...outboxActs];
    for (const act of allActs) {
      expect(act.resource).toBe(COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT);
      expect(act.resourceId).toBe(RETURN_ID);
    }
    // And the refund's payment side is NEVER S's audit resource (§11).
    expect(allActs.map((act) => act.resource)).not.toContain(
      COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD
    );
  });
});

describe('C1 step S — §10: every 409 is NAMED — token and exact message together', () => {
  it('declares EXACTLY the five §10 tokens — no sixth, none misspelled', () => {
    expect(Object.values(RETURN_FAILURE).sort()).toEqual([
      'invalid_origin',
      'invalid_transition',
      'line_reference_mismatch',
      'over_return',
      'refund_compensation_failed',
    ]);
  });

  it("over-return carries `over_return` and §10's message, exact", async () => {
    const { service, repository } = build();
    const error = await refusal(() =>
      service.create(
        ACTOR,
        DOCUMENT_ID,
        createDto({
          lines: [
            {
              purchaseLineId: PURCHASE_LINE_ID,
              receiptLineId: RECEIPT_LINE_ID,
              quantity: 100.0001,
            },
          ],
        })
      )
    );

    expect((error as HttpException).getResponse()).toEqual({
      code: RETURN_FAILURE.OVER_RETURN,
      message:
        'Return quantity exceeds the net received quantity of its receipt line: ' +
        'net received 100.0000, already returned 0.0000, requested 100.0001',
    });
    expect(failureCode(error)).toBe('over_return');
    expect(repository.appendReturn).not.toHaveBeenCalled();
  });

  it('contradicting references carry `line_reference_mismatch`, message exact', async () => {
    const { service, repository } = build();
    repository.listReceiptLines.mockResolvedValue([
      receiptLine({ purchaseLineId: OTHER_PURCHASE_LINE_ID }),
    ]);

    const error = await refusal(() => service.create(ACTOR, DOCUMENT_ID, createDto()));

    expect((error as HttpException).getResponse()).toEqual({
      code: RETURN_FAILURE.LINE_REFERENCE_MISMATCH,
      message: "Return line's receipt line does not belong to its purchase line",
    });
    expect(repository.appendReturn).not.toHaveBeenCalled();
  });

  it('an illegal command carries `invalid_transition`, naming the legal source and the state', async () => {
    const { service, repository } = build();
    const error = await refusal(() => service.receiveBack(ACTOR, DOCUMENT_ID, RETURN_ID));

    expect((error as HttpException).getResponse()).toEqual({
      code: RETURN_FAILURE.INVALID_TRANSITION,
      message: 'Only a return in APPROVED may be received back; this return is REQUESTED',
    });
    expect(repository.appendTransition).not.toHaveBeenCalled();
  });

  it('a failed Q compensation carries `refund_compensation_failed` with Q-owned words', async () => {
    const { service, repository, payments } = build();
    repository.findReturnDocument.mockResolvedValue(
      storedReturn({
        transitions: [
          transition('REQUESTED', T0),
          transition('APPROVED', T1, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
          transition('RECEIVED_BACK', T2, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
        ],
      })
    );
    payments.compensate.mockRejectedValue(
      new Error('The payment already has a compensating row: abc')
    );

    const error = await refusal(() =>
      service.refund(ACTOR, DOCUMENT_ID, RETURN_ID, { paymentId: PAYMENT_ID } as RefundReturnDto)
    );

    expect((error as HttpException).getResponse()).toEqual({
      code: RETURN_FAILURE.REFUND_COMPENSATION_FAILED,
      message: 'Refund compensation failed: The payment already has a compensating row: abc',
    });
    expect(repository.appendTransition).not.toHaveBeenCalled();
  });
});
