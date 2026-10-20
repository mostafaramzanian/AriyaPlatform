import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_PORT,
  type AuditEventInput,
  type AuditPort,
} from '../../platform/audit/audit.contract';
import { INVENTORY_AUDIT_RESOURCE } from './inventory.constants';

/**
 * The closed vocabulary of auditable Inventory resources — a union drawn from
 * `INVENTORY_AUDIT_RESOURCE`, not a bare string.
 */
export type InventoryAuditResource =
  (typeof INVENTORY_AUDIT_RESOURCE)[keyof typeof INVENTORY_AUDIT_RESOURCE];

export interface InventoryAuditAct {
  action: string;
  resource: InventoryAuditResource;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
}

/**
 * The ONE surface through which Inventory writes audit events — the envelope is
 * where the tenant stamp lives (`tenantId` from the actor, never a request
 * field). NEVER THROWS: a trail write is best-effort by the platform contract.
 */
@Injectable()
export class InventoryAuditGateway {
  private readonly logger = new Logger(InventoryAuditGateway.name);

  constructor(@Inject(AUDIT_PORT) private readonly audit: AuditPort) {}

  async record(
    actor: {
      tenantId: string;
      userId: string | null;
      requestId: string;
      correlationId?: string;
      ip: string | null;
      userAgent: string | null;
    },
    act: InventoryAuditAct
  ): Promise<void> {
    try {
      const auditId = randomUUID();
      const event: AuditEventInput = {
        ...act,
        auditId,
        tenantId: actor.tenantId,
        requestId: actor.requestId,
        correlationId: actor.correlationId,
        actorId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      };
      await this.audit.record(event);
    } catch (error) {
      this.logger.error(
        'Inventory audit write failed',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }
}
