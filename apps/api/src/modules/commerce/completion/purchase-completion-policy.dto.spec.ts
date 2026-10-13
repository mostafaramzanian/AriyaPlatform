import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import { PURCHASE_COMPLETION_SOURCE_STATUSES } from '../purchase/purchase-status';
import { PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH } from './purchase-completion-policy';
import {
  CreatePurchaseCompletionPolicyDto,
  ListPurchaseCompletionPoliciesQueryDto,
  UpdatePurchaseCompletionPolicyDto,
} from './purchase-completion-policy.dto';

/**
 * PHASE C4-R (GAP-3): the wire contract of the completion-policy routes.
 *
 * THE FOUR RULES THESE SPECS EXIST FOR
 * -----------------------------------
 *  1. THE LABEL'S BOUND IS THE COLUMN'S (`VARCHAR(64)`), asked from BOTH sides — an
 *     off-by-one in a `@MaxLength` is invisible to a test that only sends a long-enough
 *     value, and a label the column cannot store is a driver error rather than a 422.
 *  2. THE STATUS SET VALIDATES AGAINST THE SAME TUPLE the publication checklist and the
 *     completion evaluator use, so `CLOSED` and a foreign lifecycle's state (`PAID`) are
 *     refused at the EDGE — before a row exists to be unpublishable — and every one of the
 *     five candidates is accepted, because accepting them is the whole point of D1.
 *  3. NO TENANT, NO STATUS, NO ID: the tenant comes from `resolveCommerceActor(req)` and
 *     the lifecycle from the route that owns each transition. The forbidden-field cases
 *     pin that a client cannot smuggle either.
 *  4. SHAPE ONLY. "Is this row a coherent policy?" (empty set, duplicate member) is the
 *     publication checklist's answer against the STORED row — this file never claims it.
 */

/** Runs the real global pipe behaviour: transform, then validate with the whitelist. */
async function check<T extends object>(cls: new () => T, payload: Record<string, unknown>) {
  const instance = plainToInstance(cls, payload);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  return { instance, failed: errors.map((error) => error.property) };
}

/** The one complete, valid create payload every test may spread its defect into. */
const validCreate = () => ({
  versionLabel: '1404-completion-01',
  allowedFromStatuses: ['APPROVED'],
});

describe('Phase C4-R GAP-3 — the create contract', () => {
  it('accepts one complete DRAFT payload and requires every one of its fields', async () => {
    expect((await check(CreatePurchaseCompletionPolicyDto, validCreate())).failed).toEqual([]);

    for (const field of ['versionLabel', 'allowedFromStatuses']) {
      const payload: Record<string, unknown> = validCreate();
      delete payload[field];
      expect((await check(CreatePurchaseCompletionPolicyDto, payload)).failed).toEqual([field]);
    }
  });

  it('accepts EVERY source status individually — D1 is configuration, not a pick by the API', async () => {
    for (const status of PURCHASE_COMPLETION_SOURCE_STATUSES) {
      expect(
        (
          await check(CreatePurchaseCompletionPolicyDto, {
            ...validCreate(),
            allowedFromStatuses: [status],
          })
        ).failed
      ).toEqual([]);
    }

    // …and multi-status sets: several source statuses are a legitimate configuration, not
    // a shape the boundary narrows.
    expect(
      (
        await check(CreatePurchaseCompletionPolicyDto, {
          ...validCreate(),
          allowedFromStatuses: [...PURCHASE_COMPLETION_SOURCE_STATUSES],
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(CreatePurchaseCompletionPolicyDto, {
          ...validCreate(),
          allowedFromStatuses: ['APPROVED', 'REJECTED'],
        })
      ).failed
    ).toEqual([]);
  });

  it('refuses CLOSED and every state outside the vocabulary, by the field that carries it', async () => {
    for (const member of ['CLOSED', 'PAID', 'FULLY_RECEIVED', 'PENDING', 'approved', '']) {
      expect(
        (
          await check(CreatePurchaseCompletionPolicyDto, {
            ...validCreate(),
            allowedFromStatuses: [member],
          })
        ).failed
      ).toEqual(['allowedFromStatuses']);
    }

    // A mixed set fails on the same field: one bad member poisons the whole policy.
    expect(
      (
        await check(CreatePurchaseCompletionPolicyDto, {
          ...validCreate(),
          allowedFromStatuses: ['APPROVED', 'CLOSED'],
        })
      ).failed
    ).toEqual(['allowedFromStatuses']);
  });

  it('refuses an empty set at the edge — the field carries at least one status', async () => {
    expect(
      (
        await check(CreatePurchaseCompletionPolicyDto, {
          ...validCreate(),
          allowedFromStatuses: [],
        })
      ).failed
    ).toEqual(['allowedFromStatuses']);
  });

  it('states the label bound from both sides', async () => {
    const atBound = 'x'.repeat(PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH);
    expect(
      (await check(CreatePurchaseCompletionPolicyDto, { ...validCreate(), versionLabel: atBound }))
        .failed
    ).toEqual([]);

    expect(
      (
        await check(CreatePurchaseCompletionPolicyDto, {
          ...validCreate(),
          versionLabel: `${atBound}x`,
        })
      ).failed
    ).toEqual(['versionLabel']);
    expect(
      (await check(CreatePurchaseCompletionPolicyDto, { ...validCreate(), versionLabel: '' })).failed
    ).toEqual(['versionLabel']);
  });

  it('refuses a client-supplied tenant, status or id on create', async () => {
    for (const field of ['tenantId', 'status', 'id', 'createdAt']) {
      expect(
        (await check(CreatePurchaseCompletionPolicyDto, { ...validCreate(), [field]: 'x' })).failed
      ).toEqual([field]);
    }
  });
});

describe('Phase C4-R GAP-3 — the draft-edit contract', () => {
  it('carries ONLY the status set — the label is the row’s identity, the lifecycle the routes’', async () => {
    expect(
      (await check(UpdatePurchaseCompletionPolicyDto, { allowedFromStatuses: ['DRAFT'] })).failed
    ).toEqual([]);

    for (const field of ['versionLabel', 'status', 'id']) {
      expect(
        (
          await check(UpdatePurchaseCompletionPolicyDto, {
            allowedFromStatuses: ['DRAFT'],
            [field]: 'x',
          })
        ).failed
      ).toEqual([field]);
    }
  });

  it('refuses the same out-of-vocabulary members the create contract refuses', async () => {
    for (const member of ['CLOSED', 'PAID', 'MANAGER']) {
      expect(
        (await check(UpdatePurchaseCompletionPolicyDto, { allowedFromStatuses: [member] })).failed
      ).toEqual(['allowedFromStatuses']);
    }
  });
});

describe('Phase C4-R GAP-3 — the list contract', () => {
  it('inherits the shared page window, including its ceiling', async () => {
    expect((await check(ListPurchaseCompletionPoliciesQueryDto, {})).failed).toEqual([]);

    expect(
      (
        await check(ListPurchaseCompletionPoliciesQueryDto, {
          pageSize: COMMERCE_MAX_PAGE_SIZE,
        })
      ).failed
    ).toEqual([]);
    expect(
      (
        await check(ListPurchaseCompletionPoliciesQueryDto, {
          pageSize: COMMERCE_MAX_PAGE_SIZE + 1,
        })
      ).failed
    ).toEqual(['pageSize']);
    expect((await check(ListPurchaseCompletionPoliciesQueryDto, { page: 0 })).failed).toEqual([
      'page',
    ]);
  });

  it('offers no status filter the contract never defined', async () => {
    expect(
      (await check(ListPurchaseCompletionPoliciesQueryDto, { status: 'PUBLISHED' })).failed
    ).toEqual(['status']);
    expect(
      (await check(ListPurchaseCompletionPoliciesQueryDto, { tenantId: 't1' })).failed
    ).toEqual(['tenantId']);
  });
});
