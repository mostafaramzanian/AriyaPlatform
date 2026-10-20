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
import { ProductionPrismaService } from './database/production-prisma.service';

/**
 * Phase B2.4 — PRODUCTION AUDIT DURABILITY: the relay that drains the Production
 * audit outbox.
 *
 * Identical in behaviour to Financial's `AuditOutboxRelayService` (Phase B2) and
 * Commerce's `CommerceAuditOutboxRelayService` (Phase B2.3), context-local to
 * Production. Production mutations write an `AuditOutbox` row in the SAME
 * `production_db` transaction as the business state mutation. This service polls
 * that outbox and delivers each pending event through `AUDIT_PORT` to
 * `core_db."AuditLog"`.
 *
 * IDEMPOTENCY: the platform handles duplicate delivery — a retried `auditId`
 * is classified as `duplicate` (same digest) or `conflict` (different digest).
 *
 * FAILURE HANDLING: failed attempts increment `attempts` and reschedule
 * `nextAt` with linear backoff capped at 5 minutes. A DETERMINISTIC platform
 * rejection (`rejected`) is additionally parked to a once-a-day retry after
 * REJECTED_PARK_AFTER_ATTEMPTS — the row is NEVER silently discarded.
 *
 * CLEANUP: successfully relayed events (`recorded` or `duplicate`) are deleted.
 * A `conflict` is kept and logged as an operator alarm.
 */
@Injectable()
export class ProductionAuditOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductionAuditOutboxRelayService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;

  private static readonly BATCH_SIZE = 50;
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
  // instance sharing `production_db` — finds the row NOT due and skips it. The
  // lease is shorter than the first backoff step (60s), so a crash mid-dispatch
  // costs at most this much extra latency instead of losing the event.
  private static readonly CLAIM_LEASE_MS = 30_000;
  private static readonly POLL_INTERVAL_MS = 10_000;

  constructor(
    private readonly prisma: ProductionPrismaService,
    @Inject(AUDIT_PORT) private readonly auditPort: AuditPort,
  ) {}

  onModuleInit() {
    this.running = true;
    this.handle = setInterval(
      () => {
        if (this.running) void this.relay();
      },
      ProductionAuditOutboxRelayService.POLL_INTERVAL_MS,
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
        take: ProductionAuditOutboxRelayService.BATCH_SIZE,
      });

      for (const row of rows) {
        await this.relayOne(row);
      }
    } catch (err) {
      this.logger.error(
        { err },
        'Error reading Production audit outbox — will retry on next tick',
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
        'Failed to claim Production audit outbox row — will retry on next tick',
      );
      return false;
    });
    if (!claimed) return;

    try {
      const event = row.payload as AuditEventInput;

      if (!event || typeof event !== 'object') {
        this.logger.error(
          { auditId: row.auditId, outboxId: row.id, stage: 'relay.payload.parked' },
          'Outbox row has invalid payload — parked, kept for operator inspection',
        );
        await this.reschedule(row, true, true);
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
          'Production audit outbox relay detected a CONFLICT — the same auditId exists with different content',
        );
        // Phase B5: a conflict is DETERMINISTIC — the same `auditId` already
        // exists with different content, so a retry can never succeed; only a
        // data fix can. Park immediately (once-a-day retry, row kept, alarm
        // logged above) instead of hot-looping every 5 minutes for ~8 hours.
        await this.reschedule(row, true, true);
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
        'Production audit outbox relay was rejected by the platform — rescheduling',
      );
      await this.reschedule(row, true);
    } catch (err) {
      this.logger.warn(
        { err, auditId: row.auditId, outboxId: row.id },
        'Production audit outbox relay failed — rescheduling with backoff',
      );
      await this.reschedule(row);
    }
  }

  /**
   * SINGLE-FLIGHT CLAIM (Phase B5).
   *
   * WHY: a tick is not mutually exclusive with the previous one (the poll uses
   * `setInterval` and the in-flight work is not awaited), and more than one API
   * instance can share `production_db`. Two ticks/instances that read the same
   * due row would otherwise both dispatch it — safe, because the platform is
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
          now.getTime() + ProductionAuditOutboxRelayService.CLAIM_LEASE_MS,
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
    const parkAfter =
      ProductionAuditOutboxRelayService.REJECTED_PARK_AFTER_ATTEMPTS;
    // A `rejected` verdict is deterministic: it will be rejected again, so once
    // the threshold is crossed the row is parked instead of hot-looped.
    const deterministicRejection = deterministic && nextAttempt >= parkAfter;
    if (deterministicRejection) {
      this.logger.error(
        { outboxId: row.id, attempts: nextAttempt, stage: 'relay.rejected.parked' },
        'Production audit outbox row parked — deterministic platform rejection needs a data fix',
      );
    }
    const parked = parkNow || deterministicRejection;
    const backoffMs = parked
      ? ProductionAuditOutboxRelayService.REJECTED_PARK_MS
      : Math.min(
          ProductionAuditOutboxRelayService.MAX_BACKOFF_MS,
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
        'Failed to reschedule Production audit outbox row',
      );
    }
  }
}
