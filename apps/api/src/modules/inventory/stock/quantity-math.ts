/**
 * Phase W1: exact quantity arithmetic over `Decimal(18,4)` — the same problem
 * `purchase-money.ts` solves for money, for stock quantities. Quantities enter
 * as decimal text with at most four fractional digits; unit ratios carry six.
 * Every result is a STRING in the `Decimal(18,4)` domain — never a float.
 *
 * Implemented as scaled BigInt integers: a value rendered with QTY_SCALE=4
 * digits is an integer in units of 1e-4; a ratio with RATIO_SCALE=6 is an
 * integer in 1e-6; the product (1e-10) is divided back by 1e6 with half-up
 * rounding, which is the ONE rounding rule this module uses.
 */

export const QUANTITY_SCALE = 4;

const QTY_BASE = 10n ** BigInt(QUANTITY_SCALE); // 10_000
const RATIO_SCALE = 6;
const RATIO_BASE = 10n ** BigInt(RATIO_SCALE); // 1_000_000

function parseScaled(text: string, scale: number, label: string): bigint {
  const trimmed = text.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`${label} must be a decimal string, got "${text}"`);
  }
  const frac = (match[3] ?? '').padEnd(scale, '0');
  if (frac.length > scale) {
    throw new Error(`${label} has more than ${scale} fractional digits: "${text}"`);
  }
  const value = BigInt(match[2] + frac);
  return match[1] === '-' ? -value : value;
}

/** Decimal text (≤4 dp) → scaled integer. Throws on a fifth decimal or junk. */
export function quantityToScaled(text: string): bigint {
  return parseScaled(text, QUANTITY_SCALE, 'quantity');
}

/** Ratio text (≤6 dp) → scaled integer. */
export function ratioToScaled(text: string): bigint {
  return parseScaled(text, RATIO_SCALE, 'ratio');
}

/** Scaled integer → `Decimal(18,4)` text (trailing zeros kept, e.g. "1.5000"). */
export function scaledToQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / QTY_BASE;
  const frac = (abs % QTY_BASE).toString().padStart(QUANTITY_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * quantity (4dp) × ratio (6dp) → 4dp, half-up rounding toward +∞ on the
 * magnitude (the sign is carried through intact).
 */
export function multiplyQuantity(quantity: string, ratio: string): string {
  const product = quantityToScaled(quantity) * ratioToScaled(ratio); // 1e-10
  const half = RATIO_BASE / 2n;
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const rounded = (abs + half) / RATIO_BASE; // → 1e-4
  return scaledToQuantity(sign * rounded);
}

export function addQuantity(left: string, right: string): string {
  return scaledToQuantity(quantityToScaled(left) + quantityToScaled(right));
}

export function negateQuantity(value: string): string {
  return scaledToQuantity(-quantityToScaled(value));
}

export function compareQuantity(left: string, right: string): -1 | 0 | 1 {
  const a = quantityToScaled(left);
  const b = quantityToScaled(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isZeroQuantity(value: string): boolean {
  return quantityToScaled(value) === 0n;
}

/** |value| in 4dp text. */
export function absQuantity(value: string): string {
  const v = quantityToScaled(value);
  return scaledToQuantity(v < 0n ? -v : v);
}

/** Number → quantity text. Uses the shortest round-trip decimal the client sent. */
export function quantityFromNumber(value: number): string {
  return scaledToQuantity(quantityToScaled(value.toString()));
}
