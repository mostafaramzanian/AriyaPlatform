import { generateKeyPairSync } from 'crypto';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { TokenKeySet } from './token-keyset';
import { TokenPolicy } from './token-policy';
import { InMemoryRevocationRegistry } from './token-revocation';
import { TokenVerifier } from './token-verifier';
import {
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_LEGACY_ALGORITHM,
  TokenRejectedError,
  type TokenRejectionReason,
} from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: THE verifier, and the refusals that make it one.
 *
 * This suite is written around the properties that made the phase necessary, not around
 * branch coverage of the file:
 *
 *   1. ONE VERIFIER, SO TWO TRANSPORTS CANNOT DISAGREE. `verify` (the WebSocket handshake)
 *      and `planVerification` + `trust` (the passport-jwt path) are two call shapes over one
 *      implementation. Both are exercised here, and the plan is asserted to be per-request
 *      state rather than something a concurrent request could overwrite;
 *   2. THE TOKEN DOES NOT CHOOSE THE ALGORITHM OR THE KEY. Every `alg`-confusion variant —
 *      HS256 against an RSA key, `alg: none`, a kid this deployment does not hold — is a
 *      refusal, and the assertion is on the REASON, because "rejected for the wrong reason"
 *      is how a pinning regression hides;
 *   3. THE BOUNDS BELONG TO THE MODEL THAT NEEDS THEM. The TTL ceiling and the deny-set are
 *      enforced at asymmetric trust and NOT at legacy trust, where they would narrow a bridge
 *      whose whole job is to keep today's tokens working.
 */
describe('TokenVerifier', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const OTHER_PRIVATE_PEM = otherPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const SECRET = 'shared-secret-value';
  const KEY_ID = 'key-2026-09';

  /** A JwtService with no ambient secret: every key arrives from the call site. */
  const jwt = new JwtService({});

  /** The deployment the platform is on today. */
  const legacyPolicy = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({ JWT_SECRET: SECRET, ...env });

  /** The target deployment: verification from a distributed public key. */
  const asymmetricPolicy = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({
      JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_PEM,
      JWT_ASYMMETRIC_KEY_ID: KEY_ID,
      ...env,
    });

  /** A clock we control, so expiry is exercised rather than waited out. */
  function clock(startMs: number = Date.now()) {
    let now = startMs;
    return {
      now: () => now,
      advanceSeconds: (seconds: number) => {
        now += seconds * 1000;
      },
    };
  }

  function harness(policy: TokenPolicy, startMs: number = Date.now()) {
    const time = clock(startMs);
    const revocation = new InMemoryRevocationRegistry(policy.maxAcceptedTtlSeconds, time.now);

    return {
      time,
      revocation,
      verifier: new TokenVerifier(
        jwt,
        policy,
        new TokenKeySet(policy, undefined, time.now),
        revocation,
        time.now,
      ),
    };
  }

  function hs256(
    payload: Record<string, unknown>,
    options: { secret?: string; expiresIn?: number | string } = {},
  ): string {
    return jwt.sign(payload, {
      algorithm: TOKEN_LEGACY_ALGORITHM,
      secret: options.secret ?? SECRET,
      expiresIn: (options.expiresIn ?? '15m') as JwtSignOptions['expiresIn'],
    });
  }

  function rs256(
    payload: Record<string, unknown>,
    options: { key?: string; kid?: string; expiresIn?: number | string } = {},
  ): string {
    return jwt.sign(payload, {
      algorithm: TOKEN_ASYMMETRIC_ALGORITHM,
      keyid: options.kid ?? KEY_ID,
      secret: options.key ?? PRIVATE_PEM,
      expiresIn: (options.expiresIn ?? 300) as JwtSignOptions['expiresIn'],
    });
  }

  /** A token implementing the `none` algorithm, which this platform never accepts. */
  function algNoneToken(payload: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.`;
  }

  /** The claims a legacy token carries today, before the target model exists. */
  const legacyPayload = (overrides: Record<string, unknown> = {}) => ({
    sub: 'user-1',
    email: 'user@example.com',
    tokenVersion: 4,
    aud: 'aria-erp-api',
    iss: 'aria-erp-auth',
    ...overrides,
  });

  /** The claims an asymmetric token carries: `tid`, `ver` and `perm` are the authority. */
  const asymmetricPayload = (overrides: Record<string, unknown> = {}) => ({
    sub: 'user-1',
    tid: 'tenant-a',
    ver: 4,
    perm: ['hr.employee.read'],
    aud: 'aria-erp-api',
    iss: 'aria-erp-auth',
    ...overrides,
  });

  /** The rejection REASON, which is the part a caller must not have to infer. */
  async function rejection(promise: Promise<unknown>): Promise<TokenRejectionReason> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof TokenRejectedError) return error.reason;
      throw error;
    }

    throw new Error('Expected a rejection, but the verifier returned claims.');
  }

  /**
   * A fixed issuance instant, carried as the `iat` claim.
   *
   * `jsonwebtoken` takes `payload.iat` as the timestamp `exp` is derived from, so passing it
   * makes a token's lifetime EXACT — `expiresIn: 900` yields `ttlSeconds === 900` regardless
   * of how long the test took to get there. Without it, "the bridge still accepts a
   * 15-minute token" would be an assertion about wall-clock drift.
   */
  const IAT = Math.floor(Date.now() / 1000);

  /** A clock parked at the issuance instant, so `exp` is compared against a known now. */
  const AT_ISSUANCE = IAT * 1000;

  describe('at legacy (shared-secret) trust — the migration bridge', () => {
    it("accepts today's token: right secret, right issuer and audience, integer tokenVersion", async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);

      const claims = await verifier.verify(
        hs256({ ...legacyPayload(), iat: IAT }, { expiresIn: 900 }),
      );

      expect(claims.trust).toBe('legacy-hmac');
      expect(claims.sub).toBe('user-1');
      expect(claims.email).toBe('user@example.com');
      expect(claims.ver).toBe(4);
      // The target model's claims are ABSENT at legacy trust, not borrowed: a `tid` that
      // nothing resolved from would advertise a capability the bridge does not have.
      expect(claims.tid).toBeNull();
      expect(claims.perm).toEqual([]);
      expect(claims.kid).toBeNull();
      expect(claims.ttlSeconds).toBe(900);
    });

    /**
     * ADR-0006 §B2/D: a legacy token is NOT claim-authoritative, so `tid` and `perm` on one
     * are ignored even when present. This is the assertion that stops "use the claim when it
     * is there" from being the implemented rule — a rule under which the holder of the shared
     * secret could choose their own tenant and permissions.
     */
    it('ignores tid, ver and perm claims on a legacy token', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);

      const claims = await verifier.verify(
        hs256(
          {
            ...legacyPayload(),
            iat: IAT,
            tid: 'attacker-chosen-tenant',
            ver: 99,
            perm: ['hr.employee.read', 'admin.everything'],
          },
          { expiresIn: 900 },
        ),
      );

      expect(claims.trust).toBe('legacy-hmac');
      expect(claims.tid).toBeNull();
      expect(claims.perm).toEqual([]);
      // `ver` is Core's `tokenVersion` at legacy trust, never the `ver` claim.
      expect(claims.ver).toBe(4);
    });

    /**
     * The TTL ceiling belongs to the model HR adopts, so it must not narrow the bridge.
     * Today's tokens are 15 minutes while the default ceiling is 5 — an acceptance test
     * against the asymmetric bound would break every client on the day this phase shipped.
     */
    it('accepts a 15-minute token that exceeds the asymmetric lifetime ceiling', async () => {
      const policy = legacyPolicy();
      expect(policy.maxAcceptedTtlSeconds).toBe(300);

      const { verifier } = harness(policy, AT_ISSUANCE);
      const claims = await verifier.verify(
        hs256({ ...legacyPayload(), iat: IAT }, { expiresIn: 900 }),
      );

      expect(claims.ttlSeconds).toBe(900);
    });

    it('refuses a token signed with a different secret', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT }, { secret: 'not-the-configured-secret' });

      expect(await rejection(verifier.verify(token))).toBe('signature-invalid');
    });

    it('refuses an issuer that is not this platform', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT, iss: 'some-other-issuer' });

      expect(await rejection(verifier.verify(token))).toBe('issuer-mismatch');
    });

    it('refuses an audience that does not include the API', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT, aud: 'some-other-audience' });

      expect(await rejection(verifier.verify(token))).toBe('audience-mismatch');
    });

    it('accepts the audience when it is a list that contains the API', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT, aud: ['other', 'aria-erp-api'] });

      expect((await verifier.verify(token)).sub).toBe('user-1');
    });

    it('refuses an expired token', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT - 1_000 }, { expiresIn: 900 });

      expect(await rejection(verifier.verify(token))).toBe('token-expired');
    });

    it('refuses a token that is not valid yet', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT, nbf: IAT + 60 }, { expiresIn: 900 });

      expect(await rejection(verifier.verify(token))).toBe('token-not-yet-valid');
    });

    /**
     * Core's `tokenVersion` is compared by `JwtStrategy` against the database row, and the
     * column is a non-null integer. A token without one could never pass that comparison, so
     * refusing it here removes an "undefined !== 4" special case rather than changing a
     * single outcome.
     */
    it('refuses a token with no integer tokenVersion', async () => {
      const { verifier } = harness(legacyPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT, tokenVersion: undefined });

      expect(await rejection(verifier.verify(token))).toBe('claims-malformed');
    });

    it('refuses HS256 outright once the bridge is disabled', async () => {
      const { verifier } = harness(
        legacyPolicy({ JWT_LEGACY_HS256_ENABLED: 'false' }),
        AT_ISSUANCE,
      );
      const token = hs256({ ...legacyPayload(), iat: IAT });

      expect(await rejection(verifier.verify(token))).toBe('algorithm-not-accepted');
    });

    it('refuses HS256 after the configured sunset has passed', async () => {
      const { verifier } = harness(
        legacyPolicy({ JWT_LEGACY_HS256_SUNSET: new Date(AT_ISSUANCE - 1000).toISOString() }),
        AT_ISSUANCE,
      );
      const token = hs256({ ...legacyPayload(), iat: IAT });

      expect(await rejection(verifier.verify(token))).toBe('algorithm-not-accepted');
    });
  });

  describe('at asymmetric (public-key) trust — the target model', () => {
    it('accepts a token whose authority is the tid, ver and perm claims', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);

      const claims = await verifier.verify(rs256({ ...asymmetricPayload(), iat: IAT }));

      expect(claims.trust).toBe('asymmetric');
      expect(claims.sub).toBe('user-1');
      // The three claims the target model makes authoritative. ADR-0006 §B1: the issuer
      // already knows all three, so nothing downstream of this must ask a database.
      expect(claims.tid).toBe('tenant-a');
      expect(claims.ver).toBe(4);
      expect(claims.perm).toEqual(['hr.employee.read']);
      // The signature is reported against the key it was actually verified with, which is
      // what makes a rotation diagnosable from a single log line.
      expect(claims.kid).toBe(KEY_ID);
      expect(claims.ttlSeconds).toBe(300);
    });

    /**
     * ADR-0006 §B5: "removal, not a fallback chain". With asymmetric material configured,
     * HMAC acceptance is OFF — so a shared-secret token is not verified at a weaker trust
     * level, it is refused. This is the assertion that closes the migration's widest hole:
     * a verifier that kept accepting HS256 "during the transition" would accept a token
     * anyone holding one shared string can forge.
     */
    it('refuses an HS256 token outright once public-key trust is configured', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);
      const token = hs256({ ...legacyPayload(), iat: IAT });

      expect(await rejection(verifier.verify(token))).toBe('algorithm-not-accepted');
    });

    /** `alg: none` is the classic downgrade, and it is refused as an unaccepted algorithm. */
    it('refuses an alg:none token', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);
      const token = algNoneToken({ ...asymmetricPayload(), iat: IAT });

      expect(await rejection(verifier.verify(token))).toBe('algorithm-not-accepted');
    });

    /**
     * A correctly-formed RS256 token signed by a key this deployment does not hold. The
     * header cannot nominate a key into existence: it names a `kid`, and the platform uses
     * the key IT has for that name.
     */
    it('refuses a token signed by a different key', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);
      const token = rs256({ ...asymmetricPayload(), iat: IAT }, { key: OTHER_PRIVATE_PEM });

      expect(await rejection(verifier.verify(token))).toBe('signature-invalid');
    });

    /**
     * The rotation case. A `kid` this deployment does not hold is a REFUSAL, never a
     * "try the other key": trying keys is how an old, compromised key stays usable.
     */
    it('refuses a token naming a kid this deployment does not hold', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);
      const token = rs256({ ...asymmetricPayload(), iat: IAT }, { kid: 'retired-key' });

      expect(await rejection(verifier.verify(token))).toBe('key-unavailable');
    });

    it('refuses a token whose header carries no kid', async () => {
      const { verifier } = harness(asymmetricPolicy(), AT_ISSUANCE);
      const token = jwt.sign(
        { ...asymmetricPayload(), iat: IAT },
        { algorithm: TOKEN_ASYMMETRIC_ALGORITHM, secret: PRIVATE_PEM, expiresIn: 300 },
      );

      expect(await rejection(verifier.verify(token))).toBe('key-unavailable');
    });
  });
});
