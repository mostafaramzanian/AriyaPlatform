import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Phase 49L §16/§17: HMAC request signing and verification.
 *
 * WHY HMAC AND NOT mTLS OR A BEARER TOKEN
 * ---------------------------------------
 * Audited first, as §16 requires. This repository has:
 *  - JWT bearer auth for USERS (`JwtAuthGuard` + passport-jwt) — a user token is
 *    the wrong credential for a machine, and minting a long-lived one for n8n
 *    would create a user-shaped identity with no owner;
 *  - AWS SigV4 for MinIO, i.e. an HMAC-over-canonical-request scheme, which is the
 *    closest existing precedent and the model this file follows;
 *  - NO mTLS anywhere: no client certificate, no CA, no `https.Agent` with `cert`,
 *    nothing in the nginx config that requests one. Introducing mTLS would mean
 *    introducing certificate issuance and rotation infrastructure for one
 *    integration, which §1 forbids as infrastructure creep.
 *
 * So: HMAC-SHA256 over a canonical string, with the shared secret stored encrypted
 * through the SAME `CryptoService` and the SAME `AI_CONFIG_ENCRYPTION_KEY`
 * established in 49J-0. No second secret store (§15), no custom crypto.
 *
 * THE CANONICAL STRING IS EXPLICIT, ORDERED AND LENGTH-DELIMITED
 * -------------------------------------------------------------
 * Concatenating fields with a separator invites a splicing attack: with `:` as the
 * separator, `eventId="a:b"` + `correlationId="c"` produces the same string as
 * `eventId="a"` + `correlationId="b:c"`, so one signature would authenticate two
 * different requests. Every field is therefore emitted as `<byteLength>:<value>`,
 * which is unambiguous regardless of the field contents.
 *
 * THE BODY IS COVERED BY A KEYED DIGEST, NOT BY ITS RAW TEXT. That keeps the
 * canonical string bounded and makes the signature independent of how the body is
 * buffered — while still being a cryptographic commitment to the exact bytes, so a
 * modified payload fails verification.
 */

const ALGORITHM = 'sha256';

/** Header names. Lower-case because Node normalises incoming headers that way. */
export const SIGNATURE_HEADER = 'x-aria-signature';
export const TIMESTAMP_HEADER = 'x-aria-timestamp';
export const EVENT_ID_HEADER = 'x-aria-event-id';
export const INTEGRATION_HEADER = 'x-aria-integration';
export const IDEMPOTENCY_HEADER = 'x-aria-idempotency-key';

/**
 * How far a timestamp may be from now, in either direction (§16: reject expired).
 *
 * FIVE MINUTES, and symmetric on purpose: a one-sided window would reject every
 * request from a caller whose clock is a minute fast, which is the common case in
 * a local Docker setup where the container clock drifts from the host's. Narrow
 * enough that a captured request stops being replayable quickly, wide enough to
 * survive ordinary skew without an NTP dependency.
 */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Minimum accepted secret length. Below this an HMAC key is not a secret. */
export const MIN_SECRET_LENGTH = 32;

export interface SignatureMaterial {
  /** Uppercase HTTP method, e.g. `POST`. */
  method: string;
  /** Path only — no scheme, no host, no query. */
  path: string;
  /** Milliseconds since epoch, as a decimal string. */
  timestamp: string;
  /** The envelope's `eventId`. */
  eventId: string;
  /** The §18 idempotency key. */
  idempotencyKey: string;
  /** The exact serialised body. */
  body: string;
}

/**
 * Builds the canonical string. Length-prefixed and ordered, per the note above.
 *
 * The ORDER is part of the contract: any change here invalidates every signature
 * in flight, so it must never be "tidied".
 */
export function canonicalRequest(material: SignatureMaterial): string {
  const bodyDigest = createHmac(ALGORITHM, 'aria-body-digest')
    .update(material.body, 'utf8')
    .digest('hex');

  const fields = [
    material.method.toUpperCase(),
    material.path,
    material.timestamp,
    material.eventId,
    material.idempotencyKey,
    bodyDigest,
  ];

  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('\n');
}

/** Hex HMAC-SHA256 of the canonical string. */
export function signRequest(secret: string, material: SignatureMaterial): string {
  return createHmac(ALGORITHM, secret).update(canonicalRequest(material), 'utf8').digest('hex');
}

export interface VerificationResult {
  ok: boolean;
  /** Short internal code. Safe to log; never includes the expected signature. */
  reason?: 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'INVALID_SIGNATURE';
}

/**
 * Verifies a presented signature.
 *
 * TIMESTAMP IS CHECKED BEFORE THE SIGNATURE, deliberately: an expired request is
 * rejected without spending an HMAC computation, so a flood of stale requests
 * cannot be used to make this endpoint do work.
 *
 * COMPARISON IS CONSTANT-TIME. `a === b` on hex digests short-circuits at the
 * first differing character, which leaks how much of a guess was correct.
 * `timingSafeEqual` throws on a length mismatch, so length — which is not secret,
 * it is fixed by the algorithm — is checked first and degrades to `false`.
 */
export function verifySignature(
  secret: string,
  material: SignatureMaterial,
  presented: string | undefined,
  now: number = Date.now(),
): VerificationResult {
  if (!presented || !material.timestamp) {
    return { ok: false, reason: 'MISSING' };
  }

  const timestamp = Number(material.timestamp);

  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const expected = Buffer.from(signRequest(secret, material), 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  if (expected.length !== actual.length) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  return timingSafeEqual(expected, actual)
    ? { ok: true }
    : { ok: false, reason: 'INVALID_SIGNATURE' };
}

/**
 * The §18 idempotency key: `<integration>:<eventId>:v<version>`.
 *
 * Deterministic, so the same logical event dispatched twice produces the same key
 * and collides on the unique index instead of inserting a second row. The
 * integration is part of the key because the same domain event legitimately fans
 * out to several targets and each leg tracks its own delivery.
 */
export function idempotencyKeyFor(
  integration: string,
  eventId: string,
  version: number,
): string {
  return `${integration}:${eventId}:v${version}`;
}

