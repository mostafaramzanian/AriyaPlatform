import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_PORT,
  type AuditEventInput,
  type AuditOutboxJsonValue,
  type AuditPort,
  type AuditReadQuery,
  type AuditReadResult,
} from '../../platform/audit/audit.contract';
import { PRODUCTION_AUDIT_RESOURCE } from './production.constants';

/**
 * The closed vocabulary of auditable Production resources — a union drawn from the
 * `PRODUCTION_AUDIT_RESOURCE` record rather than a bare `string`.
 *
 * `CommerceAuditResource` narrows the same way, for the same reason: an unrestricted
 * `string` would let the first service record a resource name nobody has agreed to
 * search on, which makes "every mutation uses the audit gateway" true in form and
 * useless in practice — the trail would be queried by an ad-hoc string. The union is a
 * set of literal values, not an enumeration read from a database, so it cannot drift
 * away from what the platform actually accepts.
 */
export type ProductionAuditResource =
  (typeof PRODUCTION_AUDIT_RESOURCE)[keyof typeof PRODUCTION_AUDIT_RESOURCE];

/**
 * The `act` half of an audit event: what happened to what, described by the caller.
 *
 * Identical in shape to `CommerceAuditAct`, deliberately. `action`, `resource` and
 * `resourceId` are required by the platform contract (`AUDIT_ACTION_MISSING`,
 * `AUDIT_RESOURCE_MISSING` and `AUDIT_RESOURCE_ID_MISSING` are rejections, not
 * warnings), `success` and `reason` default, and the before/after pair is optional
 * because a lifecycle transition changes a state rather than a value.
 */
export interface ProductionAuditAct {
  action: string;
  resource: ProductionAuditResource;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
}

/**
 * Phase B2.4: the typed outbox payload a Production repository writes inside its
 * `$transaction`. Identical in shape to Commerce's `CommerceAuditOutboxPayload`
 * and Financial's `AuditOutboxPayload`.
 */
export interface ProductionAuditOutboxPayload {
  tenantId: string;
  auditId: string;
  /**
   * The serialized `AuditEventInput` in the Prisma `Json` input vocabulary,
   * declared through the platform's structural mirror (`AuditOutboxJsonValue`)
   * so this gateway never imports a generated client. The builders construct
   * exactly this shape before the repository writes it, so
   * `create({ data: outbox })` needs no assertion at the call site.
   */
  payload: AuditOutboxJsonValue;
}

/**
 * The ONE surface through which Production writes audit events.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Audit is not optional for a bounded context: every mutating Production service records
 * through this gateway, exactly as Commerce's does. Writing it directly — each service
 * injecting `AUDIT_PORT` and remembering the same envelope fields — would put the
 * interesting half of the trail's correctness in N places. The envelope is where the
 * tenant stamp lives: `tenantId: actor.tenantId`, taken from the actor rather than from
 * a caller-supplied field or a default. A service that invents its own envelope
 * eventually produces a "global" audit row that no tenant scoping can reach afterwards,
 * and `AuditLog` has no update path that could correct it.
 *
 * THIS GATEWAY OWNS ENVELOPE CONSTRUCTION, NOTHING ELSE. It generates `auditId`
 * (`randomUUID()` — never derived from `requestId`, because one request legitimately
 * emits many events and a re-delivered event must be recognised rather than duplicated),
 * takes `requestId`, `correlationId`, `actorId`, `ip` and `userAgent` off the actor, and
 * passes the caller's `act` through.
 *
 * PRODUCTION KEEPS NO AUDIT TABLE. Rows land in `core_db."AuditLog"`, the platform's ONE
 * trail, through `AUDIT_PORT` and nothing else.
 */
@Injectable()
export class ProductionAuditGateway {
  private readonly logger = new Logger(ProductionAuditGateway.name);

  constructor(@Inject(AUDIT_PORT) private readonly audit: AuditPort) {}

  /**
   * Records ONE event, built from the actor and the caller's `act`.
   *
   * NEVER THROWS. A trail write is best-effort by contract: an audit failure must not
   * become a business error branch. A caller that received the result would be tempted to
   * `if (res.status !== 'recorded')` and roll back a BOM because a log line failed,
   * coupling the mutation's outcome to a separate system's availability.
   */
  async record(
    actor: {
      /** The tenant every audit event is stamped with; server-side, never a request field. */
      tenantId: string;
      userId: string | null;
      requestId: string;
      correlationId?: string;
      ip: string | null;
      userAgent: string | null;
    },
    act: ProductionAuditAct
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
        'Production audit write failed',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  /**
   * Phase B2.4: build an immutable outbox payload WITHOUT writing anything.
   *
   * The caller (a service) constructs this BEFORE entering the repository
   * transaction, then passes it into the repository where it is written
   * atomically inside the Production `$transaction`. The gateway never holds
   * a transaction handle, so the durable write is the repository's
   * responsibility — this method only constructs the data.
   *
   * The returned object carries `tenantId`, `auditId` and `payload` — exactly
   * what `AuditOutbox.create` expects. `payload` is the full `AuditEventInput`
   * cast to `Record<string, unknown>` for Prisma JSON compatibility.
   */
  buildOutboxPayload(
    actor: {
      tenantId: string;
      userId: string | null;
      requestId: string;
      correlationId?: string;
      ip: string | null;
      userAgent: string | null;
    },
    act: ProductionAuditAct
  ): ProductionAuditOutboxPayload {
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
    return {
      tenantId: actor.tenantId,
      auditId,
      payload: event as unknown as AuditOutboxJsonValue,
    };
  }

  /**
   * The read half of the same port, exposed for a future BOM audit timeline.
   *
   * A PASSTHROUGH AND NOTHING ELSE. The query arrives ALREADY BUILT from trusted context:
   * the caller stamps `tenantId` from `resolveProductionActor`, and binds
   * `resource` / `resourceId` to a BOM it has already loaded tenant-scoped. This method
   * decides nothing — no filter, no default, no projection, no fallback page — because
   * every one of those would be a SECOND opinion about what a platform read means.
   *
   * A FAILURE IS NEVER TURNED INTO AN EMPTY RESULT: the port reports
   * `{ status: 'rejected', code }` instead of throwing, and this method returns that
   * rejection VERBATIM so a caller can map it to a 503 rather than falsely claiming
   * "nothing was recorded".
   *
   * TWO CALLERS READ THROUGH HERE (Phase PRODUCTION-BOM-AUDIT-TIMELINE gave it its
   * first): `BomHeaderService.getTimeline` for the `production/boms/:id/timeline` route,
   * and the Production reporting seam (`production/reporting/**`) for the Production
   * report timeline. Both stamp the query from tenant-scoped context and bind
   * `resource`/`resourceId` to a row they have already loaded — this method decides
   * nothing about either.
   */
  async read(query: AuditReadQuery): Promise<AuditReadResult> {
    try {
      return await this.audit.read(query);
    } catch (error) {
      this.logger.error(
        'Production audit read failed',
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'rejected', code: 'AUDIT_READ_FAILED' };
    }
  }
}
