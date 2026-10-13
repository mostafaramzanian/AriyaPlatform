import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContextService } from '../common/request-context.service';
import {
  TenantResolver,
  type TenantResolutionInput,
} from '../platform/auth/tenant-resolver.contract';
import type { TrustedTokenClaims } from '../platform/auth/token-contract';

/**
 * Phase 51-HR-ARCH-3A: tenant context, resolved through a port instead of a query.
 *
 * WHAT CHANGED
 * ------------
 * This interceptor used to inject `PrismaService` and read `User.tenantId` from Core on
 * EVERY authenticated request — one Core query per request, for every runtime, purely to
 * fill `RequestContextService`. It now asks a `TenantResolver`, whose authority depends on
 * the token's trust level:
 *
 *   * asymmetric trust → the `tid` claim (no query, no Core);
 *   * legacy trust     → Core's database, exactly as before this phase.
 *
 * The interceptor's own job is unchanged and deliberately narrow: populate the request
 * context ONCE, before the handler, so every layer above reads one ambient value instead of
 * carrying a tenant parameter through signatures. That is what makes HR's
 * `resolveHrActor(req)` — and therefore every HR repository signature — remain the single
 * place a tenant enters an HR query.
 *
 * WHY THE TENANT IS NOT READ FROM `request.user` DIRECTLY
 * -----------------------------------------------------
 * Because `req.user` is whatever the guard chain produced, and a mocked guard in a test can
 * produce anything. The port is the seam where "where does a tenant come from?" is
 * answered in one place, is reportable (`source`), and is provably free of Core at
 * asymmetric trust.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantResolver: TenantResolver) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Phase 54-C: `TenantContextGuard` establishes the same context EARLIER — in the guard
    // phase, because `ModuleEntitlementGuard` (a controller guard) needs a tenant before any
    // interceptor runs. When it has already answered, this interceptor must NOT ask again:
    // a second resolution would be a second Core read for a legacy token, and the two could
    // disagree. `undefined` means "not yet"; `null` is an answer.
    if (RequestContextService.get()?.tenantId !== undefined) {
      return next.handle();
    }

    if (user?.userId) {
      const resolution = await this.tenantResolver.resolve(this.resolutionInput(user));

      // `patch` rather than a store replacement, for the reason written on the method: the
      // merge is visible to every frame that shares the middleware's store, while an
      // `enterWith` after this `await` would publish only into this interceptor's own frame.
      // The route this interceptor still serves is the one reached WITHOUT
      // `TenantContextGuard` — it remains the fallback, not the primary writer.
      RequestContextService.patch({
        userId: user.userId,
        userEmail: user.email,
        userRole: user.role,
        tenantId: resolution.tenantId,
      });
    }

    return next.handle();
  }

  /** The resolver's input, taken from the verified principal and nothing else. */
  private resolutionInput(user: {
    userId?: string;
    claims?: TrustedTokenClaims | null;
  }): TenantResolutionInput {
    return {
      userId: user.userId ?? null,
      claims: user.claims ?? null,
    };
  }
}
