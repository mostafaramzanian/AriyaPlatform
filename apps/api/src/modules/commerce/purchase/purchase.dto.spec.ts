import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { COMMERCE_DEFAULT_PAGE_SIZE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import {
  CreatePurchaseDocumentDto,
  ListPurchaseDocumentsQueryDto,
  MAX_PURCHASE_LINES,
  MAX_PURCHASE_TECHNICAL_DESCRIPTION_LENGTH,
  MAX_PURCHASE_UNIT_LENGTH,
  PURCHASE_LINE_MAX_DECIMAL_PLACES,
  PurchaseLineInputDto,
  PurchaseTimelineQueryDto,
  UpdatePurchaseDocumentDto,
} from './purchase.dto';
import { PURCHASE_MAX_MONEY_AMOUNT } from './purchase-money';
import { PURCHASE_DOCUMENT_KINDS } from './purchase-status';

/**
 * Phase C1 Step L (§8): the wire contract of the purchase routes.
 *
 * THE FOUR RULES THESE SPECS EXIST FOR
 * -----------------------------------
 *  1. EVERY BOUND IS A COLUMN WIDTH. `unit` is `VARCHAR(32)`, a total is
 *     `DECIMAL(18,4)`, and a line count has a ceiling. A request that no column can
 *     store must be a 400 naming the field, not a driver error from Postgres.
 *  2. `undefined` AND `null` IN A PATCH MEAN DIFFERENT THINGS. `undefined` is "not part
 *     of this edit"; `null` is "clear it". A DTO that collapsed the two would erase a
 *     supplier on every unrelated edit.
 *  3. NOT PRICED IS NOT ZERO. Omitting `unitPrice`/`tax` must stay distinguishable from
 *     sending `0`, because §5.1 says NULL = "not stated yet" and zero says "free".
 *  4. NO TENANT, NO AUDIT, NO STATUS, NO NUMBER. The tenant comes from the actor, the
 *     trail from the service and the number from the database; a field for any of them
 *     would be a client deciding something it does not own.
 *
 * `whitelist` + `forbidNonWhitelisted` mirror the global pipe, so a forbidden field is a
 * 400 here exactly as it is in production rather than a silently dropped value.
 */

/** Runs the real global pipe behaviour: transform, then validate. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const REQUESTER_ID = '11111111-1111-4111-8111-111111111111';

const STANDARD_LINE = {
  lineType: 'STANDARD',
  quantity: 2,
  unit: 'kg',
  unitPrice: 12.5,
  tax: 1.25,
};

describe('Phase C1 Step L — PurchaseLineInputDto', () => {
  it('accepts one line of each of §5.2’s three types', async () => {
    for (const lineType of ['STANDARD', 'NON_STANDARD', 'SERVICE']) {
      const { failed } = await check(PurchaseLineInputDto, { ...STANDARD_LINE, lineType });
      expect({ lineType, failed }).toEqual({ lineType, failed: [] });
    }
  });

  it('refuses a line type outside the closed vocabulary', async () => {
    // EXPENSE is the specification's own refusal: §5.2 names it as what the vocabulary
    // does NOT contain, so a client sending it learns that at the edge.
    const { failed } = await check(PurchaseLineInputDto, {
      ...STANDARD_LINE,
      lineType: 'EXPENSE',
    });

    expect(failed).toEqual(['lineType']);
  });

  it('requires a POSITIVE quantity and refuses zero or a negative one', async () => {
    expect((await check(PurchaseLineInputDto, { ...STANDARD_LINE, quantity: 0 })).failed).toEqual([
      'quantity',
    ]);
    expect((await check(PurchaseLineInputDto, { ...STANDARD_LINE, quantity: -1 })).failed).toEqual([
      'quantity',
    ]);
    expect(
      (await check(PurchaseLineInputDto, { ...STANDARD_LINE, quantity: 0.0001 })).failed
    ).toEqual([]);
  });

  it('keeps "not priced" distinguishable from zero rather than collapsing the two', async () => {
    const unpriced = await check(PurchaseLineInputDto, { lineType: 'STANDARD', quantity: 1 });
    const free = await check(PurchaseLineInputDto, {
      lineType: 'STANDARD',
      quantity: 1,
      unitPrice: 0,
      tax: 0,
    });

    // Both are legal, and they mean different things: the first has NO unitPrice key at
    // all (the service stores NULL), the second has zeroes (the service stores 0.0000).
    expect(unpriced.failed).toEqual([]);
    expect(unpriced.instance.unitPrice).toBeUndefined();
    expect(free.instance).toMatchObject({ unitPrice: 0, tax: 0 });
  });

  it('enforces the column widths and the storage scale at the boundary', async () => {
    const longUnit = 'u'.repeat(MAX_PURCHASE_UNIT_LENGTH + 1);
    expect(
      (await check(PurchaseLineInputDto, { ...STANDARD_LINE, unit: longUnit })).failed
    ).toEqual(['unit']);
    expect(
      (
        await check(PurchaseLineInputDto, {
          ...STANDARD_LINE,
          unit: 'u'.repeat(MAX_PURCHASE_UNIT_LENGTH),
        })
      ).failed
    ).toEqual([]);

    // A fifth decimal is not storable, so it is a 400 rather than a rounded number the
    // caller never sent.
    const tooPrecise = 1 + 10 ** -(PURCHASE_LINE_MAX_DECIMAL_PLACES + 1);
    expect(
      (await check(PurchaseLineInputDto, { ...STANDARD_LINE, unitPrice: tooPrecise })).failed
    ).toEqual(['unitPrice']);
    expect(
      (
        await check(PurchaseLineInputDto, {
          ...STANDARD_LINE,
          unitPrice: PURCHASE_MAX_MONEY_AMOUNT,
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(PurchaseLineInputDto, {
          ...STANDARD_LINE,
          unitPrice: PURCHASE_MAX_MONEY_AMOUNT + 1,
        })
      ).failed
    ).toEqual(['unitPrice']);
  });

  it('refuses a line NUMBER, because position is the service’s to assign', async () => {
    // A client that could state `lineNumber` could claim position 3 twice, or leave a gap
    // the schema's unique-per-document rule would reject at the database.
    expect((await check(PurchaseLineInputDto, { ...STANDARD_LINE, lineNumber: 3 })).failed).toEqual(
      ['lineNumber']
    );
  });

  it('carries the technical description §5.4 asks for, at the column’s width', async () => {
    const atMax = 'd'.repeat(MAX_PURCHASE_TECHNICAL_DESCRIPTION_LENGTH);
    expect(
      (await check(PurchaseLineInputDto, { ...STANDARD_LINE, technicalDescription: atMax })).failed
    ).toEqual([]);
    expect(
      (await check(PurchaseLineInputDto, { ...STANDARD_LINE, technicalDescription: `${atMax}d` }))
        .failed
    ).toEqual(['technicalDescription']);
  });
});

describe('Phase C1 Step L — CreatePurchaseDocumentDto', () => {
  it('accepts a request with one line and no supplier, currency or price', async () => {
    const { instance, failed } = await check(CreatePurchaseDocumentDto, {
      requesterId: REQUESTER_ID,
      lines: [{ lineType: 'STANDARD', quantity: 1 }],
    });

    expect(failed).toEqual([]);
    expect(instance.supplierId).toBeUndefined();
    expect(instance.currency).toBeUndefined();
  });

  it('requires at least one line, because a document with none is not a draft', async () => {
    expect(
      (await check(CreatePurchaseDocumentDto, { requesterId: REQUESTER_ID, lines: [] })).failed
    ).toEqual(['lines']);
    expect((await check(CreatePurchaseDocumentDto, { requesterId: REQUESTER_ID })).failed).toEqual([
      'lines',
    ]);
  });

  it('bounds the line count at the declared maximum', async () => {
    const line = { lineType: 'STANDARD', quantity: 1 };
    const atMax = await check(CreatePurchaseDocumentDto, {
      requesterId: REQUESTER_ID,
      lines: Array.from({ length: MAX_PURCHASE_LINES }, () => line),
    });
    const overMax = await check(CreatePurchaseDocumentDto, {
      requesterId: REQUESTER_ID,
      lines: Array.from({ length: MAX_PURCHASE_LINES + 1 }, () => line),
    });

    expect(atMax.failed).toEqual([]);
    expect(overMax.failed).toEqual(['lines']);
  });

  /**
   * PHASE GAP-8 (FORK A): THE REQUESTER IS AN OPAQUE PLATFORM ID, NEVER A UUID SHAPE.
   *
   * The platform's contract for a User id is `@IsString() @MaxLength(64)` — `User.id`
   * is TEXT, UUID v4 is only the mint DEFAULT for rows Core creates, and the seeded
   * administrator is literally `super-admin-user`. A v4 check here refused a real
   * tenant member at the pipe, before `assertMember` could ever answer for it.
   *
   * The tenant boundary is untouched: whatever passes here is still verified as a
   * member of the ACTING tenant by `CommerceIdentityGateway.assertMember` before the
   * row is written. The DTO decides SHAPE; the gateway decides MEMBERSHIP.
   */
  it('accepts the seeded opaque admin id, a bare string and a UUID as one opaque shape', async () => {
    for (const requesterId of ['super-admin-user', 'me', REQUESTER_ID]) {
      const { failed } = await check(CreatePurchaseDocumentDto, {
        requesterId,
        lines: [STANDARD_LINE],
      });
      expect({ requesterId, failed }).toEqual({ requesterId, failed: [] });
    }
  });

  it('refuses an empty requester — a document must name WHO it is for', async () => {
    expect(
      (await check(CreatePurchaseDocumentDto, { requesterId: '', lines: [STANDARD_LINE] })).failed
    ).toEqual(['requesterId']);
  });

  it('refuses an identity over the platform’s 64-character bound', async () => {
    expect(
      (
        await check(CreatePurchaseDocumentDto, {
          requesterId: 'i'.repeat(64),
          lines: [STANDARD_LINE],
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(CreatePurchaseDocumentDto, {
          requesterId: 'i'.repeat(65),
          lines: [STANDARD_LINE],
        })
      ).failed
    ).toEqual(['requesterId']);
  });

  it('refuses a non-string requester — no number, object or array is an identity', async () => {
    for (const requesterId of [123, { id: 'x' }, ['x'], true]) {
      const { failed } = await check(CreatePurchaseDocumentDto, {
        requesterId,
        lines: [STANDARD_LINE],
      });
      expect({ requesterId, failed }).toEqual({ requesterId, failed: ['requesterId'] });
    }
  });

  it('accepts a three-letter ISO code and refuses anything else', async () => {
    const base = { requesterId: REQUESTER_ID, lines: [STANDARD_LINE] };

    expect((await check(CreatePurchaseDocumentDto, { ...base, currency: 'IRR' })).failed).toEqual(
      []
    );
    expect((await check(CreatePurchaseDocumentDto, { ...base, currency: 'irr' })).failed).toEqual([
      'currency',
    ]);
    expect((await check(CreatePurchaseDocumentDto, { ...base, currency: 'RIAL' })).failed).toEqual([
      'currency',
    ]);
  });

  it('refuses tenantId, status, documentNumber and kind — none of them is the client’s to state', async () => {
    const base = { requesterId: REQUESTER_ID, lines: [STANDARD_LINE] };

    // The tenant comes from `resolveCommerceActor`; the status from the schema default;
    // the number from the database's counter; the kind from the closed vocabulary. Each
    // is a separate failure so the 400 names the field a client actually sent.
    expect((await check(CreatePurchaseDocumentDto, { ...base, tenantId: 't-1' })).failed).toEqual([
      'tenantId',
    ]);
    expect(
      (await check(CreatePurchaseDocumentDto, { ...base, status: 'APPROVED' })).failed
    ).toEqual(['status']);
    expect(
      (await check(CreatePurchaseDocumentDto, { ...base, documentNumber: 'PR-1405-00001' })).failed
    ).toEqual(['documentNumber']);
    // `kind` is refused even for a member of the vocabulary: it is the numbering KEY, and
    // step L mints exactly one series (the DTO's header records this).
    expect(
      (await check(CreatePurchaseDocumentDto, { ...base, kind: PURCHASE_DOCUMENT_KINDS[0] })).failed
    ).toEqual(['kind']);
  });
});

describe('Phase C1 Step L — UpdatePurchaseDocumentDto', () => {
  it('accepts an empty body, because "no change" is a legal (if pointless) statement', async () => {
    const { instance, failed } = await check(UpdatePurchaseDocumentDto, {});

    expect(failed).toEqual([]);
    // `undefined` everywhere means the service touches nothing: an empty PATCH is a no-op
    // edit, never a wholesale clear.
    expect(instance.supplierId).toBeUndefined();
    expect(instance.lines).toBeUndefined();
  });

  it('keeps undefined (not stated) and null (cleared) apart on every nullable field', async () => {
    const cleared = await check(UpdatePurchaseDocumentDto, { supplierId: null, currency: null });

    expect(cleared.failed).toEqual([]);
    expect(cleared.instance.supplierId).toBeNull();
    expect(cleared.instance.currency).toBeNull();
  });

  it('replaces lines wholesale only when lines are stated, under the same bounds as create', async () => {
    expect((await check(UpdatePurchaseDocumentDto, { lines: [] })).failed).toEqual(['lines']);
    expect(
      (
        await check(UpdatePurchaseDocumentDto, {
          lines: Array.from({ length: MAX_PURCHASE_LINES + 1 }, () => STANDARD_LINE),
        })
      ).failed
    ).toEqual(['lines']);
    expect((await check(UpdatePurchaseDocumentDto, { lines: [STANDARD_LINE] })).failed).toEqual([]);
  });

  it('refuses a status change on this route, because nothing here decides a decision', async () => {
    expect((await check(UpdatePurchaseDocumentDto, { status: 'APPROVED' })).failed).toEqual([
      'status',
    ]);
  });

  /**
   * GAP-8 (FORK A): the edit route's requester follows the SAME opaque contract as
   * create — a platform id, 1..64 chars, never a UUID shape — and `null` still means
   * "clear", never "invalid".
   */
  it('accepts an opaque requester on edit, and refuses empty / over-long / non-string', async () => {
    expect((await check(UpdatePurchaseDocumentDto, { requesterId: 'super-admin-user' })).failed).toEqual(
      []
    );
    expect((await check(UpdatePurchaseDocumentDto, { requesterId: '' })).failed).toEqual([
      'requesterId',
    ]);
    expect(
      (await check(UpdatePurchaseDocumentDto, { requesterId: 'i'.repeat(65) })).failed
    ).toEqual(['requesterId']);
    expect((await check(UpdatePurchaseDocumentDto, { requesterId: 42 })).failed).toEqual([
      'requesterId',
    ]);
  });
});

describe('Phase C1 Step L — ListPurchaseDocumentsQueryDto', () => {
  it('inherits the bounded page window rather than re-deriving one', async () => {
    const { instance, failed } = await check(ListPurchaseDocumentsQueryDto, {
      page: '2',
      pageSize: '50',
      status: 'DRAFT',
      requesterId: REQUESTER_ID,
      search: 'PR-1405',
    });

    expect(failed).toEqual([]);
    expect(resolveCommercePageWindow(instance)).toEqual({
      page: 2,
      pageSize: 50,
      skip: 50,
      take: 50,
    });
  });

  it('defaults to the module’s declared page size, not to an unbounded read', async () => {
    const { instance } = await check(ListPurchaseDocumentsQueryDto, {});

    expect(resolveCommercePageWindow(instance)).toEqual({
      page: 1,
      pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: COMMERCE_DEFAULT_PAGE_SIZE,
    });
  });

  it('is bounded TWICE: a 400 at the edge and a clamp for a caller that skipped the edge', async () => {
    expect(
      (await check(ListPurchaseDocumentsQueryDto, { pageSize: COMMERCE_MAX_PAGE_SIZE + 1 })).failed
    ).toEqual(['pageSize']);

    // The service clamps as well, because an internal caller can build this object itself.
    expect(resolveCommercePageWindow({ pageSize: 100000 }).pageSize).toBe(COMMERCE_MAX_PAGE_SIZE);
  });

  it('filters by a status from the closed vocabulary only', async () => {
    expect((await check(ListPurchaseDocumentsQueryDto, { status: 'SUBMITTED' })).failed).toEqual(
      []
    );
    expect((await check(ListPurchaseDocumentsQueryDto, { status: 'PENDING' })).failed).toEqual([
      'status',
    ]);
  });

  it('refuses a client-supplied tenantId in the query string', async () => {
    expect((await check(ListPurchaseDocumentsQueryDto, { tenantId: 't-1' })).failed).toEqual([
      'tenantId',
    ]);
  });

  it('has no `mine` flag: the requester filter is an id the service can verify', async () => {
    // A flag would make the identity implicit in the session and unverifiable in a log.
    expect((await check(ListPurchaseDocumentsQueryDto, { mine: true })).failed).toEqual(['mine']);
  });

  /**
   * GAP-8 (FORK A): the "my requests" filter names a platform user — opaque, bounded
   * at 64, refused when empty or non-string. A UUID-shaped value is just another
   * opaque id here, never the required shape.
   */
  it('filters by an opaque requester id, and refuses empty / over-long / non-string', async () => {
    expect(
      (await check(ListPurchaseDocumentsQueryDto, { requesterId: 'super-admin-user' })).failed
    ).toEqual([]);
    expect((await check(ListPurchaseDocumentsQueryDto, { requesterId: '' })).failed).toEqual([
      'requesterId',
    ]);
    expect(
      (await check(ListPurchaseDocumentsQueryDto, { requesterId: 'i'.repeat(65) })).failed
    ).toEqual(['requesterId']);
    expect((await check(ListPurchaseDocumentsQueryDto, { requesterId: 7 })).failed).toEqual([
      'requesterId',
    ]);
  });

/**
 * PHASE C7 (GAP-7): the timeline query — two pagination bounds and NOTHING else.
 *
 * The negative cases are the point of this block: the audit query's scope
 * (`tenantId`, `resource`, `resourceId`) must be inexpressible on the wire, and the
 * bounds must fail at the edge rather than reaching the platform as a rejected read.
 */
describe('Phase C7 — PurchaseTimelineQueryDto', () => {
  it('accepts an empty query: the platform defaults answer', async () => {
    expect((await check(PurchaseTimelineQueryDto, {})).failed).toEqual([]);
  });

  it('accepts page/pageSize within the shared Commerce bounds', async () => {
    expect(
      (await check(PurchaseTimelineQueryDto, { page: 3, pageSize: COMMERCE_MAX_PAGE_SIZE }))
        .failed
    ).toEqual([]);
  });

  it('refuses pagination outside the bounds: zero, negative, over the ceiling, non-integer', async () => {
    expect((await check(PurchaseTimelineQueryDto, { page: 0 })).failed).toEqual(['page']);
    expect((await check(PurchaseTimelineQueryDto, { page: -1 })).failed).toEqual(['page']);
    expect((await check(PurchaseTimelineQueryDto, { page: 1.5 })).failed).toEqual(['page']);
    expect((await check(PurchaseTimelineQueryDto, { pageSize: 0 })).failed).toEqual(['pageSize']);
    expect(
      (await check(PurchaseTimelineQueryDto, { pageSize: COMMERCE_MAX_PAGE_SIZE + 1 })).failed
    ).toEqual(['pageSize']);
  });

  it('refuses every scope parameter a client could try to state', async () => {
    // The route binds `:id`; the service binds tenant, resource and resourceId. None of
    // them is a wire concept, so each attempt is a refused field — never a retargeted
    // audit query and never a silently ignored parameter.
    for (const scope of [
      { tenantId: 't-evil' },
      { resource: 'commerce.receipt' },
      { resourceId: 'someone-elses-document' },
      { action: 'create' },
      { from: '2026-01-01T00:00:00.000Z' },
    ]) {
      const { failed } = await check(PurchaseTimelineQueryDto, scope);
      expect(failed).toEqual(Object.keys(scope));
    }
  });

  it('has no `search`: a timeline is bounded to one document, not searchable text', async () => {
    expect((await check(PurchaseTimelineQueryDto, { search: 'x' })).failed).toEqual(['search']);
  });
});

});
