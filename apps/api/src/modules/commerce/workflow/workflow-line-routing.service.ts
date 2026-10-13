import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import { EvaluationContext } from '../../../rules/rule-evaluation.interface';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import type { CommerceTransactionHandle } from '../database/commerce-transaction';
import { WorkflowTriggerEvent } from './workflow-configuration';
import { PurchaseDocumentKind, PurchaseLineType } from '../purchase/purchase-status';
import {
  planWorkflowGroupActivation,
  workflowActivationRuleSet,
  workflowActivationRuleSetId,
  workflowStepGroups,
  type WorkflowStepConfigurationRecord,
} from './workflow-execution';
import {
  WorkflowExecutionRepository,
  type WorkflowStepActivationInput,
  type WorkflowStepRuntimeRow,
} from './workflow-execution.repository';
import {
  CommerceWorkflowFacts,
  projectCommerceWorkflowFacts,
  projectCommerceWorkflowLineFacts,
} from './workflow-facts';
import {
  planWorkflowLineRouting,
  workflowLineRoutingRuleSet,
  type WorkflowLineRoute,
} from './workflow-line-routing';
import { WorkflowLineRoutingRepository } from './workflow-line-routing.repository';

/**
 * Phase C1 Step O (§5.15): the LINE-LEVEL ROUTING orchestration service.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * It coordinates the routing of each `PurchaseLine` to its own `WorkflowInstance` under a
 * pinned `WorkflowDefinitionVersion`, using the existing Rule Engine and execution foundation.
 *
 * It does NOT persist directly, evaluate in a second engine, resolve actors outside the
 * gateway, or write audit itself.
 */

export const WORKFLOW_LINE_ROUTING_NO_ROUTE = 'WORKFLOW_LINE_ROUTING_NO_ROUTE' as const;
export const WORKFLOW_LINE_ROUTING_AMBIGUOUS = 'WORKFLOW_LINE_ROUTING_AMBIGUOUS' as const;
export const WORKFLOW_LINE_ROUTING_TARGET_INVALID = 'WORKFLOW_LINE_ROUTING_TARGET_INVALID' as const;
export const WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED =
  'WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED' as const;
export const WORKFLOW_LINE_ROUTING_ALREADY_ROUTED = 'WORKFLOW_LINE_ROUTING_ALREADY_ROUTED' as const;

export interface WorkflowLineRoutingResult {
  readonly documentId: string;
  readonly trigger: WorkflowTriggerEvent;
  readonly routingVersionId: string | null;
  readonly aggregationPolicy: 'ALL_APPROVED' | 'INDEPENDENT' | null;
  readonly createdInstances: readonly { readonly lineId: string; readonly instanceId: string }[];
  readonly unroutedLineIds: readonly string[];
  /**
   * GAP-9: the approver ids whose PENDING workflow steps THIS routing created, taken from
   * the steps' own `resolvedApproverId` (stored at activation — authoritative Commerce
   * state, never an audience). Duplicates across lines are possible on purpose: the
   * Commerce notification gateway dedupes at the boundary, so this list stays a plain
   * transcript of what this transition activated.
   */
  readonly pendingApproverUserIds: readonly string[];
}

/** The document shape the routing service needs, structurally typed so the service never
 * imports the generated client. */
interface LineRoutingPurchaseDocument {
  readonly id: string;
  readonly kind: PurchaseDocumentKind;
  readonly currency: string | null;
  readonly supplierId: string | null;
  readonly requesterId: string;
  readonly subtotalAmount: { toString(): string } | null;
  readonly taxAmount: { toString(): string } | null;
  readonly totalAmount: { toString(): string } | null;
  readonly lineRoutingVersionId: string | null;
  readonly lines: readonly LineRoutingPurchaseLine[];
}

interface LineRoutingPurchaseLine {
  readonly id: string;
  readonly lineType: PurchaseLineType;
  readonly lineNumber: number;
  readonly quantity: { toString(): string };
  readonly unit: string | null;
  readonly unitPrice: { toString(): string } | null;
  readonly tax: { toString(): string } | null;
  readonly lineTotal: { toString(): string } | null;
  readonly itemReference: string | null;
  readonly externalRef: string | null;
  readonly technicalDescription: string | null;
}

@Injectable()
export class WorkflowLineRoutingService {
  constructor(
    private readonly lineRoutingRepository: WorkflowLineRoutingRepository,
    private readonly executionRepository: WorkflowExecutionRepository,
    private readonly ruleEngine: RuleEngineService,
    private readonly identity: CommerceIdentityGateway,
    private readonly audit: CommerceAuditGateway,
    private readonly notification: CommerceNotificationGateway
  ) {}

  async routeLinesForDocument(
    actor: CommerceActor,
    purchaseDocument: LineRoutingPurchaseDocument,
    trigger: WorkflowTriggerEvent,
    tx: CommerceTransactionHandle
  ): Promise<WorkflowLineRoutingResult> {
    const routingVersion = purchaseDocument.lineRoutingVersionId
      ? await this.lineRoutingRepository.findById(
          actor.tenantId,
          purchaseDocument.lineRoutingVersionId
        )
      : await this.lineRoutingRepository.findPublishedForTrigger(actor.tenantId, trigger);

    if (!routingVersion) {
      return {
        documentId: purchaseDocument.id,
        trigger,
        routingVersionId: null,
        aggregationPolicy: null,
        createdInstances: [],
        unroutedLineIds: [],
        pendingApproverUserIds: [],
      };
    }

    const routes = this.parseRoutes(routingVersion.routeRules);
    const documentFacts = this.buildDocumentFacts(purchaseDocument);
    const createdInstances: { lineId: string; instanceId: string }[] = [];
    const unroutedLineIds: string[] = [];
    // GAP-9: the owners this routing puts in PENDING, collected inside the caller's unit
    // of work so the notification (created only after commit) addresses exactly the rows
    // this transition created and nothing else.
    const pendingApproverUserIds: string[] = [];

    const ruleSet = workflowLineRoutingRuleSet(routes);

    for (const line of purchaseDocument.lines) {
      const lineFacts = this.buildLineFacts(line);
      const context: EvaluationContext = {
        facts: lineFacts,
        evaluationInstant: new Date().toISOString(),
      };
      const engineResult = this.ruleEngine.evaluateSync(ruleSet, context);
      const plan = planWorkflowLineRouting(
        { routes, multipleMatchBehavior: routingVersion.multipleMatchBehavior },
        { evaluated: true, result: engineResult }
      );

      if (plan.outcome === 'INVALID') {
        throw new BadRequestException(`Line routing invalid: ${plan.reason}`);
      }

      if (plan.outcome === 'AMBIGUOUS') {
        await this.auditLineRouting(actor, purchaseDocument.id, line.id, 'ambiguous', {
          tiedVersionIds: plan.tiedTargetVersionIds,
        });
        throw new BadRequestException(WORKFLOW_LINE_ROUTING_AMBIGUOUS);
      }

      if (plan.outcome === 'NO_ROUTE') {
        if (routingVersion.noRouteBehavior === 'REJECT_OPERATION') {
          await this.auditLineRouting(actor, purchaseDocument.id, line.id, 'no_route_rejected');
          throw new BadRequestException(WORKFLOW_LINE_ROUTING_NO_ROUTE);
        }
        unroutedLineIds.push(line.id);
        await this.auditLineRouting(actor, purchaseDocument.id, line.id, 'no_route_unrouted');
        continue;
      }

      const routed = await this.createLineWorkflow(
        actor,
        purchaseDocument,
        line,
        plan.targetWorkflowDefinitionVersionId,
        documentFacts,
        tx
      );
      const instanceId = routed.instanceId;

      createdInstances.push({ lineId: line.id, instanceId });
      pendingApproverUserIds.push(...routed.pendingApproverUserIds);
      await this.auditLineRouting(actor, purchaseDocument.id, line.id, 'routed', {
        workflowInstanceId: instanceId,
        workflowDefinitionVersionId: plan.targetWorkflowDefinitionVersionId,
      });
      await this.notification.publish(actor, 'commerce.workflow.line.routed', {
        documentId: purchaseDocument.id,
        lineId: line.id,
        workflowInstanceId: instanceId,
      });
    }

    return {
      documentId: purchaseDocument.id,
      trigger,
      routingVersionId: routingVersion.id,
      aggregationPolicy: routingVersion.aggregationPolicy,
      createdInstances,
      unroutedLineIds,
      pendingApproverUserIds,
    };
  }

  private parseRoutes(raw: unknown): readonly WorkflowLineRoute[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException('Routing configuration routeRules must be an array');
    }
    return raw as WorkflowLineRoute[];
  }

  private buildDocumentFacts(purchaseDocument: LineRoutingPurchaseDocument): CommerceWorkflowFacts {
    return projectCommerceWorkflowFacts({
      kind: purchaseDocument.kind,
      currency: purchaseDocument.currency,
      supplierId: purchaseDocument.supplierId,
      requesterId: purchaseDocument.requesterId,
      subtotalAmount: purchaseDocument.subtotalAmount,
      taxAmount: purchaseDocument.taxAmount,
      totalAmount: purchaseDocument.totalAmount,
      lineTotals: purchaseDocument.lines.map((line) => line.lineTotal),
    });
  }

  private buildLineFacts(line: LineRoutingPurchaseLine): CommerceWorkflowFacts {
    return projectCommerceWorkflowLineFacts({
      lineType: line.lineType,
      lineNumber: line.lineNumber,
      quantity: line.quantity,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice,
      tax: line.tax,
      lineTotal: line.lineTotal,
      itemReference: line.itemReference,
      externalRef: line.externalRef,
      technicalDescription: line.technicalDescription,
    });
  }

  private async createLineWorkflow(
    actor: CommerceActor,
    purchaseDocument: LineRoutingPurchaseDocument,
    line: LineRoutingPurchaseLine,
    targetVersionId: string,
    documentFacts: CommerceWorkflowFacts,
    tx: CommerceTransactionHandle
  ): Promise<{ instanceId: string; pendingApproverUserIds: readonly string[] }> {
    const existing = await this.executionRepository.findInstanceBySubject(
      actor.tenantId,
      'PURCHASE_LINE',
      line.id,
      tx
    );
    if (existing) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_ALREADY_ROUTED,
        message: `Line ${line.id} already has a workflow instance.`,
      });
    }

    const version = await this.executionRepository.findPublishedVersion(
      actor.tenantId,
      targetVersionId,
      tx
    );

    if (!version) {
      throw new BadRequestException(WORKFLOW_LINE_ROUTING_TARGET_INVALID);
    }

    const instance = await this.executionRepository.createInstance(actor.tenantId, tx, {
      workflowDefinitionVersionId: version.workflowDefinitionVersionId,
      subjectId: line.id,
      subjectType: 'PURCHASE_LINE',
    });

    const stepInputs = await this.buildFirstGroupStepInputs(
      actor,
      line,
      instance.id,
      version.workflowDefinitionVersionId,
      version.definitionCode,
      version.steps,
      documentFacts
    );

    await this.executionRepository.createStepInstances(actor.tenantId, tx, stepInputs, 'LINE');

    return {
      instanceId: instance.id,
      // GAP-9: the PENDING steps just created, by their stored approver — the only
      // recipient this routing can prove (`resolvedApproverId` is written at activation).
      pendingApproverUserIds: stepInputs.flatMap((input) =>
        input.status === 'PENDING' && input.resolvedApproverId ? [input.resolvedApproverId] : []
      ),
    };
  }

  private async buildFirstGroupStepInputs(
    actor: CommerceActor,
    line: LineRoutingPurchaseLine,
    instanceId: string,
    versionId: string,
    definitionCode: string,
    steps: readonly WorkflowStepRuntimeRow[],
    documentFacts: CommerceWorkflowFacts
  ): Promise<WorkflowStepActivationInput[]> {
    const configurationSteps = steps as unknown as readonly WorkflowStepConfigurationRecord[];
    const groups = workflowStepGroups(configurationSteps);
    if (groups.length === 0) {
      return [];
    }

    const firstGroup = groups[0];
    const activationSet = workflowActivationRuleSet(versionId, definitionCode, configurationSteps);
    const context: EvaluationContext = {
      facts: documentFacts,
      evaluationInstant: new Date().toISOString(),
    };
    const outcome = {
      evaluated: true as const,
      result: this.ruleEngine.evaluateSync(activationSet, context),
    };
    const activation = planWorkflowGroupActivation(configurationSteps, firstGroup, outcome);

    if (activation.outcome === 'REFUSED') {
      throw new BadRequestException(`Line workflow activation refused: ${activation.code}`);
    }

    const inputs: WorkflowStepActivationInput[] = [];
    const ruleSetId = workflowActivationRuleSetId(definitionCode);

    for (const plan of activation.plan.steps) {
      const stepRuntime = steps.find((s) => s.stepKey === plan.stepKey);
      if (!stepRuntime) continue;

      if (stepRuntime.actorSource !== 'CONFIGURED_USER') {
        throw new BadRequestException(WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED);
      }

      if (plan.status === 'PENDING' && plan.resolvedApproverId) {
        await this.identity.assertMember(actor, plan.resolvedApproverId);
      }

      inputs.push({
        workflowInstanceId: instanceId,
        workflowStepId: stepRuntime.id,
        scopeId: line.id,
        status: plan.status,
        resolvedApproverId: plan.resolvedApproverId,
        conditionResult: plan.conditionResult,
        conditionInputSnapshot: documentFacts,
        conditionRuleSetId: ruleSetId,
        conditionRuleVersion: versionId,
      });
    }

    return inputs;
  }

  /**
   * Resolve the aggregation policy of a pinned routing version without crossing the
   * repository boundary. Returns null when the version is not found (preserves O4-D5:
   * no hidden fallback).
   */
  async getAggregationPolicy(
    actor: CommerceActor,
    lineRoutingVersionId: string
  ): Promise<'ALL_APPROVED' | 'INDEPENDENT' | null> {
    const version = await this.lineRoutingRepository.findById(actor.tenantId, lineRoutingVersionId);
    return version ? version.aggregationPolicy : null;
  }

  private async auditLineRouting(
    actor: CommerceActor,
    documentId: string,
    lineId: string,
    action: string,
    extras?: Record<string, unknown>
  ): Promise<void> {
    await this.audit.record(actor, {
      action: `line_routing_${action}`,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: documentId,
      newValue: { lineId, ...extras },
    });
  }
}
