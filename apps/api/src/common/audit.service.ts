import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/core-client';
import { NotificationPublisher } from '../notifications/notification.publisher';
import { redactPayload } from './audit-redactor.util';

export interface AuditOptions {
  /**
   * Phase ARCH-3B: the PRODUCER-owned event identity.
   *
   * Optional HERE and mandatory in the platform contract, which is the honest split: this
   * service is a LEGACY producer (§2/§5) and its callers do not yet supply one, so when it
   * is absent one is generated — never persisted as null. A caller that DOES supply it gets
   * idempotency for free: re-logging the same `auditId` updates nothing and returns the row
   * that is already there, which is what makes a retried legacy mutation safe now that
   * `requestId` is no longer unique.
   */
  auditId?: string;
  requestId: string;
  /**
   * The tenant this event belongs to.
   *
   * OPTIONAL BY DESIGN, and the only field here that stays optional forever: legacy
   * producers that write `AuditLog` directly have no tenant to give (§2), and the 36,489
   * historical rows have no deterministic tenant at all. A null here is recorded as a
   * LEGACY-HISTORICAL row. New platform producers go through `platform.audit@v1`, where the
   * tenant is REQUIRED — so "no tenant" cannot be produced by the new write path.
   */
  tenantId?: string | null;
  correlationId?: string;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  action: string;
  resource: string;
  resourceId: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedFields?: string[];
  success?: boolean;
  reason?: string | null;
  durationMs?: number | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService, private readonly publisher: NotificationPublisher) {}

  async log(opts: AuditOptions) {
    const startTs = Date.now();
    this.logger.debug({ requestId: opts.requestId, stage: 'log.start', ts: startTs }, 'Audit log start');
    try {
      // Redact sensitive fields from payloads before persisting.
      // `InputJsonValue` is the Json column's own vocabulary; `redactPayload`
      // guarantees JSON output (it stringifies the same tree to measure and
      // checksum it), so the assertion states that contract at the boundary.
      let redactedOld: Prisma.InputJsonValue | undefined;
      let redactedNew: Prisma.InputJsonValue | undefined;
      if (opts.oldValue !== undefined) {
        const res = redactPayload(opts.oldValue, { emailMask: true, phoneMask: true });
        redactedOld = res.redacted as Prisma.InputJsonValue;
        if (res.truncated) {
          // attach size/checksum to reason if needed
          opts.reason = opts.reason ?? 'oldValue truncated';
        }
      }
      if (opts.newValue !== undefined) {
        const res = redactPayload(opts.newValue, { emailMask: true, phoneMask: true });
        redactedNew = res.redacted as Prisma.InputJsonValue;
        if (res.truncated) {
          opts.reason = opts.reason ?? 'newValue truncated';
        }
      }

      const insertStart = Date.now();
      this.logger.debug({ requestId: opts.requestId, stage: 'db.insert.start', ts: insertStart }, 'Audit DB insert start');
      // One producer-owned identity per LOGICAL event. Generated when the caller has none,
      // never persisted as null, and never derived from `requestId` — the whole point of the
      // ARCH-3B split is that several events may share one request but never one auditId.
      const auditId = opts.auditId ?? randomUUID();
      const row = await this.prisma.auditLog.create({
        data: {
          auditId,
          requestId: opts.requestId,
          tenantId: opts.tenantId ?? undefined,
          correlationId: opts.correlationId,
          userId: opts.userId ?? undefined,
          ipAddress: opts.ip ?? undefined,
          userAgent: opts.userAgent ?? undefined,
          sessionId: opts.sessionId ?? undefined,
          action: opts.action,
          resourceType: opts.resource,
          resourceId: opts.resourceId,
          oldValue: redactedOld ?? undefined,
          newValue: redactedNew ?? undefined,
          changedFields: opts.changedFields ?? [],
          success: opts.success === undefined ? true : opts.success,
          reason: opts.reason ?? undefined,
          durationMs: opts.durationMs ?? undefined,
        },
      });
      const insertEnd = Date.now();
      this.logger.debug({ requestId: opts.requestId, stage: 'db.insert.end', ts: insertEnd, durationMs: insertEnd - insertStart }, 'Audit DB insert done');

      // fire-and-forget publish to RabbitMQ; failures are recorded in dispatch table
      const publishCallTs = Date.now();
      this.logger.debug({ requestId: opts.requestId, stage: 'publish.call', ts: publishCallTs }, 'Calling publishAuditEvent');
      // The FIRST argument is `row.id`, NOT `row.auditId`, and that is deliberate legacy
      // semantics rather than an oversight (§5): a publish failure is recorded in
      // `AuditDispatch` keyed by `AuditLog.id`, which is what every existing retry row means.
      // Passing the new `auditId` here would silently reinterpret that table.
      this.publishAuditEvent(row.id, opts).catch((err) => {
        this.logger.warn({ err, requestId: opts.requestId }, 'Failed publishing audit event, scheduling dispatch');
      });
      const afterPublishCall = Date.now();
      this.logger.debug({ requestId: opts.requestId, stage: 'publish.called', ts: afterPublishCall, callDurationMs: afterPublishCall - publishCallTs }, 'publishAuditEvent invoked');

      const endTs = Date.now();
      this.logger.debug({ requestId: opts.requestId, stage: 'log.end', ts: endTs, totalDurationMs: endTs - startTs }, 'Audit log finished');
      return row;
    } catch (err) {
      // A REPLAY OF THE SAME LOGICAL EVENT IS NOT A FAILURE. `auditId` is UNIQUE, so a
      // retried legacy call (or a caller that supplies its own `auditId`) lands here with a
      // P2002 that means "this event is already recorded". The existing row is returned so
      // the caller sees the same outcome it saw the first time, instead of a null that reads
      // as "the audit was lost".
      if (opts.auditId && (err as { code?: string })?.code === 'P2002') {
        const existing = await this.prisma.auditLog
          .findUnique({ where: { auditId: opts.auditId } })
          .catch(() => null);
        if (existing) {
          this.logger.warn(
            { auditId: opts.auditId, requestId: opts.requestId, stage: 'log.duplicate' },
            'Audit event already recorded; returning the existing row'
          );
          return existing;
        }
      }

      const errTs = Date.now();
      this.logger.error({ err, ts: errTs, stage: 'log.error' }, 'Failed to persist audit log');
      // Do not throw - audit persistence must not break business logic
      return null;
    }
  }

  private async publishAuditEvent(auditId: string, opts: AuditOptions) {
    const payload = {
      auditId,
      ...opts,
    };
    try {
      // do not await publisher to avoid blocking caller, but ensure errors are caught
      await this.publisher.publish(`audit.${opts.resource}.${opts.action}`.toLowerCase(), payload);
    } catch (err) {
      // record dispatch attempt for retry
      this.logger.warn({ err }, 'publish failed, inserting dispatch record');
      try {
        await this.prisma.auditDispatch.create({ data: { auditId } });
      } catch (e) {
        this.logger.error({ e }, 'Failed creating audit dispatch entry');
      }
    }
  }
}
