import { Injectable, Logger } from '@nestjs/common';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { ObservabilityConfigService } from './observability.config';
import {
  AuditEventInput,
  DEFAULT_SECURITY_SEVERITY,
  LifecycleEventInput,
  MAX_ACTION_LENGTH,
  MAX_REASON_LENGTH,
  MAX_RESOURCE_ID_LENGTH,
  MAX_RESOURCE_TYPE_LENGTH,
  MAX_ROUTE_LENGTH,
  MAX_USER_AGENT_LENGTH,
  SecurityEventInput,
} from './observability.contract';
import { clampText, maskIdentifier, resolveCorrelation, sanitizeContext } from './observability.sanitizer';
import { redactPayload } from '../common/audit-redactor.util';

/**
 * Phase 49M-2 §22: the DURABLE emit path — audit, security and lifecycle events.
 *
 * THE OPPOSITE CONTRACT TO `ObservabilityService`. These rows are never queued and never
 * dropped: each write is AWAITED with a finite timeout so the caller knows, by the time its
 * own work completes, whether the record landed.
 *
 * BUT IT STILL NEVER THROWS INTO THE BUSINESS PATH (§22). A failed audit write must not turn
 * a successful password change into an HTTP 500 — the state change already happened, and
 * reporting failure would be a lie about the outcome while also losing the record. So the
 * failure is surfaced THREE ways instead: it returns `false`, it emits a pino WARN, and it
 * increments a counter the health probe exposes. That is the difference from the droppable
 * tier, which fails silently by design.
 *
 * WHY `AuditEvent` AND `SecurityEvent` ARE SEPARATE TABLES, restated where the code lives:
 * an audit event describes a STATE CHANGE and therefore always has a resourceType/action; a
 * denial changes nothing, so those columns would be empty or invented. And they are read
 * under different permissions — `admin.audit.read` includes ADMIN, while
 * `admin.security.read` is SUPER_ADMIN/SECURITY_ADMIN only. One table cannot be governed by
 * two permissions without row-level filtering that a reader can get wrong.
 *
 * core_db."AuditLog" IS NOT TOUCHED BY THIS CLASS. `AuditService` keeps writing there, and
 * `/users/me/login-history` keeps reading there. This is the forward path (§51 KEEP).
 */
@Injectable()
export class ObservabilityAuditService {
  private readonly logger = new Logger(ObservabilityAuditService.name);

  private auditWritten = 0;
  private auditFailed = 0;
  private securityWritten = 0;
  private securityFailed = 0;
  private lifecycleWritten = 0;
  private lifecycleFailed = 0;
  private lastFailureAt: Date | null = null;
  private lastFailureMessage: string | null = null;

  constructor(
    private readonly prisma: ObservabilityPrismaService,
    private readonly config: ObservabilityConfigService,
  ) {}

  /**
   * Records one audited state change. Returns whether the row landed.
   *
   * `beforeValue`/`afterValue` go through the SAME `redactPayload` that `AuditService`
   * already uses, with the same `emailMask`/`phoneMask` options. Reusing it is not laziness:
   * a second redaction policy is a second thing to keep correct, and the one that falls
   * behind is the one that leaks a password hash into a table an ADMIN can read.
   */
  async record(input: AuditEventInput): Promise<boolean> {
    if (!this.config.enabled) return false;

    const ctx = RequestContextService.get();
    const correlation = resolveCorrelation();

    const before = input.beforeValue === undefined ? null : this.redact(input.beforeValue);
    const after = input.afterValue === undefined ? null : this.redact(input.afterValue);

    try {
      await this.withTimeout(
        this.prisma.auditEvent.create({
          data: {
            action: clampText(input.action, MAX_ACTION_LENGTH) ?? 'unknown',
            resourceType: clampText(input.resourceType, MAX_RESOURCE_TYPE_LENGTH) ?? 'unknown',
            resourceId: clampText(input.resourceId, MAX_RESOURCE_ID_LENGTH),
            actorType: input.actorType,
            // Falls back to the ambient user so a caller cannot forget to attribute an
            // action it performed inside a request.
            actorId: clampText(input.actorId ?? ctx?.userId, 64),
            actorRole: clampText(input.actorRole ?? ctx?.userRole, 64),
            outcome: input.outcome,
            reason: clampText(input.reason, MAX_REASON_LENGTH),
            tenantId: clampText(input.tenantId ?? ctx?.tenantId, 64),
            requestId: correlation.requestId ?? null,
            correlationId: correlation.correlationId ?? null,
            traceId: correlation.traceId ?? null,
            ipAddress: clampText(input.ipAddress ?? ctx?.ip, 64),
            userAgent: clampText(input.userAgent ?? ctx?.userAgent, MAX_USER_AGENT_LENGTH),
            beforeValue: (before ?? undefined) as never,
            afterValue: (after ?? undefined) as never,
            // Capped at 64 entries: a "changed fields" list longer than that is a bulk
            // operation misusing a single-resource audit row, and an unbounded array in a
            // hot table is a size problem with no upside.
            changedFields: (input.changedFields ?? []).slice(0, 64).map((f) => f.slice(0, 80)),
            moduleId: clampText(input.module?.moduleId, 64),
            instanceId: clampText(input.module?.instanceId, 96),
            durationMs: input.durationMs ?? null,
          },
        }),
      );
      this.auditWritten += 1;
      return true;
    } catch (err) {
      this.auditFailed += 1;
      this.noteFailure(err, 'audit', { action: input.action, resourceType: input.resourceType });
      return false;
    }
  }

  /**
   * Records one security-relevant event. Returns whether the row landed.
   *
   * `severity` defaults from the table in the contract, so a failed login is LOW at every
   * call site unless a caller with real context escalates it.
   *
   * `attemptedIdentifier` IS MASKED HERE, not by the caller. Leaving masking to callers
   * means one of them eventually forgets, and the field where that matters most is the one
   * holding whatever a person typed into a login form — which on a bad day is their
   * password in the username box.
   */
  async recordSecurity(input: SecurityEventInput): Promise<boolean> {
    if (!this.config.enabled) return false;

    const ctx = RequestContextService.get();
    const correlation = resolveCorrelation();

    try {
      await this.withTimeout(
        this.prisma.securityEvent.create({
          data: {
            eventType: input.eventType,
            severity: input.severity ?? DEFAULT_SECURITY_SEVERITY[input.eventType],
            succeeded: input.succeeded,
            actorType: input.actorType,
            actorId: clampText(input.actorId ?? ctx?.userId, 64),
            attemptedIdentifier: maskIdentifier(input.attemptedIdentifier),
            ipAddress: clampText(input.ipAddress ?? ctx?.ip, 64),
            userAgent: clampText(input.userAgent ?? ctx?.userAgent, MAX_USER_AGENT_LENGTH),
            httpMethod: clampText(input.httpMethod, 10),
            route: clampText(input.route, MAX_ROUTE_LENGTH),
            requiredPermission: clampText(input.requiredPermission, 120),
            tenantId: clampText(input.tenantId ?? ctx?.tenantId, 64),
            requestId: correlation.requestId ?? null,
            correlationId: correlation.correlationId ?? null,
            traceId: correlation.traceId ?? null,
            moduleId: clampText(input.module?.moduleId, 64),
            instanceId: clampText(input.module?.instanceId, 96),
            reasonCode: clampText(input.reasonCode, 80),
            detail: (sanitizeContext(input.detail) ?? undefined) as never,
          },
        }),
      );
      this.securityWritten += 1;
      return true;
    } catch (err) {
      this.securityFailed += 1;
      this.noteFailure(err, 'security', { eventType: input.eventType });
      return false;
    }
  }

  /**
   * Records one platform lifecycle transition. Returns whether the row landed.
   *
   * WHY LIFECYCLE IS DURABLE RATHER THAN DROPPABLE: these rows are the interleaved timeline
   * an operator reads when a provisioning run half-succeeded. A timeline with holes in it
   * is worse than no timeline, because the holes are invisible and get read as "nothing
   * happened". They are far rarer than log lines, so awaiting them costs nothing at volume.
   *
   * `outcomeCode` PRESERVES THE DOMAIN'S OWN CODE VERBATIM while `phase` normalizes across
   * domains, so a single indexed query can interleave integration, module and provisioning
   * history without any of them losing their specific reason.
   */
  async recordLifecycle(input: LifecycleEventInput): Promise<boolean> {
    if (!this.config.enabled) return false;

    const ctx = RequestContextService.get();
    const correlation = resolveCorrelation();

    try {
      await this.withTimeout(
        this.prisma.lifecycleEvent.create({
          data: {
            domain: input.domain,
            eventType: clampText(input.eventType, 120) ?? 'unknown',
            phase: input.phase,
            outcomeCode: clampText(input.outcomeCode, 80),
            subjectType: clampText(input.subjectType, 40) ?? 'unknown',
            subjectId: clampText(input.subjectId, 64),
            subjectKey: clampText(input.subjectKey, 120),
            moduleId: clampText(input.module?.moduleId, 64),
            instanceId: clampText(input.module?.instanceId, 96),
            requestId: correlation.requestId ?? null,
            correlationId: correlation.correlationId ?? null,
            traceId: correlation.traceId ?? null,
            actorType: input.actorType,
            actorId: clampText(input.actorId ?? ctx?.userId, 64),
            tenantId: clampText(input.tenantId ?? ctx?.tenantId, 64),
            durationMs: input.durationMs ?? null,
            attempt: input.attempt ?? null,
            detail: (sanitizeContext(input.detail) ?? undefined) as never,
          },
        }),
      );
      this.lifecycleWritten += 1;
      return true;
    } catch (err) {
      this.lifecycleFailed += 1;
      this.noteFailure(err, 'lifecycle', { domain: input.domain, eventType: input.eventType });
      return false;
    }
  }

  /**
   * Bounds a durable write against a hung connection.
   *
   * WITHOUT THIS, "never dropped" WOULD MEAN "CAN HANG THE CALLER". A `create` against a
   * connection that is established but unresponsive can wait far longer than any request
   * budget, so §22's promise that observability never degrades the business path requires a
   * ceiling on the wait, not merely a promise not to throw.
   *
   * THE TIMEOUT IS A FAILURE, NOT A SUCCESS: it rejects, so the caller's catch increments the
   * failure counter and the health probe shows it. The insert may still land server-side —
   * an audit row appearing that the API reported as failed is the acceptable direction of
   * error, since the opposite would silently lose the record.
   */
  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`observability durable write exceeded ${this.config.writeTimeoutMs}ms`)),
        this.config.writeTimeoutMs,
      );
      timer.unref?.();
    });

    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Same options as `AuditService.log`, so both audit trails redact identically. */
  private redact(value: unknown): unknown {
    const { redacted } = redactPayload(value, { emailMask: true, phoneMask: true });
    return redacted;
  }

  /**
   * Reports a durable-write failure to pino and to the counters.
   *
   * IT LOGS THROUGH `Logger`, NEVER THROUGH `ObservabilityService`. Feeding an observability
   * failure back into the observability queue is how a failing writer generates unbounded
   * work for itself — and the queue it would be writing into is fed by the same broken
   * database.
   */
  private noteFailure(err: unknown, kind: string, meta: Record<string, unknown>): void {
    this.lastFailureAt = new Date();
    this.lastFailureMessage = err instanceof Error ? err.message : 'unknown durable write error';
    this.logger.warn(
      { kind, ...meta, err: this.lastFailureMessage },
      'Durable observability write failed; business operation unaffected',
    );
  }

  /** Counters for the health probe. A non-zero `*Failed` means the trail has holes. */
  stats(): Record<string, unknown> {
    return {
      auditWritten: this.auditWritten,
      auditFailed: this.auditFailed,
      securityWritten: this.securityWritten,
      securityFailed: this.securityFailed,
      lifecycleWritten: this.lifecycleWritten,
      lifecycleFailed: this.lifecycleFailed,
      lastFailureAt: this.lastFailureAt ? this.lastFailureAt.toISOString() : null,
      lastFailureMessage: this.lastFailureMessage,
    };
  }
}
