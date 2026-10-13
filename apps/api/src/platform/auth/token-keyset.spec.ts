import { generateKeyPairSync, type JsonWebKey } from 'crypto';
import { TokenPolicy } from './token-policy';
import { TokenRejectedError } from './token-contract';
import {
  JWKS_CACHE_TTL_MS,
  JWKS_REFRESH_COOLDOWN_MS,
  TokenKeySet,
  type JwksFetchLike,
} from './token-keyset';

/**
 * Phase 51-HR-ARCH-3A: key selection, pinned.
 *
 * This is the only place a verification key is chosen, so the tests are about the two
 * things that must never happen:
 *
 *   1. a token must not be able to NOMINATE the algorithm it is verified with — the header
 *      is data being validated, not a decision-maker, and every algorithm-confusion attack
 *      starts by trying to make it one;
 *   2. a key this deployment cannot obtain must never be replaced by a guess (trying other
 *      cached keys, or accepting the token unverified). A JWKS outage degrades to the
 *      CACHED key and to a refusal for everything it cannot answer.
 */
describe('TokenKeySet', () => {
  const PUBLIC_PEM = '-----BEGIN PUBLIC KEY-----\nSTATIC\n-----END PUBLIC KEY-----';

  /** A real RSA public JWK, so the key conversion path is exercised rather than mocked. */
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ format: 'jwk' }) as JsonWebKey;

  const asymmetric = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_PEM, ...env });

  const legacy = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({ JWT_SECRET: 'shared-secret', ...env });

  /** A fetch double that records every call, so "how many outbound requests?" is assertable. */
  function fetchReturning(keys: unknown[], options: { ok?: boolean; status?: number } = {}) {
    const calls: string[] = [];
    const fetchImpl: JwksFetchLike = async (url) => {
      calls.push(url);
      const ok = options.ok ?? true;
      return { ok, status: options.status ?? 200, json: async () => ({ keys }) };
    };
    return { fetchImpl, calls };
  }

  describe('when this deployment is on the shared secret', () => {
    it('plans HS256 with the shared secret, and reports no kid', async () => {
      const plan = await new TokenKeySet(legacy()).planFor({ alg: 'HS256' });

      expect(plan).toEqual({
        algorithm: 'HS256',
        key: 'shared-secret',
        kid: null,
        trust: 'legacy-hmac',
      });
    });

    it('refuses RS256 rather than accepting a token it cannot check', async () => {
      await expect(new TokenKeySet(legacy()).planFor({ alg: 'RS256', kid: 'k1' })).rejects.toThrow(
        TokenRejectedError,
      );
    });

    it('refuses a header that carries no algorithm at all', async () => {
      // `alg: none` arrives here as either a missing algorithm or a mismatch; both are
      // refusals, and neither reaches the JWT library.
      await expect(new TokenKeySet(legacy()).planFor({})).rejects.toMatchObject({
        reason: 'token-malformed',
      });
      await expect(new TokenKeySet(legacy()).planFor({ alg: 'none' })).rejects.toMatchObject({
        reason: 'algorithm-not-accepted',
      });
    });

    it('refuses HS256 when the bridge is switched off, even with a shared secret present', async () => {
      // Stage 2.20 causality: this is the case the 2.19 HTTP run could not isolate. The
      // secret IS configured here and no key set is, so the only thing that can refuse the
      // token is the flag. If this passed with the flag false, the flag would be inert.
      const policy = legacy({ JWT_LEGACY_HS256_ENABLED: 'false' });

      await expect(new TokenKeySet(policy).planFor({ alg: 'HS256' })).rejects.toMatchObject({
        reason: 'algorithm-not-accepted',
      });
    });

    it('refuses HS256 with no secret configured', async () => {
      await expect(new TokenKeySet(new TokenPolicy({})).planFor({ alg: 'HS256' })).rejects.toMatchObject(
        { reason: 'key-unavailable' },
      );
    });
  });

  describe('when this deployment verifies RS256', () => {
    it('refuses an HS256 token outright — no fallback to the weaker algorithm', async () => {
      const keyset = new TokenKeySet(asymmetric(), fetchReturning([jwk]).fetchImpl);

      await expect(keyset.planFor({ alg: 'HS256' })).rejects.toMatchObject({
        reason: 'algorithm-not-accepted',
      });
    });

    it('requires a kid, because a key cannot be selected without one', async () => {
      const keyset = new TokenKeySet(asymmetric());

      await expect(keyset.planFor({ alg: 'RS256' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
      await expect(keyset.planFor({ alg: 'RS256', kid: '   ' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
    });

    it('returns the static key for a matching kid', async () => {
      const policy = asymmetric({ JWT_ASYMMETRIC_KEY_ID: 'kid-1' });
      const plan = await new TokenKeySet(policy).planFor({ alg: 'RS256', kid: 'kid-1' });

      expect(plan.algorithm).toBe('RS256');
      expect(plan.key).toBe(PUBLIC_PEM);
      expect(plan.kid).toBe('kid-1');
      expect(plan.trust).toBe('asymmetric');
    });

    it('refuses a kid the static key does not answer to', async () => {
      // Without this, a rotated-out token would keep verifying against the one key this
      // deployment holds, which is exactly what the kid exists to prevent.
      const policy = asymmetric({ JWT_ASYMMETRIC_KEY_ID: 'kid-2' });

      await expect(
        new TokenKeySet(policy).planFor({ alg: 'RS256', kid: 'kid-1' }),
      ).rejects.toMatchObject({ reason: 'key-unavailable' });
    });

    it('accepts any kid when the static key is not pinned to one (and says so)', async () => {
      const plan = await new TokenKeySet(asymmetric()).planFor({ alg: 'RS256', kid: 'anything' });

      expect(plan.key).toBe(PUBLIC_PEM);
      expect(plan.kid).toBe('anything');
    });
  });

  describe('when the key comes from a JWKS endpoint', () => {
    const jwksPolicy = (env: Record<string, string | undefined> = {}) =>
      new TokenPolicy({
        JWT_JWKS_URI: 'https://issuer.test/jwks.json',
        JWT_ASYMMETRIC_KEY_ID: 'kid-1',
        ...env,
      });

    it('resolves the key named by kid from the fetched document', async () => {
      const { fetchImpl, calls } = fetchReturning([{ ...jwk, kid: 'kid-1', use: 'sig', alg: 'RS256' }]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl);

      const plan = await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });

      expect(plan.key).toContain('BEGIN PUBLIC KEY');
      expect(plan.kid).toBe('kid-1');
      expect(calls).toEqual(['https://issuer.test/jwks.json']);
      expect(keyset.snapshot()).toMatchObject({ cachedKeys: 1, lastFetchError: null });
    });

    it('serves the cached key without a second request while the cache is fresh', async () => {
      const { fetchImpl, calls } = fetchReturning([{ ...jwk, kid: 'kid-1' }]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl);

      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });

      // A verifier that asks the issuer on every request is an outage multiplier, and the
      // cache is the thing that prevents it.
      expect(calls).toHaveLength(1);
    });

    it('refetches once the cache has expired', async () => {
      let now = 1_000_000;
      const { fetchImpl, calls } = fetchReturning([{ ...jwk, kid: 'kid-1' }]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl, () => now);

      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      now += JWKS_CACHE_TTL_MS + 1;
      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });

      expect(calls).toHaveLength(2);
    });

    it('rate-limits a refetch caused by an unknown kid (anti-amplification)', async () => {
      let now = 1_000_000;
      const { fetchImpl, calls } = fetchReturning([{ ...jwk, kid: 'kid-1' }]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl, () => now);

      await expect(keyset.planFor({ alg: 'RS256', kid: 'nope' })).rejects.toThrow(TokenRejectedError);
      now += JWKS_REFRESH_COOLDOWN_MS - 1;
      await expect(keyset.planFor({ alg: 'RS256', kid: 'nope-again' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });

      // Random kids must not become outbound requests on demand.
      expect(calls).toHaveLength(1);
    });

    it('reports a kid the issuer does not publish, and never tries another cached key', async () => {
      const { fetchImpl } = fetchReturning([{ ...jwk, kid: 'kid-1' }]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl);

      await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });

      let now = 1_000_000;
      const withClock = new TokenKeySet(jwksPolicy(), fetchImpl, () => now);
      now += 0;
      await expect(withClock.planFor({ alg: 'RS256', kid: 'kid-other' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
    });

    /**
     * The outage rule (ADR-0006 §B): JWKS downtime must not become an outage of the business
     * runtime, and it must not become a reason to accept a token either.
     *
     * The two tests below are the two halves of that sentence, and they are asserted together
     * because either one alone is satisfied by a wrong implementation: "keep using the cache"
     * alone is satisfied by "verify against whatever we have", and "refuse what we cannot
     * answer" alone is satisfied by "fetch on every request".
     */
    it('keeps serving the cached key when the JWKS endpoint starts failing', async () => {
      let failing = false;
      const calls: string[] = [];
      const flaky: JwksFetchLike = async (url) => {
        calls.push(url);
        if (failing) throw new Error('ECONNREFUSED');
        return { ok: true, status: 200, json: async () => ({ keys: [{ ...jwk, kid: 'kid-1' }] }) };
      };

      let now = 1_000_000;
      const keyset = new TokenKeySet(jwksPolicy(), flaky, () => now);

      const first = await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      expect(calls).toHaveLength(1);

      // The issuer's key distribution goes down and the cache expires. A business runtime that
      // already holds the key must keep working: the outage is the ISSUER's availability
      // problem, not a reason to fail every request.
      failing = true;
      now += JWKS_CACHE_TTL_MS + 1;

      const duringOutage = await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      expect(duringOutage.key).toBe(first.key);
      expect(keyset.snapshot().lastFetchError).toContain('ECONNREFUSED');
      expect(keyset.snapshot().cachedKeys).toBe(1);
    });

    it('still refuses a kid the cache cannot answer while the JWKS endpoint is down', async () => {
      const failing: JwksFetchLike = async () => {
        throw new Error('ECONNREFUSED');
      };
      const keyset = new TokenKeySet(jwksPolicy(), failing);

      // No cache, no key: the only correct answer is a refusal. Anything else would be the
      // verifier inventing a key, which is the one degradation that is never acceptable.
      await expect(keyset.planFor({ alg: 'RS256', kid: 'kid-1' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
      expect(keyset.snapshot().lastFetchError).toContain('ECONNREFUSED');
      expect(keyset.snapshot().cachedKeys).toBe(0);
    });

    it('ignores a JWKS entry that is not an RSA signature key', async () => {
      const { fetchImpl } = fetchReturning([
        { ...jwk, kid: 'enc-key', use: 'enc' },
        { ...jwk, kid: 'ec-key', kty: 'EC' },
        { ...jwk, kid: 'other-alg', alg: 'RS512' },
        { kty: 'RSA' },
        { ...jwk, kid: 'kid-1' },
      ]);
      const keyset = new TokenKeySet(jwksPolicy(), fetchImpl);

      // One malformed entry must not take down a key set that contains a usable key, and a
      // usable key must not be selected on behalf of a kid that names something else.
      const plan = await keyset.planFor({ alg: 'RS256', kid: 'kid-1' });
      expect(plan.key).toContain('BEGIN PUBLIC KEY');

      await expect(keyset.planFor({ alg: 'RS256', kid: 'enc-key' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
      await expect(keyset.planFor({ alg: 'RS256', kid: 'ec-key' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
      await expect(keyset.planFor({ alg: 'RS256', kid: 'other-alg' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
    });
  });

  /**
   * Phase 52-ARCH-3C: a configured KEY SET answers for every kid, and answers completely.
   *
   * The two halves of a rotation are what these tests pin: the key that is still inside its
   * window must verify, and a key that has been retired must not — not by trying another key in
   * the set, and not by reaching for a static key or a JWKS document instead.
   */
  describe('when a key set is configured', () => {
    const active = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ACTIVE_PRIVATE_PEM = active.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const RETIRING_PUBLIC_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();

    const HOUR_MS = 3_600_000;
    const retireAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

    const keySetPolicy = (retireOffsetMs: number) =>
      new TokenPolicy({
        JWT_SIGNING_KEYS: JSON.stringify([
          { kid: 'new', privateKey: ACTIVE_PRIVATE_PEM, activatedAt: '2026-01-01T00:00:00Z' },
          { kid: 'old', publicKey: RETIRING_PUBLIC_PEM, retireAt: retireAt(retireOffsetMs) },
        ]),
        JWT_ACTIVE_KEY_ID: 'new',
      });

    it('selects the key a token names, from the set', async () => {
      const plan = await new TokenKeySet(keySetPolicy(HOUR_MS)).planFor({
        alg: 'RS256',
        kid: 'new',
      });

      expect(plan).toMatchObject({ algorithm: 'RS256', kid: 'new', trust: 'asymmetric' });
      expect(plan.key).toContain('BEGIN PUBLIC KEY');
    });

    it('still verifies the key that is inside its rotation window', async () => {
      const plan = await new TokenKeySet(keySetPolicy(HOUR_MS)).planFor({
        alg: 'RS256',
        kid: 'old',
      });

      expect(plan.kid).toBe('old');
    });

    it('refuses a kid the set does not hold, naming what it holds', async () => {
      await expect(
        new TokenKeySet(keySetPolicy(HOUR_MS)).planFor({ alg: 'RS256', kid: 'never-existed' })
      ).rejects.toMatchObject({ reason: 'key-unavailable' });
    });

    it('refuses a RETIRED key, while the key that replaced it keeps working', async () => {
      const keyset = new TokenKeySet(keySetPolicy(-HOUR_MS));

      await expect(keyset.planFor({ alg: 'RS256', kid: 'old' })).rejects.toMatchObject({
        reason: 'key-unavailable',
      });
      // Retirement is decided by the CLOCK, not by a request: the same key set answers tokens
      // for `new` in the same breath.
      const plan = await keyset.planFor({ alg: 'RS256', kid: 'new' });

      expect(plan.key).toContain('BEGIN PUBLIC KEY');
    });

    it('refuses a retired kid terminally, without falling back to another key', async () => {
      // ADR-0006 §B5: a refusal is final. The set holds a usable key, and the answer for a token
      // naming a retired one is still no.
      await expect(
        new TokenKeySet(keySetPolicy(-HOUR_MS)).planFor({ alg: 'RS256', kid: 'old' })
      ).rejects.toThrow(/was retired at/);
    });
  });
});
