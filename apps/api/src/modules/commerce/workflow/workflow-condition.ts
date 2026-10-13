import {
  findUnsafePayload,
  isCalendarDayInRange,
  isIntegerInRange,
  isSafeIdentifier,
} from '../../../rules/core/rule-facts';
import { RULE_LIMITS } from '../../../rules/core/rule-limits';
import { WORKFLOW_MAX_REPORTED_ISSUES } from './workflow-configuration';
import type { WorkflowConfigurationFinding } from './workflow-configuration';
import type {
  RuleComparisonOperator,
  RuleCountOperator,
} from '../../../rules/rule-condition.interface';

/**
 * Phase C1 Step M (§5.7, §9, §31, gate I20): the CONDITION TREE GRAMMAR of a workflow step's
 * configuration — the platform rule engine's own vocabulary, borrowed and never re-invented.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * -------------------------------------
 * §5.7 requires that workflow conditions "must use a typed declarative representation
 * compatible with the existing Rule Engine vocabulary", that they be "validated on write", and
 * that they be "evaluated only through the existing pure Rule Engine". §31's "one rule engine,
 * not two" is the same requirement as a prohibition, and §9 names `CommerceRuleEngine`, `eval`
 * and `new Function` as the shapes it forbids.
 *
 * So this file walks the tree and READS NOTHING INTO IT: it does not evaluate a condition, does
 * not resolve a field, does not compare an operand, and does not know what an operator MEANS.
 * It answers one question — "is this value a well-formed tree in the frozen grammar?" — and the
 * reason it cannot have grown an interpreter is that it has no way to: no fact source, no
 * context, no clock, no engine.
 *
 * THE VOCABULARY IS IMPORTED, NOT RESTATED
 * ----------------------------------------
 * The node kinds, the operator unions, the operand shapes, the identifier pattern, the
 * calendar-day test, the payload scan and every bound come from `src/rules/**` — the same
 * files the platform engine validates and evaluates with:
 *
 *  * the two operator maps below are keyed by the ENGINE'S TYPES, so a `Record` literal that
 *    missed a member would not compile. That is the opposite of a second vocabulary: it is a
 *    completeness proof against the engine's own union, and it cannot drift silently.
 *  * the node kinds are §8.1's frozen set: `{ all }`, `{ any }`, `{ not }`, `{ field, op,
 *    value }`, `{ count: {...} }`.
 *  * the bounds are `RULE_LIMITS`, the identifiers are `isSafeIdentifier`, the days are
 *    `isCalendarDayInRange` and the payload scan is `findUnsafePayload`. A locally-chosen depth
 *    or operand bound would let a tree Commerce accepts fail the engine's validation later,
 *    which is exactly the drift §5.7's "compatible" forbids.
 *
 * WHAT IT DELIBERATELY CANNOT CHECK, AND WHY THAT IS NOT AN OMISSION
 * -----------------------------------------------------------------
 * The engine's full validation pairs each operator with the DECLARED TYPE of the field it
 * names — and `rule-condition.interface.ts` is explicit that "the field catalogue is owned by
 * the consuming domain and supplied to the engine as data". The catalogue a purchase workflow's
 * conditions are written against arrives with the step that supplies facts, so this walk checks
 * every rule that needs NO catalogue and stops honestly there: the tree's shape, arity and
 * bounds; `field` as an acceptable identifier; `op` as a member of the frozen vocabulary; the
 * OPERAND SHAPE each operator requires (§8.2/§8.3's own table, including `dateBetween`'s
 * `from <= to`); a `count` node's `over`/`where`/`op`/`value` per §8.4; and no payload shape in
 * any operand. Pairing a value with a field's TYPE needs the catalogue and stays the engine's
 * job — at publication of the rule set it owns and at evaluation. A tree this file accepts is a
 * tree the engine's validator CAN accept; it is not a claim that the engine will.
 */

/** The five node kinds of §8.1's frozen set, as the keys a node may state. */
const CONDITION_NODE_KINDS = ['all', 'any', 'not', 'count', 'field'] as const;

type ConditionNodeKind = (typeof CONDITION_NODE_KINDS)[number];

/**
 * The keys each kind may state — and the reason a `field` leaf is spelled FLAT.
 *
 * §8.1's own table (`rule-condition.interface.ts`) names the leaf `{ field, op, value }`: the
 * operator and the operand are stated BESIDE the field rather than nested under it, so a check that
 * allowed a node to state its kind and nothing else would refuse EVERY comparison — including the
 * ones this module exists to accept. The container kinds state their key alone (`count`'s
 * specification is nested UNDER `count`), which is why the allowance is per kind rather than a
 * blanket list of tolerated keys: an `all` node carrying an `op` is still a misspelling.
 */
const CONDITION_NODE_KEYS: Readonly<Record<ConditionNodeKind, readonly string[]>> = Object.freeze({
  all: ['all'],
  any: ['any'],
  not: ['not'],
  count: ['count'],
  field: ['field', 'op', 'value'],
});

/**
 * What each comparison operator requires of `value` — TOTAL over the engine's own union, so a
 * member added there fails to compile here until its operand shape is decided.
 *
 * The four shapes are §8.2's table as `rule-condition.interface.ts` states it: "equals |
 * notEquals → one operand …; in | notIn → a non-empty array …; dateBetween → exactly [from,
 * to] …; isEmpty | isNotEmpty → no operand at all".
 */
type OperandShape = 'FORBIDDEN' | 'REQUIRED' | 'ARRAY' | 'RANGE';

const COMPARISON_OPERAND_SHAPE: Readonly<Record<RuleComparisonOperator, OperandShape>> =
  Object.freeze({
    equals: 'REQUIRED',
    notEquals: 'REQUIRED',
    in: 'ARRAY',
    notIn: 'ARRAY',
    greaterThan: 'REQUIRED',
    greaterThanOrEqual: 'REQUIRED',
    lessThan: 'REQUIRED',
    lessThanOrEqual: 'REQUIRED',
    isEmpty: 'FORBIDDEN',
    isNotEmpty: 'FORBIDDEN',
    dateBefore: 'REQUIRED',
    dateAfter: 'REQUIRED',
    dateBetween: 'RANGE',
  });

/**
 * The four aggregates §8.4 permits, keyed by the engine's own union for the reason above: an
 * unknown `op` must be refused at runtime, and making the members the keys of a total map is
 * what turns "the platform declared a fifth aggregate" into a compile error here rather than a
 * condition Commerce quietly refuses for a field nobody revisited.
 */
const COUNT_OPERATORS: Readonly<Record<RuleCountOperator, true>> = Object.freeze({
  greaterThan: true,
  greaterThanOrEqual: true,
  lessThan: true,
  lessThanOrEqual: true,
});

/**
 * The most values one payload scan visits before it refuses to scan further.
 *
 * A BOUND, NOT A BUSINESS RULE (the same sentence `MAX_PURCHASE_LINES` carries): a step's
 * stated payload is tens of values, and a request carrying thousands is not a configuration.
 * Hitting the bound is REFUSED rather than passed over — a scan that silently stopped would be
 * a security check that a large payload turns off.
 */
const MAX_SCANNED_PAYLOAD_VALUES = 4096;

/** The walk's running state: the findings so far, bounded, and the node count against `RULE_LIMITS`. */
interface WalkState {
  readonly findings: WorkflowConfigurationFinding[];
  readonly maxFindings: number;
  nodes: number;
}

/** Records one finding, or drops it once the report is full (§34: a bounded response). */
function report(state: WalkState, path: string, reason: string): void {
  if (state.findings.length >= state.maxFindings) {
    return;
  }
  state.findings.push({ path, reason });
}

/** A JSON object — never `null`, an array or a scalar. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property test: a stored payload's inherited members are not part of what it states. */
function statesKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** One path segment appended to a prefix — the engine's own `a.b` grammar. */
function joinPath(prefix: string, segment: string): string {
  return prefix ? `${prefix}.${segment}` : segment;
}

/**
 * Walks one node and reports what is wrong with it.
 *
 * `prefix` IS THE PATH SO FAR and it follows the engine's deterministic grammar
 * (`rule-condition.interface.ts`: "path := segment ('.' segment)*" with the segments `all`,
 * `any`, `not`, `field:` name and `count:` over, and "the bracketed index used in a path is the
 * child's declared index"). Following it rather than inventing a second one means a refusal
 * reported here names the SAME location an engine explanation would, so a UI can point at one
 * node using one vocabulary — and `workflow-condition.spec.ts` asserts the shape.
 */
function walkConditionNode(value: unknown, prefix: string, depth: number, state: WalkState): void {
  if (state.findings.length >= state.maxFindings) {
    return;
  }

  state.nodes += 1;
  if (state.nodes > RULE_LIMITS.maxConditionsPerRule) {
    report(
      state,
      prefix,
      `a condition tree holds at most ${RULE_LIMITS.maxConditionsPerRule} nodes (§34's bound)`
    );
    return;
  }

  if (depth > RULE_LIMITS.maxConditionDepth) {
    report(
      state,
      prefix,
      `a condition tree nests at most ${RULE_LIMITS.maxConditionDepth} levels deep`
    );
    return;
  }

  if (!isPlainObject(value)) {
    report(state, prefix, 'a condition node is a JSON object');
    return;
  }

  const stated = CONDITION_NODE_KINDS.filter((kind) => statesKey(value, kind));
  if (stated.length !== 1) {
    report(
      state,
      prefix,
      `a condition node states exactly one of ${CONDITION_NODE_KINDS.join('/')} — this one states ${stated.length}`
    );
    return;
  }

  const kind = stated[0];
  // §8.1 freezes the node shapes, so a key beside the kind is not part of the grammar: it is
  // either a misspelling of the kind or a second, uninterpreted statement.
  const unknownKeys = Object.keys(value).filter((key) => !CONDITION_NODE_KEYS[kind].includes(key));
  if (unknownKeys.length > 0) {
    report(
      state,
      joinPath(prefix, kind),
      `a condition node carries nothing beside its kind — this one also states ${unknownKeys.join(', ')}`
    );
  }

  if (kind === 'all' || kind === 'any') {
    const children = value[kind];
    if (!Array.isArray(children) || children.length === 0) {
      report(state, joinPath(prefix, kind), `${kind} holds a non-empty array of conditions`);
      return;
    }
    children.forEach((child, index) => {
      walkConditionNode(child, joinPath(prefix, `${kind}[${index}]`), depth + 1, state);
    });
    return;
  }

  if (kind === 'not') {
    // §8.1: "not requires exactly one condition node" — an array is the deviation the engine's
    // own validator names explicitly (`NOT_ARITY_INVALID`).
    if (Array.isArray(value.not)) {
      report(state, joinPath(prefix, 'not'), 'not holds ONE condition node, not an array');
      return;
    }
    walkConditionNode(value.not, joinPath(prefix, 'not'), depth + 1, state);
    return;
  }

  if (kind === 'field') {
    describeComparisonNode(value, prefix, state);
    return;
  }

  describeCountNode(value, prefix, depth, state);
}

/** Whether a value is one of the frozen comparison operators. Never coerces. */
function isComparisonOperator(value: unknown): value is RuleComparisonOperator {
  return typeof value === 'string' && statesKey(COMPARISON_OPERAND_SHAPE, value);
}

/** Whether a value is one of the four count aggregates. Never coerces. */
function isCountOperator(value: unknown): value is RuleCountOperator {
  return typeof value === 'string' && statesKey(COUNT_OPERATORS, value);
}

/**
 * One operand value: a string, a finite number or a boolean — the closed union
 * `RuleConditionOperand` declares, minus the two composite shapes an operator decides.
 *
 * The string case is where §20/§32's refusal lands: an operand is DATA and is never executed, so
 * a value carrying a payload shape is refused rather than stored. `findUnsafePayload` is the
 * ENGINE'S own scan, which is what makes "the engine would refuse this too" true rather than
 * assumed. A number must be finite: `NaN`/`Infinity` are not facts a comparison may be made
 * against, which is the position the engine's own `isFiniteNumber` takes.
 */
function describeOperandValue(value: unknown, at: string, state: WalkState): void {
  if (typeof value === 'string') {
    if (value.length > RULE_LIMITS.maxStringOperandLength) {
      report(
        state,
        at,
        `a string operand holds at most ${RULE_LIMITS.maxStringOperandLength} characters`
      );
    }
    const payload = findUnsafePayload(value);
    if (payload) {
      report(
        state,
        at,
        `the operand carries the payload shape ${payload}: this module never executes an operand and refuses to store one either (§20, §32)`
      );
    }
    return;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return;
  }

  if (typeof value === 'boolean') {
    return;
  }

  report(state, at, 'an operand is a string, a finite number or a boolean');
}

/**
 * The operand an operator requires, and the operand it forbids (§8.2/§8.3), in the four shapes
 * `COMPARISON_OPERAND_SHAPE` names.
 *
 * WHAT THIS PREVENTS: a single operand sent where an array belongs is the mistake that would
 * otherwise be discovered by the engine at publication — or, worse, silently read as a
 * one-member list by whoever reads the stored JSON next.
 */
function validateComparisonOperand(
  node: Record<string, unknown>,
  op: RuleComparisonOperator,
  at: string,
  state: WalkState
): void {
  const shape = COMPARISON_OPERAND_SHAPE[op];
  const valueAt = joinPath(at, 'value');
  const stated = statesKey(node, 'value') && node.value !== undefined && node.value !== null;

  if (shape === 'FORBIDDEN') {
    if (stated) {
      report(state, valueAt, `${op} takes no operand`);
    }
    return;
  }

  if (!stated) {
    report(state, valueAt, `${op} requires an operand`);
    return;
  }

  const value = node.value;

  if (shape === 'ARRAY') {
    if (!Array.isArray(value) || value.length === 0) {
      report(state, valueAt, `${op} requires a non-empty array of values`);
      return;
    }
    if (value.length > RULE_LIMITS.maxEnumOperandValues) {
      report(state, valueAt, `${op} accepts at most ${RULE_LIMITS.maxEnumOperandValues} members`);
      return;
    }
    value.forEach((member, index) => {
      describeOperandValue(member, `${valueAt}[${index}]`, state);
    });
    return;
  }

  if (shape === 'RANGE') {
    // §8.2: "dateBetween → exactly [from, to], inclusive, with from <= to" — and an empty range
    // is a validation error rather than an always-false condition, which is the sentence the
    // engine's own validator states about its `dateBetween`.
    if (!Array.isArray(value) || value.length !== 2) {
      report(state, valueAt, 'dateBetween requires exactly two calendar days [from, to]');
      return;
    }
    const [from, to] = value;
    if (!isCalendarDayInRange(from) || !isCalendarDayInRange(to)) {
      report(
        state,
        valueAt,
        'dateBetween operands must be calendar days inside the supported range'
      );
      return;
    }
    if (from > to) {
      report(state, valueAt, `dateBetween requires from <= to (received ${from} > ${to})`);
    }
    return;
  }

  if (Array.isArray(value)) {
    report(state, valueAt, 'a single operand is required here, not an array');
    return;
  }

  describeOperandValue(value, valueAt, state);
}

/** One `{ field, op, value }` leaf: the field NAME, the operator, and the operand's shape. */
function describeComparisonNode(
  node: Record<string, unknown>,
  prefix: string,
  state: WalkState
): void {
  const field = node.field;
  // The engine's OWN test for a readable name (`isSafeIdentifier`): the pattern, the length bound,
  // a `..` path expression and a reserved name in ONE predicate — so a field this module accepts is
  // one the engine could read, rather than one that merely matched a regular expression.
  const named = isSafeIdentifier(field, RULE_LIMITS.maxIdentifierLength);
  // The engine's grammar names a leaf `field:` NAME, so a leaf whose name cannot be read is
  // reported at the `field` segment rather than at a name that does not exist.
  const at = joinPath(prefix, named ? `field:${field}` : 'field');

  if (!named) {
    report(
      state,
      at,
      `field names an identifier of at most ${RULE_LIMITS.maxIdentifierLength} characters (letters, digits, . _ : -), never a path expression`
    );
  }

  const op = node.op;
  if (!isComparisonOperator(op)) {
    report(state, at, 'op is one of the frozen comparison operators, and this is not one of them');
    return;
  }

  validateComparisonOperand(node, op, at, state);
}

/** One `{ count: { over, where?, op, value } }` aggregate (§8.4). */
function describeCountNode(
  node: Record<string, unknown>,
  prefix: string,
  depth: number,
  state: WalkState
): void {
  const spec = node.count;
  if (!isPlainObject(spec)) {
    report(state, joinPath(prefix, 'count'), 'count holds an aggregate specification');
    return;
  }

  const over = spec.over;
  const named = isSafeIdentifier(over, RULE_LIMITS.maxIdentifierLength);
  const at = joinPath(prefix, named ? `count:${over}` : 'count');

  if (!named) {
    report(
      state,
      at,
      `count names the collection it aggregates over — an identifier of at most ${RULE_LIMITS.maxIdentifierLength} characters, never a path expression`
    );
  }

  if (!isCountOperator(spec.op)) {
    report(state, at, 'op is one of the four aggregate comparisons (§8.4)');
  }

  if (!isIntegerInRange(spec.value, 0, RULE_LIMITS.maxCountOperandValue)) {
    report(
      state,
      at,
      `count compares against an integer between 0 and ${RULE_LIMITS.maxCountOperandValue}`
    );
  }

  if (spec.where === undefined) {
    return;
  }

  if (!Array.isArray(spec.where) || spec.where.length === 0) {
    report(state, at, 'where holds a non-empty array of conditions when present');
    return;
  }

  if (spec.where.length > RULE_LIMITS.maxCountWhereConditions) {
    report(state, at, `where holds at most ${RULE_LIMITS.maxCountWhereConditions} conditions`);
    return;
  }

  spec.where.forEach((child, index) => {
    // The per-item conditions live INSIDE the count node, so they continue the same path rather
    // than opening a second grammar (`count:leaveRequests.where[0]…`).
    walkConditionNode(child, joinPath(at, `where[${index}]`), depth + 1, state);
  });
}

/**
 * The condition tree's write-time report, bounded and deterministic.
 *
 * AN EMPTY RESULT MEANS "the tree is well formed in the frozen grammar" AND NOTHING MORE: it is
 * never a claim that the engine will accept the condition against a catalogue that does not exist
 * yet (see the file doc). One finding per defect, in walk order, so a caller that shows only the
 * first still shows a stable one.
 *
 * `null` IS A LEGAL INPUT AND REPORTS NOTHING: §5.7's unconditional step has no condition at all.
 * Whether a step is ALLOWED to be unconditional is decided by `workflow-configuration.ts` from
 * the step's execution mode, not here — this file answers only "given that there is a tree, is it
 * well formed?".
 */
export function describeWorkflowConditionIssues(value: unknown): WorkflowConfigurationFinding[] {
  if (value === undefined || value === null) {
    return [];
  }

  const state: WalkState = {
    findings: [],
    maxFindings: WORKFLOW_MAX_REPORTED_ISSUES,
    nodes: 0,
  };
  walkConditionNode(value, '', 0, state);
  return state.findings;
}

/**
 * The first unsafe payload shape inside a stored JSON payload, with its path — or `null`.
 *
 * WHY IT WALKS RATHER THAN SERIALISING. `findUnsafePayload` takes TEXT, so the obvious
 * implementation is `findUnsafePayload(JSON.stringify(payload))` — which would (a) miss a value
 * that serialises to nothing while still being a function or a prototype, and (b) report a defect
 * at no location. Walking the STRUCTURE and handing each STRING to the platform's own scan keeps
 * the platform's definition of "unsafe" while keeping the coordinate, so a refusal can say which
 * setting carried it.
 *
 * OWN KEYS ONLY, and the three names that could turn a stored value into a behaviour
 * (`__proto__`, `constructor`, `prototype`) are refused rather than traversed: nothing in
 * Commerce merges a stored payload into an object today, and this refuses to be the thing that
 * makes it safe to start doing so tomorrow.
 *
 * EXCEEDING `MAX_SCANNED_PAYLOAD_VALUES` IS A REFUSAL, NOT A PASS: a scan that stopped early
 * would be a check that a large payload turns off.
 */
export function findUnsafeWorkflowPayload(value: unknown): WorkflowConfigurationFinding | null {
  const prototypeKeys = ['__proto__', 'constructor', 'prototype'];
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: '' }];
  let visited = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const slot = pending[index];
    visited += 1;
    if (visited > MAX_SCANNED_PAYLOAD_VALUES) {
      return {
        path: slot.path || 'payload',
        reason: `the payload holds more than ${MAX_SCANNED_PAYLOAD_VALUES} values and is refused rather than scanned partially`,
      };
    }

    if (typeof slot.value === 'string') {
      const payload = findUnsafePayload(slot.value);
      if (payload) {
        return { path: slot.path || 'value', reason: payload };
      }
      continue;
    }

    if (Array.isArray(slot.value)) {
      slot.value.forEach((member, memberIndex) => {
        pending.push({ value: member, path: `${slot.path}[${memberIndex}]` });
      });
      continue;
    }

    if (typeof slot.value === 'object' && slot.value !== null) {
      const record = slot.value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const path = joinPath(slot.path, key);
        if (prototypeKeys.includes(key)) {
          return { path, reason: 'a payload key names a prototype member' };
        }
        pending.push({ value: record[key], path });
      }
    }
  }

  return null;
}
