import type { PurchaseDocumentStatus } from '../purchase/purchase-status';
import type { WorkflowInstanceStatus } from '../workflow/workflow-run-status';
import type { CommercialApprovalState, CommercialProjectionPolicy } from './commercial-status';

/**
 * Phase C1 Step P (§3-F, P11): the `PurchaseDocument` PROJECTION decision, as a PURE
 * function of persisted state.
 *
 * WHY THIS IS ITS OWN FILE AND NOT A PRIVATE METHOD OF THE LIFECYCLE SERVICE
 * -------------------------------------------------------------------------
 * §3-F requires ONE explicit writer for `PurchaseDocument.status` and forbids the two
 * identities everyone confuses: workflow-approved is not purchase-approved, and
 * commercial-approved is not purchase-closed. A projection written inline inside the
 * service that performs assignments would be readable only by opening that service and
 * testable only with a database. Here it is a total function from facts to
 * `APPROVED | REJECTED | null`, which is what makes the §10 projection matrix a table of
 * assertions rather than a sequence of integration cases.
 *
 * `null` MEANS "WRITE NOTHING". That is the ordinary answer: the document is not
 * SUBMITTED, no workflow exists yet, a required approval is still PENDING, or the
 * configured policy's inputs are not all satisfied. A projection that answered `null`
 * with a status anyway would be the hidden business rule §0 forbids.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 *  - It cannot write `CLOSED`. No policy member produces it, and the writer refuses any
 *    edge but `SUBMITTED → APPROVED` / `SUBMITTED → REJECTED` (§3-F, §11: the `→ CLOSED`
 *    edge is not added by P).
 *  - It cannot write `REJECTED` from a COMMERCIAL rejection. Only the document workflow
 *    is the rejection vehicle — "a commercial rejection NEVER writes
 *    `PurchaseDocument.REJECTED`".
 *  - It cannot read anything. No repository, no clock, no configuration lookup: the
 *    caller supplies the pinned policy and the rows it already read.
 */

/** What the ONE projection writer is allowed to write, and nothing else. */
export type CommercialProjectionTarget = 'APPROVED' | 'REJECTED';

/** Every input the decision reads — all of them persisted, none of them derived. */
export interface CommercialProjectionInput {
  /** The document's own commercial lifecycle; writes happen ONLY from `SUBMITTED`. */
  readonly documentStatus: PurchaseDocumentStatus;
  /** The PINNED `CommercialProjectionPolicy` (§3-B) — never "the tenant's current one". */
  readonly policy: CommercialProjectionPolicy;
  /** The pinned document workflow instance's status, or `null` when none was ever created. */
  readonly documentWorkflowStatus: WorkflowInstanceStatus | null;
  /** The document's line count — the denominator of the `ALL_LINES` policies. */
  readonly lineCount: number;
  /**
   * The status of EACH line's workflow instance. A line with no routed workflow
   * contributes no entry — which is how `ALL_LINES` refuses a document whose lines were
   * never routed rather than vacuously passing.
   */
  readonly lineWorkflowStatuses: readonly WorkflowInstanceStatus[];
  /**
   * The commercial approval statuses of the document's records (§3-G). A line whose
   * applicability was `false` has NO record, so "every required approval is APPROVED"
   * is vacuously true for a document that requires none — §3-F: "the commercial
   * contribution is trivially satisfied when no line approval is required."
   */
  readonly commercialApprovalStatuses: readonly CommercialApprovalState[];
  /**
   * O4 aggregation gate — supplied by O, consumed by P. `null` means O4 is not
   * applicable (the document has no routing-version pin) and existing P behavior
   * remains.
   */
  readonly aggregationPolicy: 'ALL_APPROVED' | 'INDEPENDENT' | null;
}

/**
 * Every line's workflow instance reached terminal APPROVED.
 *
 * REQUIRES A ROUTED LINE. `lineCount > 0` and one entry per line: §3-F states that "a
 * document with no routed lines never satisfies it", and a line that was never routed
 * (the configured no-route behaviour) must not read as satisfied by its absence.
 */
function allLinesApproved(input: CommercialProjectionInput): boolean {
  if (input.lineCount === 0) return false;
  if (input.lineWorkflowStatuses.length !== input.lineCount) return false;
  return input.lineWorkflowStatuses.every((status) => status === 'APPROVED');
}

/**
 * O4-gated line aggregation. `ALL_APPROVED` (or `null` when O4 is not applicable)
 * uses the existing all-lines behavior. `INDEPENDENT` never allows line outcomes to
 * satisfy a line-driven document approval.
 */
function lineAggregationSatisfied(input: CommercialProjectionInput): boolean {
  if (input.aggregationPolicy === 'INDEPENDENT') return false;
  return allLinesApproved(input);
}

/**
 * Every REQUIRED commercial approval is APPROVED.
 *
 * PENDING blocks (the decision is not made yet) and REJECTED blocks (§3-F: "a line
 * approval in REJECTED state blocks the commercial contribution"). Neither produces
 * `REJECTED` on the document — they only withold `APPROVED`.
 */
function commercialContributionSatisfied(input: CommercialProjectionInput): boolean {
  return input.commercialApprovalStatuses.every((status) => status === 'APPROVED');
}

/** The §3-F table, as code: one row per closed policy member. */
function approvedUnder(
  policy: CommercialProjectionPolicy,
  input: CommercialProjectionInput
): boolean {
  const documentWorkflowApproved = input.documentWorkflowStatus === 'APPROVED';

  switch (policy) {
    case 'DOCUMENT_WORKFLOW':
      return documentWorkflowApproved;
    case 'ALL_LINES':
      return lineAggregationSatisfied(input);
    case 'DOCUMENT_WORKFLOW_AND_COMMERCIAL':
      return documentWorkflowApproved && commercialContributionSatisfied(input);
    case 'ALL_LINES_AND_COMMERCIAL':
      return lineAggregationSatisfied(input) && commercialContributionSatisfied(input);
  }
}

/**
 * The projection decision.
 *
 * ORDER MATTERS AND IS THE CONTRACT'S:
 *  1. only a SUBMITTED document may move (nothing else in M/N/O writes these edges);
 *  2. a REJECTED document workflow writes REJECTED under EVERY policy — "the document
 *     workflow is the rejection vehicle under every policy";
 *  3. otherwise the pinned policy decides whether APPROVED is written.
 *
 * The result is a TARGET, never a status: the caller writes it through the ONE
 * repository statement (`applyCommercialTransitionIn`) whose own predicate is
 * `status: 'SUBMITTED'`, so the condition and the write cannot drift apart.
 */
export function computeCommercialProjection(
  input: CommercialProjectionInput
): CommercialProjectionTarget | null {
  if (input.documentStatus !== 'SUBMITTED') return null;

  if (input.documentWorkflowStatus === 'REJECTED') return 'REJECTED';

  return approvedUnder(input.policy, input) ? 'APPROVED' : null;
}
