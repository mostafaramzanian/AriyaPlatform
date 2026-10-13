import { createHash } from 'node:crypto';
import {
  RuleRequiredApprovalStepAction,
  RuleStepActivationAction,
} from '../../../rules/rule-action.interface';
import { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { RuleEvaluationOutcome } from '../../../rules/rule-engine.interface';
import { RuleConditionOutcome } from '../../../rules/rule.types';
import { RuleMatchRecord } from '../../../rules/rule-evaluation.interface';
import { RuleSetVersion, RuleSpec } from '../../../rules/rule-spec.interface';
import { RULE_ENGINE_SCHEMA_VERSION } from '../../../rules/core/rule-limits';
// The engine's OWN validator, imported for §10's last two rows and used nowhere else: publication
// asks the validator the RUNTIME's sets are judged by, so "publishable" and "evaluable" cannot
// disagree later (the configuration walk receives its verdict through `ruleSetIssues`).
import { validateRuleSetVersion } from '../../../rules/core/rule-validator';
import { RuleValidationIssue } from '../../../rules/rule-validation.interface';
import {
  WorkflowActorSource,
  WorkflowConditionFalseBehavior,
  WorkflowParallelJoinPolicy,
  WorkflowRuleSetFinding,
  WorkflowRuleSetFindings,
  WorkflowStepExecutionMode,
  WorkflowVersionConfigurationShape,
} from './workflow-configuration';
import { COMMERCE_WORKFLOW_FACT_CATALOGUE } from './workflow-facts';
import {
  WORKFLOW_STEP_INSTANCE_PENDING,
  WorkflowInstanceStatus,
  WorkflowStepDecision,
  WorkflowStepInstanceStatus,
} from './workflow-run-status';

/**
 * Phase C1 step N: the workflow EXECUTION PLANNER — the pure half of the runtime the
 * authoritative contract specifies in §5–§9 of
 * `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md`.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * -------------------------------------
 * It is a pure function library: values in, values out. No repository, no Prisma
 * client, no gateway, no clock of its own (every instant is an argument), no
 * randomness, no I/O. It DECIDES and PLANS; it never persists, never audits and never
 * notifies. The division of labour the contract fixes (§8.1, §23) and this file obeys:
 *
 *   Rule Engine   evaluates conditions        (one engine: `RuleEngineService.evaluateSync`)
 *   THIS FILE     builds rule sets, reads the engine's outcome, plans transitions
 *   Repository    persists what is planned    (tenant-first, opaque transaction handle)
 *   Service       orchestrates the unit of work, then audits and notifies
 *   Gateways      reach platform boundaries   (identity, audit, notification)
 *
 * DETERMINISM IS A PROPERTY OF THIS FILE, NOT A HOPE
 * --------------------------------------------------
 * Every identity here is a CONTENT digest over the exact inputs it was given
 * (`workflowContentDigest`): the selection set version over the candidate set, the
 * activation set version over the pinned version's own rows. Every collection is put
 * in a total order before it is hashed or planned, so two runs over the same rows
 * produce the same strings whatever order the database returned them in. Nothing here
 * reads "latest", nothing re-resolves a rule set by name, nothing consults a clock:
 * the PINNED version's own rows are the only configuration a run can see (§5.4).
 *
 * WHY THE UNCONDITIONAL TREE IS `requesterId isNotEmpty`
 * ------------------------------------------------------
 * §2.3 gives every selection candidate exactly one rule, and a version without a
 * `selection_condition` participates "unconditionally" — which must be a condition
 * tree the engine's own validator ACCEPTS. Its validator refuses empty groups
 * (`EMPTY_GROUP`), so `{ all: [] }` is not a tautology here, it is an invalid tree.
 * A purchase document ALWAYS has a requester: the column is non-null, the create path
 * requires it, and the fact projection always supplies a non-empty string. So
 * `{ field: 'requesterId', op: 'isNotEmpty' }` is the one leaf that is legal in the
 * catalogue AND true in every context this runtime can build. It carries specificity
 * 1 rather than 0 — which is exactly what makes two equal-priority unconditional
 * candidates an unresolved TIE, the ambiguity §2.4 refuses rather than resolves (§2.6).
 */

/** The selection rule-set identity (§5.2). One set, built fresh per selection. */
export const WORKFLOW_SELECTION_RULE_SET_ID = 'commerce.workflow.selection';

/** The activation rule-set identity prefix (§5.2): `<prefix>.<definitionCode>`. */
export const WORKFLOW_ACTIVATION_RULE_SET_PREFIX = 'commerce.workflow.activation';

/** The activation rule-set identity of one pinned definition (§5.2). */
export function workflowActivationRuleSetId(definitionCode: string): string {
  return `${WORKFLOW_ACTIVATION_RULE_SET_PREFIX}.${definitionCode}`;
}

/**
 * The unconditional condition tree — see the file header for why this exact leaf.
 * FROZEN and shared by reference: any number of rules may cite it.
 */
export const WORKFLOW_UNCONDITIONAL_CONDITION: RuleConditionNode = Object.freeze({
  field: 'requesterId',
  op: 'isNotEmpty',
});

/**
 * Deterministic JSON: object keys sorted, arrays in declared order, `undefined` spelled.
 *
 * WHY NOT `JSON.stringify`: key order in a parsed `Json` column is the database's, not
 * the author's, so two identical conditions could hash differently depending on how
 * PostgreSQL stored them. Sorting keys here makes the digest depend only on content.
 */
function workflowStableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(workflowStableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${workflowStableJson(child)}`).join(',')}}`;
}

/**
 * The content identity of one planned input (§5.3, §5.4): sha-256 hex — 64 characters,
 * exactly the engine's frozen `maxVersionLength`, so it is a legal rule-set version.
 *
 * The parts are read in the order given (callers pass already-ordered data), separated
 * by a NUL byte so two adjacent parts can never be confused with one part.
 */
export function workflowContentDigest(parts: readonly unknown[]): string {
  const hash = createHash('sha256');
  hash.update('commerce.workflow/c1n/1');
  for (const part of parts) {
    hash.update('\u0000');
    hash.update(workflowStableJson(part));
  }
  return hash.digest('hex');
}

/**
 * The four outcomes of one selection (§2.3–§2.6), and the vocabulary is THIS module's
 * because only this module produces them.
 *
 * WHY THE FAILURES ARE THREE AND NOT ONE. §2.4 requires the two named failures the business
 * asked for — "nothing applies" and "something is ambiguous" — because they are different
 * facts about the CONFIGURATION with different fixes: NO_MATCH means no flow governs this
 * kind of purchase (publish one, or accept the named refusal), AMBIGUOUS means more than one
 * flow claims it equally (fix priorities or conditions). They must never be collapsed into a
 * single "cannot proceed", because a caller told "ambiguous" can act and a caller told
 * "nothing applies" can decide; a caller told neither cannot.
 *
 * INVALID IS THE THIRD, AND IT IS NOT A CONFIGURATION VERDICT. It is the engine's own
 * statement that the selection could not be DECIDED at all — the constructed set did not
 * evaluate (a refused evaluation, an undecidable input). That is a different duty-holder's
 * problem (a runtime defect or an unsupported fact), and reporting it as NO_MATCH or
 * AMBIGUOUS would blame the configuration for something the configuration did not do.
 */
export const WORKFLOW_SELECTION_OUTCOMES = Object.freeze([
  'SELECTED',
  'NO_MATCH',
  'AMBIGUOUS',
  'INVALID',
] as const);

export type WorkflowSelectionOutcome = (typeof WORKFLOW_SELECTION_OUTCOMES)[number];

/**
 * The wire/refusal codes of the three non-SELECTED outcomes (§2.4) — the exact strings the
 * contract fixes, so a caller matches on a code rather than reading prose.
 */
export const WORKFLOW_SELECTION_FAILURE_CODES = Object.freeze({
  NO_MATCH: 'WORKFLOW_SELECTION_NO_MATCH',
  AMBIGUOUS: 'WORKFLOW_SELECTION_AMBIGUOUS',
  INVALID: 'WORKFLOW_SELECTION_INVALID',
} as const);

export type WorkflowSelectionFailureCode =
  (typeof WORKFLOW_SELECTION_FAILURE_CODES)[keyof typeof WORKFLOW_SELECTION_FAILURE_CODES];

/**
 * ONE selection candidate (§2.2): a PUBLISHED version whose definition carries the
 * `PURCHASE_SUBMITTED` trigger — the exact four values selection reads, and nothing else.
 *
 * WHY THE CALLER HANDS OVER COLUMNS INSTEAD OF ROWS: the planner must not know the database's
 * row shapes (§8.1 keeps Prisma types inside the database boundary). The repository selects
 * the candidate columns and passes them here; this module never sees a `WorkflowDefinition`
 * or a client.
 */
export interface WorkflowSelectionCandidate {
  readonly workflowDefinitionId: string;
  readonly workflowDefinitionCode: string;
  readonly workflowDefinitionVersionId: string;
  readonly versionLabel: string;
  /** `selection_priority`; absent reads as 0 (§2.6) — the LOWEST, not a special case. */
  readonly selectionPriority: number | null;
  /** The parsed `selection_condition`; absent means the unconditional leaf (§2.3). */
  readonly selectionCondition: RuleConditionNode | null;
}

/**
 * How the engine RANKED one candidate: its priority and its specificity.
 *
 * READ FROM THE ENGINE, NEVER RECOMPUTED HERE. Specificity is the engine's own measure of a
 * condition tree (§2.3), and a second implementation here would be a second definition of
 * "more specific": the two would agree until the engine's measure changed, and the tie
 * rule below (§2.4) would then compare a number the engine did not rank by.
 */
export interface WorkflowCandidateScore {
  readonly priority: number;
  readonly specificity: number;
}

/**
 * The plan of ONE selection — what happened, in values the service can audit and the caller
 * can read, with no engine object leaked to either.
 *
 * `ruleSetVersion` is the digest of the candidate set the decision was made under (§2.3): it
 * is recorded on the instance as the basis of the pin, so "which set decided this" is a
 * stored fact rather than a re-derivation. `candidatesConsidered` is the ids the decision was
 * made OVER — the audit trail of a refusal is the set that produced it.
 */
export type WorkflowSelectionPlan =
  | {
      readonly outcome: 'SELECTED';
      readonly winner: WorkflowSelectionCandidate;
      readonly score: WorkflowCandidateScore;
      readonly ruleSetVersion: string;
      readonly candidatesConsidered: readonly string[];
    }
  | {
      readonly outcome: 'NO_MATCH';
      readonly ruleSetVersion: string;
      readonly candidatesConsidered: readonly string[];
    }
  | {
      readonly outcome: 'AMBIGUOUS';
      /** The versions that tie at the top — every one of them, in a total order (§2.4). */
      readonly tiedVersionIds: readonly string[];
      readonly score: WorkflowCandidateScore;
      readonly ruleSetVersion: string;
      readonly candidatesConsidered: readonly string[];
    }
  | {
      readonly outcome: 'INVALID';
      /**
       * WHY it could not be decided, as a string: the engine's own reason when the ENGINE
       * refused (`RULE_SET_VERSION_UNKNOWN`, `RULE_SET_VERSION_NOT_EVALUABLE`, or a refused
       * evaluation status), or one of this module's two construction-defect reasons when the
       * decision could not be attributed to exactly one candidate — `WINNING_RULE_MISSING`,
       * `RULE_REFERENCE_MISMATCH`. One field, because a caller reading it wants the refusal
       * itself, not the layer that happened to produce it.
       */
      readonly reason: string;
      readonly ruleSetVersion: string;
      readonly candidatesConsidered: readonly string[];
    };

/* ---------------------------------------------------------------------------------------
 * SELECTION — the rule set §2.3 fixes, built as a VALUE (§5.2's construction discipline)
 * ------------------------------------------------------------------------------------- */

/**
 * The one prefix a selection rule id may carry — shared, not re-typed, so the id builder and
 * the id reader below can never disagree about where the version id begins.
 */
export const WORKFLOW_SELECTION_RULE_ID_PREFIX = 'selection:';

/**
 * The rule identity of ONE candidate (§2.3): `selection:<workflowDefinitionVersionId>`.
 *
 * WHY THE VERSION ID AND NOT THE DEFINITION'S. The id is what the runtime reads back to
 * attribute the decision (§2.3: "rule id and the action's opaque reference must name the same
 * version"), and the thing that gets PINNED is the VERSION (§2.5). A rule named after the
 * definition would have to answer "which version won" a second time, in a second place.
 */
export function workflowSelectionRuleId(workflowDefinitionVersionId: string): string {
  return `${WORKFLOW_SELECTION_RULE_ID_PREFIX}${workflowDefinitionVersionId}`;
}

/**
 * The SELECTION set's version (§5.1): a content identity over the candidate set — every
 * candidate's version id, its effective priority and its condition text, in a total order.
 *
 * WHY IT IS A DIGEST AND NOT A COUNTER. Two submissions a second apart see the same
 * configuration and must record the same basis; a counter would give them different strings
 * for the same decision. Sorting before hashing is what makes the value a property of the SET
 * rather than of the row order the database returned — §5.1's "fixed-width, deterministic".
 * The unconditional leaf participates as itself, so an absent condition is digested rather
 * than skipped: two configurations that differ only in which candidate is unconditional are
 * different bases, and the digest must say so.
 */
export function workflowSelectionSetVersion(
  candidates: readonly WorkflowSelectionCandidate[]
): string {
  const ordered = [...candidates].sort((left, right) => {
    if (left.workflowDefinitionVersionId === right.workflowDefinitionVersionId) return 0;
    return left.workflowDefinitionVersionId < right.workflowDefinitionVersionId ? -1 : 1;
  });

  return workflowContentDigest([
    WORKFLOW_SELECTION_RULE_SET_ID,
    'candidates',
    ordered.map((candidate) => [
      candidate.workflowDefinitionVersionId,
      candidate.selectionPriority ?? 0,
      candidate.selectionCondition ?? WORKFLOW_UNCONDITIONAL_CONDITION,
    ]),
  ]);
}

/**
 * The decision action of one selection rule (§2.3): `REQUIRED_APPROVAL_STEP` whose opaque
 * `approverRuleRef` IS the candidate's version id.
 *
 * WHY THIS ACTION AND NOT A NOTIFICATION. It is the engine's frozen way of saying "this
 * request enters a configured approval flow, at this position, by this opaque configured
 * reference" — which is exactly what selection decides: which flow governs. The action is
 * never executed by this runtime (selection reads WHICH rule won); it is carried so the
 * decision is expressible in the engine's own vocabulary rather than in a private one.
 */
function workflowSelectionAction(
  workflowDefinitionVersionId: string
): RuleRequiredApprovalStepAction {
  return Object.freeze({
    type: 'REQUIRED_APPROVAL_STEP',
    stepOrder: 1,
    approverRuleRef: workflowDefinitionVersionId,
  });
}

/**
 * The SELECTION rule set of a candidate list (§2.3, §5.1–§5.3), as the engine receives it:
 * one rule per candidate — priority from `selection_priority` (absent reads as 0, §2.6),
 * condition from `selection_condition` (absent is the unconditional leaf), the version id in
 * both the rule id and the action's reference.
 *
 * The set carries `status: 'PUBLISHED'` (§5.5) because it is built exclusively from published
 * versions, and the fact catalogue (§5.4) because the engine must be able to answer "may this
 * condition be decided from these facts" before it decides anything.
 *
 * THE DECLARED ORDER IS THE CALLER'S and evaluation never trusts it (§12.1): ordering is the
 * engine's, computed from priority, specificity and rule id — so passing candidates in any
 * order yields the same decision, and the digest above is the only place order mattered.
 *
 * WHY EVERY RULE's version IS THE SET'S CONTENT IDENTITY. `RuleSpec.version` is a rule's
 * revision label, and these rules have no independent revisions: each is a projection of one
 * candidate and the SET is the thing a submission is decided under. A version LABEL is free
 * text and the engine's validator requires a safe identifier (a label may legitimately carry
 * spaces or dots), so naming each rule after the set basis keeps every constructed rule
 * admissible while staying deterministic — and it means a decision's `ruleVersion` names the
 * exact configuration text it was taken under.
 */
export function workflowSelectionRuleSet(
  candidates: readonly WorkflowSelectionCandidate[]
): RuleSetVersion {
  const version = workflowSelectionSetVersion(candidates);

  const rules = candidates.map((candidate): RuleSpec =>
    Object.freeze({
      id: workflowSelectionRuleId(candidate.workflowDefinitionVersionId),
      version,
      name: candidate.workflowDefinitionCode,
      priority: candidate.selectionPriority ?? 0,
      condition: candidate.selectionCondition ?? WORKFLOW_UNCONDITIONAL_CONDITION,
      actions: Object.freeze([workflowSelectionAction(candidate.workflowDefinitionVersionId)]),
    })
  );

  return Object.freeze({
    ruleSetId: WORKFLOW_SELECTION_RULE_SET_ID,
    version,
    status: 'PUBLISHED',
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: COMMERCE_WORKFLOW_FACT_CATALOGUE,
    rules: Object.freeze(rules),
  });
}

/* ---------------------------------------------------------------------------------------
 * SELECTION — the decision §2.4 reads back from the engine's own report
 * ------------------------------------------------------------------------------------- */

/**
 * Reasons THIS module states for a selection it cannot attribute to one candidate. They are
 * not engine vocabulary: the engine cannot report a defect in how a caller wired its rule ids
 * to its candidates, so the runtime names those two itself rather than paraphrasing the
 * engine into saying something it did not say.
 */
export const WORKFLOW_SELECTION_REASON_NOT_EVALUATED = 'SELECTION_NOT_EVALUATED' as const;
export const WORKFLOW_SELECTION_REASON_WINNING_RULE_MISSING = 'WINNING_RULE_MISSING' as const;
export const WORKFLOW_SELECTION_REASON_RULE_REFERENCE_MISMATCH = 'RULE_REFERENCE_MISMATCH' as const;

/**
 * The version ids behind a list of match records, in a total order, with the rule-id prefix
 * stripped — plans report VERSIONS (§2.5), never rule ids: a version is what gets pinned and
 * what an operator recognises. A record whose id does not carry the prefix is reported as it
 * stands rather than silently dropped, because an id this runtime cannot read is a defect to
 * surface, not a row to hide.
 */
function workflowSelectionVersionIdsOf(records: readonly RuleMatchRecord[]): readonly string[] {
  return Object.freeze(
    records
      .map((record) =>
        record.ruleId.startsWith(WORKFLOW_SELECTION_RULE_ID_PREFIX)
          ? record.ruleId.slice(WORKFLOW_SELECTION_RULE_ID_PREFIX.length)
          : record.ruleId
      )
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  );
}

/**
 * The plan of ONE selection: the candidates in, the engine's outcome in, the decision out
 * (§2.3–§2.6).
 *
 * `outcome` IS `null` EXACTLY WHEN THE CANDIDATE SET IS EMPTY, and that is a contract, not a
 * convenience: §2.4 makes zero candidates a NO_MATCH stated about the CONFIGURATION, and an
 * engine asked to evaluate a set with no rules would answer a question about a rule set rather
 * than about the business — its refusal would be a validation verdict on a set nobody
 * authored. Null is refused, never defaulted, for a non-empty set: a caller that forgot to
 * evaluate gets INVALID instead of a decision nobody took.
 *
 * EVERY VERDICT BELOW IS READ FROM THE ENGINE'S OWN REPORT: `status` is its typed outcome,
 * `matchHistory` its ordered per-rule account (priority and specificity included) and
 * `winningRule` its named winner. Nothing here re-computes specificity (§2.4), re-orders rules
 * (§12.1 lives in the engine) or resolves a tie by preference.
 */
export function planWorkflowSelection(
  candidates: readonly WorkflowSelectionCandidate[],
  outcome: RuleEvaluationOutcome | null
): WorkflowSelectionPlan {
  const ruleSetVersion = workflowSelectionSetVersion(candidates);
  const candidatesConsidered = Object.freeze(
    [...candidates]
      .map((candidate) => candidate.workflowDefinitionVersionId)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  );

  if (candidates.length === 0) {
    return { outcome: 'NO_MATCH', ruleSetVersion, candidatesConsidered };
  }

  if (outcome === null) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_SELECTION_REASON_NOT_EVALUATED,
      ruleSetVersion,
      candidatesConsidered,
    };
  }

  if (!outcome.evaluated) {
    return { outcome: 'INVALID', reason: outcome.reason, ruleSetVersion, candidatesConsidered };
  }

  const result = outcome.result;

  if (result.status === 'REFUSED_INVALID_VERSION' || result.status === 'REFUSED_BOUNDS_EXCEEDED') {
    return { outcome: 'INVALID', reason: result.status, ruleSetVersion, candidatesConsidered };
  }

  if (result.status === 'CONFLICT' || result.status === 'REFUSED_INSUFFICIENT_CONTEXT') {
    const top = result.matchHistory[0];
    if (top === undefined) {
      return {
        outcome: 'INVALID',
        reason: WORKFLOW_SELECTION_REASON_WINNING_RULE_MISSING,
        ruleSetVersion,
        candidatesConsidered,
      };
    }

    const score: WorkflowCandidateScore = { priority: top.priority, specificity: top.specificity };

    return {
      outcome: 'AMBIGUOUS',
      tiedVersionIds: workflowSelectionVersionIdsOf(
        result.matchHistory.filter(
          (record) =>
            record.priority === score.priority &&
            record.specificity === score.specificity &&
            record.conditionOutcome !== 'FALSE'
        )
      ),
      score,
      ruleSetVersion,
      candidatesConsidered,
    };
  }

  if (result.status === 'NO_MATCH') {
    return { outcome: 'NO_MATCH', ruleSetVersion, candidatesConsidered };
  }

  const winningRule = result.winningRule;
  if (winningRule === null) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_SELECTION_REASON_WINNING_RULE_MISSING,
      ruleSetVersion,
      candidatesConsidered,
    };
  }

  const winningAction = winningRule.action;
  const winnerRecord = result.matchHistory.find((record) => record.ruleId === winningRule.ruleId);
  const winnerCandidate = candidates.find(
    (candidate) =>
      workflowSelectionRuleId(candidate.workflowDefinitionVersionId) === winningRule.ruleId
  );

  if (winnerRecord === undefined || winnerCandidate === undefined) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_SELECTION_REASON_RULE_REFERENCE_MISMATCH,
      ruleSetVersion,
      candidatesConsidered,
    };
  }

  if (
    winningAction.type !== 'REQUIRED_APPROVAL_STEP' ||
    winningAction.approverRuleRef !== winnerCandidate.workflowDefinitionVersionId
  ) {
    return {
      outcome: 'INVALID',
      reason: WORKFLOW_SELECTION_REASON_RULE_REFERENCE_MISMATCH,
      ruleSetVersion,
      candidatesConsidered,
    };
  }

  const score: WorkflowCandidateScore = {
    priority: winnerRecord.priority,
    specificity: winnerRecord.specificity,
  };
  const tiedVersionIds = workflowSelectionVersionIdsOf(
    result.matchHistory.filter(
      (record) =>
        record.matched &&
        record.priority === score.priority &&
        record.specificity === score.specificity
    )
  );

  if (tiedVersionIds.length > 1) {
    return { outcome: 'AMBIGUOUS', tiedVersionIds, score, ruleSetVersion, candidatesConsidered };
  }

  return {
    outcome: 'SELECTED',
    winner: winnerCandidate,
    score,
    ruleSetVersion,
    candidatesConsidered,
  };
}

/* ---------------------------------------------------------------------------------------
 * ACTIVATION — the pinned version's steps as a rule set (§5.1–§5.2)
 * ------------------------------------------------------------------------------------- */

/**
 * One step of the PINNED version, as activation reads it: the columns this decision needs,
 * and nothing else.
 *
 * WHY A SHAPE OF THIS MODULE'S OWN. The database boundary keeps Prisma types to itself (§8.1),
 * so the repository maps a step row onto this record and the planner never sees a table.
 * `condition` arrives already parsed and `null` means unconditional — the SAME absence the
 * unconditional leaf states, which is why the rule set substitutes that leaf rather than
 * inventing a `true` literal of its own.
 */
export interface WorkflowStepConfigurationRecord {
  readonly stepKey: string;
  readonly displayName: string;
  readonly mandatory: boolean;
  readonly executionMode: WorkflowStepExecutionMode;
  readonly ordering: number;
  readonly parallelGroup: string | null;
  readonly condition: RuleConditionNode | null;
  readonly onConditionFalse: WorkflowConditionFalseBehavior | null;
  readonly actorSource: WorkflowActorSource | null;
  readonly actorUserId: string | null;
}

/**
 * The pinned version's steps in the order activation numbers them: `ordering` ascending, with
 * `stepKey` breaking a tie.
 *
 * WHY THE SORT LIVES HERE AND NOT IN A QUERY'S `ORDER BY`. The 1-based position is the ONLY
 * thing mapping an engine outcome back to the step it names (§5.2), so it must be a function
 * of the step LIST. Publication refuses duplicated `ordering` values, which makes this order
 * total for every version that can be published — and the tiebreak means even a hypothetical
 * duplicate orders deterministically instead of however the rows happened to arrive.
 */
export function workflowOrderedSteps(
  steps: readonly WorkflowStepConfigurationRecord[]
): readonly WorkflowStepConfigurationRecord[] {
  return Object.freeze(
    [...steps].sort((left, right) => {
      if (left.ordering !== right.ordering) return left.ordering - right.ordering;
      if (left.stepKey === right.stepKey) return 0;
      return left.stepKey < right.stepKey ? -1 : 1;
    })
  );
}

/** The one prefix an activation rule id may carry, shared by its builder and its reader. */
export const WORKFLOW_ACTIVATION_RULE_ID_PREFIX = 'activation:';

/**
 * The rule identity of ONE step (§5.2): `activation:<stepKey>`.
 *
 * A step key that is not a safe identifier makes the id inadmissible, and the engine then
 * refuses the whole set (REFUSED_INVALID_VERSION) — a named refusal of the run, never a
 * silently skipped step. Publication is where a routable key is required; activation reports
 * the consequence rather than repairing it.
 */
export function workflowActivationRuleId(stepKey: string): string {
  return `${WORKFLOW_ACTIVATION_RULE_ID_PREFIX}${stepKey}`;
}

/**
 * The `STEP_ACTIVATION` action of one step (§5.2): its 1-based position, which is what the
 * runtime maps an outcome back through. The engine bounds a position to 1…64 and publication
 * refuses a version with more steps than the engine can represent, so the bound is never
 * reached by inventing a number here.
 */
function workflowActivationAction(stepOrder: number): RuleStepActivationAction {
  return Object.freeze({ type: 'STEP_ACTIVATION', stepOrder });
}

/**
 * The ACTIVATION rule set of a pinned version (§5.2): one rule per step, in the version's
 * order — id `activation:<stepKey>`, priority 0 (steps carry no rule precedence; their order
 * is `ordering`, not a priority), condition from the step's stored tree (absent = the
 * unconditional leaf), action `STEP_ACTIVATION` naming the step's position.
 *
 * THE VERSION IS THE PINNED VERSION ID (§5.1), never a digest and never re-derived later: the
 * set is read FROM the pinned row, so an instance's activation basis cannot drift when a
 * later version is published. `status: 'PUBLISHED'` for the same reason the selection set
 * carries it (§5.5): every row behind this set is published, and the engine's business gate —
 * a decision is taken under a published version and no other — is honoured, not bypassed.
 */
export function workflowActivationRuleSet(
  pinnedVersionId: string,
  definitionCode: string,
  steps: readonly WorkflowStepConfigurationRecord[]
): RuleSetVersion {
  const ordered = workflowOrderedSteps(steps);

  const rules = ordered.map((step, index): RuleSpec =>
    Object.freeze({
      id: workflowActivationRuleId(step.stepKey),
      version: pinnedVersionId,
      name: step.displayName,
      priority: 0,
      condition: step.condition ?? WORKFLOW_UNCONDITIONAL_CONDITION,
      actions: Object.freeze([workflowActivationAction(index + 1)]),
    })
  );

  return Object.freeze({
    ruleSetId: workflowActivationRuleSetId(definitionCode),
    version: pinnedVersionId,
    status: 'PUBLISHED',
    schemaVersion: RULE_ENGINE_SCHEMA_VERSION,
    fields: COMMERCE_WORKFLOW_FACT_CATALOGUE,
    rules: Object.freeze(rules),
  });
}

/* ---------------------------------------------------------------------------------------
 * PUBLICATION — the engine's verdict over BOTH sets (§10's last two rows)
 * ------------------------------------------------------------------------------------- */

/**
 * One stored tree, as the engine's validator needs to RECEIVE it (§10).
 *
 * WHY THIS CAST IS THE HONEST ONE AND NOT A SHORTCUT. The columns are `unknown` on this side —
 * they are whatever JSON a tenant wrote, read back through Prisma — and `RuleConditionNode` on
 * the engine's side. Deciding whether what was written IS a tree is the engine's own job, and it
 * does it totally: a non-object becomes `MISSING_CONDITION`, an unknown node kind, operator or
 * field becomes its own located refusal. Narrowing here would mean this module answering a
 * question the engine answers better, and answering it differently from the runtime — which is
 * the one thing §10 forbids ("publishable" and "evaluable" must be the same claim).
 */
function storedConditionTree(value: unknown): RuleConditionNode | null {
  return value === undefined || value === null ? null : (value as RuleConditionNode);
}

/** The candidate a version IS (§2.2), read from the version's own columns and nothing else. */
function workflowCandidateOf(
  version: WorkflowVersionConfigurationShape
): WorkflowSelectionCandidate {
  return {
    workflowDefinitionId: version.workflowDefinitionId,
    workflowDefinitionCode: version.workflowDefinitionCode,
    workflowDefinitionVersionId: version.workflowDefinitionVersionId,
    versionLabel: version.versionLabel,
    selectionPriority: version.selectionPriority ?? null,
    selectionCondition: storedConditionTree(version.selectionCondition),
  };
}

/**
 * A version's steps as activation reads them (§5.2) — the same mapping the repository performs
 * for a pinned row, done here for a version that is not pinned yet.
 *
 * `?? null` IS THE MAPPING, not a default: every optional column of the configuration shape means
 * "not stated", and the record's `null` means exactly the same absence. Reading `0`, `''` or
 * `'SKIPPED'` into an absent column would invent configuration the tenant never wrote — and for
 * `onConditionFalse` that would be the hard-coded false behaviour §4 forbids.
 */
function workflowActivationRecordsOf(
  version: WorkflowVersionConfigurationShape
): readonly WorkflowStepConfigurationRecord[] {
  return version.steps.map((step) => ({
    stepKey: step.stepKey,
    displayName: step.displayName,
    mandatory: step.mandatory,
    executionMode: step.executionMode,
    ordering: step.ordering,
    parallelGroup: step.parallelGroup ?? null,
    condition: storedConditionTree(step.condition),
    onConditionFalse: step.onConditionFalse ?? null,
    actorSource: step.actorSource ?? null,
    actorUserId: step.actorUserId ?? null,
  }));
}

/** The position the engine's own paths start with: `rules[<n>]`, 0-based, in the set's order. */
const WORKFLOW_RULE_POSITION = /^rules\[(\d+)\]/;

/**
 * The engine's issues, as this module's findings — its path, its message, and the step the path
 * names when it names one.
 *
 * WHY THE STEP IS READ OUT OF THE PATH. The activation set numbers its rules by the version's
 * stated order, so `rules[<n>]` IS the n-th step — one fact, taken from the coordinate the engine
 * itself reports. Reading it back out of a rule ID would parse a string the engine does not
 * promise to keep (this module's `activation:` prefix is its own convention, not the engine's),
 * and the report would break the day the engine's id format changed while its path stayed. A
 * set-level issue (a catalogue, a schema version, the rule count) names no position and therefore
 * no step, which is exactly right: it is about the set.
 */
function workflowFindingsOf(
  issues: readonly RuleValidationIssue[],
  stepKeys: readonly string[]
): readonly WorkflowRuleSetFinding[] {
  return issues.map((issue) => {
    const position = WORKFLOW_RULE_POSITION.exec(issue.path);
    const stepKey = position ? stepKeys[Number(position[1])] : undefined;
    return {
      path: issue.path,
      detail: issue.message,
      ...(stepKey ? { stepKey } : {}),
    };
  });
}

/**
 * The engine's verdict over the TWO rule sets §10's last two rows name, built from the version
 * being published exactly as the runtime builds them (§5.1–§5.2): the candidate rule from the
 * version's own selection columns (§2.3), and one activation rule per step (§5.2).
 *
 * WHY PUBLICATION RUNS THE ENGINE AT ALL. Publication is where a version becomes the
 * configuration purchases are governed by, and the engine is what governs them: validating the
 * stored trees with the engine's own validator, over the Commerce catalogue (§5.4) and through
 * the same construction the runtime performs, is what makes "publishable" and "evaluable" one
 * claim. A gate that walked the trees itself would be a second opinion about the engine's
 * grammar — and the day the two disagreed, the version would be published and then refuse every
 * submission, which is precisely what §10 forbids.
 *
 * THE SELECTION SET HERE HOLDS ONE CANDIDATE — THIS VERSION — because §10's row is about the
 * version's OWN rule. A whole candidate set's identity is a runtime fact (§5.1), computed by
 * selection over the published rows; here only the findings are read, and a one-candidate set
 * finds exactly what the version's own rule would contribute.
 *
 * CONFLICTS ARE NOT RETURNED, DELIBERATELY (§12.3 belongs to the engine's own contract, and the
 * workflow slice names no conflict row): for ACTIVATION nothing here CAN conflict — every step of
 * a version is activated by its own rule (§9.2 reads the whole ordered list), so two branches
 * stating the same condition, or two rules sharing priority 0, decide nothing against each other.
 * Turning the engine's conflict report into a refusal would refuse legal configuration.
 */
export function describeWorkflowRuleSetFindings(
  version: WorkflowVersionConfigurationShape
): WorkflowRuleSetFindings {
  const activationSteps = workflowOrderedSteps(workflowActivationRecordsOf(version));

  const selectionIssues = validateRuleSetVersion(
    workflowSelectionRuleSet([workflowCandidateOf(version)])
  ).issues;
  const activationIssues = validateRuleSetVersion(
    workflowActivationRuleSet(
      version.workflowDefinitionVersionId,
      version.workflowDefinitionCode,
      activationSteps
    )
  ).issues;

  return {
    selection: workflowFindingsOf(selectionIssues, []),
    activation: workflowFindingsOf(
      activationIssues,
      activationSteps.map((step) => step.stepKey)
    ),
  };
}

/* ---------------------------------------------------------------------------------------
 * GROUPS — §9.2's only structure: one step, or the branches sharing one label
 * ------------------------------------------------------------------------------------- */

/**
 * One unit of activation and one unit of join (§9.2): a single `SEQUENTIAL`/`CONDITIONAL`
 * step, or the branches sharing one `parallelGroup` label.
 *
 * WHY THE RUN IS GROUPED AT ALL. "Which step is next" is never a position, it is the next
 * GROUP that is not finished — which is what makes a parallel group one thing to advance and
 * what makes §3's join policy expressible at all. `firstOrdering` is the group's order key: a
 * group is ordered by its FIRST member's `ordering`, so branches written out of sequence still
 * advance together at the place the first of them occupies.
 *
 * A `PARALLEL` step without a label is not grouped — it becomes its own single-branch group,
 * which is exactly what §3 says a one-branch group does. Publication refuses the shape anyway,
 * so this is the runtime agreeing with the configuration gate rather than inventing a rule.
 */
export interface WorkflowStepGroup {
  /** The group's identity: its `parallelGroup` label, or the single step's `stepKey`. */
  readonly label: string;
  readonly kind: 'SINGLE' | 'PARALLEL';
  readonly members: readonly WorkflowStepConfigurationRecord[];
  /** The `ordering` of the group's first member — the group's place in the sequence. */
  readonly firstOrdering: number;
}

/**
 * The version's steps as ordered groups (§9.2), computed from the step list alone.
 *
 * The result is a FUNCTION of the rows, not of a query: stable under any input order and free
 * of counts, positions and "step 1" — the same sentence §9.2 states for the runtime.
 */
export function workflowStepGroups(
  steps: readonly WorkflowStepConfigurationRecord[]
): readonly WorkflowStepGroup[] {
  const ordered = workflowOrderedSteps(steps);
  const draft: {
    label: string;
    kind: 'SINGLE' | 'PARALLEL';
    members: WorkflowStepConfigurationRecord[];
    firstOrdering: number;
  }[] = [];
  const parallelGroupIndexes = new Map<string, number>();

  for (const step of ordered) {
    const label = step.executionMode === 'PARALLEL' ? step.parallelGroup : null;

    if (label === null) {
      draft.push({
        label: step.stepKey,
        kind: 'SINGLE',
        members: [step],
        firstOrdering: step.ordering,
      });
      continue;
    }

    const existing = parallelGroupIndexes.get(label);
    if (existing === undefined) {
      parallelGroupIndexes.set(label, draft.length);
      draft.push({ label, kind: 'PARALLEL', members: [step], firstOrdering: step.ordering });
      continue;
    }

    const group = draft[existing];
    if (group !== undefined) group.members.push(step);
  }

  return Object.freeze(
    draft.map((group) =>
      Object.freeze({
        label: group.label,
        kind: group.kind,
        members: Object.freeze(group.members),
        firstOrdering: group.firstOrdering,
      })
    )
  );
}

/* ---------------------------------------------------------------------------------------
 * ACTIVATION — one group's decision (§9.2, §3, §4)
 * ------------------------------------------------------------------------------------- */

/**
 * The runtime refusals activation can state, each one NAMED: a unit of work that cannot be
 * executed fails closed with a code and a bounded reason, never with a thrown error that
 * leaves a caller guessing what to fix.
 *
 * TWO ARE §10's PUBLISH CODES REUSED DELIBERATELY — `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED` and
 * `WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED` name the same facts at runtime as at publication,
 * and a second, differently-spelled runtime code would tell an operator that two different
 * things went wrong. `WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING` is the one row §10 says the
 * runtime RE-CHECKS (defence in depth: a row written outside the publish path cannot be
 * executed either). `WORKFLOW_VERSION_RULE_INVALID` covers a pinned version whose rules cannot
 * be evaluated at all, and `WORKFLOW_STEP_CONDITION_UNDECIDABLE` is this module's own name for
 * a condition that could not be DECIDED from the facts — the case §5.4 promises is never
 * resolved silently in either direction.
 */
export const WORKFLOW_ACTIVATION_REFUSAL_CODES = [
  'WORKFLOW_VERSION_RULE_INVALID',
  'WORKFLOW_STEP_CONDITION_UNDECIDABLE',
  'WORKFLOW_ACTOR_SOURCE_UNSUPPORTED',
  'WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING',
  'WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED',
] as const;

export type WorkflowActivationRefusalCode = (typeof WORKFLOW_ACTIVATION_REFUSAL_CODES)[number];

/** What activation decided about ONE step: its recorded outcome, its state and its approver. */
export interface WorkflowStepActivationPlan {
  readonly stepKey: string;
  /** The step's 1-based position in the version's ordered list (§5.2). */
  readonly stepOrder: number;
  readonly step: WorkflowStepConfigurationRecord;
  readonly conditionOutcome: RuleConditionOutcome;
  readonly conditionResult: boolean;
  /** `PENDING` (the step owes a decision) or `SKIPPED` (it does not) — never anything else. */
  readonly status: WorkflowStepInstanceStatus;
  /** The approver of §6.1, recorded on the instance; `null` when nothing is owed. */
  readonly resolvedApproverId: string | null;
}

/** One group's activated state, and what it means for the run. */
export interface WorkflowGroupActivationPlan {
  readonly group: WorkflowStepGroup;
  readonly steps: readonly WorkflowStepActivationPlan[];
  /** Members that became `PENDING`. Zero means the group is complete and the run advances. */
  readonly actionableCount: number;
  /** `REJECTED` iff a member's false condition was configured `TERMINATED` (§4). */
  readonly runStatus: 'RUNNING' | 'REJECTED';
}

export type WorkflowActivationDecision =
  | { readonly outcome: 'ACTIVATED'; readonly plan: WorkflowGroupActivationPlan }
  | {
      readonly outcome: 'REFUSED';
      readonly code: WorkflowActivationRefusalCode;
      readonly message: string;
    };

function refuseWorkflowActivation(
  code: WorkflowActivationRefusalCode,
  message: string
): WorkflowActivationDecision {
  return { outcome: 'REFUSED', code, message };
}

/**
 * ONE group's activation (§9.2), read from the engine's PER-STEP outcomes.
 *
 * WHY THE WINNER IS NOT READ. The engine names a winning rule, but activation asks a different
 * question — WHICH STEPS MAY BECOME ACTIVE — and each step's own `conditionOutcome` answers it.
 * That is also why `DECIDED` and `CONFLICT` are not consulted: every activation rule carries
 * the same action type (`STEP_ACTIVATION`) and the engine composes its decision signature from
 * action TYPES, so such a set can never be "incompatible matches" — its winner would be an
 * artefact of ordering, not a business answer. Only the engine's REFUSALS are fatal, because a
 * set that was never validly evaluated has no outcomes worth reading.
 *
 * A FALSE CONDITION TAKES THE STEP'S CONFIGURED PATH AND NOTHING ELSE (§4): `SKIPPED` records
 * the step as unfinished by configuration, `TERMINATED` records it the same way and ends the
 * RUN, and a missing or `BLOCKED` behaviour is refused — the runtime never guesses what a
 * false condition means, and never attributes a refusal to a person who made none.
 *
 * WHEN A MEMBER TERMINATES, NO SIBLING STAYS ACTIVE: members that would have become `PENDING`
 * are settled `SKIPPED` in the same decision — §3's own sentence for a terminal refusal inside
 * a group ("no branch may remain ambiguously active"), applied where that outcome appears.
 */
export function planWorkflowGroupActivation(
  steps: readonly WorkflowStepConfigurationRecord[],
  group: WorkflowStepGroup,
  outcome: RuleEvaluationOutcome | null
): WorkflowActivationDecision {
  if (outcome === null || !outcome.evaluated) {
    return refuseWorkflowActivation(
      'WORKFLOW_VERSION_RULE_INVALID',
      outcome === null ? 'the activation set was never evaluated' : outcome.reason
    );
  }

  const result = outcome.result;
  if (result.status === 'REFUSED_INVALID_VERSION' || result.status === 'REFUSED_BOUNDS_EXCEEDED') {
    return refuseWorkflowActivation('WORKFLOW_VERSION_RULE_INVALID', result.status);
  }

  const positions = new Map(
    workflowOrderedSteps(steps).map((step, index) => [step.stepKey, index + 1] as const)
  );
  const plans: WorkflowStepActivationPlan[] = [];
  let actionableCount = 0;
  let terminated = false;

  for (const member of group.members) {
    const stepOrder = positions.get(member.stepKey);
    const record = result.matchHistory.find(
      (entry) => entry.ruleId === workflowActivationRuleId(member.stepKey)
    );

    if (stepOrder === undefined || record === undefined) {
      return refuseWorkflowActivation(
        'WORKFLOW_VERSION_RULE_INVALID',
        `the activation set does not cover ${member.stepKey}`
      );
    }

    if (record.conditionOutcome === 'UNKNOWN') {
      return refuseWorkflowActivation(
        'WORKFLOW_STEP_CONDITION_UNDECIDABLE',
        record.missingFields.length === 0
          ? `${member.stepKey} could not be decided`
          : `${member.stepKey} could not be decided (missing: ${record.missingFields.join(', ')})`
      );
    }

    if (record.conditionOutcome === 'TRUE') {
      if (member.actorSource !== 'CONFIGURED_USER' || member.actorUserId === null) {
        return refuseWorkflowActivation(
          'WORKFLOW_ACTOR_SOURCE_UNSUPPORTED',
          `${member.stepKey} cannot resolve an approver`
        );
      }

      plans.push({
        stepKey: member.stepKey,
        stepOrder,
        step: member,
        conditionOutcome: 'TRUE',
        conditionResult: true,
        status: WORKFLOW_STEP_INSTANCE_PENDING,
        resolvedApproverId: member.actorUserId,
      });
      actionableCount += 1;
      continue;
    }

    if (member.onConditionFalse === null) {
      return refuseWorkflowActivation(
        'WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING',
        `${member.stepKey} states no behaviour for a false condition`
      );
    }

    if (member.onConditionFalse === 'BLOCKED') {
      return refuseWorkflowActivation(
        'WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED',
        `${member.stepKey} is configured BLOCKED`
      );
    }

    if (member.onConditionFalse === 'TERMINATED') terminated = true;

    plans.push({
      stepKey: member.stepKey,
      stepOrder,
      step: member,
      conditionOutcome: 'FALSE',
      conditionResult: false,
      status: 'SKIPPED',
      resolvedApproverId: null,
    });
  }

  if (terminated) {
    return {
      outcome: 'ACTIVATED',
      plan: Object.freeze({
        group,
        steps: Object.freeze(
          plans.map((plan): WorkflowStepActivationPlan =>
            plan.status === WORKFLOW_STEP_INSTANCE_PENDING
              ? Object.freeze({ ...plan, status: 'SKIPPED', resolvedApproverId: null })
              : plan
          )
        ),
        actionableCount: 0,
        runStatus: 'REJECTED',
      }),
    };
  }

  return {
    outcome: 'ACTIVATED',
    plan: Object.freeze({
      group,
      steps: Object.freeze(plans),
      actionableCount,
      runStatus: 'RUNNING',
    }),
  };
}

/* ---------------------------------------------------------------------------------------
 * DECISIONS — §9.3 and §3: what a person's decision does to the rest of the run
 * ------------------------------------------------------------------------------------- */

/**
 * The refusals a decision can state. ONE IS THE CONTRACT'S — `WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR`
 * (§6.1) — and the other three are this module's names for the states §9.3 requires to be
 * refused: a decision on a run that is not running, a step outside the pinned version, and a
 * step that owes nothing (a duplicate, a stale decision, a wrong step). Each is a different
 * conversation with the caller, and collapsing them into one "bad request" would lose the
 * difference between "this is someone else's step" and "this was already decided".
 */
export const WORKFLOW_DECISION_REFUSAL_CODES = [
  'WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR',
  'WORKFLOW_INSTANCE_NOT_RUNNING',
  'WORKFLOW_STEP_UNKNOWN',
  'WORKFLOW_STEP_NOT_ACTIONABLE',
] as const;

export type WorkflowDecisionRefusalCode = (typeof WORKFLOW_DECISION_REFUSAL_CODES)[number];

/** ONE step instance's PERSISTED state, as a decision reads it — and nothing more. */
export interface WorkflowStepStateSnapshot {
  readonly stepKey: string;
  readonly status: WorkflowStepInstanceStatus;
  readonly resolvedApproverId: string | null;
}

/** What a person asks a step to do, and who asks (§6.1, §9.3). */
export interface WorkflowStepDecisionRequest {
  readonly stepKey: string;
  readonly actingUserId: string;
  readonly decision: WorkflowStepDecision;
}

/** What a recorded decision does to the rest of the run. */
export interface WorkflowDecisionAdvance {
  readonly decidedStepKey: string;
  /** Sibling step keys to settle `SKIPPED` in the SAME transaction (§3). */
  readonly settledStepKeys: readonly string[];
  /** True when the decided step's group is COMPLETE and the run must advance (§9.2). */
  readonly advance: boolean;
  /**
   * `RUNNING`, or `REJECTED` when the join policy decided the run ends (§3). Never `APPROVED`:
   * whether any group remains depends on conditions still to be evaluated at activation, so
   * completion is decided there rather than guessed here.
   */
  readonly runStatus: 'RUNNING' | 'REJECTED';
}

export type WorkflowDecisionPlan =
  | {
      readonly outcome: 'REFUSED';
      readonly code: WorkflowDecisionRefusalCode;
      readonly message: string;
    }
  | { readonly outcome: 'APPLIED'; readonly advance: WorkflowDecisionAdvance };

function refuseWorkflowDecision(
  code: WorkflowDecisionRefusalCode,
  message: string
): WorkflowDecisionPlan {
  return { outcome: 'REFUSED', code, message };
}

function appliedWorkflowDecision(
  decidedStepKey: string,
  settledStepKeys: readonly string[],
  advance: boolean,
  runStatus: 'RUNNING' | 'REJECTED' = 'RUNNING'
): WorkflowDecisionPlan {
  return {
    outcome: 'APPLIED',
    advance: Object.freeze({
      decidedStepKey,
      settledStepKeys: Object.freeze([...settledStepKeys]),
      advance,
      runStatus,
    }),
  };
}

/**
 * The first group that still has work, or `null` when the run has none.
 *
 * "STILL HAS WORK" MEANS: it has a member owing a decision (`PENDING`) or a member with no
 * instance row at all (a group not yet activated). A group whose members are all terminal is
 * complete — including one whose members were all skipped by their conditions, which is exactly
 * the state §9.2 calls "the group is complete and the runtime advances".
 */
export function workflowNextGroup(
  groups: readonly WorkflowStepGroup[],
  state: readonly WorkflowStepStateSnapshot[]
): WorkflowStepGroup | null {
  const statuses = new Map(state.map((step) => [step.stepKey, step.status] as const));

  for (const group of groups) {
    const hasWork = group.members.some((member) => {
      const status = statuses.get(member.stepKey);
      return status === undefined || status === WORKFLOW_STEP_INSTANCE_PENDING;
    });

    if (hasWork) return group;
  }

  return null;
}

/**
 * ONE step's decision and its consequence (§9.3, §3), from the persisted state alone.
 *
 * THE FOUR CHECKS ARE IN THE ORDER §9.3 STATES THEM, and every one runs BEFORE any write: the
 * run is running, the step belongs to the pinned version, it owes a decision, and the acting
 * user is the person it was resolved to (§6.1 — `resolvedApproverId` is READ, never re-resolved
 * from "whoever is calling"). A decision failing any of them is refused with nothing written;
 * the repository's conditional write remains the second line of defence against two callers
 * racing on the same step.
 *
 * THE JOIN IS §3 VERBATIM. A single step's approval completes its group and its refusal ends the
 * run. In a parallel group, ALL ends the entire run on the first refusal and settles every
 * still-pending sibling — "no branch may remain ambiguously active after a terminal refusal" —
 * while ANY completes the group on the first approval and settles the rest, refusing to end the
 * run on a refusal as long as one branch may still approve. Only when EVERY branch of an ANY
 * group ends without an approval does the run become `REJECTED`.
 */
export function planWorkflowStepDecision(
  steps: readonly WorkflowStepConfigurationRecord[],
  state: readonly WorkflowStepStateSnapshot[],
  joinPolicy: WorkflowParallelJoinPolicy,
  runStatus: WorkflowInstanceStatus,
  request: WorkflowStepDecisionRequest
): WorkflowDecisionPlan {
  if (runStatus !== 'RUNNING') {
    return refuseWorkflowDecision('WORKFLOW_INSTANCE_NOT_RUNNING', `the run is ${runStatus}`);
  }

  const group = workflowStepGroups(steps).find((candidate) =>
    candidate.members.some((member) => member.stepKey === request.stepKey)
  );
  if (group === undefined) {
    return refuseWorkflowDecision(
      'WORKFLOW_STEP_UNKNOWN',
      `no step ${request.stepKey} in the pinned version`
    );
  }

  const target = state.find((step) => step.stepKey === request.stepKey);
  if (target === undefined) {
    return refuseWorkflowDecision(
      'WORKFLOW_STEP_NOT_ACTIONABLE',
      `${request.stepKey} has no instance`
    );
  }
  if (target.status !== WORKFLOW_STEP_INSTANCE_PENDING) {
    return refuseWorkflowDecision(
      'WORKFLOW_STEP_NOT_ACTIONABLE',
      `${request.stepKey} is ${target.status}`
    );
  }
  if (target.resolvedApproverId === null || target.resolvedApproverId !== request.actingUserId) {
    return refuseWorkflowDecision(
      'WORKFLOW_STEP_NOT_ASSIGNED_TO_ACTOR',
      `${request.stepKey} is not assigned to the acting user`
    );
  }

  const after = new Map(
    state.map(
      (step) =>
        [step.stepKey, step.stepKey === request.stepKey ? request.decision : step.status] as const
    )
  );
  const memberStatuses: WorkflowStepInstanceStatus[] = [];
  for (const member of group.members) {
    const status = after.get(member.stepKey);
    if (status === undefined) {
      return refuseWorkflowDecision(
        'WORKFLOW_STEP_NOT_ACTIONABLE',
        `the group is incomplete at ${member.stepKey}`
      );
    }
    memberStatuses.push(status);
  }

  const pendingSiblings = group.members
    .filter((member) => after.get(member.stepKey) === WORKFLOW_STEP_INSTANCE_PENDING)
    .map((member) => member.stepKey);
  const anyApproved = memberStatuses.includes('APPROVED');

  if (group.kind === 'SINGLE') {
    return request.decision === 'APPROVED'
      ? appliedWorkflowDecision(request.stepKey, [], true)
      : appliedWorkflowDecision(request.stepKey, [], false, 'REJECTED');
  }

  if (joinPolicy === 'ANY') {
    if (request.decision === 'APPROVED') {
      return appliedWorkflowDecision(request.stepKey, pendingSiblings, true);
    }
    if (pendingSiblings.length > 0) {
      return appliedWorkflowDecision(request.stepKey, [], false);
    }
    return anyApproved
      ? appliedWorkflowDecision(request.stepKey, [], true)
      : appliedWorkflowDecision(request.stepKey, [], false, 'REJECTED');
  }

  if (request.decision === 'REJECTED') {
    return appliedWorkflowDecision(request.stepKey, pendingSiblings, false, 'REJECTED');
  }
  if (pendingSiblings.length > 0) {
    return appliedWorkflowDecision(request.stepKey, [], false);
  }
  return appliedWorkflowDecision(request.stepKey, [], true);
}

/**
 * ONE cancellation (§9.3): a `RUNNING` run becomes `CANCELLED` and its outstanding steps are
 * settled `SKIPPED` in the same transaction.
 *
 * NOTHING ELSE IS INVENTED — no reopened step, no rolled-back decision, no recovery policy and
 * no cancellation roles (§9.3, §18) — and a run that is not running is refused under the same
 * code a late decision gets, because it is the same fact.
 */
export interface WorkflowCancellationPlan {
  readonly settledStepKeys: readonly string[];
  readonly runStatus: 'CANCELLED';
}

export type WorkflowCancellationDecision =
  | { readonly outcome: 'APPLIED'; readonly plan: WorkflowCancellationPlan }
  | {
      readonly outcome: 'REFUSED';
      readonly code: WorkflowDecisionRefusalCode;
      readonly message: string;
    };

export function planWorkflowCancellation(
  runStatus: WorkflowInstanceStatus,
  state: readonly WorkflowStepStateSnapshot[]
): WorkflowCancellationDecision {
  if (runStatus !== 'RUNNING') {
    return {
      outcome: 'REFUSED',
      code: 'WORKFLOW_INSTANCE_NOT_RUNNING',
      message: `the run is ${runStatus}`,
    };
  }

  return {
    outcome: 'APPLIED',
    plan: Object.freeze({
      settledStepKeys: Object.freeze(
        state
          .filter((step) => step.status === WORKFLOW_STEP_INSTANCE_PENDING)
          .map((step) => step.stepKey)
          .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
      ),
      runStatus: 'CANCELLED',
    }),
  };
}
