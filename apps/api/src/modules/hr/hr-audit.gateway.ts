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
import { HrActor } from './hr-actor';

/**
 * Phase B2.5: the shape written atomically with the business mutation in the
 * HR-local `AuditOutbox`. The relay reads this later and delivers through
 * `AUDIT_PORT`.
 */
export interface HrAuditOutboxPayload {
  readonly tenantId: string;
  readonly auditId: string;
  /**
   * Same envelope as Financial's `AuditOutboxPayload`: the JSON the
   * `AuditOutbox.payload` column accepts, built before the repository writes.
   */
  readonly payload: AuditOutboxJsonValue;
}

/**
 * Everything an HR service is allowed to state about an act it audited.
 *
 * NOTE WHAT IS ABSENT, because the absence is the design: there is no `tenantId` and no
 * `auditId` here. A service cannot pass a tenant — not because a rule forbids it but because
 * the field does not exist — so it cannot pass the WRONG one; and it cannot invent an event
 * identity, so "one logical act, one identity" is decided in one place instead of four.
 * `requestId`/`userId`/`ip`/`userAgent` are absent for the same reason: they are facts about the
 * REQUEST, and the gateway already holds the actor that carries them.
 */
export interface HrAuditAct {
  action: string;
  resource: string;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
}

/**
 * Phase ARCH-3B (§6/§16): the ONE surface through which HR writes to the platform audit trail.
 *
 * WHY HR DOES NOT INJECT THE AUDIT PORT DIRECTLY
 * ---------------------------------------------
 * Four services and twelve call sites would each have to remember `tenantId: actor.tenantId`
 * and a fresh `auditId`. That is the same failure shape `HrIdentityGateway` exists to prevent:
 * a second injection point is how one call site eventually forgets the tenant and writes an
 * unattributable audit row — and an audit row with no tenant is exactly the evidence gap the
 * narrowed ARCH-3B migration refuses to fabricate. Here the tenant and the identity are stamped
 * once, from the actor, so forgetting them is not expressible.
 *
 * WHY THE IDENTITY IS MINTED, AND WHY IT IS NOT `requestId` (§3)
 * -------------------------------------------------------------
 * `auditId` is a fresh UUID per logical act. It is deliberately NOT `actor.requestId`: a request
 * may perform several acts (create a unit, then a position), and an identity shared by several
 * events is the property the old `requestId` UNIQUE constraint had and that ARCH-3B removed.
 * Minting here rather than in the four services also means HR has ONE answer to "what is this
 * event's identity", which is what lets the platform recognise a genuine replay when a producer
 * supplies a stable id of its own.
 *
 * THE RESULT IS NOT RETURNED, AND FAILURES DO NOT THROW. Same rule as the legacy service: an
 * audit write must never turn a completed mutation into a 500, and an HR caller has nothing
 * useful to do with the outcome other than log it — which this method does, at error level,
 * because a rejected or conflicting audit event is an operator's alarm, not a caller's.
 */
@Injectable()
export class HrAuditGateway {
  private readonly logger = new Logger(HrAuditGateway.name);

  constructor(@Inject(AUDIT_PORT) private readonly audit: AuditPort) {}

  /** Writes one HR act to the platform trail. Never throws, never returns a partial result. */
  async record(actor: HrActor, act: HrAuditAct): Promise<void> {
    // The actor-derived fields come LAST, so a field added to `HrAuditAct` later cannot shadow
    // the tenant or the identity: the gateway's values win by construction, not by review.
    const event: AuditEventInput = {
      ...act,
      auditId: randomUUID(),
      tenantId: actor.tenantId,
      requestId: actor.requestId,
      correlationId: actor.correlationId,
      actorId: actor.userId,
      ip: actor.ip,
      userAgent: actor.userAgent,
    };

    try {
      const result = await this.audit.record(event);

      if (result.status === 'rejected' || result.status === 'conflict') {
        this.logger.error(
          {
            status: result.status,
            code: result.code,
            auditId: event.auditId,
            tenantId: actor.tenantId,
            act: `${act.resource}.${act.action}`,
            resourceId: act.resourceId,
          },
          'The platform refused an HR audit event; the mutation itself is unaffected'
        );
      }
    } catch (err) {
      // The port is contractually incapable of throwing. A BINDING is not: a transport-backed
      // one can fail in ways nobody enumerated, and losing the audit row is still better than
      // failing the personnel change it describes.
      this.logger.error({ err, tenantId: actor.tenantId }, 'HR audit write failed');
    }
  }

  /**
   * Phase B2.5: constructs a typed outbox payload WITHOUT writing anything.
   *
   * The service calls this BEFORE the repository mutation. The repository then
   * writes the payload atomically with the business mutation inside one `$transaction`.
   * The relay reads the outbox later and delivers through `AUDIT_PORT`.
   *
   * The payload preserves the same audit contract as `record()` — same fields, same
   * tenant resolution, same identity minting — but the write is deferred to the caller's
   * transaction, which is what makes the guarantee transactional rather than best-effort.
   */
  buildOutboxPayload(actor: HrActor, act: HrAuditAct): HrAuditOutboxPayload {
    return Object.freeze({
      tenantId: actor.tenantId,
      auditId: randomUUID(),
      // Same envelope bridge as the other domains: `act`'s `oldValue`/`newValue`
      // are intentionally `unknown` (HR acts carry personnel documents of any
      // shape), so the record crosses into the outbox JSON vocabulary here —
      // the single construction site, not at every repository call site.
      payload: Object.freeze({
        ...act,
        tenantId: actor.tenantId,
        requestId: actor.requestId,
        correlationId: actor.correlationId,
        actorId: actor.userId,
        ip: actor.ip,
        userAgent: actor.userAgent,
      }) as unknown as AuditOutboxJsonValue,
    });
  }

  /**
   * The READ half of the same port (Phase REPORTING-HR-PERSONNEL-TRAFFIC).
   *
   * A PASSTHROUGH AND NOTHING ELSE — the exact shape `ProductionAuditGateway.read`
   * established for its reporting seam, because the reasoning does not depend on which
   * context's trail is read. The query arrives ALREADY BUILT from trusted context: the
   * caller stamps `tenantId` from its server-resolved scope and binds
   * `resource`/`resourceId` to a row it has already loaded tenant-scoped. This method
   * decides nothing — no filter, no default, no projection, no fallback page — because
   * every one of those would be a SECOND opinion about what a platform read means.
   *
   * A FAILURE IS NEVER TURNED INTO AN EMPTY RESULT: the port reports
   * `{ status: 'rejected', code }` instead of throwing, and this method returns that
   * rejection VERBATIM so a caller can map it to a 503 rather than falsely claiming
   * "nothing was recorded". Exactly ONE caller reads through here today: the HR
   * personnel-traffic reporting seam (`hr/reporting/**`) reading the `hr.attendance`
   * trail for one register row it has already loaded tenant-scoped.
   *
   * WHY THE GATEWAY REMAINS THE ONLY FILE THAT TOUCHES THE PORT. `hr-isolation.spec.ts`
   * and `hr-application-boundaries.spec.ts` both pin `hr-audit.gateway.ts` as the sole
   * importer of `platform/audit/audit.contract`; adding a second injection point for
   * reads would reopen exactly the door those guards close — a call site that forgets
   * the tenant and asks the trail a question no tenancy can answer.
   */
  async read(query: AuditReadQuery): Promise<AuditReadResult> {
    try {
      return await this.audit.read(query);
    } catch (error) {
      this.logger.error(
        'HR audit read failed',
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'rejected', code: 'AUDIT_READ_FAILED' };
    }
  }
}
