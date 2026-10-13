import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';

/**
 * Phase C1 Step I (§21.I / gate I10): the Commerce request subject.
 *
 * WHY THIS FILE MIRRORS `hr-actor.ts` RATHER THAN INVENTING ITS OWN
 * ----------------------------------------------------------------
 * `tenantId` and `userId` must never be reachable from a request body, a query string
 * or a path parameter. HR established the pattern: one pure function is the only place
 * the pair is produced, every service method takes the actor and scopes its work by
 * `actor.tenantId`, and no DTO carries a server-owned identity field. Commerce repeats
 * that shape deliberately — a second actor architecture would be a second answer to
 * "who is acting, in which tenant", and the two would drift the moment one of them
 * changed its fallback order.
 *
 * WHERE THE TENANT COMES FROM
 * ---------------------------
 * `RequestContextService` is populated per request by the established tenant-context
 * mechanism, which derives the tenant from the authenticated principal. Reading it here
 * — rather than trusting `req.user.tenantId` or any client-supplied field — is what
 * makes Commerce agree with every other tenant-scoped surface: exactly one resolution
 * path. `req.body.tenantId`, `req.query.tenantId`, `req.params.tenantId` and
 * `req.user.tenantId` are all deliberately not consulted.
 *
 * FAILING CLOSED: a request with no resolved tenant is FORBIDDEN (403), never
 * "unscoped". The alternative — continuing without a tenant predicate — is how a
 * multi-tenant module reads another tenant's purchase documents, so the absence of a
 * tenant must be an error rather than a broader read.
 *
 * WHAT THIS FILE MUST NOT DO (§21.I)
 * ---------------------------------
 * It is synchronous request→context→actor translation and nothing else: no database,
 * no platform port, no directory lookup, no audit call, no notification, no permission
 * or entitlement decision (those arrive with step J), no workflow, no repository, no
 * ambient mutable tenant state and no caching. A resolver that reached for a database
 * would make "may this request act?" depend on infrastructure availability, and a
 * resolver that cached the actor would let one request's tenant leak into another's.
 */
export interface CommerceActor {
  /** The tenant every Commerce operation is scoped by. Never client-supplied. */
  tenantId: string;
  /** The Core identity performing the change; `null` for a machine context. */
  userId: string | null;
  /** Required by the audit contract; every audited Commerce write carries it. */
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
 * USER PRECEDENCE IS COPIED FROM `resolveHrActor`, NOT RE-DESIIGNED: `req.user.sub`,
 * then `req.user.id`, then the request context's `userId`, then `null`. A `null`
 * userId is legitimate (a machine/script caller), not an error.
 *
 * TENANT and USER resolution are deliberately NOT equivalent. The user may be absent;
 * the tenant may not. `req.user.tenantId` is not consulted: if the request context was
 * never populated, the request is not tenant-resolved and must fail rather than guess.
 */
export function resolveCommerceActor(req: Request): CommerceActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'Commerce requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;
  const userAgentHeader = req.headers?.['user-agent'];

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'commerce-request',
    correlationId: context?.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}
