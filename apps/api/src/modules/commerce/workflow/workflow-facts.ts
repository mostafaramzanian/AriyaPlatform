import { RuleFieldCatalogue } from '../../../rules/rule-condition.interface';
import { RuleFactValue } from '../../../rules/rule.types';
import {
  PURCHASE_DOCUMENT_KINDS,
  PURCHASE_LINE_TYPES,
  PurchaseDocumentKind,
  PurchaseLineType,
} from '../purchase/purchase-status';

/**
 * Phase C1 step N (§5.4): the Commerce fact catalogue and the projection that fills it.
 *
 * WHY THIS FILE EXISTS, AND WHERE IT SITS
 * ---------------------------------------
 * The platform Rule Engine is pure and domain-free: it evaluates a version against a
 * context it is HANDED, and it never learns where the facts came from (D12). Something
 * must therefore turn a stored purchase document into the typed facts a configured rule
 * may speak about — and that job belongs to Commerce, not to the engine. This file is
 * that boundary, and it is deliberately a PURE module: no Prisma client, no repository,
 * no gateway, no clock, no environment. It converts a value to a value, which is what
 * makes it exhaustively testable without a database and what keeps the fact vocabulary
 * readable in one place instead of sprayed across the runtime.
 *
 * THE CATALOGUE IS v1 AND FROZEN (§5.4)
 * ------------------------------------
 * NINE facts, and no more: `kind`, `currency`, `supplierId`, `requesterId`,
 * `subtotalAmount`, `taxAmount`, `totalAmount`, `lineCount`, `maxLineTotal`. The list is
 * ALLOWLISTED on purpose. Workflow status, step status, database ids outside the list and
 * arbitrary Prisma columns are NOT facts — and neither is the document's own status,
 * which is a lifecycle, not a business attribute a rule may branch on. A rule that names
 * a fact outside this catalogue is refused by the engine's own validator at publish time
 * (§10) and fails explicitly at evaluation (an undeclared name is a validation error,
 * never a silently-false comparison).
 *
 * The SAME object is handed to the engine at publication and at evaluation, so
 * "publishable" and "evaluable" cannot drift apart — there is exactly one catalogue, and
 * it is this constant.
 *
 * MONEY FAILS CLOSED, IT NEVER ROUNDS (§5.4)
 * ------------------------------------------
 * A `Decimal(18,4)` column is a value the database stores exactly, and a JavaScript
 * `number` is a binary float that can only approximate most decimal fractions. A
 * projection that quietly went through `Number(decimal)` would let a rule compare a
 * number that is not quite the one an approver sees — and a threshold that decides
 * "requires approval: yes/no" on a nearly-equal value is a policy failure nobody can
 * debug from the document. So the conversion below is exact or it is a REFUSAL:
 *
 *   1. the decimal's own digits are scaled to integer minor units at the column's scale
 *      (4 decimal places) — exactly, in `bigint`;
 *   2. a magnitude outside `Number.MAX_SAFE_INTEGER` minor units cannot be represented
 *      without loss and is refused (the contract's bound, applied at the column's scale,
 *      which is stricter than "integer cents");
 *   3. the produced `number`, scaled back, must reproduce the very same bigint — so no
 *      digit of the stored value is lost or altered.
 *
 * A refusal is a NAMED, TYPED error (`CommerceWorkflowFactError`), so the failure is
 * attributable in a test and in a log rather than appearing as a wrong decision. The
 * fact is never omitted and never rounded to "make the evaluation work".
 */

/**
 * The one fact-catalogue error code: a money value that cannot become an exact
 * JavaScript number. Named, because "the projection failed" without naming WHICH fact
 * cannot be audited, tested or explained to the administrator whose rule used it.
 */
export const COMMERCE_WORKFLOW_FACT_ERROR_MONEY_INEXACT = 'WORKFLOW_FACT_MONEY_INEXACT' as const;

export type CommerceWorkflowFactErrorCode = typeof COMMERCE_WORKFLOW_FACT_ERROR_MONEY_INEXACT;

/**
 * A fact projection that refuses rather than guesses.
 *
 * Carries the fact name and the offending text so the message identifies the VALUE, not
 * just the column: two documents can fail for different reasons and the log must say so.
 */
export class CommerceWorkflowFactError extends Error {
  constructor(
    readonly code: CommerceWorkflowFactErrorCode,
    readonly field: string,
    readonly detail: string
  ) {
    super(`${code}: fact "${field}" cannot be projected exactly — ${detail}`);
    this.name = 'CommerceWorkflowFactError';
  }
}

/**
 * A decimal-shaped value, structurally typed.
 *
 * WHY NOT `Prisma.Decimal`: this module is pure and must not import the generated client
 * (the isolation rules keep Prisma types inside the database boundary). Everything the
 * projection needs from a `Decimal` — its exact digit text — is available through
 * `toString()`, which is also what a test double can supply without a database.
 */
export interface CommerceWorkflowDecimalLike {
  toString(): string;
}

/**
 * The document-shaped input of the projection: exactly the columns the nine facts need,
 * and nothing else.
 *
 * WHY THE LINE TOTALS ARRIVE INSTEAD OF THE LINES: the only per-line fact is the maximum
 * priced line total (§5.4's `maxLineTotal`), so the projection takes the totals it
 * aggregates over rather than a row shape it would have to know the columns of — a
 * bounded, already-read array that keeps this module ignorant of the line table.
 */
export interface CommerceWorkflowFactSource {
  readonly kind: PurchaseDocumentKind;
  readonly currency: string | null;
  readonly supplierId: string | null;
  readonly requesterId: string;
  readonly subtotalAmount: CommerceWorkflowDecimalLike | null;
  readonly taxAmount: CommerceWorkflowDecimalLike | null;
  readonly totalAmount: CommerceWorkflowDecimalLike | null;
  /** The priced lines' totals; an unpriced line contributes `null`, never a zero. */
  readonly lineTotals: readonly (CommerceWorkflowDecimalLike | null)[];
}

/** The projected facts, as the engine's context receives them. */
export type CommerceWorkflowFacts = Readonly<Record<string, RuleFactValue>>;

/**
 * The Commerce fact catalogue, v1 — FROZEN (§5.4).
 *
 * The array is `Object.freeze`d because the engine treats the catalogue as data it may
 * only read; freezing makes "someone mutated the catalogue at runtime" impossible rather
 * than merely discouraged. `kind` is the ONLY enum: its members are the document KIND
 * vocabulary itself, imported from the purchase slice's pure status module rather than
 * re-typed here, so the fact cannot claim an enum the database cannot store.
 */
export const COMMERCE_WORKFLOW_FACT_CATALOGUE: RuleFieldCatalogue = Object.freeze([
  { name: 'kind', type: 'enum', enumValues: Object.freeze([...PURCHASE_DOCUMENT_KINDS]) },
  { name: 'currency', type: 'string' },
  { name: 'supplierId', type: 'string' },
  { name: 'requesterId', type: 'string' },
  { name: 'subtotalAmount', type: 'number' },
  { name: 'taxAmount', type: 'number' },
  { name: 'totalAmount', type: 'number' },
  { name: 'lineCount', type: 'number' },
  { name: 'maxLineTotal', type: 'number' },
]) as RuleFieldCatalogue;

/** The scale of the money columns this projection reads (`Decimal(18,4)`). */
const MONEY_SCALE = 4;
const MONEY_SCALE_FACTOR = 10 ** MONEY_SCALE;

/**
 * A plain decimal, and only that: an optional sign, digits, and an optional fraction.
 *
 * WHY THIS IS A REFUSAL AND NOT A PARSE. A value that is not plain decimal text cannot be
 * scaled to minor units without interpretation, and an interpretation is exactly what this
 * module refuses to perform: `1e5`, `NaN`, an empty string and `12,50` are all refused by
 * NAME rather than coerced into a number a rule would then compare.
 */
const MONEY_TEXT_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

/** The magnitude bound, in minor units: beyond it a `number` may not be an integer at all. */
const MAX_SAFE_MONEY_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

/** Refuses, naming the fact and the value. One constructor, so no code path forgets the field. */
function refuseMoneyFact(field: string, detail: string): never {
  throw new CommerceWorkflowFactError(COMMERCE_WORKFLOW_FACT_ERROR_MONEY_INEXACT, field, detail);
}

/**
 * One money column as EXACT integer minor units at the column's scale, or a refusal.
 *
 * The three refusals below are deliberately separate, because they say three different things
 * to whoever reads the failure: the text is not a decimal at all, the text carries precision
 * the column cannot store, or the magnitude exceeds what exact integer arithmetic covers.
 */
function moneyMinorUnits(field: string, text: string): bigint {
  if (!MONEY_TEXT_PATTERN.test(text)) {
    refuseMoneyFact(field, `the stored text ${JSON.stringify(text)} is not a plain decimal`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative || text.startsWith('+') ? text.slice(1) : text;
  const [integerPart, fractionPart = ''] = unsigned.split('.');

  if (fractionPart.length > MONEY_SCALE) {
    refuseMoneyFact(
      field,
      `the stored text ${text} carries more than ${MONEY_SCALE} decimal places, which this column cannot hold`
    );
  }

  const magnitude = BigInt(integerPart + fractionPart.padEnd(MONEY_SCALE, '0'));
  if (magnitude > MAX_SAFE_MONEY_MINOR_UNITS) {
    refuseMoneyFact(
      field,
      `${text} exceeds ${Number.MAX_SAFE_INTEGER} minor units at scale ${MONEY_SCALE}, so no JavaScript number represents it exactly`
    );
  }

  return negative ? -magnitude : magnitude;
}

/**
 * Projects ONE money column, or `null` when the column itself is `null` (`null` is the stored
 * statement "not priced yet", and it stays a fact the rule engine reads as absent).
 *
 * THE THIRD GUARD IS NOT DECORATION. `Number(minor) / 10_000` is the nearest double to the
 * exact quotient, and for a large enough minor value that double does not round-trip: scaling
 * it back does NOT reproduce the same integer, so a digit has been lost. A sweep of the safe
 * range shows this is a real minority of values rather than a theoretical corner, which is why
 * the guard is stated as a test. A refused amount is a NAMED failure; a rounded amount would be
 * a rule deciding "requires approval" from a number nobody entered.
 */
export function projectCommerceWorkflowMoney(
  field: string,
  value: CommerceWorkflowDecimalLike | null
): number | null {
  if (value === null) return null;

  const minor = moneyMinorUnits(field, value.toString());
  const projected = Number(minor) / MONEY_SCALE_FACTOR;
  const restored = Math.round(projected * MONEY_SCALE_FACTOR);

  if (!Number.isSafeInteger(restored) || BigInt(restored) !== minor) {
    refuseMoneyFact(
      field,
      `${value.toString()} cannot be represented exactly as a JavaScript number`
    );
  }

  return projected;
}

/**
 * The nine approved facts, projected from a purchase document (§5.4).
 *
 * THE COUNT IS THE DOCUMENT'S, THE MAXIMUM IS THE PRICED LINES'. `lineCount` counts every line
 * the document states — a rule asking "how many lines" is asking about the document, and an
 * unpriced line is still a line. `maxLineTotal` is the largest PRICED line total, and it is
 * `null` when no line is priced: averaging in a zero for "not priced yet" would make an
 * unpriced document look like a free one, which is the same honesty the document's own totals
 * follow (§5.1). Null is not a failure here — it is the fact's value, and a rule comparing it
 * gets the engine's own UNKNOWN outcome rather than a silently-false comparison.
 */
export function projectCommerceWorkflowFacts(
  source: CommerceWorkflowFactSource
): CommerceWorkflowFacts {
  let maxLineTotal: number | null = null;
  for (const lineTotal of source.lineTotals) {
    const projected = projectCommerceWorkflowMoney('maxLineTotal', lineTotal);
    if (projected !== null && (maxLineTotal === null || projected > maxLineTotal)) {
      maxLineTotal = projected;
    }
  }

  return {
    kind: source.kind,
    currency: source.currency,
    supplierId: source.supplierId,
    requesterId: source.requesterId,
    subtotalAmount: projectCommerceWorkflowMoney('subtotalAmount', source.subtotalAmount),
    taxAmount: projectCommerceWorkflowMoney('taxAmount', source.taxAmount),
    totalAmount: projectCommerceWorkflowMoney('totalAmount', source.totalAmount),
    lineCount: source.lineTotals.length,
    maxLineTotal,
  };
}

/**
 * The line-shaped input of the projection: exactly the columns the approved line facts need.
 *
 * WHY NOT `PurchaseLine`: this module is pure and must not import the generated client. The
 * structural interface lets tests supply doubles and keeps the projection ignorant of the
 * database row shape.
 */
export interface CommerceWorkflowLineFactSource {
  readonly lineType: PurchaseLineType;
  readonly lineNumber: number;
  readonly quantity: CommerceWorkflowDecimalLike;
  readonly unit: string | null;
  readonly unitPrice: CommerceWorkflowDecimalLike | null;
  readonly tax: CommerceWorkflowDecimalLike | null;
  readonly lineTotal: CommerceWorkflowDecimalLike | null;
  readonly itemReference: string | null;
  readonly externalRef: string | null;
  readonly technicalDescription: string | null;
}

/**
 * The Commerce LINE fact catalogue, v1 — FROZEN (§5.15).
 *
 * Each fact is allowlisted. Workflow internals, ids outside the list, arbitrary Prisma columns
 * and unrestricted JSON are NOT facts. The same catalogue is used at publish validation and at
 * evaluation.
 */
export const COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE: RuleFieldCatalogue = Object.freeze([
  { name: 'lineType', type: 'enum', enumValues: Object.freeze([...PURCHASE_LINE_TYPES]) },
  { name: 'lineNumber', type: 'number' },
  { name: 'quantity', type: 'number' },
  { name: 'unit', type: 'string' },
  { name: 'unitPrice', type: 'number' },
  { name: 'tax', type: 'number' },
  { name: 'lineTotal', type: 'number' },
  { name: 'itemReference', type: 'string' },
  { name: 'externalRef', type: 'string' },
  { name: 'technicalDescription', type: 'string' },
]) as RuleFieldCatalogue;

/**
 * The ten approved facts, projected from one PurchaseLine (§5.15).
 *
 * Money columns follow the same exact-or-refuse discipline as the document facts.
 */
export function projectCommerceWorkflowLineFacts(
  source: CommerceWorkflowLineFactSource
): CommerceWorkflowFacts {
  return {
    lineType: source.lineType,
    lineNumber: source.lineNumber,
    quantity: projectCommerceWorkflowMoney('quantity', source.quantity),
    unit: source.unit,
    unitPrice: projectCommerceWorkflowMoney('unitPrice', source.unitPrice),
    tax: projectCommerceWorkflowMoney('tax', source.tax),
    lineTotal: projectCommerceWorkflowMoney('lineTotal', source.lineTotal),
    itemReference: source.itemReference,
    externalRef: source.externalRef,
    technicalDescription: source.technicalDescription,
  };
}
