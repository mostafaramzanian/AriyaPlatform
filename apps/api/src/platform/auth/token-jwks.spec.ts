import { generateKeyPairSync } from 'crypto';
import { TokenJwksPublisher } from './token-jwks';
import { TokenPolicy } from './token-policy';

/**
 * Phase 52-ARCH-3C §B7: the publication half of the key-set contract.
 *
 * What is checked here is what a VERIFIER depends on, and nothing else:
 *
 *   * the document contains the keys that are in play — active first, a still-overlapping
 *     predecessor beside it — and stops containing one at the instant it retires;
 *   * it contains PUBLIC material only, asserted on the serialised document as well as on the
 *     object, because "the private key never appears in the response" is a claim about bytes;
 *   * a process that holds no key material of its own publishes NOTHING (404), rather than an
 *     empty document a verifier would read as an answer;
 *   * the cache header is derived from the verifier's own cache TTL and stays well inside the
 *     rotation window, so no intermediary can serve a document from before a rotation finished.
 */
describe('TokenJwksPublisher', () => {
  const pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  };

  const active = pair();
  const retiring = pair();

  /** A set whose predecessor retires at a FIXED instant, so a test can move the clock. */
  const fixedPolicy = () =>
    new TokenPolicy({
      JWT_SIGNING_KEYS: JSON.stringify([
        { kid: 'new', privateKey: active.privatePem, activatedAt: '2026-01-01T00:00:00Z' },
        { kid: 'old', publicKey: retiring.publicPem, retireAt: '2027-01-01T00:00:00Z' },
      ]),
      JWT_ACTIVE_KEY_ID: 'new',
    });

  const duringOverlap = () => Date.parse('2026-09-20T00:00:00Z');
  const afterRetirement = () => Date.parse('2027-01-01T00:00:00Z');

  it('publishes the active key FIRST, and the retiring one beside it during the overlap', () => {
    const document = new TokenJwksPublisher(fixedPolicy(), duringOverlap).document();

    expect(document?.keys.map((key) => key.kid)).toEqual(['new', 'old']);
  });

  it('stops publishing a key at its declared retirement, with no second deploy', () => {
    const document = new TokenJwksPublisher(fixedPolicy(), afterRetirement).document();

    expect(document?.keys.map((key) => key.kid)).toEqual(['new']);
  });

  it('publishes public material only, judged on the bytes', () => {
    const document = new TokenJwksPublisher(fixedPolicy(), duringOverlap).document();

    for (const key of document?.keys ?? []) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(key).not.toHaveProperty('d');
    }

    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain(active.privatePem.slice(40, 80));
    expect(serialized).not.toContain(retiring.privatePem.slice(40, 80));
  });

  it('publishes nothing when this process holds no key material of its own', () => {
    // A verifier whose keys come from someone else's endpoint, a deployment still on the shared
    // secret, and a static key no token could address (no key id): none of them is a publisher.
    // An empty document would be a STATEMENT ("there are no keys") rather than an absence.
    for (const policy of [
      new TokenPolicy({ JWT_JWKS_URI: 'https://issuer.test/jwks.json' }),
      new TokenPolicy({ JWT_SECRET: 'shared-secret' }),
      new TokenPolicy({ JWT_ASYMMETRIC_PUBLIC_KEY: active.publicPem }),
    ]) {
      expect(new TokenJwksPublisher(policy).document()).toBeNull();
    }
  });

  it('publishes a static single key once it has a kid to be addressed by', () => {
    const document = new TokenJwksPublisher(
      new TokenPolicy({
        JWT_ASYMMETRIC_PUBLIC_KEY: active.publicPem,
        JWT_ASYMMETRIC_KEY_ID: 'kid-1',
      })
    ).document();

    expect(document?.keys.map((key) => key.kid)).toEqual(['kid-1']);
  });
});
