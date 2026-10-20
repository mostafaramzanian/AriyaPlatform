import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { RequestContextService } from '../../common/request-context.service';

/**
 * Phase W1: the Inventory request subject — the same shape `resolveCommerceActor`
 * and `resolveFinancialActor` established, adopted rather than reinvented.
 *
 * `tenantId` comes only from the populated request context; `req.user.tenantId`,
 * `req.body.tenantId` and every other client-supplied path are deliberately not
 * consulted. No tenant context → FORBIDDEN, never "unscoped". No database, no
 * permission decision, no caching — request→context→actor translation only.
 */
export interface InventoryActor {
  /** The tenant every Inventory operation is scoped by. Never client-supplied. */
  tenantId: string;
  /** The Core identity performing the change; `null` for a machine context. */
  userId: string | null;
  /** Required by the audit contract; every audited write carries it. */
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

interface AuthenticatedRequestUser {
  sub?: string;
  id?: string;
}

export function resolveInventoryActor(req: Request): InventoryActor {
  const context = RequestContextService.get();
  const tenantId = context?.tenantId ?? null;

  if (!tenantId) {
    throw new ForbiddenException(
      'Inventory requires a tenant context; this request was not resolved to a tenant.'
    );
  }

  const user = (req as Request & { user?: AuthenticatedRequestUser }).user;
  const userId = user?.sub ?? user?.id ?? context?.userId ?? null;
  const userAgentHeader = req.headers?.['user-agent'];

  return {
    tenantId,
    userId,
    requestId: context?.requestId ?? 'inventory-request',
    correlationId: context?.correlationId,
    ip: req.ip ?? null,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}
