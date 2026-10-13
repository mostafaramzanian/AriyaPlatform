/**
 * Phase C1 Step M (§5.6, §5.7, §5.8, §6, gate I20): the CONFIGURATION RULES of a workflow
 * step — the vocabularies, the bounds and the write-time refusals — as PURE data and pure
 * functions.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * §6's rule is that "step name, step order, mandatory/optional, execution mode, conditions,
 * actors, commercial liaison, thresholds, line routing, visible fields … MUST NOT require
 * TypeScript source changes", and gate I20 adds that they must not live in environment
 * variables either. So every one of those values is a COLUMN on `WorkflowStep` (step K
 * modelled them) and every question about whether a stated configuration is ACCEPTABLE is
 * answered here, once, rather than inside the service that stores it.
 *
 * THE BOUNDS ARE THE SCHEMA'S OWN WIDTHS, NOT NEW POLICY
 * -----------------------------------------------------
 * Every maximum below is the `VARCHAR(n)` the value lands in — `stepKey` 64, `displayName`
 * 200, and the definition's `code`/`name` and the version's `versionLabel` for the same
 * reason. This is `purchase.dto.ts`'s established rule ("the column lengths are mirrored
 * here instead of being left to the database"): without them a long value reaches Postgres
 * and returns as a driver error — a 500 for a client mistake, with no field named — while
 * with them it is a 400 that names the field, and the database constraint stays the last
 * line of defence rather than the only one. The ONE bound that is not a column width is
 * `WORKFLOW_MAX_VISIBLE_FIELDS`, and it is labelled as what it is: a bound, not a business
 * rule (§34's discipline; `MAX_PURCHASE_LINES` is the precedent).
 *
 * WHAT IS DELIBERATELY *NOT* INVENTED HERE
 * ---------------------------------------
 *  * NO grammar for `stepKey` beyond "non-empty and within the column". The schema calls it
 *    "the tenant's own key for this step inside the version (\"check-budget\")" and adds
 *    that "a runtime step instance cites the step ROW, never this string", so its only job
 *    is to be the author's unique handle inside one version — which the schema's own
 *    `@@unique([tenantId, workflowDefinitionVersionId, stepKey])` already enforces.
 *    Refusing a key for its SHAPE would refuse a legal configuration on a convention no
 *    specification states.
 *  * NO contiguity rule for `ordering`. The schema states a position and uniqueness within
 *    the version ("ORDER IS STATED, NEVER INFERRED") and says nothing about gaps, so
 *    10/20/30 is a configuration this system accepts. What may not happen is two steps at
 *    one position — which the uniqueness index forbids and the service pre-checks for a
 *    friendly refusal.
 *  * NO vocabulary for `thresholds` or `lineFilters`. §5.6 names both as configuration and
 *    §5.15 gives the cash/non-cash threshold a MEANING ("Cash/non-cash threshold is
 *    configuration … above configured threshold"), but no SHAPE anywhere: the comparison a
 *    routing step performs belongs to the step that performs it (§5.15's reroute is step
 *    O/P work). Inventing `{ min, max, currency }` here would be a second guess at a rule
 *    the specification has not yet stated, so both are stored as JSON and checked only for
 *    being a JSON OBJECT and for carrying no unsafe payload — the honest maximum that can
 *    be said without inventing a vocabulary.
 *  * NO field-name vocabulary for `configuration.visibleFields`. §6 requires that visible
 *    form fields be configurable; the NAMES belong to the form that renders them, which
 *    does not exist yet. So the list's SHAPE is enforced (an array of non-empty strings,
 *    bounded) and its CONTENTS are the tenant's.
 *
 * THIS FILE HAS NO DEPENDENCIES — no NestJS, no Prisma, no clock, no sibling module. The
 * condition TREE GRAMMAR is the platform rule engine's vocabulary and is walked in
 * `workflow-condition.ts`, which is why nothing here decides it: the service runs both and
 * merges the two reports, so neither file restates the other's rule.
 *
 * WHAT STEP N ADDED HERE (§10's publication rules)
 * ------------------------------------------------
 * The VERSION became a subject of its own: `triggerEvent`, `parallelJoinPolicy`, the version's
 * `selectionPriority`/`selectionCondition` and each step's `onConditionFalse` are columns no
 * single step carries, so the walk receives the version (see
 * `WorkflowVersionConfigurationShape`) and judges it too. Two of §10's rows are not this
 * module's to decide at all — whether a candidate rule and whether an activation rule VALIDATE
 * against the Commerce fact catalogue — so they arrive through the injected `ruleSetIssues`, the
 * engine's own verdict over the sets the runtime would build (§10: "publish validation walks the
 * version's stored trees through the engine's own validator … so 'publishable' and 'evaluable'
 * cannot disagree").
 *
 * THE ONE IMPORT BELOW IS THAT DECISION'S PRICE, AND IT NARROWS THE SENTENCE ABOVE: §10 fixes
 * the step-count bound as "the engine's frozen `maxStepOrder` (64)", so the bound is READ from
 * the engine's own limits module instead of being restated as a second `64` that could drift
 * from it. That keeps "no dependencies" true in the sense it is meant — no SERVICE dependency, no
 * database, no clock, no sibling module — and false only in the sense that a shared pure constant
 * is a dependency; `workflow-condition.ts` reads the engine's vocabulary the same way, for the
 * same reason: one answer to a question the platform already answers.

 */
import { RULE_LIMITS } from '../../../rules/core/rule-limits';

/**
 * How a step executes (§5.6), in the schema's order.
 *
 * SEQUENTIAL — its turn in the stated order.
 * PARALLEL   — one branch of a concurrent group; the branch label is `parallelGroup`.
 * CONDITIONAL— activated only while its condition holds (§5.7, §5.10).
 *
 * `SEQUENTIAL` is the schema's default, which is why a step that states no mode is a plain
 * step in the order rather than an ambiguity.
 */
export const WORKFLOW_STEP_EXECUTION_MODES = ['SEQUENTIAL', 'PARALLEL', 'CONDITIONAL'] as const;

export type WorkflowStepExecutionMode = (typeof WORKFLOW_STEP_EXECUTION_MODES)[number];

/**
 * HOW a step's approver is resolved (§5.8), in the schema's order.
 *
 * REQUESTER_MANAGER   — the requester's manager, from the reporting line.
 * GROUP_MANAGER       — the manager of the requester's organizational group.
 * COMMERCIAL_LIAISON  — the tenant's configured commercial liaison (§5.8's own role).
 * CONFIGURED_USER     — one named person, by opaque Core identity id.
 * CONFIGURED_ROLE     — whoever holds a role CODE; who that is stays Core's fact (§7/§10).
 * RULE_RESOLVER       — a condition tree that names the approver (the engine's payload).
 *
 * THE MEMBERS ARE A CLOSED LIST, and the reason is §5.8's prohibition: a hard-coded
 * approver identity must not be able to live in configuration, so the vocabulary names
 * MECHANISMS and never a person. A source outside this list is refused rather than stored
 * and interpreted later.
 */
export const WORKFLOW_ACTOR_SOURCES = [
  'REQUESTER_MANAGER',
  'GROUP_MANAGER',
  'COMMERCIAL_LIAISON',
  'CONFIGURED_USER',
  'CONFIGURED_ROLE',
  'RULE_RESOLVER',
] as const;

export type WorkflowActorSource = (typeof WORKFLOW_ACTOR_SOURCES)[number];

/**
 * §4's `WorkflowConditionFalseBehavior`, in the schema's order — a step's configured answer
 * to one question: its activation condition came out FALSE, and now what.
 *
 * SKIPPED    — the step instance is recorded `SKIPPED` beside its false condition and the run
 *              proceeds under the ordinary rules.
 * BLOCKED    — MODELLED, so an administrator can see the concept, and REFUSED AT PUBLISH in
 *              C1 N because the platform defines neither WHO resumes a blocked run nor from
 *              WHICH state (§4). Storable on a DRAFT; unreachable in a published run.
 * TERMINATED — as SKIPPED, and the RUN becomes `REJECTED` in the same transaction. The step is
 *              not recorded `REJECTED`, because nobody refused it and recording a human
 *              decision that no human made is the attribution error the contract forbids.
 *
 * A TOTAL list rather than a comment, for the same reason `WORKFLOW_ACTOR_SOURCES` is one: a
 * value outside this vocabulary is refused where it is STORED, and every reader of the column
 * can enumerate what it may hold.
 */
export const WORKFLOW_CONDITION_FALSE_BEHAVIORS = ['SKIPPED', 'BLOCKED', 'TERMINATED'] as const;

export type WorkflowConditionFalseBehavior = (typeof WORKFLOW_CONDITION_FALSE_BEHAVIORS)[number];

/**
 * §3's `WorkflowParallelJoinPolicy`, in the schema's order — the version's answer to "when does
 * a group of parallel branches complete".
 *
 * ALL — every branch must approve; the first refusal ends the RUN.
 * ANY — the first approval completes the group; a refusal does not end the run while another
 *       branch may still approve.
 *
 * REQUIRED AT PUBLISH exactly when the version has at least one `PARALLEL` step: with no
 * branches there is no join to configure, and with branches the answer cannot be defaulted
 * without inventing a policy the administrator never chose.
 */
export const WORKFLOW_PARALLEL_JOIN_POLICIES = ['ALL', 'ANY'] as const;

export type WorkflowParallelJoinPolicy = (typeof WORKFLOW_PARALLEL_JOIN_POLICIES)[number];
/**
 * §2.1's trigger event, as a CLOSED vocabulary — and in C1 N it has exactly one member.
 *
 * WHY ONE MEMBER IS STILL A LIST. The schema's enum is the contract's, and a trigger typed as a
 * bare string would make the column uncheckable: a version stating `PURCHASE_APPROVED` would be
 * stored, published, and then selected by no submission at all — a silent no-op where a refusal
 * belongs. The list is also where a second trigger will land, if the specification ever states
 * one; until then the honest answer to "which triggers exist" is this one-element list.
 */
export const WORKFLOW_TRIGGER_EVENTS = ['PURCHASE_SUBMITTED', 'AFTER_DOCUMENT_WORKFLOW_APPROVED'] as const;

export type WorkflowTriggerEvent = (typeof WORKFLOW_TRIGGER_EVENTS)[number];

/**
 * The actor sources the N RUNTIME can actually resolve — exactly one, because §5.8's other five
 * need machinery this step does not have: an org chart behind `REQUESTER_MANAGER`/`GROUP_MANAGER`,
 * a resolver's approval decision behind `RULE_RESOLVER` (step N), the liaison role (step P) and
 * Core role membership behind `CONFIGURED_ROLE`.
 *
 * WHY THE STORED VOCABULARY STAYS WIDER THAN THIS LIST, AND WHY BOTH EXIST. §5.8's six sources
 * are the MODELLED vocabulary: a DRAFT may state any of them, because seeing what a version
 * would need is how an administrator plans the rest of the configuration. Publication is where
 * "modelled" becomes "EXECUTABLE", and those are two different facts about one column —
 * `STEP_ACTOR_SOURCE_UNSUPPORTED` (M) judges the first at write time, `WORKFLOW_ACTOR_SOURCE_UNSUPPORTED`
 * (§10) judges the second at publish. Reading `WORKFLOW_ACTOR_SOURCES` here instead would make
 * the schema's enum the runtime's capability, which is backwards: what the runtime can execute
 * is the runtime's statement, so it is stated once, here.
 */
export const WORKFLOW_EXECUTABLE_ACTOR_SOURCES = ['CONFIGURED_USER'] as const;

/** The column width of `WorkflowDefinition.code`. */
export const WORKFLOW_MAX_DEFINITION_CODE_LENGTH = 64;

/** The column width of `WorkflowDefinition.name`. */
export const WORKFLOW_MAX_DEFINITION_NAME_LENGTH = 200;

/** The column width of `WorkflowDefinitionVersion.versionLabel`. */
export const WORKFLOW_MAX_VERSION_LABEL_LENGTH = 64;

/** The column width of `WorkflowStep.stepKey`. */
export const WORKFLOW_MAX_STEP_KEY_LENGTH = 64;

/** The column width of `WorkflowStep.displayName`. */
export const WORKFLOW_MAX_DISPLAY_NAME_LENGTH = 200;

/** The column width of `WorkflowStep.parallelGroup`. */
export const WORKFLOW_MAX_PARALLEL_GROUP_LENGTH = 64;

/**
 * The most field names one step's `configuration.visibleFields` may list.
 *
 * A BOUND, NOT A BUSINESS RULE (the same sentence `MAX_PURCHASE_LINES` carries): a purchase
 * request form's field list is tens of entries, and a request carrying hundreds is bounded
 * rather than stored, so the stored JSON cannot become a document.
 */
export const WORKFLOW_MAX_VISIBLE_FIELDS = 64;

/**
 * The parameter each actor source carries, `null` where the source is resolved by the
 * platform rather than by a stated value.
 *
 * WHY A TOTAL `Record` AND NOT A `switch`: adding a source to `WORKFLOW_ACTOR_SOURCES`
 * fails to compile until its parameter is decided here, so a new source cannot be added
 * that silently ignores a parameter a caller passes beside it.
 */
export const WORKFLOW_ACTOR_SOURCE_PARAMETERS: Readonly<
  Record<WorkflowActorSource, 'actorUserId' | 'actorRoleCode' | 'actorRule' | null>
> = Object.freeze({
  REQUESTER_MANAGER: null,
  GROUP_MANAGER: null,
  COMMERCIAL_LIAISON: null,
  CONFIGURED_USER: 'actorUserId',
  CONFIGURED_ROLE: 'actorRoleCode',
  RULE_RESOLVER: 'actorRule',
});

/** One step's stated configuration, as the boundary accepts it — before it is stored. */
export interface WorkflowStepConfigurationShape {
  readonly stepKey: string;
  readonly displayName: string;
  readonly mandatory: boolean;
  readonly executionMode: WorkflowStepExecutionMode;
  readonly ordering: number;
  readonly parallelGroup?: string | null;
  /** §5.7's activation tree. `null`/absent = unconditional (see the mode rule below). */
  readonly condition?: unknown;
  /**
   * §4's behaviour when `condition` evaluates false; `null`/absent while a DRAFT is
   * incomplete. Publication requires it exactly when the step states a condition — a
   * conditional step whose false path is unwritten has no defined runtime behaviour, and the
   * runtime never guesses one.
   */
  readonly onConditionFalse?: WorkflowConditionFalseBehavior | null;
  /** HOW the approver is resolved; `null` while a DRAFT is incomplete (the schema's note). */
  readonly actorSource?: WorkflowActorSource | null;
  readonly actorUserId?: string | null;
  readonly actorRoleCode?: string | null;
  readonly actorRule?: unknown;
  readonly thresholds?: unknown;
  readonly lineFilters?: unknown;
  readonly configuration?: unknown;
}

/**
 * ONE version of a workflow definition, as the configuration rules read it (§6, §10): the
 * version's OWN columns — the ones no step can carry — plus its steps.
 *
 * WHY THE VERSION BECAME A SUBJECT OF ITS OWN. §10's publication rules are about the version as
 * a unit: it must state a trigger event (what makes it a candidate at all, §2.1), it must state
 * a join policy (what a parallel group MEANS when it is joined, §3), and its own
 * `selectionPriority`/`selectionCondition` columns form the candidate rule the selector reads
 * (§2.3). None of those facts lives on a step, so a walk that received a step list could not
 * express them — which is why this shape exists rather than a fourth parameter.
 *
 * WHY THE TWO NEW ENUMS ARRIVE AS `string | null` INSTEAD OF THEIR CLOSED UNIONS. The columns are
 * read through a Prisma client whose enum types are the DATABASE's, and a row written outside
 * this slice — a migration, an operator, a later step's value — can hold a member this module has
 * never heard of. Typing them as the closed union would make the type a LIE about such a row, and
 * it is exactly that row the vocabulary rules must refuse with a report rather than with a
 * crash. So the shape carries what the column holds and the rules decide what it means.
 */
export interface WorkflowVersionConfigurationShape {
  /** The definition this version belongs to — half of a selection candidate's identity (§2.2). */
  readonly workflowDefinitionId: string;
  /** The version's identity — the activation rule set's version and the candidate's own key. */
  readonly workflowDefinitionVersionId: string;
  /** The definition's code — the activation rule set is `<prefix>.<code>` (§5.2). */
  readonly workflowDefinitionCode: string;
  readonly versionLabel: string;
  /** §2.1's trigger. Required to publish; an unknown value is refused at BOTH levels. */
  readonly triggerEvent?: string | null;
  /** §3's join policy. Required when any step is `PARALLEL`; unknown values refused at both levels. */
  readonly parallelJoinPolicy?: string | null;
  /**
   * §2.2's tie-break rating and §2.3's candidate condition. NOT checked here beyond their shape:
   * their bounds and their grammar are the engine validator's (it bounds a priority and walks a
   * tree — see `ruleSetIssues`), and a second bound stated in this file would be a second answer
   * to "what may a rule's priority be".
   */
  readonly selectionPriority?: number | null;
  readonly selectionCondition?: unknown;
  readonly steps: readonly WorkflowStepConfigurationShape[];
}

/**
 * One finding of the ENGINE's own validator, as this module reads it (§10's last two rows).
 *
 * WHY A TRANSLATED FINDING AND NOT THE ENGINE'S OWN ISSUE. That issue carries a code from the
 * engine's vocabulary (`UNKNOWN_FIELD`, `TYPE_MISMATCH`, …) — a closed set this module must not
 * restate, extend or renumber, and one an administrator does not need in order to fix a version.
 * What a report needs is the engine's own `path` (so the defect is LOCATED) and its message (so
 * it is READABLE); the code stays out because §10's row is the contract's code for the whole
 * finding: "does not validate against the Commerce fact catalogue" is one fact about the version,
 * not one fact per engine code — and a refusal list that grew with the engine's vocabulary would
 * be a list an administrator could not act on.
 */
export interface WorkflowRuleSetFinding {
  /** The engine's deterministic location, e.g. `rules[1].condition.all[0].field:amount`. */
  readonly path: string;
  /** The engine's bounded, human-readable reason. Never a dump of the input. */
  readonly detail: string;
  /** The step this finding belongs to, when the engine's rule id names one (§10's per-step row). */
  readonly stepKey?: string;
}

/**
 * The findings of the engine's validator over the TWO rule sets §10 names: the version's own
 * candidate rule (§2.3) and its per-step activation rules (§5.2), each reported separately
 * because they are refused with two different codes — `WORKFLOW_SELECTION_RULE_INVALID` is about
 * how requests FIND the version, `WORKFLOW_VERSION_RULE_INVALID` about how its steps activate,
 * and an operator fixing one should not have to read the other's.
 */
export interface WorkflowRuleSetFindings {
  readonly selection: readonly WorkflowRuleSetFinding[];
  readonly activation: readonly WorkflowRuleSetFinding[];
}

/**
 * The two levels a configuration is checked at — and the ONLY difference between them is
 * COMPLETENESS, never permissiveness about what a value MEANS.
 *
 * DRAFT   — write-time. A version is authored incrementally, so a step may still be
 *           INCOMPLETE: the schema says `actorSource` "is NULLABLE because a DRAFT version
 *           may be incomplete" and that "a PUBLISHED version with an unresolved actor is
 *           refused at publish time (validated on write), never at decision time". Every
 *           other rule applies identically at both levels, because a malformed value stored
 *           at DRAFT is still malformed later.
 * PUBLISH — the completeness gate. Adds what makes a version ROUTABLE: at least one step,
 *           and an actor source on every one of them.
 */
export const WORKFLOW_CONFIGURATION_LEVELS = ['DRAFT', 'PUBLISH'] as const;

export type WorkflowConfigurationLevel = (typeof WORKFLOW_CONFIGURATION_LEVELS)[number];

/**
 * Every reason a configuration can be refused, as data — so a spec can enumerate the whole
 * vocabulary and a client can map each one, rather than discovering a new member when a
 * payload happens to carry it.
 *
 * A `satisfies` clause over the same list, exactly as HR's authoring vocabulary does it:
 * adding a member to the union without adding it here is a COMPILE error, which is the only
 * way "the vocabulary is stated once" stays true across two declarations.
 *
 * TWO MEMBERS ARE NOT PRODUCED BY THE WALK IN THIS FILE: `STEP_CONDITION_INVALID` (one per
 * finding of the borrowed tree walk) and `STEP_PAYLOAD_UNSAFE` (the platform's own payload
 * scan). Both arrive through the INJECTED facts below, so the CODES live in this vocabulary
 * — one report, one closed set — while the walks stay where their vocabulary is owned.
 */
export type WorkflowConfigurationRefusal =
  | 'STEP_KEY_MISSING'
  | 'STEP_KEY_TOO_LONG'
  | 'STEP_DISPLAY_NAME_MISSING'
  | 'STEP_DISPLAY_NAME_TOO_LONG'
  | 'STEP_ORDERING_NOT_AN_INTEGER'
  | 'STEP_ORDERING_NOT_POSITIVE'
  | 'STEP_EXECUTION_MODE_UNSUPPORTED'
  | 'STEP_PARALLEL_GROUP_MISSING'
  | 'STEP_PARALLEL_GROUP_UNEXPECTED'
  | 'STEP_PARALLEL_GROUP_TOO_LONG'
  | 'STEP_CONDITION_REQUIRED'
  | 'STEP_CONDITION_UNEXPECTED'
  | 'STEP_CONDITION_INVALID'
  | 'STEP_ACTOR_SOURCE_UNSUPPORTED'
  | 'STEP_ACTOR_SOURCE_MISSING'
  | 'STEP_ACTOR_PARAMETER_MISSING'
  | 'STEP_ACTOR_PARAMETER_UNEXPECTED'
  | 'STEP_THRESHOLDS_NOT_AN_OBJECT'
  | 'STEP_LINE_FILTERS_NOT_AN_OBJECT'
  | 'STEP_CONFIGURATION_NOT_AN_OBJECT'
  | 'STEP_VISIBLE_FIELDS_INVALID'
  | 'STEP_PAYLOAD_UNSAFE'
  | 'STEP_KEY_DUPLICATED'
  | 'STEP_ORDERING_DUPLICATED'
  // §10's rows (step N), in two groups under M's naming discipline: the SHAPE rules judge a
  // STORED VALUE and therefore apply at both levels — a value outside a closed vocabulary is
  // malformed whether or not it is ever executed — while the `WORKFLOW_*` rows are the
  // PUBLICATION gate's own: what "routable" and "executable" mean for a version about to become
  // the configuration purchases are governed by.
  | 'STEP_CONDITION_FALSE_BEHAVIOR_UNSUPPORTED'
  | 'TRIGGER_EVENT_UNSUPPORTED'
  | 'JOIN_POLICY_UNSUPPORTED'
  | 'WORKFLOW_TRIGGER_MISSING'
  | 'WORKFLOW_JOIN_POLICY_MISSING'
  | 'WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED'
  | 'WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING'
  | 'WORKFLOW_ACTOR_SOURCE_UNSUPPORTED'
  | 'WORKFLOW_LINE_SCOPE_UNSUPPORTED'
  | 'WORKFLOW_STEP_COUNT_EXCEEDED'
  | 'WORKFLOW_SELECTION_RULE_INVALID'
  | 'WORKFLOW_VERSION_RULE_INVALID'
  | 'VERSION_HAS_NO_STEPS';

/** Every refusal reason, as data. */
export const WORKFLOW_CONFIGURATION_REFUSALS = [
  'STEP_KEY_MISSING',
  'STEP_KEY_TOO_LONG',
  'STEP_DISPLAY_NAME_MISSING',
  'STEP_DISPLAY_NAME_TOO_LONG',
  'STEP_ORDERING_NOT_AN_INTEGER',
  'STEP_ORDERING_NOT_POSITIVE',
  'STEP_EXECUTION_MODE_UNSUPPORTED',
  'STEP_PARALLEL_GROUP_MISSING',
  'STEP_PARALLEL_GROUP_UNEXPECTED',
  'STEP_PARALLEL_GROUP_TOO_LONG',
  'STEP_CONDITION_REQUIRED',
  'STEP_CONDITION_UNEXPECTED',
  'STEP_CONDITION_INVALID',
  'STEP_ACTOR_SOURCE_UNSUPPORTED',
  'STEP_ACTOR_SOURCE_MISSING',
  'STEP_ACTOR_PARAMETER_MISSING',
  'STEP_ACTOR_PARAMETER_UNEXPECTED',
  'STEP_THRESHOLDS_NOT_AN_OBJECT',
  'STEP_LINE_FILTERS_NOT_AN_OBJECT',
  'STEP_CONFIGURATION_NOT_AN_OBJECT',
  'STEP_VISIBLE_FIELDS_INVALID',
  'STEP_PAYLOAD_UNSAFE',
  'STEP_KEY_DUPLICATED',
  'STEP_ORDERING_DUPLICATED',
  // §10's rows (step N) — see the union above for the two groups.
  'STEP_CONDITION_FALSE_BEHAVIOR_UNSUPPORTED',
  'TRIGGER_EVENT_UNSUPPORTED',
  'JOIN_POLICY_UNSUPPORTED',
  'WORKFLOW_TRIGGER_MISSING',
  'WORKFLOW_JOIN_POLICY_MISSING',
  'WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED',
  'WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING',
  'WORKFLOW_ACTOR_SOURCE_UNSUPPORTED',
  'WORKFLOW_LINE_SCOPE_UNSUPPORTED',
  'WORKFLOW_STEP_COUNT_EXCEEDED',
  'WORKFLOW_SELECTION_RULE_INVALID',
  'WORKFLOW_VERSION_RULE_INVALID',
  'VERSION_HAS_NO_STEPS',
] as const satisfies readonly WorkflowConfigurationRefusal[];

/** One thing a borrowed walk found, and where it found it. */
export interface WorkflowConfigurationFinding {
  /** A deterministic path inside the payload (`all[1].field:amount`, `not`, `count:lines`). */
  readonly path: string;
  /** A bounded, human-readable reason. Never a dump of the input. */
  readonly reason: string;
}

/**
 * What the validator needs that is NOT derivable from the version's or a step's own columns —
 * INJECTED rather than imported, so this file stays a pure function of its inputs.
 *
 * This is HR's `resolveLimitWindow` decision (`leave-policy-validation.ts`: "injected rather
 * than imported so this module stays a pure function of its inputs while still using the
 * module's ONE calendar boundary in production"), applied to the three vocabularies this slice
 * does not own:
 *
 *  * `conditionIssues` walks §5.7's condition TREE GRAMMAR. That grammar is the platform
 *    rule engine's (`src/rules/rule-condition.interface`), so it is walked in
 *    `workflow-condition.ts` and passed in. Injecting it also lets a spec assert "this
 *    refusal came from my walk" with a stub and no second tree walker in the test — and it
 *    is what keeps THIS file from becoming a party to the engine's vocabulary (§9/§31: no
 *    second rule engine, in either direction).
 *  * `unsafePayload` is the platform's OWN definition of an unsafe stored payload
 *    (`findUnsafePayload` in the engine's core). A second, locally-written notion of
 *    "unsafe" would be a second answer to a security question.
 *  * `ruleSetIssues` is the engine's VALIDATOR over the two rule sets §10 names — the
 *    strongest of the three borrowings, because it is the same verdict the runtime acts on.
 *
 * Production passes all three, each from its owner: the first two from `workflow-condition.ts`
 * and the third from `workflow-execution.ts`, the file where the engine's validator and the
 * Commerce fact catalogue already meet.
 */
export interface WorkflowConfigurationFacts {
  readonly conditionIssues: (value: unknown) => readonly WorkflowConfigurationFinding[];
  readonly unsafePayload: (value: unknown) => WorkflowConfigurationFinding | null;
  /**
   * `ruleSetIssues` runs the ENGINE's own validator (§10's last two rows) over the two rule sets
   * the runtime would build from this version — its candidate rule (§2.3) and its per-step
   * activation rules (§5.2) — and answers with what it found, translated.
   *
   * IT IS A `facts` MEMBER FOR THE REASON THE OTHER TWO ARE: the validator, the two set builders
   * and the Commerce fact catalogue all belong to the engine's side of the seam, and they are
   * already gathered in `workflow-execution.ts`, the one file where the engine and this module
   * meet (§9). Importing them HERE would make this file a second party to the engine's
   * vocabulary instead of a consumer of its verdict, and would put a rule-engine dependency in
   * the module whose doc says it has none — the seam keeps §10's sentence true ("publishable"
   * and "evaluable" are the same validator) without moving any of the engine's internals in.
   */
  readonly ruleSetIssues: (version: WorkflowVersionConfigurationShape) => WorkflowRuleSetFindings;
}

/**
 * ONE refusal, with the coordinate that produced it.
 *
 * WHY A COORDINATE AND NOT JUST A CODE: §6 requires administrators to configure this without
 * a deployment, so a refusal nobody can act on makes the capability unusable. A code alone
 * says that *something* about the workflow is wrong; `stepKey` says WHICH step, and `path`
 * says where inside it — the difference between an administrator fixing a condition and an
 * administrator deleting the version.
 */
export interface WorkflowConfigurationIssue {
  readonly refusal: WorkflowConfigurationRefusal;
  /** The step's own key, when the defect is about one step. Absent for version-level refusals. */
  readonly stepKey?: string;
  /** Where inside the stored payload the defect is, when it is about a nested payload. */
  readonly path?: string;
  readonly detail?: string;
}

/**
 * The largest report one validation returns (§34: a bounded response).
 *
 * A version with a hundred broken steps must not be able to turn a validation call into a
 * payload, so the report is truncated — and the report SAYS it was truncated rather than
 * returning a short list that reads like a complete one.
 */
export const WORKFLOW_MAX_REPORTED_ISSUES = 64;

/**
 * The answer one validation returns.
 *
 * `valid` IS DERIVED, NOT A SEPARATE FACT: it is `issues.length === 0`, so no caller can
 * receive a report that says it is valid while carrying a refusal. `level` is echoed back
 * because "checked for publication" and "checked while authoring" are different claims about
 * the same rows; `truncated` says whether `WORKFLOW_MAX_REPORTED_ISSUES` cut the list.
 */
export interface WorkflowConfigurationReport {
  readonly valid: boolean;
  readonly level: WorkflowConfigurationLevel;
  /** Bounded by `WORKFLOW_MAX_REPORTED_ISSUES`; `truncated` says when the bound was hit. */
  readonly issues: readonly WorkflowConfigurationIssue[];
  readonly truncated: boolean;
}

/** Present and not `null`. An empty string IS stated, and is judged by the rule that reads it. */
function isStated(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * A JSON object — not `null`, not an array, not a scalar. What arrives here is `unknown`,
 * decoded from a request body or read back from a `Json` column, and the only question the
 * rules ask is whether it is a NAMED bag of values: the named payloads below are each a set
 * of NAMED settings, so an array carries no name and a scalar carries none either.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string's trimmed form, or the empty string for a non-string. */
function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Whether a value is one of a closed vocabulary's members. Never coerces. */
function isMember<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/** The three parameters an actor source may carry, so a source's own is nameable. */
const ACTOR_PARAMETER_NAMES = ['actorUserId', 'actorRoleCode', 'actorRule'] as const;

/**
 * The rules ONE step must satisfy, at the given level.
 *
 * THE MODE-DEPENDENT RULES APPLY ONLY TO A RECOGNIZED MODE: when `executionMode` is not a
 * member of the vocabulary that alone is the refusal, because also reporting "a PARALLEL
 * step needs a branch label" about a step whose mode nobody can read would be a second,
 * misleading finding — the shape of the report is part of its usefulness (HR's validator
 * states the same discipline about not manufacturing a second, misleading refusal).
 */
function describeWorkflowStepConfiguration(
  step: WorkflowStepConfigurationShape,
  level: WorkflowConfigurationLevel,
  facts: WorkflowConfigurationFacts
): WorkflowConfigurationIssue[] {
  const issues: WorkflowConfigurationIssue[] = [];
  const stepKey = trimmedText(step.stepKey);
  const at = (
    refusal: WorkflowConfigurationRefusal,
    extra?: { path?: string; detail?: string }
  ): void => {
    issues.push({ refusal, ...(stepKey ? { stepKey } : {}), ...(extra ?? {}) });
  };

  // THE AUTHOR'S HANDLE. Non-empty and inside the column — and nothing about its spelling,
  // for the reason the file doc records: the schema calls it a label and no specification
  // states a grammar for it.
  if (!stepKey) {
    at('STEP_KEY_MISSING');
  } else if (stepKey.length > WORKFLOW_MAX_STEP_KEY_LENGTH) {
    at('STEP_KEY_TOO_LONG');
  }

  // What the step is called on screen (§6: "step name" is configuration).
  const displayName = trimmedText(step.displayName);
  if (!displayName) {
    at('STEP_DISPLAY_NAME_MISSING');
  } else if (displayName.length > WORKFLOW_MAX_DISPLAY_NAME_LENGTH) {
    at('STEP_DISPLAY_NAME_TOO_LONG');
  }

  // The position in the version's stated order: an integer, at least 1. A fractional value
  // and a position below the floor are different refusals because they are different
  // mistakes — one cannot be a position at all, the other is one no order starts from.
  if (!Number.isInteger(step.ordering)) {
    at('STEP_ORDERING_NOT_AN_INTEGER');
  } else if (step.ordering < 1) {
    at('STEP_ORDERING_NOT_POSITIVE');
  }

  if (!isMember(WORKFLOW_STEP_EXECUTION_MODES, step.executionMode)) {
    at('STEP_EXECUTION_MODE_UNSUPPORTED');
  } else {
    const parallelGroup = trimmedText(step.parallelGroup);
    if (step.executionMode === 'PARALLEL') {
      // The schema's own note: a PARALLEL step's branches share a label, and a branch with
      // no label cannot be joined with anything.
      if (!parallelGroup) {
        at('STEP_PARALLEL_GROUP_MISSING', { path: 'parallelGroup' });
      } else if (parallelGroup.length > WORKFLOW_MAX_PARALLEL_GROUP_LENGTH) {
        at('STEP_PARALLEL_GROUP_TOO_LONG', { path: 'parallelGroup' });
      }
    } else if (parallelGroup) {
      // "NULL for steps outside a parallel group" — a label here names a group this step is
      // not in, so it is a stated setting nothing reads.
      at('STEP_PARALLEL_GROUP_UNEXPECTED', { path: 'parallelGroup' });
    }

    if (step.executionMode === 'CONDITIONAL') {
      // §5.10: a conditional step decides by its condition. Without one there is nothing to
      // decide with, so this is refused at BOTH levels.
      if (!isStated(step.condition)) {
        at('STEP_CONDITION_REQUIRED', { path: 'condition' });
      }
    } else if (isStated(step.condition)) {
      // §5.10 evaluates a condition "at activation time" — an activation a step in another
      // mode has none of, so this would be configuration nothing evaluates.
      at('STEP_CONDITION_UNEXPECTED', { path: 'condition' });
    }
  }

  if (isStated(step.condition)) {
    for (const finding of facts.conditionIssues(step.condition)) {
      at('STEP_CONDITION_INVALID', {
        path: `condition${finding.path ? `.${finding.path}` : ''}`,
        detail: finding.reason,
      });
    }
  }

  // HOW THE APPROVER IS RESOLVED (§5.8), and the ONE rule where the two levels differ: an
  // absent source is legal while authoring — the schema says `actorSource` "is NULLABLE
  // because a DRAFT version may be incomplete" — and refused at publish, because a version
  // whose actor is unresolved cannot decide anything.
  const source = step.actorSource;
  if (isMember(WORKFLOW_ACTOR_SOURCES, source)) {
    const required = WORKFLOW_ACTOR_SOURCE_PARAMETERS[source];
    for (const parameter of ACTOR_PARAMETER_NAMES) {
      const value = step[parameter];
      if (parameter === required) {
        // Stated AND non-blank: an empty string is a parameter that was sent and says nothing.
        if (!isStated(value) || (typeof value === 'string' && !value.trim())) {
          at('STEP_ACTOR_PARAMETER_MISSING', { path: parameter });
        }
      } else if (isStated(value)) {
        // A parameter THIS source is not resolved by: configuration nothing reads, refused
        // rather than stored, because whoever read it later would have to guess which of the
        // two statements beside each other the author meant.
        at('STEP_ACTOR_PARAMETER_UNEXPECTED', { path: parameter });
      }
    }

    // RULE_RESOLVER's parameter IS a condition tree (§5.8: "a rule engine condition tree,
    // validated on write"), so it is walked by the same borrowed grammar as the activation
    // condition — one walk, two places a tree can live.
    if (required === 'actorRule' && isStated(step.actorRule)) {
      for (const finding of facts.conditionIssues(step.actorRule)) {
        at('STEP_CONDITION_INVALID', {
          path: `actorRule${finding.path ? `.${finding.path}` : ''}`,
          detail: finding.reason,
        });
      }
    }
  } else {
    if (isStated(source)) {
      at('STEP_ACTOR_SOURCE_UNSUPPORTED', { path: 'actorSource' });
    } else if (level === 'PUBLISH') {
      at('STEP_ACTOR_SOURCE_MISSING', { path: 'actorSource' });
    }
    // With no readable source, a stated parameter names an approver no resolution would use.
    for (const parameter of ACTOR_PARAMETER_NAMES) {
      if (isStated(step[parameter])) {
        at('STEP_ACTOR_PARAMETER_UNEXPECTED', { path: parameter });
      }
    }
  }

  // §4's FALSE PATH (§10). `onConditionFalse` is MODELLED for every step and REQUIRED of a step
  // that states a condition: a false condition has three configured meanings and NO default, so
  // silence about it is exactly the hard-coded behaviour §4 forbids — while a step with no
  // condition never reaches a false outcome at all, and demanding the column there would refuse
  // configuration that has nothing for it to mean.
  //
  // THE VALUE'S SHAPE IS JUDGED AT BOTH LEVELS AND ITS EXECUTABILITY ONLY AT PUBLISH, and that
  // split is the contract's: §4 says `BLOCKED` is MODELLED so a DRAFT may carry it (an
  // administrator can see the concept), while no published version may — C1 N has no resume
  // user, no resume permission, no resume route and no resume state, so a published `BLOCKED`
  // would describe a resumption that does not exist.
  const falseBehavior = step.onConditionFalse;
  if (isStated(falseBehavior) && !isMember(WORKFLOW_CONDITION_FALSE_BEHAVIORS, falseBehavior)) {
    at('STEP_CONDITION_FALSE_BEHAVIOR_UNSUPPORTED', { path: 'onConditionFalse' });
  } else if (level === 'PUBLISH') {
    if (falseBehavior === 'BLOCKED') {
      at('WORKFLOW_BLOCKED_BEHAVIOR_UNSUPPORTED', { path: 'onConditionFalse' });
    } else if (isStated(step.condition) && !isStated(falseBehavior)) {
      at('WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING', { path: 'onConditionFalse' });
    }
  }

  // §10's ACTOR row: publication is where a MODELLED source must also be EXECUTABLE. §5.8's six
  // sources stay the stored vocabulary — an administrator may state any of them on a DRAFT and
  // see the concept — but the runtime resolves exactly one, so a published version stating any
  // other is refused HERE, while an administrator is reading a report, instead of at a purchase
  // submission, where nobody is configuring anything. The write-time refusal above keeps its own,
  // different meaning: a value outside §5.8's vocabulary is not a source at all.
  if (
    level === 'PUBLISH' &&
    isMember(WORKFLOW_ACTOR_SOURCES, source) &&
    !isMember(WORKFLOW_EXECUTABLE_ACTOR_SOURCES, source)
  ) {
    at('WORKFLOW_ACTOR_SOURCE_UNSUPPORTED', { path: 'actorSource' });
  }

  // §10's LINE-SCOPE row: per-line approval routing is step O's territory, so a published version
  // may not carry `lineFilters` — stored and published it would be read by nobody, and the honest
  // refusal is that the capability does not exist yet. The shape rule below still applies at both
  // levels, so a DRAFT may state one and see it stored while the rest of the configuration is
  // being written.
  if (level === 'PUBLISH' && isStated(step.lineFilters)) {
    at('WORKFLOW_LINE_SCOPE_UNSUPPORTED', { path: 'lineFilters' });
  }

  // THE THREE NAMED PAYLOADS. Each must be a JSON object when present (see `isJsonObject`),
  // and none may carry an unsafe payload — which the single scan below answers for all of
  // them at once, and for the text columns too.
  if (isStated(step.thresholds) && !isJsonObject(step.thresholds)) {
    at('STEP_THRESHOLDS_NOT_AN_OBJECT', { path: 'thresholds' });
  }

  if (isStated(step.lineFilters) && !isJsonObject(step.lineFilters)) {
    at('STEP_LINE_FILTERS_NOT_AN_OBJECT', { path: 'lineFilters' });
  }

  if (isStated(step.configuration) && !isJsonObject(step.configuration)) {
    at('STEP_CONFIGURATION_NOT_AN_OBJECT', { path: 'configuration' });
  } else if (isJsonObject(step.configuration) && isStated(step.configuration.visibleFields)) {
    // §6's "visible fields": a LIST of names, bounded, each non-blank. The names themselves
    // are the tenant's — the file doc records why no vocabulary is invented for them.
    const visible = step.configuration.visibleFields;
    const fields = Array.isArray(visible) ? visible : null;
    if (
      !fields ||
      fields.length > WORKFLOW_MAX_VISIBLE_FIELDS ||
      fields.some((field) => !trimmedText(field))
    ) {
      at('STEP_VISIBLE_FIELDS_INVALID', { path: 'configuration.visibleFields' });
    }
  }

  // THE WHOLE STORED PAYLOAD IS SCANNED ONCE, by the platform's own definition of an unsafe
  // payload — over the JSON payloads above AND the text columns, because a control character
  // in a step's display name is exactly as stored as one in a condition.
  const unsafe = facts.unsafePayload(step);
  if (unsafe) {
    at('STEP_PAYLOAD_UNSAFE', { path: unsafe.path, detail: unsafe.reason });
  }

  return issues;
}

/**
 * The whole configuration of ONE version, checked at the given level — the ONE entry point
 * every configuration write and both lifecycle gates call.
 *
 * WHY THE VERSION IS THE UNIT AND NOT THE STEP: three of the rules are about the SET rather
 * than about any member — "no two steps may share a key", "no two steps may share a
 * position", and at publish "the version must have at least one step". A check that saw one
 * step at a time could never see them, and the version is also what an administrator is
 * actually configuring. It is why `addStep` passes the version's steps WITH the candidate in
 * place: a duplicate is refused as a readable 409 before a row is written, instead of as a
 * unique-index violation afterwards.
 *
 * WHY IT REPORTS EVERY REFUSAL INSTEAD OF THE FIRST (the rule HR's validator states for its
 * own gate): a version with five problems would otherwise need five round trips, and the four
 * hidden behind the first would make "it is fixed now" untrue as often as the check order is
 * unlucky. The report is BOUNDED, so completeness costs a bounded payload.
 */
export function validateWorkflowVersionConfiguration(
  version: WorkflowVersionConfigurationShape,
  level: WorkflowConfigurationLevel,
  facts: WorkflowConfigurationFacts
): WorkflowConfigurationReport {
  const steps = version.steps;

  const issues: WorkflowConfigurationIssue[] = steps.flatMap((step) =>
    describeWorkflowStepConfiguration(step, level, facts)
  );

  // §10's VERSION-LEVEL rules — the facts no step can carry: what makes the version a candidate
  // at all (§2.1), what a parallel group MEANS when it is joined (§3), how many steps the engine
  // can represent, and the two rows that hand the version's stored trees to the ENGINE's own
  // validator. They run in the same "report every refusal" spirit as the step walk: a version
  // missing three of these should hear about three.
  //
  // WHY THE SHAPE RULES ALSO RUN AT DRAFT: a stored `triggerEvent` outside §2.1's one-member
  // vocabulary, or a join policy outside §3's, is malformed whether or not anybody publishes it
  // — and an author should learn that while authoring it, which is the discipline M's mode rule
  // states. The COMPLETENESS rows are the publish-only half, because "stated" is exactly what a
  // DRAFT is still allowed to be missing.
  if (isStated(version.triggerEvent) && !isMember(WORKFLOW_TRIGGER_EVENTS, version.triggerEvent)) {
    issues.push({ refusal: 'TRIGGER_EVENT_UNSUPPORTED', path: 'triggerEvent' });
  }
  if (
    isStated(version.parallelJoinPolicy) &&
    !isMember(WORKFLOW_PARALLEL_JOIN_POLICIES, version.parallelJoinPolicy)
  ) {
    issues.push({ refusal: 'JOIN_POLICY_UNSUPPORTED', path: 'parallelJoinPolicy' });
  }

  if (level === 'PUBLISH') {
    // A version nobody can select is not a published configuration: §2.2's candidates are
    // versions whose definition carries the submit trigger, so an absent one is a version that
    // would exist, be approved by an administrator, and govern nothing.
    if (!isStated(version.triggerEvent)) {
      issues.push({ refusal: 'WORKFLOW_TRIGGER_MISSING', path: 'triggerEvent' });
    }

    // §3's policy is only READ when a group is joined, so it is only REQUIRED of a version that
    // can have a group at all: demanding it of a strictly sequential flow would refuse a
    // configuration that has nothing for it to mean — the shape of argument the false-behaviour
    // rule below uses for the same reason.
    if (
      steps.some((step) => step.executionMode === 'PARALLEL') &&
      !isStated(version.parallelJoinPolicy)
    ) {
      issues.push({ refusal: 'WORKFLOW_JOIN_POLICY_MISSING', path: 'parallelJoinPolicy' });
    }

    // THE ENGINE'S OWN BOUND, READ AND NOT RESTATED (§10: "the engine's frozen `maxStepOrder`
    // (64)"). A literal here would be a second answer that could drift from the engine's, and the
    // engine would then refuse a set this gate had called publishable — so publication asks the
    // same constant, and a version past it is refused while an administrator is still looking at
    // it, not when a purchase submission is.
    if (steps.length > RULE_LIMITS.maxStepOrder) {
      issues.push({
        refusal: 'WORKFLOW_STEP_COUNT_EXCEEDED',
        path: 'steps',
        detail: `${steps.length} steps; the engine admits ${RULE_LIMITS.maxStepOrder}`,
      });
    }

    // THE VERSION'S OWN RULE (§2.3) AND ITS ACTIVATION RULES (§5.2), walked by the engine's
    // validator over the SAME two sets the runtime builds — which is what §10's "publication is
    // where configuration becomes executable" means in practice: one validator answers both
    // questions, so "publishable" and "evaluable" cannot disagree later. The selection findings
    // are refused once per finding (there is one candidate rule per version), and the activation
    // findings name their step through the engine's rule id, so the report still says WHICH step
    // an administrator has to fix.
    const ruleSetFindings = facts.ruleSetIssues(version);
    for (const finding of ruleSetFindings.selection) {
      issues.push({
        refusal: 'WORKFLOW_SELECTION_RULE_INVALID',
        path: finding.path,
        detail: finding.detail,
      });
    }
    for (const finding of ruleSetFindings.activation) {
      issues.push({
        refusal: 'WORKFLOW_VERSION_RULE_INVALID',
        ...(finding.stepKey ? { stepKey: finding.stepKey } : {}),
        path: finding.path,
        detail: finding.detail,
      });
    }
  }
  // A version with no steps is a DRAFT being authored and an unpublishable configuration: the
  // publication gate must refuse a structurally invalid workflow, and a configuration with no
  // steps routes nothing to nobody. Both readings are the same fact, judged by the level.
  if (steps.length === 0 && level === 'PUBLISH') {
    issues.push({ refusal: 'VERSION_HAS_NO_STEPS' });
  }

  // UNIQUENESS INSIDE THE VERSION — the schema's two unique indexes, pre-checked, so the
  // caller is told WHICH key or position collided rather than meeting a driver error. One
  // issue per colliding value, not one per step: three steps at position 2 is one mistake.
  const keyCounts = new Map<string, number>();
  const orderingCounts = new Map<number, number>();
  for (const step of steps) {
    const key = trimmedText(step.stepKey);
    if (key) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    if (Number.isInteger(step.ordering)) {
      orderingCounts.set(step.ordering, (orderingCounts.get(step.ordering) ?? 0) + 1);
    }
  }
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      issues.push({
        refusal: 'STEP_KEY_DUPLICATED',
        stepKey: key,
        detail: `stated by ${count} steps`,
      });
    }
  }
  for (const [ordering, count] of orderingCounts) {
    if (count > 1) {
      issues.push({
        refusal: 'STEP_ORDERING_DUPLICATED',
        path: 'ordering',
        detail: `position ${ordering} is stated by ${count} steps`,
      });
    }
  }

  const truncated = issues.length > WORKFLOW_MAX_REPORTED_ISSUES;
  return {
    valid: issues.length === 0,
    level,
    issues: truncated ? issues.slice(0, WORKFLOW_MAX_REPORTED_ISSUES) : issues,
    truncated,
  };
}
