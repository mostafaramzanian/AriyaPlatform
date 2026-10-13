import {
  MIN_SECRET_LENGTH,
  SIGNATURE_WINDOW_MS,
  canonicalRequest,
  idempotencyKeyFor,
  signRequest,
  verifySignature,
  type SignatureMaterial,
} from './integration-signature';

/**
 * Phase 49L §16/§17/§18: signing, verification, replay window, idempotency key.
 *
 * WHAT IS ACTUALLY UNDER TEST HERE, as opposed to restated:
 *
 *  - the canonical string is UNAMBIGUOUS. The splicing test below is the reason the
 *    format is length-prefixed at all: it constructs two DIFFERENT requests that a
 *    naive `join(':')` would render identically, and asserts their signatures differ.
 *    A spec that only checked "signing produces a hex string" would pass for a
 *    forgeable format.
 *  - verification is COMPLETE. Every rejection reason is exercised, including the two
 *    that are easy to omit and fatal to omit: an absent signature and a timestamp
 *    outside the window.
 *  - the comparison does not throw on a length mismatch. `timingSafeEqual` raises a
 *    RangeError for unequal buffers, so a forged short signature would produce a 500
 *    instead of a rejection if the length were not checked first.
 *  - the idempotency key is DETERMINISTIC and integration-scoped, which is what makes
 *    the unique index a real duplicate guard rather than a coincidence.
 */

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);

const material = (overrides: Partial<SignatureMaterial> = {}): SignatureMaterial => ({
  method: 'POST',
  path: '/api/v1/integrations/N8N/callback',
  timestamp: '1780000000000',
  eventId: 'evt-1',
  idempotencyKey: 'N8N:evt-1:v1',
  body: '{"eventId":"evt-1"}',
  ...overrides,
});

describe('canonicalRequest', () => {
  it('is stable for identical input', () => {
    expect(canonicalRequest(material())).toBe(canonicalRequest(material()));
  });

  it('length-prefixes every field, so adjacent fields cannot be spliced', () => {
    // THE test that justifies the format. With a plain `join(':')` these two would
    // both render as "...:a:b:..." and one signature would authenticate both.
    const left = canonicalRequest(material({ eventId: 'a:b', idempotencyKey: 'c' }));
    const right = canonicalRequest(material({ eventId: 'a', idempotencyKey: 'b:c' }));

    expect(left).not.toBe(right);
    expect(signRequest(SECRET, material({ eventId: 'a:b', idempotencyKey: 'c' }))).not.toBe(
      signRequest(SECRET, material({ eventId: 'a', idempotencyKey: 'b:c' })),
    );
  });

  it('uppercases the method, so `post` and `POST` sign identically', () => {
    expect(canonicalRequest(material({ method: 'post' }))).toBe(
      canonicalRequest(material({ method: 'POST' })),
    );
  });

  it('commits to the body: a single changed byte changes the canonical string', () => {
    expect(canonicalRequest(material({ body: '{"eventId":"evt-2"}' }))).not.toBe(
      canonicalRequest(material()),
    );
  });

  it('counts BYTES, not characters, when prefixing', () => {
    // A Persian character is multi-byte. If the prefix were `.length` a 1-character
    // 2-byte value and a 2-character 2-byte value would share a prefix.
    const persian = canonicalRequest(material({ eventId: 'ب' }));
    expect(persian.split('\n')[3]).toBe('2:ب');
  });
});

describe('signRequest', () => {
  it('produces a 64-character hex SHA-256 digest', () => {
    expect(signRequest(SECRET, material())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed: a different secret produces a different signature', () => {
    expect(signRequest(SECRET, material())).not.toBe(
      signRequest('b'.repeat(MIN_SECRET_LENGTH), material()),
    );
  });
});

describe('verifySignature', () => {
  const now = 1_780_000_000_000;

  it('accepts a signature it just produced', () => {
    const m = material({ timestamp: String(now) });
    expect(verifySignature(SECRET, m, signRequest(SECRET, m), now)).toEqual({ ok: true });
  });

  it('rejects an absent signature as MISSING, never as a pass', () => {
    const m = material({ timestamp: String(now) });
    expect(verifySignature(SECRET, m, undefined, now)).toEqual({ ok: false, reason: 'MISSING' });
    expect(verifySignature(SECRET, m, '', now)).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('rejects an absent timestamp', () => {
    const m = material({ timestamp: '' });
    expect(verifySignature(SECRET, m, signRequest(SECRET, m), now)).toEqual({
      ok: false,
      reason: 'MISSING',
    });
  });

  it('rejects a non-numeric or non-positive timestamp as MALFORMED', () => {
    for (const timestamp of ['abc', '0', '-1', '1.5', 'NaN']) {
      const m = material({ timestamp });
      expect(verifySignature(SECRET, m, signRequest(SECRET, m), now).reason).toBe('MALFORMED');
    }
  });

  it('rejects a timestamp older than the window (replay of a captured request)', () => {
    const stale = now - SIGNATURE_WINDOW_MS - 1;
    const m = material({ timestamp: String(stale) });

    // The signature is genuinely VALID — this is exactly what a captured-and-replayed
    // request looks like. Only the clock rejects it.
    expect(verifySignature(SECRET, m, signRequest(SECRET, m), now)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects a timestamp too far in the FUTURE, not just the past', () => {
    // A one-sided window would accept a request dated a year ahead, which would then
    // stay replayable for a year.
    const ahead = now + SIGNATURE_WINDOW_MS + 1;
    const m = material({ timestamp: String(ahead) });

    expect(verifySignature(SECRET, m, signRequest(SECRET, m), now).reason).toBe('EXPIRED');
  });

  it('accepts a timestamp exactly at the window edge, in both directions', () => {
    for (const timestamp of [now - SIGNATURE_WINDOW_MS, now + SIGNATURE_WINDOW_MS]) {
      const m = material({ timestamp: String(timestamp) });
      expect(verifySignature(SECRET, m, signRequest(SECRET, m), now).ok).toBe(true);
    }
  });

  it('rejects a signature made with the wrong secret', () => {
    const m = material({ timestamp: String(now) });
    const forged = signRequest('b'.repeat(MIN_SECRET_LENGTH), m);

    expect(verifySignature(SECRET, m, forged, now)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('rejects a signature over a DIFFERENT body — the tamper case', () => {
    const signed = material({ timestamp: String(now), body: '{"status":"COMPLETED"}' });
    const presented = material({ timestamp: String(now), body: '{"status":"FAILED"}' });

    expect(verifySignature(SECRET, presented, signRequest(SECRET, signed), now).reason).toBe(
      'INVALID_SIGNATURE',
    );
  });

  it('rejects a signature over a different eventId or idempotency key', () => {
    const signed = material({ timestamp: String(now) });

    for (const tamper of [{ eventId: 'evt-9' }, { idempotencyKey: 'N8N:evt-9:v1' }]) {
      const presented = material({ timestamp: String(now), ...tamper });
      expect(verifySignature(SECRET, presented, signRequest(SECRET, signed), now).reason).toBe(
        'INVALID_SIGNATURE',
      );
    }
  });

  it('returns false rather than THROWING for a length mismatch', () => {
    // `timingSafeEqual` raises a RangeError on unequal buffers. Without the explicit
    // length check a two-character forged signature would produce a 500 instead of a
    // clean rejection — an availability bug reachable by any unauthenticated caller.
    const m = material({ timestamp: String(now) });

    expect(() => verifySignature(SECRET, m, 'ab', now)).not.toThrow();
    expect(verifySignature(SECRET, m, 'ab', now).reason).toBe('INVALID_SIGNATURE');
    expect(verifySignature(SECRET, m, 'f'.repeat(200), now).reason).toBe('INVALID_SIGNATURE');
  });
});

describe('idempotencyKeyFor', () => {
  it('is `<integration>:<eventId>:v<version>` and deterministic', () => {
    expect(idempotencyKeyFor('N8N', 'evt-1', 1)).toBe('N8N:evt-1:v1');
    expect(idempotencyKeyFor('N8N', 'evt-1', 1)).toBe(idempotencyKeyFor('N8N', 'evt-1', 1));
  });

  it('scopes by integration, so one event fanning out to two targets is two keys', () => {
    expect(idempotencyKeyFor('N8N', 'evt-1', 1)).not.toBe(idempotencyKeyFor('OTHER', 'evt-1', 1));
  });

  it('scopes by version, so a v2 payload is not deduplicated against v1', () => {
    expect(idempotencyKeyFor('N8N', 'evt-1', 1)).not.toBe(idempotencyKeyFor('N8N', 'evt-1', 2));
  });
});

