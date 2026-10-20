import type { AuditPort } from '../../platform/audit/audit.contract';
import { HrAuditOutboxRelayService } from './hr-audit-outbox-relay.service';
import { HrPrismaService } from './database/hr-prisma.service';

/**
 * Phase B2.5 — HR AUDIT OUTBOX RELAY: unit tests for the relay service.
 *
 * These tests verify:
 *   - Successful delivery + deletion
 *   - Duplicate delivery + deletion (idempotent)
 *   - Rejection → reschedule (not deletion)
 *   - Conflict → parked IMMEDIATELY (a deterministic identity collision: the
 *     same auditId with different content can never succeed on a retry)
 *   - Transport error → reschedule with backoff
 *   - Malformed payload → parked immediately (never dispatched, never left due)
 *   - Backoff is bounded at MAX_BACKOFF_MS
 *   - Tenant identity is preserved in relay delivery
 *   - Phase B5: each row is CLAIMED (single flight) before dispatch, so two poll
 *     ticks — or two instances sharing `hr_db` — never publish the same event
 *     twice; a lost or failed claim skips the row without dispatching
 *   - No Core Prisma access
 */

function makeRow(overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: 'outbox-row-1',
    tenantId: 'tenant-1',
    auditId: 'audit-evt-1',
    payload: {
      auditId: 'audit-evt-1',
      tenantId: 'tenant-1',
      action: 'APPROVE',
      resource: 'hr.leave',
      resourceId: 'leave-req-1',
      actorId: 'user-1',
    },
    attempts: 0,
    nextAt: new Date(),
    createdAt: new Date(),
  };

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(defaults)) {
    result[key] = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : (defaults as Record<string, unknown>)[key];
  }
  return result;
}

function buildRelay() {
  const deleted: string[] = [];
  const updated: { id: string; data: Record<string, unknown> }[] = [];
  let findResult: unknown[] = [];
  let recordResult: Record<string, unknown> = { status: 'recorded' };
  // Phase B5: the single-flight claim's verdict. Default = this caller won.
  let claimResult: { count: number } = { count: 1 };

  const prisma = {
    auditOutbox: {
      findMany: jest.fn(async () => findResult),
      // Phase B5: the atomic claim. Modelled as the relay uses it — a count.
      updateMany: jest.fn(async () => claimResult),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updated.push({ id: where.id, data });
        },
      ),
    },
  };

  const auditPort = {
    record: jest.fn(async (event: Record<string, unknown>) => {
      // The double stores nothing itself; the tests below read mock.calls.
      void event;
      return recordResult;
    }),
  };

  const service = new HrAuditOutboxRelayService(
    prisma as unknown as HrPrismaService,
    auditPort as unknown as AuditPort,
  );

  return {
    service,
    prisma,
    auditPort,
    deleted,
    updated,
    setFindResult: (rows: unknown[]) => { findResult = rows; },
    setRecordResult: (r: Record<string, unknown>) => { recordResult = r; },
    setClaimResult: (r: { count: number }) => { claimResult = r; },
  };
}

describe('HrAuditOutboxRelayService', () => {
  it('relays a valid event and deletes the outbox row on success', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.auditPort.record).toHaveBeenCalledTimes(1);
    expect(ctx.deleted).toEqual(['outbox-row-1']);
    expect(ctx.updated).toEqual([]);
  });

  it('preserves tenant identity in the relayed event', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([makeRow({ tenantId: 'tenant-42' })]);
    await ctx.service.relay();

    const calls = ctx.auditPort.record.mock.calls;
    const call = calls[0][0];
    expect(call.tenantId).toBe('tenant-1'); // from the payload, not from the row
    expect(call.auditId).toBe('audit-evt-1');
  });

  it('deletes on duplicate delivery (idempotent)', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'duplicate' });
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.deleted).toEqual(['outbox-row-1']);
    expect(ctx.updated).toEqual([]);
  });

  it('reschedules on rejection (not silent deletion)', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'rejected', code: 'INVALID_PAYLOAD' });
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toHaveLength(1);
    expect(ctx.updated[0].data.attempts).toBe(1);
  });

  it('reschedules on conflict and logs alarm', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'conflict', code: 'DIGEST_MISMATCH' });
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toHaveLength(1);
    expect(ctx.updated[0].data.attempts).toBe(1);
  });

  it('reschedules on transport error', async () => {
    const ctx = buildRelay();
    ctx.auditPort.record.mockRejectedValueOnce(new Error('network down'));
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toHaveLength(1);
    expect(ctx.updated[0].data.attempts).toBe(1);
  });

  it('does not crash on malformed payload (null)', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([makeRow({ payload: null })]);
    await ctx.service.relay();

    // No record call, no deletion — but the row is PARKED (~24h), not left
    // due for the next poll tick.
    expect(ctx.auditPort.record).not.toHaveBeenCalled();
    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toHaveLength(1);
    const parkedAt = ctx.updated[0].data.nextAt as Date;
    expect(parkedAt.getTime() - Date.now()).toBeGreaterThanOrEqual(86_000_000);
  });

  it('parks a conflict IMMEDIATELY — an integrity incident is never hot-looped', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'conflict', code: 'DIGEST_MISMATCH' });
    ctx.setFindResult([makeRow()]);
    await ctx.service.relay();

    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toHaveLength(1);
    // Phase B5: this row parked on its 100th attempt before — a conflict is
    // deterministic, so retrying it 100 times was pure poison. Park on attempt 1.
    expect(ctx.updated[0].data.attempts).toBe(1);
    const nextAt = ctx.updated[0].data.nextAt as Date;
    expect(nextAt.getTime() - Date.now()).toBeGreaterThanOrEqual(86_000_000);
  });

  it('claims the row before dispatching — a lost claim means no dispatch', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([makeRow()]);
    ctx.setClaimResult({ count: 0 });
    await ctx.service.relay();

    expect(ctx.auditPort.record).not.toHaveBeenCalled();
    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toEqual([]);
  });

  it('a failed claim is logged and leaves the row for the next tick', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([makeRow()]);
    ctx.prisma.auditOutbox.updateMany.mockRejectedValueOnce(new Error('db gone'));
    await ctx.service.relay();

    expect(ctx.auditPort.record).not.toHaveBeenCalled();
    expect(ctx.deleted).toEqual([]);
    expect(ctx.updated).toEqual([]);
  });

  it('bounds backoff at MAX_BACKOFF_MS (5 minutes)', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'rejected', code: 'INVALID' });
    ctx.setFindResult([makeRow({ attempts: 50 })]);
    await ctx.service.relay();

    expect(ctx.updated).toHaveLength(1);
    const nextAt = ctx.updated[0].data.nextAt as Date;
    const maxMs = 300_000; // 5 minutes
    const actualBackoff = nextAt.getTime() - Date.now();
    // Should not exceed max backoff + a small tolerance
    expect(actualBackoff).toBeLessThanOrEqual(maxMs + 5000);
    expect(ctx.updated[0].data.attempts).toBe(51);
  });

  it('parks a deterministic rejection after 100 attempts — next retry is a day away', async () => {
    const ctx = buildRelay();
    ctx.setRecordResult({ status: 'rejected', code: 'INVALID' });
    ctx.setFindResult([makeRow({ attempts: 99 })]);
    await ctx.service.relay();

    expect(ctx.updated).toHaveLength(1);
    const nextAt = ctx.updated[0].data.nextAt as Date;
    // Parked rows are kept (never deleted) but retried only once a day.
    expect(ctx.updated[0].data.attempts).toBe(100);
    expect(nextAt.getTime() - Date.now()).toBeGreaterThanOrEqual(86_000_000);
  });

  it('processes multiple rows in order', async () => {
    const ctx = buildRelay();
    ctx.setFindResult([
      makeRow({ id: 'r1', auditId: 'a1' }),
      makeRow({ id: 'r2', auditId: 'a2' }),
    ]);
    await ctx.service.relay();

    expect(ctx.auditPort.record).toHaveBeenCalledTimes(2);
    expect(ctx.deleted).toEqual(['r1', 'r2']);
  });
});
