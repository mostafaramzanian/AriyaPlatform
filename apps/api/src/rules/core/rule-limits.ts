/**
 * Bounds of the Platform Rule Engine core (§22, §34).
 *
 * Every number here is a **frozen platform constant together with its derivation**: §34 requires
 * bounded execution, and §12.2 requires that ordering weights are not tenant-tunable, for the same
 * reason the limits below are not — a configuration that decided differently in two tenancies
 * could not be explained to either. Nothing in this file is configurable per tenant, per request
 * or per environment; changing a value changes the platform's contract and belongs in a spec, not
 * in a deployment.
 *
 * Where a bound has a knock-on effect (the work budget), the derivation is stated so the two
 * numbers cannot drift apart silently.
 */

/** The payload schema the typed engine implements (§10.6). */
export const RULE_ENGINE_SCHEMA_VERSION = 1;

/** The schema versions this engine can validate and evaluate. A version outside this set is
 *  refused rather than guessed at (§10.6). */
export const SUPPORTED_RULE_ENGINE_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

export const RULE_LIMITS = Object.freeze({
  /** Rules in one set version. */
  maxRulesPerSet: 200,
  /** Declared facts in one catalogue. */
  maxCatalogueFields: 128,
  /** Fields of one collection item (a `count` filter must address a small shape). */
  maxCollectionItemFields: 16,
  /** Members of one `enum` declaration. */
  maxEnumValues: 64,
  /** Condition nodes in one rule's tree. */
  maxConditionsPerRule: 100,
  /** `count` nodes in one rule's tree. */
  maxCountNodesPerRule: 8,
  /** `where` conditions inside one `count` node. */
  maxCountWhereConditions: 8,
  /** Nesting depth of a condition tree. */
  maxConditionDepth: 8,
  /** Actions on one rule. */
  maxActionsPerRule: 8,
  /** Records the application layer may supply for one collection fact. */
  maxCountCollectionSize: 200,
  /** Work units available to one evaluation (derivation below). */
  maxEvaluationSteps: 3_000_000,
  /** Observed counts reported for one evaluation. */
  maxObservedCounts: 64,
  /** Match-history entries returned for one evaluation. */
  maxExplanationEntries: 512,
  /** Length of any identifier (ids, versions, refs, enum members). */
  maxIdentifierLength: 128,
  /** Length of a rule's human-readable name. */
  maxRuleNameLength: 200,
  /** Length of a version string. */
  maxVersionLength: 64,
  /** Length of a string operand. */
  maxStringOperandLength: 256,
  /** Members of an `in` / `notIn` operand array. */
  maxEnumOperandValues: 64,
  /** Magnitude of a `count` operand. */
  maxCountOperandValue: 1_000_000,
  minPriority: -1_000_000,
  maxPriority: 1_000_000,
  /** Calendars a date operand may fall in. */
  minCalendarYear: 1900,
  maxCalendarYear: 2100,
  /** A limit's declared maximum. */
  minLimitMaximum: 1,
  maxLimitMaximum: 1_000_000,
  /** An approval step's position. */
  minStepOrder: 1,
  maxStepOrder: 64,
});

/** The name of a bound, usable in a typed bounds report. */
export type RuleLimitName = keyof typeof RULE_LIMITS;

/**
 * Why each bound has the value it has. Kept beside the numbers so a reader cannot change one
 * without meeting its justification (§34).
 */
export const RULE_LIMIT_RATIONALE: Readonly<Record<RuleLimitName, string>> = Object.freeze({
  maxRulesPerSet:
    'A policy set this platform authorizes today is tens of rules; 200 bounds validation and explanation cost while leaving two orders of magnitude of headroom.',
  maxCatalogueFields:
    'The facts one domain speaks about in a single set; bounds catalogue validation.',
  maxCollectionItemFields:
    'A shape small enough that a `count` filter stays readable and cheap to evaluate.',
  maxEnumValues:
    'An enumeration with more members is a copy of a table, not a statement a rule makes.',
  maxConditionsPerRule:
    'Bounds one rule tree, and fixes the worst admissible work of one evaluation (see maxEvaluationSteps).',
  maxCountNodesPerRule:
    'A rule aggregating over more than a handful of collections is a report, not a rule.',
  maxCountWhereConditions: 'Bounds the per-item filter of one aggregate.',
  maxConditionDepth:
    'Beyond this a tree can no longer be explained to the person it decides about.',
  maxActionsPerRule: 'The typed outcomes one decision may carry.',
  maxCountCollectionSize:
    'The application layer supplies bounded collections; the longest window in scope is a year, whose request count is far below this.',
  maxEvaluationSteps:
    'Derived from the other bounds so no valid configuration is ever truncated: maxRulesPerSet x (maxConditionsPerRule + maxCountNodesPerRule x maxCountCollectionSize x maxCountWhereConditions) = 200 x (100 + 8 x 200 x 8) = 2,580,000, so this admits every admissible set and is reachable only by a tree that bypassed validation.',
  maxObservedCounts:
    'At most one observed count per `count` node, over every rule of an admissible set.',
  maxExplanationEntries:
    'At least maxRulesPerSet, so an admissible history is never truncated; bounded per §34.',
  maxIdentifierLength:
    'Long enough for a namespaced identifier, short enough that a report stays readable.',
  maxRuleNameLength: 'A label, not a document.',
  maxVersionLength: 'A version string is a label, never a payload.',
  maxStringOperandLength:
    'An operand longer than this is data (a note, a description), not a fact a rule compares.',
  maxEnumOperandValues: 'Matches maxEnumValues: membership cannot exceed the enum it tests.',
  maxCountOperandValue: 'A count bound beyond this magnitude is a modelling error.',
  minPriority: 'Bound so integer comparison stays exact and ordered.',
  maxPriority: 'Bound so integer comparison stays exact and ordered.',
  minCalendarYear:
    'A calendar day is compared as text, so a plausible year range keeps comparisons honest.',
  maxCalendarYear:
    'A calendar day is compared as text, so a plausible year range keeps comparisons honest.',
  minLimitMaximum: 'A limit of zero would refuse every request by construction.',
  maxLimitMaximum: 'Bound so a declared maximum stays a policy statement.',
  minStepOrder: 'Steps are 1-based, matching the step `order` of §17.',
  maxStepOrder: 'A flow with more steps than this is not an approval flow.',
});
