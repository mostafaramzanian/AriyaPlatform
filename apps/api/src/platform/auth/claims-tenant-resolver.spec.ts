import { ClaimsTenantResolver } from './claims-tenant-resolver';
import type { TrustedTokenClaims } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the claim-only tenant resolver, pinned.
 *
 * This is what a standalone business runtime binds, so the tests are about what it REFUSES
 * as much as what it resolves: a shared-secret token's `tid` is ignored (it is not
 * claim-authoritative), an untenanted token resolves to NO tenant rather than a guess, and
 * the class cannot reach a database because it has nothing to reach it with.
 */
describe('ClaimsTenantResolver', () => {
  const resolver = new ClaimsTenantResolver();

  it('resolves the tenant from the tid claim at asymmetric trust', async () => {
    await expect(resolver.resolve({ userId: 'u1', claims: claims({ tid: 'tenant-7' }) })).resolves.toEqual({
      tenantId: 'tenant-7',
      source: 'claim',
    });
  });

  it('resolves no tenant when an asymmetric token carries no tid', async () => {
    await expect(resolver.resolve({ userId: 'u1', claims: claims({ tid: null }) })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });
  });

  it('treats an empty tid claim as no tenant rather than as a tenant named ""', async () => {
    // An empty string reaching `RequestContextService` would be a tenant that no row can
    // match: every scoped query would return nothing, silently, instead of refusing.
    await expect(resolver.resolve({ userId: 'u1', claims: claims({ tid: '' }) })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });
  });

  it('IGNORES a tid claim on a legacy-hmac token', async () => {
    // The property that stops a shared-secret holder from choosing their own tenant: the
    // claim is only authoritative at asymmetric trust, and this resolver has no other
    // authority to consult — so the answer is "no tenant", which closes rather than opens.
    await expect(
      resolver.resolve({ userId: 'u1', claims: claims({ tid: 'attacker-tenant', trust: 'legacy-hmac' }) }),
    ).resolves.toEqual({ tenantId: null, source: 'none' });
  });

  it('resolves no tenant when the request has no verified claims', async () => {
    await expect(resolver.resolve({ userId: 'u1', claims: null })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });
  });

  it('never throws, whatever it is handed', async () => {
    // The port's contract: "no tenant" is a VALUE. `resolveHrActor` and the HR middleware are
    // what refuse an untenanted request, so a throw here would move a 403 into a 500.
    const inputs = [
      { userId: null, claims: null },
      { userId: 'u1', claims: null },
      { userId: null, claims: claims({ tid: 'tenant-7' }) },
      { userId: 'u1', claims: claims({ tid: 'tenant-7', trust: 'legacy-hmac' }) },
    ];

    for (const input of inputs) {
      await expect(resolver.resolve(input)).resolves.toHaveProperty('source');
    }
  });

  it('has no dependencies at all', async () => {
    // Structural, not incidental: a resolver that needed a database (or a user directory, or
    // a cache) would take it as a constructor argument. Arity 0 is what makes "an extracted
    // runtime resolves its tenant without Core" true by construction.
    expect(ClaimsTenantResolver.length).toBe(0);
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
