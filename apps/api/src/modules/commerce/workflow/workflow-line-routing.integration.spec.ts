import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PureRuleEngineModule } from '../../../rules/pure-rule-engine.module';
import { WorkflowLineRoutingService } from './workflow-line-routing.service';
import { WorkflowLineRoutingRepository } from './workflow-line-routing.repository';
import { WorkflowExecutionRepository } from './workflow-execution.repository';
import type { WorkflowPinnedVersionRow } from './workflow-execution.repository';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { CommerceActor } from '../commerce-actor';
import { CommerceTransactionHandle } from '../database/commerce-transaction';
import type { WorkflowLineRoutingVersion } from '../../../generated/commerce-client';
import type { WorkflowInstance } from '../../../generated/commerce-client';

const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'user-1',
  requestId: 'r1',
  ip: null,
  userAgent: null,
};

const document = {
  id: 'doc-1',
  kind: 'PURCHASE_REQUEST' as const,
  currency: 'IRR',
  supplierId: null,
  requesterId: 'user-1',
  subtotalAmount: { toString: () => '100.0000' },
  taxAmount: { toString: () => '10.0000' },
  totalAmount: { toString: () => '110.0000' },
  lineRoutingVersionId: null as string | null,
  lines: [
    {
      id: 'line-1',
      lineType: 'STANDARD' as const,
      lineNumber: 1,
      quantity: { toString: () => '1.0000' },
      unit: 'kg',
      unitPrice: { toString: () => '100.0000' },
      tax: { toString: () => '10.0000' },
      lineTotal: { toString: () => '110.0000' },
      itemReference: null,
      externalRef: null,
      technicalDescription: null,
    },
  ],
};

const documentV2 = {
  ...document,
  lines: [
    {
      ...document.lines[0],
      id: 'line-2',
      lineType: 'SERVICE' as const,
    },
  ],
};

function publishedVersion(targetVersionId: string): WorkflowPinnedVersionRow {
  return {
    workflowDefinitionVersionId: targetVersionId,
    versionLabel: '1.0.0',
    parallelJoinPolicy: 'ALL',
    definitionCode: 'PURCHASE_APPROVAL',
    definitionName: 'Purchase Approval',
    steps: [
      {
        id: 'ws-1',
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
      } as unknown,
    ],
  } as unknown as WorkflowPinnedVersionRow;
}

function routingConfig(
  targetVersionId: string,
  lineTypeValue: string = 'STANDARD'
): WorkflowLineRoutingVersion {
  return {
    id: 'rv-1',
    tenantId: 't1',
    status: 'PUBLISHED',
    versionLabel: 'v1',
    trigger: 'PURCHASE_SUBMITTED',
    noRouteBehavior: 'LEAVE_UNROUTED',
    multipleMatchBehavior: 'HIGHEST_PRIORITY',
    aggregationPolicy: 'INDEPENDENT',
    routeRules: [
      {
        priority: 10,
        targetWorkflowDefinitionVersionId: targetVersionId,
        condition: { field: 'lineType', op: 'equals', value: lineTypeValue },
      },
    ],
  } as unknown as WorkflowLineRoutingVersion;
}

describe('WorkflowLineRoutingService integration', () => {
  let service: WorkflowLineRoutingService;
  let routingRepository: jest.Mocked<WorkflowLineRoutingRepository>;
  let executionRepository: jest.Mocked<WorkflowExecutionRepository>;

  beforeEach(async () => {
    routingRepository = {
      findPublishedForTrigger: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<WorkflowLineRoutingRepository>;

    executionRepository = {
      findPublishedVersion: jest.fn(),
      findInstanceBySubject: jest.fn().mockResolvedValue(null),
      createInstance: jest.fn().mockImplementation((_tenantId, _tx, input) =>
        Promise.resolve({
          id: `wi-${input.workflowDefinitionVersionId}`,
        } as unknown as WorkflowInstance)
      ),
      createStepInstances: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkflowExecutionRepository>;

    const moduleRef = await Test.createTestingModule({
      imports: [PureRuleEngineModule],
      providers: [
        WorkflowLineRoutingService,
        { provide: WorkflowLineRoutingRepository, useValue: routingRepository },
        { provide: WorkflowExecutionRepository, useValue: executionRepository },
        {
          provide: CommerceIdentityGateway,
          useValue: { assertMember: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CommerceAuditGateway,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CommerceNotificationGateway,
          useValue: { publish: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = moduleRef.get(WorkflowLineRoutingService);
  });

  it('pins Line A to WorkflowDefinitionVersion V1', async () => {
    routingRepository.findPublishedForTrigger.mockResolvedValue(routingConfig('v1'));
    executionRepository.findPublishedVersion.mockResolvedValue(publishedVersion('v1'));

    const result = await service.routeLinesForDocument(
      actor,
      document,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );

    expect(result.createdInstances).toHaveLength(1);
    expect(executionRepository.createInstance).toHaveBeenCalledWith(
      't1',
      expect.anything(),
      expect.objectContaining({ workflowDefinitionVersionId: 'v1' })
    );
  });

  it('keeps V1 for Line A and lets Line B route to V2', async () => {
    routingRepository.findPublishedForTrigger
      .mockResolvedValueOnce(routingConfig('v1'))
      .mockResolvedValueOnce(routingConfig('v2', 'SERVICE'));
    executionRepository.findPublishedVersion
      .mockResolvedValueOnce(publishedVersion('v1'))
      .mockResolvedValueOnce(publishedVersion('v2'));

    const resultA = await service.routeLinesForDocument(
      actor,
      document,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );
    const resultB = await service.routeLinesForDocument(
      actor,
      documentV2,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );

    expect(resultA.createdInstances[0].instanceId).toBe('wi-v1');
    expect(resultB.createdInstances[0].instanceId).toBe('wi-v2');
  });

  it('prevents duplicate workflow instances for the same line', async () => {
    routingRepository.findPublishedForTrigger.mockResolvedValue(routingConfig('v1'));
    executionRepository.findPublishedVersion.mockResolvedValue(publishedVersion('v1'));
    executionRepository.findInstanceBySubject
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'wi-v1' } as unknown as WorkflowInstance);

    await service.routeLinesForDocument(
      actor,
      document,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );

    await expect(
      service.routeLinesForDocument(
        actor,
        document,
        'PURCHASE_SUBMITTED',
        {} as unknown as CommerceTransactionHandle
      )
    ).rejects.toThrow(ConflictException);
  });

  it('returns routing version id and aggregation policy', async () => {
    routingRepository.findPublishedForTrigger.mockResolvedValue(routingConfig('v1'));
    executionRepository.findPublishedVersion.mockResolvedValue(publishedVersion('v1'));

    const result = await service.routeLinesForDocument(
      actor,
      document,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );

    expect(result.routingVersionId).toBe('rv-1');
    expect(result.aggregationPolicy).toBe('INDEPENDENT');
  });

  it('uses the pinned routing version when lineRoutingVersionId is set', async () => {
    const pinned = routingConfig('v1');
    routingRepository.findById.mockResolvedValue(pinned);
    executionRepository.findPublishedVersion.mockResolvedValue(publishedVersion('v1'));

    const pinnedDocument = { ...document, lineRoutingVersionId: 'rv-1' };
    const result = await service.routeLinesForDocument(
      actor,
      pinnedDocument,
      'PURCHASE_SUBMITTED',
      {} as unknown as CommerceTransactionHandle
    );

    expect(routingRepository.findPublishedForTrigger).not.toHaveBeenCalled();
    expect(routingRepository.findById).toHaveBeenCalledWith('t1', 'rv-1');
    expect(result.routingVersionId).toBe('rv-1');
    expect(result.aggregationPolicy).toBe('INDEPENDENT');
  });
});
