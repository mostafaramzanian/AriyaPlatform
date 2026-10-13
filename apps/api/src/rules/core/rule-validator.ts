import { RuleAction, RuleNotifyRecipientRole, isRuleActionType } from '../rule-action.interface';
import {
  RuleComparisonOperator,
  RuleCountOperator,
  RuleFieldCatalogue,
  RuleFieldCatalogueEntry,
  RuleFieldDeclaration,
  RuleCollectionFieldDeclaration,
  isCollectionField,
} from '../rule-condition.interface';
import { RuleSpec, RuleSetVersion } from '../rule-spec.interface';
import {
  RuleValidationIssue,
  RuleValidationIssueCode,
  RuleValidationResult,
} from '../rule-validation.interface';
import {
  RuleActionType,
  RuleApproverResolutionReason,
  RuleCountingBasis,
  RuleScalarFieldType,
} from '../rule.types';
import { detectRuleConflicts, ruleOrderingBasisOf } from './rule-conflict';
import { assertNever, buildValidationResult, validationIssue } from './rule-error';
import {
  findUnsafePayload,
  isCalendarDayInRange,
  isIntegerInRange,
  isReservedFieldName,
  isSafeIdentifier,
  matchesScalarFieldType,
} from './rule-facts';
import {
  RULE_ENGINE_SCHEMA_VERSION,
  RULE_LIMITS,
  SUPPORTED_RULE_ENGINE_SCHEMA_VERSIONS,
} from './rule-limits';
import { orderRuleSpecs } from './rule-ordering';

/**
 * The validator: total, typed, and the only gate before execution (§7, §11, §16).
 *
 * Validation is **mandatory and total** before publish (§11): unknown fields, type mismatches,
 * missing versions, non-deterministic ids, unbounded collections and conflicts are all refused.
 * Every finding carries a stable code and a deterministic path, and the report is bounded, so a
 * hostile definition cannot turn a validation response into a payload (§34).
 *
 * The validator is also what makes execution safe by construction: the interpreter in
 * `rule-condition-evaluator.ts` may then assume a validated tree, and its defence-in-depth branch
 * (`UNKNOWN` for anything it cannot interpret) exists only for a version that bypassed this gate.
 */

/** The largest number of findings reported for one definition (§34: bounded response). */
export const RULE_MAX_REPORTED_ISSUES = 256;

/** The operators each declared field type admits (§8.2, §8.3). */
const ALLOWED_OPERATORS: Readonly<Record<RuleScalarFieldType, readonly RuleComparisonOperator[]>> =
  Object.freeze({
    string: ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
    enum: ['equals', 'notEquals', 'in', 'notIn', 'isEmpty', 'isNotEmpty'],
    boolean: ['equals', 'notEquals'],
    number: [
      'equals',
      'notEquals',
      'in',
      'notIn',
      'greaterThan',
      'greaterThanOrEqual',
      'lessThan',
      'lessThanOrEqual',
    ],
    date: [
      'equals',
      'notEquals',
      'in',
      'notIn',
      'greaterThan',
      'greaterThanOrEqual',
      'lessThan',
      'lessThanOrEqual',
      'dateBefore',
      'dateAfter',
      'dateBetween',
      'isEmpty',
      'isNotEmpty',
    ],
  });

const COUNT_OPERATORS: readonly RuleCountOperator[] = Object.freeze([
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);

const RESOLUTION_REASONS: readonly RuleApproverResolutionReason[] = Object.freeze([
  'PRIMARY',
  'SUBSTITUTE',
  'UNAVAILABLE',
]);

const NOTIFY_RECIPIENTS: readonly RuleNotifyRecipientRole[] = Object.freeze([
  'EMPLOYEE',
  'MANAGER',
  'HR_ADMIN',
]);

const COUNTING_BASES: readonly RuleCountingBasis[] = Object.freeze(['REQUEST_COUNT', 'DAY_COUNT']);

/** Collects findings while walking a definition. */
interface CatalogueValidation {
  readonly index: Map<string, RuleFieldCatalogueEntry>;
  readonly collections: Map<string, RuleCollectionFieldDeclaration>;
}

/** All operators of the frozen vocabulary, used to distinguish "unknown" from "not for this type". */
const COMPARISON_OPERATORS: readonly RuleComparisonOperator[] = Object.freeze([
  'equals',
  'notEquals',
  'in',
  'notIn',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'isEmpty',
  'isNotEmpty',
  'dateBefore',
  'dateAfter',
  'dateBetween',
]);

const SCALAR_FIELD_TYPES: readonly RuleScalarFieldType[] = Object.freeze([
  'string',
  'number',
  'boolean',
  'date',
  'enum',
]);

type AddIssue = (code: RuleValidationIssueCode, path: string, message: string) => void;

/** Validates one set version, in full, without executing anything (§7). */
export function validateRuleSetVersion(version: RuleSetVersion): RuleValidationResult {
  const issues: RuleValidationIssue[] = [];
  const add: AddIssue = (code, path, message) => {
    if (issues.length < RULE_MAX_REPORTED_ISSUES) {
      issues.push(validationIssue(code, path, message));
    }
  };

  const ruleSetId = typeof version.ruleSetId === 'string' ? version.ruleSetId : '';
  const versionLabel = typeof version.version === 'string' ? version.version : '';

  validateVersionShape(version, add);
  const catalogue = validateCatalogue(version.fields, add);

  const rules = Array.isArray(version.rules) ? version.rules : [];
  rules.forEach((rule, index) => {
    validateRule(rule, index, catalogue, add);
  });

  const conflicts = detectRuleConflicts(rules);
  const ordered = orderRuleSpecs(rules);

  return buildValidationResult({
    ruleSetId,
    version: versionLabel,
    issues,
    conflicts,
    ruleCount: rules.length,
    ordering: ordered.map((entry) => ruleOrderingBasisOf(entry.rule)),
    specificities: ordered.map((entry) => entry.specificity),
  });
}

/** The version's own shape: schema, identity, derivation and effective dating (§10, §11). */
function validateVersionShape(version: RuleSetVersion, add: AddIssue): void {
  if (!SUPPORTED_RULE_ENGINE_SCHEMA_VERSIONS.includes(version.schemaVersion)) {
    add(
      'SCHEMA_VERSION_UNSUPPORTED',
      'schemaVersion',
      `schemaVersion ${String(version.schemaVersion)} is not supported by this engine (implements ${RULE_ENGINE_SCHEMA_VERSION}; supports ${SUPPORTED_RULE_ENGINE_SCHEMA_VERSIONS.join(', ')})`
    );
  }

  if (!isSafeIdentifier(version.ruleSetId)) {
    add('RULE_SET_ID_INVALID', 'ruleSetId', 'ruleSetId must be a bounded identifier');
  }

  if (!isSafeIdentifier(version.version, RULE_LIMITS.maxVersionLength)) {
    add(
      'RULE_SET_VERSION_INVALID',
      'version',
      'version is required, bounded, and free of spaces or payload shapes (§10.1)'
    );
  }

  const supersedes = version.supersedes ?? null;
  if (
    supersedes !== null &&
    (!isSafeIdentifier(supersedes, RULE_LIMITS.maxVersionLength) || supersedes === version.version)
  ) {
    add(
      'RULE_SET_VERSION_SUPERSEDES_INVALID',
      'supersedes',
      'supersedes must be a bounded identifier naming a different version (§10.2)'
    );
  }

  const from = version.effectiveFrom ?? null;
  const to = version.effectiveTo ?? null;
  if (from !== null && !isCalendarDayInRange(from)) {
    add(
      'EFFECTIVE_RANGE_INVALID',
      'effectiveFrom',
      'effectiveFrom must be a calendar day (YYYY-MM-DD)'
    );
  }
  if (to !== null && !isCalendarDayInRange(to)) {
    add(
      'EFFECTIVE_RANGE_INVALID',
      'effectiveTo',
      'effectiveTo must be a calendar day (YYYY-MM-DD)'
    );
  }
  if (
    from !== null &&
    to !== null &&
    isCalendarDayInRange(from) &&
    isCalendarDayInRange(to) &&
    from > to
  ) {
    add('EFFECTIVE_RANGE_INVALID', 'effectiveFrom', 'effectiveFrom must not be after effectiveTo');
  }

  if (!Array.isArray(version.rules)) {
    add('RULE_SET_VERSION_INVALID', 'rules', 'rules must be an array');
    return;
  }
  if (version.rules.length > RULE_LIMITS.maxRulesPerSet) {
    add(
      'RULE_COUNT_EXCEEDED',
      'rules',
      `a set version holds at most ${RULE_LIMITS.maxRulesPerSet} rules (found ${version.rules.length})`
    );
  }
}

/** The declared fact catalogue: names, types, enums and collections (§8.3, §8.4). */
function validateCatalogue(fields: RuleFieldCatalogue, add: AddIssue): CatalogueValidation {
  const index = new Map<string, RuleFieldCatalogueEntry>();
  const collections = new Map<string, RuleCollectionFieldDeclaration>();

  if (!Array.isArray(fields)) {
    add('CATALOGUE_FIELD_INVALID', 'fields', 'fields must be an array');
    return { index, collections };
  }

  if (fields.length > RULE_LIMITS.maxCatalogueFields) {
    add(
      'CATALOGUE_FIELD_COUNT_EXCEEDED',
      'fields',
      `a catalogue declares at most ${RULE_LIMITS.maxCatalogueFields} facts (found ${fields.length})`
    );
  }

  fields.forEach((field, position) => {
    const path = `fields[${position}]`;

    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      add('CATALOGUE_FIELD_INVALID', path, 'a field declaration must be an object');
      return;
    }

    if (!isSafeIdentifier(field.name)) {
      const reserved = isReservedFieldName(String(field.name));
      add(
        reserved ? 'RESERVED_FIELD_NAME' : 'CATALOGUE_FIELD_INVALID',
        `${path}.name`,
        reserved
          ? `"${String(field.name)}" may not be used as a fact name`
          : 'a fact name must be a bounded identifier'
      );
      return;
    }

    if (index.has(field.name)) {
      add('DUPLICATE_FIELD_NAME', `${path}.name`, `fact "${field.name}" is declared twice`);
      return;
    }
    index.set(field.name, field);

    if (isCollectionField(field)) {
      collections.set(field.name, field);
      validateCollectionDeclaration(field, path, add);
      return;
    }
    validateScalarDeclaration(field, path, add);
  });

  return { index, collections };
}

/** A scalar declaration: a known type, and `enumValues` exactly when the type is `enum`. */
function validateScalarDeclaration(field: RuleFieldDeclaration, path: string, add: AddIssue): void {
  if (!SCALAR_FIELD_TYPES.includes(field.type)) {
    add(
      'CATALOGUE_FIELD_INVALID',
      `${path}.type`,
      `unknown field type "${String(field.type)}" (expected one of ${SCALAR_FIELD_TYPES.join(', ')})`
    );
    return;
  }

  if (field.type !== 'enum') {
    if (field.enumValues !== undefined) {
      add(
        'ENUM_DECLARATION_INVALID',
        `${path}.enumValues`,
        `enumValues is only allowed for an enum field, not for "${field.type}"`
      );
    }
    return;
  }

  const values = field.enumValues;
  if (!Array.isArray(values) || values.length === 0) {
    add(
      'ENUM_DECLARATION_INVALID',
      `${path}.enumValues`,
      'an enum field must declare a non-empty enumValues list'
    );
    return;
  }
  if (values.length > RULE_LIMITS.maxEnumValues) {
    add(
      'ENUM_DECLARATION_INVALID',
      `${path}.enumValues`,
      `an enum declares at most ${RULE_LIMITS.maxEnumValues} members (found ${values.length})`
    );
    return;
  }
  if (new Set(values).size !== values.length) {
    add('ENUM_DECLARATION_INVALID', `${path}.enumValues`, 'enum members must be unique');
  }

  values.forEach((value, position) => {
    const valuePath = `${path}.enumValues[${position}]`;
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > RULE_LIMITS.maxStringOperandLength
    ) {
      add('ENUM_DECLARATION_INVALID', valuePath, 'an enum member must be a bounded string');
      return;
    }
    const payload = findUnsafePayload(value);
    if (payload !== null) {
      add('UNSAFE_OPERAND', valuePath, `enum member carries a ${payload} payload shape`);
    }
  });
}

/** A collection declaration: a bounded size and a bounded, scalar-only item shape (§8.4). */
function validateCollectionDeclaration(
  field: RuleCollectionFieldDeclaration,
  path: string,
  add: AddIssue
): void {
  if (!isIntegerInRange(field.maxSize, 1, RULE_LIMITS.maxCountCollectionSize)) {
    add(
      'COLLECTION_DECLARATION_INVALID',
      `${path}.maxSize`,
      `maxSize must be an integer between 1 and ${RULE_LIMITS.maxCountCollectionSize} (exceeding it is a context error, never a truncation)`
    );
  }

  const itemFields = field.itemFields;
  if (!Array.isArray(itemFields) || itemFields.length === 0) {
    add(
      'COLLECTION_DECLARATION_INVALID',
      `${path}.itemFields`,
      'a collection must declare a non-empty itemFields list'
    );
    return;
  }
  if (itemFields.length > RULE_LIMITS.maxCollectionItemFields) {
    add(
      'COLLECTION_DECLARATION_INVALID',
      `${path}.itemFields`,
      `a collection item declares at most ${RULE_LIMITS.maxCollectionItemFields} fields (found ${itemFields.length})`
    );
    return;
  }

  const seen = new Set<string>();
  itemFields.forEach((item, position) => {
    const itemPath = `${path}.itemFields[${position}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      add('COLLECTION_DECLARATION_INVALID', itemPath, 'an item field must be an object');
      return;
    }
    if (!isSafeIdentifier(item.name)) {
      const reserved = isReservedFieldName(String(item.name));
      add(
        reserved ? 'RESERVED_FIELD_NAME' : 'COLLECTION_DECLARATION_INVALID',
        `${itemPath}.name`,
        reserved
          ? `"${String(item.name)}" may not be used as an item field name`
          : 'an item field name must be a bounded identifier'
      );
      return;
    }
    if (seen.has(item.name)) {
      add(
        'DUPLICATE_FIELD_NAME',
        `${itemPath}.name`,
        `item field "${item.name}" is declared twice`
      );
      return;
    }
    seen.add(item.name);
    validateScalarDeclaration(item, itemPath, add);
  });
}

/** Counters that make the tree bounds enforceable in one pass (§34). */
interface ConditionWalkCounters {
  nodes: number;
  countNodes: number;
  reportedNodes: boolean;
  reportedDepth: boolean;
  reportedCountNodes: boolean;
}

/** One rule: identity, ranking, condition tree and actions (§7, §8, §9). */
function validateRule(
  rule: RuleSpec,
  position: number,
  catalogue: CatalogueValidation,
  add: AddIssue
): void {
  const path = `rules[${position}]`;

  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    add('RULE_ID_INVALID', path, 'a rule must be an object');
    return;
  }

  if (!isSafeIdentifier(rule.id)) {
    add('RULE_ID_INVALID', `${path}.id`, 'a rule id must be a bounded identifier');
  }
  if (!isSafeIdentifier(rule.version, RULE_LIMITS.maxVersionLength)) {
    add(
      'RULE_VERSION_INVALID',
      `${path}.version`,
      'a rule version label is required and bounded (§10.1)'
    );
  }
  if (typeof rule.name !== 'string' || rule.name.length === 0) {
    add('RULE_NAME_INVALID', `${path}.name`, 'a rule name is required');
  } else if (rule.name.length > RULE_LIMITS.maxRuleNameLength) {
    add(
      'RULE_NAME_INVALID',
      `${path}.name`,
      `a rule name holds at most ${RULE_LIMITS.maxRuleNameLength} characters`
    );
  } else {
    const payload = findUnsafePayload(rule.name);
    if (payload !== null) {
      add('UNSAFE_OPERAND', `${path}.name`, `the rule name carries a ${payload} payload shape`);
    }
  }
  if (!isIntegerInRange(rule.priority, RULE_LIMITS.minPriority, RULE_LIMITS.maxPriority)) {
    add(
      'PRIORITY_INVALID',
      `${path}.priority`,
      `priority must be an integer between ${RULE_LIMITS.minPriority} and ${RULE_LIMITS.maxPriority}`
    );
  }

  const counters: ConditionWalkCounters = {
    nodes: 0,
    countNodes: 0,
    reportedNodes: false,
    reportedDepth: false,
    reportedCountNodes: false,
  };

  if (
    rule.condition === null ||
    typeof rule.condition !== 'object' ||
    Array.isArray(rule.condition)
  ) {
    add('MISSING_CONDITION', `${path}.condition`, 'a rule must declare a condition tree (§8)');
  } else {
    walkCondition(
      rule.condition,
      `${path}.condition`,
      1,
      catalogue.index,
      catalogue.collections,
      add,
      counters
    );
  }

  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    add(
      'MISSING_ACTION',
      `${path}.actions`,
      'a matching rule must produce at least one action (§9)'
    );
  } else {
    if (rule.actions.length > RULE_LIMITS.maxActionsPerRule) {
      add(
        'ACTION_COUNT_EXCEEDED',
        `${path}.actions`,
        `a rule holds at most ${RULE_LIMITS.maxActionsPerRule} actions (found ${rule.actions.length})`
      );
    }
    rule.actions.forEach((action, index) => {
      validateAction(action, `${path}.actions[${index}]`, add);
    });
  }
}

/**
 * Walks one condition node, enforcing the node, depth and aggregate bounds of §34.
 *
 * @remarks The path produced here prefixes the leaf grammar of §13 with the definition location:
 * `rules[2].condition.all[1].field:leaveTypeRef` here is `all[1].field:leaveTypeRef` in a match
 * record. One grammar, two prefixes, so a finding and an explanation name the same leaf.
 */
function walkCondition(
  node: unknown,
  path: string,
  depth: number,
  fields: ReadonlyMap<string, RuleFieldCatalogueEntry>,
  collections: ReadonlyMap<string, RuleCollectionFieldDeclaration>,
  add: AddIssue,
  counters: ConditionWalkCounters
): void {
  counters.nodes += 1;
  if (counters.nodes > RULE_LIMITS.maxConditionsPerRule) {
    if (!counters.reportedNodes) {
      add(
        'CONDITION_COUNT_EXCEEDED',
        path,
        `a rule tree holds at most ${RULE_LIMITS.maxConditionsPerRule} condition nodes`
      );
      counters.reportedNodes = true;
    }
    return;
  }

  if (depth > RULE_LIMITS.maxConditionDepth) {
    if (!counters.reportedDepth) {
      add(
        'CONDITION_DEPTH_EXCEEDED',
        path,
        `a condition tree nests at most ${RULE_LIMITS.maxConditionDepth} levels deep`
      );
      counters.reportedDepth = true;
    }
    return;
  }

  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    add('CONDITION_NODE_INVALID', path, 'a condition node must be an object');
    return;
  }

  const record = node as Record<string, unknown>;
  const known = ['all', 'any', 'not', 'count', 'field', 'op', 'value'];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      add(
        'UNKNOWN_CONDITION_KEY',
        `${path}.${key}`,
        `"${key}" is not part of the frozen condition model (§8.1): there is no free-form payload`
      );
    }
  }

  if ('all' in record) {
    validateGroup(record.all, 'all', path, depth, fields, collections, add, counters);
    return;
  }
  if ('any' in record) {
    validateGroup(record.any, 'any', path, depth, fields, collections, add, counters);
    return;
  }
  if ('not' in record) {
    if (record.not === null || typeof record.not !== 'object' || Array.isArray(record.not)) {
      add('NOT_ARITY_INVALID', `${path}.not`, 'not requires exactly one condition node');
      return;
    }
    walkCondition(record.not, `${path}.not`, depth + 1, fields, collections, add, counters);
    return;
  }
  if ('count' in record) {
    validateCountNode(record.count, `${path}.count`, depth, collections, add, counters);
    return;
  }
  if ('field' in record) {
    validateComparisonNode(record, path, fields, add);
    return;
  }

  add(
    'CONDITION_NODE_INVALID',
    path,
    'a condition node must be one of: all, any, not, field+op(+value), count (§8.1)'
  );
}

/** `all` / `any`: a non-empty list of child conditions (§12.3 refuses an empty group). */
function validateGroup(
  children: unknown,
  kind: 'all' | 'any',
  path: string,
  depth: number,
  fields: ReadonlyMap<string, RuleFieldCatalogueEntry>,
  collections: ReadonlyMap<string, RuleCollectionFieldDeclaration>,
  add: AddIssue,
  counters: ConditionWalkCounters
): void {
  if (!Array.isArray(children) || children.length === 0) {
    add('EMPTY_GROUP', `${path}.${kind}`, `an "${kind}" group must contain at least one condition`);
    return;
  }
  children.forEach((child, index) => {
    walkCondition(
      child,
      `${path}.${kind}[${index}]`,
      depth + 1,
      fields,
      collections,
      add,
      counters
    );
  });
}

/** A collection fact no `where` filter may reach: item fields are scalar only (§8.4). */
const NO_NESTED_COLLECTIONS: ReadonlyMap<string, RuleCollectionFieldDeclaration> = new Map();

/**
 * One action: a known type, typed parameters, and nothing else (§9).
 *
 * @remarks Unknown action types are refused at publish time, never a runtime no-op (§9.6), and an
 * undeclared parameter is refused rather than ignored (§9.3: there is no `data: any` escape hatch).
 * The engine only ever *produces* these values; an application layer applies them (D12).
 */
function validateAction(action: RuleAction, path: string, add: AddIssue): void {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    add('ACTION_TYPE_UNKNOWN', path, 'an action must be an object');
    return;
  }

  if (!isRuleActionType(action.type)) {
    add(
      'ACTION_TYPE_UNKNOWN',
      `${path}.type`,
      `"${String(action.type)}" is not an action type of this engine (§9.6)`
    );
    return;
  }

  const record = action as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedActionKeys(action.type).includes(key)) {
      add(
        'UNKNOWN_ACTION_PARAMETER',
        `${path}.${key}`,
        `"${key}" is not a parameter of ${action.type} (§9.3)`
      );
    }
  }

  const actionType = action.type;
  switch (actionType) {
    case 'REQUIRED_APPROVAL_STEP':
      validateStepOrder(record.stepOrder, `${path}.stepOrder`, actionType, add);
      validateActionIdentifier(record.approverRuleRef, `${path}.approverRuleRef`, actionType, add);
      return;

    case 'AUTO_APPROVE':
      return;

    case 'AUTO_REJECT':
      validateActionIdentifier(record.reasonCode, `${path}.reasonCode`, actionType, add);
      return;

    case 'LIMIT_REFUSAL': {
      validateActionIdentifier(record.limitRef, `${path}.limitRef`, actionType, add);
      if (
        typeof record.countingBasis !== 'string' ||
        !COUNTING_BASES.includes(record.countingBasis as RuleCountingBasis)
      ) {
        add(
          'ACTION_PARAMETER_INVALID',
          `${path}.countingBasis`,
          `countingBasis is mandatory and must be one of: ${COUNTING_BASES.join(', ')} (§16.1: a maximum is never interpreted without its basis)`
        );
      }
      if (
        !isIntegerInRange(record.maximum, RULE_LIMITS.minLimitMaximum, RULE_LIMITS.maxLimitMaximum)
      ) {
        add(
          'ACTION_PARAMETER_INVALID',
          `${path}.maximum`,
          `maximum must be an integer between ${RULE_LIMITS.minLimitMaximum} and ${RULE_LIMITS.maxLimitMaximum}`
        );
      }
      const startValid = validateActionDay(
        record.windowStart,
        `${path}.windowStart`,
        actionType,
        add
      );
      const endValid = validateActionDay(record.windowEnd, `${path}.windowEnd`, actionType, add);
      if (startValid && endValid && (record.windowStart as string) > (record.windowEnd as string)) {
        add(
          'ACTION_PARAMETER_INVALID',
          `${path}.windowStart`,
          'windowStart must not be after windowEnd (§16: the window is resolved by the domain layer)'
        );
      }
      return;
    }

    case 'STEP_ACTIVATION':
      validateStepOrder(record.stepOrder, `${path}.stepOrder`, actionType, add);
      return;

    case 'APPROVER_RESOLUTION':
      validateActionIdentifier(record.approverRuleRef, `${path}.approverRuleRef`, actionType, add);
      if (
        typeof record.resolutionReason !== 'string' ||
        !RESOLUTION_REASONS.includes(record.resolutionReason as RuleApproverResolutionReason)
      ) {
        add(
          'ACTION_PARAMETER_INVALID',
          `${path}.resolutionReason`,
          `resolutionReason must be one of: ${RESOLUTION_REASONS.join(', ')} (§17.3: why this approver)`
        );
      }
      return;

    case 'NOTIFY':
      validateActionIdentifier(record.templateRef, `${path}.templateRef`, actionType, add);
      if (
        typeof record.recipientRole !== 'string' ||
        !NOTIFY_RECIPIENTS.includes(record.recipientRole as RuleNotifyRecipientRole)
      ) {
        add(
          'ACTION_PARAMETER_INVALID',
          `${path}.recipientRole`,
          `recipientRole must be one of: ${NOTIFY_RECIPIENTS.join(', ')} (§9.4: declarative only)`
        );
      }
      return;

    default:
      assertNever(actionType, 'unknown action type');
      return;
  }
}

/** The declared parameter keys of each action type — the whitelist that refuses a payload (§9.3). */
function allowedActionKeys(type: RuleActionType): readonly string[] {
  switch (type) {
    case 'REQUIRED_APPROVAL_STEP':
      return ['type', 'stepOrder', 'approverRuleRef'];
    case 'AUTO_APPROVE':
      return ['type'];
    case 'AUTO_REJECT':
      return ['type', 'reasonCode'];
    case 'LIMIT_REFUSAL':
      return ['type', 'limitRef', 'countingBasis', 'maximum', 'windowStart', 'windowEnd'];
    case 'STEP_ACTIVATION':
      return ['type', 'stepOrder'];
    case 'APPROVER_RESOLUTION':
      return ['type', 'approverRuleRef', 'resolutionReason'];
    case 'NOTIFY':
      return ['type', 'templateRef', 'recipientRole'];
    default:
      return assertNever(type, 'unknown action type');
  }
}

/**
 * `{ count: { over, where?, op, value } }` — the §8.4 aggregate.
 *
 * @remarks Inside `where`, only the item's own declared fields are addressable, and a nested
 * collection does not exist (item fields are scalar by declaration), so an aggregate inside a
 * filter fails as an unknown target instead of silently counting nothing.
 */
function validateCountNode(
  count: unknown,
  path: string,
  depth: number,
  collections: ReadonlyMap<string, RuleCollectionFieldDeclaration>,
  add: AddIssue,
  counters: ConditionWalkCounters
): void {
  if (count === null || typeof count !== 'object' || Array.isArray(count)) {
    add('CONDITION_NODE_INVALID', path, 'a count node must be an object');
    return;
  }

  const record = count as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['over', 'where', 'op', 'value'].includes(key)) {
      add('UNKNOWN_CONDITION_KEY', `${path}.${key}`, `"${key}" is not a count parameter (§8.4)`);
    }
  }

  counters.countNodes += 1;
  if (counters.countNodes > RULE_LIMITS.maxCountNodesPerRule) {
    if (!counters.reportedCountNodes) {
      add(
        'COUNT_NODE_COUNT_EXCEEDED',
        path,
        `a rule holds at most ${RULE_LIMITS.maxCountNodesPerRule} count nodes`
      );
      counters.reportedCountNodes = true;
    }
    return;
  }

  const targetName = typeof record.over === 'string' ? record.over : '';
  const target = collections.get(targetName);
  if (target === undefined) {
    add(
      'COUNT_TARGET_INVALID',
      `${path}.over`,
      targetName.length === 0
        ? 'count requires the name of a declared collection fact (§8.4)'
        : `"${targetName}" is not a declared collection fact (§8.4)`
    );
  }

  if (typeof record.op !== 'string' || !COUNT_OPERATORS.includes(record.op as RuleCountOperator)) {
    add(
      'COUNT_OPERATOR_INVALID',
      `${path}.op`,
      `count requires one of: ${COUNT_OPERATORS.join(', ')} (§8.4)`
    );
  }

  if (!isIntegerInRange(record.value, 0, RULE_LIMITS.maxCountOperandValue)) {
    add(
      'COUNT_VALUE_INVALID',
      `${path}.value`,
      `count compares against an integer between 0 and ${RULE_LIMITS.maxCountOperandValue}`
    );
  }

  const where = record.where;
  if (where === undefined) {
    return;
  }
  if (!Array.isArray(where) || where.length === 0) {
    add(
      'CONDITION_NODE_INVALID',
      `${path}.where`,
      'where must be a non-empty array of conditions when present (§8.4)'
    );
    return;
  }
  if (where.length > RULE_LIMITS.maxCountWhereConditions) {
    add(
      'COUNT_WHERE_COUNT_EXCEEDED',
      `${path}.where`,
      `a count filter holds at most ${RULE_LIMITS.maxCountWhereConditions} conditions`
    );
  }

  const itemFields = indexDeclaredItemFields(target);
  where.forEach((child, index) => {
    walkCondition(
      child,
      `${path}.where[${index}]`,
      depth + 1,
      itemFields,
      NO_NESTED_COLLECTIONS,
      add,
      counters
    );
  });
}

/** The addressable facts inside a count filter: the declared item fields of the collection. */
function indexDeclaredItemFields(
  target: RuleCollectionFieldDeclaration | undefined
): Map<string, RuleFieldCatalogueEntry> {
  const index = new Map<string, RuleFieldCatalogueEntry>();
  if (target === undefined || !Array.isArray(target.itemFields)) {
    return index;
  }
  for (const item of target.itemFields) {
    if (
      item !== null &&
      typeof item === 'object' &&
      isSafeIdentifier(item.name) &&
      !index.has(item.name)
    ) {
      index.set(item.name, item);
    }
  }
  return index;
}

/**
 * `{ field, op, value? }` — one leaf comparison (§8.1, §8.2).
 *
 * @remarks The declared type decides which operators are admissible, and a mismatch is refused
 * rather than coerced (§8.3): there is no numeric parsing of a string, no truthiness, and no
 * default when a fact is missing.
 */
function validateComparisonNode(
  record: Record<string, unknown>,
  path: string,
  fields: ReadonlyMap<string, RuleFieldCatalogueEntry>,
  add: AddIssue
): void {
  const fieldName = typeof record.field === 'string' ? record.field : '';
  const entry = fields.get(fieldName);

  if (fieldName.length === 0 || entry === undefined) {
    add(
      'UNKNOWN_FIELD',
      `${path}.field`,
      fieldName.length === 0
        ? 'a comparison requires the name of a declared fact (§8.3)'
        : `"${fieldName}" is not declared by the field catalogue (§8.3): no fallback to undefined and no implicit truthiness`
    );
    return;
  }

  if (isCollectionField(entry)) {
    add(
      'TYPE_MISMATCH',
      `${path}.field`,
      `"${fieldName}" is a collection: it can only be aggregated by a count node (§8.4), never compared`
    );
    return;
  }

  const op = record.op;
  if (typeof op !== 'string' || !COMPARISON_OPERATORS.includes(op as RuleComparisonOperator)) {
    add(
      'UNKNOWN_OPERATOR',
      `${path}.op`,
      `"${String(op)}" is not an operator of this engine (§8.2)`
    );
    return;
  }

  if (!ALLOWED_OPERATORS[entry.type].includes(op as RuleComparisonOperator)) {
    add(
      'TYPE_MISMATCH',
      `${path}.op`,
      `${op} is not defined for a "${entry.type}" field (§8.2, §8.3): refused, never coerced`
    );
    return;
  }

  validateOperand(record, op as RuleComparisonOperator, entry, path, add);
}

/** The operand each operator requires — and the operand each operator forbids (§8.2). */
function validateOperand(
  record: Record<string, unknown>,
  op: RuleComparisonOperator,
  entry: RuleFieldDeclaration,
  path: string,
  add: AddIssue
): void {
  const value = record.value;

  if (op === 'isEmpty' || op === 'isNotEmpty') {
    if (value !== undefined) {
      add('OPERAND_FORBIDDEN', `${path}.value`, `${op} takes no operand`);
    }
    return;
  }

  if (value === undefined) {
    add('OPERAND_REQUIRED', `${path}.value`, `${op} requires an operand`);
    return;
  }

  if (op === 'in' || op === 'notIn') {
    if (!Array.isArray(value) || value.length === 0) {
      add(
        'OPERAND_INVALID',
        `${path}.value`,
        `${op} requires a non-empty array of the field's declared type`
      );
      return;
    }
    if (value.length > RULE_LIMITS.maxEnumOperandValues) {
      add(
        'OPERAND_INVALID',
        `${path}.value`,
        `${op} accepts at most ${RULE_LIMITS.maxEnumOperandValues} members`
      );
      return;
    }
    value.forEach((member, index) => {
      validateLiteral(member, entry, `${path}.value[${index}]`, add);
    });
    return;
  }

  if (op === 'dateBetween') {
    if (!Array.isArray(value) || value.length !== 2) {
      add(
        'OPERAND_INVALID',
        `${path}.value`,
        'dateBetween requires exactly two calendar days [from, to]'
      );
      return;
    }
    const from = value[0];
    const to = value[1];
    if (!isCalendarDayInRange(from) || !isCalendarDayInRange(to)) {
      add(
        'INVALID_DATE',
        `${path}.value`,
        'dateBetween operands must be calendar days (YYYY-MM-DD) inside the supported range'
      );
      return;
    }
    if (from > to) {
      add(
        'INVALID_DATE_RANGE',
        `${path}.value`,
        `dateBetween requires from <= to (received ${from} > ${to}): an empty range is a validation error, never an always-false rule`
      );
    }
    return;
  }

  validateLiteral(value, entry, `${path}.value`, add);
}

/** One operand against one declared type: exact, bounded, and payload-free (§8.3, §20). */
function validateLiteral(
  value: unknown,
  entry: RuleFieldDeclaration,
  path: string,
  add: AddIssue
): void {
  if (Array.isArray(value)) {
    add('OPERAND_INVALID', path, 'a single operand is required here, not an array');
    return;
  }

  if (!matchesScalarFieldType(value, entry.type, entry.enumValues)) {
    if (entry.type === 'date' && typeof value === 'string') {
      add(
        'INVALID_DATE',
        path,
        `"${value}" is not a calendar day (YYYY-MM-DD) inside the supported range`
      );
      return;
    }
    if (entry.type === 'enum' && typeof value === 'string') {
      add(
        'ENUM_VALUE_UNKNOWN',
        path,
        `"${value}" is not a declared member of enum "${entry.name}"`
      );
      return;
    }
    add(
      'TYPE_MISMATCH',
      path,
      `a "${entry.type}" operand is required (received ${typeof value}): the engine never coerces (§8.3)`
    );
    return;
  }

  if (typeof value === 'string') {
    if (value.length > RULE_LIMITS.maxStringOperandLength) {
      add(
        'OPERAND_INVALID',
        path,
        `a string operand holds at most ${RULE_LIMITS.maxStringOperandLength} characters`
      );
      return;
    }
    const payload = findUnsafePayload(value);
    if (payload !== null) {
      add(
        'UNSAFE_OPERAND',
        path,
        `the operand carries a ${payload} payload shape: the engine never executes an operand, and it refuses to carry one either (§20, §32)`
      );
    }
  }
}

/** A named reference or code: opaque, bounded, and never a path or a sentence. */
function validateActionIdentifier(
  value: unknown,
  path: string,
  actionType: RuleActionType,
  add: AddIssue
): void {
  if (!isSafeIdentifier(value)) {
    add('ACTION_PARAMETER_INVALID', path, `${actionType} requires a bounded identifier here`);
  }
}

/** A 1-based step position inside the flow bound (§17, §18). */
function validateStepOrder(
  value: unknown,
  path: string,
  actionType: RuleActionType,
  add: AddIssue
): void {
  if (!isIntegerInRange(value, RULE_LIMITS.minStepOrder, RULE_LIMITS.maxStepOrder)) {
    add(
      'ACTION_PARAMETER_INVALID',
      path,
      `${actionType} requires stepOrder to be an integer between ${RULE_LIMITS.minStepOrder} and ${RULE_LIMITS.maxStepOrder}`
    );
  }
}

/** A resolved inclusive calendar day (the domain layer resolves windows, the engine reads them). */
function validateActionDay(
  value: unknown,
  path: string,
  actionType: RuleActionType,
  add: AddIssue
): boolean {
  if (!isCalendarDayInRange(value)) {
    add(
      'ACTION_PARAMETER_INVALID',
      path,
      `${actionType} requires a calendar day (YYYY-MM-DD) inside the supported range`
    );
    return false;
  }
  return true;
}
