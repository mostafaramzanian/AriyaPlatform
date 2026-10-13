import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { COMMERCE_DEFAULT_PAGE_SIZE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import {
  WORKFLOW_MAX_DEFINITION_CODE_LENGTH,
  WORKFLOW_MAX_DEFINITION_NAME_LENGTH,
  WORKFLOW_MAX_DISPLAY_NAME_LENGTH,
  WORKFLOW_MAX_PARALLEL_GROUP_LENGTH,
  WORKFLOW_MAX_STEP_KEY_LENGTH,
  WORKFLOW_MAX_VERSION_LABEL_LENGTH,
} from './workflow-configuration';
import {
  CreateWorkflowDefinitionDto,
  CreateWorkflowStepDto,
  CreateWorkflowVersionDto,
  ListWorkflowVersionsQueryDto,
  MAX_WORKFLOW_STEP_REORDER,
  RenameWorkflowDefinitionDto,
  ReorderWorkflowStepsDto,
  UpdateWorkflowStepDto,
} from './workflow-configuration.dto';

/**
 * Phase C1 Step M (§8): the wire contract of the workflow configuration routes.
 *
 * THE FOUR RULES THESE SPECS EXIST FOR
 * -----------------------------------
 *  1. EVERY BOUND IS A COLUMN WIDTH. The step key is `VARCHAR(64)`, the display name
 *     `VARCHAR(200)`, and a reorder list has a ceiling. A request no column can store must be a 400
 *     naming the field, not a driver error from Postgres — and each test asks for the boundary from
 *     BOTH sides, because an off-by-one in a `@MaxLength` is invisible to a test that only sends a
 *     value "long enough".
 *  2. `undefined` AND `null` MEAN DIFFERENT THINGS. `undefined` is "not part of this edit"; `null`
 *     is "clear it". Both survive validation, and the DTO must NOT default the second from the
 *     first — the SERVICE resolves the distinction (see `toPatch`).
 *  3. THE DEFAULTS ARE NOT THE DTO'S. `mandatory` and `executionMode` are optional here and the
 *     service applies the schema's values when it writes, so an omitted field is genuinely absent
 *     from the parsed instance rather than pre-filled by a validator.
 *  4. NO TENANT, NO STATUS, NO TIMESTAMP. The tenant comes from the actor and the lifecycle from
 *     the routes that own each transition; a field for either would be a client deciding something
 *     it does not own, which is what the `forbidNonWhitelisted` cases pin.
 *
 * `whitelist` + `forbidNonWhitelisted` mirror the global pipe, so a forbidden field is a 400 here
 * exactly as it is in production rather than a silently dropped value.
 */

/** Runs the real global pipe behaviour: transform, then validate. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const STEP_ID = '22222222-2222-4222-8222-222222222222';

describe('Phase C1 Step M — the definition contract', () => {
  it('accepts the tenant’s code and name, and requires both', async () => {
    expect(
      (await check(CreateWorkflowDefinitionDto, { code: 'standard-purchase', name: 'Standard' }))
        .failed
    ).toEqual([]);
    expect((await check(CreateWorkflowDefinitionDto, { name: 'Standard' })).failed).toEqual([
      'code',
    ]);
    expect((await check(CreateWorkflowDefinitionDto, { code: 'standard' })).failed).toEqual([
      'name',
    ]);
  });

  it('refuses a code or a name past its column, and accepts the column’s own width', async () => {
    const atLimit = {
      code: 'c'.repeat(WORKFLOW_MAX_DEFINITION_CODE_LENGTH),
      name: 'n'.repeat(WORKFLOW_MAX_DEFINITION_NAME_LENGTH),
    };
    expect((await check(CreateWorkflowDefinitionDto, atLimit)).failed).toEqual([]);

    expect(
      (
        await check(CreateWorkflowDefinitionDto, {
          ...atLimit,
          code: 'c'.repeat(WORKFLOW_MAX_DEFINITION_CODE_LENGTH + 1),
        })
      ).failed
    ).toEqual(['code']);
    expect(
      (
        await check(CreateWorkflowDefinitionDto, {
          ...atLimit,
          name: 'n'.repeat(WORKFLOW_MAX_DEFINITION_NAME_LENGTH + 1),
        })
      ).failed
    ).toEqual(['name']);
  });

  it('refuses an empty label, and a tenantId — the tenant is never a field', async () => {
    expect(
      (await check(CreateWorkflowDefinitionDto, { code: '', name: 'Standard' })).failed
    ).toEqual(['code']);
    expect(
      (
        await check(CreateWorkflowDefinitionDto, {
          code: 'standard',
          name: 'Standard',
          tenantId: 't1',
        })
      ).failed
    ).toEqual(['tenantId']);
  });

  it('renames the container with a name alone, and refuses a blank one', async () => {
    expect((await check(RenameWorkflowDefinitionDto, { name: 'Renamed' })).failed).toEqual([]);
    expect((await check(RenameWorkflowDefinitionDto, { name: '' })).failed).toEqual(['name']);
    expect((await check(RenameWorkflowDefinitionDto, {})).failed).toEqual(['name']);
  });
});

describe('Phase C1 Step M — the version contract', () => {
  it('opens a version with the tenant’s label, bounded by the column and never blank', async () => {
    expect((await check(CreateWorkflowVersionDto, { versionLabel: '1404-01' })).failed).toEqual([]);
    expect((await check(CreateWorkflowVersionDto, {})).failed).toEqual(['versionLabel']);
    expect((await check(CreateWorkflowVersionDto, { versionLabel: '' })).failed).toEqual([
      'versionLabel',
    ]);

    const atLimit = 'v'.repeat(WORKFLOW_MAX_VERSION_LABEL_LENGTH);
    expect((await check(CreateWorkflowVersionDto, { versionLabel: atLimit })).failed).toEqual([]);
    expect((await check(CreateWorkflowVersionDto, { versionLabel: `${atLimit}v` })).failed).toEqual(
      ['versionLabel']
    );
  });

  it('has NO field for `status` or `publishedAt` — the lifecycle is not client-settable', async () => {
    // The transitions are the routes that own each edge; a settable status would be how "a published
    // version is immutable" gets a bypass.
    expect(
      (await check(CreateWorkflowVersionDto, { versionLabel: 'v1', status: 'PUBLISHED' })).failed
    ).toEqual(['status']);
    expect(
      (
        await check(CreateWorkflowVersionDto, {
          versionLabel: 'v1',
          publishedAt: '2026-01-01T00:00:00.000Z',
        })
      ).failed
    ).toEqual(['publishedAt']);
  });

  it('narrows a version list by ONE status of the module’s own vocabulary', async () => {
    expect((await check(ListWorkflowVersionsQueryDto, {})).failed).toEqual([]);
    expect((await check(ListWorkflowVersionsQueryDto, { status: 'DRAFT' })).failed).toEqual([]);
    expect((await check(ListWorkflowVersionsQueryDto, { status: 'PENDING' })).failed).toEqual([
      'status',
    ]);
  });
});

describe('Phase C1 Step M — the step contract', () => {
  const MINIMAL_STEP = { stepKey: 'check-budget', displayName: 'Check budget', ordering: 1 };

  it('requires the three columns that have no sensible default, and no more', async () => {
    const { instance, failed } = await check(CreateWorkflowStepDto, MINIMAL_STEP);
    expect(failed).toEqual([]);

    // RULE 3: the schema's defaults are applied by the SERVICE, so an omitted column is absent from
    // the parsed instance rather than pre-filled by a validator.
    expect(instance).toMatchObject(MINIMAL_STEP);
    expect(instance.mandatory).toBeUndefined();
    expect(instance.executionMode).toBeUndefined();
  });

  it('requires each of the three, one at a time', async () => {
    for (const field of ['stepKey', 'displayName', 'ordering'] as const) {
      expect({
        field,
        failed: (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, [field]: undefined }))
          .failed,
      }).toEqual({ field, failed: [field] });
    }
  });

  it('refuses a key, a name or a branch label past its column, and accepts the width', async () => {
    const key = 'k'.repeat(WORKFLOW_MAX_STEP_KEY_LENGTH);
    expect((await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, stepKey: key })).failed).toEqual(
      []
    );
    expect(
      (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, stepKey: `${key}k` })).failed
    ).toEqual(['stepKey']);

    expect(
      (
        await check(CreateWorkflowStepDto, {
          ...MINIMAL_STEP,
          displayName: 'n'.repeat(WORKFLOW_MAX_DISPLAY_NAME_LENGTH + 1),
        })
      ).failed
    ).toEqual(['displayName']);

    expect(
      (
        await check(CreateWorkflowStepDto, {
          ...MINIMAL_STEP,
          executionMode: 'PARALLEL',
          parallelGroup: 'g'.repeat(WORKFLOW_MAX_PARALLEL_GROUP_LENGTH + 1),
        })
      ).failed
    ).toEqual(['parallelGroup']);
  });

  it('refuses a position below the floor or a fractional one', async () => {
    expect((await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, ordering: 0 })).failed).toEqual([
      'ordering',
    ]);
    expect((await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, ordering: 1.5 })).failed).toEqual(
      ['ordering']
    );
  });

  it('refuses a mode or a source outside the closed vocabularies, at the boundary', async () => {
    expect(
      (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, executionMode: 'PARALEL' })).failed
    ).toEqual(['executionMode']);
    expect(
      (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, actorSource: 'EVERYONE' })).failed
    ).toEqual(['actorSource']);
  });

  it('takes each payload as an OBJECT, and refuses an array or a scalar', async () => {
    expect(
      (
        await check(CreateWorkflowStepDto, {
          ...MINIMAL_STEP,
          condition: { field: 'amount' },
          actorRule: { field: 'amount' },
          thresholds: { cash: 1000 },
          lineFilters: { category: 'IT' },
          configuration: { visibleFields: ['amount'] },
        })
      ).failed
    ).toEqual([]);

    expect(
      (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, thresholds: [1] })).failed
    ).toEqual(['thresholds']);
    expect(
      (await check(CreateWorkflowStepDto, { ...MINIMAL_STEP, configuration: 'fields' })).failed
    ).toEqual(['configuration']);
  });

  it('keeps `null` as “clear it” — a nullish DTO field must not be dropped', async () => {
    const { instance, failed } = await check(CreateWorkflowStepDto, {
      ...MINIMAL_STEP,
      condition: null,
      parallelGroup: null,
      actorSource: null,
      actorUserId: null,
      actorRoleCode: null,
      actorRule: null,
      thresholds: null,
      lineFilters: null,
      configuration: null,
    });

    expect(failed).toEqual([]);
    // `null` survives validation and reaches the service, which is what makes "clear the
    // threshold" expressible at all; a default that replaced it with `undefined` would turn a clear
    // into a no-op.
    expect(instance.condition).toBeNull();
    expect(instance.actorSource).toBeNull();
  });

  it('accepts an EMPTY update and an update that clears a payload, and refuses a `status`', async () => {
    expect((await check(UpdateWorkflowStepDto, {})).failed).toEqual([]);
    expect(
      (await check(UpdateWorkflowStepDto, { condition: null, ordering: 3, stepKey: 'renamed' }))
        .failed
    ).toEqual([]);

    // The lifecycle is not an edit: a client writing a status is refused at the boundary rather
    // than ignored, and `forbidNonWhitelisted` is what makes the refusal visible.
    expect((await check(UpdateWorkflowStepDto, { status: 'DRAFT' })).failed).toEqual(['status']);
  });
});

describe('Phase C1 Step M — the reorder contract', () => {
  it('states the order as a list of step IDS, and refuses an empty list or a non-id', async () => {
    expect((await check(ReorderWorkflowStepsDto, { order: [STEP_ID, VERSION_ID] })).failed).toEqual(
      []
    );
    expect((await check(ReorderWorkflowStepsDto, { order: [] })).failed).toEqual(['order']);
    expect((await check(ReorderWorkflowStepsDto, { order: ['not-a-uuid'] })).failed).toEqual([
      'order',
    ]);
  });

  it('bounds the list, and accepts the ceiling itself', async () => {
    // A bound, not a business rule: a reorder states a version's steps, and a version with more
    // steps than this is a configuration nobody authored by hand.
    const ids = Array.from(
      { length: MAX_WORKFLOW_STEP_REORDER },
      (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`
    );

    expect((await check(ReorderWorkflowStepsDto, { order: ids })).failed).toEqual([]);
    expect((await check(ReorderWorkflowStepsDto, { order: [...ids, ids[0]] })).failed).toEqual([
      'order',
    ]);
  });
});

describe('Phase C1 Step M — the shared page window', () => {
  it('resolves an absent window to the module default and CLAMPS an absurd one', async () => {
    expect(resolveCommercePageWindow({})).toEqual({
      page: 1,
      pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
      skip: 0,
      take: COMMERCE_DEFAULT_PAGE_SIZE,
    });

    // The DTO refuses an absurd page size (a 400 naming the field) and the service clamps as well;
    // this pins the clamp — the half an internal caller that never met the DTO relies on.
    expect(resolveCommercePageWindow({ page: 3, pageSize: 5000 })).toEqual({
      page: 3,
      pageSize: COMMERCE_MAX_PAGE_SIZE,
      skip: 2 * COMMERCE_MAX_PAGE_SIZE,
      take: COMMERCE_MAX_PAGE_SIZE,
    });
    expect((await check(ListWorkflowVersionsQueryDto, { pageSize: 5000 })).failed).toEqual([
      'pageSize',
    ]);
  });
});
