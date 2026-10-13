import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_PORT,
  type AuditEventInput,
  type AuditPort,
  type AuditReadQuery,
  type AuditReadResult,
} from '../../platform/audit/audit.contract';
import { FINANCIAL_AUDIT_RESOURCE } from './financial.constants';
import { FinancialPrismaService } from './database/financial-prisma.service';
import type { AuditOutboxPayload } from './check-request/check-request.repository';
import type { Prisma } from '../../generated/financial-client';

/**
 * The closed vocabulary of auditable Financial resources — a union drawn from the
 * `FINANCIAL_AUDIT_RESOURCE` record rather than a bare `string`.
 *
 * `ProductionAuditResource` narrows the same way, for the same reason: an unrestricted
 * `string` would let the first service record a resource name nobody has agreed to
 * search on, which makes "every mutation uses the audit gateway" true in form and useless
 * in practice — the trail would be queried by an ad-hoc string.
 */
export type FinancialAuditResource =
  (typeof FINANCIAL_AUDIT_RESOURCE)[keyof typeof FINANCIAL_AUDIT_RESOURCE];

/**
 * The `act` half of an audit event: what happened to what, described by the caller.
 *
 * Identical in shape to `ProductionAuditAct`, deliberately. `action`, `resource` and
 * `resourceId` are required by the platform contract; `success` and `reason` default;
 * and the before/after pair is optional because a lifecycle transition changes a state
 * rather than a value.
 */
export interface FinancialAuditAct {
  action: string;
  resource: FinancialAuditResource;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
}

/**
 * The ONE surface through which Financial writes audit events.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Audit is not optional for a bounded context: every mutating Financial service records
 * through this gateway, exactly as Production's and Commerce's do. Writing it directly —
 * each service injecting `AUDIT_PORT` and remembering the same envelope fields — would
 * put the interesting half of the trail's correctness in N places. The envelope is where
 * the tenant stamp lives: `tenantId: actor.tenantId`, taken from the actor rather than
 * from a caller-supplied field or a default.
 *
 * THIS GATEWAY OWNS ENVELOPE CONSTRUCTION, NOTHING ELSE. It generates `auditId`
 * (`randomUUID()` — never derived from `requestId`, because one request legitimately
 * emits many events and a re-delivered event must be recognised rather than duplicated),
 * takes `requestId`, `correlationId`, `actorId`, `ip` and `userAgent` off the actor, and
 * passes the caller's `act` through.
 *
 * Phase B2 — AUDIT DURABILITY: the gateway now offers TWO write paths:
 *
 *   1. `record(actor, act)` — the original best-effort path. It writes directly
 *      through `AUDIT_PORT` and swallows failures. Suitable for events whose loss
 *      is tolerable (e.g. supplementary metadata, non-critical observations).
 *
 *   2. `recordDurable(tx, actor, act)` — the durable path. It writes an
 *      `AuditOutbox` row in the SAME Prisma transaction as the business mutation,
 *      so the event is guaranteed to be delivered eventually. The relay service
 *      (`AuditOutboxRelayService`) drains the outbox asynchronously.
 *
 * Callers that do NOT pass a transaction client continue to use path 1 unchanged.
 * The `AuditOutbox` table lives in `finance_db` alongside the business data, so
 * the outbox write can participate in the business transaction atomically.
 */
@Injectable()
export class FinancialAuditGateway {
  private readonly logger = new Logger(FinancialAuditGateway.name);

  constructor(
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
    private readonly prisma: FinancialPrismaService,
  ) {}

  /**
   * Records ONE event, built from the actor and the caller's `act`.
   *
   * NEVER THROWS. A trail write is best-effort by contract: an audit failure must not
   * become a business error branch. A caller that received the result would be tempted to
   * `if (res.status !== 'recorded')` and roll back a request because a log line failed,
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
    act: FinancialAuditAct
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
        'Financial audit write failed',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  /**
   * Phase B2 — AUDIT DURABILITY: writes an audit event to the Financial outbox.
   *
   * This method writes the event to the `AuditOutbox` table WITHIN the caller's
   * Prisma transaction, so the outbox row commits or rolls back with the business
   * mutation. The `AuditOutboxRelayService` then reads pending rows and writes
   * them through `AUDIT_PORT`.
   *
   * WHEN TO USE THIS INSTEAD OF `record`:
   * - Compliance-critical lifecycle transitions (state changes, approvals,
   *   issue/delivery) where losing the audit event is unacceptable.
   *
   * NEVER THROWS: a failure to write the outbox row is logged and the method
   * returns, exactly like `record`. The business mutation is not affected.
   *
   * @param tx  A Prisma transaction client from the same `$transaction` that
   *            performs the business mutation. The outbox write participates in
   *            that transaction atomically.
   */
  async recordDurable(
    tx: { auditOutbox: { create: (args: { data: AuditOutboxPayload }) => Promise<unknown> } },
    actor: {
      tenantId: string;
      userId: string | null;
      requestId: string;
      correlationId?: string;
      ip: string | null;
      userAgent: string | null;
    },
    act: FinancialAuditAct
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

      await tx.auditOutbox.create({
        data: {
          tenantId: actor.tenantId,
          auditId,
          // Same JSON-envelope bridge as `buildOutboxPayload`: the event IS the
          // serialized input — the `Record` envelope is already Json-compatible,
          // so this passes it through the domain's own payload vocabulary.
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(
        'Financial audit durable write failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Phase B2.1 — AUDIT DURABILITY ADOPTION: builds an outbox payload for the
   * repository to write inside its own `$transaction`.
   *
   * The repository methods accept an optional `AuditOutboxPayload` and write the
   * outbox row atomically with the business mutation. This method builds the
   * payload — the gateway's ONLY responsibility is constructing the correct
   * envelope (tenant stamp, audit identity, actor context).
   *
   * The returned payload is passed to the repository, NOT written by this method.
   * The repository writes it inside `$transaction`.
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
    act: FinancialAuditAct
  ): { tenantId: string; auditId: string; payload: Prisma.InputJsonValue } {
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
    return { tenantId: actor.tenantId, auditId, payload: event as unknown as Prisma.InputJsonValue };
  }

  /**
   * The read half of the same port — the ONLY source of the check-request timeline.
   *
   * A PASSTHROUGH AND NOTHING ELSE. The query arrives ALREADY BUILT from trusted context:
   * the caller stamps `tenantId` from `resolveFinancialActor`, binds `resource` /
   * `resourceId` to a request it has already loaded tenant-scoped. This method decides
   * nothing — no filter, no default, no projection, no fallback page.
   *
   * A FAILURE IS NEVER TURNED INTO AN EMPTY RESULT: the port reports
   * `{ status: 'rejected', code }` instead of throwing, and this method returns that
   * rejection VERBATIM so the service can map it to a 503 rather than falsely claiming
   * "nothing was recorded".
   */
  async read(query: AuditReadQuery): Promise<AuditReadResult> {
    try {
      return await this.audit.read(query);
    } catch (error) {
      this.logger.error(
        'Financial audit read failed',
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'rejected', code: 'AUDIT_READ_FAILED' };
    }
  }
}
