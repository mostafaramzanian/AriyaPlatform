import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial request subject.
 *
 * WHY THIS FILE MIRRORS `resolveProductionActor` RATHER THAN INVENTING ITS OWN
 * ---------------------------------------------------------------------------
 * `tenantId` and `userId` must never be reachable from a request body, a query string or
 * a path parameter. Commerce, HR and Production established the pattern: one pure
 * function is the only place the pair is produced, every service method takes the actor
 * and scopes its work by `actor.tenantId`, and no DTO carries a server-owned identity
 * field. Financial repeats that shape deliberately — a fourth actor architecture would be
 * a fourth answer to "who is acting, in which tenant", and the four would drift the
 * moment one of them changed its fallback order.
 *
 * WHERE THE TENANT COMES FROM
 * ---------------------------
 * `RequestContextService` is populated per request by the established tenant-context
 * mechanism, which derives the tenant from the authenticated principal. Reading it here —
 * rather than trusting `req.user.tenantId` or any client-supplied field — is what makes
 * Financial agree with every other tenant-scoped surface: exactly one resolution path.
 * `req.body.tenantId`, `req.query.tenantId`, `req.params.tenantId` and
 * `req.user.tenantId` are all deliberately not consulted.
 *
 * FAILING CLOSED: a request with no resolved tenant is FORBIDDEN (403), never
 * "unscoped". The alternative — continuing without a tenant predicate — is how a
 * multi-tenant module reads another tenant's check requests.
 *
 * WHAT THIS FILE MUST NOT DO
 * --------------------------
 * It is synchronous request→context→actor translation and nothing else: no database, no
 * platform port, no directory lookup, no audit call, no permission or entitlement
 * decision, no lifecycle rule, no repository, no ambient mutable tenant state and no
 * caching. A resolver that reached for a database would make "may this request act?"
 * depend on infrastructure availability, and a resolver that cached the actor would let
 * one request's tenant leak into another's.
 */
export interface FinancialActor {
  /** The tenant every Financial operation is scoped by. Never client-supplied. */
  tenantId: string;
  /** The Core identity performing the change; `null` for a machine context. */
  userId: string | null;
  /** Required by the audit contract; every audited Financial write carries it. */
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
 * USER PRECEDENCE IS COPIED FROM `resolveProductionActor`, NOT RE-DESIGNED: `req.user.sub`,
 * then `req.user.id`, then the request context's `userId`, then `null`. A `null` userId
 * is legitimate (a machine/script caller), not an error — and the FINANCIAL RULES THAT
 * NEED A HUMAN (create's forced requester, every manager decision) refuse a `null` actor
 * in the service, each in its own vocabulary, rather than making this resolver guess.
 *
 * TENANT and USER resolution are deliberately NOT equivalent. The user may be absent; the
 * tenant may not. `req.user.tenantId` is not consulted: if the request context was never
 * populated, the request is not tenant-resolved and must fail rather than guess.
 */
export function resolveFinancialActor(req: Request): FinancialActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'Financial requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;
  const userAgentHeader = req.headers?.['user-agent'];

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'financial-request',
    correlationId: context?.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}
