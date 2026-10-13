import { toPersianDigits } from './calendar-api';

/**
 * PHASE UI-2: exact decimal-string arithmetic for DISPLAY-ONLY derivations.
 *
 * WHY THIS FILE EXISTS. The wire carries money and quantities as exact `Decimal(18,4)`
 * strings, and the UI-2 prompt forbids floating-point business arithmetic. Two display
 * needs are legitimate client-side transformations of AUTHORITATIVE server values:
 *
 *   1. «باقی‌مانده» on the receiving screen = ordered − received (both server-provided);
 *   2. the same subtraction for the return screen's per-receipt-line hint.
 *
 * Both are shown as HINTS. The server re-validates every bound under lock (over-receipt
 * → 409, over-return → 409), and nothing here ever becomes a business verdict or a
 * stored value.
 *
 * HOW IT IS EXACT. The value is parsed into a BigInt count of 1e-4 units (the storage
 * scale), all arithmetic happens on those integers, and the result is rendered back at
 * four decimals — the same model as the API's `purchase-money` module, which is why
 * `1250.0000` minus `1250.0000` is exactly zero and not `-1.1e-13`.
 */

const SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Parses a wire decimal string into its scaled integer, or `null` when unparseable. */
function toScaled(value: string): bigint | null {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > SCALE) {
    // More precision than the wire should ever carry: refuse rather than round silently.
    if (/[1-9]/.test(fraction.slice(SCALE))) return null;
  }

  const paddedFraction = fraction.slice(0, SCALE).padEnd(SCALE, '0');
  const digits = BigInt(whole) * SCALE_FACTOR + BigInt(paddedFraction);
  return sign === '-' ? -digits : digits;
}

/** Renders a scaled integer back as a `Decimal(18,4)`-style string. */
function fromScaled(scaled: bigint): string {
  const sign = scaled < 0n ? '-' : '';
  const absolute = scaled < 0n ? -scaled : scaled;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR).toString().padStart(SCALE, '0');
  return `${sign}${whole.toString()}.${fraction}`;
}

/**
 * `minuend − subtrahend`, exactly. Returns `null` when either value is unparseable, so
 * a caller can render «—» instead of a wrong number.
 */
export function subtractDecimal(minuend: string, subtrahend: string): string | null {
  const left = toScaled(minuend);
  const right = toScaled(subtrahend);
  if (left === null || right === null) return null;
  return fromScaled(left - right);
}

/** Exact comparison: `-1` / `0` / `1`, or `null` when either value is unparseable. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 | null {
  const a = toScaled(left);
  const b = toScaled(right);
  if (a === null || b === null) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The exact sum of a list of wire decimals (display-only projections such as «خالص
 * دریافت‌شدهٔ یک رسید»). `null` — never a half-computed number — when ANY input is
 * unparseable, so a caller renders «—» instead of a plausible lie.
 */
export function sumDecimals(values: readonly string[]): string | null {
  let total = 0n;
  for (const value of values) {
    const scaled = toScaled(value);
    if (scaled === null) return null;
    total += scaled;
  }
  return fromScaled(total);
}

/**
 * A wire decimal as a compact Persian display label: trailing zeros after the decimal
 * point fall away («۴٫۰۰۰۰» → «۴»), the value is NEVER re-rounded, and an unparseable
 * input is returned verbatim (showing the machine value is honest).
 */
export function decimalDisplayLabel(value: string | null): string {
  if (value === null) return '—';
  const scaled = toScaled(value);
  if (scaled === null) return value;

  const formatted = fromScaled(scaled);
  const trimmed = formatted.includes('.')
    ? formatted.replace(/0+$/, '').replace(/\.$/, '')
    : formatted;

  const [whole, fraction] = trimmed.split('.');
  const withGrouping = Number(whole).toLocaleString('en-US', { useGrouping: true });
  const label = fraction ? `${withGrouping}.${fraction}` : withGrouping;
  // Persian numerals, the Persian thousands separator (٬) and decimal separator (٫) —
  // matching what `Intl.NumberFormat('fa-IR')` produces for money elsewhere.
  return toPersianDigits(label).replace(/,/g, '٬').replace(/\./g, '٫');
}
