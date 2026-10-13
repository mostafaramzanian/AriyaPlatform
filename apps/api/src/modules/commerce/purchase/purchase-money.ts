/**
 * Phase C1 Step L: money arithmetic over `Decimal(18,4)`, as PURE, exact,
 * dependency-free functions.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Commerce is where `Decimal(18,4)` first appears in this repository (the schema
 * header records that choice: eighteen digits, four fractional, applied uniformly to
 * every quantity, price, tax and total). A purchase document stores its lines' totals
 * and its own subtotal/tax/total as STORED values, "not a per-read sum" — so something
 * has to compute them once, when the document is written, and that something must
 * produce the same number the database will then hold.
 *
 * WHY NOT JAVASCRIPT NUMBERS
 * --------------------------
 * `0.1 * 3` is `0.30000000000000004`, and `0.1 + 0.2` is `0.30000000000000004` too. A
 * purchase request totalling a fraction of a cent more than the sum of its lines is a
 * wrong stored fact that no read can repair, and the schema has no CHECK that could
 * notice it. Rounding each float operation would fix the visible symptom and leave the
 * rule "which rounding, where" in every caller — which is how two totals computed from
 * the same lines end up disagreeing by a cent.
 *
 * So the arithmetic here is EXACT: every value is parsed from its decimal
 * representation into a scaled `bigint` (four fractional digits), operated on as
 * integers, and rendered back as a STRING in the `Decimal(18,4)` domain. Parsing from
 * the shortest round-trip decimal text (`Number.prototype.toString`) recovers the
 * decimal a client actually sent, which is the whole trick: `0.1` arrives as
 * `"0.1"`, not as the binary double that is a hair away from it.
 *
 * WHY STRINGS ARE THE RESULT, AND WHY THEY GO STRAIGHT TO PRISMA
 * -------------------------------------------------------------
 * The result is the exact decimal text, and Prisma accepts `string` for a `Decimal`
 * column and converts it exactly. Returning a `number` would re-introduce the loss the
 * rest of this file exists to avoid — and it would do it at the boundary, where it is
 * hardest to see. The wire projection keeps the same convention for the same reason:
 * a client reads `"1234.5678"`, and a client that wants a number can parse it.
 *
 * WHAT IS DELIBERATELY ABSENT: no rounding mode configuration (half-up at four
 * decimals, stated once, applied everywhere), no currency, no exchange rate, no tax
 * RATE — this file computes amounts, and §5.2 states that the tax column is an AMOUNT
 * because no rate catalogue exists.
 */

/** The fractional digits of `Decimal(18,4)`, in one place. */
export const PURCHASE_MONEY_SCALE = 4;

/** `Decimal(18,4)`'s precision: eighteen digits in total, four of them fractional. */
export const PURCHASE_MONEY_PRECISION = 18;

const SCALE_FACTOR = 10n ** BigInt(PURCHASE_MONEY_SCALE);
const MAX_SCALED = 10n ** BigInt(PURCHASE_MONEY_PRECISION) - 1n;

/**
 * The largest amount a client may state: the storage domain's maximum INTEGRAL part,
 * `99999999999999`.
 *
 * EXPORTED BECAUSE THE DTO STATES THE SAME BOUND TO A CLIENT (`@Max`): without it, a
 * request no column can store reaches Postgres and returns a driver error — a 500 for a
 * client mistake. Validation and storage agreeing on one number is the point.
 *
 * WHY NOT THE COLUMN'S EXACT MAXIMUM, `99999999999999.9999`, AND NOT `10^14 − 10^-4`
 * --------------------------------------------------------------------------------
 * Neither is a JavaScript number. `10^14 − 10^-4` EVALUATES TO `10^14` in binary (the
 * double nearest that difference is the next representable value up), and the column
 * REFUSES `10^14` — `parseScaled` raises `RangeError` because `10^18` scaled units
 * exceed `10^18 − 1`. A bound written that way would therefore admit, at its own
 * boundary, the one value the storage domain cannot hold, and the refusal would surface
 * as a 500 from the arithmetic instead of a 400 naming the field.
 *
 * So the bound is the largest amount that is BOTH exactly representable as a double and
 * certainly storable: fourteen digits, no fraction. The sliver above it (the nearest
 * double is `99999999999999.984375`) is refused a hair early — the conservative
 * direction, and the only one available to a `number`-typed bound. `parseScaled` stays
 * the backstop for a value that reaches the arithmetic another way.
 */
export const PURCHASE_MAX_MONEY_AMOUNT = 10 ** 14 - 1;

/** Rounds `digits × 10^-scale` to four fractional digits, half-up, as scaled units. */
function roundToScale(digits: bigint, scale: number): bigint {
  if (scale <= PURCHASE_MONEY_SCALE) {
    return digits * 10n ** BigInt(PURCHASE_MONEY_SCALE - scale);
  }

  const drop = 10n ** BigInt(scale - PURCHASE_MONEY_SCALE);
  const quotient = digits / drop;
  const remainder = digits % drop;
  // Half-up on the absolute remainder; `digits` is negative only as a whole.
  return remainder * 2n >= drop ? quotient + 1n : quotient;
}

/**
 * Parses an exact decimal string into scaled units, refusing what cannot be stored.
 *
 * Accepts what `Number.prototype.toString` produces (including exponent notation and a
 * leading sign) and what this file itself emits (`"1234.5678"`), so the two directions
 * cannot disagree about what a valid value looks like. Anything non-finite, malformed
 * or outside `Decimal(18,4)` raises: silently clamping a price to the column's maximum
 * would store a number nobody wrote.
 */
function parseScaled(text: string, label: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match) throw new RangeError(`${label} is not a decimal number: "${text}"`);

  const [, sign, whole, fraction = '', exponent] = match;
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const scale = fraction.length - Number(exponent ?? 0);
  const scaled = roundToScale(BigInt(digits), scale);

  if (scaled > MAX_SCALED) throw new RangeError(`${label} exceeds Decimal(18,4): "${text}"`);
  return sign === '-' ? -scaled : scaled;
}

/** Renders scaled units as the exact `Decimal(18,4)` decimal string. */
function fromScaled(scaled: bigint): string {
  const sign = scaled < 0n ? '-' : '';
  const absolute = scaled < 0n ? -scaled : scaled;
  const whole = absolute / SCALE_FACTOR;
  const fraction = String(absolute % SCALE_FACTOR).padStart(PURCHASE_MONEY_SCALE, '0');
  return `${sign}${whole}.${fraction}`;
}

/** One value a client sent, in the storage domain. */
export function moneyFromNumber(value: number, label = 'amount'): string {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`);
  return fromScaled(parseScaled(value.toString(), label));
}

/**
 * `quantity × unitPrice`, rounded half-up to four decimals.
 *
 * The line total is DERIVED, never accepted from a client: the DTO carries a quantity
 * and a unit price, and a document whose stored `lineTotal` disagreed with its own two
 * numbers would be a fact nobody could read consistently. Computing it here (rather
 * than in the service) keeps the arithmetic and its rounding in one tested place.
 */
export function multiplyMoney(quantity: number, unitPrice: number): string {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
    throw new RangeError('money operands must be finite numbers');
  }

  const product =
    parseScaled(quantity.toString(), 'quantity') * parseScaled(unitPrice.toString(), 'unitPrice');
  // Two four-decimal operands multiply to eight fractional digits; the column holds four.
  return fromScaled(roundToScale(product, 2 * PURCHASE_MONEY_SCALE));
}

/** The exact sum of values this module produced, refused if it leaves the column. */
export function sumMoney(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += parseScaled(value, 'amount');

  if (total > MAX_SCALED) throw new RangeError('the money sum exceeds Decimal(18,4)');
  return fromScaled(total);
}

/** `subtotal + tax`, the document's stored total. */
export function addMoney(left: string, right: string): string {
  return sumMoney([left, right]);
}

/**
 * Exact three-way comparison of two `Decimal(18,4)` strings: `-1` when `left < right`,
 * `0` when equal, `1` when `left > right`.
 *
 * ADDED BY STEP Q (contract §3-C): the payment status projection (§5.13) is a set of
 * comparisons over exact money — "paid equals total", "paid exceeds total" — and a
 * comparison re-typed with `Number(a) < Number(b)` beside the projection would put float
 * judgement back into the one place the schema's four decimals are meant to be trusted.
 * Both operands are parsed into the SAME scaled `bigint` domain the rest of this file
 * operates in, so equality is integer equality on the stored representation: `26.25` and
 * `26.2500` are the same amount, and neither can be a hair above the other.
 *
 * Refuses what `parseScaled` refuses (a malformed or unstorable value), never coerces.
 */
export function compareMoney(left: string, right: string): -1 | 0 | 1 {
  const a = parseScaled(left, 'left amount');
  const b = parseScaled(right, 'right amount');
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The exact negation of an amount — the compensating payment row's `amount` (§5.14,
 * contract Q4/§3-D).
 *
 * ADDED BY STEP Q: a correction is a NEW row whose amount is the EXACT negation of the
 * row it reverses, so the pair sums to zero and the projection reflects the reversal
 * immediately. Deriving it here — a pure sign flip of the SAME scaled value — makes the
 * reversal bit-for-bit the original's magnitude, which no client-side arithmetic could
 * promise. It is deliberately NOT exposed as a client-stated field: the service computes
 * it from the stored row, never from a payload.
 *
 * `-0` is normalised to `0.0000` (the negation of a zero payment is still zero, and the
 * column cannot hold a signed zero). Refuses what `parseScaled` refuses.
 */
export function negateMoney(value: string): string {
  const scaled = parseScaled(value, 'amount');
  if (scaled === 0n) return fromScaled(0n);
  return fromScaled(-scaled);
}
