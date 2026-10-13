import {
  RuleCalendarDay,
  RuleFactRecord,
  RuleFactScalar,
  RuleFactValue,
  RuleScalarFieldType,
} from '../rule.types';
import { RULE_LIMITS } from './rule-limits';

/**
 * Fact access and input guards: the one home for the engine's security-relevant primitives (§20,
 * §32, §34).
 *
 * Two independent facts make this engine safe to hand a hostile definition, and both are
 * deliberately visible in one file:
 *
 *  1. **Nothing is executed.** A condition is interpreted data (§8) and an action is a typed
 *     outcome (§9); there is no `eval`, no `new Function`, no template rendering, no SQL, no shell
 *     and no property path. The engine cannot be a code-execution vector because it has no
 *     interpreter for anything but the frozen operator set.
 *  2. **Nothing is trusted by name.** A field is resolved by *exact declared name* against an
 *     own-property read of the supplied facts, and the names that would let a definition reach
 *     `Object.prototype` or a built-in method are refused outright. So a rule cannot address — or
 *     create — anything the catalogue did not declare.
 *
 * The payload scan below is therefore a **second** line of defence, not the mechanism: it stops a
 * definition from *carrying* a script/SQL/template payload that a later renderer might mishandle,
 * even though this engine would only ever compare it as text.
 */

/** Identifiers: ASCII, namespaced with `.`, `:` or `-` (the shape the repository already uses,
 *  e.g. `core.example.auto-approve`). */
export const RULE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Names that are never usable as a field, because reading them would reach the prototype chain or
 * a built-in method rather than a stated fact.
 */
export const RULE_RESERVED_FIELD_NAMES: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
  'hasownproperty',
  'tostring',
  'valueof',
]);

/**
 * Control characters anywhere in authored text are refused: they are invisible to a reader but
 * present in the stored version.
 *
 * @remarks The expression must match control characters, so the lint rule that catches accidental ones
 * is disabled here deliberately.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Payload shapes refused in any authored text (a name, an operand, a reference, a code). */
const UNSAFE_PAYLOAD_PATTERNS: readonly {
  readonly code: string;
  readonly pattern: RegExp;
}[] = Object.freeze([
  { code: 'TEMPLATE_INTERPOLATION', pattern: /\$\{|\{\{|\}\}|<%|%>/ },
  { code: 'MARKUP', pattern: /<\/?[a-z]|javascript:|data:text\/html/i },
  {
    code: 'SQL',
    pattern:
      /\b(select|insert|update|delete|drop|union)\b[\s\S]{0,40}\b(from|table|select|into)\b/i,
  },
  { code: 'SHELL', pattern: /\$\(|;\s*(rm|sh|bash|cmd|powershell)\b/i },
  { code: 'PATH_TRAVERSAL', pattern: /\.\.[\\/]/ },
]);

/** True when `value` is a usable identifier of at most `maxLength` characters (§34). */
export function isSafeIdentifier(
  value: unknown,
  maxLength: number = RULE_LIMITS.maxIdentifierLength
): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    RULE_IDENTIFIER_PATTERN.test(value) &&
    !value.includes('..') &&
    !isReservedFieldName(value)
  );
}

/** True when `name` may not be used as a fact name (compared case-insensitively). */
export function isReservedFieldName(name: string): boolean {
  return RULE_RESERVED_FIELD_NAMES.includes(name.toLowerCase());
}

/**
 * Returns the code of the first payload shape found in `text`, or `null` when the text is inert.
 * Deterministic: the patterns are tried in their declared order.
 */
export function findUnsafePayload(text: string): string | null {
  if (CONTROL_CHARACTERS.test(text)) {
    return 'CONTROL_CHARACTER';
  }
  for (const candidate of UNSAFE_PAYLOAD_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return candidate.code;
    }
  }
  return null;
}

/** True when `text` carries a payload shape (see the file doc). */
export function containsUnsafePayload(text: string): boolean {
  return findUnsafePayload(text) !== null;
}

/** A magnitude check that never coerces: a string is not a number (§8.3). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A bounded integer check. */
export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

/** An own-property test: the engine never reads an inherited member as if it were a fact. */
export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Reads a fact by exact declared name, ignoring anything inherited (§see the file doc). */
export function readOwnFact(
  source: Readonly<Record<string, RuleFactValue>> | undefined,
  name: string
): RuleFactValue | undefined {
  if (!source || !hasOwn(source, name)) {
    return undefined;
  }
  return source[name];
}

/**
 * A calendar day, `YYYY-MM-DD`, with a real day of a real month.
 *
 * @remarks Validated arithmetically, **without** `Date`: the engine performs no calendar
 * arithmetic (§16.2) and must not acquire time-zone or clock behaviour through a parser. A day is
 * compared as text, which is exact and total for this format.
 */
export function isCalendarDay(value: unknown): value is RuleCalendarDay {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInMonth(year, month);
}

/** A calendar day inside the plausible employment range (§34). */
export function isCalendarDayInRange(value: unknown): value is RuleCalendarDay {
  if (!isCalendarDay(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  return year >= RULE_LIMITS.minCalendarYear && year <= RULE_LIMITS.maxCalendarYear;
}

/** An explicit instant, ISO-8601 with a time and zone designator — never a bare day. */
export function isIsoInstant(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= RULE_LIMITS.maxIdentifierLength &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

/**
 * True when `value` is a valid fact value of the declared scalar type.
 *
 * @remarks Exact: a number is never accepted for a `string` field, a numeric string is never
 * accepted for a `number` field, and an `enum` member must be one of the declared members (§8.3).
 */
export function matchesScalarFieldType(
  value: unknown,
  type: RuleScalarFieldType,
  enumValues?: readonly string[]
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isFiniteNumber(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return isCalendarDayInRange(value);
    case 'enum':
      return typeof value === 'string' && Array.isArray(enumValues) && enumValues.includes(value);
    default:
      return false;
  }
}

/**
 * A fact that is *stated*: a scalar, or a collection array. `null` means explicitly absent.
 *
 * @remarks A type predicate, so a caller that has checked it may compare the value without a cast:
 * the engine's narrowing and its runtime check are the same fact, not two parallel opinions.
 */
export function isStatedFact(
  value: RuleFactValue | undefined
): value is RuleFactScalar | readonly RuleFactRecord[] {
  return value !== undefined && value !== null;
}

/**
 * True when the fact is **empty** for `isEmpty` / `isNotEmpty` (§8.2: absence is `null` or a blank
 * string).
 *
 * @remarks A blank string is exactly `''`. Whitespace-only text is *not* blank: normalising it
 * would be an implicit coercion, and the engine performs none (§8.3).
 */
export function isEmptyFact(value: RuleFactValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/** The number of days in a month, arithmetically (§see `isCalendarDay`). */
function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
