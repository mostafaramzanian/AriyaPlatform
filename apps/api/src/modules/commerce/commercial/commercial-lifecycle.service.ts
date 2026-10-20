import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { PurchaseRepository } from '../purchase/purchase.repository';
import type {
  PurchaseDocumentKind,
  PurchaseDocumentStatus,
  PurchaseLineType,
} from '../purchase/purchase-status';
import { WorkflowExecutionRepository } from '../workflow/workflow-execution.repository';
import {
  projectCommerceWorkflowFacts,
  projectCommerceWorkflowLineFacts,
} from '../workflow/workflow-facts';
import type { CommerceWorkflowFacts } from '../workflow/workflow-facts';
import type { WorkflowInstanceStatus } from '../workflow/workflow-run-status';
import { COMMERCIAL_AUDIT_ACTION, COMMERCIAL_FAILURE } from './commercial.constants';
import { CommercialConfigurationRepository } from './commercial-configuration.repository';
import { CommercialLifecycleRepository } from './commercial-lifecycle.repository';
import { CommercialLiaisonResolver } from './commercial-liaison';
import { computeCommercialProjection } from './commercial-projection';
import {
  commercialApprovalApplicabilityRuleSet,
  commercialAssignmentRuleSet,
  planCommercialAssignment,
} from './commercial-rule';
import type { CommercialAssignmentRule } from './commercial-rule';
import { isCommercialManualAssignmentForbidden } from './commercial-status';
import type {
  CommercialApprovalApprover,
  CommercialAssignmentSource,
  CommercialAssignmentTrigger,
} from './commercial-status';
import type {
  CommercialApprovalDecisionDto,
  CreateCommercialAssignmentDto,
} from './commercial.dto';

/**
 * Phase C1 Step P (§3-A…§3-O, §9): the COMMERCIAL LIFECYCLE orchestration service —
 * assignment, reassignment, commercial approval and the one `PurchaseDocument`
 * projection writer.
 *
 * THE THREE LIFECYCLE IT KEEPS APART, IN ONE SENTENCE EACH
 * ---------------------------------------------------------
 *  Purchase   — `PurchaseDocument.status`, moved only here (§3-F), never by workflow.
 *  Workflow   — `WorkflowInstance.status`, moved only by N's execution service; P READS
 *               it as projection input and never writes it (§4).
 *  Commercial — `CommercialAssignment` + `CommercialApproval`, moved only here, with
 *               their own actors and their own clock (P12).
 *
 * A commercial APPROVED therefore never becomes a purchase CLOSED, and a workflow
 * APPROVED never becomes a purchase APPROVED unless the PINNED policy says so.
 *
 * THE TWO DISPATCH POINTS (§4)
 * ----------------------------
 *  `purchase.service.submit`              → `onPurchaseSubmitted`   (P4 trigger)
 *  `WorkflowExecutionService` settle      → `onWorkflowSettled`     (P4 trigger + §3-F)
 *  plus the explicit API: `assign` and `decide`.
 *
 * All four run INSIDE the caller's unit of work (or open their own when they are the
 * act), and every statement goes through a repository with the opaque handle. This
 * service holds no Prisma client, evaluates rules through `RuleEngineService` and only
 * ever reads persisted state — nothing is recomputed on read (§5).
 *
 * ABSENT CONFIGURATION IS A NO-OP, AN EXPLICIT CALL IS NOT (§3-A)
 * ----------------------------------------------------------------
 * A trigger with no published version changes nothing: no assignment, no approval, no
 * projection — the document stays SUBMITTED. A manual assign, a decision or a publish
 * refuses with a NAMED failure instead, because a caller who asked explicitly must be
 * told why it did not happen.
 */

/**
 * The document shape these paths need, structurally typed so the service never imports
 * the generated client (gate A). It mirrors `workflow-line-routing.service.ts`'s shape
 * plus the two columns §3-B and §3-F depend on.
 */
export interface CommercialPurchaseLine {
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

export interface CommercialPurchaseDocument {
  readonly id: string;
  readonly status: PurchaseDocumentStatus;
  readonly commercialConfigurationVersionId: string | null;
  readonly kind: PurchaseDocumentKind;
  readonly currency: string | null;
  readonly supplierId: string | null;
  readonly requesterId: string;
  readonly subtotalAmount: { toString(): string } | null;
  readonly taxAmount: { toString(): string } | null;
  readonly totalAmount: { toString(): string } | null;
  readonly lines: readonly CommercialPurchaseLine[];
}

/**
 * One stored configuration version, as the repository returns it — structural, so this
 * file never names the generated client (gate A).
 */
type CommercialConfigurationRecord = NonNullable<
  Awaited<ReturnType<CommercialConfigurationRepository['findConfigurationById']>>
>;

/** What one automatic trigger did, so a caller (and a test) can assert it precisely. */
export interface CommercialTriggerResult {
  readonly documentId: string;
  readonly trigger: CommercialAssignmentTrigger | null;
  readonly assignedLineIds: readonly string[];
  readonly unassignedLineIds: readonly string[];
  readonly skippedLineIds: readonly string[];
  /**
   * GAP-9: the approver user ids of the commercial approvals THIS activation created
   * (PENDING rows whose `approverUserId` was stored at activation). Lines that already
   * had a record, or that no rule required one for, contribute nothing — this is a
   * transcript of new pending decisions, never an audience.
   */
  readonly activatedApprovalUserIds: readonly string[];
}

/** The settle notification `WorkflowExecutionService` hands across (§4). */
export interface CommercialWorkflowSettlement {
  readonly subjectType: 'PURCHASE_DOCUMENT' | 'PURCHASE_LINE';
  readonly subjectId: string;
  readonly status: WorkflowInstanceStatus;
  /** O4 aggregation input — supplied by O, consumed by P projection (§O4-D3). */
  readonly aggregationPolicy?: 'ALL_APPROVED' | 'INDEPENDENT' | null;
}

@Injectable()
export class CommercialLifecycleService {
  constructor(
    private readonly configurationRepository: CommercialConfigurationRepository,
    private readonly lifecycleRepository: CommercialLifecycleRepository,
    private readonly purchaseRepository: PurchaseRepository,
    private readonly executionRepository: WorkflowExecutionRepository,
    private readonly ruleEngine: RuleEngineService,
    private readonly liaison: CommercialLiaisonResolver,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  // ---------------------------------------------------------------------------
  // Dispatch point 1 — `purchase.service.submit` (P4)
  // ---------------------------------------------------------------------------

  /**
   * The `PURCHASE_SUBMITTED` activation: pin the configuration, run assignment for the
   * lines, activate approvals if this event is their configured activation, recompute
   * the projection. In ONE unit of work — the caller's — so a refused assignment
   * (`COMMERCIAL_NO_ROUTE`) rolls back the submit with it.
   */
  async onPurchaseSubmitted(
    actor: CommerceActor,
    document: CommercialPurchaseDocument,
    tx: CommerceTransactionHandle,
    aggregationPolicy?: 'ALL_APPROVED' | 'INDEPENDENT' | null
  ): Promise<CommercialTriggerResult | null> {
    return this.applyActivation(actor, document, 'PURCHASE_SUBMITTED', tx, aggregationPolicy);
  }

  // ---------------------------------------------------------------------------
  // Dispatch point 2 — `WorkflowExecutionService` settle (§4, §3-F)
  // ---------------------------------------------------------------------------

  /**
   * A workflow instance reached a terminal state.
   *
   * TWO DIFFERENT QUESTIONS, ANSWERED FROM THE SUBJECT TYPE:
   *  - a DOCUMENT instance is the P4 `AFTER_DOCUMENT_WORKFLOW_APPROVED` event (on
   *    APPROVED) and, under every policy, the §3-F rejection signal (on REJECTED);
   *  - a LINE instance is only a projection input — line workflow outcomes feed
   *    `ALL_LINES` but never activate anything, because the activation vocabulary is
   *    document-level.
   *
   * The document is re-read inside the SAME unit of work, so the projection sees the
   * settle that was just written rather than the snapshot the caller held.
   *
   * GAP-9: returns the approver user ids of the commercial approvals this settle
   * CREATED (`[]` for every projection-only path), so the caller can notify exactly the
   * owners this transition put in PENDING. The returned ids are read from the trigger
   * result of THIS unit of work — never from a re-read that could pick up rows another
   * transaction created.
   */
  async onWorkflowSettled(
    actor: CommerceActor,
    settlement: CommercialWorkflowSettlement,
    tx: CommerceTransactionHandle
  ): Promise<readonly string[]> {
    if (settlement.subjectType === 'PURCHASE_DOCUMENT') {
      if (settlement.status === 'APPROVED') {
        const trigger = await this.applyActivation(
          actor,
          settlement.subjectId,
          'AFTER_DOCUMENT_WORKFLOW_APPROVED',
          tx,
          settlement.aggregationPolicy
        );
        return trigger?.activatedApprovalUserIds ?? [];
      }

      // REJECTED (or any other terminal) is a projection signal only: §3-F writes
      // SUBMITTED → REJECTED here and NOTHING else — commercial state is untouched.
      await this.recomputeProjectionForDocument(
        actor,
        settlement.subjectId,
        tx,
        settlement.aggregationPolicy
      );
      return [];
    }

    const documentId = await this.purchaseRepository.findDocumentIdByLineId(
      actor.tenantId,
      settlement.subjectId,
      tx
    );
    if (!documentId) return [];
    await this.recomputeProjectionForDocument(actor, documentId, tx, settlement.aggregationPolicy);
    return [];
  }

  // ---------------------------------------------------------------------------
  // The activation itself: pin → assign → activate approvals → project (§3-A…§3-B)
  // ---------------------------------------------------------------------------

  /**
   * One configured event, applied to one document.
   *
   * ORDER IS THE CONTRACT'S, NOT A CONVENIENCE:
   *  1. PIN (§3-B) — the first commercial operation freezes the tenant's currently
   *     published version onto the document; everything after this reads ONLY the pin,
   *     so a configuration published later never changes this document's meaning.
   *  2. ASSIGN if the pinned `assignmentTrigger` is this event (P4).
   *  3. ACTIVATE approvals if the pinned `approvalActivation` is this event (§3-G) —
   *     strictly AFTER assignment, because the approver may be the liaison the line was
   *     just assigned to.
   *  4. PROJECT (§3-F) — always attempted; it writes only if the pinned policy says so.
   *
   * Returns `null` for §3-A: nothing published and nothing pinned means no commercial
   * effect at all. Not an error, not an empty assignment — a configured domain that is
   * not configured.
   */
  private async applyActivation(
    actor: CommerceActor,
    documentRef: CommercialPurchaseDocument | string,
    event: CommercialAssignmentTrigger,
    tx: CommerceTransactionHandle,
    aggregationPolicy?: 'ALL_APPROVED' | 'INDEPENDENT' | null
  ): Promise<CommercialTriggerResult | null> {
    const document = await this.readDocument(actor, documentRef, tx);
    if (!document) return null;

    const pinned = await this.resolvePinnedVersion(actor, document, tx);
    if (!pinned) {
      // Nothing to project from either: without a pinned version §3-A keeps the
      // document exactly where the submit (or the workflow) left it.
      return null;
    }

    const wasTrigger = pinned.version.assignmentTrigger === event;
    let assignedLineIds: readonly string[] = [];
    let unassignedLineIds: readonly string[] = [];
    let skippedLineIds: readonly string[] = [];
    let activatedApprovalUserIds: readonly string[] = [];

    if (wasTrigger) {
      const assignment = await this.assignLines(actor, pinned.document, pinned.version, event, tx);
      assignedLineIds = assignment.assignedLineIds;
      unassignedLineIds = assignment.unassignedLineIds;
      skippedLineIds = assignment.skippedLineIds;
    }

    if (pinned.version.approvalActivation === event) {
      activatedApprovalUserIds = await this.activateApprovals(
        actor,
        pinned.document,
        pinned.version,
        tx
      );
    }

    await this.recomputeProjection(actor, pinned.document, pinned.version, tx, aggregationPolicy);

    return {
      documentId: pinned.document.id,
      trigger: wasTrigger ? event : null,
      assignedLineIds,
      unassignedLineIds,
      skippedLineIds,
      activatedApprovalUserIds,
    };
  }

  /**
   * §3-B in code: the document's PIN if it has one, otherwise the tenant's currently
   * published version — written onto the document with the conditional `null → id`
   * statement and returned alongside the row it reloaded.
   *
   * THREE ANSWERS, ALL NAMED:
   *  - `null`      — no published configuration exists (§3-A's no-op);
   *  - a throw     — two published versions (§3-B's ambiguity refuses rather than
   *    choosing) or a pin that cannot be read back (an integrity break, not a 404);
   *  - the pair    — the version to govern this document, and the document carrying it.
   */
  private async resolvePinnedVersion(
    actor: CommerceActor,
    document: CommercialPurchaseDocument,
    tx: CommerceTransactionHandle
  ): Promise<{
    version: CommercialConfigurationRecord;
    document: CommercialPurchaseDocument;
  } | null> {
    if (document.commercialConfigurationVersionId) {
      const version = await this.configurationRepository.findConfigurationById(
        actor.tenantId,
        document.commercialConfigurationVersionId,
        tx
      );
      if (!version) {
        throw new ConflictException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
          message: 'The configuration version pinned to this document no longer exists.',
        });
      }
      return { version, document };
    }

    const published = await this.configurationRepository.listPublishedConfigurations(
      actor.tenantId,
      tx
    );
    if (published.length === 0) return null;
    if (published.length > 1) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_AMBIGUOUS,
        message: `${published.length} commercial configurations are published; exactly one may govern a document (§3-B).`,
      });
    }

    const pinnedDocument = await this.purchaseRepository.pinCommercialConfigurationVersionIn(
      actor.tenantId,
      tx,
      document.id,
      published[0].id
    );
    if (!pinnedDocument) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The document could not be read back after pinning its configuration.',
      });
    }

    return { version: published[0], document: pinnedDocument };
  }

  // ---------------------------------------------------------------------------
  // Assignment (§3-C, §3-D, §3-H, P3/P5/P6)
  // ---------------------------------------------------------------------------

  /**
   * Assign every line that has no current row, under the PINNED configuration.
   *
   * §3-H's rule, stated once: an automatic trigger SKIPS a line that already has a
   * current assignment (no duplicate, no silent overwrite), while a manual call on the
   * same line is a REASSIGNMENT — a different method, below.
   *
   * PER LINE, IN THIS ORDER (§3-D → §3-K → §3-C):
   *  1. the Rule Engine decides the group, deterministically, under the pinned rule set
   *     — never "the latest rule", never a second evaluator;
   *  2. no match → the CONFIGURED behaviour: a named refusal (`COMMERCIAL_NO_ROUTE`,
   *     rolling the unit of work back) or an explicit `UNASSIGNED` current row;
   *  3. a match → the group's configured liaison is resolved and validated (§3-K), and
   *     only then is anything written;
   *  4. the CURRENT row and its APPEND-ONLY history entry are written together, in this
   *     one unit of work, so no caller can reach one without the other (§3-C).
   *
   * `actorUserId` on the history row is NULL by design (§3-E: "NULL for a configured
   * trigger, set for MANUAL") — the cause of this change is the CONFIGURATION, and
   * recording the person who happened to press submit as its author would say the
   * opposite of what happened.
   */
  private async assignLines(
    actor: CommerceActor,
    document: CommercialPurchaseDocument,
    version: CommercialConfigurationRecord,
    source: CommercialAssignmentSource,
    tx: CommerceTransactionHandle
  ) {
    const rules = this.readAssignmentRules(version);
    const ruleSet = commercialAssignmentRuleSet(rules);
    const current = await this.lifecycleRepository.listAssignmentsByDocument(
      actor.tenantId,
      document.id,
      tx
    );
    const alreadyAssigned = new Set(current.map((row) => row.purchaseLineId));

    const assignedLineIds: string[] = [];
    const unassignedLineIds: string[] = [];
    const skippedLineIds: string[] = [];

    for (const line of document.lines) {
      if (alreadyAssigned.has(line.id)) {
        skippedLineIds.push(line.id);
        continue;
      }

      const plan = planCommercialAssignment(rules, version.matchBehavior, {
        evaluated: true as const,
        result: this.ruleEngine.evaluateSync(ruleSet, {
          facts: projectCommerceWorkflowLineFacts({
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
          }),
          evaluationInstant: new Date().toISOString(),
        }),
      });

      if (plan.outcome === 'INVALID') {
        throw new BadRequestException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_RULE_INVALID,
          message: `Line ${line.id}: the assignment rule set could not decide (${plan.reason}).`,
        });
      }

      if (plan.outcome === 'AMBIGUOUS') {
        throw new BadRequestException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_AMBIGUOUS_MATCH,
          message: `Line ${line.id}: ${plan.tiedGroupIds.length} assignment rules matched and matchBehavior is AMBIGUOUS_ERROR.`,
        });
      }

      if (plan.outcome === 'UNASSIGNED') {
        if (version.noAssignmentBehavior === 'REJECT_OPERATION') {
          throw new BadRequestException({
            code: COMMERCIAL_FAILURE.COMMERCIAL_NO_ROUTE,
            message: `Line ${line.id} matched no assignment rule and the configured noAssignmentBehavior is REJECT_OPERATION.`,
          });
        }

        await this.writeAssignment(
          actor,
          {
            purchaseLineId: line.id,
            purchaseDocumentId: document.id,
            commercialGroupId: null,
            status: 'UNASSIGNED',
            source,
            resolvedUserId: null,
            matchedRuleLabel: null,
            configurationVersionId: version.id,
          },
          { actorUserId: null, reason: null },
          COMMERCIAL_AUDIT_ACTION.UNASSIGNED,
          tx
        );
        unassignedLineIds.push(line.id);
        continue;
      }

      const group = await this.configurationRepository.findGroupById(
        actor.tenantId,
        plan.commercialGroupId,
        tx
      );
      if (!group) {
        throw new NotFoundException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_GROUP_NOT_FOUND,
          message: `Commercial group ${plan.commercialGroupId} was not found in this tenant.`,
        });
      }

      // §3-K: a matched group with no configured liaison REFUSES — it never falls back
      // to another user, because `resolvedUserId` must be somebody the configuration
      // actually named.
      const resolvedUserId = await this.liaison.resolveGroupLiaison(
        actor,
        group,
        `commercial assignment for line ${line.id}`
      );

      await this.writeAssignment(
        actor,
        {
          purchaseLineId: line.id,
          purchaseDocumentId: document.id,
          commercialGroupId: group.id,
          status: 'ASSIGNED',
          source,
          resolvedUserId,
          matchedRuleLabel: plan.matchedLabel,
          configurationVersionId: version.id,
        },
        { actorUserId: null, reason: null },
        COMMERCIAL_AUDIT_ACTION.ASSIGNED,
        tx
      );
      assignedLineIds.push(line.id);
    }

    return { assignedLineIds, unassignedLineIds, skippedLineIds };
  }

  /**
   * The ONE write that produces a current row AND its history entry — used by the
   * automatic trigger and by the manual operation alike, so "every change to the
   * current row writes a new history row" (§3-C) is one place rather than two that
   * could be kept apart.
   *
   * Audit is recorded inside the unit of work, following `workflow-line-routing
   * .service.ts` (O's precedent): a refusal that rolls the act back must still leave
   * the refusal in the trail, and `CommerceAuditGateway` never throws, so the trail
   * cannot change the outcome.
   */
  private async writeAssignment(
    actor: CommerceActor,
    write: {
      purchaseLineId: string;
      purchaseDocumentId: string;
      commercialGroupId: string | null;
      status: 'ASSIGNED' | 'UNASSIGNED';
      source: CommercialAssignmentSource;
      resolvedUserId: string | null;
      matchedRuleLabel: string | null;
      configurationVersionId: string | null;
    },
    provenance: { actorUserId: string | null; reason: string | null },
    action: string,
    tx: CommerceTransactionHandle
  ) {
    const created = await this.lifecycleRepository.createAssignmentIn(actor.tenantId, tx, write);

    await this.lifecycleRepository.appendAssignmentHistoryIn(actor.tenantId, tx, {
      purchaseLineId: write.purchaseLineId,
      commercialGroupId: write.commercialGroupId,
      status: write.status,
      source: write.source,
      resolvedUserId: write.resolvedUserId,
      matchedRuleLabel: write.matchedRuleLabel,
      configurationVersionId: write.configurationVersionId,
      actorUserId: provenance.actorUserId,
      reason: provenance.reason,
    });

    await this.audit.record(actor, {
      action,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_ASSIGNMENT,
      resourceId: created.id,
      newValue: {
        purchaseLineId: write.purchaseLineId,
        purchaseDocumentId: write.purchaseDocumentId,
        commercialGroupId: write.commercialGroupId,
        status: write.status,
        source: write.source,
        resolvedUserId: write.resolvedUserId,
        matchedRuleLabel: write.matchedRuleLabel,
        configurationVersionId: write.configurationVersionId,
        reason: provenance.reason,
      },
    });

    return created;
  }

  // ---------------------------------------------------------------------------
  // Commercial approval activation (§3-G, P12) — its OWN lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the PENDING record for every ASSIGNED line the configuration says needs one.
   *
   * §3-G, exactly as written:
   *  - records exist only for a document whose LINES have a commercial assignment, and
   *    a line whose current row says `UNASSIGNED` has no one to ask — so it gets no
   *    record rather than a fake approver (§3-K's "no fallback user");
   *  - applicability is the optional bound condition evaluated against the DOCUMENT
   *    catalogue: `true`/no condition → `PENDING`, `false` → NO record;
   *  - `approverUserId` is resolved and STORED now, not at decision time — the decision
   *    route compares against this row, which is what makes "the approver the
   *    configuration named at activation" a fact rather than a later opinion;
   *  - one record per line (`@@unique([tenantId, purchaseLineId])`), so a re-fired
   *    activation skips lines that already have one instead of failing.
   *
   * The applicability outcome IS persisted on the record (§5: nothing is recomputed on
   * read) — `NULL` meaning "no condition was bound", never "not evaluated".
   *
   * GAP-9: returns the approver user ids of the records this call CREATED, so a caller
   * can notify exactly the owners this activation put in PENDING. Records that already
   * existed contribute nothing — a re-fired activation is idempotent for the row AND
   * therefore silent for the notification.
   */
  private async activateApprovals(
    actor: CommerceActor,
    document: CommercialPurchaseDocument,
    version: CommercialConfigurationRecord,
    tx: CommerceTransactionHandle
  ): Promise<readonly string[]> {
    if (version.approvalActivation === 'NOT_REQUIRED') return [];

    if (!version.approvalApprover) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: `The pinned configuration activates commercial approval but states no approver resolver (§7.8).`,
      });
    }
    const approver: CommercialApprovalApprover = version.approvalApprover;

    const assignments = await this.lifecycleRepository.listAssignmentsByDocument(
      actor.tenantId,
      document.id,
      tx
    );
    const assignmentByLine = new Map(assignments.map((row) => [row.purchaseLineId, row]));
    const existing = await this.lifecycleRepository.listApprovalsByDocument(
      actor.tenantId,
      document.id,
      tx
    );
    const existingLines = new Set(existing.map((row) => row.purchaseLineId));
    const activatedApprovalUserIds: string[] = [];

    const boundCondition =
      version.applicabilityCondition === null || version.applicabilityCondition === undefined
        ? null
        : (version.applicabilityCondition as unknown as RuleConditionNode);
    const documentFacts = projectCommerceWorkflowFacts({
      kind: document.kind,
      currency: document.currency,
      supplierId: document.supplierId,
      requesterId: document.requesterId,
      subtotalAmount: document.subtotalAmount,
      taxAmount: document.taxAmount,
      totalAmount: document.totalAmount,
      lineTotals: document.lines.map((line) => line.lineTotal),
    });

    for (const line of document.lines) {
      const assignment = assignmentByLine.get(line.id);
      if (!assignment || assignment.status !== 'ASSIGNED') continue;
      if (existingLines.has(line.id)) continue;

      let applicabilityResult: boolean | null = null;
      if (boundCondition !== null) {
        applicabilityResult = this.evaluateApplicability(boundCondition, documentFacts);
        if (!applicabilityResult) continue;
      }

      // §3-G + P10: LINE_COMMERCIAL_LIAISON takes the line's stored assignment user,
      // CONFIGURED_USER the configuration's own — each validated through the gateway.
      const approverUserId = await this.liaison.resolveApprovalApprover(
        actor,
        approver,
        {
          approverUserId: version.approverUserId,
          assignmentUserId: assignment.resolvedUserId,
        },
        `commercial approval for line ${line.id}`
      );

      const created = await this.lifecycleRepository.createApprovalIn(actor.tenantId, tx, {
        purchaseLineId: line.id,
        purchaseDocumentId: document.id,
        approver,
        approverUserId,
        applicabilityResult,
        configurationVersionId: version.id,
      });

      // Deliberately NOT audited: §20's closed list records assignment, reassignment,
      // unassignment and DECISIONS — activation is an automatic consequence of a
      // configured event, and one more trail entry per line would say somebody decided
      // something when nobody did.
      //
      // GAP-9: the row's NEW pending owner — `approverUserId` is the stored,
      // tenant-validated decision owner (§3-G), resolved at activation above.
      activatedApprovalUserIds.push(created.approverUserId);
    }

    return activatedApprovalUserIds;
  }

  /**
   * The bound applicability condition, decided by the ONE engine.
   *
   * `DECIDED` → applicable, `NO_MATCH` → not applicable, anything else (`REFUSED_*`,
   * `CONFLICT`) → a NAMED refusal: an undecidable condition must never be read as
   * `false`, because `false` means "this document genuinely does not require approval"
   * and is a decision an administrator configured on purpose.
   */
  private evaluateApplicability(
    condition: RuleConditionNode,
    facts: CommerceWorkflowFacts
  ): boolean {
    const result = this.ruleEngine.evaluateSync(commercialApprovalApplicabilityRuleSet(condition), {
      facts,
      evaluationInstant: new Date().toISOString(),
    });

    if (result.status === 'DECIDED') return true;
    if (result.status === 'NO_MATCH') return false;

    throw new BadRequestException({
      code: COMMERCIAL_FAILURE.COMMERCIAL_RULE_INVALID,
      message: `The commercial approval applicability condition could not be decided (${result.status}).`,
    });
  }

  // ---------------------------------------------------------------------------
  // The ONE PurchaseDocument projection writer (§3-F, P11)
  // ---------------------------------------------------------------------------

  /**
   * Recompute a document by id — the entry point the two DISPATCH POINTS use when all
   * they hold is the subject that just settled.
   *
   * §3-A applies: a document with nothing pinned has no configured policy, so there is
   * no answer to give and nothing is written. The document and the pin are read inside
   * the SAME unit of work, so the settle that triggered this call is already visible.
   */
  private async recomputeProjectionForDocument(
    actor: CommerceActor,
    documentId: string,
    tx: CommerceTransactionHandle,
    aggregationPolicy?: 'ALL_APPROVED' | 'INDEPENDENT' | null
  ): Promise<void> {
    const document = await this.purchaseRepository.findDocumentById(actor.tenantId, documentId, tx);
    if (!document || !document.commercialConfigurationVersionId) return;

    const version = await this.configurationRepository.findConfigurationById(
      actor.tenantId,
      document.commercialConfigurationVersionId,
      tx
    );
    if (!version) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The configuration version pinned to this document no longer exists.',
      });
    }

    await this.recomputeProjection(actor, document, version, tx, aggregationPolicy);
  }

  /**
   * The projection itself: four persisted facts in, at most ONE write out.
   *
   * EVERY INPUT IS READ, NONE IS INFERRED: the pinned policy (never "today's"), the
   * document workflow instance, each line's workflow instance and the commercial
   * approvals. The decision is `computeCommercialProjection` — pure and exhaustively
   * tested — and the write is the repository's conditional `SUBMITTED → …` statement.
   *
   * THERE IS NO OTHER WRITER. `PurchaseDocument.status` moves from `SUBMITTED` to
   * `APPROVED`/`REJECTED` exactly here, and never to `CLOSED`: §3-F's "APPROVED never
   * becomes CLOSED automatically" is enforced by there being no call that could ask.
   */
  private async recomputeProjection(
    actor: CommerceActor,
    document: CommercialPurchaseDocument,
    version: CommercialConfigurationRecord,
    tx: CommerceTransactionHandle,
    aggregationPolicy?: 'ALL_APPROVED' | 'INDEPENDENT' | null
  ) {
    const documentInstance = await this.executionRepository.findInstanceBySubject(
      actor.tenantId,
      'PURCHASE_DOCUMENT',
      document.id,
      tx
    );
    const lineInstances = await this.executionRepository.listInstancesBySubjects(
      actor.tenantId,
      'PURCHASE_LINE',
      document.lines.map((line) => line.id),
      tx
    );
    const approvals = await this.lifecycleRepository.listApprovalsByDocument(
      actor.tenantId,
      document.id,
      tx
    );

    const target = computeCommercialProjection({
      documentStatus: document.status,
      policy: version.projectionPolicy,
      documentWorkflowStatus: documentInstance ? documentInstance.status : null,
      lineCount: document.lines.length,
      lineWorkflowStatuses: lineInstances.map((instance) => instance.status),
      commercialApprovalStatuses: approvals.map((approval) => approval.status),
      aggregationPolicy: aggregationPolicy ?? null,
    });

    if (!target) return null;
    return this.purchaseRepository.applyCommercialTransitionIn(
      actor.tenantId,
      tx,
      document.id,
      target,
      actor.userId
    );
  }

  // ---------------------------------------------------------------------------
  // The explicit API (§3-H, §3-G, §9) — never a no-op, always a named answer
  // ---------------------------------------------------------------------------

  /**
   * MANUAL assignment / reassignment (§9: `lineId`, `groupId`, optional `reason`).
   *
   * §3-H, in the order the guards are asked:
   *  1. a configuration must exist — pinned, or currently published for an unpinned
   *     document; §3-B says later operations read ONLY the pin, so an archived-but-
   *     pinned version still governs this document. Absence of both is
   *     `COMMERCIAL_CONFIGURATION_NOT_PUBLISHED`, because §3-A forbids an explicit
   *     call from quietly doing nothing;
   *  2. the document must not be terminal (`REJECTED`/`CANCELLED`/`CLOSED`) —
   *     `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE`;
   *  3. the group must be THIS tenant's, and its liaison must resolve (§3-K);
   *  4. an existing current row makes this a REASSIGNMENT (P7): the current row takes
   *     the new state while a NEW history entry records actor, timestamp and reason —
   *     and asking for exactly what is already there is
   *     `COMMERCIAL_INVALID_REASSIGNMENT` rather than a silent success.
   *
   * History's `actorUserId` is SET here, unlike the trigger's: §3-E says "set for
   * MANUAL". One unit of work, so the current row, its history entry and the projection
   * that follows from them commit together or not at all (§3-O).
   */
  async assign(actor: CommerceActor, dto: CreateCommercialAssignmentDto) {
    const documentId = await this.purchaseRepository.findDocumentIdByLineId(
      actor.tenantId,
      dto.lineId
    );
    if (!documentId) throw new NotFoundException('Purchase line not found');

    return this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      const document = await this.purchaseRepository.findDocumentById(
        actor.tenantId,
        documentId,
        tx
      );
      if (!document) throw new NotFoundException('Purchase document not found');

      if (isCommercialManualAssignmentForbidden(document.status)) {
        throw new ConflictException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_ASSIGNMENT_IMPOSSIBLE,
          message: `A purchase document in status ${document.status} can no longer be assigned (§3-H).`,
        });
      }

      const pinned = await this.resolvePinnedVersion(actor, document, tx);
      if (!pinned) {
        throw new ConflictException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_NOT_PUBLISHED,
          message: 'No commercial configuration is published for this tenant (§3-A).',
        });
      }

      const group = await this.configurationRepository.findGroupById(
        actor.tenantId,
        dto.groupId,
        tx
      );
      if (!group) {
        throw new NotFoundException('Commercial group not found');
      }

      const resolvedUserId = await this.liaison.resolveGroupLiaison(
        actor,
        group,
        `manual assignment of line ${dto.lineId}`
      );
      const reason = dto.reason ?? null;

      const existing = await this.lifecycleRepository.findAssignmentByLine(
        actor.tenantId,
        dto.lineId,
        tx
      );

      if (existing) {
        if (
          existing.status === 'ASSIGNED' &&
          existing.commercialGroupId === group.id &&
          existing.resolvedUserId === resolvedUserId
        ) {
          throw new ConflictException({
            code: COMMERCIAL_FAILURE.COMMERCIAL_INVALID_REASSIGNMENT,
            message: 'This line is already assigned to that group and liaison (§3-H).',
          });
        }

        const changed = await this.lifecycleRepository.changeAssignmentIn(
          actor.tenantId,
          tx,
          dto.lineId,
          {
            commercialGroupId: group.id,
            status: 'ASSIGNED',
            source: 'MANUAL',
            resolvedUserId,
            matchedRuleLabel: null,
            configurationVersionId: pinned.version.id,
          }
        );
        if (!changed) {
          throw new ConflictException({
            code: COMMERCIAL_FAILURE.COMMERCIAL_ASSIGNMENT_NOT_FOUND,
            message: 'The current assignment changed while this request was being applied.',
          });
        }

        // The history entry names the state that TOOK EFFECT; the previous one remains
        // the preceding row for this line — §3-C's "January stays readable after
        // February" is this append, never an update.
        await this.lifecycleRepository.appendAssignmentHistoryIn(actor.tenantId, tx, {
          purchaseLineId: dto.lineId,
          commercialGroupId: group.id,
          status: 'ASSIGNED',
          source: 'MANUAL',
          resolvedUserId,
          matchedRuleLabel: null,
          configurationVersionId: pinned.version.id,
          actorUserId: actor.userId,
          reason,
        });

        await this.audit.record(actor, {
          action: COMMERCIAL_AUDIT_ACTION.REASSIGNED,
          resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_ASSIGNMENT,
          resourceId: changed.id,
          oldValue: {
            commercialGroupId: existing.commercialGroupId,
            resolvedUserId: existing.resolvedUserId,
            status: existing.status,
          },
          newValue: {
            purchaseLineId: dto.lineId,
            commercialGroupId: group.id,
            resolvedUserId,
            status: 'ASSIGNED',
            reason,
          },
        });

        await this.recomputeProjection(actor, document, pinned.version, tx);
        return changed;
      }

      const created = await this.writeAssignment(
        actor,
        {
          purchaseLineId: dto.lineId,
          purchaseDocumentId: documentId,
          commercialGroupId: group.id,
          status: 'ASSIGNED',
          source: 'MANUAL',
          resolvedUserId,
          matchedRuleLabel: null,
          configurationVersionId: pinned.version.id,
        },
        { actorUserId: actor.userId, reason },
        COMMERCIAL_AUDIT_ACTION.ASSIGNED,
        tx
      );

      await this.recomputeProjection(actor, document, pinned.version, tx);
      return created;
    });
  }

  /**
   * A COMMERCIAL decision (§9) — approve or reject ONE record.
   *
   * This is not `WorkflowStepInstance.decision` and does not touch it (P12): a separate
   * table, a separate actor, a separate clock, a separate permission. The checks are
   * §3-G's own four, in this order:
   *  1. the record exists in THIS tenant (404 otherwise — no existence leaks);
   *  2. the acting user EQUALS the approver stored at activation — a mismatch is
   *     `COMMERCIAL_APPROVAL_ACTOR_MISMATCH`, including a request with no user at all;
   *  3. the record is still `PENDING` — `COMMERCIAL_APPROVAL_NOT_PENDING`, which is
   *     also what a concurrent duplicate decision answers, because the repository's
   *     write is conditional on the state it read;
   *  4. the decision and the PROJECTION that follows from it are ONE unit of work
   *     (§3-G: "then drives the projection recompute (F) in the same unit of work").
   */
  async decide(actor: CommerceActor, id: string, dto: CommercialApprovalDecisionDto) {
    const approval = await this.lifecycleRepository.findApprovalById(actor.tenantId, id);
    if (!approval) {
      throw new NotFoundException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_APPROVAL_NOT_FOUND,
        message: 'Commercial approval not found',
      });
    }

    if (!actor.userId || actor.userId !== approval.approverUserId) {
      throw new BadRequestException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_APPROVAL_ACTOR_MISMATCH,
        message: 'Only the approver resolved at activation may decide this record (§3-G).',
      });
    }

    if (approval.status !== 'PENDING') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_APPROVAL_NOT_PENDING,
        message: `This commercial approval is already ${approval.status}.`,
      });
    }

    const decidedAt = new Date();
    const comment = dto.comment ?? null;

    // Phase B2.3: build the durable outbox payload BEFORE the unit of work.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: COMMERCIAL_AUDIT_ACTION.APPROVAL_DECIDED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_APPROVAL,
      resourceId: id,
      oldValue: { status: approval.status },
      newValue: {
        status: dto.decision,
        decidedByUserId: actor.userId as string,
        decidedAt,
        comment,
      },
    });

    const decided = await this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      const result = await this.lifecycleRepository.decideApprovalIn(
        actor.tenantId,
        tx,
        id,
        {
          status: dto.decision,
          decidedByUserId: actor.userId as string,
          decidedAt,
          comment,
        },
        outbox
      );
      if (!result) {
        throw new ConflictException({
          code: COMMERCIAL_FAILURE.COMMERCIAL_APPROVAL_NOT_PENDING,
          message: 'This commercial approval was decided while this request was being applied.',
        });
      }

      await this.recomputeProjectionForDocument(actor, result.purchaseDocumentId, tx);
      return result;
    });

    return decided;
  }

  // ---------------------------------------------------------------------------
  // The §9 reads
  // ---------------------------------------------------------------------------

  /** A document's CURRENT assignments plus its APPEND-ONLY history (§9). */
  async listAssignments(actor: CommerceActor, documentId: string) {
    const document = await this.purchaseRepository.findDocumentById(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');

    const [assignments, history] = await Promise.all([
      this.lifecycleRepository.listAssignmentsByDocument(actor.tenantId, documentId),
      this.lifecycleRepository.listHistoryByLines(
        actor.tenantId,
        document.lines.map((line) => line.id)
      ),
    ]);

    return { documentId, assignments, history };
  }

  /** A document's commercial approvals (§9) — its OWN lifecycle, not the workflow's. */
  async listApprovals(actor: CommerceActor, documentId: string) {
    const document = await this.purchaseRepository.findDocumentById(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');

    const approvals = await this.lifecycleRepository.listApprovalsByDocument(
      actor.tenantId,
      documentId
    );
    return { documentId, approvals };
  }

  // ---------------------------------------------------------------------------
  // Two helpers the activation path reads through
  // ---------------------------------------------------------------------------

  /**
   * The document a dispatch carries — an id (settle path) or the row the caller just
   * wrote (submit path). A `null` id is an unknown document for this tenant, which an
   * AUTOMATIC event treats as nothing to do: the refusal vocabulary belongs to calls a
   * person made, and there is no caller here to inform.
   */
  private async readDocument(
    actor: CommerceActor,
    reference: CommercialPurchaseDocument | string,
    tx: CommerceTransactionHandle
  ): Promise<CommercialPurchaseDocument | null> {
    if (typeof reference !== 'string') return reference;
    return this.purchaseRepository.findDocumentById(actor.tenantId, reference, tx);
  }

  /**
   * The pinned version's stored candidate list, as the planner's own type.
   *
   * A configuration that reaches runtime was validated by §7, so the shape check here
   * is a NAMED refusal for the one case §7 could not have seen (a row written outside
   * this service) rather than an assumption that would surface as a crash mid-trigger.
   */
  private readAssignmentRules(
    version: CommercialConfigurationRecord
  ): readonly CommercialAssignmentRule[] {
    if (!Array.isArray(version.assignmentRules)) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The pinned configuration carries no assignmentRules array (§7.3).',
      });
    }
    return version.assignmentRules as unknown as readonly CommercialAssignmentRule[];
  }
}
