import { CorePermissionSource } from '../services/core-permission-source';
import type { TrustedTokenClaims } from '../../../platform/auth/token-contract';

/**
 * Phase 51-HR-ARCH-3A: Core's permission binding, pinned.
 *
 * `RolesGuard` asks this class for every authorization decision in the combined runtime, so
 * these tests are about the ONE RULE the class exists to encode: an asymmetric token's
 * permissions are its `perm` claim and nothing else — Core's catalogue is never consulted on
 * that path — while a legacy token is answered from Core exactly as before this phase.
 */
describe('CorePermissionSource', () => {
  const makePermissions = () => ({
    getUserPermissions: jest.fn(async () => ['catalogue.read'] as string[]),
  });

  let permissions: ReturnType<typeof makePermissions>;
  let source: CorePermissionSource;

  beforeEach(() => {
    permissions = makePermissions();
    source = new CorePermissionSource(permissions as never);
  });

  it('answers from the perm claim at asymmetric trust, without reading the catalogue', async () => {
    await expect(
      source.getEffectivePermissions('u1', claims({ perm: ['hr.employees.read'] })),
    ).resolves.toEqual(['hr.employees.read']);

    expect(permissions.getUserPermissions).not.toHaveBeenCalled();
  });

  it('does NOT fall back to the catalogue when an asymmetric token has no permissions', async () => {
    // The failure mode that would be catastrophic and silent: a valid RS256 token minted
    // with an empty authority set receiving Core's catalogue answer instead of nothing.
    // "The claim is empty" and "there is no claim" must not be the same code path.
    await expect(source.getEffectivePermissions('u1', claims({ perm: [] }))).resolves.toEqual([]);

    expect(permissions.getUserPermissions).not.toHaveBeenCalled();
  });

  it('IGNORES the perm claim on a legacy-hmac token and asks Core', async () => {
    // A holder of the shared secret can write any `perm` list into a token, so on the bridge
    // the catalogue remains the authority — which is also exactly the pre-migration answer.
    await expect(
      source.getEffectivePermissions(
        'u1',
        claims({ trust: 'legacy-hmac', perm: ['users.read', 'hr.employees.read'] }),
      ),
    ).resolves.toEqual(['catalogue.read']);

    expect(permissions.getUserPermissions).toHaveBeenCalledWith('u1');
  });

  it('asks Core when there is no verified token at all', async () => {
    // The documented meaning of `claims === null`: "Core is the authority", never "no
    // permissions". It is the issuance path's answer — `AuthService` is ASSEMBLING the
    // permissions, so there is nothing to read them from yet — and a direct controller call
    // in a test behaves the same way.
    await expect(source.getEffectivePermissions('u1', null)).resolves.toEqual(['catalogue.read']);

    expect(permissions.getUserPermissions).toHaveBeenCalledWith('u1');
  });

  it('hands back a copy on the claim path, so a caller cannot mutate verified claims', async () => {
    const verified = claims({ perm: ['hr.employees.read'] });

    const result = await source.getEffectivePermissions('u1', verified);
    result.push('users.delete');

    expect(verified.perm).toEqual(['hr.employees.read']);
  });

  it('propagates a catalogue failure rather than reporting an empty set', async () => {
    // Either way the request is denied — `RolesGuard` turns any non-Forbidden failure into a
    // 403 "Permission check failed" — but swallowing the error would make a Core outage look
    // like a user who simply lacks the permission, and hide the incident.
    permissions.getUserPermissions.mockRejectedValue(new Error('catalogue unavailable'));

    await expect(source.getEffectivePermissions('u1', claims({ trust: 'legacy-hmac' }))).rejects.toThrow(
      'catalogue unavailable',
    );
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