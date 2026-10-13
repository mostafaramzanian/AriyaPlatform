import {
  MIN_SECRET_LENGTH,
  SIGNATURE_WINDOW_MS,
  isSecretExpired,
  moduleCanonicalRequest,
  signModuleRequest,
  verifyModuleRequest,
} from './module-signature';
import { canonicalRequest } from '../integrations/integration-signature';

/**
 * Phase 49M §19: module authentication.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - THE SCHEME IS 49L's, NOT A SECOND ONE. The canonical string produced here is asserted to be
 *    byte-identical to what 49L's `canonicalRequest` produces for the same material — so there is
 *    demonstrably one canonicalisation in the codebase, not two that happen to agree today.
 *  - THE MODULE ID IS COVERED. A signature made for module A does not verify for module B, even
 *    with the same secret, body and timestamp. That is what stops a captured request being
 *    replayed at a different module.
 *  - THE TENANT IS COVERED, INCLUDING `null`. Re-signing as a different tenant fails, and — the
 *    subtler one — a tenant-less request and a tenant-bearing one produce different signatures, so
 *    stripping the tenant is detected rather than silently accepted.
 *  - SPLICING IS IMPOSSIBLE. Values cannot be rearranged into a different (moduleId, requestId)
 *    pair with the same signature.
 *  - THE WINDOW AND THE CONSTANT-TIME COMPARISON ARE 49L's, exercised here so a future change to
 *    either is caught by this phase's suite too.
 */

const SECRET = 'k'.repeat(MIN_SECRET_LENGTH);

const material = (overrides: Record<string, unknown> = {}) => ({
  method: 'POST',
  path: '/api/v1/module/v1/invoke',
  timestamp: '1780000000000',
  identity: { moduleId: 'finance', requestId: 'req-1', tenantId: 'tenant-1' as string | null },
  body: JSON.stringify({ operation: 'invoice.read', payload: { id: 'x' } }),
  ...overrides,
});

describe('module signature canonicalisation', () => {
  it('produces exactly what 49L would produce for the same material', () => {
    // THE ANTI-DUPLICATION ASSERTION. If somebody re-implements canonicalisation in this phase,
    // this test fails even if the new implementation is internally consistent.
    const input = material();

    expect(moduleCanonicalRequest(input)).toBe(
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp: input.timestamp,
        eventId: 'finance:req-1',
        idempotencyKey: 't:tenant-1',
        body: input.body,
      }),
    );
  });

  it('length-prefixes every field, so a separator in a value cannot splice', () => {
    const spliced = moduleCanonicalRequest(
      material({ identity: { moduleId: 'a-b', requestId: 'c', tenantId: null } }),
    );
    const other = moduleCanonicalRequest(
      material({ identity: { moduleId: 'a', requestId: 'b-c', tenantId: null } }),
    );

    expect(spliced).not.toBe(other);
  });

  it('distinguishes a tenant-less call from a tenant-bearing one', () => {
    const withTenant = moduleCanonicalRequest(material());
    const withoutTenant = moduleCanonicalRequest(
      material({ identity: { moduleId: 'finance', requestId: 'req-1', tenantId: null } }),
    );

    expect(withTenant).not.toBe(withoutTenant);
  });

  it('cannot be collided by a tenant literally named like the null marker', () => {
    // The `t:` prefix is what makes this safe: a tenant called `-` is `t:-`, not `-`.
    const nullTenant = moduleCanonicalRequest(
      material({ identity: { moduleId: 'finance', requestId: 'req-1', tenantId: null } }),
    );
    const dashTenant = moduleCanonicalRequest(
      material({ identity: { moduleId: 'finance', requestId: 'req-1', tenantId: '-' } }),
    );

    expect(nullTenant).not.toBe(dashTenant);
  });
});

describe('verifyModuleRequest', () => {
  const now = 1_780_000_000_000;

  it('accepts a signature it produced', () => {
    const input = material({ timestamp: String(now) });
    const signature = signModuleRequest(SECRET, input);

    expect(verifyModuleRequest(SECRET, input, signature, now)).toEqual({ ok: true });
  });

  it('rejects a signature made for a DIFFERENT module', () => {
    // The replay-across-modules case. Same secret, same body, same timestamp, different target.
    const signed = signModuleRequest(SECRET, material({ timestamp: String(now) }));

    const replayed = verifyModuleRequest(
      SECRET,
      material({
        timestamp: String(now),
        identity: { moduleId: 'other', requestId: 'req-1', tenantId: 'tenant-1' },
      }),
      signed,
      now,
    );

    expect(replayed).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('rejects a signature replayed for a DIFFERENT tenant', () => {
    // §21 enforced cryptographically: the receiving module cannot be tricked into acting for
    // another tenant by rewriting a header.
    const signed = signModuleRequest(SECRET, material({ timestamp: String(now) }));

    const replayed = verifyModuleRequest(
      SECRET,
      material({
        timestamp: String(now),
        identity: { moduleId: 'finance', requestId: 'req-1', tenantId: 'tenant-2' },
      }),
      signed,
      now,
    );

    expect(replayed).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('rejects a modified body', () => {
    const signed = signModuleRequest(SECRET, material({ timestamp: String(now) }));

    expect(
      verifyModuleRequest(
        SECRET,
        material({ timestamp: String(now), body: JSON.stringify({ operation: 'other' }) }),
        signed,
        now,
      ),
    ).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('rejects a stale timestamp before doing any HMAC work', () => {
    const stale = String(now - SIGNATURE_WINDOW_MS - 1);
    const signed = signModuleRequest(SECRET, material({ timestamp: stale }));

    expect(verifyModuleRequest(SECRET, material({ timestamp: stale }), signed, now)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('accepts clock skew in BOTH directions inside the window', () => {
    // A symmetric window matters in local Docker setups, where the container clock drifts ahead of
    // the host's.
    for (const offset of [-SIGNATURE_WINDOW_MS + 1_000, SIGNATURE_WINDOW_MS - 1_000]) {
      const timestamp = String(now + offset);
      const signed = signModuleRequest(SECRET, material({ timestamp }));

      expect(verifyModuleRequest(SECRET, material({ timestamp }), signed, now)).toEqual({
        ok: true,
      });
    }
  });

  it('rejects a missing signature and a malformed timestamp distinctly', () => {
    const input = material({ timestamp: String(now) });

    expect(verifyModuleRequest(SECRET, input, undefined, now)).toEqual({
      ok: false,
      reason: 'MISSING',
    });

    expect(
      verifyModuleRequest(SECRET, material({ timestamp: 'not-a-number' }), 'deadbeef', now),
    ).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch; the wrapper must degrade to a rejection.
    expect(verifyModuleRequest(SECRET, material({ timestamp: String(now) }), 'ab', now)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('rejects a signature made with a different secret', () => {
    const signed = signModuleRequest(
      'x'.repeat(MIN_SECRET_LENGTH),
      material({ timestamp: String(now) }),
    );

    expect(verifyModuleRequest(SECRET, material({ timestamp: String(now) }), signed, now)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
});

describe('isSecretExpired', () => {
  const now = 1_780_000_000_000;

  it('treats a null expiry as NOT expired', () => {
    // The opposite default would break every module the moment the column shipped.
    expect(isSecretExpired(null, now)).toBe(false);
  });

  it('expires at the boundary, not after it', () => {
    expect(isSecretExpired(new Date(now), now)).toBe(true);
    expect(isSecretExpired(new Date(now - 1), now)).toBe(true);
    expect(isSecretExpired(new Date(now + 1), now)).toBe(false);
  });
});

