import { CoreTenantResolver } from './core-tenant-resolver';
import type { TrustedTokenClaims } from '../platform/auth/token-contract';

/**
 * Phase 51-HR-ARCH-3A: Core's tenant binding, pinned.
 *
 * This is the class that used to be an unconditional `User.findUnique` on every authenticated
 * request. The tests below are therefore mostly about the QUERY THAT MUST NOT HAPPEN: at
 * asymmetric trust the `tid` claim answers, and `userId` being available is not a reason to
 * look it up again — including when the claim says there is no tenant, where falling back to
 * the database would be exactly the wrong answer.
 */
describe('CoreTenantResolver', () => {
  const makePrisma = () => ({
    user: {
      findUnique: jest.fn(async () => null as { tenantId: string | null } | null),
    },
  });

  let prisma: ReturnType<typeof makePrisma>;
  let resolver: CoreTenantResolver;

  beforeEach(() => {
    prisma = makePrisma();
    resolver = new CoreTenantResolver(prisma as never);
  });

  it('resolves the tenant from the claim at asymmetric trust, without reading Core', async () => {
    await expect(resolver.resolve({ userId: 'u1', claims: claims({ tid: 'tenant-7' }) })).resolves.toEqual({
      tenantId: 'tenant-7',
      source: 'claim',
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('reports no tenant for an untenanted asymmetric token instead of falling back to Core', async () => {
    // The subtle hole this closes: the `sub` IS a user id, so a resolver written as
    // "use the claim if it is there, otherwise query" would silently resolve a tenant for a
    // token whose issuer deliberately minted none.
    await expect(resolver.resolve({ userId: 'u1', claims: claims({ tid: null }) })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('queries Core for a legacy-hmac token, with the narrow projection', async () => {
    // The bridge, unchanged from before this phase: a shared-secret token is not
    // claim-authoritative, so Core answers. The projection is asserted because a resolver
    // that fetched the whole user row would be a fresh data-exposure surface.
    prisma.user.findUnique.mockResolvedValue({ tenantId: 'tenant-a' });

    await expect(resolver.resolve({ userId: 'u1', claims: claims({ trust: 'legacy-hmac', tid: 'ignored' }) }))
      .resolves.toEqual({ tenantId: 'tenant-a', source: 'core-database' });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { tenantId: true },
    });
  });

  it('reports no tenant when a legacy token names a subject Core does not know', async () => {
    // `source` says the query HAPPENED even though the answer is null: "no tenant because
    // there is no such user" and "no tenant because nothing was asked" are different facts,
    // and only one of them is a data problem.
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(resolver.resolve({ userId: 'ghost', claims: claims({ trust: 'legacy-hmac' }) })).resolves.toEqual({
      tenantId: null,
      source: 'core-database',
    });
  });

  it('does not query Core without a subject to query for', async () => {
    await expect(resolver.resolve({ userId: null, claims: null })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });
    await expect(resolver.resolve({ userId: null, claims: claims({ trust: 'legacy-hmac' }) })).resolves.toEqual({
      tenantId: null,
      source: 'none',
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
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