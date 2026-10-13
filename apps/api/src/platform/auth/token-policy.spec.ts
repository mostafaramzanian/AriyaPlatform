import { generateKeyPairSync } from 'crypto';
import {
  DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS,
  DEFAULT_LEGACY_ACCESS_TTL,
  DEFAULT_MAX_PERMISSIONS_PER_TOKEN,
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_LEGACY_ALGORITHM,
} from './token-contract';
import { TOKEN_POLICY_ENV_NAMES, TokenPolicy, TokenPolicyError } from './token-policy';

/**
 * Phase 51-HR-ARCH-3A: the configuration surface, pinned.
 *
 * `TokenPolicy` is where "which algorithm does this process accept?" is decided for the
 * issuer, both verifiers and the tenant resolver at once. Every test here is therefore
 * about a decision that must NOT be reachable by two different code paths in two ways:
 *
 *   * with no key material configured, the deployment is UNCHANGED (shared secret, today's
 *     behaviour) — this phase must be a prerequisite, not a policy flip;
 *   * with key material configured, HMAC acceptance is gone, not a fallback;
 *   * a configuration this contract cannot honour throws at construction, so a boot either
 *     has a coherent posture or does not happen.
 */
describe('TokenPolicy', () => {
  const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMFwwDQ==\n-----END PUBLIC KEY-----';
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMFwwDQ==\n-----END PRIVATE KEY-----';

  describe('with no asymmetric material configured', () => {
    const policy = new TokenPolicy({ JWT_SECRET: 'shared-secret' });

    it("keeps the deployment on the shared secret with today's defaults", () => {
      expect(policy.asymmetricEnabled).toBe(false);
      expect(policy.asymmetricIssuanceEnabled).toBe(false);
      expect(policy.acceptedAlgorithm).toBe(TOKEN_LEGACY_ALGORITHM);
      expect(policy.maxAcceptedTtlSeconds).toBe(DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS);
      expect(policy.maxPermissionsPerToken).toBe(DEFAULT_MAX_PERMISSIONS_PER_TOKEN);
      expect(policy.legacyAccessTtl).toBe(DEFAULT_LEGACY_ACCESS_TTL);
      expect(policy.legacyHs256Enabled).toBe(true);
      expect(policy.legacyHs256SunsetMs).toBeNull();
    });

    it('pins the issuer and audience the verifiers compare against', () => {
      expect(policy.issuer).toBe(TOKEN_ISSUER);
      expect(policy.audience).toBe(TOKEN_AUDIENCE);
    });

    it('accepts HMAC when a secret exists, and refuses when it does not', () => {
      expect(policy.legacyAccepted()).toBe(true);
      // A deployment on the bridge with no secret cannot verify anything. Saying so here is
      // what lets the key set refuse the token as 'key-unavailable' rather than throwing
      // from deep inside the JWT library.
      expect(new TokenPolicy({}).legacyAccepted()).toBe(false);
    });

    it('describes the bridge posture in one line, naming the bound', () => {
      const description = policy.describe();

      expect(description).toContain(TOKEN_LEGACY_ALGORITHM);
      expect(description).toContain('max-ttl=300s');
      expect(description).toContain('asymmetric keys not configured');
    });
  });

  describe('with asymmetric material configured', () => {
    it('accepts one algorithm only, from a static key', () => {
      const policy = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
        JWT_ASYMMETRIC_KEY_ID: 'key-2026-01',
      });

      expect(policy.asymmetricEnabled).toBe(true);
      expect(policy.acceptedAlgorithm).toBe(TOKEN_ASYMMETRIC_ALGORITHM);
      expect(policy.asymmetricPublicKey).toBe(PUBLIC_KEY);
      expect(policy.asymmetricKeyId).toBe('key-2026-01');
    });

    it('refuses HMAC outright — removal, not a fallback chain (B5)', () => {
      // The shared secret is still set. It is deliberately IGNORED: a deployment that has
      // adopted public-key verification must not keep a second, weaker way in.
      const policy = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
      });

      expect(policy.legacyAccepted()).toBe(false);
    });

    it('accepts a JWKS endpoint as the alternative key source', () => {
      const policy = new TokenPolicy({ JWT_JWKS_URI: 'https://issuer.test/.well-known/jwks.json' });

      expect(policy.asymmetricEnabled).toBe(true);
      expect(policy.jwksUri).toBe('https://issuer.test/.well-known/jwks.json');
      expect(policy.asymmetricPublicKey).toBeNull();
    });

    it('refuses two key sources, because that is two answers to "which key signed this?"', () => {
      expect(
        () =>
          new TokenPolicy({
            JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
            JWT_JWKS_URI: 'https://issuer.test/jwks.json',
          }),
      ).toThrow(TokenPolicyError);
    });

    it('refuses private key material in the verification key', () => {
      // A verifier that holds the signing key has signing authority, which is the property
      // asymmetric verification exists to remove.
      expect(() => new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PRIVATE_KEY })).toThrow(
        /PRIVATE key material/,
      );
    });

    it('separates "can verify" from "can sign"', () => {
      const verifierOnly = new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY });
      const issuer = new TokenPolicy({
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
        JWT_ASYMMETRIC_PRIVATE_KEY: PRIVATE_KEY,
      });

      expect(verifierOnly.asymmetricEnabled).toBe(true);
      expect(verifierOnly.asymmetricIssuanceEnabled).toBe(false);
      expect(issuer.asymmetricIssuanceEnabled).toBe(true);
    });

    it('defaults the asymmetric TTL to the accepted maximum, not above it', () => {
      const policy = new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY });

      expect(policy.asymmetricAccessTtlSeconds).toBe(DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS);
    });

    it("refuses an issuance TTL this platform's own verifiers would reject", () => {
      expect(
        () =>
          new TokenPolicy({
            JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
            JWT_ASYMMETRIC_ACCESS_TTL_SECONDS: '600',
          }),
      ).toThrow(/exceeds HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS/);

      // Exactly at the bound is legal: the verifier rejects only ABOVE it.
      const atBound = new TokenPolicy({
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
        JWT_ASYMMETRIC_ACCESS_TTL_SECONDS: '300',
      });
      expect(atBound.asymmetricAccessTtlSeconds).toBe(300);
    });

    it('describes the posture including the key source and whether this process signs', () => {
      const jwks = new TokenPolicy({ JWT_JWKS_URI: 'https://issuer.test/jwks.json' });
      const staticVerifier = new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY });
      const signer = new TokenPolicy({
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_KEY,
        JWT_ASYMMETRIC_KEY_ID: 'kid-1',
        JWT_ASYMMETRIC_PRIVATE_KEY: PRIVATE_KEY,
      });

      expect(jwks.describe()).toContain('jwks=https://issuer.test/jwks.json');
      expect(jwks.describe()).toContain('HMAC acceptance disabled');
      expect(staticVerifier.describe()).toContain('kid unpinned');
      expect(staticVerifier.describe()).toContain('verify-only');
      expect(signer.describe()).toContain('kid=kid-1');
      expect(signer.describe()).toContain('signs RS256');
    });
  });

  /**
   * Phase 52-ARCH-3C: the signing KEY SET as configuration — a third key source, with one
   * active member, a declared rotation window, and a publication projection verifiers read.
   */
  describe('the signing key set', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PRIVATE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const OTHER_PUBLIC = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();

    const keySet = (env: Record<string, string | undefined> = {}) =>
      new TokenPolicy({
        JWT_SIGNING_KEYS: JSON.stringify([
          { kid: 'new', privateKey: PRIVATE, activatedAt: '2026-01-01T00:00:00Z' },
          { kid: 'old', publicKey: OTHER_PUBLIC, retireAt: '2099-01-01T00:00:00Z' },
        ]),
        JWT_ACTIVE_KEY_ID: 'new',
        ...env,
      });

    it('counts as asymmetric material, so HMAC acceptance is gone (ADR-0006 §B5)', () => {
      const policy = keySet({ JWT_SECRET: 'shared-secret' });

      expect(policy.asymmetricEnabled).toBe(true);
      expect(policy.acceptedAlgorithm).toBe(TOKEN_ASYMMETRIC_ALGORITHM);
      expect(policy.legacyAccepted()).toBe(false);
      expect(policy.asymmetricIssuanceEnabled).toBe(true);
    });

    it('resolves the ONE signing key to the active entry', () => {
      expect(keySet().signingKey).toEqual({ kid: 'new', privatePem: PRIVATE.trim() });
      expect(keySet().signingKeyProblem).toBeNull();
    });

    it('reports why it cannot sign, naming the key set rather than the single-key variables', () => {
      const publicOnly = new TokenPolicy({
        JWT_SIGNING_KEYS: JSON.stringify([{ kid: 'new', publicKey: PUBLIC }]),
      });

      expect(publicOnly.signingKey).toBeNull();
      expect(publicOnly.signingKeyProblem).toContain('JWT_SIGNING_KEYS');
      expect(publicOnly.asymmetricIssuanceEnabled).toBe(false);
    });

    it('publishes the ACTIVE key first, and drops one that has retired', () => {
      const policy = keySet();

      expect(policy.publishableKeys(Date.parse('2026-06-01T00:00:00Z')).map((k) => k.kid)).toEqual([
        'new',
        'old',
      ]);
      // Past the declared instant the key is not published any more, so a verifier cannot keep
      // fetching a key this deployment has stopped accepting.
      expect(policy.publishableKeys(Date.parse('2099-01-01T00:00:00Z')).map((k) => k.kid)).toEqual([
        'new',
      ]);
    });

    it('publishes nothing on the shared secret, and nothing without a kid to address', () => {
      expect(new TokenPolicy({ JWT_SECRET: 'shared-secret' }).publishableKeys()).toEqual([]);
      // A static key with no key id cannot be addressed by a token header, so it is not
      // published: a JWKS entry without a `kid` documents a key no verifier could select.
      expect(new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC }).publishableKeys()).toEqual([]);
      expect(
        new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC, JWT_ASYMMETRIC_KEY_ID: 'kid-1' })
          .publishableKeys()
          .map((key) => key.kid)
      ).toEqual(['kid-1']);
    });

    it('describes the key set in the boot log without any key material', () => {
      const description = keySet().describe();

      expect(description).toContain('key-set(2 keys, active=new');
      expect(description).toContain('overlap>=900s');
      expect(description).toContain('2 public key(s) published');
      expect(description).toContain('signs RS256');
      expect(description).not.toContain('BEGIN');
    });

    it('refuses a key set combined with any single-source variable', () => {
      for (const [name, value] of [
        ['JWT_ASYMMETRIC_PUBLIC_KEY', PUBLIC],
        ['JWT_ASYMMETRIC_KEY_ID', 'kid-1'],
        ['JWT_ASYMMETRIC_PRIVATE_KEY', PRIVATE],
        ['JWT_JWKS_URI', 'https://issuer.test/jwks.json'],
      ] as const) {
        expect(() => keySet({ [name]: value })).toThrow(/exactly one key source/);
      }
    });

    it('refuses an active key that the set does not hold', () => {
      expect(() => keySet({ JWT_ACTIVE_KEY_ID: 'missing' })).toThrow(/does not hold/);
    });

    it('refuses signing material with no active key, and an active key with no key set', () => {
      expect(() => keySet({ JWT_ACTIVE_KEY_ID: '' })).toThrow(/does not name the key that signs/);
      expect(() => new TokenPolicy({ JWT_ACTIVE_KEY_ID: 'new' })).toThrow(
        /JWT_SIGNING_KEYS is not/
      );
    });

    it('refuses an active entry that holds no private half while other entries do', () => {
      expect(
        () =>
          new TokenPolicy({
            JWT_SIGNING_KEYS: JSON.stringify([
              {
                kid: 'old',
                privateKey: PRIVATE,
                activatedAt: '2026-01-01T00:00:00Z',
                retireAt: '2099-01-01T00:00:00Z',
              },
              { kid: 'new', publicKey: PUBLIC },
            ]),
            JWT_ACTIVE_KEY_ID: 'new',
          })
      ).toThrow(/must carry the private half/);
    });

    it('keeps a deployment with a blank key set exactly where it was', () => {
      const policy = new TokenPolicy({ JWT_SECRET: 'shared-secret', JWT_SIGNING_KEYS: '  ' });

      expect(policy.asymmetricEnabled).toBe(false);
      expect(policy.acceptedAlgorithm).toBe(TOKEN_LEGACY_ALGORITHM);
    });
  });

  describe('the HMAC sunset, which turns an intention into a date', () => {
    const future = '2030-01-01T00:00:00Z';
    const past = '2020-01-01T00:00:00Z';

    it('accepts HMAC before the sunset and refuses it after', () => {
      const before = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_LEGACY_HS256_SUNSET: future,
      });
      const after = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_LEGACY_HS256_SUNSET: past,
      });

      expect(before.legacyAccepted(Date.parse('2029-12-31T23:59:59Z'))).toBe(true);
      // The boundary is inclusive: at the sunset instant, the bridge is closed.
      expect(before.legacyAccepted(Date.parse(future))).toBe(false);
      expect(after.legacyAccepted()).toBe(false);
    });

    it('can be switched off outright', () => {
      for (const value of ['false', '0', 'no', 'off', 'FALSE']) {
        const policy = new TokenPolicy({ JWT_SECRET: 'shared-secret', JWT_LEGACY_HS256_ENABLED: value });
        expect(policy.legacyAccepted()).toBe(false);
      }

      for (const value of ['true', '1', 'yes', 'on']) {
        const policy = new TokenPolicy({ JWT_SECRET: 'shared-secret', JWT_LEGACY_HS256_ENABLED: value });
        expect(policy.legacyAccepted()).toBe(true);
      }
    });

    it('mentions the sunset in the boot description when one is configured', () => {
      const policy = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_LEGACY_HS256_SUNSET: future,
      });

      expect(policy.describe()).toContain('sunset=2030-01-01T00:00:00.000Z');
    });
  });

  describe('configuration this contract cannot honour', () => {
    it('refuses a non-numeric bound instead of silently defaulting', () => {
      // A typo that quietly becomes 300 is a bound nobody knows they lost, so every one of
      // these must fail the boot rather than be coerced.
      for (const value of ['5m', '300s', 'abc', '-1', '0', '1.5', ' 0x10 ']) {
        expect(() => new TokenPolicy({ HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS: value })).toThrow(
          TokenPolicyError,
        );
      }
    });

    it('refuses a perm ceiling that is not a positive whole number', () => {
      expect(() => new TokenPolicy({ MAX_PERMISSIONS_PER_TOKEN: 'many' })).toThrow(TokenPolicyError);
      expect(new TokenPolicy({ MAX_PERMISSIONS_PER_TOKEN: '1000' }).maxPermissionsPerToken).toBe(1000);
    });

    it('refuses an unparseable sunset rather than treating it as "no sunset"', () => {
      expect(() => new TokenPolicy({ JWT_LEGACY_HS256_SUNSET: 'next quarter' })).toThrow(
        /ISO-8601/,
      );
    });

    it('refuses an unreadable boolean rather than defaulting it', () => {
      expect(() => new TokenPolicy({ JWT_LEGACY_HS256_ENABLED: 'maybe' })).toThrow(
        /must be a boolean/,
      );
    });

    it('treats a blank value as absent, not as an empty key', () => {
      // `JWT_SECRET=` in a .env file is an empty string. Reading it as a secret would make
      // every HMAC token verifiable with the empty key.
      const policy = new TokenPolicy({ JWT_SECRET: '   ', JWT_JWKS_URI: '' });

      expect(policy.legacyHs256Secret).toBeNull();
      expect(policy.legacyAccepted()).toBe(false);
      expect(policy.asymmetricEnabled).toBe(false);
    });
  });

  /**
   * `fromConfig` is what the DI container calls. It reads a FIXED list of names rather than
   * iterating the environment, so the whole configuration surface is auditable above and
   * assertable here — including that nothing reads a name twice under two spellings.
   */
  describe('TokenPolicy.fromConfig', () => {
    it('reads exactly the declared names, and nothing else', () => {
      const read: string[] = [];
      const config = {
        get: (name: string) => {
          read.push(name);
          return { JWT_SECRET: 'shared-secret' }[name];
        },
      } as never;

      const policy = TokenPolicy.fromConfig(config);

      expect(read.sort()).toEqual([...TOKEN_POLICY_ENV_NAMES].sort());
      expect(policy.legacyHs256Secret).toBe('shared-secret');
    });

    it('declares the canonical names exactly once, in one list', () => {
      expect(new Set(TOKEN_POLICY_ENV_NAMES).size).toBe(TOKEN_POLICY_ENV_NAMES.length);
      expect(TOKEN_POLICY_ENV_NAMES).toContain('HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS');
      expect(TOKEN_POLICY_ENV_NAMES).toContain('JWT_ASYMMETRIC_PRIVATE_KEY');
    });
  });
});
