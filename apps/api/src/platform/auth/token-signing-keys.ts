import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from 'crypto';
import {
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_ROTATION_OVERLAP_SECONDS,
  TokenPolicyError,
} from './token-contract';

/**
 * Phase 52-ARCH-3C: the signing KEY SET (`JWT_SIGNING_KEYS`), parsed and validated once.
 *
 * WHY A KEY SET IS CONFIGURATION AND NOT A TABLE
 * ----------------------------------------------
 * Rotating a signing key needs exactly one thing from the issuer: the ability to SIGN with
 * one key while still PUBLISHING the previous one until every token minted with it has
 * expired. That is a set of keys plus a designated active member — nothing more. A database
 * registry would add a second, mutable authority inside the process (a row that changes what
 * "the active key" means while requests are in flight), a migration, a permission and an
 * audit action; it would also make "which key signed this?" a question about a row's history
 * rather than about configuration. So the set is read from this process's own configuration
 * at boot and is immutable for the life of the process: the active key cannot change under a
 * running instance, and rotation is therefore a deployment/secret-management act — add the
 * new key, designate it, restart, wait out the overlap, remove the old key.
 *
 * WHY EACH ENTRY CARRIES AN ACTIVATION WINDOW
 * -------------------------------------------
 * The overlap is not a note in a runbook, it is a value this file checks: for every key that
 * is still accepted, `retireAt` must be at least `TOKEN_ROTATION_OVERLAP_SECONDS` (15
 * minutes, §B8) after its successor became active. Retiring a key earlier than that is
 * refused at boot, because the floor is derived from this platform's own numbers
 * (`DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS` plus the verifier's JWKS cache TTL ≈ 600s) and a
 * shorter window would leave verifiers holding tokens that name a key nobody publishes any
 * more. A LONGER window is allowed. Retirement is then ENFORCED rather than trusted: a key
 * past its `retireAt` is neither published nor accepted (`isRetired`), so a forgotten entry
 * ages out by itself instead of leaving a verification path open forever.
 *
 * WHAT IS REFUSED HERE
 * --------------------
 *   * a key set that is not JSON, not an array, or empty;
 *   * an entry that is not an object, carries a field nothing reads, has no `kid`, or reuses
 *     one already given (tokens are addressed BY kid, so a duplicate makes that ambiguous);
 *   * private material in `publicKey`, or material that is not a PEM of the kind its field
 *     promises;
 *   * a key that is not RSA, or is RSA below 2048 bits (ADR-0006 §B2);
 *   * a `publicKey` that is not the public half of the `privateKey` beside it — the one
 *     mistake that is invisible in a config diff and would otherwise surface as a
 *     fleet-wide `signature-invalid`;
 *   * a timestamp that is not an ISO-8601 instant, or a `retireAt` at or before its own
 *     `activatedAt`;
 *   * a `retireAt` on the ACTIVE key: a signer with an end date stops being able to mint
 *     when the window closes. Retirement is expressed by naming a successor and giving the
 *     OLD key a `retireAt`, which is the §B8 sequence exactly;
 *   * a non-active key with no `retireAt` at all (an unbounded acceptance window).
 *
 * KEY MATERIAL NEVER REACHES A MESSAGE
 * ------------------------------------
 * Every refusal below names an INDEX, a FIELD and — at most — a bounded `kid`. A
 * configuration error is written to a boot log that is shipped, indexed and read by people
 * who are not operators of this secret; echoing the offending value would make the failure
 * louder by publishing the key.
 */

/** One entry of the signing key set, with everything derived from it held beside it. */
export interface TokenSigningKey {
  readonly kid: string;
  /** The public half as PEM: the configured one, or derived from the private half. */
  readonly publicPem: string;
  /** The private half, or null for a verification-only entry. */
  readonly privatePem: string | null;
  /** When this key became the active signer. */
  readonly activatedAtMs: number | null;
  /** When this key stops being published and accepted. */
  readonly retireAtMs: number | null;
  /** Position in `JWT_SIGNING_KEYS`, so a refusal can identify an entry without echoing it. */
  readonly index: number;
}

/** The public projection of one key: a JWKS entry, and nothing else. */
export interface PublishedJsonWebKey {
  readonly kty: 'RSA';
  readonly use: 'sig';
  readonly alg: string;
  readonly kid: string;
  readonly n: string;
  readonly e: string;
}

/** ADR-0006 §B2: "RS256 (≥2048-bit)". Anything smaller is not a key this platform accepts. */
export const MIN_RSA_MODULUS_BITS = 2048;

/**
 * The fields one `JWT_SIGNING_KEYS` entry may carry.
 *
 * Closed on purpose: a misspelled field (`private_key`, `retire`) would otherwise be ignored
 * and the entry would be silently weaker than the operator believes — a key that never
 * retires, or a verification-only entry where a signing key was intended.
 */
export const SIGNING_KEY_FIELDS = [
  'kid',
  'publicKey',
  'privateKey',
  'activatedAt',
  'retireAt',
] as const;

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;
const PUBLIC_KEY_PATTERN = /-----BEGIN (?:RSA )?PUBLIC KEY-----|-----BEGIN CERTIFICATE-----/;

/** Bound on a `kid`. It reaches a token header, the JWKS document and a log line. */
const MAX_KID_LENGTH = 128;

/** `kid` is an identifier: the charset rule permission names use, for the same log-safety reason. */
const KID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Parses `JWT_SIGNING_KEYS` into the set this process signs and verifies with.
 *
 * An unset variable is an EMPTY set, not an error: a deployment that configures no key set
 * behaves exactly as it did before this phase (`TokenPolicy`). A set that IS given is
 * expected to be complete and coherent, so every refusal below happens at boot rather than at
 * the first token that needs the missing key.
 */
export function parseSigningKeys(raw: string | undefined): TokenSigningKey[] {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new TokenPolicyError(
      `JWT_SIGNING_KEYS is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'It must be a JSON array of key entries, e.g. ' +
        '[{"kid":"2026-09","privateKey":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"}]; ' +
        'a newline inside a PEM is written as \\n.'
    );
  }

  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new TokenPolicyError(
      'JWT_SIGNING_KEYS must be a non-empty JSON array of key entries. Leave the variable unset to stay on the shared secret, or list at least one key.'
    );
  }

  const keys: TokenSigningKey[] = [];
  const kids = new Set<string>();

  decoded.forEach((entry, index) => {
    const key = parseSigningKey(entry, index);

    if (kids.has(key.kid)) {
      throw new TokenPolicyError(
        `JWT_SIGNING_KEYS names kid=${JSON.stringify(key.kid)} more than once. Tokens are verified BY kid, so a duplicated kid leaves "which key signed this?" with two answers.`
      );
    }

    kids.add(key.kid);
    keys.push(key);
  });

  return keys;
}

/** One entry: shape, material, key size, pair consistency and timestamps. */
function parseSigningKey(entry: unknown, index: number): TokenSigningKey {
  const where = `JWT_SIGNING_KEYS[${index}]`;

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TokenPolicyError(
      `${where} must be an object with a "kid" and at least one of "publicKey"/"privateKey".`
    );
  }

  const record = entry as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (field) => !(SIGNING_KEY_FIELDS as readonly string[]).includes(field)
  );

  if (unknownFields.length > 0) {
    throw new TokenPolicyError(
      `${where} carries unknown field(s) ${unknownFields.map((field) => JSON.stringify(field)).join(', ')}. ` +
        `This platform reads exactly ${SIGNING_KEY_FIELDS.map((field) => JSON.stringify(field)).join(', ')}; a field nothing reads is a field an operator believes is protecting something.`
    );
  }

  const kid = requireKid(record.kid, where);
  const publicPemRaw = optionalText(record.publicKey);
  const privatePemRaw = optionalText(record.privateKey);

  if (publicPemRaw && PRIVATE_KEY_PATTERN.test(publicPemRaw)) {
    throw new TokenPolicyError(
      `${where}.publicKey contains PRIVATE key material. A verification key must be public; a verifier that holds the signing key has signing authority.`
    );
  }

  if (publicPemRaw && !PUBLIC_KEY_PATTERN.test(publicPemRaw)) {
    throw new TokenPolicyError(
      `${where}.publicKey must be a PEM-encoded public key or certificate.`
    );
  }

  if (privatePemRaw && !PRIVATE_KEY_PATTERN.test(privatePemRaw)) {
    throw new TokenPolicyError(`${where}.privateKey must be a PEM-encoded private key.`);
  }

  if (!publicPemRaw && !privatePemRaw) {
    throw new TokenPolicyError(
      `${where} carries neither "publicKey" nor "privateKey". An entry that holds no key can neither sign nor verify.`
    );
  }

  const privateKey = privatePemRaw ? readPrivateKey(privatePemRaw, where) : null;
  const derivedPublicPem = privateKey ? exportSpkiPem(createPublicKey(privateKey)) : null;
  const configuredPublicPem = publicPemRaw ? readPublicPem(publicPemRaw, where) : null;

  if (configuredPublicPem && derivedPublicPem && configuredPublicPem !== derivedPublicPem) {
    throw new TokenPolicyError(
      `${where}.publicKey is not the public half of ${where}.privateKey. Signing with one key while publishing another is invisible in a configuration diff and surfaces as every verifier reporting "signature-invalid".`
    );
  }

  // The public half is DERIVED when only the private half was given, so a signing entry never
  // publishes a key other than the one it signs with, and an operator never has to keep two
  // copies of the same key in agreement by hand.
  const publicPem = configuredPublicPem ?? derivedPublicPem;

  if (!publicPem) {
    // Unreachable: an entry holding neither half was refused above. Stated so the
    // non-nullness of the value below is a proof rather than an assertion.
    throw new TokenPolicyError(`${where} carries no usable public key.`);
  }

  // Converted HERE, at boot: a key set that cannot produce a JWKS entry fails the boot
  // instead of failing the verifiers that fetch the document.
  toPublishedJwk(kid, publicPem);

  const activatedAtMs = timestamp(record.activatedAt, `${where}.activatedAt`);
  const retireAtMs = timestamp(record.retireAt, `${where}.retireAt`);

  if (activatedAtMs !== null && retireAtMs !== null && retireAtMs <= activatedAtMs) {
    throw new TokenPolicyError(
      `${where}.retireAt must be later than ${where}.activatedAt: a key cannot retire before it was activated.`
    );
  }

  return {
    kid,
    publicPem,
    privatePem: privateKey ? (privatePemRaw ?? null) : null,
    activatedAtMs,
    retireAtMs,
    index,
  };
}

/**
 * The public projection of one key.
 *
 * Only these six values ever leave this process, and they are written out ONE BY ONE rather
 * than by spreading the library's export: a JWK carries whatever the runtime decided to put in
 * it, and a document assembled by spreading publishes whatever a future field smuggles in.
 * `use: 'sig'` and `alg` are stated because a verifier that has to infer either of them is a
 * verifier that may infer wrong.
 */
export function toPublishedJwk(kid: string, publicPem: string): PublishedJsonWebKey {
  let key: KeyObject;

  try {
    key = createPublicKey(publicPem);
  } catch (error) {
    throw new TokenPolicyError(
      `kid=${JSON.stringify(kid)} is not a readable public key (${error instanceof Error ? error.message : String(error)}).`
    );
  }

  assertRsaKeySize(key, `kid=${JSON.stringify(kid)}`);

  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  const modulus = typeof jwk.n === 'string' && jwk.n.length > 0 ? jwk.n : null;
  const exponent = typeof jwk.e === 'string' && jwk.e.length > 0 ? jwk.e : null;

  if (!modulus || !exponent) {
    throw new TokenPolicyError(
      `kid=${JSON.stringify(kid)} could not be exported as an RSA JWK (no modulus/exponent).`
    );
  }

  return {
    kty: 'RSA',
    use: 'sig',
    alg: TOKEN_ASYMMETRIC_ALGORITHM,
    kid,
    n: modulus,
    e: exponent,
  };
}

/**
 * True when `now` is at or past this key's declared retirement.
 *
 * This is the ONLY thing that decides whether a key is still in play, and it is consulted by
 * both halves of the contract — `TokenKeySet` refuses a token signed by a retired key and the
 * JWKS publisher omits it — so "retired" cannot mean one thing to a verifier and another to
 * the document verifiers read.
 */
export function isRetired(key: TokenSigningKey, now: number): boolean {
  return key.retireAtMs !== null && now >= key.retireAtMs;
}

/**
 * The §B8 rotation policy, checked at boot.
 *
 * Three rules, in the order an operator meets them:
 *
 *   1. the ACTIVE key may not carry a `retireAt` — the signer must not have an end date;
 *   2. when this process DESIGNATES a signer, every other key must carry one: a set with an
 *      active member is a rotation in progress, so a predecessor with no end date would stay
 *      published and accepted forever and the rotation would never complete. A
 *      VERIFICATION-ONLY set (no active kid — a business runtime holding the platform's public
 *      keys) is not a rotation and is not given a window it has no use for; a key there that DOES
 *      declare one is still honoured, because `isRetired` reads the declaration either way;
 *   3. for every key that is still inside its window (`retireAt` in the future), the span from
 *      its successor's activation to its retirement must be at least
 *      `TOKEN_ROTATION_OVERLAP_SECONDS`. A key that has already retired is history, and is not
 *      re-litigated here: it is simply not published and not accepted (`isRetired`).
 *
 * Rule 3 is why the ACTIVE key needs `activatedAt` as soon as it has a predecessor: without it
 * the window cannot be measured, and "we waited long enough" would be an assumption rather than
 * a checked value.
 */
export function assertRotationOverlap(
  keys: readonly TokenSigningKey[],
  activeKid: string | null,
  now: number = Date.now()
): void {
  if (keys.length === 0) return;

  const active = activeKid === null ? null : (keys.find((key) => key.kid === activeKid) ?? null);

  if (active && active.retireAtMs !== null) {
    throw new TokenPolicyError(
      `JWT_SIGNING_KEYS names kid=${JSON.stringify(active.kid)} as the active signing key and also gives it a retireAt. A signer with an end date would stop being able to mint the moment the window closed; retirement is expressed by making a successor active and giving the OLD key a retireAt.`
    );
  }

  for (const key of keys) {
    if (active && key.kid === active.kid) continue;

    if (active && key.retireAtMs === null) {
      throw new TokenPolicyError(
        `JWT_SIGNING_KEYS[${key.index}] (kid=${JSON.stringify(key.kid)}) is not the active key and declares no retireAt. A key set with an active signer is a rotation in progress, and a verification key with no end date stays published and accepted forever — so the rotation would never complete.`
      );
    }

    if (key.retireAtMs === null || key.retireAtMs <= now) continue;

    const reference = active?.activatedAtMs ?? key.activatedAtMs;

    if (reference === null) {
      throw new TokenPolicyError(
        `JWT_SIGNING_KEYS[${key.index}] (kid=${JSON.stringify(key.kid)}) is still inside its rotation window, but no activation timestamp is declared for the active key${active ? ` (kid=${JSON.stringify(active.kid)})` : ''}. Add "activatedAt" so the ${TOKEN_ROTATION_OVERLAP_SECONDS}s overlap is checked rather than assumed.`
      );
    }

    const overlapSeconds = Math.floor((key.retireAtMs - reference) / 1000);

    if (overlapSeconds < TOKEN_ROTATION_OVERLAP_SECONDS) {
      throw new TokenPolicyError(
        `JWT_SIGNING_KEYS[${key.index}] (kid=${JSON.stringify(key.kid)}) retires ${overlapSeconds}s after the active key was activated, and this platform's rotation policy requires at least ${TOKEN_ROTATION_OVERLAP_SECONDS}s (${TOKEN_ROTATION_OVERLAP_SECONDS / 60} minutes). Verifiers here accept a token for up to ${TOKEN_ROTATION_OVERLAP_SECONDS}s in total, so retiring earlier leaves valid tokens naming a key nobody publishes.`
      );
    }
  }
}

function requireKid(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TokenPolicyError(
      `${where}.kid is required: a token names its key by kid, so a key without one cannot be selected or rotated.`
    );
  }

  const kid = value.trim();

  if (kid.length > MAX_KID_LENGTH) {
    throw new TokenPolicyError(
      `${where}.kid is longer than ${MAX_KID_LENGTH} characters. A kid reaches a token header, a JWKS document and a log line; keep it an identifier.`
    );
  }

  if (!KID_PATTERN.test(kid)) {
    throw new TokenPolicyError(
      `${where}.kid may contain letters, digits and the characters _ . : - only.`
    );
  }

  return kid;
}

/** A blank string is ABSENT, not an empty value: `"privateKey": ""` must not read as a key. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads a configured public key and normalises it, so two spellings compare equal. */
function readPublicPem(pem: string, where: string): string {
  let key: KeyObject;

  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new TokenPolicyError(
      `${where}.publicKey could not be read as a public key (${error instanceof Error ? error.message : String(error)}).`
    );
  }

  assertRsaKeySize(key, `${where}.publicKey`);

  return exportSpkiPem(key);
}

/** Reads a configured private key. The material itself is never echoed on failure. */
function readPrivateKey(pem: string, where: string): KeyObject {
  let key: KeyObject;

  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new TokenPolicyError(
      `${where}.privateKey could not be read as a private key (${error instanceof Error ? error.message : String(error)}).`
    );
  }

  assertRsaKeySize(key, `${where}.privateKey`);

  return key;
}

/** SPKI PEM is the ONE normal form used for comparison, storage and publication. */
function exportSpkiPem(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * ADR-0006 §B2 says RS256 with a key of at least 2048 bits, and this is where a smaller one is
 * refused — at boot, rather than accepted because it happens to parse.
 */
function assertRsaKeySize(key: KeyObject, where: string): void {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new TokenPolicyError(
      `${where} is not an RSA key (${key.asymmetricKeyType ?? 'unknown type'}); this platform signs and verifies RSA only (ADR-0006 §B2).`
    );
  }

  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;

  if (bits < MIN_RSA_MODULUS_BITS) {
    throw new TokenPolicyError(
      `${where} is a ${bits}-bit RSA key; this platform requires at least ${MIN_RSA_MODULUS_BITS} bits (ADR-0006 §B2).`
    );
  }
}

/** An ISO-8601 instant, or null when absent. A value that does not parse is refused. */
function timestamp(value: unknown, where: string): number | null {
  const text = optionalText(value);
  if (text === undefined) return null;

  const parsed = Date.parse(text);

  if (Number.isNaN(parsed)) {
    throw new TokenPolicyError(
      `${where} must be an ISO-8601 timestamp (e.g. 2026-09-20T12:15:00Z); received ${JSON.stringify(text)}.`
    );
  }

  return parsed;
}
