import { Injectable, Logger } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import {
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_LEGACY_ALGORITHM,
  canonicalisePermissions,
  type TokenTrust,
} from './token-contract';
import { TokenPolicy } from './token-policy';

/**
 * Phase 51-HR-ARCH-3A: the issuer. The only code in the platform that MINTS a token.
 *
 * WHY ISSUANCE MOVED (IT WAS THREE LINES IN `AuthService`)
 * ------------------------------------------------------
 * The claim set is the contract every verifier reads. While `AuthService` built its own
 * payload object, the claim names and the TTL were properties of one call site rather
 * than of the platform: adding `tid`/`ver`/`perm` there and starting to sign RS256 would
 * have left the WebSocket path, the refresh path and any future HR runtime agreeing with
 * it by coincidence.
 *
 * So there is one issuer, one payload shape per trust level, and one place that enforces
 * the `perm` ceiling at issuance (ADR-0006 §B4: exceeding it is an ISSUANCE error — a
 * token is never minted with a truncated permission list).
 *
 * THE LEGACY PATH IS BYTE-COMPATIBLE WITH THE PRE-3A TOKEN
 * -------------------------------------------------------
 * While the bridge is open, this class mints EXACTLY the payload `AuthService` minted
 * before this phase — `sub`, `email`, `tokenVersion`, `aud`, `iss` — with the same
 * lifetime. That is deliberate: every verifier and every client in the combined runtime
 * keeps working unchanged, and the phase adds a contract without moving the deployment
 * onto it. `tid`, `ver` and `perm` are NOT added to legacy tokens, because a claim that
 * nothing resolves from would be noise that suggests a capability the bridge does not
 * have.
 *
 * Asymmetric issuance is a different payload: `sub`, `tid`, `ver`, `perm` (canonicalised),
 * `email` (display-only), `aud`, `iss`, and the same lifetime bound the verifiers enforce.
 */
export class TokenIssuanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenIssuanceError';
  }
}

export interface IssueAccessTokenInput {
  readonly sub: string;
  /** Display-only (ADR-0006 §B3). Never an authorization input. */
  readonly email?: string | null;
  /** The tenant the subject acts in. Required by the asymmetric path. */
  readonly tid?: string | null;
  /** Token version: Core's `tokenVersion` today, `ver` in the target model. */
  readonly ver: number;
  /** The subject's permissions. Canonicalised and bounded here. */
  readonly perm?: readonly string[];
}

export interface IssuedAccessToken {
  readonly token: string;
  /** Actual `exp - iat` of the minted token, asserted after signing. */
  readonly expiresIn: number;
  readonly trust: TokenTrust;
  readonly kid: string | null;
}

const MAX_CLAIM_ID_LENGTH = 128;

@Injectable()
export class TokenIssuer {
  private readonly logger = new Logger(TokenIssuer.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly policy: TokenPolicy,
  ) {}

  /**
   * Mints one access token at the trust level this deployment is configured for.
   *
   * The choice is not the caller's: a caller cannot ask for a weaker token, and cannot
   * ask for a longer one either.
   */
  async issueAccessToken(input: IssueAccessTokenInput): Promise<IssuedAccessToken> {
    const sub = requireId(input.sub, 'sub');
    const ver = requireVersion(input.ver);

    return this.policy.asymmetricEnabled
      ? this.issueAsymmetric(sub, ver, input)
      : this.issueLegacy(sub, ver, input);
  }

  /**
   * RS256 issuance: the target model.
   *
   * Three ways this refuses rather than guesses:
   *
   *   * no private key configured — asymmetric VERIFICATION is a verifier-side setting,
   *     so a runtime can be configured to accept RS256 without being able to mint it.
   *     Minting is then an error, never a silent downgrade to HMAC;
   *   * no key id configured — a token with no `kid` cannot be verified after a
   *     rotation, and this platform's verifier refuses one, so minting one would create
   *     a token its own issuer cannot use;
   *   * a `perm` list over the ceiling — truncated authority is worse than no token.
   */
  private issueAsymmetric(
    sub: string,
    ver: number,
    input: IssueAccessTokenInput,
  ): IssuedAccessToken {
    // Phase 52-ARCH-3C: the signing key is asked of the POLICY, so this class cannot disagree
    // with the rest of the platform about which key signs. A key set's active entry and the
    // single-key path are resolved in one place, and the diagnostic that comes back names the
    // variable the operator actually has to set.
    const signingKey = this.policy.signingKey;

    if (!signingKey) {
      throw new TokenIssuanceError(
        this.policy.signingKeyProblem ?? 'No signing key is configured for this process.'
      );
    }

    const privateKey = signingKey.privatePem;
    const kid = signingKey.kid;

    const tid = requireId(input.tid ?? '', 'tid');

    const permitted = canonicalisePermissions(input.perm ?? [], this.policy.maxPermissionsPerToken);
    if (!permitted.ok) {
      throw new TokenIssuanceError(
        permitted.reason === 'permissions-exceed-maximum'
          ? `Refusing to mint a token with more than ${this.policy.maxPermissionsPerToken} permissions. Narrow the grants, or raise MAX_PERMISSIONS_PER_TOKEN deliberately.`
          : 'Refusing to mint a token whose perm claim is not a list of permission names.',
      );
    }

    const payload: Record<string, unknown> = {
      sub,
      tid,
      ver,
      perm: permitted.permissions,
      aud: this.policy.audience,
      iss: this.policy.issuer,
    };

    const email = displayableEmail(input.email);
    if (email) payload.email = email;

    const token = this.jwt.sign(payload, {
      algorithm: TOKEN_ASYMMETRIC_ALGORITHM,
      keyid: kid,
      secret: privateKey,
      expiresIn: this.policy.asymmetricAccessTtlSeconds,
    });

    return { token, expiresIn: this.assertLifetime(token), trust: 'asymmetric', kid };
  }

  /**
   * HS256 issuance: exactly the payload and lifetime this platform minted before this
   * phase, so the combined runtime and its clients are untouched while the bridge is
   * open.
   *
   * `JWT_EXPIRES_IN` is the one TTL for both the login and the refresh path. Before this
   * phase the login path hard-coded `15m` while the refresh path read
   * `process.env.JWT_EXPIRES_IN || '15m'`; with the variable unset (its only state in
   * this repository) the two are the same value, so unifying them preserves behaviour
   * and removes a disagreement waiting to happen.
   */
  private issueLegacy(sub: string, ver: number, input: IssueAccessTokenInput): IssuedAccessToken {
    const secret = this.policy.legacyHs256Secret;
    if (!secret) {
      throw new TokenIssuanceError('No shared secret is configured, so no HS256 token can be minted.');
    }

    const payload: Record<string, unknown> = {
      sub,
      tokenVersion: ver,
      aud: this.policy.audience,
      iss: this.policy.issuer,
    };

    const email = displayableEmail(input.email);
    if (email) payload.email = email;

    // `expiresIn` is `number | ms.StringValue` in `jsonwebtoken`, and the legacy TTL is a
    // configured string (today's `JWT_EXPIRES_IN`, default `15m`). The assertion is the one
    // place the two type worlds meet; the value is validated by `jsonwebtoken` itself at
    // signing time, and `assertLifetime` below refuses anything it cannot measure.
    const options: JwtSignOptions = {
      algorithm: TOKEN_LEGACY_ALGORITHM,
      secret,
      expiresIn: this.policy.legacyAccessTtl as JwtSignOptions['expiresIn'],
    };

    const token = this.jwt.sign(payload, options);

    return { token, expiresIn: this.assertLifetime(token), trust: 'legacy-hmac', kid: null };
  }

  /**
   * Reads back what was actually signed and refuses an unusable result.
   *
   * Reporting `exp - iat` from the minted token (rather than the requested value) means
   * the caller's `expiresIn` cannot disagree with the token it was given, and asserting
   * the ceiling HERE means a configuration that would mint a token this platform's own
   * verifiers reject fails at issuance — the failure mode becomes a loud error at login
   * instead of a fleet of tokens that cannot be used.
   */
  private assertLifetime(token: string): number {
    const decoded = this.jwt.decode<{ iat?: unknown; exp?: unknown }>(token);
    const iat = typeof decoded?.iat === 'number' ? decoded.iat : null;
    const exp = typeof decoded?.exp === 'number' ? decoded.exp : null;

    if (iat === null || exp === null) {
      throw new TokenIssuanceError(
        'Minted token carries no measurable lifetime (iat/exp), so its expiry cannot be asserted.',
      );
    }

    const ttl = exp - iat;
    if (ttl <= 0) {
      throw new TokenIssuanceError(`Minted token has a non-positive lifetime (${ttl}s).`);
    }

    if (this.policy.asymmetricEnabled && ttl > this.policy.maxAcceptedTtlSeconds) {
      throw new TokenIssuanceError(
        `Refusing to return a token whose lifetime (${ttl}s) exceeds the accepted maximum (${this.policy.maxAcceptedTtlSeconds}s): this platform's verifiers would reject it.`,
      );
    }

    return ttl;
  }
}

function requireId(value: string, claim: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TokenIssuanceError(`Cannot mint a token without a ${claim}.`);
  }
  if (value.length > MAX_CLAIM_ID_LENGTH) {
    throw new TokenIssuanceError(`Cannot mint a token with an implausibly long ${claim}.`);
  }
  return value;
}

function requireVersion(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TokenIssuanceError('Cannot mint a token without a non-negative integer version.');
  }
  return value;
}

function displayableEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
