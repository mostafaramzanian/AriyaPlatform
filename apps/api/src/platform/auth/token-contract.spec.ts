import {
  DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS,
  DEFAULT_LEGACY_ACCESS_TTL,
  DEFAULT_MAX_PERMISSIONS_PER_TOKEN,
  MAX_PERMISSION_LENGTH,
  PERMISSION_NAME_PATTERN,
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_LEGACY_ALGORITHM,
  canonicalisePermissions,
} from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the token contract's own rules, pinned.
 *
 * This is the file every other part of the seam consumes, so the constants are asserted
 * rather than assumed: the issuer, the two verifiers and the policy must agree on the one
 * audience, the one issuer and the two pinned algorithms. A change to any of them is a
 * change to what the platform accepts, and it has to be a deliberate one.
 */
describe('token contract constants', () => {
  it('pins the issuer and audience that both verifiers compare against', () => {
    expect(TOKEN_ISSUER).toBe('aria-erp-auth');
    expect(TOKEN_AUDIENCE).toBe('aria-erp-api');
  });

  it('pins one asymmetric algorithm and one bridge algorithm', () => {
    expect(TOKEN_ASYMMETRIC_ALGORITHM).toBe('RS256');
    expect(TOKEN_LEGACY_ALGORITHM).toBe('HS256');
  });

  it('documents the ADR-0006 numbers this build ships', () => {
    // §C1(1): the accepted lifetime bound is the number the revocation reasoning depends on.
    expect(DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS).toBe(300);
    // §B4: the perm ceiling, enforced at issuance and at verification.
    expect(DEFAULT_MAX_PERMISSIONS_PER_TOKEN).toBe(200);
    expect(MAX_PERMISSION_LENGTH).toBe(128);
    expect(DEFAULT_LEGACY_ACCESS_TTL).toBe('15m');
  });

  it('accepts dotted permission names and refuses control characters', () => {
    for (const name of ['hr.employees.read', 'blog:write', 'a-b_c', 'ns.one.two']) {
      expect(PERMISSION_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of ['has space', 'line\nbreak', 'quote"d', 'semi;colon', '']) {
      expect(PERMISSION_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

/**
 * `canonicalisePermissions` is shared by the issuer and the verifier, so its behaviour IS
 * the contract between them: whatever the issuer writes, the verifier must read back
 * identically. Each rule below is one line of ADR-0006 §B4.
 */
describe('canonicalisePermissions', () => {
  const max = 3;

  it('treats an absent or null perm as an EMPTY authority set, never as unrestricted', () => {
    expect(canonicalisePermissions(undefined, max)).toEqual({ ok: true, permissions: [] });
    expect(canonicalisePermissions(null, max)).toEqual({ ok: true, permissions: [] });
  });

  it('deduplicates and sorts, so two tokens with the same authority compare equal', () => {
    const result = canonicalisePermissions(['b', 'a', 'b', 'c.permission'], max);

    expect(result).toEqual({ ok: true, permissions: ['a', 'b', 'c.permission'] });
  });

  it('refuses a perm that is not an array rather than guessing it means "none"', () => {
    expect(canonicalisePermissions('hr.employees.read', max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
    expect(canonicalisePermissions({ 0: 'hr.employees.read' }, max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
  });

  it('refuses a non-string, an empty string and an over-long entry', () => {
    expect(canonicalisePermissions(['ok', 7], max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
    expect(canonicalisePermissions(['ok', ''], max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
    expect(canonicalisePermissions(['ok', 'x'.repeat(MAX_PERMISSION_LENGTH + 1)], max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
  });

  it('refuses an entry outside the permission character set (log-injection guard)', () => {
    expect(canonicalisePermissions(['ok', 'bad\nname'], max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
  });

  it('counts DISTINCT entries against the ceiling, and refuses rather than truncating', () => {
    expect(canonicalisePermissions(['a', 'a', 'a'], max)).toEqual({ ok: true, permissions: ['a'] });
    expect(canonicalisePermissions(['a', 'b', 'c'], max)).toEqual({
      ok: true,
      permissions: ['a', 'b', 'c'],
    });
    expect(canonicalisePermissions(['a', 'b', 'c', 'd'], max)).toEqual({
      ok: false,
      reason: 'permissions-exceed-maximum',
    });
  });

  it('accepts an exact-length entry and refuses one longer by a single character', () => {
    const exact = 'a'.repeat(MAX_PERMISSION_LENGTH);

    expect(canonicalisePermissions([exact], max)).toEqual({ ok: true, permissions: [exact] });
    expect(canonicalisePermissions([`${exact}b`], max)).toEqual({
      ok: false,
      reason: 'permissions-malformed',
    });
  });
});
