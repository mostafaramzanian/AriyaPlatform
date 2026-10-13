import { RuleCalendarDay, RuleScalarFieldType } from './rule.types';

/**
 * The frozen condition model of the Platform Rule Engine (§8).
 *
 * A condition is a **tree of typed nodes** with a closed operator set. Nothing here is executed as
 * code: a condition is interpreted data, so no string a rule author writes can become a program
 * (§20, §32).
 *
 * Node kinds, exactly as frozen by §8.1:
 *   { all:  ConditionNode[] }                    — AND
 *   { any:  ConditionNode[] }                    — OR
 *   { not:  ConditionNode }                      — NOT
 *   { field, op, value }                         — comparison / membership / emptiness / date
 *   { count: { over, where?, op, value } }       — aggregate comparison (D7 limits)
 */

/** §8.2 — the frozen comparison operator set. */
export type RuleComparisonOperator =
  | 'equals'
  | 'notEquals'
  | 'in'
  | 'notIn'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'dateBefore'
  | 'dateAfter'
  | 'dateBetween';

/**
 * §8.4 — the operators a `count` aggregate may use. The frozen text enumerates the ordering
 * operators only, so equality on a count is expressed as two ordering comparisons rather than
 * invented here.
 */
export type RuleCountOperator =
  'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';

/**
 * A single leaf operand. The shape is a closed union — there is no `data: any` escape hatch
 * (§9.3) — and the *pairing* of an operator with an operand shape is enforced by
 * `validateRuleSetVersion` at publish time (§8.3: type mismatch is a validation error, never a
 * coercion):
 *
 *   equals | notEquals            → one operand of the field's declared type
 *   in | notIn                    → a non-empty array of the field's declared type
 *   greaterThan…lessThanOrEqual   → one `number`, or one `date` operand
 *   dateBefore | dateAfter        → one `date` operand
 *   dateBetween                   → exactly `[from, to]`, inclusive, with `from <= to`
 *   isEmpty | isNotEmpty          → no operand at all
 */
export type RuleConditionOperand =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]
  | readonly [RuleCalendarDay, RuleCalendarDay];

/** `{ field, op, value }` — one leaf comparison (§8.1). */
export interface RuleComparisonCondition {
  readonly field: string;
  readonly op: RuleComparisonOperator;
  readonly value?: RuleConditionOperand;
}

/** `{ count: { over, where?, op, value } }` — an aggregate over a declared collection (§8.4). */
export interface RuleCountSpec {
  /** The collection's field name in the evaluation context (the counting basis, e.g. a
   *  `REQUEST_COUNT`-based collection). Never a path expression. */
  readonly over: string;
  /** Optional per-item condition, evaluated against each record of the collection. */
  readonly where?: readonly RuleConditionNode[];
  readonly op: RuleCountOperator;
  /** The declared maximum/minimum. Always read together with `over` and `op` (§16.1, D7). */
  readonly value: number;
}

export interface RuleCountCondition {
  readonly count: RuleCountSpec;
}

/** `{ all: [...] }` — AND. Every child must hold. */
export interface RuleAllCondition {
  readonly all: readonly RuleConditionNode[];
}

/** `{ any: [...] }` — OR. At least one child must hold. */
export interface RuleAnyCondition {
  readonly any: readonly RuleConditionNode[];
}

/** `{ not: node }` — NOT. Exactly one child. */
export interface RuleNotCondition {
  readonly not: RuleConditionNode;
}

export type RuleConditionNode =
  | RuleAllCondition
  | RuleAnyCondition
  | RuleNotCondition
  | RuleComparisonCondition
  | RuleCountCondition;

/**
 * A declared fact: its name and its type (§8.3). `enumValues` is present exactly when the type is
 * `enum`; the validator refuses any other combination.
 *
 * @remarks Field names are opaque identifiers, never paths: the engine resolves a fact by exact
 * name against the supplied context and never walks a property chain, so a rule author cannot
 * address (or reach) anything the catalogue did not declare.
 */
export interface RuleFieldDeclaration {
  readonly name: string;
  readonly type: RuleScalarFieldType;
  readonly enumValues?: readonly string[];
}

/**
 * A declared collection fact, usable only by the `count` node (§8.4). `itemFields` may not contain
 * a further collection, so the context shape is exactly one level deep and bounded.
 */
export interface RuleCollectionFieldDeclaration {
  readonly name: string;
  readonly type: 'collection';
  /** Hard maximum of records the application layer may supply (exceeding it is a context error,
   *  never a silent truncation — §8.4, §34). */
  readonly maxSize: number;
  readonly itemFields: readonly RuleFieldDeclaration[];
}

export type RuleFieldCatalogueEntry = RuleFieldDeclaration | RuleCollectionFieldDeclaration;

/**
 * The field catalogue, owned by the *consuming domain* and supplied to the engine as data (§8.3).
 * The engine never learns where it came from and never queries for it (D12).
 */
export type RuleFieldCatalogue = readonly RuleFieldCatalogueEntry[];

/** True when the declaration describes a collection (§8.4). */
export function isCollectionField(
  entry: RuleFieldCatalogueEntry
): entry is RuleCollectionFieldDeclaration {
  return entry.type === 'collection';
}

/**
 * Leaf paths are reported with a deterministic grammar so an explanation can name a precise
 * location without re-evaluating (§13.1):
 *
 *   path       := segment ('.' segment)*
 *   segment    := 'all' | 'any' | 'not' | 'field:' name | 'count:' over
 *
 * Examples: `field:employmentType`, `all[1].field:leaveTypeRef`, `count:leaveRequestsThisYear`.
 * The bracketed index used in a path is the child's declared index, so identical inputs always
 * produce identical paths.
 */
export const RULE_LEAF_PATH_PREFIX_FIELD = 'field:';
export const RULE_LEAF_PATH_PREFIX_COUNT = 'count:';
