import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import type { CommerceIdentityGateway } from '../commerce-identity.gateway';
import type { WorkflowConfigurationRepository } from './workflow-configuration.repository';
import {
  WORKFLOW_AUDIT_ACTION,
  WorkflowConfigurationService,
} from './workflow-configuration.service';

/** The repository double: every method this spec drives, as a recording jest mock. */
type WorkflowConfigurationRepositoryMock = {
  createDefinition: jest.Mock;
  findDefinitionByCode: jest.Mock;
  findDefinition: jest.Mock;
  listDefinitionPage: jest.Mock;
  renameDefinition: jest.Mock;
  createVersion: jest.Mock;
  findVersionByLabel: jest.Mock;
  findVersion: jest.Mock;
  listVersionPage: jest.Mock;
  transitionVersion: jest.Mock;
  createStep: jest.Mock;
  findStep: jest.Mock;
  updateStep: jest.Mock;
  deleteStep: jest.Mock;
  reorderSteps: jest.Mock;
};

/**
 * Phase C1 Step M (§5.5–§5.8, §11): the configuration APPLICATION layer, at its own seam.
 *
 * THE REPOSITORY IS FAKED AND THE GATEWAYS ARE RECORDING SPIES, so every assertion here is about a
 * DECISION rather than about SQL: which writes happen, in what order, what is refused before
 * anything is written, and which level the walk was asked at. The rules that would otherwise be
 * invisible until production are each one test:
 *
 *  * the TENANT comes from the actor and is the repository's first argument on every call — there is
 *    no shape of these calls that reaches another tenant's rows;
 *  * `tenantId` NEVER REACHES A RESPONSE: the projections drop it, because a caller must not receive
 *    a field it never sent;
 *  * a version that is not a DRAFT is refused BEFORE any write, and a conditional write that matched
 *    nothing is a 409 rather than a silent success;
 *  * authoring writes are checked at `DRAFT` and the two lifecycle acts at `PUBLISH` — the level is
 *    the ACT's, never the caller's;
 *  * a refused validation writes NOTHING and audits NOTHING, while every successful mutation audits
 *    exactly once against the VERSION that owns it;
 *  * the ONE Core identity a step may name is verified, and only for the source that names one;
 *  * `publishedAt` is stated by the publish transition alone, and archiving leaves it alone.
 *
 * The call log is the mocks' own `.mock.calls` (the reason `purchase.service.spec.ts` records): a
 * `push` written inside a mock whose return value the test replaces would stop recording exactly
 * when the assertion needs it.
 */

const ACTOR: CommerceActor = {
  tenantId: 't1',
  userId: 'u1',
  requestId: 'r1',
  correlationId: 'c1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

/** One step row as the repository returns it — tenant included, because it must not escape. */
function storedStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    tenantId: 't1',
    workflowDefinitionVersionId: 'v1',
    stepKey: 'check-budget',
    displayName: 'Check budget',
    mandatory: true,
    executionMode: 'SEQUENTIAL',
    ordering: 1,
    parallelGroup: null,
    condition: null,
    actorSource: null,
    actorUserId: null,
    actorRoleCode: null,
    actorRule: null,
    thresholds: null,
    lineFilters: null,
    configuration: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** One version row WITH its steps, in the stated order. */
function storedVersion(overrides: Record<string, unknown> = {}) {
  const steps =
    (overrides.steps as ReturnType<typeof storedStep>[] | undefined) ?? [storedStep()];
  return {
    id: 'v1',
    tenantId: 't1',
    workflowDefinitionId: 'd1',
    versionLabel: 'v1',
    status: 'DRAFT',
    publishedAt: null,
    triggerEvent: null,
    parallelJoinPolicy: null,
    selectionPriority: null,
    selectionCondition: null,
    definition: { code: 'standard-purchase' },
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
    steps,
  };
}

/** One definition row, with the version count its list renders. */
function storedDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    tenantId: 't1',
    code: 'standard-purchase',
    name: 'Standard',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    _count: { versions: 1 },
    ...overrides,
  };
}

/**
 * The service with fakes, and the DEFAULTS stated once: nothing found, no page, a conditional write
 * that won, and a verification that passes. A test overrides the ONE mock it cares about.
 */
function build() {
  const repository: WorkflowConfigurationRepositoryMock = {
    createDefinition: jest.fn(),
    findDefinitionByCode: jest.fn(),
    findDefinition: jest.fn(),
    listDefinitionPage: jest.fn(),
    renameDefinition: jest.fn(),
    createVersion: jest.fn(),
    findVersionByLabel: jest.fn(),
    findVersion: jest.fn(),
    listVersionPage: jest.fn(),
    transitionVersion: jest.fn(),
    createStep: jest.fn(),
    findStep: jest.fn(),
    updateStep: jest.fn(),
    deleteStep: jest.fn(),
    reorderSteps: jest.fn(),
  };

  const audit = { record: jest.fn() };
  const identity = { assertMember: jest.fn(), profilesFor: jest.fn() };

  repository.createDefinition.mockResolvedValue(storedDefinition());
  repository.findDefinitionByCode.mockResolvedValue(null);
  repository.findDefinition.mockResolvedValue(storedDefinition());
  repository.listDefinitionPage.mockResolvedValue([[], 0]);
  repository.renameDefinition.mockResolvedValue(1);
  repository.createVersion.mockResolvedValue(storedVersion({ steps: undefined }));
  repository.findVersionByLabel.mockResolvedValue(null);
  repository.findVersion.mockResolvedValue(storedVersion());
  repository.listVersionPage.mockResolvedValue([[], 0]);
  repository.transitionVersion.mockResolvedValue(1);
  repository.createStep.mockResolvedValue(storedStep());
  repository.findStep.mockResolvedValue(storedStep());
  repository.updateStep.mockResolvedValue(1);
  repository.deleteStep.mockResolvedValue(1);
  repository.reorderSteps.mockResolvedValue(1);
  audit.record.mockResolvedValue(undefined);
  identity.assertMember.mockResolvedValue(undefined);

  const service = new WorkflowConfigurationService(
    repository as unknown as WorkflowConfigurationRepository,
    audit as unknown as CommerceAuditGateway,
    identity as unknown as CommerceIdentityGateway
  );

  return {
    service,
    repository,
    audit,
    identity,
    calls: {
      createDefinition: repository.createDefinition.mock.calls,
      listDefinitionPage: repository.listDefinitionPage.mock.calls,
      renameDefinition: repository.renameDefinition.mock.calls,
      createVersion: repository.createVersion.mock.calls,
      listVersionPage: repository.listVersionPage.mock.calls,
      transitionVersion: repository.transitionVersion.mock.calls,
      createStep: repository.createStep.mock.calls,
      updateStep: repository.updateStep.mock.calls,
      deleteStep: repository.deleteStep.mock.calls,
      reorderSteps: repository.reorderSteps.mock.calls,
      audit: audit.record.mock.calls,
      assertMember: identity.assertMember.mock.calls,
      profilesFor: identity.profilesFor.mock.calls,
    },
  };
}

describe('Phase C1 Step M — definitions (the container)', () => {
  it('creates the container for the ACTING tenant, trimming both labels, and audits the ROW', async () => {
    const { service, repository, calls } = build();
    // The ROW the write returns is what the answer AND the trail carry, so the fake returns a row
    // whose stored label differs from the request's: an implementation that audited the intent
    // would fail below.
    const row = storedDefinition();
    repository.createDefinition.mockResolvedValue(row);

    const created = await service.createDefinition(ACTOR, {
      code: '  standard-purchase  ',
      name: '  Standard purchase  ',
    });

    expect(calls.createDefinition).toEqual([
      ['t1', { code: 'standard-purchase', name: 'Standard purchase' }],
    ]);
    // The audit carries the ROW the repository returned, never the intent that produced it: the
    // trail states the stored label, which the request's own text need not match.
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION,
      resourceId: 'd1',
      newValue: row,
    });
    // And the tenant the row is scoped by is NOT part of the answer.
    expect(created).not.toHaveProperty('tenantId');
    expect(created).toEqual({
      id: 'd1',
      code: 'standard-purchase',
      name: 'Standard',
      versionCount: 1,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('refuses a code this tenant already uses, and writes nothing', async () => {
    const { service, repository, calls } = build();
    repository.findDefinitionByCode.mockResolvedValue(storedDefinition());

    await expect(service.createDefinition(ACTOR, { code: 'standard', name: 'x' })).rejects.toThrow(
      ConflictException
    );
    expect(calls.createDefinition).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('checks the LABEL the caller stated, before it reaches the database', async () => {
    const { service, calls } = build();

    await expect(service.createDefinition(ACTOR, { code: '   ', name: 'x' })).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.createDefinition(ACTOR, { code: 'c'.repeat(65), name: 'x' })
    ).rejects.toThrow(BadRequestException);
    expect(calls.createDefinition).toEqual([]);
  });

  it('answers with a 404 for a definition this tenant does not have', async () => {
    const { service, repository } = build();
    repository.findDefinition.mockResolvedValue(null);

    await expect(service.getDefinition(ACTOR, 'd1')).rejects.toThrow(NotFoundException);
  });

  it('pages the tenant’s definitions, echoes the window, and CLAMPS an absurd page size', async () => {
    const { service, repository, calls } = build();
    repository.listDefinitionPage.mockResolvedValue([[storedDefinition()], 1]);

    const page = await service.listDefinitions(ACTOR, { pageSize: 5000 });

    // 100 is `COMMERCE_MAX_PAGE_SIZE`: the DTO is the CONTRACT, this clamp is the GUARANTEE.
    expect(calls.listDefinitionPage[0]).toEqual([
      't1',
      { search: undefined },
      { page: 1, pageSize: 100, skip: 0, take: 100 },
    ]);
    expect(page).toEqual({
      items: [
        {
          id: 'd1',
          code: 'standard-purchase',
          name: 'Standard',
          versionCount: 1,
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      ],
      page: 1,
      pageSize: 100,
      total: 1,
    });
  });

  it('renames the container, auditing OLD and NEW, and answers 404 for a vanished row', async () => {
    const { service, repository, calls } = build();

    const renamed = await service.renameDefinition(ACTOR, 'd1', { name: '  Renamed  ' });

    expect(calls.renameDefinition).toEqual([['t1', 'd1', 'Renamed']]);
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.RENAME,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION,
      oldValue: { name: 'Standard' },
      newValue: { name: 'Standard' },
      changedFields: ['name'],
    });
    expect(renamed).not.toHaveProperty('tenantId');

    // The row was read a moment ago and the update matched nothing: it is gone, not renamed.
    repository.renameDefinition.mockResolvedValue(0);
    await expect(service.renameDefinition(ACTOR, 'd1', { name: 'Renamed' })).rejects.toThrow(
      NotFoundException
    );
  });
});

describe('Phase C1 Step M — versions, reads and the edit guards', () => {
  it('opens a DRAFT under a definition of THIS tenant, and audits the version; a foreign container is 404', async () => {
    const { service, repository, calls } = build();

    const created = await service.createVersion(ACTOR, 'd1', { versionLabel: ' 1404-01 ' });

    expect(calls.createVersion).toEqual([
      [
        't1',
        'd1',
        {
          versionLabel: '1404-01',
          triggerEvent: null,
          parallelJoinPolicy: null,
          selectionPriority: null,
          selectionCondition: null,
        },
      ],
    ]);
    expect(created).toMatchObject({ id: 'v1', status: 'DRAFT' });
    expect(created).not.toHaveProperty('tenantId');
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: 'v1',
    });

    repository.findDefinition.mockResolvedValue(null);
    await expect(service.createVersion(ACTOR, 'd1', { versionLabel: 'v2' })).rejects.toThrow(
      NotFoundException
    );
  });

  it('refuses a version label the definition already uses, and writes nothing', async () => {
    const { service, repository, calls } = build();
    repository.findVersionByLabel.mockResolvedValue(storedVersion({ steps: undefined }));

    await expect(service.createVersion(ACTOR, 'd1', { versionLabel: 'v1' })).rejects.toThrow(
      ConflictException
    );
    expect(calls.createVersion).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('lists a definition’s versions with their step counts, passing the status filter through', async () => {
    const { service, repository, calls } = build();
    repository.listVersionPage.mockResolvedValue([
      [{ ...storedVersion({ steps: undefined }), _count: { steps: 3 } }],
      1,
    ]);

    const page = await service.listVersions(ACTOR, 'd1', { status: 'DRAFT' });

    // The tenant and the definition are the SCOPE, never fields of the query.
    expect(calls.listVersionPage[0]).toEqual([
      't1',
      'd1',
      { status: 'DRAFT' },
      { page: 1, pageSize: 20, skip: 0, take: 20 },
    ]);
    expect(page.items).toEqual([
      {
        id: 'v1',
        workflowDefinitionId: 'd1',
        versionLabel: 'v1',
        status: 'DRAFT',
        triggerEvent: null,
        parallelJoinPolicy: null,
        selectionPriority: null,
        selectionCondition: null,
        publishedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        stepCount: 3,
      },
    ]);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 1 });
  });

  it('C8: forwards the shared `search` filter — and only the filter — to the version list', async () => {
    const { service, repository, calls } = build();
    repository.listVersionPage.mockResolvedValue([
      [{ ...storedVersion({ steps: undefined }), _count: { steps: 0 } }],
      1,
    ]);

    await service.listVersions(ACTOR, 'd1', {
      status: 'DRAFT',
      search: '1405',
    });

    // The tenant and the definition stay the SCOPE — never fields of the query — while
    // `search` arrives as the one filter the repository narrows `versionLabel` with. The
    // window is unchanged, so adding a filter did not move a single page boundary.
    expect(calls.listVersionPage[0]).toEqual([
      't1',
      'd1',
      { status: 'DRAFT', search: '1405' },
      { page: 1, pageSize: 20, skip: 0, take: 20 },
    ]);
  });

  it('C8: with no search the version list is the unfiltered read it was before', async () => {
    const { service, repository, calls } = build();
    repository.listVersionPage.mockResolvedValue([[], 0]);

    await service.listVersions(ACTOR, 'd1', {});

    expect(calls.listVersionPage[0][0]).toBe('t1');
    expect(calls.listVersionPage[0][1]).toBe('d1');
    // `search` is present-but-undefined rather than absent: the repository's predicate
    // spreads on the VALUE, so both shapes build the identical `where`, and no other key
    // (status, tenant, sort) is invented on the way through.
    expect(calls.listVersionPage[0][2]).toEqual({ status: undefined, search: undefined });
    expect(calls.listVersionPage[0][3]).toEqual({
      page: 1,
      pageSize: 20,
      skip: 0,
      take: 20,
    });
  });

  it('reads one version WITH its steps — and neither the tenant nor the version id a step belongs to', async () => {
    const { service } = build();

    const version = await service.getVersion(ACTOR, 'v1');

    expect(version).toMatchObject({ id: 'v1', status: 'DRAFT' });
    expect(version).not.toHaveProperty('tenantId');
    expect(version.steps).toHaveLength(1);
    expect(version.steps[0]).not.toHaveProperty('tenantId');
    // The step's OWNER is the route's path; repeating it inside every step would be noise a client
    // could get wrong.
    expect(version.steps[0]).not.toHaveProperty('workflowDefinitionVersionId');
  });

  it('validates a COMPLETE draft at PUBLISH level, walking DRAFT → VALIDATED exactly once', async () => {
    const { service, repository, calls } = build();
    const complete = [storedStep({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1' })];
    repository.findVersion
      .mockResolvedValueOnce(storedVersion({ triggerEvent: 'PURCHASE_SUBMITTED', steps: complete }))
      .mockResolvedValue(
        storedVersion({ status: 'VALIDATED', triggerEvent: 'PURCHASE_SUBMITTED', steps: complete })
      );

    const validated = await service.validateVersion(ACTOR, 'v1');

    expect(calls.transitionVersion[0]).toEqual(['t1', 'v1', 'DRAFT', 'VALIDATED', null]);
    expect(validated.status).toBe('VALIDATED');
    // The trail is written from the RE-READ row, so it describes what happened.
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.VALIDATE,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: 'v1',
      oldValue: { status: 'DRAFT', publishedAt: null },
      newValue: { status: 'VALIDATED', publishedAt: null },
      changedFields: ['status'],
    });
  });

  it('refuses to validate a version that is not a DRAFT, before anything is written', async () => {
    const { service, repository, calls } = build();
    repository.findVersion.mockResolvedValue(
      storedVersion({
        status: 'PUBLISHED',
        steps: [storedStep({ actorSource: 'REQUESTER_MANAGER' })],
      })
    );

    await expect(service.validateVersion(ACTOR, 'v1')).rejects.toThrow(ConflictException);
    expect(calls.transitionVersion).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses an INCOMPLETE body with the walk’s report, and records nothing', async () => {
    const { service, repository, calls } = build();
    // A step whose actor source is unstated: legal while authoring, refused at PUBLISH — the level
    // BOTH lifecycle acts are checked at.
    repository.findVersion.mockResolvedValue(storedVersion());

    await expect(service.validateVersion(ACTOR, 'v1')).rejects.toThrow(BadRequestException);
    expect(calls.transitionVersion).toEqual([]);
    expect(calls.audit).toEqual([]);
  });
});

describe('Phase C1 Step M — publication and withdrawal', () => {
  const PUBLISHED_AT = new Date('2026-09-10T00:00:00.000Z');

  it('publishes a VALIDATED version stating `publishedAt` ONCE, then archives WITHOUT clearing it', async () => {
    const { service, repository, calls } = build();
    const complete = [storedStep({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1' })];
    repository.findVersion
      .mockResolvedValueOnce(
        storedVersion({ status: 'VALIDATED', triggerEvent: 'PURCHASE_SUBMITTED', steps: complete })
      )
      .mockResolvedValueOnce(
        storedVersion({
          status: 'PUBLISHED',
          publishedAt: PUBLISHED_AT,
          triggerEvent: 'PURCHASE_SUBMITTED',
          steps: complete,
        })
      )
      .mockResolvedValueOnce(
        storedVersion({
          status: 'PUBLISHED',
          publishedAt: PUBLISHED_AT,
          triggerEvent: 'PURCHASE_SUBMITTED',
          steps: complete,
        })
      )
      .mockResolvedValue(
        storedVersion({
          status: 'ARCHIVED',
          publishedAt: PUBLISHED_AT,
          triggerEvent: 'PURCHASE_SUBMITTED',
          steps: complete,
        })
      );

    const published = await service.publishVersion(ACTOR, 'v1');

    const [tenantId, versionId, from, to, publishedAt] = calls.transitionVersion[0];
    expect([tenantId, versionId, from, to]).toEqual(['t1', 'v1', 'VALIDATED', 'PUBLISHED']);
    expect(publishedAt).toBeInstanceOf(Date);
    expect(published.status).toBe('PUBLISHED');
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.PUBLISH,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: 'v1',
      newValue: { status: 'PUBLISHED', publishedAt: expect.any(Date) },
    });

    const archived = await service.archiveVersion(ACTOR, 'v1');

    // NO instant is passed here: the one a version entered force stays true after it leaves force.
    expect(calls.transitionVersion[1]).toEqual(['t1', 'v1', 'PUBLISHED', 'ARCHIVED', null]);
    expect(archived.status).toBe('ARCHIVED');
    expect(calls.audit[1][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.ARCHIVE,
      resourceId: 'v1',
    });
  });

  it('refuses to publish anything but a VALIDATED version, and to archive anything but a PUBLISHED one', async () => {
    const { service, repository, calls } = build();
    const complete = [storedStep({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1' })];

    repository.findVersion.mockResolvedValue(
      storedVersion({ status: 'DRAFT', triggerEvent: 'PURCHASE_SUBMITTED', steps: complete })
    );
    await expect(service.publishVersion(ACTOR, 'v1')).rejects.toThrow(ConflictException);

    repository.findVersion.mockResolvedValue(
      storedVersion({ status: 'VALIDATED', triggerEvent: 'PURCHASE_SUBMITTED', steps: complete })
    );
    await expect(service.archiveVersion(ACTOR, 'v1')).rejects.toThrow(ConflictException);

    expect(calls.transitionVersion).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('answers 409 — never a silent success — when the conditional write matched nothing', async () => {
    const { service, repository, calls } = build();
    repository.findVersion.mockResolvedValue(
      storedVersion({
        status: 'VALIDATED',
        triggerEvent: 'PURCHASE_SUBMITTED',
        steps: [storedStep({ actorSource: 'CONFIGURED_USER', actorUserId: 'u1' })],
      })
    );
    repository.transitionVersion.mockResolvedValue(0);

    await expect(service.publishVersion(ACTOR, 'v1')).rejects.toThrow(ConflictException);
    expect(calls.audit).toEqual([]);
  });

  it('carries NO event publisher: a configuration act emits nothing yet (§21)', () => {
    // The absences this slice is built on, stated once: three collaborators — the repository, the
    // audit gateway and the identity gateway — and no publisher. That is why no test above spies on
    // an event, and §I9's stream begins with execution, in step N.
    expect(WorkflowConfigurationService.length).toBe(3);
  });
});

describe('Phase C1 Step M — the step writes', () => {
  /** A step that collides with NOTHING the stored version states (it holds `check-budget` at 1). */
  const NEW_STEP = {
    stepKey: 'approve-manager',
    displayName: 'Manager approval',
    ordering: 2,
    actorSource: 'REQUESTER_MANAGER' as const,
  };

  it('adds a step with the schema’s DEFAULTS applied, auditing the row the repository returned', async () => {
    const { service, calls } = build();

    const added = await service.addStep(ACTOR, 'v1', NEW_STEP);

    // `mandatory` true and `executionMode` SEQUENTIAL are applied by the SERVICE, so the stored row
    // reads as the author meant it without a reader knowing what the DDL would have filled in.
    expect(calls.createStep[0][0]).toBe('t1');
    expect(calls.createStep[0][1]).toBe('v1');
    expect(calls.createStep[0][2]).toMatchObject({
      stepKey: 'approve-manager',
      displayName: 'Manager approval',
      mandatory: true,
      executionMode: 'SEQUENTIAL',
      ordering: 2,
      actorSource: 'REQUESTER_MANAGER',
      condition: null,
      thresholds: null,
    });
    expect(calls.audit[0][1]).toMatchObject({
      action: WORKFLOW_AUDIT_ACTION.ADD_STEP,
      resourceId: 'v1',
      newValue: expect.objectContaining({ id: 'step-1' }),
    });
    expect(added).not.toHaveProperty('tenantId');
  });

  it('refuses a step whose KEY or POSITION the version already states, before anything is written', async () => {
    const { service, calls } = build();

    // The candidate set is the version WITH this step, so both collisions are visible HERE rather
    // than at the unique index afterwards.
    await expect(
      service.addStep(ACTOR, 'v1', { ...NEW_STEP, stepKey: 'check-budget' })
    ).rejects.toThrow(ConflictException);
    await expect(service.addStep(ACTOR, 'v1', { ...NEW_STEP, ordering: 1 })).rejects.toThrow(
      ConflictException
    );

    expect(calls.createStep).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it('refuses a malformed step as a 400 — a blank key, and a mode outside the vocabulary', async () => {
    const { service, calls } = build();

    await expect(service.addStep(ACTOR, 'v1', { ...NEW_STEP, stepKey: '   ' })).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.addStep(ACTOR, 'v1', { ...NEW_STEP, executionMode: 'PARALEL' as never })
    ).rejects.toThrow(BadRequestException);
    expect(calls.createStep).toEqual([]);
  });

  it('verifies the ONE Core identity a CONFIGURED_USER step names — and no other source', async () => {
    const { service, calls } = build();

    await service.addStep(ACTOR, 'v1', {
      ...NEW_STEP,
      actorSource: 'CONFIGURED_USER',
      actorUserId: 'someone',
    });

    expect(calls.assertMember).toEqual([[ACTOR, 'someone']]);

    // A role CODE is Core's fact (§7) and a rule resolver's approver is decided at decision time,
    // so neither is a membership check this slice may make.
    const other = build();
    await other.service.addStep(ACTOR, 'v1', {
      ...NEW_STEP,
      actorSource: 'CONFIGURED_ROLE',
      actorRoleCode: 'ROLE_BUYER',
    });
    expect(other.calls.assertMember).toEqual([]);
  });

  it('answers 409 when the insert found the version no longer editable', async () => {
    const { service, repository, calls } = build();
    repository.createStep.mockResolvedValue(null);

    await expect(service.addStep(ACTOR, 'v1', NEW_STEP)).rejects.toThrow(ConflictException);
    expect(calls.audit).toEqual([]);
  });
});
