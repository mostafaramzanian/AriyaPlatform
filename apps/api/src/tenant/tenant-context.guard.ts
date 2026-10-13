import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import {
  TenantResolver,
  type TenantResolutionInput,
} from '../platform/auth/tenant-resolver.contract';
import type { TrustedTokenClaims } from '../platform/auth/token-contract';

/**
 * Phase 54-C (D14, §43.5): the tenant context, established in the GUARD PHASE.
 *
 * WHY THIS EXISTS, AND WHY THE INTERCEPTOR ALONE WAS NOT ENOUGH
 * -------------------------------------------------------------
 * `TenantContextInterceptor` has populated `RequestContextService` per request since
 * Phase 51-HR-ARCH-3A, and every consumer that reads it — HR's `resolveHrActor`, the
 * directory, `ModuleRegistryService.resolve`, notifications — is a SERVICE or a HANDLER,
 * which runs after interceptors. That is why an interceptor was sufficient for four
 * phases, and why the gap it leaves went unnoticed:
 *
 *   Nest's request lifecycle is middleware → GUARDS → interceptors → pipes → handler.
 *
 * `ModuleEntitlementGuard` is the first consumer in this repository that runs in the GUARD
 * phase, because §43.5 puts the entitlement gate after authentication and authorization and
 * before the handler. At that moment the interceptor has NOT run, so
 * `RequestContextService` still carries no tenant, so `PlatformEntitlementService` — which
 * reads the tenant from that context deliberately, so that no query parameter, header, body
 * field or DTO can influence the decision — resolved `null` and refused every
 * tenant-scoped module with `MODULE_FORBIDDEN`.
 *
 * The consequence was total: the gate was DEAD ON ARRIVAL in the real process. HR was
 * unreachable for every tenant, including the 162 the D16 seed had just enrolled, and the
 * refusal named the wrong reason (a tenancy that did not exist rather than a missing
 * grant). It is not visible to a unit test that hands the guard a prepared context — it is
 * a fact about WHERE the guard sits in the chain — which is why the runtime suite
 * (`test/module-entitlement-runtime.e2e-spec.ts`) is what found it, and why that suite is
 * the regression test for this file.
 *
 * WHAT THIS GUARD DOES, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------
 * It resolves the tenant through the SAME `TenantResolver` port the interceptor uses —
 * claim-first (`tid`, no Core read) with the Core bridge for legacy tokens — and publishes
 * it to `RequestContextService` before any controller-level guard runs. It reads the
 * principal from `request.user`, which is what passport put there when `JwtAuthGuard`
 * authenticated the request, and NOTHING ELSE: no query parameter, header, body field or
 * DTO is in its reach, so establishing the context here cannot reopen what §43.5 closed.
 *
 * IT NEVER REFUSES. "No tenant" is a value, not a failure — the same contract
 * `ClaimsTenantResolver` states — so refusing stays where the decision belongs: in the gate
 * that needed a tenant, with the failure code that names the real reason. A `@Public()`
 * route has no principal and passes through untouched.
 *
 * IT RESOLVES AT MOST ONCE PER REQUEST. The interceptor keeps the same job and the same
 * port, and remains the fallback for any route reached without this guard, so both sides
 * ask whether a tenant is already established before consulting the resolver. That is what
 * keeps the per-request Core read count for a legacy token at exactly one — the property
 * `tenant-context.interceptor.spec.ts` pins with `toHaveBeenCalledTimes(1)`.
 *
 * `undefined` IS THE ONLY "NOT YET" VALUE. `null` is a real answer (a tenant-less caller)
 * and is never re-resolved: re-asking would turn an authoritative "no tenant" into a
 * second query whose answer nobody checked.
 *
 * ORDERING IS THE WHOLE POINT: this is registered as a global guard AFTER `JwtAuthGuard`,
 * because a guard that runs before authentication has no verified principal to resolve
 * from. `RolesGuard` already depends on that same ordering, which is why both runtimes
 * register the three in this order.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly tenantResolver: TenantResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest();
    const user = request?.user;

    // No verified principal — a `@Public()` route, or a runtime whose authentication guard
    // has not run yet. There is no tenant to resolve and no refusal to add.
    if (!user?.userId) return true;

    // Already established for this request.
    if (RequestContextService.get()?.tenantId !== undefined) return true;

    const resolution = await this.tenantResolver.resolve(this.resolutionInput(user));

    // `patch`, NOT `set` — and this is the difference between a gate that works and a gate
    // that refuses everything. This guard AWAITS the resolver above, and Nest runs guards as
    // a flat loop in one frame: an `enterWith` store replacement performed after that await
    // is scoped to this guard's child frame, so the guards that run after it (including
    // `ModuleEntitlementGuard`) and the handler both read the OLD store. `patch` mutates the
    // store the middleware established, which every frame below shares, so the tenant is
    // visible where it is needed. Measured, not assumed: `test/module-entitlement-runtime.
    // e2e-spec.ts` fails with `MODULE_FORBIDDEN` on every HR route if this line regresses.
    RequestContextService.patch({
      userId: user.userId,
      userEmail: user.email,
      userRole: user.role,
      tenantId: resolution.tenantId,
    });

    return true;
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
