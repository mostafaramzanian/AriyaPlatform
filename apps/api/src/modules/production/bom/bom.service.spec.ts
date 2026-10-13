import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { UserDirectoryContract } from '../../../platform/user-directory/user-directory.contract';
import type { ProductionAuditGateway } from '../production-audit.gateway';
import { BomHeaderService, PRODUCTION_BOM_AUDIT_ACTION, toBomHeaderView } from './bom.service';
import { PRODUCTION_BOM_ERROR_CODES } from './bom-item';
import type { BomHeaderRecord, BomHeaderRepository } from './bom.repository';
import type { CreateBomHeaderDto } from './bom.dto';

/**
 * Phase PRODUCTION-BOM-HEADER: the BOM Header slice's application surface.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE TENANT IS THE ACTOR'S, ALWAYS. Every call reaches the repository with
 *     `actor.tenantId` as the first argument, and a row that is not this tenant's is a
 *     404 that cannot be told apart from "does not exist".
 *  2. TWO IDENTITIES ARE VERIFIED, NOT TRUSTED. `requesterUserId` and `approverUserId`
 *     are checked against `USER_DIRECTORY` before anything is stored; a non-member is a
 *     400 naming the FIELD, and nothing is written.
 *  3. SELF-APPROVAL IS REFUSED, and the rule is about the ROW's two roles rather than
 *     about who called the API — a delegate creating a BOM for somebody else is covered
 *     by the same check.
 *  4. ONLY THE SNAPSHOTTED APPROVER MAY DECIDE. The check is an equality against the
 *     STORED value, so a `null` actor id (a machine caller) is refused by construction.
 *  5. THE TRAIL RECORDS WHAT WAS STORED, NOT WHAT WAS INTENDED. Every mutation audits
 *     after the repository returned a row, so a refused conditional write produces no
 *     audit row claiming success.
 *
 * The doubles are structural: the repository, the audit gateway and the directory are
 * plain objects, so these specs exercise the orchestration without a database, a Nest
 * container, or another owner's client.
 */

const TENANT = 'tenant-a';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';
const BOM_ID = '11111111-1111-4111-8111-111111111111';

const ACTOR = {
  tenantId: TENANT,
  userId: REQUESTER,
  requestId: 'req-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

function row(overrides: Partial<BomHeaderRecord> = {}): BomHeaderRecord {
  return {
    id: BOM_ID,
    tenantId: TENANT,
    title: 'BOM for project 42',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: REQUESTER,
    approverUserId: APPROVER,
    status: 'DRAFT',
    managerOpinion: null,
    comments: null,
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

const CREATE_DTO: CreateBomHeaderDto = {
  title: '  BOM for project 42  ',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: REQUESTER,
  approverUserId: APPROVER,
};

function build() {
  const repository = {
    create: jest.fn().mockResolvedValue(row()),
    findById: jest.fn().mockResolvedValue(row()),
    list: jest.fn().mockResolvedValue({ items: [row()], total: 1 }),
    updateDraft: jest.fn().mockResolvedValue(row({ title: 'renamed' })),
    submit: jest.fn().mockResolvedValue(row({ status: 'SUBMITTED', submittedAt: new Date() })),
    decide: jest
      .fn()
      .mockResolvedValue(row({ status: 'APPROVED', managerOpinion: 'APPROVED' })),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
    buildOutboxPayload: jest.fn().mockReturnValue({
      tenantId: TENANT,
      auditId: 'mock-audit-id',
      payload: {},
    }),
  };
  const directory = {
    findProfiles: jest.fn().mockResolvedValue([]),
    // A member by default; individual tests remove the identity to provoke the refusal.
    findTenantMember: jest.fn().mockResolvedValue({ id: 'any' }),
    findTenantId: jest.fn().mockResolvedValue(TENANT),
  };

  return {
    service: new BomHeaderService(
      repository as unknown as BomHeaderRepository,
      audit as unknown as ProductionAuditGateway,
      directory as unknown as UserDirectoryContract
    ),
    repository,
    audit,
    directory,
  };
}

describe('BomHeaderService.create', () => {
  it('verifies BOTH identities against the acting tenant before storing anything', async () => {
    const { service, repository, directory } = build();

    await service.create(ACTOR, CREATE_DTO);

    expect(directory.findTenantMember.mock.calls).toEqual([
      [TENANT, REQUESTER],
      [TENANT, APPROVER],
    ]);
    // The title is TRIMMED on the way in: the stored snapshot is what a reader searched
    // for, and `'  x  '` and `'x'` must not be two different documents.
    expect(repository.create).toHaveBeenCalledWith(TENANT, {
      title: 'BOM for project 42',
      projectRef: '42',
      productTreeRef: '771',
      requesterUserId: REQUESTER,
      approverUserId: APPROVER,
      comments: null,
    });
  });

  it('refuses a non-member with a 400 naming the field, and writes nothing', async () => {
    const { service, repository, directory } = build();
    directory.findTenantMember.mockResolvedValue(null);

    await expect(service.create(ACTOR, CREATE_DTO)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.create(ACTOR, CREATE_DTO)).rejects.toThrow(/requesterUserId/);
    // Fails closed: no row is stored referencing a stranger, because nothing inside
    // `production_db` could ever check that (there is no foreign key across databases).
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses self-approval — the rule is about the ROW\'s two roles (M-5b §5.6)', async () => {
    const { service, repository } = build();

    await expect(
      service.create(ACTOR, { ...CREATE_DTO, approverUserId: REQUESTER })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();

    // A DELEGATE case: the caller is somebody else entirely, and the check still has to
    // fire because the two stored roles are equal.
    await expect(
      service.create({ ...ACTOR, userId: 'user-somebody-else' }, {
        ...CREATE_DTO,
        requesterUserId: 'user-x',
        approverUserId: 'user-x',
      })
    ).rejects.toThrow(/self-approval/i);
  });

  it('audits the created row — the stored values, not the intent', async () => {
    const { service, audit } = build();

    const view = await service.create(ACTOR, CREATE_DTO);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [recordedActor, act] = audit.record.mock.calls[0];
    expect(recordedActor).toBe(ACTOR);
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_AUDIT_ACTION.CREATE,
      resource: 'production.bom',
      resourceId: BOM_ID,
    });
    expect(view.id).toBe(BOM_ID);
    expect(view.status).toBe('DRAFT');
  });
});

describe('BomHeaderService.list and getOne', () => {
  it('scopes the page by the actor tenant and returns the window it used', async () => {
    const { service, repository } = build();

    const page = await service.list(ACTOR, { page: 2, pageSize: 5, status: 'DRAFT' });

    expect(repository.list).toHaveBeenCalledWith(TENANT, {
      skip: 5,
      take: 5,
      status: 'DRAFT',
      search: undefined,
    });
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 5 });
    expect(page.items).toHaveLength(1);
  });

  it('clamps a page size above the ceiling in the SERVICE as well as the DTO', async () => {
    const { service, repository } = build();

    await service.list(ACTOR, { pageSize: 100000 });

    // The DTO refuses this at the edge; this is the guarantee an internal caller that
    // builds its own query object cannot escape.
    expect(repository.list.mock.calls[0][1].take).toBe(100);
  });

  it('answers 404 for a row that is not this tenant\'s, indistinguishably from absent', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(null);

    await expect(service.getOne(ACTOR, BOM_ID)).rejects.toBeInstanceOf(NotFoundException);
    // The tenant travelled with the id — that is the whole difference.
    expect(repository.findById).toHaveBeenCalledWith(TENANT, BOM_ID);
  });

describe('BomHeaderService.update', () => {
  it('patches a DRAFT, trims the title and audits the before/after pair', async () => {
    const { service, repository, audit } = build();

    const view = await service.update(ACTOR, BOM_ID, { title: '  renamed  ' });

    expect(repository.updateDraft).toHaveBeenCalledWith(TENANT, BOM_ID, { title: 'renamed' });
    expect(view.title).toBe('renamed');
    const [, act] = audit.record.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_AUDIT_ACTION.UPDATE,
      changedFields: ['title'],
      oldValue: { title: 'BOM for project 42' },
      newValue: { title: 'renamed' },
    });
  });

  it('refuses an empty patch: a mutation that changed nothing must not be audited', async () => {
    const { service, repository, audit } = build();

    await expect(service.update(ACTOR, BOM_ID, {})).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(repository.updateDraft).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to edit anything but a DRAFT, naming the CURRENT status', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(row({ status: 'SUBMITTED' }));

    await expect(service.update(ACTOR, BOM_ID, { title: 'x' })).rejects.toBeInstanceOf(
      ConflictException
    );
    await expect(service.update(ACTOR, BOM_ID, { title: 'x' })).rejects.toThrow(/SUBMITTED/);
    expect(repository.updateDraft).not.toHaveBeenCalled();
  });

  it('re-checks a re-chosen approver against membership AND the row\'s own requester', async () => {
    const { service, repository, directory } = build();

    await service.update(ACTOR, BOM_ID, { approverUserId: 'user-new-approver' });
    expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, 'user-new-approver');

    // A non-member is refused before the write, exactly as at create.
    repository.updateDraft.mockClear();
    directory.findTenantMember.mockResolvedValue(null);
    await expect(
      service.update(ACTOR, BOM_ID, { approverUserId: 'user-ghost' })
    ).rejects.toThrow(/approverUserId/);
    expect(repository.updateDraft).not.toHaveBeenCalled();

    // Self-approval compares the NEW approver against the ROW's requester — not against
    // whoever happened to call the route.
    directory.findTenantMember.mockResolvedValue({ id: 'any' });
    await expect(
      service.update({ ...ACTOR, userId: 'user-somebody-else' }, BOM_ID, {
        approverUserId: REQUESTER,
      })
    ).rejects.toThrow(/self-approval/i);
  });

  it('turns a lost conditional write into a 409 carrying the CURRENT status', async () => {
    const { service, repository, audit } = build();
    repository.updateDraft.mockResolvedValue(null);
    // The row was submitted by a concurrent request between the read and the write.
    repository.findById
      .mockResolvedValueOnce(row({ status: 'DRAFT' }))
      .mockResolvedValueOnce(row({ status: 'SUBMITTED' }));

    await expect(service.update(ACTOR, BOM_ID, { title: 'x' })).rejects.toThrow(/SUBMITTED/);
    // Nothing succeeded, so nothing is recorded as having succeeded.
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BomHeaderService.submit', () => {
  it('re-verifies the approver at the freeze point, then audits the transition', async () => {
    const { service, repository, directory, audit } = build();

    const view = await service.submit(ACTOR, BOM_ID);

    // Between create and submit a person can leave the tenant; the row must never be
    // routed to somebody who can no longer act.
    expect(directory.findTenantMember).toHaveBeenCalledWith(TENANT, APPROVER);
    // Phase B2.4: submit now passes an outbox payload as the 4th argument.
    expect(repository.submit).toHaveBeenCalledWith(
      TENANT, BOM_ID, null, expect.objectContaining({ tenantId: TENANT }),
    );
    expect(view.status).toBe('SUBMITTED');
    // Phase B2.4: the durable events use buildOutboxPayload instead of audit.record.
    const [, act] = audit.buildOutboxPayload.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_AUDIT_ACTION.SUBMIT,
      changedFields: ['status', 'submittedAt'],
    });
  });

  it('refuses to submit anything but a DRAFT, and writes nothing', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(row({ status: 'APPROVED' }));

    await expect(service.submit(ACTOR, BOM_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it('refuses to route to an approver who is no longer a tenant member', async () => {
    const { service, repository, directory } = build();
    directory.findTenantMember.mockResolvedValue(null);

    await expect(service.submit(ACTOR, BOM_ID)).rejects.toThrow(/approverUserId/);
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it('refuses to submit an EMPTY BOM with a typed code, and leaves it a DRAFT', async () => {
    const { service, repository, audit } = build();
    // The repository's `items: { some: {} }` predicate matched nothing, so the conditional
    // write lost — and the re-read still shows DRAFT, which is exactly how this service
    // distinguishes "no items" from "someone else already routed it".
    repository.submit.mockResolvedValue(null);
    repository.findById
      .mockResolvedValueOnce(row({ status: 'DRAFT' }))
      .mockResolvedValueOnce(row({ status: 'DRAFT' }));

    const error = await service.submit(ACTOR, BOM_ID).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: PRODUCTION_BOM_ERROR_CODES.ITEMS_REQUIRED,
      message: expect.stringContaining('at least one item'),
    });
    // A refused submit is not a transition: nothing is audited, and the reason it was
    // refused is a domain code rather than a sentence the UI would have to match on.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('turns a lost conditional write into a 409 instead of a second submission', async () => {
    const { service, repository } = build();
    repository.submit.mockResolvedValue(null);
    repository.findById
      .mockResolvedValueOnce(row({ status: 'DRAFT' }))
      .mockResolvedValueOnce(row({ status: 'SUBMITTED' }));

    await expect(service.submit(ACTOR, BOM_ID)).rejects.toThrow(/SUBMITTED/);
  });
});


describe('BomHeaderService.decide', () => {
  const submitted = () =>
    row({ status: 'SUBMITTED', submittedAt: new Date('2026-01-03T00:00:00.000Z') });

  it('refuses a body that states a different outcome than the route stands for', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(submitted());

    // The reject endpoint cannot produce an APPROVED row even if a client sends one: the
    // endpoint decides the outcome and the body only confirms which of the three it meant.
    await expect(
      service.decide({ ...ACTOR, userId: APPROVER }, BOM_ID, 'REJECTED', {
        opinion: 'APPROVED',
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('refuses anyone but the SNAPSHOTTED approver — including a machine caller', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(submitted());

    await expect(
      service.decide({ ...ACTOR, userId: 'user-somebody-else' }, BOM_ID, 'APPROVED', {
        opinion: 'APPROVED',
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    // A `null` actor id is refused BY CONSTRUCTION: it cannot equal a stored id, so no
    // separate branch is needed for a non-human caller.
    await expect(
      service.decide({ ...ACTOR, userId: null }, BOM_ID, 'APPROVED', {
        opinion: 'APPROVED',
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('records the decision on a SUBMITTED row and audits the before/after pair', async () => {
    const { service, repository, audit } = build();
    repository.findById.mockResolvedValue(submitted());

    const view = await service.decide({ ...ACTOR, userId: APPROVER }, BOM_ID, 'APPROVED', {
      opinion: 'APPROVED',
      comments: 'ok',
    });

    // Phase B2.4: decide now passes an outbox payload as the 5th argument.
    expect(repository.decide).toHaveBeenCalledWith(TENANT, BOM_ID, 'SUBMITTED', {
      status: 'APPROVED',
      managerOpinion: 'APPROVED',
      comments: 'ok',
      decidedByUserId: APPROVER,
    }, expect.objectContaining({ tenantId: TENANT }));
    expect(view.status).toBe('APPROVED');
    // Phase B2.4: the durable events use buildOutboxPayload instead of audit.record.
    const [, act] = audit.buildOutboxPayload.mock.calls[0];
    expect(act).toMatchObject({
      action: PRODUCTION_BOM_AUDIT_ACTION.APPROVE,
      changedFields: ['status', 'managerOpinion', 'decidedAt', 'decidedByUserId'],
    });
  });

  it('returns a corrected BOM to DRAFT while still recording the decision', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(submitted());
    repository.decide.mockResolvedValue(
      row({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION', decidedAt: new Date() })
    );

    const view = await service.decide(
      { ...ACTOR, userId: APPROVER },
      BOM_ID,
      'NEEDS_CORRECTION',
      { opinion: 'NEEDS_CORRECTION' }
    );

    // Back to the EDITABLE state — the legacy `نیاز به اصلاح` branch wrote `State = 0` —
    // but `managerOpinion` is set, so "returned for correction" stays distinguishable
    // from "never submitted" without a fifth state.
    expect(view.status).toBe('DRAFT');
    expect(view.managerOpinion).toBe('NEEDS_CORRECTION');
    expect(repository.decide.mock.calls[0][3].status).toBe('DRAFT');
  });

  it('refuses to decide anything that is not SUBMITTED, and writes nothing', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(row({ status: 'DRAFT' }));

    await expect(
      service.decide({ ...ACTOR, userId: APPROVER }, BOM_ID, 'APPROVED', {
        opinion: 'APPROVED',
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.decide).not.toHaveBeenCalled();
  });

  it('turns a lost conditional decision into a 409, so two deciders cannot both win', async () => {
    const { service, repository, audit } = build();
    repository.findById
      .mockResolvedValueOnce(submitted())
      .mockResolvedValueOnce(row({ status: 'APPROVED', managerOpinion: 'APPROVED' }));
    repository.decide.mockResolvedValue(null);

    await expect(
      service.decide({ ...ACTOR, userId: APPROVER }, BOM_ID, 'APPROVED', {
        opinion: 'APPROVED',
      })
    ).rejects.toThrow(/APPROVED/);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('toBomHeaderView', () => {
  it('projects the stored row and nothing else — no derived field, no label', () => {
    const view = toBomHeaderView(
      row({ submittedAt: new Date('2026-01-03T00:00:00.000Z'), managerOpinion: 'APPROVED' })
    );

    expect(Object.keys(view).sort()).toEqual([
      'approverUserId',
      'comments',
      'createdAt',
      'decidedAt',
      'decidedByUserId',
      'id',
      'managerOpinion',
      'productTreeRef',
      'projectRef',
      'requesterUserId',
      'status',
      'submittedAt',
      'title',
      'updatedAt',
    ]);
    // Instants are ISO strings on the wire, and an unset instant is `null` — never a
    // fabricated date, which would claim a decision nobody made.
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view.submittedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(view.decidedAt).toBeNull();
    expect(view.decidedByUserId).toBeNull();
  });
});

});

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the ONE read of the platform audit trail this
 * module exposes.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE QUERY IS EXACTLY FOUR-FIELDS-PLUS-WINDOW. `tenantId` from the actor,
 *     `resource` from the closed constant, `resourceId` from the tenant-resolved row,
 *     plus `page`/`pageSize`. An extra key would be a second opinion about what a
 *     platform read means — an `action` filter nobody asked for, an `orderBy` the
 *     contract has no parameter for, or a caller-influenced scope.
 *  2. EXISTENCE IS CHECKED FIRST AND A FOREIGN ID IS A 404, with the audit port NEVER
 *     reached. Otherwise the timeline becomes an oracle answering "does this BOM exist
 *     in some tenant?".
 *  3. EMPTY IS NOT FAILED, AND A REJECTION IS NOT EMPTY. `ok` with zero items and
 *     `rejected` are opposite answers; rendering the second as the first would tell a
 *     reader "nothing happened" when the truth is "we could not ask".
 *  4. THE PROJECTION IS A WHITELIST OF SEVEN FIELDS, and every field the contract calls
 *     absent-by-construction must not survive it.
 *  5. THE ORDER IS THE CONTRACT'S (`createdAt ASC, id ASC`) AND IS NEVER REVERSED HERE.
 *
 * The doubles are structural: the repository and the audit gateway are plain objects, so
 * these specs exercise the orchestration without a database, a Nest container, or
 * another owner's client.
 */

const TIMELINE_EVENT = {
  id: '22222222-2222-4222-8222-222222222222',
  resource: 'production.bom',
  resourceId: BOM_ID,
  action: 'create',
  actorId: 'user-requester',
  success: true,
  reason: null,
  changedFields: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function timelineOk(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    page: { items, page: 1, pageSize: 20, total: items.length, ...overrides },
  };
}

describe('BomHeaderService.getTimeline — scope binding', () => {
  it('issues EXACTLY the bound fields and nothing else', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(timelineOk([]));

    await service.getTimeline(ACTOR, BOM_ID, {});

    expect(audit.read).toHaveBeenCalledTimes(1);
    const query = audit.read.mock.calls[0][0];

    // The exact key set: an added `action`, `from`, `to`, `orderBy` or `resource` filter
    // would widen a read the platform deliberately keeps narrow.
    expect(Object.keys(query).sort()).toEqual([
      'page',
      'pageSize',
      'resource',
      'resourceId',
      'tenantId',
    ]);
    expect(query).toEqual({
      tenantId: TENANT,
      resource: 'production.bom',
      resourceId: BOM_ID,
      page: 1,
      pageSize: 20,
    });
  });

  it('always reads the HEADER resource and never the item resource', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(timelineOk([]));

    await service.getTimeline(ACTOR, BOM_ID, {});

    const query = audit.read.mock.calls[0][0];
    expect(query.resource).toBe('production.bom');
    // The item family is keyed by the ITEM's own id, so it cannot be correlated to a BOM
    // through this contract (hard-deleted ids are unrecoverable). Querying it here would
    // either return another BOM's events or nothing at all.
    expect(query.resource).not.toBe('production.bom.item');
  });

  it('resolves the window from the MODULE pair: defaults 1/20, ceiling 100', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(timelineOk([]));

    await service.getTimeline(ACTOR, BOM_ID, {});
    expect(audit.read.mock.calls[0][0]).toMatchObject({ page: 1, pageSize: 20 });

    await service.getTimeline(ACTOR, BOM_ID, { page: 3, pageSize: 50 });
    expect(audit.read.mock.calls[1][0]).toMatchObject({ page: 3, pageSize: 50 });

    // The GUARANTEE half of the two-bounds rule: even a caller that bypassed the DTO
    // cannot exceed the platform's own ceiling.
    await service.getTimeline(ACTOR, BOM_ID, { pageSize: 9999 });
    expect(audit.read.mock.calls[2][0]).toMatchObject({ pageSize: 100 });

    // Absurd values clamp UP to the floor rather than producing a non-positive page or a
    // `pageSize: 0` the platform would reject as invalid — the same floor
    // `resolveProductionPageWindow` applies to the header list.
    await service.getTimeline(ACTOR, BOM_ID, { page: 0, pageSize: 0 });
    expect(audit.read.mock.calls[3][0]).toMatchObject({ page: 1, pageSize: 1 });
  });

  it('refuses a BOM this tenant does not own WITHOUT reaching the audit port', async () => {
    const { service, repository, audit } = build();
    repository.findById.mockResolvedValue(null);

    await expect(service.getTimeline(ACTOR, BOM_ID, {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    // The tenant travelled with the id — and the trail was never asked about a row the
    // caller could not prove was theirs. An empty page here would have been a lie.
    expect(repository.findById).toHaveBeenCalledWith(TENANT, BOM_ID);
    expect(audit.read).not.toHaveBeenCalled();
  });
});

describe('BomHeaderService.getTimeline — the page', () => {
  it('answers an empty timeline as ok with items: [] and the platform total', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(timelineOk([], { total: 0 }));

    const page = await service.getTimeline(ACTOR, BOM_ID, {});

    // EMPTY IS NOT FAILED: the two states mean opposite things, so this one must not be
    // an exception — and the rejection below must never look like this.
    expect(page).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  it('returns multiple events in the platform order, chronological and unreversed', async () => {
    const { service, audit } = build();
    // The contract's own order is `createdAt ASC, id ASC`. The service must not sort,
    // reverse or re-page it — presenting "newest first" is the VIEW's decision.
    audit.read.mockResolvedValue(
      timelineOk([
        { ...TIMELINE_EVENT, id: 'e1', action: 'create', createdAt: '2026-01-01T00:00:00.000Z' },
        { ...TIMELINE_EVENT, id: 'e2', action: 'submit', createdAt: '2026-01-02T00:00:00.000Z' },
        {
          ...TIMELINE_EVENT,
          id: 'e3',
          action: 'approve',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ])
    );

    const page = await service.getTimeline(ACTOR, BOM_ID, {});

    expect(page.items.map((item) => item.action)).toEqual(['create', 'submit', 'approve']);
    expect(page.items.map((item) => item.createdAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ]);
    // The envelope echoes the RESOLVED window and the platform's count — never a count
    // this module computed.
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 3 });
  });

  it('passes pagination through and keeps the envelope aligned with the request', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(
      timelineOk([{ ...TIMELINE_EVENT, id: 'e4' }], { page: 2, pageSize: 5, total: 7 })
    );

    const page = await service.getTimeline(ACTOR, BOM_ID, {
      page: 2,
      pageSize: 5,
    });

    expect(audit.read.mock.calls[0][0]).toMatchObject({ page: 2, pageSize: 5 });
    expect(page).toEqual({
      items: [expect.objectContaining({ id: 'e4' })],
      page: 2,
      pageSize: 5,
      total: 7,
    });
  });
});

describe('BomHeaderService.getTimeline — the projection', () => {
  it('exposes exactly the seven whitelisted fields and nothing the platform item carries', async () => {
    const { service, audit } = build();
    // The platform item arrives carrying `resource`/`resourceId` too, and — in this DOUBLE
    // — every field the contract calls absent-by-construction. They are present on purpose,
    // so a spread-through would be CAUGHT rather than assumed away.
    audit.read.mockResolvedValue(
      timelineOk([
        {
          ...TIMELINE_EVENT,
          tenantId: 'tenant-OTHER',
          ip: '10.0.0.1',
          userAgent: 'leak',
          sessionId: 's-1',
          requestId: 'req-x',
          correlationId: 'corr-x',
          oldValue: { secret: 'before' },
          newValue: { secret: 'after' },
          changes: { password: 'hunter2' },
        },
      ])
    );

    const page = await service.getTimeline(ACTOR, BOM_ID, {});
    const item = page.items[0];

    expect(Object.keys(item).sort()).toEqual([
      'action',
      'actorId',
      'changedFields',
      'createdAt',
      'id',
      'reason',
      'success',
    ]);

    // Belt and braces: the excluded values must not merely be absent from the KEY list,
    // they must not appear anywhere in the serialised entry — that is the difference
    // between a projection and a filter that forgot a nested key.
    const serialised = JSON.stringify(item);
    for (const forbidden of [
      'tenant-OTHER',
      '10.0.0.1',
      'leak',
      'hunter2',
      'before',
      'after',
      'production.bom',
      BOM_ID,
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('keeps `action` as the raw audit vocabulary and never invents a label', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue(
      timelineOk([{ ...TIMELINE_EVENT, action: 'request_correction' }])
    );

    const page = await service.getTimeline(ACTOR, BOM_ID, {});

    // The API stores and returns the fact; the Persian sentence is the UI's mapping. A
    // rewritten action here would be a second vocabulary for one event — and the trail
    // would stop matching what the platform recorded.
    expect(page.items[0].action).toBe('request_correction');
    expect(page.items[0].actorId).toBe('user-requester');
    expect(page.items[0].success).toBe(true);
    expect(page.items[0].reason).toBeNull();
    expect(page.items[0].changedFields).toEqual([]);
  });
});

describe('BomHeaderService.getTimeline — a rejected read', () => {
  it('maps AUDIT_READ_FAILED to a 503 and never to an empty page', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_FAILED' });

    await expect(service.getTimeline(ACTOR, BOM_ID, {})).rejects.toMatchObject({
      status: 503,
      response: { code: 'AUDIT_READ_FAILED' },
    });
  });

  it('maps a caller-fault code to a 422 rather than swallowing it', async () => {
    const { service, audit } = build();
    // Unreachable through the route — the DTO validates the window and the service binds
    // the scope — but mapped per P-AUDIT-READ rather than silently ignored, because a
    // rejection is never a quiet empty timeline.
    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_PAGE_INVALID' });

    await expect(service.getTimeline(ACTOR, BOM_ID, {})).rejects.toMatchObject({
      status: 422,
      response: { code: 'AUDIT_READ_PAGE_INVALID' },
    });
  });

  it('never renders a rejection as items: []', async () => {
    const { service, audit } = build();
    audit.read.mockResolvedValue({ status: 'rejected', code: 'AUDIT_READ_FAILED' });

    const settled = await service.getTimeline(ACTOR, BOM_ID, {}).then(
      (value) => ({ resolved: value }),
      (error) => ({ rejected: error })
    );

    // The distinction the whole design turns on: "nothing recorded" and "we could not ask"
    // must not be the same response.
    expect(settled).not.toHaveProperty('resolved');
    expect(settled).toHaveProperty('rejected');
    expect((settled as { rejected: { status: number } }).rejected.status).toBe(503);
  });
});
