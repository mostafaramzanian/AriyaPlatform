import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service';
import {
  TOKEN_VERIFICATION_PLAN,
  TokenRejectedError,
  type TrustedTokenClaims,
} from '../../platform/auth/token-contract';
import type { TokenVerificationPlan } from '../../platform/auth/token-keyset';
import { TokenVerifier } from '../../platform/auth/token-verifier';

/**
 * JWT Strategy — the HTTP transport adapter for `TokenVerifier`.
 *
 * WHAT THIS CLASS IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * -----------------------------------------------------
 * It adapts a token on an `Authorization` header into a principal on the request. It does
 * NOT decide which algorithm is acceptable, which key verifies a signature, what a claim
 * means, or how long a token may live: all of that is `TokenVerifier`'s, so the HTTP and
 * WebSocket paths cannot disagree about it.
 *
 * The split is forced by `passport-jwt`'s shape, and the shape is why the verification PLAN
 * exists: passport needs a key BEFORE it calls `validate`, and it does not pass the token
 * header to `validate`. So `secretOrKeyProvider` runs `TokenVerifier.planVerification`,
 * which pins the algorithm, selects the key by `kid` and stashes the plan on the request;
 * `validate` then reads the plan back and calls `TokenVerifier.trust`.
 *
 * WHAT THE LEGACY BRANCH STILL DOES
 * --------------------------------
 * For a shared-secret token the principal is resolved exactly as before this phase: the user
 * row is read from Core and `tokenVersion` is compared, so a revoked or re-versioned account
 * cannot keep using an old token. For an asymmetric token no query is made — `tid` and
 * `perm` are the authority (ADR-0006 §B1) — and revocation is bounded by the short TTL plus
 * the deny-set.
 *
 * FAIL-CLOSED REJECTIONS ARE LOGGED, NEVER RETURNED
 * ------------------------------------------------
 * A rejection reason is the operator's diagnostic (which key? which rule?) and not the
 * client's business: the guard turns every failure into a plain 401. Logging here — at the
 * one place that knows a request existed — is what makes a key-rotation incident visible in
 * the logs while the response body stays uniform.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenVerifier: TokenVerifier,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // The plan must be readable in `validate`, and passport-jwt only passes the request
      // when this is set.
      passReqToCallback: true,
      secretOrKeyProvider: (
        request: unknown,
        rawToken: string,
        done: (error: unknown, key?: string | Buffer, options?: unknown) => void,
      ) => {
        this.tokenVerifier
          .planVerification(rawToken, request as Record<PropertyKey, unknown>)
          .then((plan) =>
            // `algorithms` comes from the PLAN, so the token header cannot nominate its own
            // algorithm. This is the only place the HTTP path hands a key to the library.
            done(null, plan.key, { algorithms: [plan.algorithm] }),
          )
          .catch((error: unknown) => done(this.reject(error)));
      },
    });
  }

  /**
   * Resolves the principal once the signature has been verified.
   *
   * `passReqToCallback: true` means passport passes the request first; the plan it carries
   * is what proves which algorithm and key were used for this specific token.
   */
  async validate(request: unknown, payload: unknown): Promise<Record<string, unknown>> {
    const plan = readPlan(request);
    if (!plan) {
      throw this.reject(
        new TokenRejectedError(
          'token-malformed',
          'Token reached validate() without a verification plan, so its key cannot be proven.',
        ),
      );
    }

    let claims: TrustedTokenClaims;
    try {
      claims = await this.tokenVerifier.trust(payload, { alg: plan.algorithm, kid: plan.kid });
    } catch (error) {
      throw this.reject(error);
    }

    if (claims.trust === 'asymmetric') {
      // No Core read: the claims are the authority, which is the property that lets an
      // extracted business runtime outlive Core's availability.
      return {
        sub: claims.sub,
        userId: claims.sub,
        email: claims.email,
        tokenVersion: claims.ver,
        tenantId: claims.tid,
        claims,
      };
    }

    // Legacy bridge: unchanged resolution. `tokenVersion` is compared against the row, so
    // revocation remains immediate for shared-secret tokens.
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, tokenVersion: true, status: true },
    });

    if (!user) {
      this.logger.warn(`JWT validation failed: user not found (userId: ${claims.sub})`);
      throw new UnauthorizedException('User not found');
    }

    if (claims.ver !== user.tokenVersion) {
      this.logger.warn(
        `Stale JWT token detected (userId: ${claims.sub}, jwtVersion: ${claims.ver}, currentVersion: ${user.tokenVersion})`,
      );
      throw new UnauthorizedException('Token is no longer valid. Please login again.');
    }

    return {
      sub: user.id,
      userId: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
      claims,
    };
  }

  /** Logs the reason and returns the 401 the guard will raise. */
  private reject(error: unknown): UnauthorizedException {
    if (error instanceof TokenRejectedError) {
      this.logger.warn(`Token rejected (${error.reason}): ${error.message}`);
      return new UnauthorizedException('Invalid or expired token');
    }

    this.logger.warn(
      `Token verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new UnauthorizedException('Invalid or expired token');
  }
}

/** Reads the plan `TokenVerifier.planVerification` stashed on this request. */
function readPlan(request: unknown): TokenVerificationPlan | null {
  if (!request || typeof request !== 'object') return null;
  const plan = (request as Record<PropertyKey, unknown>)[TOKEN_VERIFICATION_PLAN];
  return plan && typeof plan === 'object' ? (plan as TokenVerificationPlan) : null;
}
