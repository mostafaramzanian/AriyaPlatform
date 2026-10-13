import {
  isPurchaseCompletionSourceStatus,
  type PurchaseCompletionSourceStatus,
} from '../purchase/purchase-status';

/**
 * PHASE C4-R (GAP-3): the Purchase Completion Policy as a PURE module — the constrained,
 * typed shape of the configuration and its deterministic validation, with NO dependencies
 * at all (no NestJS, no Prisma, no repository, no clock).
 *
 * WHY A PURE MODULE (the `purchase-status.ts` / `payment-status.ts` precedent)
 * ---------------------------------------------------------------------------
 * Three callers must agree on what a valid policy IS: the DTO validates the request shape
 * against it, the publish checklist validates the STORED ROW against it (a row written by
 * any path is checked the same way before it may govern a purchase), and the completion
 * act applies it before it reads the set. A rule re-typed in the service is how "this
 * policy is publishable" and "this policy cannot be evaluated" both end up true.
 *
 * WHAT THE MODEL IS — AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------
 * The whole policy is ONE finite, typed field: `allowedFromStatuses`, a non-empty set drawn
 * from `PURCHASE_COMPLETION_SOURCE_STATUSES` (the purchase document's OWN lifecycle
 * vocabulary, every member but the destination). There is:
 *
 *   * NO expression language, no SQL, no `eval`, no script, no user-supplied condition tree
 *     (brief §3) — the set is data a service can compare, nothing it must execute;
 *   * NO second rule engine and no reuse of the Pure Rule Engine: the rule engine's facts
 *     are workflow/routing facts (`workflow-facts.ts`), and the exact capability required
 *     here is set membership, which the engine does not model better than `includes`;
 *   * NO prerequisite dimension — payment state, receiving state, workflow completion,
 *     return state and commercial approval are read NOWHERE, because C1 §29 states those
 *     lifecycles are not purchase completion and no C1/C2/C3 document makes any of them a
 *     completion precondition (C4 contract §D, brief §8). A condition the source never
 *     sanctions must not become a configurable one, so the model has no field for one;
 *   * NO authority/permission field — who may act is Core/RBAC's (`commerce.manage` on the
 *     close route); what this configuration owns is BUSINESS eligibility only.
 *
 * "NO PREREQUISITES" IS THEREFORE NOT A DEFAULT SOMEBODY CHOSE. Nothing is implicitly
 * satisfied and nothing is implicitly required: with no POLICY there is no completion at
 * all, and a published policy decides the one thing it can state — the source statuses.
 */

/** The longest policy label the boundary accepts, matching the `VARCHAR(64)` it lands in. */
export const PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH = 64;

/**
 * The publication checklist, as a deterministic report: `[]` means the stored value IS a
 * valid policy, and every other result is the complete list of reasons it is not.
 *
 * WHY A LIST AND NOT A THROW: the same function answers the `validate` route (which reports
 * the first reason to a client) and gives tests one artifact to exercise exhaustively over
 * every malformed shape — an unknown member, `CLOSED`, an empty set, a duplicate, a
 * non-array, a row written by a future migration nobody taught this module about.
 *
 * THE FOUR REFUSALS, EACH A DIFFERENT KIND OF WRONG:
 *   * not an array            → the column does not hold a set at all;
 *   * a member outside the vocabulary (including `CLOSED`, or a foreign lifecycle's status
 *     such as `PAID`/`FULLY_RECEIVED`) → the policy would never match a real document;
 *   * an empty set            → the policy can complete NOTHING, which is a contradiction
 *     dressed as configuration (the honest spelling of "not configured" is NO published
 *     policy, which fails closed);
 *   * a duplicate member      → the value claims to be a set and is not one.
 */
export function completionPolicyIssues(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return ['allowedFromStatuses must be an array of purchase document statuses.'];
  }

  const issues: string[] = [];
  const seen = new Set<string>();

  for (const member of raw) {
    if (typeof member !== 'string' || !isPurchaseCompletionSourceStatus(member)) {
      issues.push(
        `${String(member)} is not a status a purchase document may be completed from.`
      );
      continue;
    }
    if (seen.has(member)) {
      issues.push(`${member} is stated more than once; allowedFromStatuses is a set.`);
    }
    seen.add(member);
  }

  if (raw.length === 0) {
    issues.push(
      'allowedFromStatuses names no status, so no purchase document could ever be completed under this policy.'
    );
  }

  return issues;
}

/**
 * The stored value as a usable allowlist, or `null` when it is not a valid policy.
 *
 * THE COMPLETION ACT'S ONLY READ OF A POLICY. A `null` here is NOT "no policy configured"
 * (that is a missing PUBLISHED row) — it is a stored policy that cannot be evaluated, and
 * the act answers it with the configuration failure rather than with a guess. Fail closed
 * means fail closed for a malformed row too, not only for a missing one.
 */
export function readAllowedFromStatuses(
  raw: unknown
): readonly PurchaseCompletionSourceStatus[] | null {
  if (completionPolicyIssues(raw).length > 0) return null;
  return raw as readonly PurchaseCompletionSourceStatus[];
}

/**
 * The policy's human-readable meaning, as the completion act's refusal message states it —
 * ONE spelling of the set, so a 409 and the settings screen cannot describe it differently.
 */
export function describeAllowedFromStatuses(
  allowed: readonly PurchaseCompletionSourceStatus[]
): string {
  return allowed.join(', ');
}
