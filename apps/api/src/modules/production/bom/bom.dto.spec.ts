import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
} from '../production.constants';
import {
  BomTimelineQueryDto,
  CreateBomHeaderDto,
  DecideBomHeaderDto,
  ListBomHeadersQueryDto,
  MAX_PRODUCTION_COMMENTS_LENGTH,
  MAX_PRODUCTION_EXTERNAL_REF_LENGTH,
  MAX_PRODUCTION_TITLE_LENGTH,
  MAX_PRODUCTION_USER_ID_LENGTH,
  resolveProductionPageWindow,
  resolveProductionTimelineWindow,
  UpdateBomHeaderDto,
} from './bom.dto';
import { BOM_MANAGER_OPINIONS } from './bom-status';

/**
 * Phase PRODUCTION-BOM-HEADER: the wire contract of the BOM Header routes.
 *
 * THE FOUR RULES THESE SPECS EXIST FOR
 * -----------------------------------
 *  1. EVERY BOUND IS A COLUMN WIDTH. `title` is `VARCHAR(200)`, a reference is
 *     `VARCHAR(128)`, a platform user id is `VARCHAR(64)`. A request no column can store
 *     must be a 400 naming the field, not a driver error from Postgres.
 *  2. THERE IS NO `tenantId`, NO `status`, NO DECISION COLUMN AND NO `approverUserId` ON
 *     DECIDE. The tenant comes from the actor, the lifecycle from the routes, and the
 *     approver from the row's own frozen snapshot. `whitelist` +
 *     `forbidNonWhitelisted` mirror the global pipe, so a forbidden field is a 400 here
 *     exactly as it is in production rather than a silently dropped value.
 *  3. AN EXTERNAL REFERENCE IS BOUNDED, NEVER FORMAT-CHECKED. There is no authoritative
 *     contract for a Project or Product Tree id yet, so a UUID-shaped validator would
 *     reject a legitimate legacy id while proving nothing about tenancy.
 *  4. THE PAGE CEILING IS A CONTRACT AT THE EDGE AND A GUARANTEE IN THE SERVICE. An
 *     absurd `pageSize` is a 400 here; the service's `Math.min` bound is what an internal
 *     caller that builds its own query object cannot exceed.
 */

/** Runs the real global pipe behaviour: transform, then validate. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';

const VALID_CREATE = {
  title: 'BOM for project 42',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: REQUESTER,
  approverUserId: APPROVER,
};

describe('CreateBomHeaderDto', () => {
  it('accepts a complete payload and keeps the values it was given', async () => {
    const { instance, failed } = await check(CreateBomHeaderDto, VALID_CREATE);

    expect(failed).toEqual([]);
    expect(instance).toMatchObject(VALID_CREATE);
  });

  it('requires title, both references and both identities', async () => {
    for (const missing of Object.keys(VALID_CREATE)) {
      const payload: Record<string, unknown> = { ...VALID_CREATE };
      delete payload[missing];
      expect({ missing, failed: (await check(CreateBomHeaderDto, payload)).failed }).toEqual({
        missing,
        failed: [missing],
      });
    }
  });

  it('refuses an empty title and an empty identity, but tolerates empty comments', async () => {
    expect((await check(CreateBomHeaderDto, { ...VALID_CREATE, title: '' })).failed).toEqual([
      'title',
    ]);
    expect((await check(CreateBomHeaderDto, { ...VALID_CREATE, requesterUserId: '' })).failed).toEqual(
      ['requesterUserId']
    );
    expect((await check(CreateBomHeaderDto, { ...VALID_CREATE, approverUserId: '' })).failed).toEqual(
      ['approverUserId']
    );
    // `comments` is the one free-text field with no presence rule: a note nobody wrote is
    // an empty string, not a violation.
    expect((await check(CreateBomHeaderDto, { ...VALID_CREATE, comments: '' })).failed).toEqual([]);
  });

  it('bounds every field by the WIDTH OF ITS COLUMN', async () => {
    const over = (length: number) => 'x'.repeat(length + 1);
    const cases: Array<[string, string, number]> = [
      ['title', 'title', MAX_PRODUCTION_TITLE_LENGTH],
      ['projectRef', 'projectRef', MAX_PRODUCTION_EXTERNAL_REF_LENGTH],
      ['productTreeRef', 'productTreeRef', MAX_PRODUCTION_EXTERNAL_REF_LENGTH],
      ['requesterUserId', 'requesterUserId', MAX_PRODUCTION_USER_ID_LENGTH],
      ['approverUserId', 'approverUserId', MAX_PRODUCTION_USER_ID_LENGTH],
      ['comments', 'comments', MAX_PRODUCTION_COMMENTS_LENGTH],
    ];

    for (const [field, , width] of cases) {
      const payload = { ...VALID_CREATE, [field]: over(width) };
      expect({ field, failed: (await check(CreateBomHeaderDto, payload)).failed }).toEqual({
        field,
        failed: [field],
      });
      // The exact width is accepted: the bound is inclusive, so a value the column can
      // store is never refused.
      const atBound = { ...VALID_CREATE, [field]: 'x'.repeat(width) };
      expect({ field, failed: (await check(CreateBomHeaderDto, atBound)).failed }).toEqual({
        field,
        failed: [],
      });
    }
  });
});


describe('UpdateBomHeaderDto', () => {
  it('accepts an empty object — "change nothing yet" is a valid declaration', async () => {
    // The SERVICE refuses an empty patch with 400 because it would bump `updatedAt` and
    // audit a mutation that changed nothing. The DTO stays permissive so that refusal is
    // one place rather than two.
    expect((await check(UpdateBomHeaderDto, {})).failed).toEqual([]);
  });

  it('is header fields only: the requester is NOT editable, every other field is', async () => {
    const editable: Array<[string, unknown]> = [
      ['title', VALID_CREATE.title],
      ['projectRef', VALID_CREATE.projectRef],
      ['productTreeRef', VALID_CREATE.productTreeRef],
      ['approverUserId', VALID_CREATE.approverUserId],
      ['comments', 'a note'],
    ];
    for (const [field, value] of editable) {
      const { failed } = await check(UpdateBomHeaderDto, { [field]: value });
      expect({ field, failed }).toEqual({ field, failed: [] });
    }

    // WHO ASKED IS HISTORY, NOT CONFIGURATION. `requesterUserId` is written once, at
    // create, and is what the self-approval rule compares a new approver against — so a
    // PATCH that states it must be refused rather than silently dropped.
    const { failed } = await check(UpdateBomHeaderDto, { requesterUserId: REQUESTER });
    expect(failed).toEqual(['requesterUserId']);
  });

  it('refuses a blank title but accepts a blank comment', async () => {
    expect((await check(UpdateBomHeaderDto, { title: '' })).failed).toEqual(['title']);
    expect((await check(UpdateBomHeaderDto, { projectRef: '' })).failed).toEqual(['projectRef']);
    expect((await check(UpdateBomHeaderDto, { productTreeRef: '' })).failed).toEqual([
      'productTreeRef',
    ]);
    expect((await check(UpdateBomHeaderDto, { approverUserId: '' })).failed).toEqual([
      'approverUserId',
    ]);
    // Clearing a note is `null` or `''`, and neither is a violation.
    expect((await check(UpdateBomHeaderDto, { comments: '' })).failed).toEqual([]);
    expect((await check(UpdateBomHeaderDto, { comments: null })).failed).toEqual([]);
  });
});

describe('DecideBomHeaderDto', () => {
  it('accepts each of the three legacy outcomes, and nothing else', async () => {
    for (const opinion of BOM_MANAGER_OPINIONS) {
      const { instance, failed } = await check(DecideBomHeaderDto, { opinion });
      expect({ opinion, failed }).toEqual({ opinion, failed: [] });
      expect(instance.opinion).toBe(opinion);
    }

    // The legacy control could render only these three; a fourth string is a client
    // mistake the edge names rather than a decision the service has to interpret.
    expect((await check(DecideBomHeaderDto, { opinion: 'ABSTAIN' })).failed).toEqual(['opinion']);
    expect((await check(DecideBomHeaderDto, {})).failed).toEqual(['opinion']);
  });

  it('carries no approver, no status and no tenant', async () => {
    // THE POINT OF THE WHOLE DECISION CONTRACT: the approver is the row's frozen snapshot
    // and the outcome is fixed by the ROUTE, so none of these fields may be expressible.
    for (const forbidden of [
      'approverUserId',
      'status',
      'tenantId',
      'managerOpinion',
      'decidedByUserId',
    ]) {
      const { failed } = await check(DecideBomHeaderDto, { opinion: 'APPROVED', [forbidden]: 'x' });
      expect({ forbidden, failed }).toEqual({ forbidden, failed: [forbidden] });
    }
  });
});

describe('ListBomHeadersQueryDto and resolveProductionPageWindow', () => {
  it('accepts an empty query and filters by the closed status vocabulary only', async () => {
    expect((await check(ListBomHeadersQueryDto, {})).failed).toEqual([]);

    for (const status of ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']) {
      expect({ status, failed: (await check(ListBomHeadersQueryDto, { status })).failed }).toEqual({
        status,
        failed: [],
      });
    }
    // A status the domain does not have must not be expressible as a filter.
    expect((await check(ListBomHeadersQueryDto, { status: 'DRAFTY' })).failed).toEqual(['status']);
  });

  it('refuses a client-supplied tenant, which is the one field that must not exist', async () => {
    const { failed } = await check(ListBomHeadersQueryDto, { tenantId: 'tenant-b' });
    expect(failed).toEqual(['tenantId']);
  });

  it('bounds the search text by the column it matches', async () => {
    const tooLong = 'x'.repeat(MAX_PRODUCTION_TITLE_LENGTH + 1);
    expect((await check(ListBomHeadersQueryDto, { search: tooLong })).failed).toEqual(['search']);
  });

  it('defaults the window, clamps the ceiling, and never produces a negative skip', async () => {
    expect(resolveProductionPageWindow({})).toEqual({
      page: 1,
      pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: PRODUCTION_DEFAULT_PAGE_SIZE,
    });

    // Beyond the ceiling is clamped rather than refused: the DTO already refused it at
    // the edge, and this is the guarantee an internal caller cannot escape.
    expect(resolveProductionPageWindow({ page: 3, pageSize: 5000 })).toEqual({
      page: 3,
      pageSize: PRODUCTION_MAX_PAGE_SIZE,
      skip: (3 - 1) * PRODUCTION_MAX_PAGE_SIZE,
      take: PRODUCTION_MAX_PAGE_SIZE,
    });

    // Zero, a negative page and a negative size all resolve to the first legal window —
    // a skip of `-20` would be a database error rather than a page.
    expect(resolveProductionPageWindow({ page: 0, pageSize: 0 })).toEqual({
      page: 1,
      pageSize: 1,
      skip: 0,
      take: 1,
    });
    expect(resolveProductionPageWindow({ page: -5, pageSize: -5 }).skip).toBe(0);
  });
});

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the timeline query's wire contract.
 *
 * WHAT THESE SPECS PIN: the timeline accepts ONLY a page window — the three scope inputs
 * (`tenantId`, `resource`, `resourceId`) are bound server-side and must be REFUSED as
 * query parameters rather than silently ignored, because a client that could set
 * `resource` would be choosing what the trail query means.
 */
describe('BomTimelineQueryDto and resolveProductionTimelineWindow', () => {
  const check = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(BomTimelineQueryDto, payload);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return { failed: errors.map((error) => error.property).sort() };
  };

  it('accepts an empty query and a legal window', async () => {
    expect((await check({})).failed).toEqual([]);
    expect((await check({ page: 2, pageSize: 50 })).failed).toEqual([]);
  });

  it('refuses the three scope inputs, which must never be request fields', async () => {
    // Each of these, if accepted, would let a caller choose the trail's scope — the exact
    // thing the platform read contract refuses to expose.
    expect((await check({ tenantId: 'tenant-b' })).failed).toEqual(['tenantId']);
    expect((await check({ resource: 'commerce.purchase_document' })).failed).toEqual([
      'resource',
    ]);
    expect((await check({ resourceId: 'x' })).failed).toEqual(['resourceId']);
    // An action filter is deliberately absent too: the route returns the whole BOM family.
    expect((await check({ action: 'approve' })).failed).toEqual(['action']);
  });

  it('refuses a page or size outside the contract at the edge', async () => {
    expect((await check({ page: 0 })).failed).toEqual(['page']);
    expect((await check({ pageSize: 0 })).failed).toEqual(['pageSize']);
    expect((await check({ pageSize: PRODUCTION_MAX_PAGE_SIZE + 1 })).failed).toEqual([
      'pageSize',
    ]);
  });

  it('defaults to the module pair and clamps rather than rejecting', async () => {
    expect(resolveProductionTimelineWindow({})).toEqual({
      page: 1,
      pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
    });
    // The GUARANTEE half, for an internal caller that bypassed the DTO.
    expect(resolveProductionTimelineWindow({ page: 2, pageSize: 9999 })).toEqual({
      page: 2,
      pageSize: PRODUCTION_MAX_PAGE_SIZE,
    });
    // Below the floor clamps UP — never a non-positive page or a `pageSize: 0` the
    // platform would reject as `AUDIT_READ_PAGE_INVALID`.
    expect(resolveProductionTimelineWindow({ page: 0, pageSize: 0 })).toEqual({
      page: 1,
      pageSize: 1,
    });
  });
});
