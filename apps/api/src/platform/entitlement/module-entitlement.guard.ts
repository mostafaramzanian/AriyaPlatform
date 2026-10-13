import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ENTITLEMENT_PORT,
  FEATURE_REQUIREMENT_KEY,
  MODULE_REQUIREMENT_KEY,
  combineEntitlementRequirement,
  type EntitlementPort,
  type FeatureRequirement,
} from './entitlement.contract';

/**
 * Phase 54-C (D14, §43.5): the entitlement gate, declared at the boundary and never called
 * from a service.
 *
 * WHERE IT SITS IN THE CHAIN, AND WHY THAT ORDER IS THE DESIGN
 * ------------------------------------------------------------
 *   1. `JwtAuthGuard` (global, APP_GUARD)      — is there an authenticated actor?
 *   2. `RolesGuard` (global, APP_GUARD)        — does the actor hold the required permission?
 *   3. `ModuleEntitlementGuard` (controller)   — is this tenancy entitled?
 *   4. the handler, which then applies its own tenant condition (§24).
 *
 * Entitlement is therefore evaluated AFTER authentication and authorization: an unauthenticated
 * or unauthorized request never reaches the registry. And entitlement is NOT a permission — a
 * `SUPER_ADMIN` holding every permission code is still refused here when the tenancy is not
 * entitled. Routine RBAC administration cannot grant module access, which is the whole point of
 * §5's two-layer model.
 *
 * THIS GUARD NEVER TOUCHES THE REQUEST. That is not an omission, it is the mechanism: the
 * tenant is read inside the port from `RequestContextService`, the same source `resolve()` uses,
 * so no query parameter, header, body field or DTO can influence the decision — there is no code
 * path here that could read one. The guard reads two pieces of METADATA and asks one question.
 *
 * A DECORATED SURFACE WITH NO DECLARATION IS REFUSED. If neither `@RequiresModule` nor
 * `@RequiresFeature` is present the request is refused with
 * `ENTITLEMENT_NOT_DECLARED`, and the port is NOT asked: a forgotten decorator must close a
 * door, not open one, and consulting the registry first would make the missing declaration
 * indistinguishable from a real entitlement decision in the logs.
 *
 * THE REFUSAL IS TOTAL AND UNIFORM: `403` with a stable body
 * `{ statusCode, code, moduleId, featureId? }`. The code is a frozen §43.2 failure code, so an
 * operator and a support engineer read the same sentence. Denials are deliberately NOT written
 * to the audit trail — an audit trail records events that happened to the system, and a refused
 * request changed nothing (the attempt is already an access-log fact).
 */
@Injectable()
export class ModuleEntitlementGuard implements CanActivate {
  constructor(
    @Inject(ENTITLEMENT_PORT) private readonly port: EntitlementPort,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler first, class second: a handler-level declaration overrides the class-level one,
    // which is the `getAllAndOverride` order `JwtAuthGuard` and `RolesGuard` both use.
    const requirement = combineEntitlementRequirement(
      this.reflector.getAllAndOverride<string | undefined>(MODULE_REQUIREMENT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
      this.reflector.getAllAndOverride<FeatureRequirement | undefined>(FEATURE_REQUIREMENT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    );

    if (requirement === null) {
      throw new ForbiddenException({ statusCode: 403, code: 'ENTITLEMENT_NOT_DECLARED' });
    }

    const decision = await this.port.decide(requirement);

    if (decision.ok) return true;

    throw new ForbiddenException({
      statusCode: 403,
      code: decision.failure,
      moduleId: requirement.moduleId,
      // Echoed only when the surface declared a feature: the field states what was asked, so
      // its absence means "the module level was the question", never "unknown".
      ...(requirement.featureId === undefined ? {} : { featureId: requirement.featureId }),
    });
  }
}
