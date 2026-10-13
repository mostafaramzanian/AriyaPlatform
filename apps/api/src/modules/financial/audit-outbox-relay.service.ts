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
import { FinancialPrismaService } from './database/financial-prisma.service';

/**
 * Phase B2 — AUDIT DURABILITY: the relay that drains the Financial audit outbox.
 *
 * WHY THIS SERVICE EXISTS
 * -----------------------
 * Financial mutations write an `AuditOutbox` row in the SAME transaction as the
 * business state mutation (via `FinancialAuditGateway.recordDurable`). That row
 * is the durable promise that the event WILL reach `core_db."AuditLog"`. This
 * service polls the outbox and writes each pending event through `AUDIT_PORT`,
 * which is the platform's ONE audit write surface.
 *
 * IDEMPOTENCY
 * -----------
 * The platform's `PlatformAuditService` already handles duplicate delivery (§14):
 * an `auditId` that already exists is classified as `duplicate` (same digest) or
 * `conflict` (different digest). A relay retry is therefore safe — the worst case
 * is a `duplicate` result and a deleted outbox row.
 *
 * FAILURE HANDLING
 * ----------------
 * A failed relay attempt increments `attempts` and schedules `nextAt` with
 * exponential backoff (1m, 2m, 4m, 8m, capped at 5m). The row is NEVER silently
 * discarded: a compliance-critical event that cannot be delivered stays in the
 * outbox and is logged as an alarm. The relay processes at most 50 rows per tick
 * to avoid unbounded work.
 *
 * CLEANUP
 * -------
 * A successfully relayed event (`recorded` or `duplicate`) is deleted from the
 * outbox. A `conflict` is kept and logged — it signals an identity collision that
 * an operator must investigate.
 */
@Injectable()
export class AuditOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditOutboxRelayService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;

  /** Maximum rows per relay tick. */
  private static readonly BATCH_SIZE = 50;

  /** Maximum backoff between retries (5 minutes). */
  private static readonly MAX_BACKOFF_MS = 300_000;

  /** Polling interval (10 seconds). */
  private static readonly POLL_INTERVAL_MS = 10_000;

  constructor(
    private readonly prisma: FinancialPrismaService,
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
  ) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(
      () => {
        if (this.running) void this.relay();
      },
      AuditOutboxRelayService.POLL_INTERVAL_MS,
    );
    // Drain any pending rows from a previous cold start immediately.
    void this.relay();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
  }

  /**
   * One relay tick: read pending rows, write each through `AUDIT_PORT`, and
   * delete or reschedule.
   *
   * Safe to call directly (e.g. from tests or a manual trigger). The `running`
   * guard only prevents the INTERVAL callback from executing after shutdown.
   */
  async relay(): Promise<void> {

    try {
      const now = new Date();
      const rows = await this.prisma.auditOutbox.findMany({
        where: { nextAt: { lte: now } },
        orderBy: { nextAt: 'asc' },
        take: AuditOutboxRelayService.BATCH_SIZE,
      });

      for (const row of rows) {
        await this.relayOne(row);
      }
    } catch (err) {
      this.logger.error(
        { err },
        'Error reading Financial audit outbox — will retry on next tick',
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

      // Ensure the auditId on the payload matches the outbox row's key.
      if (!event || typeof event !== 'object') {
        this.logger.error(
          { auditId: row.auditId, outboxId: row.id },
          'Outbox row has invalid payload — cannot relay',
        );
        return;
      }

      const result = await this.audit.record({ ...event, auditId: row.auditId });

      if (result.status === 'recorded' || result.status === 'duplicate') {
        // Success: the event is in the trail. Remove the outbox row.
        await this.prisma.auditOutbox
          .delete({ where: { id: row.id } })
          .catch((e) =>
            this.logger.warn({ e, outboxId: row.id }, 'Failed to delete relayed outbox row'),
          );
        return;
      }

      if (result.status === 'conflict') {
        // An identity collision: the same auditId arrived with different content.
        // Keep the row and log an alarm — an operator must investigate.
        this.logger.error(
          {
            auditId: row.auditId,
            outboxId: row.id,
            code: result.code,
            stage: 'relay.conflict',
          },
          'Audit outbox relay detected a CONFLICT — the same auditId exists with different content',
        );
        // Still increment attempts to track how many times this was tried.
        await this.reschedule(row);
        return;
      }

      // `rejected` — a validation failure in the platform contract. Reschedule
      // with backoff; it may be a transient issue or a genuine producer fault.
      this.logger.warn(
        {
          auditId: row.auditId,
          outboxId: row.id,
          status: result.status,
          code: result.code,
          stage: 'relay.rejected',
        },
        'Audit outbox relay was rejected by the platform — rescheduling',
      );
      await this.reschedule(row);
    } catch (err) {
      this.logger.warn(
        { err, auditId: row.auditId, outboxId: row.id },
        'Audit outbox relay failed — rescheduling with backoff',
      );
      await this.reschedule(row);
    }
  }

  private async reschedule(row: { id: string; attempts: number }): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const backoffMs = Math.min(
      AuditOutboxRelayService.MAX_BACKOFF_MS,
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
        'Failed to reschedule audit outbox row',
      );
    }
  }
}
