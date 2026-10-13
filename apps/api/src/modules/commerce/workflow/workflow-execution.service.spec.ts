import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkflowExecutionService } from './workflow-execution.service';
import { WorkflowExecutionRepository } from './workflow-execution.repository';
import { WorkflowLineRoutingService } from './workflow-line-routing.service';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { CommerceActor } from '../commerce-actor';
import { CommercialLifecycleService } from '../commercial/commercial-lifecycle.service';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import type {
  WorkflowInstanceDetailRow,
  WorkflowPinnedVersionRow,
} from './workflow-execution.repository';

type FoundPurchaseDocument = NonNullable<
  Awaited<ReturnType<PurchaseRepository['findDocumentById']>>
>;

describe('WorkflowExecutionService', () => {
  let service: WorkflowExecutionService;
  let executionRepository: jest.Mocked<WorkflowExecutionRepository>;
  let lineRouting: jest.Mocked<WorkflowLineRoutingService>;
  let purchaseRepository: jest.Mocked<PurchaseRepository>;
  let unitOfWork: CommerceUnitOfWork;
  /** Kept at this scope so a test can steer what a group's own condition answers (§9.2). */
  let ruleEngine: { evaluateSync: jest.Mock };
  let identity: { assertMember: jest.Mock };
  let commercial: { onWorkflowSettled: jest.Mock };
  // GAP-9: the user-addressed surface, recorded — the recipient RESOLUTION is this
  // service's (and is what these tests assert); the gateway's own contract is pinned by
  // commerce-notification.gateway.spec.ts.
  let notification: { notifyUsers: jest.Mock };

  const actor: CommerceActor = {
    tenantId: 't1',
    userId: 'user-1',
    requestId: 'r1',
    ip: null,
    userAgent: null,
  };

  const mockTx = {} as unknown as CommerceTransactionHandle;

  beforeEach(async () => {
    executionRepository = {
      findInstanceDetail: jest.fn(),
      findPinnedVersion: jest.fn(),
      recordStepDecision: jest.fn().mockResolvedValue(1),
      skipPendingStepInstances: jest.fn().mockResolvedValue(0),
      settleInstance: jest.fn().mockResolvedValue(1),
      createStepInstances: jest.fn().mockResolvedValue(1),
      listInstancePage: jest.fn().mockResolvedValue([[], 0]),
    } as unknown as jest.Mocked<WorkflowExecutionRepository>;

    lineRouting = {
      routeLinesForDocument: jest.fn().mockResolvedValue({
        documentId: 'doc-1',
        trigger: 'AFTER_DOCUMENT_WORKFLOW_APPROVED',
        createdInstances: [{ lineId: 'line-1', instanceId: 'wi-2' }],
        unroutedLineIds: [],
        // GAP-9: the line-routing pass resolves an approver for the line it routed; the
        // default states one so the APPROVED-settle path's recipient is asserted below,
        // and a test that wants none can override.
        pendingApproverUserIds: ['line-approver'],
      }),
    } as unknown as jest.Mocked<WorkflowLineRoutingService>;

    purchaseRepository = {
      findDocumentById: jest.fn(),
    } as unknown as jest.Mocked<PurchaseRepository>;

    unitOfWork = {
      run: jest
        .fn()
        .mockImplementation(async (work: (tx: CommerceTransactionHandle) => Promise<unknown>) =>
          work(mockTx)
        ),
    } as unknown as CommerceUnitOfWork;

    // Step P's settle dispatch (§4): recorded, never evaluated — the commercial
    // lifecycle has its own suite and must not run inside the workflow's.
    commercial = {
      onWorkflowSettled: jest.fn().mockResolvedValue([]),
    };

    // §9.2's advance: the activation set is evaluated for the group that becomes active next.
    // Every step without a condition of its own answers TRUE, which is what the real engine
    // returns for the file's unconditional leaf. A test may re-answer for one group.
    ruleEngine = {
      evaluateSync: jest.fn((ruleSet: { rules: readonly { id: string }[] }) => ({
        status: 'EVALUATED',
        matchHistory: ruleSet.rules.map((rule) => ({
          ruleId: rule.id,
          conditionOutcome: 'TRUE',
          missingFields: [],
        })),
      })),
    };

    identity = {
      assertMember: jest.fn().mockResolvedValue(undefined),
    };

    notification = {
      notifyUsers: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkflowExecutionService,
        { provide: WorkflowExecutionRepository, useValue: executionRepository },
        { provide: WorkflowLineRoutingService, useValue: lineRouting },
        { provide: PurchaseRepository, useValue: purchaseRepository },
        { provide: CommerceUnitOfWork, useValue: unitOfWork },
        { provide: CommercialLifecycleService, useValue: commercial },
        { provide: RuleEngineService, useValue: ruleEngine },
        { provide: CommerceIdentityGateway, useValue: identity },
        { provide: CommerceNotificationGateway, useValue: notification },
      ],
    }).compile();

    service = moduleRef.get(WorkflowExecutionService);
  });

  function documentWorkflowInstance() {
    return {
      id: 'wi-1',
      tenantId: 't1',
      status: 'RUNNING',
      subjectType: 'PURCHASE_DOCUMENT',
      subjectId: 'doc-1',
      workflowDefinitionVersionId: 'v-doc-1',
      version: {
        versionLabel: '1.0.0',
        parallelJoinPolicy: 'ALL',
        definition: { code: 'PURCHASE_APPROVAL', name: 'Purchase Approval' },
      },
      steps: [
        {
          id: 'si-1',
          workflowStepId: 'ws-1',
          scopeType: 'DOCUMENT',
          scopeId: 'doc-1',
          status: 'PENDING',
          resolvedApproverId: 'user-1',
          decision: null,
          decisionComment: null,
          decidedAt: null,
          conditionResult: true,
          conditionInputSnapshot: {},
          conditionRuleSetId: 'rs-1',
          conditionRuleVersion: 'v-doc-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          stepDefinition: {
            stepKey: 'manager_approval',
            displayName: 'Manager Approval',
            executionMode: 'SEQUENTIAL',
            ordering: 1,
            mandatory: true,
            onConditionFalse: null,
          },
        },
      ],
    } as unknown as WorkflowInstanceDetailRow;
  }

  function pinnedVersion() {
    return {
      workflowDefinitionVersionId: 'v-doc-1',
      versionLabel: '1.0.0',
      parallelJoinPolicy: 'ALL',
      definitionCode: 'PURCHASE_APPROVAL',
      definitionName: 'Purchase Approval',
      steps: [
        {
          id: 'ws-1',
          stepKey: 'manager_approval',
          displayName: 'Manager Approval',
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
    } as unknown as WorkflowPinnedVersionRow;
  }

  it('approves the last step, settles the document workflow APPROVED and triggers line routing', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());
    purchaseRepository.findDocumentById.mockResolvedValue({
      id: 'doc-1',
      kind: 'PURCHASE_REQUEST',
      currency: 'IRR',
      supplierId: null,
      requesterId: 'user-1',
      subtotalAmount: { toString: () => '100.0000' },
      taxAmount: { toString: () => '10.0000' },
      totalAmount: { toString: () => '110.0000' },
      lines: [
        {
          id: 'line-1',
          lineType: 'STANDARD',
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
    } as unknown as FoundPurchaseDocument);

    const result = await service.approveStep(actor, 'wi-1', 'manager_approval', 'ok');

    expect(result.status).toBe('APPROVED');
    expect(executionRepository.recordStepDecision).toHaveBeenCalled();
    expect(executionRepository.settleInstance).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      status: 'APPROVED',
    });
    expect(lineRouting.routeLinesForDocument).toHaveBeenCalledWith(
      actor,
      expect.anything(),
      'AFTER_DOCUMENT_WORKFLOW_APPROVED',
      mockTx
    );
  });

  it('refuses approval when the acting user is not the resolved approver', async () => {
    const instance = documentWorkflowInstance();
    instance.steps[0].resolvedApproverId = 'user-2';
    executionRepository.findInstanceDetail.mockResolvedValue(instance);
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

    await expect(service.approveStep(actor, 'wi-1', 'manager_approval')).rejects.toThrow(
      BadRequestException
    );
  });

  it('refuses approval when the instance is not running', async () => {
    const instance = documentWorkflowInstance();
    instance.status = 'APPROVED';
    executionRepository.findInstanceDetail.mockResolvedValue(instance);
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

    // PHASE C2's refusal class: a STATE refusal (the run is no longer running) is the
    // module's 409 conflict, with the planner's named code travelling intact — the actor
    // refusal above stays 400, exactly as step N's e2e verifies it.
    await expect(service.approveStep(actor, 'wi-1', 'manager_approval')).rejects.toThrow(
      ConflictException
    );
  });

  // -------------------------------------------------------------------------
  // §9.2 regression: the sequential advance.
  //
  // OBSERVED IN THIS SESSION, end to end: deciding group 1 returned 201 while the run's second
  // step then refused with WORKFLOW_STEP_NOT_ACTIONABLE ("has no instance"), because nothing
  // ever wrote the rows for group 2 -- `createStepInstances` had exactly one caller, at instance
  // birth. The unit suite had no coverage of this transition; these are that coverage.
  // -------------------------------------------------------------------------

  /** A two-group sequential version: group 1 'planning', then group 2 'commercial'. */
  function sequentialVersion(options: { commercialOnFalse?: 'TERMINATED' } = {}) {
    return {
      workflowDefinitionVersionId: 'v-doc-1',
      versionLabel: '1.0.0',
      parallelJoinPolicy: 'ALL',
      definitionCode: 'PURCHASE_APPROVAL',
      definitionName: 'Purchase Approval',
      steps: [
        {
          id: 'ws-1',
          stepKey: 'planning',
          displayName: 'Planning',
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
        {
          id: 'ws-2',
          stepKey: 'commercial',
          displayName: 'Commercial',
          mandatory: true,
          executionMode: 'SEQUENTIAL',
          ordering: 2,
          parallelGroup: null,
          condition: null,
          onConditionFalse: options.commercialOnFalse ?? null,
          actorSource: 'CONFIGURED_USER',
          actorUserId: 'user-2',
          actorRoleCode: null,
        },
      ],
    } as unknown as WorkflowPinnedVersionRow;
  }

  /**
   * The run itself, with an explicit row state per group. `'ABSENT'` is what group 2 is in
   * until group 1 completes -- no reader may ever see a partially activated group.
   */
  function sequentialInstance(states: {
    planning: 'PENDING' | 'APPROVED';
    commercial?: 'PENDING';
  }) {
    const row = (
      id: string,
      stepKey: string,
      ordering: number,
      approverId: string,
      status: string
    ) => ({
      id,
      workflowStepId: stepKey === 'planning' ? 'ws-1' : 'ws-2',
      scopeType: 'DOCUMENT',
      scopeId: 'doc-1',
      status,
      resolvedApproverId: approverId,
      decision: status === 'APPROVED' ? 'APPROVED' : null,
      decisionComment: null,
      decidedAt: null,
      conditionResult: true,
      conditionInputSnapshot: {},
      conditionRuleSetId: 'rs-1',
      conditionRuleVersion: 'v-doc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      stepDefinition: {
        stepKey,
        displayName: stepKey,
        executionMode: 'SEQUENTIAL',
        ordering,
        mandatory: true,
        onConditionFalse: null,
      },
    });

    const steps = [row('si-1', 'planning', 1, 'user-1', states.planning)];
    if (states.commercial !== undefined) {
      steps.push(row('si-2', 'commercial', 2, 'user-2', states.commercial));
    }

    return {
      id: 'wi-1',
      tenantId: 't1',
      status: 'RUNNING',
      subjectType: 'PURCHASE_DOCUMENT',
      subjectId: 'doc-1',
      workflowDefinitionVersionId: 'v-doc-1',
      version: {
        versionLabel: '1.0.0',
        parallelJoinPolicy: 'ALL',
        definition: { code: 'PURCHASE_APPROVAL', name: 'Purchase Approval' },
      },
      steps,
    } as unknown as WorkflowInstanceDetailRow;
  }

  it('advances to the next sequential group in the same unit of work instead of stalling', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(
      sequentialInstance({ planning: 'PENDING' })
    );
    executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());

    const result = await service.approveStep(actor, 'wi-1', 'planning', 'ok');

    // Group 2 became active inside the decision's own transaction: one row, written here.
    expect(executionRepository.createStepInstances).toHaveBeenCalledTimes(1);
    const [tenantId, tx, inputs, scopeType] = executionRepository.createStepInstances.mock
      .calls[0] as unknown as [string, unknown, Record<string, unknown>[], string];
    expect(tenantId).toBe('t1');
    expect(tx).toBe(mockTx);
    expect(scopeType).toBe('DOCUMENT');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      workflowInstanceId: 'wi-1',
      workflowStepId: 'ws-2',
      status: 'PENDING',
      resolvedApproverId: 'user-2',
      scopeId: 'doc-1',
      conditionInputSnapshot: {},
      conditionRuleVersion: 'v-doc-1',
    });

    // The approver the next group resolved to was re-verified as a member of the acting tenant.
    expect(identity.assertMember).toHaveBeenCalledWith(actor, 'user-2');

    // The run is NOT settled: there is still a group left to decide.
    expect(executionRepository.settleInstance).not.toHaveBeenCalled();
    expect(result.status).toBe('RUNNING');
    expect(ruleEngine.evaluateSync).toHaveBeenCalledTimes(1);
  });

  it('settles the run APPROVED when the last sequential group completes', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(
      sequentialInstance({ planning: 'APPROVED', commercial: 'PENDING' })
    );
    executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());
    purchaseRepository.findDocumentById.mockResolvedValue({
      id: 'doc-1',
      lineRoutingVersionId: null,
    } as unknown as FoundPurchaseDocument);

    const approver: CommerceActor = { ...actor, userId: 'user-2' };
    const result = await service.approveStep(approver, 'wi-1', 'commercial', 'ok');

    expect(result.status).toBe('APPROVED');
    expect(executionRepository.settleInstance).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      status: 'APPROVED',
    });

    // There is no group after the last one: nothing was activated for it.
    expect(executionRepository.createStepInstances).not.toHaveBeenCalled();
    expect(ruleEngine.evaluateSync).not.toHaveBeenCalled();
    expect(lineRouting.routeLinesForDocument).toHaveBeenCalledWith(
      approver,
      expect.anything(),
      'AFTER_DOCUMENT_WORKFLOW_APPROVED',
      mockTx
    );
  });

  it('settles REJECTED when the group a decision activates is terminated by its own condition', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(
      sequentialInstance({ planning: 'PENDING' })
    );
    executionRepository.findPinnedVersion.mockResolvedValue(
      sequentialVersion({ commercialOnFalse: 'TERMINATED' })
    );
    purchaseRepository.findDocumentById.mockResolvedValue({
      id: 'doc-1',
      lineRoutingVersionId: null,
    } as unknown as FoundPurchaseDocument);

    // The next group's own condition answers false, and its configured behaviour is TERMINATED.
    ruleEngine.evaluateSync.mockImplementation((ruleSet: { rules: readonly { id: string }[] }) => ({
      status: 'EVALUATED',
      matchHistory: ruleSet.rules.map((rule, index) => ({
        ruleId: rule.id,
        conditionOutcome: index === 1 ? 'FALSE' : 'TRUE',
        missingFields: [],
      })),
    }));

    const result = await service.approveStep(actor, 'wi-1', 'planning', 'ok');

    // The activation outcome feeds the settle decision: the run ends REJECTED, not APPROVED.
    expect(result.status).toBe('REJECTED');
    expect(executionRepository.settleInstance).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      status: 'REJECTED',
    });

    // The rows the activation decided on were still written (as SKIPPED, never as PENDING), and
    // §3-F's rejection signal went out in the same unit of work.
    const inputs = executionRepository.createStepInstances.mock.calls[0][2];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].status).toBe('SKIPPED');
    expect(commercial.onWorkflowSettled).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        subjectType: 'PURCHASE_DOCUMENT',
        subjectId: 'doc-1',
        status: 'REJECTED',
      }),
      mockTx
    );
  });

  it('refuses a repeat decision of a decided step instead of activating its group twice', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(
      sequentialInstance({ planning: 'APPROVED' })
    );
    executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());

    // A repeat decision is the same STATE refusal as a settled run: 409 (C2's class), code intact.
    await expect(service.approveStep(actor, 'wi-1', 'planning')).rejects.toThrow(ConflictException);

    // No decision, no activation: the planner refuses a step that is no longer PENDING before
    // any write in this unit of work is reached.
    expect(executionRepository.recordStepDecision).not.toHaveBeenCalled();
    expect(executionRepository.createStepInstances).not.toHaveBeenCalled();
    expect(executionRepository.settleInstance).not.toHaveBeenCalled();
  });

  it('throws when the instance does not exist', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(null);

    await expect(service.approveStep(actor, 'wi-1', 'manager_approval')).rejects.toThrow(
      NotFoundException
    );
  });

  // ---------------------------------------------------------------------------------------
  // PHASE C2 (GAP-1): the DECIDE and CANCEL shapes over the SAME pipeline.
  // ---------------------------------------------------------------------------------------

  it('records a REJECTED decision for the addressed step instance and settles the run', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

    const result = await service.decideStep(actor, 'wi-1', 'si-1', 'REJECTED', 'not needed');

    expect(result).toEqual({ instanceId: 'wi-1', status: 'REJECTED' });
    expect(executionRepository.recordStepDecision).toHaveBeenCalledWith(
      't1',
      mockTx,
      expect.objectContaining({
        instanceId: 'wi-1',
        stepInstanceId: 'si-1',
        decision: 'REJECTED',
        comment: 'not needed',
      })
    );
    expect(executionRepository.settleInstance).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      status: 'REJECTED',
    });
    // §3-F's rejection signal went out of the same unit of work; no line routing does.
    expect(commercial.onWorkflowSettled).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ subjectId: 'doc-1', status: 'REJECTED' }),
      mockTx
    );
    expect(lineRouting.routeLinesForDocument).not.toHaveBeenCalled();
  });

  it('refuses a decide whose step instance is not part of the addressed run', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

    await expect(service.decideStep(actor, 'wi-1', 'si-unknown', 'APPROVED')).rejects.toThrow(
      NotFoundException
    );
    expect(executionRepository.recordStepDecision).not.toHaveBeenCalled();
    expect(executionRepository.settleInstance).not.toHaveBeenCalled();
  });

  it('refuses a decide by a non-approver through the new shape exactly as through approve', async () => {
    const instance = documentWorkflowInstance();
    instance.steps[0].resolvedApproverId = 'user-2';
    executionRepository.findInstanceDetail.mockResolvedValue(instance);
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

    await expect(service.decideStep(actor, 'wi-1', 'si-1', 'APPROVED')).rejects.toThrow(
      BadRequestException
    );
  });

  it('tells the loser of a decision race the conflict instead of a success it did not record', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
    executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());
    executionRepository.recordStepDecision.mockResolvedValue(0);

    await expect(service.decideStep(actor, 'wi-1', 'si-1', 'APPROVED')).rejects.toThrow(
      ConflictException
    );
    expect(executionRepository.settleInstance).not.toHaveBeenCalled();
  });

  it('cancels a running run: pending steps skipped, run settled, nothing else dispatched', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());

    const result = await service.cancelInstance(actor, 'wi-1');

    expect(result).toEqual({ instanceId: 'wi-1', status: 'CANCELLED' });
    expect(executionRepository.skipPendingStepInstances).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      stepInstanceIds: ['si-1'],
    });
    expect(executionRepository.settleInstance).toHaveBeenCalledWith('t1', mockTx, {
      instanceId: 'wi-1',
      status: 'CANCELLED',
    });
    // §9.3: TWO writes and nothing else — no decision, no birth, no dispatch, no projection.
    expect(executionRepository.recordStepDecision).not.toHaveBeenCalled();
    expect(executionRepository.createStepInstances).not.toHaveBeenCalled();
    expect(commercial.onWorkflowSettled).not.toHaveBeenCalled();
    expect(lineRouting.routeLinesForDocument).not.toHaveBeenCalled();
  });

  it('refuses a cancel of a run that is no longer running, with the planner code', async () => {
    const instance = documentWorkflowInstance();
    instance.status = 'APPROVED';
    executionRepository.findInstanceDetail.mockResolvedValue(instance);

    await expect(service.cancelInstance(actor, 'wi-1')).rejects.toThrow(ConflictException);
    expect(executionRepository.skipPendingStepInstances).not.toHaveBeenCalled();
    expect(executionRepository.settleInstance).not.toHaveBeenCalled();
  });

  it('tells the loser of a cancel race the conflict', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
    executionRepository.settleInstance.mockResolvedValue(0);

    await expect(service.cancelInstance(actor, 'wi-1')).rejects.toThrow(ConflictException);
  });

  it('refuses a cancel of an instance this tenant does not hold', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(null);

    await expect(service.cancelInstance(actor, 'wi-nope')).rejects.toThrow(NotFoundException);
  });

  // ---------------------------------------------------------------------------------------
  // PHASE C2: §11's READ views — translation only, and never a tenant scope on the wire.
  // ---------------------------------------------------------------------------------------

  it('pages runs without ever returning the tenant scope to the client', async () => {
    const row = {
      ...documentWorkflowInstance(),
      createdAt: new Date('2026-09-30T08:00:00.000Z'),
      updatedAt: new Date('2026-09-30T09:00:00.000Z'),
    };
    executionRepository.listInstancePage.mockResolvedValue([[row], 1]);

    const page = await service.listInstances(actor, { page: 1, pageSize: 2 });

    expect(executionRepository.listInstancePage).toHaveBeenCalledWith(
      't1',
      { status: undefined, subjectId: undefined },
      { skip: 0, take: 2, page: 1, pageSize: 2 }
    );
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe('wi-1');
    expect(page.items[0]).not.toHaveProperty('tenantId');
    expect(typeof page.items[0].createdAt).toBe('string');
    expect(page.items[0].steps[0]).not.toHaveProperty('scopeType'); // list shape, not detail's.
  });

  it('reads one run with its steps and persisted outcomes, stripping the tenant scope', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue({
      ...documentWorkflowInstance(),
      createdAt: new Date('2026-09-30T08:00:00.000Z'),
      updatedAt: new Date('2026-09-30T09:00:00.000Z'),
    });

    const detail = await service.getInstance(actor, 'wi-1');

    expect(detail).not.toHaveProperty('tenantId');
    expect(detail.steps[0]).toMatchObject({
      id: 'si-1',
      stepKey: 'manager_approval',
      status: 'PENDING',
      decision: null,
      conditionResult: true,
    });
    expect(detail.steps[0]).not.toHaveProperty('conditionInputSnapshot');
  });

  it('refuses a detail read of an instance this tenant does not hold', async () => {
    executionRepository.findInstanceDetail.mockResolvedValue(null);

    await expect(service.getInstance(actor, 'wi-nope')).rejects.toThrow(NotFoundException);
  });

  /**
   * GAP-9: the decision's USER-ADDRESSED notification.
   *
   * A decision is the one workflow act that ACTIVATES the next owner, so it is the one act
   * with a provable recipient: the next group's stored `resolvedApproverId`, the line-routing
   * pass's new PENDING steps, and any commercial approval the settle activated. The acting
   * approver is not a recipient of their own decision — their step is no longer pending.
   */
  describe('GAP-9 — a decision notifies the owners it puts in PENDING', () => {
    it('notifies the next group’s resolved approver, after the decision committed', async () => {
      executionRepository.findInstanceDetail.mockResolvedValue(
        sequentialInstance({ planning: 'PENDING' })
      );
      executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());

      await service.approveStep(actor, 'wi-1', 'planning', 'ok');

      expect(notification.notifyUsers).toHaveBeenCalledTimes(1);
      const [notifyActor, recipients, content] = notification.notifyUsers.mock.calls[0];
      expect(notifyActor).toBe(actor);
      // `user-2` is the approver the NEXT group resolved to — and the acting user (`user-1`)
      // is absent: the decision they just made is not waiting for them.
      expect(recipients).toEqual(['user-2']);
      expect(recipients).not.toContain(actor.userId);
      expect(content).toEqual({
        type: 'INFORMATION',
        title: 'تصمیم جدید در گردش کار خرید',
        body: 'یک تصمیم گردش‌کار خرید منتظر اقدام شماست.',
        sourceType: 'purchase-document',
        sourceId: 'doc-1',
      });
    });

    it('adds the line-routing pass’s approvers when the decision APPROVES the document run', async () => {
      executionRepository.findInstanceDetail.mockResolvedValue(
        sequentialInstance({ planning: 'APPROVED', commercial: 'PENDING' })
      );
      executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());
      purchaseRepository.findDocumentById.mockResolvedValue({
        id: 'doc-1',
        lineRoutingVersionId: null,
      } as unknown as FoundPurchaseDocument);
      commercial.onWorkflowSettled.mockResolvedValue(['commercial-approver']);

      await service.approveStep({ ...actor, userId: 'user-2' }, 'wi-1', 'commercial', 'ok');

      const [, recipients] = notification.notifyUsers.mock.calls[0];
      // The line routing this APPROVED settle triggered (`line-approver`, the suite's default)
      // and the commercial approvals the same settle activated — one list, deduplicated by the
      // gateway.
      expect(recipients).toEqual(['line-approver', 'commercial-approver']);
    });

    it('notifies nobody when a decision ends the run with no next owner', async () => {
      executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());
      executionRepository.findPinnedVersion.mockResolvedValue(pinnedVersion());

      await service.decideStep(actor, 'wi-1', 'si-1', 'REJECTED', 'not needed');

      // A terminal rejection activates nothing: no recipient, so no notification at all —
      // not even an empty one (GAP-9 §2/§11: the requester path is deliberately unwired).
      expect(notification.notifyUsers).not.toHaveBeenCalled();
    });

    it('notifies nobody when the decision never committed', async () => {
      executionRepository.findInstanceDetail.mockResolvedValue(
        sequentialInstance({ planning: 'PENDING' })
      );
      executionRepository.findPinnedVersion.mockResolvedValue(sequentialVersion());
      // The conditional write lost a race: the transition did not happen.
      executionRepository.recordStepDecision.mockResolvedValue(0);

      await expect(service.approveStep(actor, 'wi-1', 'planning', 'ok')).rejects.toThrow(
        ConflictException
      );
      expect(notification.notifyUsers).not.toHaveBeenCalled();
    });

    it('does not notify on cancel: a cancelled run activates nobody', async () => {
      executionRepository.findInstanceDetail.mockResolvedValue(documentWorkflowInstance());

      await service.cancelInstance(actor, 'wi-1');

      expect(notification.notifyUsers).not.toHaveBeenCalled();
    });
  });
});
