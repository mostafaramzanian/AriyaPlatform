import { Injectable } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import {
  resolveCommercePageWindow,
  type CommercePageQueryDto,
} from '../dto/commerce-query.dto';
import { CommercialLifecycleRepository } from '../commercial/commercial-lifecycle.repository';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { WorkflowExecutionRepository } from '../workflow/workflow-execution.repository';

/**
 * PHASE C2 (GAP-1b): «نیازمند اقدام من» as a SERVER-AUTHORITATIVE read — which currently
 * actionable decisions belong to the authenticated Commerce user, in this tenant.
 *
 * WHAT ANSWERS THE QUESTION, AND WHY IT IS THE SERVER'S. Before C2 the frontend could only
 * approximate this by paging documents and filtering client-side (the bounded Option A the
 * UI-0 contract documented). This service replaces that composition with two indexed,
 * tenant-scoped, actor-scoped queries — one per decision system the source actually has —
 * and ONE eligibility definition per system: the exact predicate each execution route
 * enforces before it will write (see the two repositories' own comments). A row listed
 * here is therefore a row the backend WILL execute, and the contract's invariant holds by
 * construction: listed-as-actionable ⇒ the server can authorize the action. The race
 * between listing and executing is deliberately left to the execution route's conditional
 * write (409), never "removed" by weakening authorization to make the list look final.
 *
 * THIS IS A PROJECTION, NOT A TASK ENGINE: no assignment, priority, SLA or delegation
 * exists here, and the two kinds are never merged into a shared model the domain does not
 * have — each row keeps its `kind` so the client routes to the DECIDE its kind exists for.
 *
 * ORDERING AND PAGING (deterministic, no invented business priority): each source reads
 * newest-first with `id` as tie-break (the register's convention) bounded by the exact
 * window the page needs; the union sorts by `createdAt` desc / `id` asc — a technical
 * order — and is sliced to the page; `total` is the sum of both counts. Taking
 * `skip + take` rows per source makes the merged slice exact: an item outside its own
 * source's window has at least that many newer items of its own kind and cannot belong.
 */
export type CommercePendingDecisionKind = 'WORKFLOW_STEP' | 'COMMERCIAL_APPROVAL';

/** One actionable decision, as the inbox returns it — never a raw repository row. */
export interface CommercePendingDecisionItem {
  /** Which execution route this row belongs to — the ONLY way its fields are interpreted. */
  readonly kind: CommercePendingDecisionKind;
  /** The actionable record's own id: the step INSTANCE id, or the approval id. */
  readonly id: string;
  /** Always `PENDING` — the queries select it; a non-pending row is not a task. */
  readonly status: 'PENDING';
  /** When the actionable record was created (ISO 8601). */
  readonly createdAt: string;
  /** The purchase document this decision concerns — `null` only when its opaque reference
   *  resolves to no row this tenant holds (a broken reference, never another tenant). */
  readonly purchaseDocumentId: string | null;
  readonly documentNumber: string | null;
  /** The line the decision concerns: a commercial approval's line, or a LINE-scoped run's. */
  readonly purchaseLineId: string | null;
  readonly workflowInstanceId: string | null;
  /** The configured step's key and its AUTHORED name (from the pinned version's step row). */
  readonly stepKey: string | null;
  readonly stepName: string | null;
}

/** What both halves sort by: newest first, `id` breaking same-instant ties. */
function newestFirst(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

@Injectable()
export class PendingDecisionsService {
  constructor(
    private readonly executions: WorkflowExecutionRepository,
    private readonly approvals: CommercialLifecycleRepository,
    private readonly purchases: PurchaseRepository
  ) {}

  /** One page of THIS user's actionable decisions, both systems, tenant-scoped. */
  async list(actor: CommerceActor, query: CommercePageQueryDto) {
    const window = resolveCommercePageWindow(query);

    /*
     * A session with no user id (a non-interactive principal) has no "mine": the answer
     * is an EMPTY page, never a tenant-wide one — same posture the UI-1 Option A
     * composition took when the session carried no acting user.
     */
    if (!actor.userId) {
      return { items: [], page: window.page, pageSize: window.pageSize, total: 0 };
    }

    // Exact top-N window per source: an item outside its own source's `skip + take` rows
    // is not part of the requested merged page either (see the class comment).
    const take = window.skip + window.take;
    const [steps, stepTotal] = await this.executions.listPendingStepPage(
      actor.tenantId,
      actor.userId,
      { take }
    );
    const [approvals, approvalTotal] = await this.approvals.listPendingApprovalPage(
      actor.tenantId,
      actor.userId,
      { take }
    );

    // Display joins in ONE round trip per shape — never one per task row (the C2 contract).
    const documentIds = steps
      .filter((step) => step.instance.subjectType === 'PURCHASE_DOCUMENT')
      .map((step) => step.instance.subjectId);
    const lineIds = steps
      .filter((step) => step.instance.subjectType === 'PURCHASE_LINE')
      .map((step) => step.instance.subjectId);
    const lineDocuments = await this.purchases.findDocumentIdsByLineIds(actor.tenantId, lineIds);
    documentIds.push(...lineDocuments.values());

    const numbers = await this.purchases.findDocumentNumbersByIds(actor.tenantId, [
      ...documentIds,
      ...approvals.map((approval) => approval.purchaseDocumentId),
    ]);

    const items: CommercePendingDecisionItem[] = [
      ...steps.map((step): CommercePendingDecisionItem => {
        const documentId =
          step.instance.subjectType === 'PURCHASE_DOCUMENT'
            ? step.instance.subjectId
            : (lineDocuments.get(step.instance.subjectId) ?? null);
        return {
          kind: 'WORKFLOW_STEP',
          id: step.id,
          status: 'PENDING',
          createdAt: step.createdAt.toISOString(),
          purchaseDocumentId: documentId,
          documentNumber: documentId ? (numbers.get(documentId) ?? null) : null,
          purchaseLineId: step.scopeType === 'LINE' ? step.scopeId : null,
          workflowInstanceId: step.instance.id,
          stepKey: step.stepDefinition.stepKey,
          stepName: step.stepDefinition.displayName,
        };
      }),
      ...approvals.map((approval): CommercePendingDecisionItem => ({
        kind: 'COMMERCIAL_APPROVAL',
        id: approval.id,
        status: 'PENDING',
        createdAt: approval.createdAt.toISOString(),
        purchaseDocumentId: approval.purchaseDocumentId,
        documentNumber: numbers.get(approval.purchaseDocumentId) ?? null,
        purchaseLineId: approval.purchaseLineId,
        workflowInstanceId: null,
        stepKey: null,
        stepName: null,
      })),
    ];

    items.sort(newestFirst);

    return {
      items: items.slice(window.skip, window.skip + window.take),
      page: window.page,
      pageSize: window.pageSize,
      total: stepTotal + approvalTotal,
    };
  }
}
