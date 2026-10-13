import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RuleEngineService } from '../../../rules/rule-engine.service';
import { buildRuleExplanation } from '../../../rules/core/rule-explanation';
import type { RuleExplanation } from '../../../rules/core/rule-explanation';
import type { EvaluationContext, SimulationResult } from '../../../rules/rule-evaluation.interface';
import type { RuleEvidenceLevel, RuleFactValue } from '../../../rules/rule.types';
import { LEAVE_LIMIT_RULE_SET_ID } from '../domain/leave-policy';
import type { LeaveLimitCountingBasis, LeaveLimitEmploymentType } from '../domain/leave-policy';
import { HrActor } from '../hr-actor';
import { LeaveRepository } from '../leave/leave.repository';
import { LeavePolicyRepository } from './leave-policy.repository';
import type { StoredLeaveLimit, StoredLeavePolicyVersion } from './leave-policy.repository';
import { LeavePolicyService } from './leave-policy.service';
import { MAX_COUNTED_LEAVE_REQUESTS } from './leave-limit-enforcement';
import type { CountableLeaveRequest } from './leave-limit-counting';
import {
  LEAVE_DAY_WINDOW_COLLECTION,
  LEAVE_REQUEST_WINDOW_COLLECTION,
  leaveDayWindowProjection,
  leaveLimitSimulationScalars,
  leaveRequestWindowProjection,
} from './leave-limit-simulation-facts';
import { projectLeaveLimitRuleSetVersion } from './leave-limit-simulation-projection';

/**
 * Phase 54-H (§14, §13, §16, §24, D4): the LEAVE-LIMIT SIMULATION application service.
 *
 * WHAT THIS CLASS IS, AND THE ONE THING IT MUST NEVER BECOME
 * ---------------------------------------------------------
 * It is the adapter §1/D1 puts at the boundary: it reads HR's stored configuration, projects it into
 * the generic engine's own value types, assembles the typed facts, and asks the REAL engine for a
 * simulated decision. It is not an evaluator. It contains no limit arithmetic, no counting basis
 * branch, no applicability test and no comparison — every one of those already exists in Phase 54-G,
 * and a second copy here would be the "two engines" failure §14.2 and §38.2 gate 9 exist to refuse.
 *
 * WHY THE ENGINE IS REACHED THROUGH `simulateSync`
 * -----------------------------------------------
 * `simulateVersion(ruleSetId, version, context)` reads the REGISTRY and refuses anything that is not
 * `PUBLISHED` (`rule-engine.service.ts:165` → `mayDecide` → `businessEvaluationIssue`, which returns
 * non-null for DRAFT/VALIDATED/ARCHIVED). Choice 1B requires all four states to be simulatable, so
 * that door is the wrong one — and would be wrong even if it worked, because it would make the
 * simulation's answer depend on what a process happened to have REGISTERED.
 *
 * `simulateSync(ruleSetVersion, context)` takes the version AS A VALUE. Its own doc names this
 * exact case: "Simulation is where a DRAFT is legitimately evaluated, and it is still the *real*
 * engine (identical validation, ordering and match history)". It consults no store, so:
 *
 *   * a DRAFT is simulatable without being published,
 *   * an ARCHIVED version is simulatable without becoming selectable,
 *   * and NOTHING is written, because the engine has nothing to write to.
 *
 * THE ENGINE IS NOT MODIFIED. Not one line of `src/rules/` changes for this phase: the catalogue and
 * the projections are HR's, passed in as data (§8.3), which is what keeps the engine unaware that
 * leave, policies, tenants or employees exist.
 */

/**
 * The permission string this surface is gated on (2A), declared beside the service so the wiring
 * test and the controller cannot disagree about it.
 */
export const LEAVE_POLICY_SIMULATION_PERMISSION = 'hr.leave.policy';

/**
 * One stored limit's evaluation grounds, as the simulation reports them.
 *
 * A DELIBERATELY FLAT, TYPED SHAPE rather than the engine's `RuleLimitRefusalAction` verbatim. The
 * action is the ENGINE's decision record and is returned unchanged in `wouldApply`; this shape is the
 * HR-SIDE rendering of the same grounds, carrying the stored `leaveTypeId` and `employmentType` that
 * the action does not — because "which limit refused me?" needs the leave type an operator authored,
 * not only the opaque `limitRef` (§16.7, §23.5).
 */
export interface SimulatedLimitGrounds {
  readonly limitRef: string;
  readonly leaveTypeId: string;
  readonly employmentType: string | null;
  readonly countingBasis: string;
  readonly maximum: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** The observed cardinality of the projection the basis counts over (§16.3, §16.7). */
  readonly observed: number;
  /** `observed > maximum` — the refusal condition itself, stated rather than re-derived. */
  readonly exceeded: boolean;
}

/**
 * What a simulation answers (§14, §13, §25).
 *
 * THE GENERIC `SimulationResult` IS CARRIED WHOLE rather than flattened, so the frozen §14 fields
 * (`mode`, `banner`, `wouldApply`, `decision`, `matchHistory`, `explanationText`, `validation`) keep
 * their engine-authored meaning and §14.5's "labelled everywhere" cannot be lost in translation. The
 * surrounding fields are the HR-side context an operator needs to read it: WHICH configuration was
 * simulated, whether that configuration is currently in force, and the grounds of each limit.
 */
export interface LeaveLimitSimulationResult {
  readonly ruleSetId: string;
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly versionLabel: string;
  /**
   * The stored lifecycle state, reported verbatim.
   *
   * §23.2/log 4: a decision is explained by the configuration that was in force when it was made, so
   * the state travels with the answer rather than being assumed from the version number.
   */
  readonly status: string;
  /**
   * `true` ONLY for an ARCHIVED version, and it is the marker §14's "historical/configuration
   * simulation" needs.
   *
   * IT EXISTS SO NOTHING CAN CLAIM AN ARCHIVED VERSION GOVERNS. An ARCHIVED version is not the
   * version new evaluations use (§10.3) — it is readable so a past decision can explain itself
   * (§10.5) — and a response that called it "effective" would be a claim about governance the
   * lifecycle contradicts.
   */
  readonly historical: boolean;
  readonly evaluationInstant: string;
  readonly simulation: SimulationResult;
  /** HR-side grounds, one entry per projected limit, in the version's own stored order. */
  readonly limits: readonly SimulatedLimitGrounds[];
  readonly explanation: RuleExplanation;
}

/**
 * The evidence level this surface reports at, DERIVED FROM THE CAPABILITY IT AUTHORISES (§13.3,
 * §27.2, §27.6).
 *
 * WHY A CONSTANT HERE RATHER THAN A REQUEST FIELD
 * -----------------------------------------------
 * The evidence level is a property of the SURFACE, not of the caller and not of the payload. §27.6:
 * "the level is per surface, not per person forever … which layer is shown follows the *capability
 * being used*, which is what the permission gates already express." This route's capability IS
 * `hr.leave.policy`, so its level is a fact about the route — and a fact the client cannot state is
 * the only kind that stays true.
 *
 * `HR_ADMIN` AND NOT `PLATFORM_ADMIN`, DELIBERATELY. §31 puts the Level-3 surface (rule builder,
 * version comparison, full explanation tree, cross-tenant inspection) behind a *platform permission*
 * and an audit trail, on its own surface. This HR route has neither, so claiming Level 3 here would
 * disclose priority, specificity, complete match history and conflict reports to anyone holding a
 * tenant-configuration permission. It is also the STOP condition the phase forbids: widening the
 * answer instead of narrowing the gate.
 *
 * WHAT THE LEVEL ACTUALLY WITHHOLDS, so the guarantee is legible: `RULE_EVIDENCE_LEVEL_FIELDS` gives
 * `HR_ADMIN` `matchHistory: 'MATCHED_ONLY'`, `orderingBasis: false`, `failedLeaves: false`, and
 * `versionIdentity: true`. So no priority, no specificity, no failed-leaf paths, and no unmatched
 * rules' internals reach this response — and because `buildRuleExplanation` PROJECTS rather than
 * filters, those fields are absent from the payload rather than hidden by a renderer (§27.2).
 */
export const LEAVE_POLICY_SIMULATION_EVIDENCE_LEVEL: RuleEvidenceLevel = 'HR_ADMIN';

/** What the controller hands the service: §14's body, with NO evidence level (see above). */
export interface SimulateLeavePolicyVersionInput {
  readonly ruleSetId: string;
  /** The DAY to resolve when the caller named no version. Absent means the server's today. */
  readonly asOf?: string;
  /** The leave type the question is about; required to resolve a governing version. */
  readonly leaveTypeId?: string;
  /** The exact stored version to simulate; absent means the currently effective published one. */
  readonly versionId?: string;
  readonly evaluationInstant?: string;
  readonly employmentType?: string;
  readonly requestedFrom?: string;
  readonly requestedTo?: string;
  readonly employeeId?: string;
}

/**
 * The simulation surface (§14): "what would the engine decide under this configuration, and why?"
 *
 * ONE METHOD, BECAUSE THERE IS ONE QUESTION. `simulate` resolves the version the caller asked about,
 * projects it, assembles the facts, asks the engine, and renders the answer. Nothing is written, so
 * there is no second method that a caller could reach to make the write happen.
 */
@Injectable()
export class LeavePolicySimulationService {
  constructor(
    private readonly policies: LeavePolicyRepository,
    private readonly policyService: LeavePolicyService,
    private readonly leave: LeaveRepository,
    private readonly engine: RuleEngineService
  ) {}

  /**
   * Simulates a leave-limit decision against a stored policy version (§14).
   *
   * THE SEQUENCE, AND WHY EACH STEP REFUSES RATHER THAN DEFAULTS:
   *
   *   1. THE RULE SET IS CHECKED FIRST. §14's body names a `ruleSetId`, and this surface owns exactly
   *      one (`hr.leave.limit`). A caller naming anything else is refused rather than resolved,
   *      because exposing the platform's other rule sets through an HR leave-policy route would make
   *      this endpoint a general-purpose engine console — a surface §25 gates per-domain, and one no
   *      HR permission was ever meant to grant.
   *   2. THE VERSION IS RESOLVED, and there are exactly two ways, which are different questions:
   *      with no `versionId` the caller asks "what governs now?" and Phase 54-F's `resolveEffective`
   *      answers it; with one, the caller asks "show me this exact version" and the tenant-scoped
   *      repository primitive answers it, INCLUDING `DRAFT` and `VALIDATED` (Choice 1B).
   *   3. THE FACTS ARE ASSEMBLED from stored rows the caller could already read, bounded before
   *      anything is counted (§16.5, §34).
   *   4. THE REAL ENGINE IS ASKED, through `simulateSync` — the version as a VALUE, so no store is
   *      consulted and nothing can be registered (§14.1, §23.7).
   *
   * WHAT THIS METHOD CANNOT DO, BY CONSTRUCTION: it holds no `audit` gateway, calls no write method
   * on either repository, and never touches `RuleRegistryService`. The read-only guarantee is a
   * property of what is injected rather than of a flag, which is what lets the read-only test assert
   * it by observation instead of by trusting a comment.
   */
  async simulate(
    actor: HrActor,
    version: StoredLeavePolicyVersion,
    input: SimulateLeavePolicyVersionInput
  ): Promise<LeaveLimitSimulationResult> {
    if (input.ruleSetId !== LEAVE_LIMIT_RULE_SET_ID) {
      throw new NotFoundException(
        `This surface simulates "${LEAVE_LIMIT_RULE_SET_ID}"; "${input.ruleSetId}" is not a rule set it owns.`
      );
    }

    const limits = await this.policies.findLimitsForPolicyVersion(actor.tenantId, version.id);

    /**
     * THE EVALUATION INSTANT DEFAULTS AT THE EDGE, ONCE (D12).
     *
     * §14 makes it optional in the body and requires the engine to always receive an explicit value.
     * Defaulting HERE — at the API boundary — is what satisfies both: the engine never reads a clock,
     * and a caller that omits the instant still gets a definite one. When the caller DOES supply one it
     * is used unchanged, so the same state plus the same body reproduces the same answer (§36.4).
     */
    const evaluationInstant = input.evaluationInstant ?? new Date().toISOString();

    const projected = projectLeaveLimitRuleSetVersion({
      versionLabel: version.versionLabel,
      status: version.status,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      limits: limits.map((limit) => this.toProjectionLimit(limit)),
    });

    const context = await this.assembleContext(actor, limits, input, evaluationInstant);
    const simulation = this.engine.simulateSync(projected, context);

    return {
      ruleSetId: LEAVE_LIMIT_RULE_SET_ID,
      policyId: version.policyId,
      policyVersionId: version.id,
      versionLabel: version.versionLabel,
      status: version.status,
      // ONLY ARCHIVED IS HISTORICAL. A DRAFT is not history — it is a configuration that has not taken
      // effect yet — and conflating the two would tell an operator that a draft was once in force.
      historical: version.status === 'ARCHIVED',
      evaluationInstant,
      simulation,
      limits: this.groundsOf(limits, simulation),
      /**
       * THE LEVEL IS NOT PASSED IN — IT IS THIS SURFACE'S OWN, and the constant is read here so the
       * derivation is visible at the one place it takes effect. A caller cannot influence it: the field
       * it would have used does not exist on the DTO, and the global `ValidationPipe` runs
       * `whitelist` + `forbidNonWhitelisted`, so sending `level` is a 400 rather than an ignored field.
       */
      explanation: buildRuleExplanation(simulation, LEAVE_POLICY_SIMULATION_EVIDENCE_LEVEL),
    };
  }

  /**
   * The stored limit, narrowed to the projection's shape.
   *
   * `employmentType` IS VALIDATED RATHER THAN CAST, reusing the same reasoning
   * `LeaveService.toStoredLimitRow` records: the column's own `string | null` is narrowed to the
   * domain's closed vocabulary, so a value the vocabulary does not know becomes `null` — §16.6's
   * "cannot state the type" — instead of reaching the scope rule as an unrecognized string.
   */
  private toProjectionLimit(limit: StoredLeaveLimit) {
    return {
      id: limit.id,
      leaveTypeId: limit.leaveTypeId,
      employmentType: limit.employmentType as LeaveLimitEmploymentType | null,
      maximum: limit.maximum,
      countingBasis: limit.countingBasis,
      windowStart: limit.windowStart,
      windowEnd: limit.windowEnd,
      consumedStates: [...limit.consumesStates],
    };
  }

  /**
   * The typed facts the engine is asked about (§8.3, §14, §16.3).
   *
   * THE PROJECTIONS ARE BUILT FROM THE LIMITS' OWN WINDOWS, which is what makes one simulation of a
   * multi-limit version meaningful: each limit counts over the window IT declared, from the requests
   * that window covers, narrowed by ITS OWN consumed states. A single shared collection would count
   * every request against every limit and report refusals for limits that do not apply.
   *
   * ONLY ONE COLLECTION IS POPULATED PER BASIS, because the limit's stored `countingBasis` decides
   * which. The other is present and EMPTY — never absent — so the engine's `count.over` always
   * resolves to a declared collection rather than reporting a missing fact (§8.4 refuses an undeclared
   * or absent collection, and an absent one would be indistinguishable from "the caller forgot").
   *
   * THE TENANT IS THE FIRST ARGUMENT OF EVERY READ, so a cross-tenant row cannot enter a collection;
   * `employeeId` is passed to the read rather than filtered afterwards, because §16.3 counts the
   * requests the window covers and an employee-scoped simulation must not see a colleague's records at
   * all (§24.6).
   */
  private async assembleContext(
    actor: HrActor,
    limits: readonly StoredLeaveLimit[],
    input: SimulateLeavePolicyVersionInput,
    evaluationInstant: string
  ): Promise<EvaluationContext> {
    const facts: Record<string, RuleFactValue> = {};

    const requestedFrom = input.requestedFrom ?? input.asOf ?? simulationDayOf(new Date());
    const requestedTo = input.requestedTo ?? requestedFrom;

    const requestWindow = await this.collect(actor, limits, 'REQUEST_COUNT', input.employeeId);
    const dayWindow = await this.collect(actor, limits, 'DAY_COUNT', input.employeeId);

    /**
     * THE SCALARS STATE THE QUESTION; THE RULES STATE THE THRESHOLDS.
     *
     * §14's `context` is a scalar-stated question ("would THIS request be refused?"), while each
     * projected rule carries its own `where` and `count.value`. So the scalars carry the leave type,
     * the range and the employment type — never a per-limit maximum that would make one limit's
     * threshold stand for every other's.
     */
    const first = limits[0];
    Object.assign(
      facts,
      leaveLimitSimulationScalars({
        leaveTypeId: first?.leaveTypeId ?? input.leaveTypeId ?? '',
        employmentType: input.employmentType ?? first?.employmentType ?? null,
        requestedFrom,
        requestedTo,
        countingBasis: first?.countingBasis ?? 'REQUEST_COUNT',
        maximum: first?.maximum ?? 0,
        windowStart: first === undefined ? requestedFrom : simulationDayOf(first.windowStart),
        windowEnd: first === undefined ? requestedTo : simulationDayOf(first.windowEnd),
      })
    );

    facts[LEAVE_REQUEST_WINDOW_COLLECTION] = requestWindow;
    facts[LEAVE_DAY_WINDOW_COLLECTION] = dayWindow;

    return { facts, evaluationInstant };
  }

  /**
   * One basis's collection, read per limit and concatenated.
   *
   * THE BOUND IS CHECKED BEFORE THE FACT IS HANDED OVER (§16.5, §34), against the same constant Phase
   * 54-G refuses on, so the two paths cannot disagree about how much data is too much. §8.4 makes
   * exceeding a collection's `maxSize` a context error rather than a truncation, and this refuses for
   * the same reason `REQUEST_COUNT_UNBOUNDED` does: a truncated count is a WRONG count that looks like
   * a right one, and under-counting would silently ALLOW a request that should be refused.
   */
  private async collect(
    actor: HrActor,
    limits: readonly StoredLeaveLimit[],
    basis: LeaveLimitCountingBasis,
    employeeId: string | undefined
  ): Promise<readonly Readonly<Record<string, RuleFactValue>>[]> {
    const rows: Readonly<Record<string, RuleFactValue>>[] = [];

    for (const limit of limits) {
      if (limit.countingBasis !== basis) continue;

      const requests = await this.leave.findCountableRequests(actor.tenantId, {
        leaveTypeId: limit.leaveTypeId,
        ...(employeeId === undefined ? {} : { employeeId }),
        from: limit.windowStart,
        to: limit.windowEnd,
        statuses: limit.consumesStates,
      });

      /**
       * THE STATUS IS NARROWED, NOT RE-DERIVED — the same checked narrowing Phase 54-G's
       * `limitPorts()` performs, and for the same reason: the rows arrive with the WIDER
       * `LeaveRequestStatus` while the counting contract takes the narrower `LeaveLimitConsumedState`,
       * and the query has ALREADY predicate-narrowed them to the limit's own configured states. So
       * this is a narrowing of a known-safe value rather than a trust in the database.
       */
      const countable = requests.map((row) => ({
        id: row.id,
        startDate: row.startDate,
        endDate: row.endDate,
        status: row.status as CountableLeaveRequest['status'],
      }));

      const projection =
        basis === 'REQUEST_COUNT'
          ? leaveRequestWindowProjection({
              countingBasis: basis,
              leaveTypeId: limit.leaveTypeId,
              consumedStates: limit.consumesStates,
              requests: countable,
            })
          : leaveDayWindowProjection({
              countingBasis: basis,
              leaveTypeId: limit.leaveTypeId,
              consumedStates: limit.consumesStates,
              requests: countable,
            });

      if (rows.length + projection.length > MAX_COUNTED_LEAVE_REQUESTS) {
        throw new ConflictException(
          `This simulation would count more than ${MAX_COUNTED_LEAVE_REQUESTS} records for one limit, ` +
            'so the count cannot be trusted. Narrow the range or the leave type.'
        );
      }

      rows.push(...projection);
    }

    return rows;
  }

  /**
   * The HR-side grounds of each limit, read back off the ENGINE's own observed counts.
   *
   * THE COUNT IS TAKEN FROM `observedCounts` RATHER THAN RE-COUNTED HERE, and that is the point: §13.2
   * requires an explanation to be DERIVED from the decision, never recomputed, so recomputing the
   * cardinality in this method would be a second arithmetic that could disagree with the verdict it is
   * explaining. The engine reports what it counted; this renders it.
   *
   * A LIMIT THE ENGINE NEVER COUNTED REPORTS `0`, which is the honest answer rather than a missing
   * field: the collection it counts over was empty, so the count it observed was zero.
   */
  private groundsOf(
    limits: readonly StoredLeaveLimit[],
    simulation: SimulationResult
  ): readonly SimulatedLimitGrounds[] {
    const observed = new Map(
      simulation.observedCounts.map((entry) => [entry.over, entry.count] as const)
    );

    return limits.map((limit) => {
      const collection =
        limit.countingBasis === 'REQUEST_COUNT'
          ? LEAVE_REQUEST_WINDOW_COLLECTION
          : LEAVE_DAY_WINDOW_COLLECTION;

      const count = observed.get(collection) ?? 0;

      return {
        limitRef: limit.id,
        leaveTypeId: limit.leaveTypeId,
        employmentType: limit.employmentType,
        countingBasis: limit.countingBasis,
        maximum: limit.maximum,
        windowStart: simulationDayOf(limit.windowStart),
        windowEnd: simulationDayOf(limit.windowEnd),
        observed: count,
        // The SAME comparison Phase 54-G's `evaluateLeaveLimit` makes (`count > maximum`), stated here
        // so a reader is not asked to re-derive an inequality from two numbers.
        exceeded: count > limit.maximum,
      };
    });
  }
  /**
   * Resolves the version to simulate, then simulates it (§14, Choice 1B, A2).
   *
   * THE TWO LOOKUPS ARE DIFFERENT QUESTIONS, and this method is where that distinction is enforced:
   *
   *   * NO `version` — "which configuration governs this context?" Phase 54-F's `resolveEffective` is
   *     the ONE authority on that question and is called UNCHANGED. It is deliberately not extended
   *     with a version argument: its own doc records that "a parameter naming a version would be an
   *     ANSWER to the question this method exists to ask, and §10.5's 'still resolvable for historical
   *     references' would decay into 'selectable by anyone who can guess an id'".
   *   * A `version` — "show me this exact version". The stored rows are read under the actor's tenant
   *     and the route's policy, and a `DRAFT` or `VALIDATED` row may be returned because the caller is
   *     not asking what governs — it is naming a configuration it already knows about.
   *
   * THE TENANT IS STRUCTURAL. Every read takes `actor.tenantId` as its first argument, so a version of
   * another tenant is NOT FOUND rather than refused — §24.6's "existence is never confirmed across
   * tenants, in responses or in error text". Both paths therefore produce the SAME `NotFoundException`
   * prose, because a distinguishable message would be the confirmation §24.6 forbids.
   */
  async resolveAndSimulate(
    actor: HrActor,
    policyId: string,
    input: SimulateLeavePolicyVersionInput
  ): Promise<LeaveLimitSimulationResult> {
    if (input.ruleSetId !== LEAVE_LIMIT_RULE_SET_ID) {
      throw new NotFoundException(
        `This surface simulates "${LEAVE_LIMIT_RULE_SET_ID}"; "${input.ruleSetId}" is not a rule set it owns.`
      );
    }

    return this.simulate(actor, await this.resolveVersion(actor, policyId, input), input);
  }

  /**
   * The version the caller asked about — by name when it named one, by governance when it did not.
   *
   * WHY THE OMITTED-VERSION PATH DELEGATES RATHER THAN QUERIES
   * ---------------------------------------------------------
   * "What governs this leave type on this day?" is Phase 54-F's answered question, including its §12
   * refusal of an ambiguous multi-policy configuration. Reimplementing it here would be a second answer
   * to it — the "no second policy selector" rule this phase's architecture tests enforce — so this
   * calls the service that owns it.
   *
   * WHY THE NAMED PATH USES THE TENANT-SCOPED PRIMITIVE
   * --------------------------------------------------
   * `findVersion(tenantId, policyId, versionId)` is a `findFirst` carrying all three predicates at once,
   * so tenancy and policy scope are part of the READ rather than a filter applied to its result — and a
   * version of another tenant, or of another policy in the same tenant, is simply NOT FOUND. That is
   * §24.6's "existence is never confirmed across tenants": the refusal is identical for a version that
   * does not exist and one that is not the caller's, because a distinguishable message would be the
   * confirmation the rule forbids.
   *
   * NOTHING FALLS BACK TO THE PUBLISHED VERSION. A missing match is refused, because answering a
   * question about a named draft with an answer about something else would be the most misleading
   * result this surface could produce.
   */
  private async resolveVersion(
    actor: HrActor,
    policyId: string,
    input: SimulateLeavePolicyVersionInput
  ): Promise<StoredLeavePolicyVersion> {
    if (input.versionId === undefined) {
      /**
       * THE RESOLVER IS CALLED, NOT REIMPLEMENTED. `resolveEffective` answers "which PUBLISHED version
       * governs this leave type on this day?" and owns §12's refusal of an ambiguous multi-policy
       * configuration. It returns `version: null` when nothing governs — a real configuration state
       * (§15.8) — reported here as "nothing to simulate" rather than as an empty evaluation, so the
       * caller cannot mistake "no policy has been stated" for "the policy permitted it".
       */
      const resolved = await this.policyService.resolveEffective(actor, {
        ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
        ...(input.leaveTypeId === undefined ? {} : { leaveTypeId: input.leaveTypeId }),
        ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType }),
      });

      if (resolved.version === null) {
        throw new NotFoundException('No leave policy version matches this simulation request.');
      }

      return resolved.version;
    }

    const version = await this.policies.findVersion(actor.tenantId, policyId, input.versionId);

    if (version === null) {
      throw new NotFoundException('No leave policy version matches this simulation request.');
    }

    return version;
  }
}

/**
 * A stored `@db.Date` column as the inclusive calendar day it holds.
 *
 * THE UTC FIELDS ARE USED BECAUSE THE COLUMN IS A DATE, not an instant: `toISOString().slice(0, 10)`
 * would move a local midnight to the previous day west of UTC, which for this decision would judge a
 * request against the wrong day. The same reasoning, and the same shape, as
 * `leave-limit-runtime.ts`'s own `toStoredDay` — restated rather than imported because that function
 * is private to that module, and widening it would make a display helper part of its public surface.
 */
export function simulationDayOf(instant: Date): string {
  const year = instant.getUTCFullYear();
  const month = String(instant.getUTCMonth() + 1).padStart(2, '0');
  const day = String(instant.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
