import { generateKeyPairSync } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { TokenIssuer, TokenIssuanceError } from './token-issuer';
import { TokenPolicy } from './token-policy';
import { TOKEN_AUDIENCE, TOKEN_ISSUER, TOKEN_LEGACY_ALGORITHM } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the one place a token is minted.
 *
 * Two properties are worth testing here and nowhere else:
 *
 *   1. WHILE THE BRIDGE IS OPEN, NOTHING MOVES. The legacy token this class mints must be
 *      byte-compatible with the payload `AuthService` assembled before this phase — same
 *      claim names, same lifetime, no new claims — because every existing verifier and
 *      client keeps running against it. A test that only asserted "a token came back" would
 *      pass while quietly breaking every legacy consumer;
 *   2. ISSUANCE FAILS LOUDLY RATHER THAN DOWNGRADING. A misconfigured asymmetric process
 *      must not fall back to HMAC, must not mint without a `kid`, and must not truncate a
 *      `perm` list to fit the ceiling. Each of those would produce a token whose authority
 *      is not the authority the caller asked for.
 */
describe('TokenIssuer', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  /** The deployment the platform is on today: a shared secret and nothing else. */
  const legacyPolicy = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({ JWT_SECRET: 'shared-secret', ...env });

  /** The target deployment: asymmetric verification, with signing material on the issuer. */
  const asymmetricPolicy = (env: Record<string, string | undefined> = {}) =>
    new TokenPolicy({
      JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_PEM,
      JWT_ASYMMETRIC_PRIVATE_KEY: PRIVATE_PEM,
      JWT_ASYMMETRIC_KEY_ID: 'key-2026-09',
      ...env,
    });

  /**
   * A JwtService with no registered secret: every key must arrive from the call site, so a
   * spec that forgets one fails here exactly as it would in production.
   */
  const issuerFor = (policy: TokenPolicy) => new TokenIssuer(new JwtService({}), policy);

  const decode = (token: string) => new JwtService({}).decode<Record<string, unknown>>(token)!;
  /** A decoded payload's numeric claim, as a number. */
  const numeric = (payload: Record<string, unknown>, claim: string) =>
    Number(payload[claim] as number);
  const headerOf = (token: string) =>
    new JwtService({}).decode<{ header: Record<string, unknown> }>(token, { complete: true })!
      .header;

  describe('on the shared secret (the migration bridge)', () => {
    const issuer = issuerFor(legacyPolicy());

    it('mints exactly the pre-3A payload and nothing more', async () => {
      const issued = await issuer.issueAccessToken({
        sub: 'user-1',
        email: 'user@example.com',
        ver: 3,
      });

      const payload = decode(issued.token);

      // The claim set, as a whole. `tid`, `ver` and `perm` are deliberately absent: they are
      // the asymmetric contract, and a legacy token carrying them would suggest an authority
      // this trust level does not have.
      expect(Object.keys(payload).sort()).toEqual(
        ['aud', 'email', 'exp', 'iat', 'iss', 'sub', 'tokenVersion'].sort(),
      );
      expect(payload.sub).toBe('user-1');
      expect(payload.email).toBe('user@example.com');
      expect(payload.tokenVersion).toBe(3);
      expect(payload.aud).toBe(TOKEN_AUDIENCE);
      expect(payload.iss).toBe(TOKEN_ISSUER);
      expect(headerOf(issued.token).alg).toBe(TOKEN_LEGACY_ALGORITHM);
    });

    it('reports trust and kid for the level it actually minted at', async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', ver: 0 });

      expect(issued.trust).toBe('legacy-hmac');
      expect(issued.kid).toBeNull();
    });

    it("reports the lifetime the token really has, matching today's 15 minutes", async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', ver: 0 });
      const payload = decode(issued.token);

      expect(issued.expiresIn).toBe(900);
      expect(numeric(payload, 'exp') - numeric(payload, 'iat')).toBe(900);
    });

    it('honours a configured legacy lifetime', async () => {
      const issued = await issuerFor(legacyPolicy({ JWT_EXPIRES_IN: '2h' })).issueAccessToken({
        sub: 'user-1',
        ver: 0,
      });

      expect(issued.expiresIn).toBe(7200);
    });

    /**
     * The TTL ceiling belongs to the ASYMMETRIC model (ADR-0006 §C1(1)), and the verifier
     * applies it at asymmetric trust only. A legacy token longer than the ceiling must
     * therefore still be minted, or the bridge would refuse to issue tokens that the bridge
     * is configured to accept.
     */
    it('does not apply the asymmetric TTL ceiling to a legacy token', async () => {
      const policy = legacyPolicy({
        HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS: '300',
        JWT_EXPIRES_IN: '1h',
      });

      const issued = await issuerFor(policy).issueAccessToken({ sub: 'user-1', ver: 0 });

      expect(issued.expiresIn).toBe(3600);
    });

    it('omits the email claim when there is none to display', async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', email: '   ', ver: 0 });

      expect(decode(issued.token)).not.toHaveProperty('email');
    });

    /**
     * No secret is a configuration error, not a reason to mint something unsigned: a token
     * no verifier can check is worse than a failed login, because the failure surfaces at the
     * client instead of at boot.
     */
    it('refuses to mint when no shared secret is configured', async () => {
      const issuerWithoutSecret = issuerFor(new TokenPolicy({}));

      await expect(issuerWithoutSecret.issueAccessToken({ sub: 'user-1', ver: 0 })).rejects.toThrow(
        TokenIssuanceError,
      );
    });
  });

  describe('on RS256 (the target model)', () => {
    const issuer = issuerFor(asymmetricPolicy());

    it('mints the asymmetric claim set, addressed by kid', async () => {
      const issued = await issuer.issueAccessToken({
        sub: 'user-1',
        email: 'user@example.com',
        tid: 'tenant-a',
        ver: 5,
        perm: ['hr.employee.read', 'hr.employee.write'],
      });

      const payload = decode(issued.token);
      const header = headerOf(issued.token);

      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe('key-2026-09');
      expect(payload).toMatchObject({
        sub: 'user-1',
        tid: 'tenant-a',
        ver: 5,
        aud: TOKEN_AUDIENCE,
        iss: TOKEN_ISSUER,
        email: 'user@example.com',
      });
      expect(payload.perm).toEqual(['hr.employee.read', 'hr.employee.write']);
      expect(payload).not.toHaveProperty('tokenVersion');
      expect(issued.trust).toBe('asymmetric');
      expect(issued.kid).toBe('key-2026-09');
    });

    it('canonicalises the perm claim, so the same authority set is comparable', async () => {
      const issued = await issuer.issueAccessToken({
        sub: 'user-1',
        tid: 'tenant-a',
        ver: 1,
        perm: ['hr.b', 'hr.a', 'hr.b'],
      });

      expect(decode(issued.token).perm).toEqual(['hr.a', 'hr.b']);
    });

    it('mints an empty authority set when no permissions are granted', async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1 });

      expect(decode(issued.token).perm).toEqual([]);
    });

    it('never mints a token longer than the accepted maximum', async () => {
      const policy = asymmetricPolicy({
        HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS: '300',
        JWT_ASYMMETRIC_ACCESS_TTL_SECONDS: '300',
      });

      const issued = await issuerFor(policy).issueAccessToken({
        sub: 'user-1',
        tid: 'tenant-a',
        ver: 1,
      });

      expect(issued.expiresIn).toBe(300);
    });

    /**
     * A runtime can be configured to ACCEPT RS256 without holding a signing key. That is a
     * legitimate verifier-only deployment — and the one case where minting must fail rather
     * than fall back to the secret, because a silent downgrade would put a shared-secret
     * token into a fleet that no longer accepts them.
     */
    it('refuses to mint without a signing key, and does not downgrade to HMAC', async () => {
      const verifierOnly = new TokenPolicy({
        JWT_SECRET: 'shared-secret',
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_PEM,
        JWT_ASYMMETRIC_KEY_ID: 'key-2026-09',
      });

      await expect(
        issuerFor(verifierOnly).issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1 }),
      ).rejects.toThrow(/JWT_ASYMMETRIC_PRIVATE_KEY/);
    });

    /**
     * A token without a `kid` cannot be verified after a rotation, and THIS platform's
     * verifier refuses one outright. Minting it would create a token the issuer itself
     * rejects, so the configuration error surfaces at issuance.
     */
    it('refuses to mint without a key id', async () => {
      const noKid = new TokenPolicy({
        JWT_ASYMMETRIC_PUBLIC_KEY: PUBLIC_PEM,
        JWT_ASYMMETRIC_PRIVATE_KEY: PRIVATE_PEM,
      });

      await expect(
        issuerFor(noKid).issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1 }),
      ).rejects.toThrow(/JWT_ASYMMETRIC_KEY_ID/);
    });

    /**
     * `tid` is required at THIS trust level: the verifier rejects an untenanted asymmetric
     * token, so issuing one would be issuing something unusable — and, in a multi-tenant
     * platform, something whose tenant a consumer might be tempted to guess.
     */
    it('refuses to mint an untenanted asymmetric token', async () => {
      await expect(issuer.issueAccessToken({ sub: 'user-1', tid: null, ver: 1 })).rejects.toThrow(
        /tid/,
      );

      await expect(issuer.issueAccessToken({ sub: 'user-1', ver: 1 })).rejects.toThrow(/tid/);
    });

    /**
     * ADR-0006 §B4: exceeding the ceiling is an ISSUANCE error. Truncating would mint a token
     * whose authority is not the authority the caller asked for, and which would fail at a
     * `@Roles(...)` route for reasons no log would explain.
     */
    it('refuses to mint over the permission ceiling rather than truncating', async () => {
      const policy = asymmetricPolicy({ MAX_PERMISSIONS_PER_TOKEN: '2' });

      await expect(
        issuerFor(policy).issueAccessToken({
          sub: 'user-1',
          tid: 'tenant-a',
          ver: 1,
          perm: ['hr.a', 'hr.b', 'hr.c'],
        }),
      ).rejects.toThrow(/more than 2 permissions/);
    });

    it('refuses a perm claim that is not a list of permission names', async () => {
      await expect(
        issuer.issueAccessToken({
          sub: 'user-1',
          tid: 'tenant-a',
          ver: 1,
          perm: ['hr.a\nforged.line'],
        }),
      ).rejects.toThrow(/not a list of permission names/);
    });

    it('omits the email claim when there is none to display', async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1 });

      expect(decode(issued.token)).not.toHaveProperty('email');
    });

    /**
     * Phase 52-ARCH-3C: the same issuance path with the key coming from a SET rather than from
     * a single configured pair. Nothing else may differ — the claim set, the lifetime bound and
     * the refusal to downgrade are unchanged, which is the point of resolving the signing key in
     * `TokenPolicy` instead of at each call site.
     */
    describe('with a signing key set', () => {
      const retiring = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const RETIRING_PUBLIC_PEM = retiring.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();

      const keySetPolicy = (env: Record<string, string | undefined> = {}) =>
        new TokenPolicy({
          JWT_SIGNING_KEYS: JSON.stringify([
            { kid: 'new', privateKey: PRIVATE_PEM, activatedAt: '2026-01-01T00:00:00Z' },
            { kid: 'old', publicKey: RETIRING_PUBLIC_PEM, retireAt: '2099-01-01T00:00:00Z' },
          ]),
          JWT_ACTIVE_KEY_ID: 'new',
          ...env,
        });

      it('mints with the ACTIVE key and names it in the header', async () => {
        const issued = await issuerFor(keySetPolicy()).issueAccessToken({
          sub: 'user-1',
          tid: 'tenant-a',
          ver: 7,
          perm: ['hr.employee.read'],
        });

        expect(headerOf(issued.token)).toMatchObject({ alg: 'RS256', kid: 'new' });
        expect(issued.kid).toBe('new');
        expect(decode(issued.token)).toMatchObject({ sub: 'user-1', tid: 'tenant-a', ver: 7 });
      });

      it('signs with the key whose public half this platform publishes', async () => {
        const issued = await issuerFor(keySetPolicy()).issueAccessToken({
          sub: 'user-1',
          tid: 'tenant-a',
          ver: 1,
        });

        // Signing with one key while publishing another is the failure a key set exists to make
        // impossible, so the verification here uses the PUBLIC half a verifier would hold.
        expect(() =>
          new JwtService({}).verify(issued.token, {
            algorithms: ['RS256'],
            publicKey: PUBLIC_PEM,
          })
        ).not.toThrow();
      });

      it('refuses to mint when the active entry holds no private half, naming the key set', async () => {
        const verifierOnly = new TokenPolicy({
          JWT_SIGNING_KEYS: JSON.stringify([{ kid: 'new', publicKey: PUBLIC_PEM }]),
        });

        await expect(
          issuerFor(verifierOnly).issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1 })
        ).rejects.toThrow(/JWT_SIGNING_KEYS/);
      });
    });
  });

  describe('input discipline, applied before anything is signed', () => {
    const issuer = issuerFor(asymmetricPolicy());

    it('refuses a missing or empty subject', async () => {
      await expect(issuer.issueAccessToken({ sub: '', tid: 'tenant-a', ver: 1 })).rejects.toThrow(
        /sub/,
      );
    });

    it('refuses an implausibly long subject rather than putting it in a claim', async () => {
      await expect(
        issuer.issueAccessToken({ sub: 'u'.repeat(129), tid: 'tenant-a', ver: 1 }),
      ).rejects.toThrow(/implausibly long/);
    });

    it('refuses a version that is not a non-negative whole number', async () => {
      await expect(
        issuer.issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 1.5 }),
      ).rejects.toThrow(/version/);

      await expect(
        issuer.issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: -1 }),
      ).rejects.toThrow(/version/);
    });

    /** Version 0 is the ordinary "never bumped" state of a fresh row, not an error. */
    it('accepts version zero', async () => {
      const issued = await issuer.issueAccessToken({ sub: 'user-1', tid: 'tenant-a', ver: 0 });

      expect(decode(issued.token).ver).toBe(0);
    });
  });
});
