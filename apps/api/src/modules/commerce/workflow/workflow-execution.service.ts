import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import type { EvaluationContext } from '../../../rules/rule-evaluation.interface';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { CommerceActor } from '../commerce-actor';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import type { ListWorkflowInstancesQueryDto } from './workflow-execution.dto';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { CommercialLifecycleService } from '../commercial/commercial-lifecycle.service';
import { WorkflowParallelJoinPolicy } from './workflow-configuration';
import {
  planWorkflowCancellation,
  planWorkflowGroupActivation,
  planWorkflowStepDecision,
  workflowActivationRuleSet,
  workflowActivationRuleSetId,
  workflowStepGroups,
  type WorkflowStepConfigurationRecord,
  type WorkflowStepGroup,
  type WorkflowStepStateSnapshot,
} from './workflow-execution';
import { type WorkflowInstanceStatus, type WorkflowStepDecision } from './workflow-run-status';
import {
  WorkflowExecutionRepository,
  type WorkflowInstanceDetailRow,
  type WorkflowInstanceListRow,
  type WorkflowPinnedVersionRow,
  type WorkflowSettlementStatus,
  type WorkflowStepActivationInput,
} from './workflow-execution.repository';
import { WorkflowLineRoutingService } from './workflow-line-routing.service';

export const WORKFLOW_STEP_NOT_FOUND = 'WORKFLOW_STEP_NOT_FOUND' as const;
export const WORKFLOW_INSTANCE_NOT_RUNNING = 'WORKFLOW_INSTANCE_NOT_RUNNING' as const;

/**
 * PHASE C2 (GAP-1): how one of the planner's NAMED refusals becomes an HTTP answer.
 *
 * TWO CLASSES, AND THE DISTINCTION IS THE MODULE'S OWN CONVENTION. A refusal about the
 * RECORD'S STATE — the run is not RUNNING, the step is no longer PENDING — is a conflict:
 * Commerce answers those 409 everywhere else (submit, commercial decision, receiving,
 * returns) and the loser of a race is told exactly that. A refusal about WHO is asking or
 * WHAT was asked (actor mismatch, a step the pinned version does not know) stays 400,
 * matching both the commercial decision's actor rule and the behaviour step N's e2e already
 * verifies. The CODE travels unchanged either way — this maps a class, never a vocabulary,
 * so a client can still branch on `WORKFLOW_*`.
 */
export function workflowDecisionRefusal(
  code: string,
  message: string
): BadRequestException | ConflictException {
  return code === 'WORKFLOW_INSTANCE_NOT_RUNNING' || code === 'WORKFLOW_STEP_NOT_ACTIONABLE'
    ? new ConflictException({ code, message })
    : new BadRequestException({ code, message });
}

/**
 * Phase C1 Step O gap closure + PHASE C2 (GAP-1): synchronous, request-driven workflow execution.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The runtime service that records a step decision (APPROVED or REJECTED — both shapes reach
 * ONE `applyDecision` pipeline), cancels a running run (§9.3's two writes), serves §11's
 * persisted reads, advances or settles the run, and — when a DOCUMENT workflow reaches
 * APPROVED — invokes the configured AFTER_DOCUMENT_WORKFLOW_APPROVED line routing
 * synchronously inside the same unit of work. No worker, queue, cron or background
 * processing is used.
 */
@Injectable()
export class WorkflowExecutionService {
  constructor(
    private readonly executionRepository: WorkflowExecutionRepository,
    private readonly lineRouting: WorkflowLineRoutingService,
    private readonly purchaseRepository: PurchaseRepository,
    private readonly unitOfWork: CommerceUnitOfWork,
    private readonly commercial: CommercialLifecycleService,
    // §9.2's advance needs both of these: the engine answers whether a step's own condition
    // admits it when its group becomes active, and the gateway re-verifies that the approver a
    // later group resolves to is a member of the acting tenant before that row is written.
    private readonly ruleEngine: RuleEngineService,
    private readonly identity: CommerceIdentityGateway,
    // GAP-9: the ONE surface a Commerce service may notify through — injected here so a
    // step decision can tell the owners it just put in PENDING (see applyDecision).
    private readonly notification: CommerceNotificationGateway
  ) {}

  /**
   * PHASE C2 (GAP-1): the two shapes of ONE act, both landing on the same pipeline.
   *
   * `approveStep` keeps the signature the e2e probes and the unit suite already call
   * (locate the step by its KEY). `decideStep` is the §11 HTTP shape: the contract's route
   * addresses a step INSTANCE by id, so the key is derived from the instance the id belongs
   * to — tenant-scoped, and 404 when the id is not a step of THIS run. Everything after
   * that (planner, conditional write, advance, settle, dispatch) is the same code with the
   * decision parameterised: the domain already planned BOTH decisions (`WORKFLOW_STEP_DECISIONS`),
   * and a second implementation of their consequences would be two definitions of one rule.
   */
  async approveStep(
    actor: CommerceActor,
    instanceId: string,
    stepKey: string,
    comment: string | null = null
  ): Promise<{ instanceId: string; status: WorkflowInstanceStatus }> {
    const { instance, version } = await this.loadRun(actor, instanceId);
    return this.applyDecision(actor, instance, version, stepKey, 'APPROVED', comment);
  }

  /** §11's DECIDE route: APPROVED or REJECTED, recorded for ONE step of a running run. */
  async decideStep(
    actor: CommerceActor,
    instanceId: string,
    stepInstanceId: string,
    decision: WorkflowStepDecision,
    comment: string | null = null
  ): Promise<{ instanceId: string; status: WorkflowInstanceStatus }> {
    const { instance, version } = await this.loadRun(actor, instanceId);
    const step = instance.steps.find((candidate) => candidate.id === stepInstanceId);
    if (!step) {
      throw new NotFoundException({
        code: WORKFLOW_STEP_NOT_FOUND,
        message: `Step instance ${stepInstanceId} not found`,
      });
    }
    return this.applyDecision(
      actor,
      instance,
      version,
      step.stepDefinition.stepKey,
      decision,
      comment
    );
  }

  /**
   * §9.3's CANCELLATION, exposed: a RUNNING run settles CANCELLED and its outstanding
   * steps settle SKIPPED — the planner's own two writes, in one unit of work. NOTHING ELSE
   * happens: no commercial dispatch and no document status change (N §9.3, §5.9), so a
   * cancelled run leaves the purchase exactly where the submit left it.
   */
  async cancelInstance(
    actor: CommerceActor,
    instanceId: string
  ): Promise<{ instanceId: string; status: WorkflowInstanceStatus }> {
    const instance = await this.executionRepository.findInstanceDetail(actor.tenantId, instanceId);
    if (!instance) {
      throw new NotFoundException('Workflow instance not found');
    }

    const plan = planWorkflowCancellation(instance.status, this.stepState(instance));
    if (plan.outcome === 'REFUSED') {
      throw workflowDecisionRefusal(plan.code, plan.message);
    }

    const pendingStepInstanceIds = instance.steps
      .filter((step) => step.status === 'PENDING')
      .map((step) => step.id);

    return this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      await this.executionRepository.skipPendingStepInstances(actor.tenantId, tx, {
        instanceId,
        stepInstanceIds: pendingStepInstanceIds,
      });
      const settled = await this.executionRepository.settleInstance(actor.tenantId, tx, {
        instanceId,
        status: plan.plan.runStatus,
      });
      if (settled === 0) {
        throw new ConflictException({
          code: WORKFLOW_INSTANCE_NOT_RUNNING,
          message: 'The run finished while this request was being applied.',
        });
      }
      return { instanceId, status: plan.plan.runStatus };
    });
  }

  /**
   * §11's LIST: one page of the tenant's runs, newest-touched first, steps as PERSISTED
   * (an operator's "what is waiting" cannot be answered by a run row alone). The view
   * strips `tenantId`: pagination is not authorization, and the client derives its own
   * scope from its session — never from a field in a response.
   */
  async listInstances(actor: CommerceActor, query: ListWorkflowInstancesQueryDto) {
    const window = resolveCommercePageWindow(query);
    const [rows, total] = await this.executionRepository.listInstancePage(
      actor.tenantId,
      { status: query.status, subjectId: query.subjectId },
      window
    );
    return {
      items: rows.map((row) => this.serializeInstanceListRow(row)),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /** §11's DETAIL: one run, the version it pinned, every step's persisted outcome. */
  async getInstance(actor: CommerceActor, instanceId: string) {
    const row = await this.executionRepository.findInstanceDetail(actor.tenantId, instanceId);
    if (!row) {
      throw new NotFoundException('Workflow instance not found');
    }
    return this.serializeInstanceDetailRow(row);
  }

  /** The load every DECIDE-shaped act shares: instance, pinned version, an acting user. */
  private async loadRun(
    actor: CommerceActor,
    instanceId: string
  ): Promise<{ instance: WorkflowInstanceDetailRow; version: WorkflowPinnedVersionRow }> {
    const instance = await this.executionRepository.findInstanceDetail(actor.tenantId, instanceId);
    if (!instance) {
      throw new NotFoundException('Workflow instance not found');
    }

    const version = await this.executionRepository.findPinnedVersion(
      actor.tenantId,
      instance.workflowDefinitionVersionId
    );
    if (!version) {
      throw new NotFoundException('Pinned workflow version not found');
    }

    if (!actor.userId) {
      throw new BadRequestException('An acting user is required to decide a workflow step');
    }

    return { instance, version };
  }

  /** The planner's snapshot of one run's steps — ONE mapping, used by every decision. */
  private stepState(instance: WorkflowInstanceDetailRow): readonly WorkflowStepStateSnapshot[] {
    return instance.steps.map((step) => ({
      stepKey: step.stepDefinition.stepKey,
      status: step.status,
      resolvedApproverId: step.resolvedApproverId,
    }));
  }

  /** ONE decision's pipeline: plan → conditional write → advance/settle → dispatch. */
  private async applyDecision(
    actor: CommerceActor,
    instance: WorkflowInstanceDetailRow,
    version: WorkflowPinnedVersionRow,
    stepKey: string,
    decision: WorkflowStepDecision,
    comment: string | null
  ): Promise<{ instanceId: string; status: WorkflowInstanceStatus }> {
    const configurationSteps =
      version.steps as unknown as readonly WorkflowStepConfigurationRecord[];
    const groups = workflowStepGroups(configurationSteps);
    const joinPolicy: WorkflowParallelJoinPolicy = instance.version.parallelJoinPolicy ?? 'ALL';
    const instanceId = instance.id;

    const state = this.stepState(instance);

    const plan = planWorkflowStepDecision(
      configurationSteps,
      state,
      joinPolicy,
      instance.status as WorkflowInstanceStatus,
      { stepKey, actingUserId: actor.userId as string, decision }
    );

    if (plan.outcome === 'REFUSED') {
      throw workflowDecisionRefusal(plan.code, plan.message);
    }

    const stepInstance = instance.steps.find((s) => s.stepDefinition.stepKey === stepKey);
    if (!stepInstance) {
      throw new NotFoundException({
        code: WORKFLOW_STEP_NOT_FOUND,
        message: `Step ${stepKey} not found`,
      });
    }

    // GAP-9: the decision owners THIS transition activates — collected inside the unit
    // of work (a rollback discards them with it) and notified only after its commit.
    let pendingDecisionUserIds: readonly string[] = [];

    const result = await this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      const updated = await this.executionRepository.recordStepDecision(actor.tenantId, tx, {
        instanceId,
        stepInstanceId: stepInstance.id,
        decision,
        comment,
        decidedAt: new Date(),
      });
      if (updated === 0) {
        /*
         * The conditional write's SECOND line of defence, made visible: two callers raced
         * the same step and this one lost — the conflict is told to the caller instead of
         * reporting a decision it did not record. Same 409 convention (and the same named
         * code) the commercial decision uses for its own `count === 0`.
         */
        throw new ConflictException({
          code: 'WORKFLOW_STEP_NOT_ACTIONABLE',
          message: 'The step was decided while this request was being applied.',
        });
      }

      const settledStepIds = plan.advance.settledStepKeys
        .map((key) => instance.steps.find((s) => s.stepDefinition.stepKey === key)?.id)
        .filter((id): id is string => typeof id === 'string');

      await this.executionRepository.skipPendingStepInstances(actor.tenantId, tx, {
        instanceId,
        stepInstanceIds: settledStepIds,
      });

      // §9.2's advance, second half: the decided group is complete, so the group that follows
      // becomes the one that is active now -- written HERE, in the same unit of work as the
      // decision, with the same planner (and the same persisted facts) the first group was born
      // with. Without this write a sequential run would stop after its first group and the rest
      // of its own configuration could never be decided at all.
      let activatedRunStatus: 'RUNNING' | 'REJECTED' | null = null;
      const activatedDecisionUserIds: string[] = [];
      if (plan.advance.advance && plan.advance.runStatus !== 'REJECTED') {
        const decidedGroupIndex = groups.findIndex((candidate) =>
          candidate.members.some((member) => member.stepKey === stepKey)
        );
        const nextGroup = decidedGroupIndex >= 0 ? groups[decidedGroupIndex + 1] : undefined;
        if (nextGroup !== undefined) {
          const activation = await this.activateGroup(actor, instance, version, nextGroup, tx);
          activatedRunStatus = activation.runStatus;
          // The next group's PENDING steps' stored approvers — the authoritative
          // "who owes the next decision" this advance just created (GAP-9).
          activatedDecisionUserIds.push(...activation.pendingApproverUserIds);
        }
      }

      let finalStatus: WorkflowSettlementStatus | null = null;
      if (plan.advance.runStatus === 'REJECTED' || activatedRunStatus === 'REJECTED') {
        finalStatus = 'REJECTED';
      } else if (plan.advance.advance && this.isLastGroup(groups, stepKey)) {
        finalStatus = 'APPROVED';
      }

      if (finalStatus) {
        await this.executionRepository.settleInstance(actor.tenantId, tx, {
          instanceId,
          status: finalStatus,
        });
      }

      let aggregationPolicy: 'ALL_APPROVED' | 'INDEPENDENT' | null = null;

      if (finalStatus === 'APPROVED' && instance.subjectType === 'PURCHASE_DOCUMENT') {
        const document = await this.purchaseRepository.findDocumentById(
          actor.tenantId,
          instance.subjectId,
          tx
        );
        if (!document) {
          throw new NotFoundException('Purchase document for approved workflow not found');
        }
        const routingResult = await this.lineRouting.routeLinesForDocument(
          actor,
          document as unknown as Parameters<WorkflowLineRoutingService['routeLinesForDocument']>[1],
          'AFTER_DOCUMENT_WORKFLOW_APPROVED',
          tx
        );
        if (routingResult.routingVersionId) {
          await this.purchaseRepository.pinLineRoutingVersionIn(
            actor.tenantId,
            tx,
            document.id,
            routingResult.routingVersionId
          );
        }
        aggregationPolicy = routingResult.aggregationPolicy;
        // GAP-9: the SECOND line-routing pass this decision triggers (the document's own
        // APPROVED settle) creates its own PENDING steps — their stored approvers are
        // decision owners this transition activated, exactly like the advance above.
        activatedDecisionUserIds.push(...(routingResult.pendingApproverUserIds ?? []));
      } else if (finalStatus) {
        // Resolve the document's pinned O4 aggregation semantics for REJECTED and
        // line-level terminal events. `null` means O4 is not applicable (O4-D5).
        const documentId =
          instance.subjectType === 'PURCHASE_DOCUMENT'
            ? instance.subjectId
            : await this.purchaseRepository.findDocumentIdByLineId(
                actor.tenantId,
                instance.subjectId,
                tx
              );
        if (documentId) {
          const document = await this.purchaseRepository.findDocumentById(
            actor.tenantId,
            documentId,
            tx
          );
          if (document?.lineRoutingVersionId) {
            aggregationPolicy = await this.lineRouting.getAggregationPolicy(
              actor,
              document.lineRoutingVersionId
            );
          }
        }
      }

      // Step P, dispatch point 2 (§4): a TERMINAL run is the event the commercial
      // slice reacts to — the document's APPROVED settle is the configured
      // `AFTER_DOCUMENT_WORKFLOW_APPROVED` activation, its REJECTED settle is §3-F's
      // rejection signal, and a line's settle is a projection input for `ALL_LINES`.
      // One unit of work with the decision itself, so the projection can never describe
      // a state this transaction did not commit.
      if (finalStatus) {
        const settledApprovalUserIds = await this.commercial.onWorkflowSettled(
          actor,
          {
            subjectType: instance.subjectType,
            subjectId: instance.subjectId,
            status: finalStatus,
            aggregationPolicy,
          },
          tx
        );
        // GAP-9: commercial approvals this settle ACTIVATED carry their stored approver —
        // the same recipient category as the workflow advance above, one list.
        activatedDecisionUserIds.push(...(settledApprovalUserIds ?? []));
      }

      // GAP-9: the recipient list is complete only when the transaction is. Assigning it
      // to the caller's scope HERE (inside the unit of work) means a rollback discards it
      // with every other write, and the notify below runs strictly after commit.
      pendingDecisionUserIds = activatedDecisionUserIds;

      return { instanceId, status: finalStatus ?? instance.status };
    });

    /*
     * GAP-9: the user-facing Notification Center row, created only after the unit of work
     * committed — a refused or rolled-back decision never reaches this point, so no
     * notification can describe a transition that did not happen.
     *
     * WHO IS TOLD. Exactly the owners this decision put in PENDING: the next group's
     * steps' stored `resolvedApproverId`, the line-routing pass's new pending steps, and
     * any commercial approval this settle activated. The acting approver is NOT
     * automatically a recipient: their own step is no longer pending, so they appear here
     * only when an independent, authoritative path makes them the owner of the NEXT
     * decision — which genuinely is a decision awaiting them. An empty list notifies
     * nobody (a terminal REJECTED run activates no next owner; the requester is
     * deliberately left unwired, see the GAP-9 implementation report).
     *
     * `requesterId` is NOT used as a recipient and no audience is derived: the ids above
     * come from decision state that already exists, and Core's Center resolves no
     * audience of its own.
     */
    if (pendingDecisionUserIds.length > 0) {
      const documentId =
        instance.subjectType === 'PURCHASE_DOCUMENT'
          ? instance.subjectId
          : await this.purchaseRepository.findDocumentIdByLineId(
              actor.tenantId,
              instance.subjectId
            );

      await this.notification.notifyUsers(actor, pendingDecisionUserIds, {
        type: 'INFORMATION',
        title: 'تصمیم جدید در گردش کار خرید',
        body: 'یک تصمیم گردش‌کار خرید منتظر اقدام شماست.',
        sourceType: 'purchase-document',
        sourceId: documentId ?? instance.subjectId,
      });
    }

    return result;
  }

  private isLastGroup(groups: ReturnType<typeof workflowStepGroups>, stepKey: string): boolean {
    const index = groups.findIndex((group) =>
      group.members.some((member) => member.stepKey === stepKey)
    );
    return index >= 0 && index === groups.length - 1;
  }

  /**
   * §9.2's advance: activate the group that follows the one that just completed.
   *
   * THE SAME MACHINERY AS A BIRTH, DELIBERATELY. The planner, the rule set, the persisted facts
   * and the member assertion are the ones `WorkflowLineRoutingService` used when the run was
   * created, so a group that starts later is indistinguishable from one that started first --
   * and a run whose second step never becomes active is a run that silently stops, which §9.2
   * does not permit.
   *
   * THE FACTS ARE THE PERSISTED SNAPSHOT, NOT A RE-READ. Every step instance already carries the
   * inputs its condition was evaluated against, so "is the next step admissible?" is answered
   * from the same record the first step was answered from (§5.7 and §24's "persisted condition
   * result") rather than from a document that may have changed since the run began.
   *
   * Returns the run status the activation itself produced — which is `REJECTED` only when a
   * member's own condition terminated the run the moment it became active — together with
   * the approver ids of the PENDING steps the activation created (GAP-9: the authoritative
   * "who owes the next decision" transcript a caller notifies from).
   */
  private async activateGroup(
    actor: CommerceActor,
    instance: WorkflowInstanceDetailRow,
    version: WorkflowPinnedVersionRow,
    group: WorkflowStepGroup,
    tx: CommerceTransactionHandle
  ): Promise<{
    runStatus: 'RUNNING' | 'REJECTED';
    pendingApproverUserIds: readonly string[];
  }> {
    const configurationSteps =
      version.steps as unknown as readonly WorkflowStepConfigurationRecord[];
    const facts =
      instance.steps.find((step) => step.conditionInputSnapshot)?.conditionInputSnapshot ?? {};

    const activationSet = workflowActivationRuleSet(
      version.workflowDefinitionVersionId,
      version.definitionCode,
      configurationSteps
    );
    const outcome = {
      evaluated: true as const,
      result: this.ruleEngine.evaluateSync(activationSet, {
        facts: facts as EvaluationContext['facts'],
        evaluationInstant: new Date().toISOString(),
      }),
    };

    const activation = planWorkflowGroupActivation(configurationSteps, group, outcome);
    if (activation.outcome === 'REFUSED') {
      throw new BadRequestException(`Workflow group activation refused: ${activation.code}`);
    }

    const ruleSetId = workflowActivationRuleSetId(version.definitionCode);
    const inputs: WorkflowStepActivationInput[] = [];

    for (const plan of activation.plan.steps) {
      const stepRuntime = version.steps.find((candidate) => candidate.stepKey === plan.stepKey);
      if (!stepRuntime) continue;

      if (plan.status === 'PENDING' && plan.resolvedApproverId) {
        await this.identity.assertMember(actor, plan.resolvedApproverId);
      }

      inputs.push({
        workflowInstanceId: instance.id,
        workflowStepId: stepRuntime.id,
        scopeId: instance.subjectId,
        status: plan.status,
        resolvedApproverId: plan.resolvedApproverId,
        conditionResult: plan.conditionResult,
        conditionInputSnapshot: facts,
        conditionRuleSetId: ruleSetId,
        conditionRuleVersion: version.workflowDefinitionVersionId,
      });
    }

    await this.executionRepository.createStepInstances(
      actor.tenantId,
      tx,
      inputs,
      instance.subjectType === 'PURCHASE_LINE' ? 'LINE' : 'DOCUMENT'
    );

    return {
      runStatus: activation.plan.runStatus,
      // GAP-9: the PENDING steps just written, by their stored approver — the only
      // recipients this activation can prove, since `resolvedApproverId` is precisely the
      // value asserted against tenant membership three lines above.
      pendingApproverUserIds: inputs.flatMap((input) =>
        input.status === 'PENDING' && input.resolvedApproverId ? [input.resolvedApproverId] : []
      ),
    };
  }

  // ---------------------------------------------------------------------------------------
  // §11's READ VIEWS (C2) — translation only: persisted rows in, client-safe rows out.
  //
  // WHAT IS DELIBERATELY ABSENT: `tenantId` (the client's scope comes from its own session,
  // never from a field in a response) and `conditionInputSnapshot` (§5.7's raw fact payload —
  // backend evidence for reproducibility, never part of the §10.5 step-progress read the UI
  // contract specifies). Everything else is exactly what the repository selected.
  // ---------------------------------------------------------------------------------------

  /** One run of §11's LIST, as the client receives it. */
  private serializeInstanceListRow(row: WorkflowInstanceListRow) {
    const { tenantId: _tenantId, ...rest } = row;
    void _tenantId;
    return {
      ...rest,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: {
        versionLabel: row.version.versionLabel,
        parallelJoinPolicy: row.version.parallelJoinPolicy,
        definition: row.version.definition,
      },
      steps: row.steps.map((step) => ({
        id: step.id,
        workflowStepId: step.workflowStepId,
        status: step.status,
        resolvedApproverId: step.resolvedApproverId,
        decision: step.decision,
        decidedAt: step.decidedAt ? step.decidedAt.toISOString() : null,
        stepKey: step.stepDefinition.stepKey,
        stepName: step.stepDefinition.displayName,
        ordering: step.stepDefinition.ordering,
      })),
    };
  }

  /** One run of §11's DETAIL, as the client receives it. */
  private serializeInstanceDetailRow(row: WorkflowInstanceDetailRow) {
    const { tenantId: _tenantId, ...rest } = row;
    void _tenantId;
    return {
      ...rest,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: {
        versionLabel: row.version.versionLabel,
        parallelJoinPolicy: row.version.parallelJoinPolicy,
        definition: row.version.definition,
      },
      steps: row.steps.map((step) => ({
        id: step.id,
        workflowStepId: step.workflowStepId,
        scopeType: step.scopeType,
        scopeId: step.scopeId,
        status: step.status,
        resolvedApproverId: step.resolvedApproverId,
        decision: step.decision,
        decisionComment: step.decisionComment,
        decidedAt: step.decidedAt ? step.decidedAt.toISOString() : null,
        conditionResult: step.conditionResult,
        conditionRuleSetId: step.conditionRuleSetId,
        conditionRuleVersion: step.conditionRuleVersion,
        createdAt: step.createdAt.toISOString(),
        updatedAt: step.updatedAt.toISOString(),
        stepKey: step.stepDefinition.stepKey,
        stepName: step.stepDefinition.displayName,
        executionMode: step.stepDefinition.executionMode,
        ordering: step.stepDefinition.ordering,
        mandatory: step.stepDefinition.mandatory,
        onConditionFalse: step.stepDefinition.onConditionFalse,
      })),
    };
  }
}
