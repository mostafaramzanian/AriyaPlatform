import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AllocateCheckRequestDto,
  CheckRequestTimelineQueryDto,
  ConfirmCheckDeliveryDto,
  ConfirmCheckIssueDto,
  CreateCheckRequestDto,
  DecideCheckRequestDto,
  DecideDocumentReviewDto,
  DecideExecutiveApprovalDto,
  ListCheckRequestsQueryDto,
  MAX_FINANCIAL_EXTERNAL_REF_LENGTH,
  MAX_FINANCIAL_MANAGER_COMMENT_LENGTH,
  MAX_FINANCIAL_USER_ID_LENGTH,
  UpdateCheckAttachmentDto,
  UpdateCheckRequestDto,
} from './check-request.dto';
import { CHECK_REQUEST_STATUSES } from './check-request-status';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the wire contract's own boundary statements.
 *
 * The helper runs class-validator with the EXACT options the global `ValidationPipe`
 * uses (`whitelist` + `forbidNonWhitelisted` + `forbidUnknownValues`), so a forbidden
 * field is refused here exactly as it is in production rather than silently dropped —
 * the pattern `bom-change.dto.spec.ts` and `return.dto.spec.ts` established.
 *
 * WHAT IS PINNED
 * --------------
 *  1. EVERY field the brief's §17 forbids is refused on EVERY payload, naming the field:
 *     `tenantId`, `requesterUserId`, `status`, `nextState`, the manager decision fields,
 *     the audit actor, `requestDate`, `title`, `id`, `createdAt`, `updatedAt` — and the
 *     cheque-instrument names the brief forbids inventing (they must be refused because
 *     they are not fields at all).
 *  2. `checkIssueType` is REQUIRED, and outside the closed three values is refused.
 *  3. Column widths are mirrored: a value past the column is a 400 naming the field.
 *  4. The DECISION DTO carries only an optional comment — no `decision` / `opinion`
 *     field can rewrite the meaning of a route.
 *  5. The register query accepts exactly the statuses the process defines and a bounded
 *     page size (Phase CHECK-ISSUATION: the set is {0..8, 50}, derived from the constant
 *     so the test can never lag the closed set).
 */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return { instance, failed: errors.map((error) => error.property) };
}

/** The §17 forbidden list plus the cheque-instrument names the brief forbids inventing. */
const FORBIDDEN_FIELDS = [
  'id',
  'tenantId',
  'requesterUserId',
  'status',
  'nextState',
  'StateNext',
  'managerDecision',
  'managerComment',
  'decidedAt',
  'decidedByUserId',
  'submittedAt',
  'requestDate',
  'title',
  'createdAt',
  'updatedAt',
  'actorId',
  'auditActor',
  'chequeNumber',
  'serialNumber',
  'bankAccount',
  'bank',
  'iban',
  'sayadId',
  'dueDate',
  'signatory',
  'issuedAt',
  'deliveredAt',
];

const VALID_CREATE = { checkIssueType: 'PURCHASE' };

describe('Phase F1 — CreateCheckRequestDto', () => {
  it('accepts a purchase type and the optional references with only the required field', async () => {
    const { instance, failed } = await check(CreateCheckRequestDto, {
      ...VALID_CREATE,
      purchaseType: 'NON_PROJECT',
      orderReference: 'ORDER-1',
      requesterOpinion: 'CONTINUE',
    });
    expect(failed).toEqual([]);
    expect(instance.checkIssueType).toBe('PURCHASE');
    expect(instance.purchaseType).toBe('NON_PROJECT');
  });

  it('requires checkIssueType (V1) and refuses a value outside the closed set', async () => {
    expect((await check(CreateCheckRequestDto, {})).failed).toContain('checkIssueType');
    expect((await check(CreateCheckRequestDto, { checkIssueType: 'CHEQUE' })).failed).toContain(
      'checkIssueType'
    );
  });

  it('refuses a purchase type or opinion outside the source vocabularies', async () => {
    expect(
      (await check(CreateCheckRequestDto, { ...VALID_CREATE, purchaseType: 'PROJECTED' })).failed
    ).toContain('purchaseType');
    expect(
      (await check(CreateCheckRequestDto, { ...VALID_CREATE, requesterOpinion: 'MAYBE' })).failed
    ).toContain('requesterOpinion');
  });

  it('bounds the opaque references and the manager id by their columns', async () => {
    expect(
      (
        await check(CreateCheckRequestDto, {
          ...VALID_CREATE,
          orderReference: 'x'.repeat(MAX_FINANCIAL_EXTERNAL_REF_LENGTH),
          projectReference: 'x'.repeat(MAX_FINANCIAL_EXTERNAL_REF_LENGTH),
          projectManagerUserId: 'u'.repeat(MAX_FINANCIAL_USER_ID_LENGTH),
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(CreateCheckRequestDto, {
          ...VALID_CREATE,
          orderReference: 'x'.repeat(MAX_FINANCIAL_EXTERNAL_REF_LENGTH + 1),
        })
      ).failed
    ).toContain('orderReference');
    expect(
      (
        await check(CreateCheckRequestDto, {
          ...VALID_CREATE,
          projectManagerUserId: 'u'.repeat(MAX_FINANCIAL_USER_ID_LENGTH + 1),
        })
      ).failed
    ).toContain('projectManagerUserId');
    expect(
      (await check(CreateCheckRequestDto, { ...VALID_CREATE, projectManagerUserId: '' })).failed
    ).toContain('projectManagerUserId');
  });

  it('refuses EVERY forbidden field, naming it', async () => {
    for (const field of FORBIDDEN_FIELDS) {
      const { failed } = await check(CreateCheckRequestDto, {
        ...VALID_CREATE,
        [field]: 'forged',
      });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase F1 — UpdateCheckRequestDto', () => {
  it('accepts a partial patch of every writable field', async () => {
    const { failed } = await check(UpdateCheckRequestDto, {
      checkIssueType: 'SALARY',
      requesterOpinion: 'CANCEL',
    });
    expect(failed).toEqual([]);
  });

  it('refuses EVERY forbidden field on the patch too', async () => {
    expect(FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(25); // non-vacuity: the §17 list
    for (const field of FORBIDDEN_FIELDS) {
      const { failed } = await check(UpdateCheckRequestDto, { [field]: 'forged' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase F1 — DecideCheckRequestDto', () => {
  it('accepts an EMPTY body (the comment is optional — the source never enforced one)', async () => {
    expect((await check(DecideCheckRequestDto, {})).failed).toEqual([]);
    expect((await check(DecideCheckRequestDto, { comment: 'ok' })).failed).toEqual([]);
  });

  it('carries NO decision field — the route states the decision', async () => {
    for (const field of ['decision', 'opinion', 'managerDecision']) {
      const { failed } = await check(DecideCheckRequestDto, { [field]: 'APPROVE' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });

  it('bounds the comment by its column', async () => {
    expect(
      (
        await check(DecideCheckRequestDto, {
          comment: 'x'.repeat(MAX_FINANCIAL_MANAGER_COMMENT_LENGTH),
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(DecideCheckRequestDto, {
          comment: 'x'.repeat(MAX_FINANCIAL_MANAGER_COMMENT_LENGTH + 1),
        })
      ).failed
    ).toContain('comment');
  });
});

describe('Phase F1 — ListCheckRequestsQueryDto and the timeline query', () => {
  it('accepts exactly the statuses the process defines — and nothing outside them', async () => {
    for (const status of CHECK_REQUEST_STATUSES) {
      expect((await check(ListCheckRequestsQueryDto, { status })).failed).toEqual([]);
    }
    // 9 is a real gap (no member between 8 and 50); 100 and -1 are outside anything the
    // process could ever hold. The check is set-equality with the CLOSED SET, so a future
    // member fails here until this test is deliberately updated alongside it.
    for (const status of [9, 100, -1]) {
      expect({
        status,
        rejected: (await check(ListCheckRequestsQueryDto, { status })).failed.includes('status'),
      }).toEqual({ status, rejected: true });
    }
  });

  it('bounds pageSize and refuses unknown filters (a resource pivot is not a field)', async () => {
    expect((await check(ListCheckRequestsQueryDto, { pageSize: 100 })).failed).toEqual([]);
    expect((await check(ListCheckRequestsQueryDto, { pageSize: 101 })).failed).toContain(
      'pageSize'
    );
    expect((await check(ListCheckRequestsQueryDto, { resource: 'x' })).failed).toContain(
      'resource'
    );
  });

  it('keeps the timeline query to page/pageSize — no scope field exists', async () => {
    expect((await check(CheckRequestTimelineQueryDto, { page: 1, pageSize: 20 })).failed).toEqual(
      []
    );
    for (const field of ['resource', 'resourceId', 'tenantId', 'action']) {
      const { failed } = await check(CheckRequestTimelineQueryDto, { [field]: 'x' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });
});

describe('Phase F1 — UpdateCheckAttachmentDto', () => {
  it('accepts metadata fields only — no file, no key, no owner', async () => {
    expect(
      (await check(UpdateCheckAttachmentDto, { documentType: 'GARARDAD', description: 'x' })).failed
    ).toEqual([]);
    for (const field of ['storageKey', 'fileName', 'mimeType', 'size', 'createdBy', 'tenantId']) {
      const { failed } = await check(UpdateCheckAttachmentDto, { [field]: 'forged' });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });

  it('refuses an unknown document type', async () => {
    expect(
      (await check(UpdateCheckAttachmentDto, { documentType: 'CHECK_IMAGE' })).failed
    ).toContain('documentType');
  });
});

describe('Phase CHECK-ISSUATION — the stage DTOs', () => {
  it('AllocateCheckRequestDto: accepts the six source fields and refuses everything server-owned', async () => {
    expect(
      (
        await check(AllocateCheckRequestDto, {
          allocationPlace: 'بانک ملت',
          balance: '5000',
          checkDate: '2026-10-10',
          checkDescription: 'شرح',
          checkAmount: '4000',
          payableTo: 'آقای X',
        })
      ).failed
    ).toEqual([]);

    // A valid payload WITHOUT the two optional money/date fields is still valid —
    // the source required only محل تخصیص and مبلغ چک.
    expect(
      (await check(AllocateCheckRequestDto, { allocationPlace: 'x', checkAmount: '1' })).failed
    ).toEqual([]);

    for (const field of ['status', 'takhsis', 'tenantId', 'recordedByUserId']) {
      const { failed } = await check(AllocateCheckRequestDto, {
        allocationPlace: 'x',
        checkAmount: '1',
        [field]: 'forged',
      });
      expect({ field, rejected: failed.includes(field) }).toEqual({ field, rejected: true });
    }
  });

  it('AllocateCheckRequestDto: bounds the ریال columns and the ISO date shape', async () => {
    // 18 digits is the column; 19 is not.
    expect(
      (
        await check(AllocateCheckRequestDto, {
          allocationPlace: 'x',
          checkAmount: '9'.repeat(18),
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(AllocateCheckRequestDto, {
          allocationPlace: 'x',
          checkAmount: '9'.repeat(19),
        })
      ).failed
    ).toContain('checkAmount');

    for (const bad of ['1.5', '-1', '1,000', 'abc', '']) {
      const { failed } = await check(AllocateCheckRequestDto, {
        allocationPlace: 'x',
        checkAmount: bad,
      });
      expect({ bad, rejected: failed.includes('checkAmount') }).toEqual({ bad, rejected: true });
    }
    expect(
      (
        await check(AllocateCheckRequestDto, {
          allocationPlace: 'x',
          checkAmount: '1',
          checkDate: '10/10/2026',
        })
      ).failed
    ).toContain('checkDate');
  });

  it('DecideDocumentReviewDto: exactly تایید/اصلاح — no reject, no extra fields', async () => {
    for (const decision of ['APPROVE', 'CORRECTION']) {
      expect((await check(DecideDocumentReviewDto, { decision })).failed).toEqual([]);
    }
    expect((await check(DecideDocumentReviewDto, { decision: 'REJECT' })).failed).toContain(
      'decision'
    );
    expect(
      (await check(DecideDocumentReviewDto, { decision: 'APPROVE', opinion: 'x' })).failed
    ).toContain('opinion');
  });

  it('DecideExecutiveApprovalDto: exactly تایید/رد — the contested third value is UNREPRESENTABLE', async () => {
    for (const decision of ['APPROVE', 'REJECT']) {
      expect((await check(DecideExecutiveApprovalDto, { decision })).failed).toEqual([]);
    }
    // «نیازمند اصلاح» has no enum member (DEFERRED / SOURCE-CONFLICT): no body can
    // express the guessed branch, under either spelling a client might try.
    for (const decision of ['NEEDS_CORRECTION', 'REQUEST_CORRECTION', 'CORRECTION']) {
      expect({ decision, rejected: (await check(DecideExecutiveApprovalDto, { decision })).failed.includes('decision') }).toEqual({
        decision,
        rejected: true,
      });
    }
  });

  it('Confirm DTOs: a real boolean required, a string that looks like one refused', async () => {
    expect((await check(ConfirmCheckIssueDto, { confirmed: true })).failed).toEqual([]);
    expect((await check(ConfirmCheckIssueDto, { confirmed: 'true' })).failed).toContain(
      'confirmed'
    );
    expect((await check(ConfirmCheckIssueDto, {})).failed).toContain('confirmed');

    expect((await check(ConfirmCheckDeliveryDto, { completed: true })).failed).toEqual([]);
    expect((await check(ConfirmCheckDeliveryDto, { completed: 1 })).failed).toContain('completed');
  });
});
