import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';

/**
 * Phase 51-HR-1: the HR request subject.
 *
 * WHY THIS IS A FUNCTION AND NOT A DECORATOR OR A FIELD ON THE DTO
 * ---------------------------------------------------------------
 * `tenantId` and `userId` must never be reachable from a request body or a query
 * string. The global `ValidationPipe` runs with `whitelist` +
 * `forbidNonWhitelisted`, so a `tenantId` field would be REJECTED rather than
 * honoured — but the stronger guarantee is that no HR DTO HAS such a field, and this
 * function is the only place the pair is produced. Every HR service method takes an
 * `HrActor` and scopes its every query by `actor.tenantId`; there is no code path
 * that reads a tenant from client input.
 *
 * WHERE THE TENANT COMES FROM
 * ---------------------------
 * `RequestContextService` is populated per request by `TenantContextInterceptor`,
 * which is registered globally in both `AppModule` and `CoreAppModule`. It derives
 * the tenant from the authenticated principal. Reading it here — rather than trusting
 * `req.user.tenantId` directly — is what makes HR agree with the Organization
 * Directory and with every other tenant-scoped surface: there is exactly one
 * resolution path.
 *
 * FAILING CLOSED: a request with no resolved tenant is FORBIDDEN (403), not
 * "unscoped". The alternative — falling back to a query with no tenant predicate —
 * is how a multi-tenant module ends up returning another tenant's personnel records,
 * so the absence of a tenant must be an error rather than a broader read.
 */
export interface HrActor {
  /** The tenant every query in this module is scoped by. Never client-supplied. */
  tenantId: string;
  /** The Core identity performing the change; `null` for a machine context. */
  userId: string | null;
  /** Required by `AuditService`; every audited HR write carries it. */
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

interface AuthenticatedRequestUser {
  sub?: string;
  id?: string;
}

/**
 * Resolves the actor, or throws.
 *
 * The `req.user.sub` fallback exists because HR can be reached from a request whose
 * context was not entered (a unit test that calls the controller directly); the
 * TENANT has no such fallback. `req.user.tenantId` is deliberately not consulted: if
 * the interceptor did not populate the context, the request is not tenant-resolved and
 * must fail rather than guess.
 */
export function resolveHrActor(req: Request): HrActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'HR requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;
  const userAgentHeader = req.headers?.['user-agent'];

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'hr-request',
    correlationId: context?.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}

/**
 * THERE IS DELIBERATELY NO `systemActor` / `systemHrActor` HELPER IN 51-HR-1.
 *
 * A module with no scheduler and no queue has no caller that runs outside a request, so
 * such a helper would be an export nobody calls — and the docstring justifying it would
 * be a claim about a call site that does not exist. When HR-4 adds the attendance
 * materialisation job, that job will need a tenant it was NOT given by a request, and
 * the correct answer then is for the caller to name the tenant explicitly (a
 * `systemActor(tenantId, requestId)` factory, introduced with its first real caller),
 * never for the request path to fall back to an inferred one. Adding the helper now
 * would make "no actor" expressible before anything needs to express it.
 */
