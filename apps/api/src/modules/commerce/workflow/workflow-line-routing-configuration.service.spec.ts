import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkflowLineRoutingConfigurationService } from './workflow-line-routing-configuration.service';
import { WorkflowLineRoutingRepository } from './workflow-line-routing.repository';
import { WorkflowExecutionRepository } from './workflow-execution.repository';
import type { WorkflowPinnedVersionRow } from './workflow-execution.repository';
import type {
  CreateLineRoutingVersionDto,
  ListLineRoutingVersionsQueryDto,
} from './workflow-line-routing.dto';
import type { WorkflowLineRoutingVersion } from '../../../generated/commerce-client';

function routingRow(
  overrides: Partial<WorkflowLineRoutingVersion> = {}
): WorkflowLineRoutingVersion {
  return {
    id: 'rv-1',
    tenantId: 't1',
    status: 'DRAFT',
    versionLabel: 'v1',
    trigger: 'PURCHASE_SUBMITTED',
    noRouteBehavior: 'REJECT_OPERATION',
    multipleMatchBehavior: 'HIGHEST_PRIORITY',
    aggregationPolicy: 'INDEPENDENT',
    routeRules: [
      {
        priority: 10,
        targetWorkflowDefinitionVersionId: 'v-standard',
        condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
      },
    ],
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as WorkflowLineRoutingVersion;
}

describe('WorkflowLineRoutingConfigurationService', () => {
  let service: WorkflowLineRoutingConfigurationService;
  let routingRepository: jest.Mocked<WorkflowLineRoutingRepository>;
  let executionRepository: jest.Mocked<WorkflowExecutionRepository>;

  beforeEach(async () => {
    routingRepository = {
      findById: jest.fn(),
      publish: jest.fn(),
      // PHASE C3 (GAP-2): the three collaborators the configuration surface composes.
      create: jest.fn(),
      findByLabel: jest.fn(),
      listPage: jest.fn(),
    } as unknown as jest.Mocked<WorkflowLineRoutingRepository>;

    executionRepository = {
      findPublishedVersion: jest.fn(),
    } as unknown as jest.Mocked<WorkflowExecutionRepository>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkflowLineRoutingConfigurationService,
        { provide: WorkflowLineRoutingRepository, useValue: routingRepository },
        { provide: WorkflowExecutionRepository, useValue: executionRepository },
      ],
    }).compile();

    service = moduleRef.get(WorkflowLineRoutingConfigurationService);
  });

  it('publishes a valid routing version', async () => {
    const row = routingRow();
    routingRepository.findById.mockResolvedValue(row);
    executionRepository.findPublishedVersion.mockResolvedValue({
      workflowDefinitionVersionId: 'v-standard',
      versionLabel: '1.0.0',
      parallelJoinPolicy: 'ALL',
      definitionCode: 'PURCHASE_APPROVAL',
      definitionName: 'Purchase Approval',
      steps: [
        {
          id: 'step-1',
          stepKey: 'approve',
          displayName: 'Approve',
          mandatory: true,
          executionMode: 'SEQUENTIAL',
          ordering: 1,
          parallelGroup: null,
          condition: null,
          onConditionFalse: null,
          actorSource: 'CONFIGURED_USER',
          actorUserId: 'user-1',
          actorRoleCode: null,
        },
      ],
    } as unknown as WorkflowPinnedVersionRow);
    routingRepository.publish.mockResolvedValue({
      ...row,
      status: 'PUBLISHED',
    } as unknown as WorkflowLineRoutingVersion);

    const result = await service.publish('t1', 'rv-1');

    expect(result.status).toBe('PUBLISHED');
    expect(routingRepository.publish).toHaveBeenCalledWith('t1', 'rv-1');
  });

  it('refuses to publish an already published version', async () => {
    routingRepository.findById.mockResolvedValue(routingRow({ status: 'PUBLISHED' }));

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses an unsupported trigger', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        trigger: 'PURCHASE_CREATED' as unknown as WorkflowLineRoutingVersion['trigger'],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses an unsupported no-route behavior', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        noRouteBehavior: 'IGNORE' as unknown as WorkflowLineRoutingVersion['noRouteBehavior'],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses an unsupported multiple-match behavior', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        multipleMatchBehavior:
          'FIRST' as unknown as WorkflowLineRoutingVersion['multipleMatchBehavior'],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses an unsupported aggregation policy', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        aggregationPolicy:
          'ANY_APPROVED' as unknown as WorkflowLineRoutingVersion['aggregationPolicy'],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses empty routeRules', async () => {
    routingRepository.findById.mockResolvedValue(routingRow({ routeRules: [] }));

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses a route with a disallowed fact', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        routeRules: [
          {
            priority: 10,
            targetWorkflowDefinitionVersionId: 'v-standard',
            condition: { field: 'rogueFact', op: 'equals', value: 'x' },
          },
        ],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses a route pointing to a missing target version', async () => {
    routingRepository.findById.mockResolvedValue(routingRow());
    executionRepository.findPublishedVersion.mockResolvedValue(null);

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses a route pointing to a workflow with unsupported actor source', async () => {
    routingRepository.findById.mockResolvedValue(routingRow());
    executionRepository.findPublishedVersion.mockResolvedValue({
      workflowDefinitionVersionId: 'v-standard',
      versionLabel: '1.0.0',
      parallelJoinPolicy: 'ALL',
      definitionCode: 'PURCHASE_APPROVAL',
      definitionName: 'Purchase Approval',
      steps: [
        {
          id: 'step-1',
          stepKey: 'approve',
          displayName: 'Approve',
          mandatory: true,
          executionMode: 'SEQUENTIAL',
          ordering: 1,
          parallelGroup: null,
          condition: null,
          onConditionFalse: null,
          actorSource: 'COMMERCIAL_LIAISON',
          actorUserId: null,
          actorRoleCode: null,
        },
      ],
    } as unknown as WorkflowPinnedVersionRow);

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('refuses to publish a version with an invalid rule set', async () => {
    routingRepository.findById.mockResolvedValue(
      routingRow({
        routeRules: [
          {
            priority: 10,
            targetWorkflowDefinitionVersionId: '',
            condition: { field: 'lineType', op: 'equals', value: 'STANDARD' },
          },
        ],
      })
    );

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(ConflictException);
  });

  it('throws NotFoundException for an unknown version id', async () => {
    routingRepository.findById.mockResolvedValue(null);

    await expect(service.publish('t1', 'rv-1')).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// PHASE C3 (GAP-2): the configuration surface — create, list, read, publish —
// composed OVER the domain the C1/O suite above already pins. Every test here
// proves two things at once: the operation works, and it reaches for nothing
// the repository and the existing publish gate do not already own.
// ---------------------------------------------------------------------------
describe('Phase C3 GAP-2 — the configuration surface', () => {
  const actor = {
    tenantId: 't1',
    userId: 'u1',
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  } as never;

  let service: WorkflowLineRoutingConfigurationService;
  let routingRepository: jest.Mocked<WorkflowLineRoutingRepository>;
  let executionRepository: jest.Mocked<WorkflowExecutionRepository>;

  const createDto = (overrides: Record<string, unknown> = {}) =>
    ({
      versionLabel: '  1404-02  ',
      trigger: 'PURCHASE_SUBMITTED',
      noRouteBehavior: 'LEAVE_UNROUTED',
      multipleMatchBehavior: 'HIGHEST_PRIORITY',
      aggregationPolicy: 'INDEPENDENT',
      routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: 'v-standard' }],
      ...overrides,
    }) as unknown as CreateLineRoutingVersionDto;

  beforeEach(async () => {
    routingRepository = {
      findById: jest.fn(),
      publish: jest.fn(),
      create: jest.fn(),
      findByLabel: jest.fn(),
      listPage: jest.fn(),
    } as unknown as jest.Mocked<WorkflowLineRoutingRepository>;
    executionRepository = {
      findPublishedVersion: jest.fn(),
    } as unknown as jest.Mocked<WorkflowExecutionRepository>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkflowLineRoutingConfigurationService,
        { provide: WorkflowLineRoutingRepository, useValue: routingRepository },
        { provide: WorkflowExecutionRepository, useValue: executionRepository },
      ],
    }).compile();

    service = moduleRef.get(WorkflowLineRoutingConfigurationService);
  });

  it('opens a DRAFT for the ACTING tenant, trims the label, and answers with a view without the tenant', async () => {
    routingRepository.findByLabel.mockResolvedValue(null);
    routingRepository.create.mockResolvedValue(
      routingRow({ id: 'rv-9', status: 'DRAFT', versionLabel: '1404-02' })
    );

    const view = await service.createVersion(actor, createDto());

    // The tenant comes from the ACTOR and nowhere else, and the label is the caller's own
    // text trimmed — never a scope statement.
    expect(routingRepository.findByLabel).toHaveBeenCalledWith('t1', '1404-02');
    expect(routingRepository.create).toHaveBeenCalledWith('t1', {
      status: 'DRAFT',
      versionLabel: '1404-02',
      trigger: 'PURCHASE_SUBMITTED',
      noRouteBehavior: 'LEAVE_UNROUTED',
      multipleMatchBehavior: 'HIGHEST_PRIORITY',
      aggregationPolicy: 'INDEPENDENT',
      routeRules: [{ priority: 1, targetWorkflowDefinitionVersionId: 'v-standard' }],
    });
    expect(view.id).toBe('rv-9');
    expect(view.status).toBe('DRAFT');
    expect(view).not.toHaveProperty('tenantId');
  });

  it('refuses a label this tenant already uses, before anything is written', async () => {
    routingRepository.findByLabel.mockResolvedValue(routingRow({ versionLabel: '1404-02' }));

    const error = await service.createVersion(actor, createDto()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN',
    });
    expect(routingRepository.create).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only or over-long label at the service, whatever the boundary saw', async () => {
    routingRepository.findByLabel.mockResolvedValue(null);

    await expect(service.createVersion(actor, createDto({ versionLabel: '   ' }))).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.createVersion(actor, createDto({ versionLabel: 'L'.repeat(65) }))
    ).rejects.toThrow(BadRequestException);
    expect(routingRepository.create).not.toHaveBeenCalled();
  });

  it('lists one page for the tenant, resolving the module window and clamping its ceiling', async () => {
    routingRepository.listPage.mockResolvedValue([[routingRow({ id: 'rv-1' })], 1]);

    const page = await service.listVersions(actor, {
      page: 2,
      pageSize: 999_999,
    } as ListLineRoutingVersionsQueryDto);

    // The DTO is the CONTRACT; this clamp is the GUARANTEE for internal callers too.
    expect(routingRepository.listPage).toHaveBeenCalledWith(
      't1',
      { search: undefined },
      { page: 2, pageSize: 100, skip: 100, take: 100 }
    );
    expect(page).toMatchObject({ page: 2, pageSize: 100, total: 1 });
    expect(page.items[0]).not.toHaveProperty('tenantId');
  });

  it('passes the identifying-column search through to the repository query', async () => {
    routingRepository.listPage.mockResolvedValue([[], 0]);

    await service.listVersions(actor, {
      page: 1,
      pageSize: 20,
      search: '1404',
    } as ListLineRoutingVersionsQueryDto);

    expect(routingRepository.listPage).toHaveBeenCalledWith(
      't1',
      { search: '1404' },
      expect.anything()
    );
  });

  it('reads one version for the tenant, and 404s one this tenant does not have', async () => {
    routingRepository.findById.mockResolvedValue(routingRow());
    const view = await service.getVersion(actor, 'rv-1');
    expect(routingRepository.findById).toHaveBeenCalledWith('t1', 'rv-1');
    expect(view.id).toBe('rv-1');
    expect(view).not.toHaveProperty('tenantId');

    routingRepository.findById.mockResolvedValue(null);
    await expect(service.getVersion(actor, 'rv-1')).rejects.toThrow(NotFoundException);
  });

  it('publishes through the EXISTING gate — delegating, never re-implementing the walk', async () => {
    const row = routingRow();
    routingRepository.findById.mockResolvedValue(row);
    executionRepository.findPublishedVersion.mockResolvedValue({
      workflowDefinitionVersionId: 'v-standard',
      versionLabel: '1.0.0',
      parallelJoinPolicy: 'ALL',
      definitionCode: 'PURCHASE_APPROVAL',
      definitionName: 'Purchase Approval',
      steps: [
        {
          id: 'step-1',
          stepKey: 'approve',
          displayName: 'Approve',
          mandatory: true,
          executionMode: 'SEQUENTIAL',
          ordering: 1,
          parallelGroup: null,
          condition: null,
          onConditionFalse: null,
          actorSource: 'CONFIGURED_USER',
          actorUserId: 'user-1',
          actorRoleCode: null,
        },
      ],
    } as unknown as WorkflowPinnedVersionRow);
    routingRepository.publish.mockResolvedValue({ ...row, status: 'PUBLISHED' });

    const view = await service.publishVersion(actor, 'rv-1');

    // The HTTP face calls the SAME repository writes the C1/O suite pins — the validation
    // ran (targets were checked), and the answer is the server's resulting state.
    expect(executionRepository.findPublishedVersion).toHaveBeenCalledWith('t1', 'v-standard');
    expect(routingRepository.publish).toHaveBeenCalledWith('t1', 'rv-1');
    expect(view).toMatchObject({ id: 'rv-1', status: 'PUBLISHED' });
    expect(view).not.toHaveProperty('tenantId');
  });

  it('carries the gate’s own refusals to the wire: unknown id 404, published version 409', async () => {
    routingRepository.findById.mockResolvedValue(null);
    await expect(service.publishVersion(actor, 'rv-1')).rejects.toThrow(NotFoundException);
    expect(routingRepository.publish).not.toHaveBeenCalled();

    routingRepository.findById.mockResolvedValue(routingRow({ status: 'PUBLISHED' }));
    const error = await service.publishVersion(actor, 'rv-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED',
    });
    expect(routingRepository.publish).not.toHaveBeenCalled();
  });
});
