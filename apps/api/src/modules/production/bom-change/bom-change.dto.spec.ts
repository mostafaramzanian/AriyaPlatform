import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PRODUCTION_DEFAULT_PAGE_SIZE, PRODUCTION_MAX_PAGE_SIZE } from '../production.constants';
import {
  AddBomChangeRequestItemDto,
  CreateBomChangeRequestDto,
  DecideBomChangeRequestDto,
  ListBomChangeRequestsQueryDto,
  MAX_BOM_CHANGE_NOTES_LENGTH,
  MAX_BOM_CHANGE_TITLE_LENGTH,
  MAX_BOM_CHANGE_USER_ID_LENGTH,
  UpdateBomChangeRequestDto,
  UpdateBomChangeRequestItemDto,
  resolveBomChangeRequestPageWindow,
} from './bom-change.dto';
import { BOM_CHANGE_TYPES } from './bom-change';

/**
 * Phase PRODUCTION-BOM-CHANGE: the wire contract of the change-request routes.
 *
 * THE FIVE RULES THESE SPECS EXIST FOR
 * ------------------------------------
 *  1. EVERY BOUND IS A COLUMN WIDTH. `title` is `VARCHAR(200)`, `notes` `VARCHAR(2000)`, a
 *     platform user id `VARCHAR(64)`. A request no column can store must be a 400 naming
 *     the field, not a driver error from Postgres.
 *  2. THERE IS NO `tenantId`, NO `status`, NO `requesterUserId`, NO `original*` AND NO
 *     `total` ON THE WIRE. The tenant comes from the actor, the requester from
 *     `actor.userId`, the snapshot from the item, and the total is a display derivation
 *     (S8). `whitelist` + `forbidNonWhitelisted` mirror the global pipe, so a forbidden
 *     field is a 400 here exactly as it is in production rather than silently dropped.
 *  3. A DELTA IS AN SIGNED INTEGER AND NOTHING MORE: no `@Min`, no `@Max`, no `@IsPositive`.
 *     A `3`, a `-3` and a `0` are all accepted; `1.5` and `'3'` are refused. The range the
 *     source commented out must not come back through the DTO.
 *  4. THE CHANGE TYPE IS A CLOSED SET. Anything outside the source's two values is a 400
 *     naming `changeType`, so a future `INACTIVE` / `DELETE` string cannot reach the domain
 *     and be silently reinterpreted.
 *  5. THE PAGE CEILING IS A CONTRACT AT THE EDGE AND A GUARANTEE IN THE SERVICE. An absurd
 *     `pageSize` is a 400 here; `resolveBomChangeRequestPageWindow`'s `Math.min` is what an
 *     internal caller that builds its own query object cannot exceed.
 */

/** Runs the real global pipe behaviour: transform, then validate. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return {
    instance,
    failed: errors.map((error) => error.property),
    /**
     * Whether an UNKNOWN field was refused rather than silently dropped. class-validator
     * names this constraint `whitelistValidation` — verified against the installed version
     * rather than guessed, because matching the wrong key would make every "no field on the
     * wire" assertion below pass by asserting nothing.
     */
    rejected: errors.some(
      (error) => error.constraints && 'whitelistValidation' in error.constraints
    ),
  };
}

const BOM_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';

const VALID_CREATE: Record<string, unknown> = {
  bomId: BOM_ID,
  title: 'تغییر اقلام پروژه الف',
  approverUserId: 'user-approver',
  notes: 'توضیحات',
};

describe('CreateBomChangeRequestDto', () => {
  it('accepts a well-formed payload', async () => {
    const { failed } = await check(CreateBomChangeRequestDto, VALID_CREATE);
    expect(failed).toEqual([]);
  });

  it('requires a title, an approver and a v4 BOM id, and reports each by name', async () => {
    const { failed } = await check(CreateBomChangeRequestDto, { title: 'x' });
    expect(failed.sort()).toEqual(['approverUserId', 'bomId']);
  });

  it('refuses a non-uuid `bomId` — a Production-owned id IS a UUID v4', async () => {
    const { failed } = await check(CreateBomChangeRequestDto, {
      ...VALID_CREATE,
      bomId: 'not-a-uuid',
    });
    expect(failed).toEqual(['bomId']);
  });

  it('refuses an EMPTY title at the edge; whitespace is the SERVICE\u2019s rule to trim', async () => {
    const { failed } = await check(CreateBomChangeRequestDto, { ...VALID_CREATE, title: '' });
    expect(failed).toEqual(['title']);

    // `'   '` passes `@IsNotEmpty()` — it is not blank-checked anywhere at the WIRE level,
    // and `bom-change.service.spec.ts` asserts that the service refuses it after trimming.
    // Stated here so nobody "fixes" one without knowing the other owns the other half.
    const spaces = await check(CreateBomChangeRequestDto, { ...VALID_CREATE, title: '   ' });
    expect(spaces.failed).toEqual([]);
  });

  it('bounds the title by its COLUMN width', async () => {
    expect(MAX_BOM_CHANGE_TITLE_LENGTH).toBe(200);
    const { failed } = await check(CreateBomChangeRequestDto, {
      ...VALID_CREATE,
      title: 'x'.repeat(MAX_BOM_CHANGE_TITLE_LENGTH + 1),
    });
    expect(failed).toEqual(['title']);
  });

  it('bounds the notes and the platform user id by their COLUMN widths', async () => {
    expect(MAX_BOM_CHANGE_NOTES_LENGTH).toBe(2000);
    expect(MAX_BOM_CHANGE_USER_ID_LENGTH).toBe(64);

    const longNotes = await check(CreateBomChangeRequestDto, {
      ...VALID_CREATE,
      notes: 'x'.repeat(MAX_BOM_CHANGE_NOTES_LENGTH + 1),
    });
    expect(longNotes.failed).toEqual(['notes']);

    const longApprover = await check(CreateBomChangeRequestDto, {
      ...VALID_CREATE,
      approverUserId: 'u'.repeat(MAX_BOM_CHANGE_USER_ID_LENGTH + 1),
    });
    expect(longApprover.failed).toEqual(['approverUserId']);
  });

  it('keeps `requestDate` OFF the wire — the column defaults at creation', async () => {
    const { rejected } = await check(CreateBomChangeRequestDto, {
      ...VALID_CREATE,
      requestDate: '2026-01-01T00:00:00.000Z',
    });
    // `forbidNonWhitelisted` turns an unknown field into a 400 rather than a silent drop,
    // which is the difference between "ignored" and "refused".
    expect(rejected).toBe(true);
  });
});

describe('no DTO carries a field the domain owns', () => {
  const FORBIDDEN = [
    'tenantId',
    'userId',
    'status',
    'managerOpinion',
    'requesterUserId',
    'decidedAt',
    'decidedByUserId',
    'submittedAt',
    'projectRef',
    'productTreeRef',
    'originalDrawingCoefficient',
    'originalSpareCoefficient',
    'total',
    'changeRequestId',
  ];

  it('refuses every one of them on create, add-item and both patches', async () => {
    const payloads: Array<[new () => object, Record<string, unknown>, string[]]> = [
      [CreateBomChangeRequestDto, VALID_CREATE, FORBIDDEN],
      [UpdateBomChangeRequestDto, { title: 'x' }, FORBIDDEN],
      [AddBomChangeRequestItemDto, { bomItemId: ITEM_ID, changeType: 'QUANTITY_CHANGE' }, FORBIDDEN],
      [UpdateBomChangeRequestItemDto, { changeType: 'DEACTIVATE' }, FORBIDDEN],
      [DecideBomChangeRequestDto, {}, FORBIDDEN],
      // The REGISTER query is the one place `status` and `projectRef` are legitimate — they
      // are its own server-side filters. Excluding exactly those two, and nothing else, is
      // what keeps this list from becoming a shape that "passes" for the wrong reason.
      [
        ListBomChangeRequestsQueryDto,
        {},
        FORBIDDEN.filter((field) => !['status', 'projectRef'].includes(field)),
      ],
    ];

    for (const [cls, base, fields] of payloads) {
      for (const field of fields) {
        const { rejected } = await check(cls as new () => object, { ...base, [field]: 'x' });
        expect({ cls: cls.name, field, rejected }).toEqual({
          cls: cls.name,
          field,
          rejected: true,
        });
      }
    }
  });

  it('gives the DECISION endpoint only an optional note — the path states the opinion', async () => {
    const { failed, rejected } = await check(DecideBomChangeRequestDto, {
      notes: 'ok',
      opinion: 'APPROVED',
    });
    // The note is a legitimate field; `opinion` is refused BY NAME, which is what makes the
    // refusal a 400 a client can act on rather than a field silently dropped.
    expect(failed).toEqual(['opinion']);
    expect(rejected).toBe(true);
  });
});


describe('the change type is a closed two-value set', () => {
  it('accepts both source values and refuses anything else', async () => {
    for (const changeType of BOM_CHANGE_TYPES) {
      const { failed } = await check(AddBomChangeRequestItemDto, {
        bomItemId: ITEM_ID,
        changeType,
      });
      expect({ changeType, failed }).toEqual({ changeType, failed: [] });
    }

    for (const changeType of ['INACTIVE', 'DELETE', '', 'تغییر موجودی']) {
      const { failed } = await check(AddBomChangeRequestItemDto, {
        bomItemId: ITEM_ID,
        changeType,
      });
      expect({ changeType, failed }).toEqual({ changeType, failed: ['changeType'] });
    }
  });
});

describe('a delta is a SIGNED integer and nothing more', () => {
  it('accepts an increase, a decrease and a zero', async () => {
    for (const drawingCoefficientDelta of [5, -5, 0]) {
      const { failed } = await check(AddBomChangeRequestItemDto, {
        bomItemId: ITEM_ID,
        changeType: 'QUANTITY_CHANGE',
        drawingCoefficientDelta,
        spareCoefficientDelta: 1,
      });
      expect({ drawingCoefficientDelta, failed }).toEqual({ drawingCoefficientDelta, failed: [] });
    }
  });

  it('refuses a fraction — the source `parseInt`s it, so the domain refuses rather than truncates', async () => {
    const { failed } = await check(AddBomChangeRequestItemDto, {
      bomItemId: ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: 1.5,
    });
    expect(failed).toEqual(['drawingCoefficientDelta']);
  });

  it('refuses a non-numeric delta', async () => {
    const { failed } = await check(AddBomChangeRequestItemDto, {
      bomItemId: ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: 'three',
    });
    expect(failed).toEqual(['drawingCoefficientDelta']);
  });

  it('carries NO `@Min` and NO `@Max` on a DELTA — the source\u2019s range checks are commented out', () => {
    // Read from the FILE and scope to the two detail DTOs' own class bodies, because
    // decorators compile into `__decorate` calls outside the class and a `toString()` of the
    // class would contain none of them — a vacuous assertion. The register query's
    // `@Max(PRODUCTION_MAX_PAGE_SIZE)` is a PAGINATION bound on a different class and is
    // deliberately out of scope here.
    const source = readFileSync(join(__dirname, 'bom-change.dto.ts'), 'utf8');

    const bodies = ['AddBomChangeRequestItemDto', 'UpdateBomChangeRequestItemDto'].map((name) => {
      // A line that is exactly `}` ends the class, whatever the line ending is — an index
      // search for `'\n}\n'` would silently miss CRLF and slice from `-1`.
      const match = source.match(new RegExp(`export class ${name} [\\s\\S]*?^\\}$`, 'm'));
      expect({ name, found: match !== null }).toEqual({ name, found: true });
      return match![0];
    });

    for (const body of bodies) {
      expect(body).not.toMatch(/@Min\(/);
      expect(body).not.toMatch(/@Max\(/);
      expect(body).not.toMatch(/@IsPositive/);
      // …while the integrality bound the source DOES prove is present.
      expect(body).toMatch(/@IsInt\(\)/);
    }
  });

  it('lets a PATCH CLEAR a delta with `null` while still refusing a fraction', async () => {
    const cleared = await check(UpdateBomChangeRequestItemDto, {
      drawingCoefficientDelta: null,
    });
    expect(cleared.failed).toEqual([]);

    const fractional = await check(UpdateBomChangeRequestItemDto, {
      drawingCoefficientDelta: 0.5,
    });
    expect(fractional.failed).toEqual(['drawingCoefficientDelta']);
  });
});

describe('the register query', () => {
  it('accepts the four server-side filters and refuses an unknown one', async () => {
    const { failed } = await check(ListBomChangeRequestsQueryDto, {
      page: 1,
      pageSize: 20,
      bomId: BOM_ID,
      projectRef: '42',
      status: 'SUBMITTED',
      search: 'تغییر',
    });
    expect(failed).toEqual([]);

    const unknown = await check(ListBomChangeRequestsQueryDto, { statusFilter: 'DRAFT' });
    expect(unknown.rejected).toBe(true);
  });

  it('refuses a status outside the four the lifecycle has', async () => {
    const { failed } = await check(ListBomChangeRequestsQueryDto, { status: 'CANCELLED' });
    expect(failed).toEqual(['status']);
  });

  it('refuses an absurd `pageSize` at the edge rather than silently clamping', async () => {
    const { failed } = await check(ListBomChangeRequestsQueryDto, { pageSize: 5000 });
    expect(failed).toEqual(['pageSize']);
    expect(PRODUCTION_MAX_PAGE_SIZE).toBe(100);
  });

  it('resolves the window with a floor and a ceiling an internal caller cannot exceed', () => {
    expect(resolveBomChangeRequestPageWindow({})).toEqual({
      page: 1,
      pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: PRODUCTION_DEFAULT_PAGE_SIZE,
    });
    expect(resolveBomChangeRequestPageWindow({ page: 3, pageSize: 10 })).toMatchObject({
      page: 3,
      skip: 20,
      take: 10,
    });
    expect(resolveBomChangeRequestPageWindow({ page: -4, pageSize: -1 })).toMatchObject({
      page: 1,
      skip: 0,
      take: 1,
    });
    expect(resolveBomChangeRequestPageWindow({ pageSize: 10000 }).take).toBe(
      PRODUCTION_MAX_PAGE_SIZE
    );
  });
});

