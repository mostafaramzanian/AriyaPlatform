import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  AUDIT_PORT,
  type AuditEventInput,
  type AuditPort,
} from '../../platform/audit/audit.contract';
import { CommercePrismaService } from './database/commerce-prisma.service';

/**
 * Phase B2.3 — COMMERCE AUDIT DURABILITY: the relay that drains the Commerce
 * audit outbox.
 *
 * Identical in behaviour to Financial's `AuditOutboxRelayService` (Phase B2),
 * context-local to Commerce. Commerce mutations write an `AuditOutbox` row in
 * the SAME `commerce_db` transaction as the business state mutation. This
 * service polls that outbox and delivers each pending event through
 * `AUDIT_PORT` to `core_db."AuditLog"`.
 *
 * IDEMPOTENCY: the platform handles duplicate delivery — a retried `auditId`
 * is classified as `duplicate` (same digest) or `conflict` (different digest).
 *
 * FAILURE HANDLING: failed attempts increment `attempts` and reschedule
 * `nextAt` with linear backoff capped at 5 minutes. The row is NEVER silently
 * discarded.
 *
 * CLEANUP: successfully relayed events (`recorded` or `duplicate`) are deleted.
 * A `conflict` is kept and logged as an operator alarm.
 */
@Injectable()
export class CommerceAuditOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommerceAuditOutboxRelayService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;

  private static readonly BATCH_SIZE = 50;
  private static readonly MAX_BACKOFF_MS = 300_000;
  private static readonly POLL_INTERVAL_MS = 10_000;

  constructor(
    private readonly prisma: CommercePrismaService,
    @Inject(AUDIT_PORT) private readonly auditPort: AuditPort,
  ) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(
      () => {
        if (this.running) void this.relay();
      },
      CommerceAuditOutboxRelayService.POLL_INTERVAL_MS,
    );
    void this.relay();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
  }

  async relay(): Promise<void> {
    try {
      const now = new Date();
      const rows = await this.prisma.auditOutbox.findMany({
        where: { nextAt: { lte: now } },
        orderBy: { nextAt: 'asc' },
        take: CommerceAuditOutboxRelayService.BATCH_SIZE,
      });

      for (const row of rows) {
        await this.relayOne(row);
      }
    } catch (err) {
      this.logger.error(
        { err },
        'Error reading Commerce audit outbox — will retry on next tick',
      );
    }
  }

  private async relayOne(row: {
    id: string;
    auditId: string;
    payload: unknown;
    attempts: number;
  }): Promise<void> {
    try {
      const event = row.payload as AuditEventInput;

      if (!event || typeof event !== 'object') {
        this.logger.error(
          { auditId: row.auditId, outboxId: row.id },
          'Outbox row has invalid payload — cannot relay',
        );
        return;
      }

      const result = await this.auditPort.record({ ...event, auditId: row.auditId });

      if (result.status === 'recorded' || result.status === 'duplicate') {
        await this.prisma.auditOutbox
          .delete({ where: { id: row.id } })
          .catch((e) =>
            this.logger.warn({ e, outboxId: row.id }, 'Failed to delete relayed outbox row'),
          );
        return;
      }

      if (result.status === 'conflict') {
        this.logger.error(
          {
            auditId: row.auditId,
            outboxId: row.id,
            code: result.code,
            stage: 'relay.conflict',
          },
          'Commerce audit outbox relay detected a CONFLICT — the same auditId exists with different content',
        );
        await this.reschedule(row);
        return;
      }

      this.logger.warn(
        {
          auditId: row.auditId,
          outboxId: row.id,
          status: result.status,
          code: result.code,
          stage: 'relay.rejected',
        },
        'Commerce audit outbox relay was rejected by the platform — rescheduling',
      );
      await this.reschedule(row);
    } catch (err) {
      this.logger.warn(
        { err, auditId: row.auditId, outboxId: row.id },
        'Commerce audit outbox relay failed — rescheduling with backoff',
      );
      await this.reschedule(row);
    }
  }

  private async reschedule(row: { id: string; attempts: number }): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const backoffMs = Math.min(
      CommerceAuditOutboxRelayService.MAX_BACKOFF_MS,
      nextAttempt * 60_000,
    );

    try {
      await this.prisma.auditOutbox.update({
        where: { id: row.id },
        data: {
          attempts: nextAttempt,
          nextAt: new Date(Date.now() + backoffMs),
        },
      });
    } catch (e) {
      this.logger.error(
        { e, outboxId: row.id },
        'Failed to reschedule Commerce audit outbox row',
      );
    }
  }
}
