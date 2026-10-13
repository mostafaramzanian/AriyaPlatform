/**
 * Phase 51-HR-ARCH-1B: the ORGANIZATION HIERARCHY cycle rule, as pure TypeScript.
 *
 * WHY THIS FILE HAS EXACTLY ZERO IMPORTS
 * --------------------------------------
 * Same falsifiable claim as `employment-interval.ts`, and the same guard:
 * `hr-application-boundaries.spec.ts` requires zero import specifiers in every non-spec
 * file of this directory. The decision below therefore cannot reach for Prisma, a
 * repository, NestJS or an exception — which is the point, because the rule it encodes is
 * the one that used to be tangled up with the fetching loop inside
 * `OrganizationService.assertParentIsUsable`.
 *
 * WHAT IS SEPARATED FROM WHAT
 * ---------------------------
 * "Is re-parenting this unit legal?" needs the parent chain, and only the repository can
 * fetch it. So the split is by responsibility, not by file count:
 *
 *   application (`OrganizationService`)  — fetch ONE parent id per step, bounded
 *   domain    (this file)                — decide what the step we are standing on MEANS
 *   repository (`OrganizationRepository`) — the query that returns the parent id
 *   database  (`OrganizationUnit_no_cycle_guard`) — the recursive BEFORE trigger that is
 *                                          the real guarantee, because the service is not
 *                                          the only possible writer
 *
 * The trigger is NOT replaced and NOT duplicated. This decision only lets the ordinary API
 * answer 409 with a readable message instead of surfacing a raw Postgres exception.
 *
 * WHY A STEP DECISION RATHER THAN A `detectCycle(units, childId)` FUNCTION
 * -----------------------------------------------------------------------
 * A function that took the whole tree would force the service to load every unit — that is
 * a different query plan (and a different failure mode for a large tenant) than the bounded
 * walk that ships today. Encoding ONE STEP keeps the walk's query count and its ordering
 * exactly as they are, while still moving every comparison into a framework-free function.
 */

/** Where the walk currently stands, plus the bound the caller owns. */
export interface AncestorWalkState {
  /** The unit being re-parented. The walk is illegal the moment it reaches this id. */
  readonly childId: string;
  /** Steps taken so far. The caller carries it; this file never loops. */
  readonly steps: number;
  /** Inclusive ceiling on steps, supplied by the caller (the service's own bound). */
  readonly maxSteps: number;
}

/**
 * What the node we are standing on means for the proposed re-parent.
 *
 *   * `found-child` — walking up from the proposed parent reached the unit being moved, so
 *     the relationship would close a cycle (`A → B → C → A`);
 *   * `too-deep` — the walk exceeded the caller's bound, so the tenant's tree is refused
 *     rather than traversed without limit;
 *   * `descend` — this step is legal; carry `steps` forward and ask for the next parent id.
 */
export type AncestorStepDecision =
  | { readonly kind: 'found-child' }
  | { readonly kind: 'too-deep' }
  | { readonly kind: 'descend'; readonly steps: number };

/**
 * One step of the ancestor walk.
 *
 * ORDER IS PART OF THE BEHAVIOUR: the reach-the-child test is evaluated BEFORE the bound is
 * incremented, so a cycle that closes on the very last permitted step is reported as a
 * cycle (409 with the cycle message) rather than as a depth failure. `currentId` has
 * already been proven non-null by the caller's loop, which is why this takes a `string`.
 */
export function evaluateAncestorStep(
  state: AncestorWalkState,
  currentId: string
): AncestorStepDecision {
  if (currentId === state.childId) {
    return { kind: 'found-child' };
  }

  const steps = state.steps + 1;

  if (steps > state.maxSteps) {
    return { kind: 'too-deep' };
  }

  return { kind: 'descend', steps };
}
