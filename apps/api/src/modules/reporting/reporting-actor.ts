import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the Reporting request subject.
 *
 * Mirrors `resolveFinancialActor` deliberately — a second actor architecture
 * would be a second answer to «who is acting, in which tenant». The tenant
 * comes ONLY from the request context (never `req.user.tenantId`, never a
 * client field); a missing tenant is 403, never «unscoped».
 */
export interface ReportingActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

interface AuthenticatedRequestUser {
  sub?: string;
  id?: string;
}

export function resolveReportingActor(req: Request): ReportingActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'Reporting requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;
  const userAgentHeader = req.headers?.['user-agent'];

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'reporting-request',
    correlationId: context?.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}
