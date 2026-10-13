import { Logger } from '@nestjs/common';
import { createPublicKey, type JsonWebKey } from 'crypto';
import {
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_LEGACY_ALGORITHM,
  TokenRejectedError,
  type TokenAlgorithm,
  type TokenTrust,
} from './token-contract';
import { TokenPolicy } from './token-policy';
import { isRetired } from './token-signing-keys';

/**
 * Phase 51-HR-ARCH-3A: key selection, and the ONLY place a verification key is chosen.
 *
 * WHAT THIS CLASS GETS TO DECIDE
 * -----------------------------
 * Everything that must happen BEFORE a signature can be checked:
 *
 *   1. which algorithm this token is allowed to use (from configuration, never from
 *      the token's `alg` header — the header is data being validated, not a
 *      decision-maker);
 *   2. which key that algorithm uses, addressed by `kid` for RS256;
 *   3. how a JWKS outage degrades: a cached key is still used, an unknown key with
 *      no cache is refused (ADR-0006 §B: JWKS downtime must not become an outage of
 *      the business runtime, but a key we cannot obtain must never be replaced by a
 *      guess).
 *
 * WHY `kid` IS MANDATORY FOR RS256
 * -------------------------------
 * Key rotation is the point of asymmetric verification. A token that does not name
 * the key it was signed with cannot be verified after a rotation, and accepting one
 * by trying every key in the set is how a verifier ends up accepting a signature
 * made with a retired key. So a missing `kid` is `key-unavailable`, not "try the
 * first key".
 *
 * WHY THE LEGACY SECRET IS READ FROM THE POLICY, NOT FROM `process.env`
 * --------------------------------------------------------------------
 * There is exactly one place in this phase that knows the shared secret, and it is
 * `TokenPolicy`. `TokenVerifier` never sees `JWT_SECRET`: it receives a plan whose
 * `key` is either a public key or the legacy secret for a legacy-trust token. That
 * is what makes "the verifier holds no signing material" a property of the code
 * rather than of a deployment's discipline.
 */

/** What `TokenVerifier` needs in order to check a signature. */
export interface TokenVerificationPlan {
  /** The pinned algorithm. Passed to the library so the header cannot override it. */
  readonly algorithm: TokenAlgorithm;
  /** RSA public key (PEM) for `asymmetric`, the shared secret for `legacy-hmac`. */
  readonly key: string | Buffer;
  /** The `kid` the key was selected by, or null for a legacy token. */
  readonly kid: string | null;
  readonly trust: TokenTrust;
}

/** A JWKS document, as far as this platform cares about it. */
export interface JsonWebKeySetDocument {
  readonly keys?: unknown;
}

/**
 * The `fetch` shape this class uses, declared here rather than relying on a global
 * type, so a spec can inject a plain function without casting.
 */
export type JwksFetchLike = (
  url: string,
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/** How long a fetched JWKS stays authoritative before it is refetched. */
export const JWKS_CACHE_TTL_MS = 300_000;

/** How long a JWKS request may take before the key is treated as unobtainable. */
export const JWKS_FETCH_TIMEOUT_MS = 3_000;

/**
 * Minimum spacing between two JWKS fetches triggered by an unknown `kid`. Without
 * this, a client sending random `kid` values turns every request into an outbound
 * request — the verifier becomes an amplifier aimed at the issuer's JWKS endpoint.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 30_000;

export interface TokenKeySetSnapshot {
  readonly cachedKeys: number;
  readonly lastFetchAtMs: number | null;
  readonly lastFetchError: string | null;
}

export class TokenKeySet {
  private readonly logger = new Logger(TokenKeySet.name);

  /** kid → PEM, with the time it was fetched, so expiry is per-fetch not per-key. */
  private readonly keys = new Map<string, { pem: string; fetchedAtMs: number }>();

  private lastFetchAtMs: number | null = null;
  private lastFetchError: string | null = null;
  private inflightFetch: Promise<void> | null = null;
  private warnedAboutUnpinnedKey = false;
  private warnedAboutStaleCache = false;

  constructor(
    private readonly policy: TokenPolicy,
    private readonly fetchImpl: JwksFetchLike = globalThis.fetch as unknown as JwksFetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Chooses the algorithm and the key for one token header, or refuses.
   *
   * The two branches are mutually exclusive BY CONFIGURATION, which is why this is
   * not a chain of `if`s that can fall through: with asymmetric material configured
   * there is no path that returns an HMAC key, and without it there is no path that
   * returns a public key.
   */
  async planFor(header: {
    readonly alg?: unknown;
    readonly kid?: unknown;
  }): Promise<TokenVerificationPlan> {
    const alg = typeof header?.alg === 'string' ? header.alg : null;
    if (!alg) {
      throw new TokenRejectedError('token-malformed', 'Token header carries no algorithm.');
    }

    const kid =
      typeof header?.kid === 'string' && header.kid.trim().length > 0 ? header.kid.trim() : null;

    if (this.policy.asymmetricEnabled) {
      if (alg !== TOKEN_ASYMMETRIC_ALGORITHM) {
        throw new TokenRejectedError(
          'algorithm-not-accepted',
          `This deployment accepts ${TOKEN_ASYMMETRIC_ALGORITHM} only; the token declares ${JSON.stringify(alg)}.`,
        );
      }

      if (!kid) {
        throw new TokenRejectedError(
          'key-unavailable',
          'Token declares no kid, so no public key can be selected for it.',
        );
      }

      return {
        algorithm: alg,
        key: await this.asymmetricKey(kid),
        kid,
        trust: 'asymmetric',
      };
    }

    if (alg !== TOKEN_LEGACY_ALGORITHM) {
      throw new TokenRejectedError(
        'algorithm-not-accepted',
        `This deployment is on the shared-secret bridge and accepts ${TOKEN_LEGACY_ALGORITHM} only; the token declares ${JSON.stringify(alg)}.`,
      );
    }

    // The secret is checked BEFORE the bridge gate, because the two failures mean different
    // things and the contract names them separately: "no legacy secret configured" is
    // `key-unavailable` (there is no key), while a disabled or sunset bridge is
    // `algorithm-not-accepted` (there IS a key, and this deployment has stopped using it).
    const secret = this.policy.legacyHs256Secret;
    if (!secret) {
      throw new TokenRejectedError('key-unavailable', 'No shared secret is configured.');
    }

    if (!this.policy.legacyAccepted(this.now())) {
      throw new TokenRejectedError(
        'algorithm-not-accepted',
        'Shared-secret tokens are no longer accepted by this deployment (the bridge is disabled or past its sunset).',
      );
    }

    return { algorithm: alg, key: secret, kid: null, trust: 'legacy-hmac' };
  }

  /** The public key for a `kid`: a configured key set, a static PEM, or the JWKS entry it names. */
  private async asymmetricKey(kid: string): Promise<string> {
    // Phase 52-ARCH-3C: a configured KEY SET answers first, and answers completely. Two
    // questions are asked of it — does it hold this kid, and is that key still in play — and
    // both answers are refusals that must not fall through to another key source: an unknown kid
    // has no key here, and a RETIRED kid names a key this deployment has stopped publishing, so
    // accepting it would mean trusting a key after the rotation that retired it.
    if (this.policy.signingKeys.length > 0) {
      const key = this.policy.signingKeys.find((entry) => entry.kid === kid);

      if (!key) {
        throw new TokenRejectedError(
          'key-unavailable',
          `Token names kid=${JSON.stringify(kid)}, which this deployment's key set does not hold (it holds ${this.policy.signingKeys
            .map((entry) => JSON.stringify(entry.kid))
            .join(', ')}).`
        );
      }

      if (isRetired(key, this.now())) {
        throw new TokenRejectedError(
          'key-unavailable',
          `kid=${JSON.stringify(kid)} was retired at ${new Date(key.retireAtMs ?? 0).toISOString()} and is no longer accepted; tokens signed with it must be replaced.`
        );
      }

      return key.publicPem;
    }

    const staticKey = this.policy.asymmetricPublicKey;

    if (staticKey) {
      if (!this.warnedAboutUnpinnedKey && !this.policy.asymmetricKeyId) {
        this.warnedAboutUnpinnedKey = true;
        this.logger.warn(
          'JWT_ASYMMETRIC_PUBLIC_KEY is configured without JWT_ASYMMETRIC_KEY_ID: any kid is accepted with this one key. Set the key id so a rotation cannot leave stale tokens verifiable by accident.',
        );
      }

      if (this.policy.asymmetricKeyId && this.policy.asymmetricKeyId !== kid) {
        throw new TokenRejectedError(
          'key-unavailable',
          `Token names kid=${JSON.stringify(kid)} but this deployment holds kid=${JSON.stringify(this.policy.asymmetricKeyId)}.`,
        );
      }

      return staticKey;
    }

    return this.jwksKey(kid);
  }

  /**
   * The public key for `kid` from the JWKS cache, refetching when it is missing or
   * the cache has expired.
   *
   * DEGRADATION, STATED PLAINLY (ADR-0006 §B / §C2)
   * ----------------------------------------------
   * A JWKS that cannot be reached is an availability problem for the ISSUER's key
   * distribution, not a reason to fail every request in a business runtime that
   * already holds the key it needs. So: a cached key is used past its TTL when a
   * refresh fails, with a warning. Two things are NOT done: an unknown `kid` is never
   * resolved by trying other cached keys, and an empty cache is never resolved by
   * accepting the token unverified. Both are refusals.
   */
  private async jwksKey(kid: string): Promise<string> {
    const cached = this.keys.get(kid);
    const fresh =
      cached !== undefined && this.now() - cached.fetchedAtMs < JWKS_CACHE_TTL_MS;

    if (fresh) return cached.pem;

    const reason = cached ? 'expired-cache' : 'unknown-kid';

    if (
      reason === 'unknown-kid' &&
      this.lastFetchAtMs !== null &&
      this.now() - this.lastFetchAtMs < JWKS_REFRESH_COOLDOWN_MS
    ) {
      // Rate-limited: a client cannot make the verifier query the issuer on demand.
      throw new TokenRejectedError(
        'key-unavailable',
        `kid=${JSON.stringify(kid)} is not in the cached key set and the JWKS endpoint was queried less than ${JWKS_REFRESH_COOLDOWN_MS}ms ago.`,
      );
    }

    try {
      await this.refreshJwks();
    } catch (error) {
      this.lastFetchError = error instanceof Error ? error.message : String(error);

      if (cached) {
        if (!this.warnedAboutStaleCache) {
          this.warnedAboutStaleCache = true;
          this.logger.warn(
            `JWKS refresh failed (${this.lastFetchError}); continuing with the cached key set. Refusal, not degradation, applies to any kid this cache cannot answer.`,
          );
        }
        return cached.pem;
      }

      throw new TokenRejectedError(
        'key-unavailable',
        `kid=${JSON.stringify(kid)} could not be resolved: JWKS refresh failed (${this.lastFetchError}) and no cached key exists.`,
      );
    }

    const resolved = this.keys.get(kid);
    if (!resolved) {
      throw new TokenRejectedError(
        'key-unavailable',
        `kid=${JSON.stringify(kid)} is not present in the issuer's key set.`,
      );
    }

    return resolved.pem;
  }

  /**
   * Fetches and replaces the cached key set.
   *
   * Replacement, not merge: a key the issuer has withdrawn must stop being usable,
   * so a successful refresh is authoritative. That places one obligation on the
   * issuer, stated in the README: a retired key stays in the JWKS for at least
   * `HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS` so the tokens already signed with it (which
   * can be at most that old) have expired before the key disappears.
   *
   * Concurrent callers share one request: a burst of requests with the same unknown
   * `kid` must not become a burst of outbound requests.
   */
  private async refreshJwks(): Promise<void> {
    if (this.inflightFetch) {
      await this.inflightFetch;
      return;
    }

    const fetchPromise = (async () => {
      const document = await this.withTimeout(this.fetchImpl(this.policy.jwksUri as string));

      if (!document.ok) {
        throw new Error(`JWKS endpoint answered HTTP ${document.status}`);
      }

      // The BODY carries the keys, and reading it is a second await that can fail or hang on
      // its own — so it is bounded too. Reading `document.keys` (the response object's own
      // properties) would find nothing on any real fetch and in any double that models one,
      // which fails closed with "no keys array": safe, but useless.
      const payload = (await this.withTimeout(document.json())) as JsonWebKeySetDocument | null;
      const keys = payload?.keys;

      if (!Array.isArray(keys)) {
        throw new Error('JWKS document contains no keys array');
      }

      const next = new Map<string, { pem: string; fetchedAtMs: number }>();
      const fetchedAtMs = this.now();

      for (const entry of keys) {
        const parsed = toRsaVerificationKey(entry, this.logger);
        if (!parsed) continue;
        next.set(parsed.kid, { pem: parsed.pem, fetchedAtMs });
      }

      if (next.size === 0) {
        throw new Error('JWKS document contains no usable RS256 verification key');
      }

      this.keys.clear();
      for (const [kid, value] of next) {
        this.keys.set(kid, value);
      }

      this.lastFetchAtMs = fetchedAtMs;
      this.lastFetchError = null;
      this.warnedAboutStaleCache = false;
    })();

    this.inflightFetch = fetchPromise.then(
      () => undefined,
      (error: unknown) => {
        this.lastFetchAtMs = this.now();
        throw error;
      },
    );

    try {
      await this.inflightFetch;
    } finally {
      this.inflightFetch = null;
    }
  }

  /** Observability surface. Reports state; never influences a decision. */
  snapshot(): TokenKeySetSnapshot {
    return {
      cachedKeys: this.keys.size,
      lastFetchAtMs: this.lastFetchAtMs,
      lastFetchError: this.lastFetchError,
    };
  }

  /**
   * Bounds a JWKS request in time.
   *
   * `Promise.race` rather than an abort signal: the goal is that a hung issuer must
   * not hang a request path, and a race achieves that with no dependency on which
   * fetch/AbortSignal flavour the runtime exposes. The abandoned request is left to
   * the runtime's own connection handling.
   */
  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`JWKS request exceeded ${JWKS_FETCH_TIMEOUT_MS}ms`)),
            JWKS_FETCH_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Turns one JWKS entry into a usable public key, or reports that it is not one.
 *
 * The filters are all refusals of "some other key": not RSA, marked for encryption
 * rather than signature, or naming an algorithm other than the pinned RS256. A key
 * that fails to convert is skipped with a warning rather than failing the whole
 * document, because one malformed entry must not take down a key set that contains
 * a usable key.
 */
function toRsaVerificationKey(
  entry: unknown,
  logger: Logger,
): { kid: string; pem: string } | null {
  if (!entry || typeof entry !== 'object') return null;

  const jwk = entry as Record<string, unknown>;
  const kid = typeof jwk.kid === 'string' && jwk.kid.trim().length > 0 ? jwk.kid.trim() : null;

  if (!kid) return null;
  if (jwk.kty !== 'RSA') return null;
  if (typeof jwk.use === 'string' && jwk.use !== 'sig') return null;
  if (typeof jwk.alg === 'string' && jwk.alg !== TOKEN_ASYMMETRIC_ALGORITHM) return null;

  const modulus = typeof jwk.n === 'string' && jwk.n.length > 0 ? jwk.n : null;
  const exponent = typeof jwk.e === 'string' && jwk.e.length > 0 ? jwk.e : null;

  // `kty` is checked above, but a JWK without the two RSA parameters is not a key: the
  // conversion would throw and be reported as a malformed entry. Refusing here keeps that
  // failure in the "this entry is not an RSA public key" bucket where it belongs.
  if (!modulus || !exponent) return null;

  try {
    // Rebuilt as a NODE JsonWebKey rather than cast: only `kty`, `n` and `e` are read, so a
    // JWKS entry cannot smuggle extra parameters (a `d` private component, say) into the
    // conversion, and the type is the one `createPublicKey` actually accepts.
    const rsaJwk: JsonWebKey = { kty: 'RSA', n: modulus, e: exponent, kid };
    const pem = createPublicKey({ key: rsaJwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();

    return { kid, pem };
  } catch (error) {
    logger.warn(
      `Ignoring JWKS entry kid=${JSON.stringify(kid)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
