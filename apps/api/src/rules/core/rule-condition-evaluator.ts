import {
  RuleComparisonCondition,
  RuleConditionNode,
  RuleCountSpec,
  RuleFieldCatalogueEntry,
  RuleFieldDeclaration,
  isCollectionField,
} from '../rule-condition.interface';
import {
  RuleConditionOutcome,
  RuleFactRecord,
  RuleFactValue,
  RuleScalarFieldType,
} from '../rule.types';
import {
  isCalendarDayInRange,
  isEmptyFact,
  isStatedFact,
  matchesScalarFieldType,
  readOwnFact,
} from './rule-facts';
import { assertNever } from './rule-error';

/**
 * The condition interpreter: pure, total, three-valued (§8).
 *
 * Design decisions that are contractual, not incidental:
 *
 *  - **No short-circuit.** Every node of the tree is evaluated even after the outcome is already
 *    decided, so `failedLeaves` and `matchedLeaves` are complete and an explanation never has to
 *    say "and then it stopped looking" (§13.1). The tree is bounded (§34), so completeness is
 *    affordable.
 *  - **Three-valued.** A fact the context does not state is `UNKNOWN`, never `false` and never
 *    `true` (§8.3). `all` is false if any child is false and unknown otherwise; `any` is true if
 *    any child is true and unknown otherwise; `not` reverses a decided child and leaves `UNKNOWN`
 *    undecided.
 *  - **No coercion, ever.** A fact whose value does not match its declared type is treated exactly
 *    as an unstated fact (§8.3). A comparison that cannot be performed is `UNKNOWN`.
 *  - **Conservative on a bypassed tree.** Every uninterpretable construct yields `UNKNOWN` rather
 *    than a guessed `TRUE`, so a definition that skipped validation can never produce a decision
 *    by accident; an empty group is `UNKNOWN` for the same reason.
 *  - **Leaf truth is the leaf's own truth.** Under `not`, leaf paths are reported as evaluated;
 *    the negation is reflected in the node outcome and therefore in the rule outcome.
 */

/** The declared catalogue, indexed once per evaluation (never rebuilt per node). */
export type RuleFieldIndex = ReadonlyMap<string, RuleFieldCatalogueEntry>;

export interface ConditionEvaluationInput {
  readonly facts: Readonly<Record<string, RuleFactValue>>;
  readonly fields: RuleFieldIndex;
  /** The evaluation's remaining work allowance (§34). */
  readonly maxWorkUnits: number;
}

export interface RuleCountObservation {
  readonly over: string;
  readonly count: number;
}

/** A bound that was exceeded; reported instead of truncating silently (§8.4, §34). */
export interface ConditionBoundBreach {
  readonly limit: string;
  readonly observed: number;
  readonly maximum: number;
}

export interface ConditionEvaluation {
  readonly outcome: RuleConditionOutcome;
  /** Leaf paths whose comparison was false — the frozen `failedLeaves` of §13. */
  readonly failedLeaves: readonly string[];
  /** Leaf paths whose comparison was true — the grounds an action is explained by (§9.2). */
  readonly matchedLeaves: readonly string[];
  /** Declared facts the context did not state (sorted, deduplicated). */
  readonly missingFields: readonly string[];
  readonly observedCounts: readonly RuleCountObservation[];
  readonly steps: number;
  readonly breach: ConditionBoundBreach | null;
}

/** Work accounting, shared by every node of one evaluation. */
interface WorkState {
  steps: number;
  exceeded: boolean;
  breach: ConditionBoundBreach | null;
}

/** Per-scope leaf reporting: a rule scope feeds the explanation, an item scope does not. */
interface LeafScope {
  failed: string[];
  matched: string[];
  missing: string[];
  counts: RuleCountObservation[];
}

/** Evaluates one rule's condition tree and reports everything the explanation needs. */
export function evaluateConditionTree(
  condition: RuleConditionNode,
  input: ConditionEvaluationInput
): ConditionEvaluation {
  const work: WorkState = { steps: 0, exceeded: false, breach: null };
  const scope: LeafScope = { failed: [], matched: [], missing: [], counts: [] };

  const outcome = evaluateNode(condition, '', input, work, scope);

  return {
    outcome,
    failedLeaves: scope.failed,
    matchedLeaves: scope.matched,
    missingFields: dedupeSorted(scope.missing),
    observedCounts: [...scope.counts].sort(compareCountObservation),
    steps: work.steps,
    breach: work.breach,
  };
}

function evaluateNode(
  node: RuleConditionNode,
  path: string,
  input: ConditionEvaluationInput,
  work: WorkState,
  scope: LeafScope
): RuleConditionOutcome {
  work.steps += 1;
  if (work.exceeded || work.steps > input.maxWorkUnits) {
    work.exceeded = true;
    return 'UNKNOWN';
  }

  if ('all' in node) {
    return evaluateGroup(node.all, 'all', path, input, work, scope);
  }
  if ('any' in node) {
    return evaluateGroup(node.any, 'any', path, input, work, scope);
  }
  if ('not' in node) {
    return negate(evaluateNode(node.not, childPath(path, 'not', 0), input, work, scope));
  }
  if ('count' in node) {
    return evaluateCount(node.count, childPath(path, 'count', node.count.over), input, work, scope);
  }
  if ('field' in node) {
    return evaluateComparison(node, childPath(path, 'field', node.field), input, work, scope);
  }

  return assertNever(node, 'unknown condition node');
}

/**
 * AND (`all`) and OR (`any`).
 *
 * @remarks An empty group is `UNKNOWN`, not vacuously true or false: §12.3 refuses an empty group
 * at validation, and a bypassed one must not become a rule that matches everything.
 */
function evaluateGroup(
  children: readonly RuleConditionNode[],
  kind: 'all' | 'any',
  path: string,
  input: ConditionEvaluationInput,
  work: WorkState,
  scope: LeafScope
): RuleConditionOutcome {
  if (children.length === 0) {
    return 'UNKNOWN';
  }

  let sawFalse = false;
  let sawTrue = false;
  let sawUnknown = false;

  for (let index = 0; index < children.length; index += 1) {
    const outcome = evaluateNode(children[index], childPath(path, kind, index), input, work, scope);
    sawFalse = sawFalse || outcome === 'FALSE';
    sawTrue = sawTrue || outcome === 'TRUE';
    sawUnknown = sawUnknown || outcome === 'UNKNOWN';
  }

  if (kind === 'all') {
    return sawFalse ? 'FALSE' : sawUnknown ? 'UNKNOWN' : 'TRUE';
  }
  return sawTrue ? 'TRUE' : sawUnknown ? 'UNKNOWN' : 'FALSE';
}

function negate(outcome: RuleConditionOutcome): RuleConditionOutcome {
  if (outcome === 'TRUE') {
    return 'FALSE';
  }
  if (outcome === 'FALSE') {
    return 'TRUE';
  }
  return 'UNKNOWN';
}

/**
 * Leaf path grammar (§13): `all[1].field:leaveTypeRef`, `count:leaveRequestsThisYear`,
 * `not.field:x`. Deterministic, derived from declared positions only.
 */
function childPath(parent: string, kind: string, key: string | number): string {
  const segment = typeof key === 'number' ? `${kind}[${key}]` : `${kind}:${key}`;
  return parent.length === 0 ? segment : `${parent}.${segment}`;
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function compareCountObservation(a: RuleCountObservation, b: RuleCountObservation): number {
  return a.over < b.over ? -1 : a.over > b.over ? 1 : 0;
}

/** Indexes a declared field list, refusing duplicate names (validation guarantees none). */
export function indexFields(fields: readonly RuleFieldCatalogueEntry[]): RuleFieldIndex {
  const index = new Map<string, RuleFieldCatalogueEntry>();
  for (const field of fields) {
    if (!index.has(field.name)) {
      index.set(field.name, field);
    }
  }
  return index;
}

/** Indexes a collection's item fields (one level deep, §8.4). */
export function indexItemFields(itemFields: readonly RuleFieldDeclaration[]): RuleFieldIndex {
  return indexFields(itemFields);
}

/** The count comparison of a `count` node (§8.4: ordering operators against an integer result). */
function compareCount(count: number, op: RuleCountSpec['op'], value: number): RuleConditionOutcome {
  switch (op) {
    case 'greaterThan':
      return booleanOutcome(count > value);
    case 'greaterThanOrEqual':
      return booleanOutcome(count >= value);
    case 'lessThan':
      return booleanOutcome(count < value);
    case 'lessThanOrEqual':
      return booleanOutcome(count <= value);
    default:
      return assertNever(op, 'unknown count operator');
  }
}

/** Orders a stated fact against an operand: numbers numerically, calendar days as days. */
function compareOrdered(
  fact: string | number | boolean,
  operand: unknown,
  type: RuleScalarFieldType
): number | null {
  if (type === 'number' && typeof fact === 'number' && typeof operand === 'number') {
    return fact === operand ? 0 : fact < operand ? -1 : 1;
  }
  if (
    type === 'date' &&
    typeof fact === 'string' &&
    isCalendarDayInRange(fact) &&
    isCalendarDayInRange(operand)
  ) {
    return fact === operand ? 0 : fact < operand ? -1 : 1;
  }
  return null;
}

function orderingOutcome(
  comparison: number,
  op: 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual'
): RuleConditionOutcome {
  switch (op) {
    case 'greaterThan':
      return booleanOutcome(comparison > 0);
    case 'greaterThanOrEqual':
      return booleanOutcome(comparison >= 0);
    case 'lessThan':
      return booleanOutcome(comparison < 0);
    case 'lessThanOrEqual':
      return booleanOutcome(comparison <= 0);
    default:
      return assertNever(op, 'unknown ordering operator');
  }
}

function emptinessOutcome(op: 'isEmpty' | 'isNotEmpty', empty: boolean): RuleConditionOutcome {
  return booleanOutcome(op === 'isEmpty' ? empty : !empty);
}

function booleanOutcome(value: boolean): RuleConditionOutcome {
  return value ? 'TRUE' : 'FALSE';
}

/** Records a decided leaf: a truth is a ground, a falsehood is a failure, `UNKNOWN` is neither. */
function recordLeaf(scope: LeafScope, path: string, outcome: RuleConditionOutcome): void {
  if (outcome === 'TRUE') {
    scope.matched.push(path);
  } else if (outcome === 'FALSE') {
    scope.failed.push(path);
  }
}

/** A declared field usable in a comparison (a collection is not: §8.4 aggregates it). */
function isDeclaredScalar(
  entry: RuleFieldCatalogueEntry | undefined
): entry is RuleFieldDeclaration {
  return entry !== undefined && !isCollectionField(entry);
}

function isScalarOperand(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isFactRecord(value: unknown): value is RuleFactRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stated collection value on a scalar-typed field: unusable as a scalar, and never coerced
 * (§8.3). A type predicate so the scalar path needs no cast.
 */
function isFactCollection(value: unknown): value is readonly RuleFactRecord[] {
  return Array.isArray(value);
}

/**
 * One leaf comparison.
 *
 * @remarks Emptiness is decided *before* the fact is required to be stated, because an absent fact
 * **is** empty (§8.3): `isEmpty` is how a missing fact is stated explicitly, and it must be
 * answerable about a fact the context did not supply. Everything else about an unstated — or
 * stated in a type that contradicts its declaration — fact is `UNKNOWN` and is recorded as a
 * missing field, so the refusal is explainable (§16.6).
 */
function evaluateComparison(
  condition: RuleComparisonCondition,
  path: string,
  input: ConditionEvaluationInput,
  work: WorkState,
  scope: LeafScope
): RuleConditionOutcome {
  const entry = input.fields.get(condition.field);
  const raw = readOwnFact(input.facts, condition.field);
  const declared = isDeclaredScalar(entry);

  if (condition.op === 'isEmpty' || condition.op === 'isNotEmpty') {
    if (!declared) {
      scope.missing.push(condition.field);
      return 'UNKNOWN';
    }
    const outcome = emptinessOutcome(condition.op, isEmptyFact(raw));
    recordLeaf(scope, path, outcome);
    return outcome;
  }

  if (
    !declared ||
    !isStatedFact(raw) ||
    isFactCollection(raw) ||
    !matchesScalarFieldType(raw, entry.type, entry.enumValues)
  ) {
    scope.missing.push(condition.field);
    return 'UNKNOWN';
  }

  const outcome = compareScalar(condition, raw, entry.type);
  recordLeaf(scope, path, outcome);
  return outcome;
}

/**
 * Compares a stated, type-correct fact with the declared operand.
 *
 * @remarks Every branch answers `UNKNOWN` rather than guessing when the operand does not fit the
 * operator. Validation refuses such a rule at publish time, so this path exists for a bypassed
 * tree — where a guess would be the one outcome that must never happen.
 */
function compareScalar(
  condition: RuleComparisonCondition,
  fact: string | number | boolean,
  type: RuleScalarFieldType
): RuleConditionOutcome {
  const operand = condition.value;

  switch (condition.op) {
    case 'equals':
    case 'notEquals': {
      if (!isScalarOperand(operand) || typeof operand !== typeof fact) {
        return 'UNKNOWN';
      }
      return booleanOutcome(condition.op === 'equals' ? operand === fact : operand !== fact);
    }

    case 'in':
    case 'notIn': {
      if (!Array.isArray(operand) || operand.length === 0) {
        return 'UNKNOWN';
      }
      const candidate = operand as readonly (string | number | boolean)[];
      if (!candidate.every((value) => typeof value === typeof fact)) {
        return 'UNKNOWN';
      }
      const member = candidate.includes(fact);
      return booleanOutcome(condition.op === 'in' ? member : !member);
    }

    case 'greaterThan':
    case 'greaterThanOrEqual':
    case 'lessThan':
    case 'lessThanOrEqual': {
      const comparison = compareOrdered(fact, operand, type);
      return comparison === null ? 'UNKNOWN' : orderingOutcome(comparison, condition.op);
    }

    /**
     * `dateBefore` / `dateAfter` are the frozen spellings of strict date ordering (§8.2). They are
     * evaluated by the identical machinery as `lessThan` / `greaterThan` over calendar days: two
     * spellings of one semantics, so no second implementation can drift from this one.
     */
    case 'dateBefore':
    case 'dateAfter': {
      if (type !== 'date') {
        return 'UNKNOWN';
      }
      const comparison = compareOrdered(fact, operand, type);
      return comparison === null
        ? 'UNKNOWN'
        : orderingOutcome(comparison, condition.op === 'dateBefore' ? 'lessThan' : 'greaterThan');
    }

    case 'dateBetween': {
      if (
        type !== 'date' ||
        !Array.isArray(operand) ||
        operand.length !== 2 ||
        !isCalendarDayInRange(operand[0]) ||
        !isCalendarDayInRange(operand[1])
      ) {
        return 'UNKNOWN';
      }
      const [from, to] = operand as unknown as readonly [string, string];
      return booleanOutcome(fact >= from && fact <= to);
    }

    case 'isEmpty':
    case 'isNotEmpty':
      return emptinessOutcome(condition.op, isEmptyFact(fact));

    default:
      return assertNever(condition.op, 'unknown comparison operator');
  }
}

/** The §8.4 aggregate: count the records of a declared collection that pass the filter. */
function evaluateCount(
  spec: RuleCountSpec,
  path: string,
  input: ConditionEvaluationInput,
  work: WorkState,
  scope: LeafScope
): RuleConditionOutcome {
  const entry = input.fields.get(spec.over);
  const raw = readOwnFact(input.facts, spec.over);

  if (entry === undefined || !isCollectionField(entry) || !Array.isArray(raw)) {
    scope.missing.push(spec.over);
    return 'UNKNOWN';
  }

  if (raw.length > entry.maxSize) {
    work.breach = {
      limit: `collection:${spec.over}`,
      observed: raw.length,
      maximum: entry.maxSize,
    };
    return 'UNKNOWN';
  }

  const itemFields = indexItemFields(entry.itemFields);
  const where = spec.where ?? [];
  let count = 0;

  for (const item of raw) {
    if (work.exceeded) {
      break;
    }
    work.steps += 1;
    if (work.steps > input.maxWorkUnits) {
      work.exceeded = true;
      break;
    }
    if (isFactRecord(item) && itemMatches(where, item, itemFields, input, work)) {
      count += 1;
    }
  }

  if (work.exceeded) {
    return 'UNKNOWN';
  }

  scope.counts.push({ over: spec.over, count });

  const outcome = compareCount(count, spec.op, spec.value);
  recordLeaf(scope, path, outcome);
  return outcome;
}

/**
 * Whether one collection record is counted.
 *
 * @remarks `where` is a **filter list**, so its conditions are joined by conjunction: an item is
 * counted when every listed condition holds. The alternative reading (union) would make a filter
 * that counts almost everything, which contradicts §8.4's purpose of stating a limit precisely.
 * An item that cannot be *proved* to pass is not counted, and its leaf detail is deliberately not
 * mixed into the rule's grounds: the rule's grounds are the count basis and the observed count.
 */
function itemMatches(
  where: readonly RuleConditionNode[],
  item: RuleFactRecord,
  itemFields: RuleFieldIndex,
  input: ConditionEvaluationInput,
  work: WorkState
): boolean {
  if (where.length === 0) {
    return true;
  }

  const itemScope: LeafScope = { failed: [], matched: [], missing: [], counts: [] };
  const itemInput: ConditionEvaluationInput = {
    facts: item,
    fields: itemFields,
    maxWorkUnits: input.maxWorkUnits,
  };

  for (let index = 0; index < where.length; index += 1) {
    const outcome = evaluateNode(where[index], `item[${index}]`, itemInput, work, itemScope);
    if (outcome !== 'TRUE') {
      return false;
    }
  }
  return true;
}
