/**
 * Phase 51-HR-ARCH-3A: the TOKEN CONTRACT (ADR-0006 §B).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this phase the platform had exactly one notion of "an authenticated
 * caller": a token signed with the shared `JWT_SECRET`, verified against that same
 * secret by `JwtStrategy` (HTTP) and by `MessagingGateway` (WebSocket), with the
 * caller's identity, tenant and permissions resolved from Core's database on every
 * request. Two consequences followed from that shape, and both of them are what
 * ADR-0006 exists to remove:
 *
 *   1. every runtime that accepted a token had to hold the SIGNING secret, so a
 *      business runtime was one configuration mistake away from minting identities;
 *   2. every request needed Core to be up, so an independently-owned business module
 *      that reads permission strings could not outlive Core's availability.
 *
 * This file is the single declaration of what a token IS after this phase: the
 * algorithm split (`asymmetric` vs `legacy-hmac`), the claim set, the reason codes a
 * rejection carries, and the one canonicalisation rule for `perm`. Verification
 * (`token-verifier.ts`), the signer (`token-issuer.ts`), the tenant resolver
 * (`tenant-resolver.contract.ts`) and the permission source
 * (`permission-source.contract.ts`) all consume THESE declarations instead of
 * re-declaring a claim name, a ceiling or an algorithm wherever they are needed.
 *
 * THE TWO TRUST LEVELS, AND WHY "legacy-hmac" IS NOT A FALLBACK
 * ------------------------------------------------------------
 * `asymmetric` is a token whose signature was verified against a PUBLIC key the
 * verifier holds and whose `alg` is pinned to RS256. It carries `tid`, `ver` and
 * `perm`, and those claims are AUTHORITATIVE: resolution never consults Core.
 *
 * `legacy-hmac` is a token signed with the shared `JWT_SECRET` that exists only
 * because Core has not yet been switched to RS256 issuance. It is accepted only
 * while no asymmetric key material is configured (see `TokenPolicy`), and it is
 * resolved exactly as before this phase — identity, tenant and permissions from
 * Core's database. Its `tid` and `perm` claims are deliberately IGNORED even if
 * present, so the migration bridge can never be the place where a claim becomes
 * authoritative without the trust level that justifies it.
 *
 * There is no "try RS256, then HMAC, then the database" chain anywhere: the trust
 * level is decided ONCE, from configuration, before any part of a request is
 * resolved (ADR-0006 §B5, and the §28 hard stop on a hidden Core fallback).
 */

/**
 * Issuer and audience. These were previously string literals repeated in
 * `JwtStrategy`, `MessagingGateway` and `AuthService`; a token contract with three
 * copies of its own identifier is a contract that can drift. Pinned by the
 * verification matrix, which rejects a token carrying a different `iss` or `aud`.
 */
export const TOKEN_ISSUER = 'aria-erp-auth';
export const TOKEN_AUDIENCE = 'aria-erp-api';

/**
 * The ONE asymmetric algorithm this platform accepts, and the ONE symmetric
 * algorithm it accepts while the migration bridge is open. Both are pinned: the
 * verifier selects the algorithm from configuration and refuses a token whose
 * header claims anything else, so `alg: none`, `alg: HS256` alongside an RSA public
 * key, and algorithm-confusion attacks are all rejected before the signature is
 * even inspected.
 */
export const TOKEN_ASYMMETRIC_ALGORITHM = 'RS256';
export const TOKEN_LEGACY_ALGORITHM = 'HS256';

/**
 * The algorithm a verification plan may carry. Declared as a union of the two pinned
 * literals rather than `string`, because `TokenVerifier` hands it to the JWT library's
 * `algorithms` list: a `string` there is exactly the value that could nominate an
 * algorithm the deployment did not choose, and the type is the first place that is
 * prevented.
 */
export type TokenAlgorithm = typeof TOKEN_ASYMMETRIC_ALGORITHM | typeof TOKEN_LEGACY_ALGORITHM;

/**
 * ADR-0006 §C1(1): the maximum accepted access-token lifetime, in seconds. A token
 * whose `exp - iat` exceeds this is REJECTED, not merely observed — the bound is
 * what makes the revocation gap arithmetic rather than aspirational. 300 seconds
 * (5 minutes) is the ADR's stated maximum.
 */
export const DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS = 300;

/**
 * ADR-0006 §B4: the ceiling on permissions carried by one token. Exceeding it is an
 * ISSUANCE error (the token is not minted at all, never truncated) and a
 * verification error (a token claiming more than the ceiling is rejected rather
 * than silently reduced to the first N entries).
 */
export const DEFAULT_MAX_PERMISSIONS_PER_TOKEN = 200;

/**
 * Bound on a single permission string. Permission names in this codebase are
 * dotted lowercase identifiers (`hr.employees.read`); the bound exists so a hostile
 * or broken issuer cannot put a kilobyte of text into a claim that this platform
 * then writes into a log line.
 */
export const MAX_PERMISSION_LENGTH = 128;

/** Default access-token lifetime for the legacy (HS256) issuance path. */
export const DEFAULT_LEGACY_ACCESS_TTL = '15m';

/**
 * Phase 52-ARCH-3C §B8: the minimum time a retired signing key stays published and
 * accepted after its successor became active.
 *
 * This is a POLICY decision, not a measurement, and it is deliberately not configurable:
 * a knob whose only effect is to shorten a rotation window is a knob that turns a
 * security property into a typo. The floor it must cover is derived from two numbers this
 * platform already has —
 *
 *   * `DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS` (300s): the longest access token any
 *     verifier here will accept, so no token signed by the retiring key can outlive the
 *     window by more than its own TTL;
 *   * `JWKS_CACHE_TTL_MS` (300s, `token-keyset.ts`): how long a verifier may keep using a
 *     JWKS document it already fetched, so a verifier can be up to 300s behind the
 *     published set.
 *
 * ≈600s is therefore the technical floor; 900s is the policy, with margin for clock skew
 * between the issuer and a verifier. `token-signing-keys.ts` refuses a key set whose
 * declared window is shorter.
 */
export const TOKEN_ROTATION_OVERLAP_SECONDS = 900;

/**
 * Phase 52-ARCH-3C §B7: the ONE venue where this platform publishes its public signing keys.
 *
 * Core issues the tokens, so Core publishes the keys its verifiers need — the private half
 * never leaves the issuer, and the public half is served from the issuer's own process
 * rather than from a second deployment nobody owns. The path is a constant because it is a
 * CONTRACT: `token-jwks.controller.ts` serves it, `main.ts` excludes it from the `api/v1`
 * prefix, `.env.example` tells verifiers to point `JWT_JWKS_URI` at it, and an operator
 * reading any one of those should not have to guess the other two.
 */
export const TOKEN_JWKS_PATH = '/.well-known/jwks.json';

/**
 * Raised for configuration this contract cannot honour. Never caught and ignored.
 *
 * Declared beside the token contract rather than beside `TokenPolicy` because the key-set
 * parser (`token-signing-keys.ts`) refuses configuration too, and the two must report the
 * same class: a caller that guards its boot with `TokenPolicyError` is guarding the whole
 * token configuration surface, not one file of it. `token-policy.ts` re-exports this name
 * for the call sites that have always imported it from there.
 */
export class TokenPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenPolicyError';
  }
}

/**
 * Where the verification plan for the current request is stashed.
 *
 * `passport-jwt` decides the verification key BEFORE it hands the payload to
 * `JwtStrategy.validate`, and it does not pass the token header along with the
 * payload. The header is nonetheless needed — `kid` selects the key and `alg`
 * proves the token used the pinned algorithm — so the plan produced by
 * `TokenVerifier.planVerification` is attached to the request under this symbol and
 * read back in `validate`. A Symbol (not a string key) so it cannot collide with
 * anything a client could send or a controller could read.
 */
export const TOKEN_VERIFICATION_PLAN = Symbol('aria.token.verification-plan');

/**
 * The trust level a token was verified at. Decided by configuration, never by the
 * token itself.
 */
export type TokenTrust = 'asymmetric' | 'legacy-hmac';

/**
 * A token that has passed signature verification, claim discipline and revocation.
 *
 * Every consumer receives THIS shape, so "where did the tenant come from?" and "is
 * this permission authoritative?" are answered by the value's own `trust` field
 * rather than by the caller's assumptions. `tid` is non-null exactly when
 * `trust === 'asymmetric'`; `perm` is the empty array exactly when
 * `trust === 'legacy-hmac'`.
 */
export interface TrustedTokenClaims {
  readonly trust: TokenTrust;
  /** Core's stable identity id, from `sub`. Never null: a token without it is rejected. */
  readonly sub: string;
  /** The tenant the subject acts in. Authoritative for `asymmetric`, null for legacy. */
  readonly tid: string | null;
  /**
   * Token version. For `asymmetric` this is the `ver` claim, compared against the
   * revocation deny-set. For `legacy-hmac` it is Core's `tokenVersion` claim, which
   * the legacy bridge still compares against the database row.
   */
  readonly ver: number;
  /** The canonicalised `perm` claim. Empty for legacy tokens, which are never claim-authorised. */
  readonly perm: readonly string[];
  /** Display-only. Never an authorization input (ADR-0006 §B3). */
  readonly email: string | null;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  /** `exp - iat`. Bounded by the accepted maximum at verification time. */
  readonly ttlSeconds: number;
  /** The `kid` the signature was verified against, or null for legacy tokens. */
  readonly kid: string | null;
}

/**
 * Why a token was rejected.
 *
 * These are deliberately fine-grained and are logged (never returned to the client:
 * a caller learns "unauthorized", the operator learns which rule fired). A shared
 * "invalid token" string would make an algorithm-pinning regression
 * indistinguishable from an expired token in the logs.
 */
export type TokenRejectionReason =
  /** Not a JWT at all: undecodable header, bad base64url, non-object payload. */
  | 'token-malformed'
  /** `alg` is not the algorithm configuration permits for this deployment. */
  | 'algorithm-not-accepted'
  /** No usable key: unknown `kid`, no JWKS entry, or no legacy secret configured. */
  | 'key-unavailable'
  /** Signature did not validate against the selected key. */
  | 'signature-invalid'
  /** `iss` is not `aria-erp-auth`. */
  | 'issuer-mismatch'
  /** `aud` does not contain `aria-erp-api`. */
  | 'audience-mismatch'
  /** A required claim is missing, the wrong type, or outside its permitted shape. */
  | 'claims-malformed'
  /** `exp` is in the past. */
  | 'token-expired'
  /** `nbf` is in the future. */
  | 'token-not-yet-valid'
  /** `exp - iat` exceeds the accepted maximum (ADR-0006 §C1(1)). */
  | 'lifetime-exceeds-maximum'
  /** More permissions than the configured ceiling (ADR-0006 §B4). */
  | 'permissions-exceed-maximum'
  /** The deny-set says this `(userId, ver)` pair was revoked (ADR-0006 §C1(2)). */
  | 'token-revoked';

/** Thrown by every verification step. Callers never see a raw library error. */
export class TokenRejectedError extends Error {
  constructor(
    readonly reason: TokenRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

/**
 * The character set a permission name may use.
 *
 * Permission strings in this codebase are dotted lowercase identifiers. The pattern
 * is permissive about the exact vocabulary (a future domain may add a namespace)
 * and strict about the characters, because `perm` entries reach log lines and error
 * messages: a newline or a control character in a claim is a log-injection vector,
 * and the cheapest place to refuse it is here.
 */
export const PERMISSION_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type PermissionCanonicalisation =
  | { readonly ok: true; readonly permissions: string[] }
  | { readonly ok: false; readonly reason: 'permissions-malformed' | 'permissions-exceed-maximum' };

/**
 * THE one canonicalisation rule for `perm`, shared by the issuer and the verifier so
 * the two can never disagree about what a token is allowed to say.
 *
 * Rules, in order:
 *
 *   * absent / null          → `[]`. ADR-0006 §B4: a token with no `perm` is treated
 *                              as having NO permissions, never as unrestricted.
 *                              Absence is not an error here — it is an empty
 *                              authority set, which denies at every `@Roles(...)`
 *                              route.
 *   * not an array           → malformed. A scalar or an object is not a claim this
 *                              platform can interpret as "no permissions" without
 *                              guessing, so it is refused.
 *   * an entry that is not a non-empty string, exceeds `MAX_PERMISSION_LENGTH`, or
 *     contains a character outside `PERMISSION_NAME_PATTERN` → malformed.
 *   * more than `maxPermissions` distinct entries → exceed-maximum.
 *
 * Surviving entries are deduplicated and SORTED, so two tokens carrying the same
 * authority set are comparable and a decision cannot depend on the issuer's
 * ordering.
 */
export function canonicalisePermissions(
  input: unknown,
  maxPermissions: number,
): PermissionCanonicalisation {
  if (input === undefined || input === null) {
    return { ok: true, permissions: [] };
  }

  if (!Array.isArray(input)) {
    return { ok: false, reason: 'permissions-malformed' };
  }

  const canonical = new Set<string>();

  for (const entry of input) {
    if (typeof entry !== 'string') {
      return { ok: false, reason: 'permissions-malformed' };
    }
    if (entry.length === 0 || entry.length > MAX_PERMISSION_LENGTH) {
      return { ok: false, reason: 'permissions-malformed' };
    }
    if (!PERMISSION_NAME_PATTERN.test(entry)) {
      return { ok: false, reason: 'permissions-malformed' };
    }
    canonical.add(entry);
  }

  if (canonical.size > maxPermissions) {
    return { ok: false, reason: 'permissions-exceed-maximum' };
  }

  return { ok: true, permissions: Array.from(canonical).sort() };
}
