import { generateKeyPairSync } from 'crypto';
import { TOKEN_ROTATION_OVERLAP_SECONDS } from './token-contract';
import { TokenPolicyError } from './token-policy';
import {
  MIN_RSA_MODULUS_BITS,
  assertRotationOverlap,
  isRetired,
  parseSigningKeys,
  toPublishedJwk,
  type TokenSigningKey,
} from './token-signing-keys';

/**
 * Phase 52-ARCH-3C: the signing key set, pinned.
 *
 * Every test here is about a configuration that must not survive a boot, or a value a verifier
 * must be able to rely on:
 *
 *   * a key set that is not coherent is refused AT BOOT, because discovering it at the first
 *     login means shipping a deployment that cannot mint or cannot verify;
 *   * the rotation window is CHECKED against `TOKEN_ROTATION_OVERLAP_SECONDS`, so "we keep the
 *     old key for 15 minutes" is a value rather than a hope;
 *   * the published projection carries PUBLIC material only, and it is built field by field.
 */
describe('token signing keys', () => {
  const keyPair = (modulusLength: number = MIN_RSA_MODULUS_BITS) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
    return {
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  };

  const first = keyPair();
  const second = keyPair();
  const HOUR_MS = 3_600_000;
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const parseOne = (entry: unknown) => parseSigningKeys(JSON.stringify([entry]));

  describe('reading the configuration', () => {
    it('treats an unset or blank variable as no key set at all', () => {
      // The same rule the rest of the token configuration follows: an empty `.env` line is an
      // ABSENT value, never an empty key set that would mean "verify with nothing".
      expect(parseSigningKeys(undefined)).toEqual([]);
      expect(parseSigningKeys('   ')).toEqual([]);
    });

    it('parses a signing entry and derives the public half from the private one', () => {
      const keys = parseOne({ kid: 'a', privateKey: first.privatePem });

      expect(keys).toHaveLength(1);
      expect(keys[0].kid).toBe('a');
      // The stored form is the CANONICAL one (trimmed), not a copy of the raw configuration:
      // a PEM read from an `.env` file arrives with the surrounding whitespace dotenv leaves.
      expect(keys[0].privatePem).toBe(first.privatePem.trim());
      // Derived, not configured: an operator cannot publish a key other than the one it signs
      // with, and does not have to keep two copies in agreement by hand.
      expect(keys[0].publicPem).toContain('BEGIN PUBLIC KEY');
      expect(keys[0].activatedAtMs).toBeNull();
      expect(keys[0].retireAtMs).toBeNull();
    });

    it('accepts a public-only entry, for a runtime that may not sign', () => {
      const keys = parseOne({ kid: 'a', publicKey: first.publicPem });

      expect(keys[0].privatePem).toBeNull();
      expect(keys[0].publicPem).toContain('BEGIN PUBLIC KEY');
    });

    it('accepts a pair, and normalises it the same way either spelling does', () => {
      const keys = parseOne({
        kid: 'a',
        publicKey: first.publicPem,
        privateKey: first.privatePem,
      });

      // SPKI PEM is the one normal form, so the configured public half and the derived one are
      // the same string; a mismatch is refused separately below.
      expect(keys[0].publicPem).toBe(
        parseOne({ kid: 'a', privateKey: first.privatePem })[0].publicPem
      );
    });

    it('carries the declared activation window', () => {
      const activatedAt = iso(-HOUR_MS);
      const retireAt = iso(HOUR_MS);
      const keys = parseOne({ kid: 'a', privateKey: first.privatePem, activatedAt, retireAt });

      expect(keys[0].activatedAtMs).toBe(Date.parse(activatedAt));
      expect(keys[0].retireAtMs).toBe(Date.parse(retireAt));
    });

    it('keeps several keys, in declaration order, with their index recorded', () => {
      const keys = parseSigningKeys(
        JSON.stringify([
          { kid: 'new', privateKey: first.privatePem },
          { kid: 'old', publicKey: second.publicPem },
        ])
      );

      expect(keys.map((key) => key.kid)).toEqual(['new', 'old']);
      // The index is what a refusal names, so it must survive parsing.
      expect(keys.map((key) => key.index)).toEqual([0, 1]);
    });
  });

  describe('configuration this contract cannot honour', () => {
    /** The refusal an entry produces, or null when it is accepted. */
    const refusalOf = (entry: unknown): TokenPolicyError | null => {
      try {
        parseOne(entry);
        return null;
      } catch (error) {
        return error as TokenPolicyError;
      }
    };

    const refusesWith = (entry: unknown, pattern: RegExp): string => {
      const error = refusalOf(entry);

      expect(error?.name).toBe('TokenPolicyError');
      expect(error?.message).toMatch(pattern);

      return error?.message ?? '';
    };

    it('refuses a value that is not JSON at all', () => {
      expect(() => parseSigningKeys('not json')).toThrow(/not valid JSON/);
    });

    it('refuses a set that is not a non-empty array', () => {
      expect(() => parseSigningKeys('{}')).toThrow(/non-empty JSON array/);
      expect(() => parseSigningKeys('[]')).toThrow(/non-empty JSON array/);
    });

    it('refuses an entry that is not an object', () => {
      refusesWith('kid-a', /must be an object/);
      refusesWith(['kid-a'], /must be an object/);
      refusesWith(null, /must be an object/);
    });

    it('refuses a field nothing reads, so a misspelling cannot weaken an entry', () => {
      // `retire` instead of `retireAt` would otherwise leave a key that never retires, and the
      // operator would have no way to tell from the configuration they wrote.
      refusesWith(
        { kid: 'a', privateKey: first.privatePem, retire: iso(HOUR_MS) },
        /unknown field/
      );
    });

    it('refuses a missing, blank or unloggable kid', () => {
      refusesWith({ privateKey: first.privatePem }, /kid is required/);
      refusesWith({ kid: '   ', privateKey: first.privatePem }, /kid is required/);
      refusesWith({ kid: 'a b', privateKey: first.privatePem }, /may contain letters/);
      refusesWith({ kid: 'x'.repeat(129), privateKey: first.privatePem }, /longer than 128/);
    });

    it('refuses the same kid twice', () => {
      expect(() =>
        parseSigningKeys(
          JSON.stringify([
            { kid: 'a', publicKey: first.publicPem },
            { kid: 'a', publicKey: second.publicPem },
          ])
        )
      ).toThrow(/more than once/);
    });

    it('refuses private material in the public field', () => {
      refusesWith({ kid: 'a', publicKey: first.privatePem }, /PRIVATE key material/);
    });

    it('refuses material that is not the PEM its field promises', () => {
      refusesWith({ kid: 'a', publicKey: 'not-a-pem' }, /must be a PEM-encoded public key/);
      refusesWith({ kid: 'a', privateKey: 'not-a-pem' }, /must be a PEM-encoded private key/);
      refusesWith({ kid: 'a' }, /neither "publicKey" nor "privateKey"/);
    });

    it('refuses a public key that is not the public half of the private one', () => {
      // The one mistake that is invisible in a configuration diff and surfaces as every verifier
      // reporting "signature-invalid".
      refusesWith(
        { kid: 'a', privateKey: first.privatePem, publicKey: second.publicPem },
        /not the public half/
      );
    });

    it('refuses a key that is not RSA at all', () => {
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();

      refusesWith({ kid: 'a', privateKey: ec }, /not an RSA key/);
    });

    it('refuses an RSA key below the ADR floor instead of accepting what parses', () => {
      const weak = keyPair(1024);

      refusesWith({ kid: 'a', privateKey: weak.privatePem }, /requires at least 2048 bits/);
      refusesWith({ kid: 'a', publicKey: weak.publicPem }, /requires at least 2048 bits/);
    });

    it('never echoes key material in a refusal', () => {
      // A boot log is shipped, indexed and read by people who are not operators of this secret,
      // so a refusal quotes the field and the size and nothing else.
      const weak = keyPair(1024);
      const sized = refusesWith({ kid: 'a', privateKey: weak.privatePem }, /2048/);

      expect(sized).not.toContain('BEGIN');
      expect(sized).not.toContain(weak.privatePem.slice(40, 80));

      const unreadable = refusesWith(
        {
          kid: 'a',
          privateKey: '-----BEGIN PRIVATE KEY-----\nZZZZ\n-----END PRIVATE KEY-----',
        },
        /could not be read/
      );
      expect(unreadable).not.toContain('ZZZZ');
    });

    it('refuses a timestamp that is not an instant, and a window that runs backwards', () => {
      refusesWith({ kid: 'a', privateKey: first.privatePem, retireAt: 'next tuesday' }, /ISO-8601/);
      refusesWith(
        {
          kid: 'a',
          privateKey: first.privatePem,
          activatedAt: iso(HOUR_MS),
          retireAt: iso(-HOUR_MS),
        },
        /must be later than/
      );
    });
  });

  describe('the rotation window (§B8)', () => {
    const entry = (
      kid: string,
      activatedAtMs: number | null,
      retireAtMs: number | null
    ): TokenSigningKey => ({
      kid,
      publicPem: first.publicPem,
      privatePem: null,
      activatedAtMs,
      retireAtMs,
      index: 0,
    });

    const now = Date.now();

    it('accepts a window exactly at the policy floor', () => {
      const activatedAtMs = now - 1_000;
      const entries = [
        entry('new', activatedAtMs, null),
        entry('old', null, activatedAtMs + TOKEN_ROTATION_OVERLAP_SECONDS * 1000),
      ];

      expect(() => assertRotationOverlap(entries, 'new', now)).not.toThrow();
    });

    it('accepts a window LONGER than the floor — a slow rotation is not a defect', () => {
      const activatedAtMs = now - 1_000;
      const entries = [
        entry('new', activatedAtMs, null),
        entry('old', null, activatedAtMs + 10 * TOKEN_ROTATION_OVERLAP_SECONDS * 1000),
      ];

      expect(() => assertRotationOverlap(entries, 'new', now)).not.toThrow();
    });

    it('refuses a window shorter than the floor, naming the policy', () => {
      const activatedAtMs = now - 1_000;
      const entries = [
        entry('new', activatedAtMs, null),
        entry('old', null, activatedAtMs + (TOKEN_ROTATION_OVERLAP_SECONDS - 1) * 1000),
      ];

      expect(() => assertRotationOverlap(entries, 'new', now)).toThrow(/requires at least 900s/);
    });

    it('refuses a non-active key with no retireAt — an unbounded acceptance window', () => {
      expect(() =>
        assertRotationOverlap([entry('new', null, null), entry('old', null, null)], 'new', now)
      ).toThrow(/declares no retireAt/);
    });

    it('refuses a retireAt on the ACTIVE key', () => {
      expect(() => assertRotationOverlap([entry('new', null, now + HOUR_MS)], 'new', now)).toThrow(
        /active signing key/
      );
    });

    it('refuses a live predecessor whose window cannot be measured', () => {
      expect(() =>
        assertRotationOverlap(
          [entry('new', null, null), entry('old', null, now + HOUR_MS)],
          'new',
          now
        )
      ).toThrow(/"activatedAt"/);
    });

    it('leaves an already-retired key alone, because it is out of the acceptance path', () => {
      // History is not re-litigated: a key whose window closed is not published and not accepted
      // (that is `isRetired`'s job), so a past window is not a reason to refuse to boot.
      const entries = [entry('new', now - HOUR_MS, null), entry('old', null, now - 1_000)];

      expect(() => assertRotationOverlap(entries, 'new', now)).not.toThrow();
    });

    it('checks an empty set as nothing to verify', () => {
      expect(() => assertRotationOverlap([], null, now)).not.toThrow();
    });

    it('gives a VERIFICATION-ONLY set no window it has no use for', () => {
      // A business runtime holding the platform's public keys designates no signer, so it is not
      // a rotation in progress and is not made to declare retirement for keys it only ever
      // verifies. A window it DOES declare is still honoured (see `isRetired`).
      expect(() => assertRotationOverlap([entry('only', null, null)], null, now)).not.toThrow();
    });
  });

  describe('retirement', () => {
    const retiring = (retireAtMs: number | null): TokenSigningKey => ({
      kid: 'a',
      publicPem: first.publicPem,
      privatePem: null,
      activatedAtMs: null,
      retireAtMs,
      index: 0,
    });

    it('is false inside the window, and true from the declared instant on', () => {
      const retireAtMs = Date.parse(iso(HOUR_MS));

      expect(isRetired(retiring(retireAtMs), retireAtMs - 1)).toBe(false);
      expect(isRetired(retiring(retireAtMs), retireAtMs)).toBe(true);
      expect(isRetired(retiring(retireAtMs), retireAtMs + 1)).toBe(true);
    });

    it('is false for a key that declares no retirement', () => {
      expect(isRetired(retiring(null), Date.parse('2099-01-01T00:00:00Z'))).toBe(false);
    });
  });

  describe('what leaves the process', () => {
    it('publishes the public fields of one key and nothing else', () => {
      const jwk = toPublishedJwk('a', first.publicPem);

      expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(jwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'a' });
      expect(jwk.n.length).toBeGreaterThan(0);
      expect(jwk.e.length).toBeGreaterThan(0);
      // `d` is the private exponent. There is no path by which one could appear, because the
      // object is built field by field rather than spread from the library's export.
      expect(jwk).not.toHaveProperty('d');
    });

    it('refuses to project a key that is not RSA', () => {
      const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString();

      expect(() => toPublishedJwk('a', ec)).toThrow(/not an RSA key/);
    });

    it('refuses to project unreadable material instead of publishing something empty', () => {
      expect(() => toPublishedJwk('a', 'not-a-key')).toThrow(TokenPolicyError);
    });
  });
});
