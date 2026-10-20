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
  // POISON GUARD: a platform `rejected` is a deterministic refusal (contract,
  // FK or validation violation) — it can never succeed without a data fix.
  // After this many attempts the row is PARKED (retried once a day, kept for
  // operators) instead of hot-looping every 5 minutes. The row is never
  // deleted; `attempts` keeps counting so a parked row stays inspectable.
  private static readonly REJECTED_PARK_AFTER_ATTEMPTS = 100;
  private static readonly REJECTED_PARK_MS = 86_400_000;
  // SINGLE-FLIGHT CLAIM (Phase B5): `claim()` writes this lease into `nextAt`
  // before dispatching, so a second tick — in THIS process or in another API
  // instance sharing `finance_db` — finds the row NOT due and skips it. The
  // lease is shorter than the first backoff step (60s), so a crash mid-dispatch
  // costs at most this much extra latency instead of losing the event.
  private static readonly CLAIM_LEASE_MS = 30_000;

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
    // SINGLE-FLIGHT CLAIM (Phase B5): claim the row before dispatching. `false`
    // means either another tick/instance already owns it (normal — the row is
    // NOT due any more) or the claim itself failed (logged, row untouched and
    // retried on the next tick). Either way this tick must not dispatch.
    const claimed = await this.claim(row).catch((e) => {
      this.logger.error(
        { e, outboxId: row.id, stage: 'relay.claim.failed' },
        'Failed to claim Financial audit outbox row — will retry on next tick',
      );
      return false;
    });
    if (!claimed) return;

    try {
      const event = row.payload as AuditEventInput;

      // Ensure the auditId on the payload matches the outbox row's key.
      if (!event || typeof event !== 'object') {
        this.logger.error(
          { auditId: row.auditId, outboxId: row.id, stage: 'relay.payload.parked' },
          'Outbox row has invalid payload — parked, kept for operator inspection',
        );
        await this.reschedule(row, true, true);
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
        // Phase B5: a conflict is DETERMINISTIC — the same `auditId` already
        // exists with different content, so a retry can never succeed; only a
        // data fix can. Park immediately (once-a-day retry, row kept, alarm
        // logged above) instead of hot-looping every 5 minutes for ~8 hours.
        await this.reschedule(row, true, true);
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
      await this.reschedule(row, true);
    } catch (err) {
      this.logger.warn(
        { err, auditId: row.auditId, outboxId: row.id },
        'Audit outbox relay failed — rescheduling with backoff',
      );
      await this.reschedule(row);
    }
  }

  /**
   * SINGLE-FLIGHT CLAIM (Phase B5).
   *
   * WHY: a tick is not mutually exclusive with the previous one (the poll uses
   * `setInterval` and the in-flight work is not awaited), and more than one API
   * instance can share `finance_db`. Two ticks/instances that read the same due
   * row would otherwise both dispatch it — safe, because the platform is
   * idempotent, but a duplicate publication an operator has to reason about.
   *
   * HOW: an optimistic claim on the row's own `attempts` counter. `updateMany`
   * is atomic and conditional: only the caller that presents the value it READ
   * wins; the loser gets `count === 0`. PostgreSQL re-evaluates the predicate
   * after the row lock is released, so this is not a lost-update race.
   *
   * The claim also pushes `nextAt` to now + CLAIM_LEASE_MS, which is what makes
   * `relay()`'s `nextAt <= now` read skip an in-flight row. `attempts` is
   * incremented HERE (so the counter keeps its meaning — "attempts made") and
   * `reschedule()` writes that same value back when it computes `nextAttempt`.
   *
   * A crash between claim and dispatch is safe: the row is due again after the
   * lease, and nothing deletes a row except a `recorded`/`duplicate` verdict.
   */
  private async claim(row: { id: string; attempts: number }): Promise<boolean> {
    const now = new Date();
    const { count } = await this.prisma.auditOutbox.updateMany({
      where: { id: row.id, attempts: row.attempts, nextAt: { lte: now } },
      data: {
        attempts: row.attempts + 1,
        nextAt: new Date(
          now.getTime() + AuditOutboxRelayService.CLAIM_LEASE_MS,
        ),
      },
    });
    return count === 1;
  }

  private async reschedule(
    row: { id: string; attempts: number },
    deterministic = false,
    parkNow = false,
  ): Promise<void> {
    const nextAttempt = row.attempts + 1;
    const parkAfter = AuditOutboxRelayService.REJECTED_PARK_AFTER_ATTEMPTS;
    // A `rejected` verdict is deterministic: it will be rejected again, so once
    // the threshold is crossed the row is parked instead of hot-looped.
    const deterministicRejection = deterministic && nextAttempt >= parkAfter;
    if (deterministicRejection) {
      this.logger.error(
        { outboxId: row.id, attempts: nextAttempt, stage: 'relay.rejected.parked' },
        'Financial audit outbox row parked — deterministic platform rejection needs a data fix',
      );
    }
    const parked = parkNow || deterministicRejection;
    const backoffMs = parked
      ? AuditOutboxRelayService.REJECTED_PARK_MS
      : Math.min(AuditOutboxRelayService.MAX_BACKOFF_MS, nextAttempt * 60_000);

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
