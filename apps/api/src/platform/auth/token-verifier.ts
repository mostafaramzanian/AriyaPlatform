import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_LEGACY_ALGORITHM,
  TOKEN_VERIFICATION_PLAN,
  TokenRejectedError,
  canonicalisePermissions,
  type TokenTrust,
  type TrustedTokenClaims,
} from './token-contract';
import { TokenKeySet, type TokenVerificationPlan } from './token-keyset';
import { TokenPolicy } from './token-policy';
import { TokenRevocationRegistry } from './token-revocation';

/**
 * Phase 51-HR-ARCH-3A: THE verifier. One class, three transports, no second opinion.
 *
 * WHY ONE CLASS AND NOT A STRATEGY PLUS A GATEWAY COPY
 * ---------------------------------------------------
 * Before this phase the same verification existed twice: `JwtStrategy` for HTTP and
 * `MessagingGateway` for the WebSocket handshake, each with its own copy of the
 * secret, the audience, the issuer and the `tokenVersion` re-read. Two copies of a
 * security rule is one copy too many — the gateway's copy is exactly where an
 * unpinned HMAC verifier would have survived this migration, because nothing that
 * happened on the HTTP path would have repaired it.
 *
 * So verification is split into two callable steps, and both transports use BOTH:
 *
 *   * `planVerification(rawToken)` — decode the header, pin the algorithm from
 *     configuration, select the key by `kid`, and stash the plan on the request. It is
 *     separate because `passport-jwt` must be given a key BEFORE it calls
 *     `validate`, and the plan is what proves which key was used;
 *   * `trust(payload, header)` — the claim discipline: issuer, audience, identity,
 *     lifetime bound, `tid`/`ver`/`perm`, and the revocation check. It runs AFTER the
 *     signature has been verified, because a claim is only worth interpreting once
 *     the bytes that carry it are known to be the issuer's.
 *
 * `verify(rawToken)` is the two composed, for a caller that holds the raw token (the
 * WebSocket handshake, which has no guard chain to run against).
 *
 * WHAT THIS CLASS DELIBERATELY DOES NOT DO
 * ---------------------------------------
 *   * It never reads `JWT_SECRET` or any environment value; configuration reaches it
 *     through `TokenPolicy` and key material through `TokenKeySet`.
 *   * It never catches a `TokenRejectedError` to fall back on something weaker. Every
 *     refusal is terminal.
 *   * It never consults a database. In asymmetric mode nothing downstream of it does
 *     either — that is the whole point of `tid` and `perm` (ADR-0006 §B1).
 *   * It never reads the `role` claim for authorization (ADR-0006 §B3).
 */

/** The two header fields that matter, taken from the VERIFICATION PLAN, not the token. */
export interface TokenHeader {
  readonly alg: string;
  readonly kid: string | null;
}

/** Bound on an identity claim, so a malformed token cannot put a novel into memory. */
const MAX_CLAIM_ID_LENGTH = 128;

/** Bound on a display-only claim. */
const MAX_EMAIL_LENGTH = 320;

@Injectable()
export class TokenVerifier {
  constructor(
    private readonly jwt: JwtService,
    private readonly policy: TokenPolicy,
    private readonly keySet: TokenKeySet,
    private readonly revocation: TokenRevocationRegistry,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Step 1: decide the algorithm and the key for this token, and remember the
   * decision on the request.
   *
   * The plan is attached to the request rather than kept in shared state because
   * `passport-jwt` offers no other channel, and it must be per-request: two concurrent
   * requests signed with different `kid`s must not be able to confuse each other's
   * `trust()` call. Nothing but `JwtStrategy.validate` reads it.
   */
  async planVerification(
    rawToken: string,
    request?: Record<PropertyKey, unknown>,
  ): Promise<TokenVerificationPlan> {
    const header = decodeHeader(rawToken, this.jwt);
    const plan = await this.keySet.planFor({ alg: header.alg, kid: header.kid });

    if (request) {
      request[TOKEN_VERIFICATION_PLAN] = plan;
    }

    return plan;
  }

  /**
   * The whole pipeline for a caller that holds the raw token.
   *
   * Signature first, claims second: a payload is untrusted data until the signature
   * over it has been checked, so no claim is read before that point.
   */
  async verify(rawToken: string): Promise<TrustedTokenClaims> {
    const header = decodeHeader(rawToken, this.jwt);
    const plan = await this.keySet.planFor({ alg: header.alg, kid: header.kid });
    const payload = await this.verifySignature(rawToken, plan);

    return this.trust(payload, { alg: plan.algorithm, kid: plan.kid });
  }

  /**
   * The trust level for this request, from CONFIGURATION.
   *
   * The `header.alg` argument is the algorithm the verification plan pinned, so this
   * is an assertion that the plan agrees with configuration rather than a choice made
   * from token data. If the two ever disagreed, the request is refused instead of
   * resolved at the weaker level.
   */
  private trustLevel(header: TokenHeader): TokenTrust {
    if (this.policy.asymmetricEnabled) {
      if (header.alg !== TOKEN_ASYMMETRIC_ALGORITHM) {
        throw new TokenRejectedError(
          'algorithm-not-accepted',
          `Verification plan selected ${JSON.stringify(header.alg)} while configuration requires ${TOKEN_ASYMMETRIC_ALGORITHM}.`,
        );
      }
      return 'asymmetric';
    }

    if (header.alg !== TOKEN_LEGACY_ALGORITHM) {
      throw new TokenRejectedError(
        'algorithm-not-accepted',
        `Verification plan selected ${JSON.stringify(header.alg)} while this deployment accepts ${TOKEN_LEGACY_ALGORITHM} only.`,
      );
    }

    return 'legacy-hmac';
  }

  /**
   * The claim discipline, identical for every transport.
   *
   * ORDER MATTERS AND IS THE SECURITY PROPERTY. The issuer and audience are checked
   * before anything else, so a token from another system is refused before any of its
   * claims are interpreted; identity and lifetime are checked before the authoritative
   * claims, so an expired or anonymous token can never reach the code that decides a
   * tenant or a permission; and revocation is checked last, because it is the only rule
   * that depends on state outside the token.
   */
  async trust(payload: unknown, header: TokenHeader): Promise<TrustedTokenClaims> {
    if (!isRecord(payload)) {
      throw new TokenRejectedError('claims-malformed', 'Token payload is not an object.');
    }

    if (payload.iss !== this.policy.issuer) {
      throw new TokenRejectedError(
        'issuer-mismatch',
        `Token issuer ${JSON.stringify(payload.iss)} is not ${JSON.stringify(this.policy.issuer)}.`,
      );
    }

    if (!audienceContains(payload.aud, this.policy.audience)) {
      throw new TokenRejectedError(
        'audience-mismatch',
        `Token audience ${JSON.stringify(payload.aud)} does not include ${JSON.stringify(this.policy.audience)}.`,
      );
    }

    const trust = this.trustLevel(header);

    const sub = requireClaimId(payload.sub, 'sub');
    const iat = requireIntegerClaim(payload.iat, 'iat');
    const exp = requireIntegerClaim(payload.exp, 'exp');
    const nbf = payload.nbf === undefined ? iat : requireIntegerClaim(payload.nbf, 'nbf');

    const nowSeconds = Math.floor(this.now() / 1000);
    if (exp <= nowSeconds) {
      throw new TokenRejectedError('token-expired', 'Token has expired.');
    }
    if (nbf > nowSeconds) {
      throw new TokenRejectedError('token-not-yet-valid', 'Token is not valid yet.');
    }

    const ttlSeconds = exp - iat;
    if (ttlSeconds <= 0) {
      throw new TokenRejectedError(
        'claims-malformed',
        'Token lifetime (exp - iat) is not positive.',
      );
    }

    const email = optionalText(payload.email);

    if (trust === 'legacy-hmac') {
      return this.trustLegacy({ sub, email, iat, nbf, exp, ttlSeconds }, payload);
    }

    return this.trustAsymmetric({ sub, email, iat, nbf, exp, ttlSeconds }, payload, header);
  }

  /**
   * The legacy (shared-secret) branch. IDENTITY, TENANT AND PERMISSIONS STAY CORE'S.
   *
   * This branch exists only while Core has not been switched to RS256 issuance, and it
   * is resolved exactly as before this phase: `ver` is Core's `tokenVersion`, which
   * `JwtStrategy` compares against the database row; `tid` and `perm` are ignored even
   * when present. Nothing here is claim-authoritative, which is why the migration
   * bridge cannot be the place where the platform starts trusting a claim it has no
   * trust level for.
   */
  private trustLegacy(
    base: { sub: string; email: string | null; iat: number; nbf: number; exp: number; ttlSeconds: number },
    payload: Record<string, unknown>,
  ): TrustedTokenClaims {
    // A legacy token WITHOUT an integer `tokenVersion` can never pass the database
    // comparison (Core's column is a non-null integer), so refusing it here changes no
    // outcome and removes the "undefined !== 0" special case.
    const ver = requireIntegerClaim(payload.tokenVersion, 'tokenVersion');
    if (ver < 0) {
      throw new TokenRejectedError('claims-malformed', 'Claim tokenVersion must not be negative.');
    }

    return freezeClaims({
      trust: 'legacy-hmac',
      sub: base.sub,
      tid: null,
      ver,
      perm: [],
      email: base.email,
      iat: base.iat,
      nbf: base.nbf,
      exp: base.exp,
      ttlSeconds: base.ttlSeconds,
      kid: null,
    });
  }

  /**
   * The asymmetric branch. `tid`, `ver` and `perm` are the authority.
   *
   * `tid` is required: a token that does not name a tenant cannot be resolved to one,
   * and an "untenanted" request in a multi-tenant platform is either a global operator
   * (which this contract does not model) or a bug. Refusing is the only option that
   * cannot silently widen a query.
   *
   * `perm` absent is NOT a refusal — ADR-0006 §B4 makes it an EMPTY authority set, which
   * denies at every `@Roles(...)` route. A `perm` of the wrong SHAPE is refused, because
   * "not a list of permission names" is not something this platform can interpret as
   * "no permissions" without guessing.
   */
  private trustAsymmetric(
    base: { sub: string; email: string | null; iat: number; nbf: number; exp: number; ttlSeconds: number },
    payload: Record<string, unknown>,
    header: TokenHeader,
  ): TrustedTokenClaims {
    if (!header.kid) {
      throw new TokenRejectedError(
        'key-unavailable',
        'Asymmetric trust requires a kid so the verification key is unambiguous.',
      );
    }

    // ADR-0006 §C1(1) — layer one of the revocation design, enforced here and not in
    // the shared path: the bound belongs to the model HR adopts, so it is applied to
    // every token accepted at ASYMMETRIC trust and to none accepted at legacy trust.
    // That is not a loophole: HMAC acceptance is disabled the moment asymmetric
    // material is configured, so there is no deployment in which an unbounded token is
    // accepted while this bound is in force. Meanwhile the bridge keeps today's
    // 15-minute tokens working exactly as they do now.
    if (base.ttlSeconds > this.policy.maxAcceptedTtlSeconds) {
      throw new TokenRejectedError(
        'lifetime-exceeds-maximum',
        `Token lifetime of ${base.ttlSeconds}s exceeds the accepted maximum of ${this.policy.maxAcceptedTtlSeconds}s.`,
      );
    }

    const tid = requireClaimId(payload.tid, 'tid');
    const ver = requireIntegerClaim(payload.ver, 'ver');
    if (ver < 0) {
      throw new TokenRejectedError('claims-malformed', 'Claim ver must not be negative.');
    }

    const permitted = canonicalisePermissions(payload.perm, this.policy.maxPermissionsPerToken);
    if (!permitted.ok) {
      throw new TokenRejectedError(
        permitted.reason === 'permissions-exceed-maximum'
          ? 'permissions-exceed-maximum'
          : // A `perm` of the wrong shape is a malformed claim: the platform cannot read it as
            // "no permissions" without guessing (ADR-0006 §B4).
            'claims-malformed',
        permitted.reason === 'permissions-exceed-maximum'
          ? `Token carries more than ${this.policy.maxPermissionsPerToken} permissions.`
          : 'Claim perm is not a list of permission names.',
      );
    }

    if (this.revocation.isRevoked(base.sub, ver)) {
      throw new TokenRejectedError(
        'token-revoked',
        `Token version ${ver} is at or below the revoked version for this subject.`,
      );
    }

    return freezeClaims({
      trust: 'asymmetric',
      sub: base.sub,
      tid,
      ver,
      perm: permitted.permissions,
      email: base.email,
      iat: base.iat,
      nbf: base.nbf,
      exp: base.exp,
      ttlSeconds: base.ttlSeconds,
      kid: header.kid,
    });
  }

  /**
   * Signature verification, with the algorithm PINNED BY THE PLAN.
   *
   * `algorithms: [plan.algorithm]` is the line that makes `alg: none`, `alg: HS256`
   * against an RSA key and every algorithm-confusion variant fail: the library is told
   * which one algorithm is acceptable, so a header cannot nominate its own. The key is
   * passed as `publicKey` for RS256 and `secret` for HS256 so the two kinds of material
   * are never interchangeable at the call site.
   */
  private async verifySignature(
    rawToken: string,
    plan: TokenVerificationPlan,
  ): Promise<Record<string, unknown>> {
    const options =
      plan.algorithm === TOKEN_ASYMMETRIC_ALGORITHM
        ? { algorithms: [plan.algorithm], publicKey: plan.key as string }
        : { algorithms: [plan.algorithm], secret: plan.key as string };

    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(rawToken, options);
    } catch (error) {
      throw toRejection(error);
    }
  }
}

/**
 * Reads the JOSE header WITHOUT verifying anything.
 *
 * Decoding a header is not a trust decision: it is how the algorithm and `kid` are
 * discovered so the plan can be built. The header is treated as untrusted input
 * throughout, and the algorithm it names is compared against configuration rather than
 * obeyed.
 */
function decodeHeader(rawToken: string, jwt: JwtService): { alg: unknown; kid: unknown } {
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new TokenRejectedError('token-malformed', 'No token was presented.');
  }

  const decoded = jwt.decode<{ header?: unknown }>(rawToken.trim(), { complete: true, json: true });
  const header = decoded && typeof decoded === 'object' ? (decoded as { header?: unknown }).header : null;

  if (!header || typeof header !== 'object') {
    throw new TokenRejectedError('token-malformed', 'Token is not a decodable JWT.');
  }

  const candidate = header as { alg?: unknown; kid?: unknown };
  return { alg: candidate.alg, kid: candidate.kid };
}

/**
 * Maps a library error onto a rejection reason.
 *
 * The reason codes are what an operator investigates, so an expired token and a bad
 * signature must not arrive as the same string. Library messages are included in the
 * error message — this value is logged, never returned to a client — because "bad
 * signature" with the library's own wording is what makes a key-rotation incident
 * diagnosable.
 */
function toRejection(error: unknown): TokenRejectedError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'TokenExpiredError') {
    return new TokenRejectedError('token-expired', 'Token has expired.');
  }
  if (name === 'NotBeforeError') {
    return new TokenRejectedError('token-not-yet-valid', 'Token is not valid yet.');
  }
  if (/malformed|signature required|invalid token|must be provided|No signature/i.test(message)) {
    return new TokenRejectedError('token-malformed', `Token could not be verified: ${message}`);
  }

  return new TokenRejectedError('signature-invalid', `Signature verification failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `aud` may be a single value or a list; the expected audience must be one of them. */
function audienceContains(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

function requireClaimId(value: unknown, claim: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TokenRejectedError('claims-malformed', `Claim ${claim} is missing or empty.`);
  }
  if (value.length > MAX_CLAIM_ID_LENGTH) {
    throw new TokenRejectedError('claims-malformed', `Claim ${claim} is implausibly long.`);
  }
  return value;
}

function requireIntegerClaim(value: unknown, claim: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new TokenRejectedError('claims-malformed', `Claim ${claim} is not a whole number.`);
  }
  return value;
}

/** Display-only claim: a non-string or an absurd length becomes null, never a rejection. */
function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  return trimmed;
}

/**
 * Freezes the claims and their permission list.
 *
 * A verified token's claims are shared across the guard, the interceptor and every
 * consumer that reads the request context, so they are frozen: an authorization input
 * that any layer can mutate is not an authorization input.
 */
function freezeClaims(claims: TrustedTokenClaims): TrustedTokenClaims {
  return Object.freeze({
    ...claims,
    perm: Object.freeze([...claims.perm]),
  }) as TrustedTokenClaims;
}
