/**
 * Phase KPI-RUNTIME — the KPI request subject.
 *
 * Mirrors `resolveReportingActor` deliberately rather than importing it: a second ACTOR
 * ARCHITECTURE would be a second answer to «who is acting, in which tenant», and this context
 * must be able to state its own contract instead of reaching into Reporting for a helper —
 * the isolation suites fail the build on exactly the kind of cross-context reach that would
 * make `reporting` the owner of KPI authorization.
 *
 * THE TENANT COMES ONLY FROM THE REQUEST CONTEXT. Never `req.user.tenantId`, never a query,
 * body or path field: a missing tenant is 403, never "unscoped", so there is no shape of a KPI
 * route that could read another tenant's rows. The global `whitelist` +
 * `forbidNonWhitelisted` pipe turns a sent `tenantId` into a 422 before it reaches here.
 */

import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';
import type { TrustedTokenClaims } from '../../platform/auth/token-contract';

export interface KpiRuntimeActor {
  tenantId: string;
  userId: string;
  requestId: string;
  /**
   * The VERIFIED claims the token verifier produced, or `null`.
   *
   * Carried — rather than passing `null` the way the search-source adapter does — because
   * `PermissionSource` reads them at ASYMMETRIC trust: with `claims: null` a
   * `TokenPermissionSource` answers `[]` for everyone, which would make every KPI 403 for
   * every caller in a Core-free runtime. `RolesGuard` passes `user.claims ?? null` for the
   * same reason, so this is the identical answer under the identical input.
   */
  claims: TrustedTokenClaims | null;
}

interface AuthenticatedRequestUser {
  sub?: string;
  id?: string;
  claims?: TrustedTokenClaims | null;
}

/**
 * The subject a KPI read runs as, or a 403.
 *
 * BOTH the tenant and the user id are required: the tenant scopes every seam read, and the
 * user id is the subject `PermissionSource.getEffectivePermissions` is asked about — a KPI
 * whose caller has no identity cannot be filtered by remit, so it must not be served at all.
 */
export function resolveKpiRuntimeActor(req: Request): KpiRuntimeActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'A KPI read requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;

  if (!userId) {
    throw new ForbiddenException(
      'A KPI read requires an identified subject; no user is attached to this request.'
    );
  }

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'kpi-runtime-request',
    claims: user?.claims ?? null,
  };
}
