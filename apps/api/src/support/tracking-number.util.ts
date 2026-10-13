import { randomBytes } from 'crypto';

/**
 * Phase 49G: server-generated ticket tracking number.
 *
 * `TK-` + 10 characters drawn from Crockford base32 with `I`, `L`, `O` and `U`
 * removed. Three properties matter and each is deliberate:
 *
 *  - NON-SEQUENTIAL. A counter would leak ticket volume, and would let a caller in
 *    one tenant infer (and probe for) another tenant's tickets by counting. The
 *    value carries no ordering information at all.
 *  - UNGUESSABLE. 32^10 ≈ 1.1e15 possibilities drawn from `crypto.randomBytes`,
 *    not `Math.random`, so a tracking number cannot be brute-forced into a lookup.
 *    Lookup is additionally tenant-scoped, so guessing one is still not enough.
 *  - HUMAN-QUOTABLE. The excluded letters are exactly the ones people confuse with
 *    digits when reading a number aloud or over the phone.
 *
 * Uniqueness is NOT asserted here — it is owned by the `Ticket_trackingNumber_key`
 * UNIQUE index. The caller retries on a unique-violation, which is what makes
 * concurrent creation safe without a lock or a sequence table.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 10;

export const TRACKING_NUMBER_PREFIX = 'TK-';
export const TRACKING_NUMBER_PATTERN = /^TK-[0-9A-Z]{10}$/;

export function generateTrackingNumber(): string {
  // Rejection-free mapping: the alphabet is exactly 32 symbols, so 5 bits map to
  // one character with no modulo bias.
  const bytes = randomBytes(LENGTH);
  let out = '';

  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i] & 31];
  }

  return `${TRACKING_NUMBER_PREFIX}${out}`;
}

/**
 * Normalises a user-typed tracking number for lookup: trimmed, upper-cased and
 * with the prefix supplied when the user omitted it. Returns null when the result
 * still does not match the stored shape, so a malformed value never reaches a
 * query.
 */
export function normalizeTrackingNumber(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().toUpperCase().replace(/\s+/g, '');
  if (trimmed.length === 0) return null;

  const candidate = trimmed.startsWith(TRACKING_NUMBER_PREFIX)
    ? trimmed
    : `${TRACKING_NUMBER_PREFIX}${trimmed}`;

  return TRACKING_NUMBER_PATTERN.test(candidate) ? candidate : null;
}
