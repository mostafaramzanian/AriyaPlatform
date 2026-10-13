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
import { COMMERCE_AUDIT_RESOURCE } from './commerce.constants';

/**
 * The closed vocabulary of auditable Commerce resources — a union drawn from the
 * `COMMERCE_AUDIT_RESOURCE` record rather than a bare `string`.
 *
 * HR's `HrAuditAct` types `resource: string` because its resource names were already
 * settled when the gateway was written. Commerce's step-G constants file exists to
 * record the same vocabulary BEFORE any mutating service does, and an unrestricted
 * `string` would let the first service record a resource name nobody has agreed to
 * search on — which makes §I8's "every mutation uses `CommerceAuditGateway`" true in
 * form and useless in practice, since the trail would be queried by an ad-hoc string.
 * Narrowing the type here is the only enforcement the compiler can offer: it is a union
 * of literal values, not an enumeration read from a database, so it cannot drift away
 * from what the platform actually accepts.
 *
 * TODO(step P and beyond): the record grows when payment, receiving and return arrive;
 * nothing else in this file changes.
 */
export type CommerceAuditResource =
  (typeof COMMERCE_AUDIT_RESOURCE)[keyof typeof COMMERCE_AUDIT_RESOURCE];

/**
 * The `act` half of an audit event: what happened to what, described by the caller.
 *
 * Identical in shape to `HrAuditAct`, deliberately. `action`, `resource` and `resourceId`
 * are required by the platform contract (`AUDIT_ACTION_MISSING`, `AUDIT_RESOURCE_MISSING`
 * and `AUDIT_RESOURCE_ID_MISSING` are rejections, not warnings), `success` and `reason`
 * default, and the before/after pair is optional because a grant or an approval changes
 * a state rather than a value. The Commerce-specific narrowing is `resource` alone.
 */
export interface CommerceAuditAct {
  action: string;
  resource: CommerceAuditResource;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
}

/**
 * Phase B2.3: the typed outbox payload a Commerce repository writes inside its
 * `$transaction`. Identical in shape to Financial's `AuditOutboxPayload`.
 */
export interface CommerceAuditOutboxPayload {
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
 * Phase C1 Step H (§21.H / gate I8): the ONE surface through which Commerce writes audit
 * events, and the tenant-scoped application of those events.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Audit is not optional for a bounded context: §I8 requires every mutating Commerce
 * service to record through this gateway. Writing it directly — each service injecting
 * `AUDIT_PORT` and remembering the same envelope fields — would put the interesting
 * half of the trail's correctness in N places. The envelope is where the tenant stamp
 * lives: `tenantId: actor.tenantId`, taken from the actor rather than from a
 * caller-supplied field or a default. A service that invents its own envelope eventually
 * produces a "global" audit row that no tenant scoping can reach afterwards, and
 * `AuditLog` has no update path that could correct it.
 *
 * THIS GATEWAY OWNS ENVELOPE CONSTRUCTION, NOTHING ELSE
 * -----------------------------------------------------
 * It generates `auditId` (`randomUUID()` — per §9, never derived from `requestId`), takes
 * `requestId`, `correlationId`, `actorId`, `ip` and `userAgent` off the actor, and passes
 * the caller's `act` through. It does not decide WHETHER a mutation is auditable, does
 * not decide what a purchase document's "before" value is, and does not expose the
 * result — `record` returns `Promise<void>`, because §9 requires that an audit write
 * failure must not turn a completed business mutation into a 500. The platform's
 * `AuditPort` never throws; it reports `status: 'rejected'` for the caller to log, so
 * there is no failure branch a business service could take.
 *
 * WHAT THIS FILE MUST NEVER OWN (gate I8 restated)
 * -----------------------------------------------
 * It must never write a Commerce audit table, because Commerce has none and adding one
 * would give the module two trails that disagree on what "recorded" means. It must never
 * import `HrPrismaService` or a Core generated client. It must never contain a
 * Commerce-specific result mapping: the result belongs to the platform contract.
 *
 * THE ACTOR PARAMETER IS STRUCTURAL, ON PURPOSE
 * ---------------------------------------------
 * Declared inline rather than as a named actor type, for the reason documented in
 * `commerce-identity.gateway.ts`: `commerce-actor.ts` arrives in step I, and a second
 * actor model written here would have to be reconciled with it. Structural typing means
 * the Step-I `resolveCommerceActor(req)` value satisfies this signature as written.
 *
 * The compiler cannot enforce the single surface — structural DI lets any file write
 * `@Inject(AUDIT_PORT)` and type-check. The Step-H guard scans the module for a second
 * reference and fails instead.
 */
@Injectable()
export class CommerceAuditGateway {
  private readonly logger = new Logger(CommerceAuditGateway.name);

  constructor(@Inject(AUDIT_PORT) private readonly audit: AuditPort) {}

  /**
   * Hand the platform ONE event. Never throws — an audit write failing must not turn a
   * completed business mutation into a 500 — so the only path that can raise is caught
   * and logged here rather than propagated.
   *
   * WHY `Promise<void>` AND NOT `Promise<AuditRecordResult>`: an audit failure must not
   * become a business error branch. A caller that received the result would be tempted
   * to `if (res.status !== 'recorded')` and roll back a purchase order because a log line
   * failed, coupling the mutation's outcome to a separate system's availability. §9 says
   * the write is attempted and reported — never that the caller may act on it.
   *
   * `randomUUID` is required, not optional: `auditId` is the idempotency key, and §9
   * forbids deriving it from `requestId`, because one request legitimately emits many
   * events and a re-delivered event must be recognised rather than duplicated.
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
    act: CommerceAuditAct
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
        'Commerce audit write failed',
        error instanceof Error ? error.stack : String(error)
      );
    }
  }

  /**
   * PHASE C7 (GAP-7): ask the platform for events ALREADY RECORDED — the read half of
   * the same port, extended in the smallest possible way now that P-AUDIT-READ provides
   * `AuditPort.read`.
   *
   * WHY THIS IS A PASSTHROUGH AND NOTHING ELSE
   * ------------------------------------------
   * The query arrives ALREADY BUILT from trusted context: the caller (the timeline
   * service) stamps `tenantId` from `resolveCommerceActor`, and binds `resource` /
   * `resourceId` to a document it has already loaded tenant-scoped. This method decides
   * nothing — no filter, no default, no projection, no fallback page — because every one
   * of those would be a SECOND opinion about what a platform read means, and the
   * contract (`docs/PHASE-P-AUDIT-READ-CONTRACT.md`) is the single source for that.
   *
   * A FAILURE IS NEVER TURNED INTO AN EMPTY RESULT. The port reports
   * `{ status: 'rejected', code }` instead of throwing (one error idiom for `record` and
   * `read`), and this method returns that rejection VERBATIM so the service can map it to
   * a 503 — an empty page would falsely claim "nothing was recorded". The `catch` below
   * exists only for a bound implementation that would violate the port's never-throw
   * promise: it is CLASSIFIED as the closed `AUDIT_READ_FAILED` code and logged, not
   * swallowed and not re-thrown as an unclassified error.
   *
   * WHAT THIS METHOD MUST NEVER EXPOSE: a Prisma client, `core_db."AuditLog"`, the
   * internal `PlatformAuditService`, or any raw row. Only the port's typed
   * `AuditReadResult` crosses this boundary — the same rule `record` follows.
   */
  /**
   * Phase B2.3: build an immutable outbox payload WITHOUT writing anything.
   *
   * The caller (a service) constructs this BEFORE entering the unit of work,
   * then passes it into the repository where it is written atomically inside
   * the Commerce `$transaction`. The gateway never holds a transaction handle
   * (Commerce's opaque-handle architecture forbids it), so the durable write
   * is the repository's responsibility — this method only constructs the data.
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
    act: CommerceAuditAct
  ): CommerceAuditOutboxPayload {
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

  async read(query: AuditReadQuery): Promise<AuditReadResult> {
    try {
      return await this.audit.read(query);
    } catch (error) {
      this.logger.error(
        'Commerce audit read failed',
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'rejected', code: 'AUDIT_READ_FAILED' };
    }
  }
}
