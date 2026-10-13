import { TokenPermissionSource } from './token-permission-source';
import type { TrustedTokenClaims } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the claim-only permission source, pinned.
 *
 * The property this spec defends is ADR-0006 §D's: at asymmetric trust the `perm` claim IS
 * the authority, so no Core query happens — and a legacy token, whose `perm` claim its
 * holder could have written themselves, gets NOTHING rather than that claim.
 */
describe('TokenPermissionSource', () => {
  const source = new TokenPermissionSource();

  it('returns exactly the perm claim at asymmetric trust', async () => {
    await expect(
      source.getEffectivePermissions('u1', claims({ perm: ['hr.employees.read', 'hr.leave.approve'] })),
    ).resolves.toEqual(['hr.employees.read', 'hr.leave.approve']);
  });

  it('does not expand, infer or widen the claim', async () => {
    // No role → permission expansion, no "admin implies everything": what the issuer signed
    // is what the guard sees. An empty list therefore denies every @Roles(...) route.
    await expect(source.getEffectivePermissions('u1', claims({ perm: [] }))).resolves.toEqual([]);
    await expect(source.getEffectivePermissions('u1', claims({ perm: ['hr.employees.read'] }))).resolves.toEqual(
      ['hr.employees.read'],
    );
  });

  it('IGNORES the perm claim on a legacy-hmac token', async () => {
    // The whole point of routing on the VERIFIED TRUST LEVEL rather than on "is the claim
    // present": a holder of the shared secret can put any list in `perm`, and that list must
    // authorize nothing here.
    await expect(
      source.getEffectivePermissions(
        'u1',
        claims({ trust: 'legacy-hmac', perm: ['users.read', 'hr.employees.read'] }),
      ),
    ).resolves.toEqual([]);
  });

  it('returns nothing when there is no verified token', async () => {
    await expect(source.getEffectivePermissions('u1', null)).resolves.toEqual([]);
  });

  it('hands back a copy, so a caller cannot mutate the verified claims', async () => {
    const verified = claims({ perm: ['hr.employees.read'] });

    const result = await source.getEffectivePermissions('u1', verified);
    result.push('users.delete');

    // Not merely "the list is unchanged" — the returned array must not BE the claim's array,
    // because the guard's callers and the request context share this value, and an
    // authorization input that any layer can mutate is not an authorization input. (That the
    // verifier's own array is also frozen is asserted at the verifier, where it is produced.)
    expect(result).not.toBe(verified.perm);
    expect(verified.perm).toEqual(['hr.employees.read']);
  });

  it('has no dependencies at all', async () => {
    // The structural half of "an extracted runtime authorizes from the token": a source that
    // held a Prisma client, a cache or Core's catalogue would take one as a constructor
    // argument. Arity 0 is the check that it does not, and cannot start to quietly.
    expect(TokenPermissionSource.length).toBe(0);
  });
});

/** Verified claims as the platform verifier would produce them. */
function claims(overrides: Partial<TrustedTokenClaims> = {}): TrustedTokenClaims {
  const iat = Math.floor(Date.now() / 1000);
  return {
    trust: 'asymmetric',
    sub: 'u1',
    tid: 'tenant-1',
    ver: 1,
    perm: [],
    email: null,
    iat,
    nbf: iat,
    exp: iat + 900,
    ttlSeconds: 900,
    kid: 'test-key',
    ...overrides,
  };
}