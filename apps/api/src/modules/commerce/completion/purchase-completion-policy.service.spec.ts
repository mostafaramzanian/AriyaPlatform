import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import type { CommerceTransactionHandle, CommerceUnitOfWork } from '../database/commerce-transaction';
import {
  PURCHASE_COMPLETION_AUDIT_ACTION,
  PURCHASE_COMPLETION_FAILURE,
} from './completion.constants';
import type { PurchaseCompletionPolicyRepository } from './purchase-completion-policy.repository';
import {
  PurchaseCompletionPolicyService,
} from './purchase-completion-policy.service';
import type {
  CreatePurchaseCompletionPolicyDto,
  UpdatePurchaseCompletionPolicyDto,
} from './purchase-completion-policy.dto';

/**
 * PHASE C4-R (GAP-3): the completion-policy configuration surface, at the seam where it
 * validates and walks the lifecycle.
 *
 * WHAT IS PINNED, AND WHY AT THIS SEAM
 * ------------------------------------
 * The repository is faked and the audit gateway is a recorded spy, so every assertion is
 * about a DECISION: which writes happen, in what order, and what is refused BEFORE
 * anything is written. The rules that would otherwise be invisible until production:
 *
 *  * the TENANT comes from the actor and is the repository's first argument everywhere —
 *    there is no shape of these calls that reads another tenant's policy;
 *  * the CHECKLIST runs against the row at validate AND publish, so a value that could
 *    never be a policy is refused with the same reasons whether it arrived as a request
 *    or as a stored row;
 *  * a PUBLISHED row is IMMUTABLE and an ARCHIVED one cannot come back — the refusals name
 *    the status, and the conditional repository write is the second line of defence;
 *  * `publish` archives the previously published policy INSIDE ONE unit of work, so the
 *    tenant can never end with two (the single-published invariant the completion act
 *    relies on);
 *  * a refusal writes NOTHING: no repository call, no audit row;
 *  * `tenantId` never reaches a response body.
 */

const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'u-admin',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

/** One policy version as the repository returns it. */
function storedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    tenantId: 't1',
    status: 'DRAFT',
    versionLabel: '1404-completion-01',
    allowedFromStatuses: ['APPROVED'] as unknown,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function build() {
  type PolicyMocks = {
    create: jest.Mock;
    findById: jest.Mock;
    findByLabel: jest.Mock;
    listPage: jest.Mock;
    updateDraftIn: jest.Mock;
    validateIn: jest.Mock;
    publishIn: jest.Mock;
    archiveIn: jest.Mock;
  };
  const policies: PolicyMocks = {
    create: jest.fn(),
    findById: jest.fn(),
    findByLabel: jest.fn(),
    listPage: jest.fn(),
    updateDraftIn: jest.fn(),
    validateIn: jest.fn(),
    publishIn: jest.fn(),
    archiveIn: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const unitOfWork = {
    run: jest.fn((work: (tx: CommerceTransactionHandle) => Promise<unknown>) =>
      work({} as CommerceTransactionHandle)
    ),
  };

  // DEFAULTS: a found DRAFT, an empty page, and every conditional write succeeding.
  policies.findById.mockResolvedValue(storedPolicy());
  policies.findByLabel.mockResolvedValue(null);
  policies.listPage.mockResolvedValue([[], 0]);
  policies.create.mockResolvedValue(storedPolicy());
  policies.updateDraftIn.mockResolvedValue(storedPolicy());
  policies.validateIn.mockResolvedValue(storedPolicy({ status: 'VALIDATED' }));
  policies.publishIn.mockResolvedValue(storedPolicy({ status: 'PUBLISHED' }));
  policies.archiveIn.mockResolvedValue(storedPolicy({ status: 'ARCHIVED' }));

  const service = new PurchaseCompletionPolicyService(
    policies as unknown as PurchaseCompletionPolicyRepository,
    audit as unknown as CommerceAuditGateway,
    unitOfWork as unknown as CommerceUnitOfWork
  );

  return {
    service,
    policies,
    audit,
    unitOfWork,
    calls: {
      create: policies.create.mock.calls,
      findById: policies.findById.mock.calls,
      findByLabel: policies.findByLabel.mock.calls,
      listPage: policies.listPage.mock.calls,
      updateDraftIn: policies.updateDraftIn.mock.calls,
      validateIn: policies.validateIn.mock.calls,
      publishIn: policies.publishIn.mock.calls,
      archiveIn: policies.archiveIn.mock.calls,
      audit: audit.record.mock.calls,
      run: unitOfWork.run.mock.calls,
    },
  };
}

/** Await a refusal and return its whole response (`{code, message}`), failing otherwise. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as { code?: string; message?: string };
  }
  throw new Error('expected a 409 refusal, but the call succeeded');
}

describe('Phase C4-R GAP-3 — opening a DRAFT', () => {
  it('creates a DRAFT inside the actor’s tenant, and never takes a tenant from the payload', async () => {
    const { service, calls } = build();

    const created = await service.createPolicy(actor, {
      versionLabel: '  1404-completion-01  ',
      allowedFromStatuses: ['APPROVED'],
    } as CreatePurchaseCompletionPolicyDto);

    // TENANT FIRST: the repository's first argument is `actor.tenantId`, and the payload
    // carries only the two fields the DTO admits — a client cannot state where to write.
    expect(calls.create).toHaveLength(1);
    const [tenantId, data] = calls.create[0];
    expect(tenantId).toBe('t1');
    expect(data).toEqual({
      status: 'DRAFT',
      versionLabel: '1404-completion-01',
      allowedFromStatuses: ['APPROVED'],
    });
    expect(JSON.stringify(data)).not.toContain('tenantId');

    expect(created).toMatchObject({
      id: 'p1',
      status: 'DRAFT',
      versionLabel: '1404-completion-01',
      allowedFromStatuses: ['APPROVED'],
    });
    // The tenant is the one thing a response body must never carry.
    expect(created).not.toHaveProperty('tenantId');
    expect(calls.audit[0][1]).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_CREATED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: 'p1',
    });
  });

  it('refuses a label this tenant already uses, before anything is written', async () => {
    const { service, policies, calls } = build();
    policies.findByLabel.mockResolvedValue(storedPolicy({ id: 'other' }));

    expect(
      (await refusalOf(
        service.createPolicy(
          actor,
          { versionLabel: 'dup', allowedFromStatuses: ['APPROVED'] } as CreatePurchaseCompletionPolicyDto
        )
      ))
        .code
    ).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_LABEL_TAKEN);

    expect(calls.findByLabel).toEqual([['t1', 'dup']]);
    expect(calls.create).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses an incoherent set at create, with the checklist’s own reasons', async () => {
    const { service, calls } = build();

    for (const allowedFromStatuses of [[], ['CLOSED'], ['PAID'], ['APPROVED', 'APPROVED']]) {
      const response = await refusalOf(
        service.createPolicy(
          actor,
          { versionLabel: 'v', allowedFromStatuses } as CreatePurchaseCompletionPolicyDto
        )
      );
      expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
      expect(response.message?.length).toBeGreaterThan(0);
    }

    // Nothing was written for any of them — the refusal precedes the insert.
    expect(calls.create).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses an empty or over-long label with the bound it broke', async () => {
    const { service, calls } = build();

    await expect(
      service.createPolicy(
        actor,
        { versionLabel: '   ', allowedFromStatuses: ['APPROVED'] } as CreatePurchaseCompletionPolicyDto
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createPolicy(actor, {
        versionLabel: 'x'.repeat(65),
        allowedFromStatuses: ['APPROVED'],
      } as CreatePurchaseCompletionPolicyDto)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(calls.create).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — editing a DRAFT', () => {
  it('edits the status set only, in the actor’s tenant, and records what changed', async () => {
    const { service, calls } = build();

    await service.updatePolicy(
      actor,
      'p1',
      { allowedFromStatuses: ['APPROVED', 'REJECTED'] } as UpdatePurchaseCompletionPolicyDto
    );

    const [tenantId, , id, set] = calls.updateDraftIn[0];
    expect(tenantId).toBe('t1');
    expect(id).toBe('p1');
    expect(set).toEqual(['APPROVED', 'REJECTED']);
    expect(calls.audit[0][1]).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_UPDATED,
      changedFields: ['allowedFromStatuses'],
    });
  });

  it('refuses to edit a VALIDATED or PUBLISHED row — a change is a new version', async () => {
    const { service, policies, calls } = build();

    for (const status of ['VALIDATED', 'PUBLISHED', 'ARCHIVED']) {
      policies.findById.mockResolvedValue(storedPolicy({ status }));
      const response = await refusalOf(
        service.updatePolicy(
          actor,
          'p1',
          { allowedFromStatuses: ['APPROVED'] } as UpdatePurchaseCompletionPolicyDto
        )
      );
      expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
      expect(response.message).toContain(status);
    }

    expect(calls.updateDraftIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('answers 404 for an unknown or foreign policy id, without confirming it exists', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(null);

    await expect(service.getPolicy(actor, 'foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.findById).toEqual([['t1', 'foreign']]);

    await expect(
      service.updatePolicy(
        actor,
        'foreign',
        { allowedFromStatuses: ['APPROVED'] } as UpdatePurchaseCompletionPolicyDto
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls.updateDraftIn).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — validate (the checklist against the STORED row)', () => {
  it('walks DRAFT → VALIDATED, in one unit of work, and records the transition', async () => {
    const { service, calls } = build();

    const validated = await service.validatePolicy(actor, 'p1');

    expect(calls.run).toHaveLength(1);
    const [tenantId, , id] = calls.validateIn[0];
    expect([tenantId, id]).toEqual(['t1', 'p1']);
    expect(validated).toMatchObject({ status: 'VALIDATED' });
    expect(calls.audit[0][1]).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_VALIDATED,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'VALIDATED' },
    });
  });

  it('refuses a row that is not a DRAFT, naming the status it is actually in', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ status: 'VALIDATED' }));

    const response = await refusalOf(service.validatePolicy(actor, 'p1'));
    expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
    expect(response.message).toContain('VALIDATED');
    expect(calls.validateIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses to validate a stored row the checklist rejects — every reason, no write', async () => {
    const { service, policies, calls } = build();
    // A row written by a path that never passed the DTO: duplicated members.
    policies.findById.mockResolvedValue(
      storedPolicy({ allowedFromStatuses: ['APPROVED', 'APPROVED'] })
    );

    const response = await refusalOf(service.validatePolicy(actor, 'p1'));
    expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
    expect(response.message).toContain('more than once');
    expect(calls.validateIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('answers 409 when the row left DRAFT under the request — never a silent transition', async () => {
    const { service, policies, calls } = build();
    policies.validateIn.mockResolvedValue(null);

    expect((await refusalOf(service.validatePolicy(actor, 'p1'))).code).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_INVALID
    );
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — publish (the single-published invariant)', () => {
  it('validates a DRAFT and publishes it in ONE unit of work', async () => {
    const { service, calls } = build();

    const published = await service.publishPolicy(actor, 'p1');

    // The whole walk is one unit: a failure between "validate this" and "publish that"
    // rolls the pair back rather than leaving a half-published policy.
    expect(calls.run).toHaveLength(1);
    expect(calls.validateIn).toEqual([['t1', {}, 'p1']]);
    expect(calls.publishIn).toEqual([['t1', {}, 'p1']]);
    expect(published).toMatchObject({ status: 'PUBLISHED' });
    expect(calls.audit[0][1]).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_PUBLISHED,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'PUBLISHED', allowedFromStatuses: ['APPROVED'] },
    });
  });

  it('publishes an already-VALIDATED row without re-validating it', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ status: 'VALIDATED' }));

    await service.publishPolicy(actor, 'p1');

    expect(calls.validateIn).toEqual([]);
    expect(calls.publishIn).toEqual([['t1', {}, 'p1']]);
  });

  it('refuses to re-publish a PUBLISHED row — it is immutable; publish a new version', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ status: 'PUBLISHED' }));

    const response = await refusalOf(service.publishPolicy(actor, 'p1'));
    expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
    expect(response.message).toContain('immutable');
    expect(calls.run).toEqual([]);
    expect(calls.publishIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses to revive an ARCHIVED row — the one way back is a new version', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ status: 'ARCHIVED' }));

    const response = await refusalOf(service.publishPolicy(actor, 'p1'));
    expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
    expect(response.message).toContain('create a new version');
    expect(calls.publishIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses to publish a row the checklist rejects — a policy never governs by accident', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ allowedFromStatuses: [] }));

    const response = await refusalOf(service.publishPolicy(actor, 'p1'));
    expect(response.code).toBe(PURCHASE_COMPLETION_FAILURE.POLICY_INVALID);
    expect(calls.run).toEqual([]);
    expect(calls.publishIn).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('reports a publish that lost a race, with no audit row for a transition that did not happen', async () => {
    const { service, policies, calls } = build();
    policies.publishIn.mockResolvedValue(null);

    expect((await refusalOf(service.publishPolicy(actor, 'p1'))).code).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_INVALID
    );
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — archive (retiring the policy)', () => {
  it('archives a row that is still live, tenant-scoped, and records it', async () => {
    const { service, calls } = build();

    const archived = await service.archivePolicy(actor, 'p1');

    expect(calls.archiveIn).toEqual([['t1', {}, 'p1']]);
    expect(archived).toMatchObject({ status: 'ARCHIVED' });
    expect(calls.audit[0][1]).toMatchObject({
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_ARCHIVED,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'ARCHIVED' },
    });
  });

  it('refuses to archive an already-ARCHIVED row, and to double-archive a race', async () => {
    const { service, policies, calls } = build();
    policies.findById.mockResolvedValue(storedPolicy({ status: 'ARCHIVED' }));

    expect((await refusalOf(service.archivePolicy(actor, 'p1'))).code).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_INVALID
    );
    expect(calls.archiveIn).toEqual([]);

    policies.findById.mockResolvedValue(storedPolicy({ status: 'PUBLISHED' }));
    policies.archiveIn.mockResolvedValue(null);
    expect((await refusalOf(service.archivePolicy(actor, 'p1'))).code).toBe(
      PURCHASE_COMPLETION_FAILURE.POLICY_INVALID
    );
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C4-R GAP-3 — the reads', () => {
  it('pages the tenant’s policies with the shared window, search on the label', async () => {
    const { service, policies, calls } = build();
    policies.listPage.mockResolvedValue([[storedPolicy()], 1]);

    const page = await service.listPolicies(actor, {
      page: 2,
      pageSize: 10,
      search: '1404',
    });

    const [tenantId, filter, window] = calls.listPage[0];
    expect(tenantId).toBe('t1');
    expect(filter).toEqual({ search: '1404' });
    expect(window).toEqual({ page: 2, pageSize: 10, skip: 10, take: 10 });
    expect(page).toMatchObject({ page: 2, pageSize: 10, total: 1 });
    expect(page.items[0]).toMatchObject({ id: 'p1', status: 'DRAFT' });
    // The tenant is the one thing a response body must never carry.
    expect(JSON.stringify(page)).not.toContain('"tenantId"');
  });

  it('clamps an absurd page size to the module ceiling even for an internal caller', async () => {
    const { service, calls } = build();

    await service.listPolicies(actor, { pageSize: COMMERCE_MAX_PAGE_SIZE * 10 });

    const [, , window] = calls.listPage[0];
    expect(window.take).toBe(COMMERCE_MAX_PAGE_SIZE);
  });
});
