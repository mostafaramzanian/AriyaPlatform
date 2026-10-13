import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RULE_LIMITS } from '../../../rules/core/rule-limits';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH } from './workflow-line-routing';
import {
  CreateLineRoutingVersionDto,
  LineRoutingRouteInputDto,
  ListLineRoutingVersionsQueryDto,
  MAX_LINE_ROUTING_ROUTE_DESCRIPTION_LENGTH,
} from './workflow-line-routing.dto';

/**
 * PHASE C3 (GAP-2): the wire contract of the line-routing configuration routes.
 *
 * THE FOUR RULES THESE SPECS EXIST FOR
 * -----------------------------------
 *  1. EVERY BOUND IS A COLUMN OR AN ENGINE LIMIT. The label is `VARCHAR(64)`; a route's
 *     `priority` is the engine's own priority range; a description is the engine's rule-name
 *     length; the route list is the engine's `maxRulesPerSet`. A request no column or no
 *     validator could accept must be a 422 naming the field (the production pipe's
 *     `whitelist`/`forbidNonWhitelisted` behaviour, reproduced by `check`), not a driver error
 *     or a refusal discovered only at publication — and each bound is asked from BOTH sides,
 *     because an off-by-one in a `@MaxLength` is invisible to a test that only sends a value
 *     "long enough".
 *  2. EVERY VOCABULARY IS A CLOSED TUPLE. `trigger` (O1), `noRouteBehavior` (O2),
 *     `multipleMatchBehavior` (O3) and `aggregationPolicy` (O4) validate against the SAME
 *     tuples the publish gate compares against, so a member nobody accepts is refused at the
 *     edge rather than stored as an unpublishable draft.
 *  3. NO TENANT, NO STATUS, NO ID. The tenant comes from `resolveCommerceActor(req)` and the
 *     lifecycle from the route that owns each transition; a field for either is a client
 *     deciding something it does not own, which is what the forbidden-field cases pin.
 *  4. SHAPE ONLY. Structural validity — the frozen fact allowlist, target existence, rule-set
 *     validity — belongs to the publish walk, so this file never claims it. What it does
 *     claim is that a malformed route object cannot reach a row at all.
 */

/** Runs the real global pipe behaviour: transform, then validate with the whitelist. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

const TARGET_ID = '11111111-1111-4111-8111-111111111111';

/** The one complete, valid create payload every test may spread its defect into. */
const validCreate = () => ({
  versionLabel: '1404-01',
  trigger: 'PURCHASE_SUBMITTED',
  noRouteBehavior: 'LEAVE_UNROUTED',
  multipleMatchBehavior: 'HIGHEST_PRIORITY',
  aggregationPolicy: 'INDEPENDENT',
  routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID, condition: null }],
});

describe('Phase C3 GAP-2 — the create contract', () => {
  it('accepts one complete DRAFT payload and requires every one of its fields', async () => {
    expect((await check(CreateLineRoutingVersionDto, validCreate())).failed).toEqual([]);

    for (const field of [
      'versionLabel',
      'trigger',
      'noRouteBehavior',
      'multipleMatchBehavior',
      'aggregationPolicy',
      'routeRules',
    ]) {
      const payload: Record<string, unknown> = validCreate();
      delete payload[field];
      expect((await check(CreateLineRoutingVersionDto, payload)).failed).toEqual([field]);
    }
  });

  it('refuses a value outside each closed vocabulary — O1..O4 stated from both ends', async () => {
    // O1: the trigger vocabulary is exactly the workflow trigger tuple.
    for (const trigger of ['PURCHASE_SUBMITTED', 'AFTER_DOCUMENT_WORKFLOW_APPROVED']) {
      expect(
        (await check(CreateLineRoutingVersionDto, { ...validCreate(), trigger })).failed
      ).toEqual([]);
    }
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), trigger: 'PAYMENT_RECORDED' }))
        .failed
    ).toEqual(['trigger']);

    // O2, O3, O4: both members accepted, a third member refused by name.
    for (const noRouteBehavior of ['REJECT_OPERATION', 'LEAVE_UNROUTED']) {
      expect(
        (await check(CreateLineRoutingVersionDto, { ...validCreate(), noRouteBehavior })).failed
      ).toEqual([]);
    }
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), noRouteBehavior: 'FIRST' }))
        .failed
    ).toEqual(['noRouteBehavior']);

    for (const multipleMatchBehavior of ['HIGHEST_PRIORITY', 'AMBIGUOUS_ERROR']) {
      expect(
        (await check(CreateLineRoutingVersionDto, { ...validCreate(), multipleMatchBehavior }))
          .failed
      ).toEqual([]);
    }
    expect(
      (
        await check(CreateLineRoutingVersionDto, {
          ...validCreate(),
          multipleMatchBehavior: 'REJECT',
        })
      ).failed
    ).toEqual(['multipleMatchBehavior']);

    for (const aggregationPolicy of ['ALL_APPROVED', 'INDEPENDENT']) {
      expect(
        (await check(CreateLineRoutingVersionDto, { ...validCreate(), aggregationPolicy })).failed
      ).toEqual([]);
    }
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), aggregationPolicy: 'ANY' }))
        .failed
    ).toEqual(['aggregationPolicy']);
  });

  it('refuses a label that is blank or past its column, and accepts the column’s own width', async () => {
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), versionLabel: '' })).failed
    ).toEqual(['versionLabel']);

    const atLimit = 'L'.repeat(WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH);
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), versionLabel: atLimit })).failed
    ).toEqual([]);
    expect(
      (
        await check(CreateLineRoutingVersionDto, {
          ...validCreate(),
          versionLabel: `${atLimit}L`,
        })
      ).failed
    ).toEqual(['versionLabel']);
  });

  it('refuses a tenantId, a status and an id — the tenant and the lifecycle are never fields', async () => {
    for (const field of ['tenantId', 'status', 'id']) {
      expect(
        (await check(CreateLineRoutingVersionDto, { ...validCreate(), [field]: 'x' })).failed
      ).toEqual([field]);
    }
  });
});

describe('Phase C3 GAP-2 — the route candidate contract', () => {
  it('accepts a route the O contract describes, with an optional description', async () => {
    expect(
      (
        await check(CreateLineRoutingVersionDto, {
          ...validCreate(),
          routeRules: [
            {
              priority: RULE_LIMITS.minPriority,
              targetWorkflowDefinitionVersionId: TARGET_ID,
              condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
              description: 'Standard lines',
            },
          ],
        })
      ).failed
    ).toEqual([]);
  });

  it('refuses a priority that is not an integer or is outside the engine’s own range', async () => {
    for (const priority of [1.5, '1', RULE_LIMITS.maxPriority + 1, RULE_LIMITS.minPriority - 1]) {
      expect(
        (
          await check(CreateLineRoutingVersionDto, {
            ...validCreate(),
            routeRules: [{ priority, targetWorkflowDefinitionVersionId: TARGET_ID }],
          })
        ).failed
      ).toEqual(['routeRules']);
    }
  });

  it('refuses a target that is not a UUID v4 — it names a workflow version ROW', async () => {
    for (const targetWorkflowDefinitionVersionId of [
      'not-a-uuid',
      '11111111-1111-5111-8111-111111111111', // v5: version digit is not 4
      '11111111-1111-4111-7111-111111111111', // invalid variant: first nibble must be 8/9/a/b
      '',
    ]) {
      expect(
        (
          await check(CreateLineRoutingVersionDto, {
            ...validCreate(),
            routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId }],
          })
        ).failed
      ).toEqual(['routeRules']);
    }
  });

  it('accepts a condition as an object or null, and refuses any other kind', async () => {
    for (const condition of [null, { field: 'lineType', op: 'isNotEmpty' }]) {
      expect(
        (
          await check(CreateLineRoutingVersionDto, {
            ...validCreate(),
            routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID, condition }],
          })
        ).failed
      ).toEqual([]);
    }
    expect(
      (
        await check(CreateLineRoutingVersionDto, {
          ...validCreate(),
          routeRules: [
            { priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID, condition: 'lineType' },
          ],
        })
      ).failed
    ).toEqual(['routeRules']);
  });
});

describe('Phase C3 GAP-2 — the bounds a column or the engine states', () => {
  it('bounds the description by the engine’s rule-name length, from both sides', async () => {
    const atLimit = 'd'.repeat(MAX_LINE_ROUTING_ROUTE_DESCRIPTION_LENGTH);
    for (const description of [undefined, atLimit]) {
      expect(
        (
          await check(CreateLineRoutingVersionDto, {
            ...validCreate(),
            routeRules: [
              { priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID, description },
            ],
          })
        ).failed
      ).toEqual([]);
    }
    for (const description of ['', `${atLimit}d`]) {
      expect(
        (
          await check(CreateLineRoutingVersionDto, {
            ...validCreate(),
            routeRules: [
              { priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID, description },
            ],
          })
        ).failed
      ).toEqual(['routeRules']);
    }
  });

  it('refuses an empty route list and one past the engine’s rule ceiling', async () => {
    const route = { priority: 1, targetWorkflowDefinitionVersionId: TARGET_ID };
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), routeRules: [] })).failed
    ).toEqual(['routeRules']);

    const atCeiling = Array.from({ length: RULE_LIMITS.maxRulesPerSet }, (_, index) => ({
      ...route,
      priority: index + 1,
    }));
    expect(
      (await check(CreateLineRoutingVersionDto, { ...validCreate(), routeRules: atCeiling })).failed
    ).toEqual([]);
    expect(
      (
        await check(CreateLineRoutingVersionDto, {
          ...validCreate(),
          routeRules: [...atCeiling, { ...route, priority: atCeiling.length + 1 }],
        })
      ).failed
    ).toEqual(['routeRules']);
  });
});

describe('Phase C3 GAP-2 — the list query contract', () => {
  it('takes the shared page window and its identifying-column search, and no tenant scope', async () => {
    expect(
      (await check(ListLineRoutingVersionsQueryDto, { page: 2, pageSize: 10, search: '1404' }))
        .failed
    ).toEqual([]);
    expect(
      (await check(ListLineRoutingVersionsQueryDto, { pageSize: COMMERCE_MAX_PAGE_SIZE + 1 }))
        .failed
    ).toEqual(['pageSize']);
    expect((await check(ListLineRoutingVersionsQueryDto, { tenantId: 't1' })).failed).toEqual([
      'tenantId',
    ]);
  });

  it('declares no status/trigger filter the O contract never defined', async () => {
    expect((await check(ListLineRoutingVersionsQueryDto, { status: 'PUBLISHED' })).failed).toEqual([
      'status',
    ]);
    expect(
      (await check(ListLineRoutingVersionsQueryDto, { trigger: 'PURCHASE_SUBMITTED' })).failed
    ).toEqual(['trigger']);
  });
});

describe('Phase C3 GAP-2 — the route input as its own class', () => {
  it('is validated nested under routeRules, so one bad candidate fails the field alone', async () => {
    expect(
      (
        await check(LineRoutingRouteInputDto, {
          priority: 1,
          targetWorkflowDefinitionVersionId: TARGET_ID,
        })
      ).failed
    ).toEqual([]);
    expect((await check(LineRoutingRouteInputDto, { priority: 1 })).failed).toEqual([
      'targetWorkflowDefinitionVersionId',
    ]);
  });
});
