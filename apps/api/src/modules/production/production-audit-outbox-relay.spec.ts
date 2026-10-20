
/**
 * Phase B2.4 — PRODUCTION AUDIT OUTBOX RELAY: unit tests for the relay service
 * that drains the Production audit outbox and delivers events through AUDIT_PORT.
 *
 * These tests verify:
 *   - successful relay deletes the outbox row
 *   - duplicate delivery deletes the outbox row (idempotent)
 *   - failed delivery reschedules with backoff
 *   - conflict delivery is parked IMMEDIATELY (a deterministic identity
 *     collision: the same auditId with different content can never succeed on a
 *     retry) and logs an alarm
 *   - invalid payload is parked immediately (never dispatched, never left due)
 *   - tenant identity is preserved through the relay
 *   - Phase B5: each row is CLAIMED (single flight) before dispatch — only the
 *     claim winner dispatches, and a lost or failed claim skips the row
 */

import { ProductionAuditOutboxRelayService } from './production-audit-outbox-relay.service';
import type { ProductionPrismaService } from './database/production-prisma.service';
import type { AuditPort } from '../../platform/audit/audit.contract';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const AUDIT_ID_1 = 'audit-id-1';
const AUDIT_ID_2 = 'audit-id-2';

function makeRow(overrides: Partial<{
  id: string;
  tenantId: string;
  auditId: string;
  payload: unknown;
  attempts: number;
  nextAt: Date;
  createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'row-1',
    tenantId: overrides.tenantId ?? TENANT_A,
    auditId: overrides.auditId ?? AUDIT_ID_1,
    payload: 'payload' in overrides
      ? overrides.payload
      : {
          auditId: AUDIT_ID_1,
          tenantId: TENANT_A,
          action: 'submit',
          resource: 'production.bom',
          resourceId: 'bom-1',
        },
    attempts: overrides.attempts ?? 0,
    nextAt: overrides.nextAt ?? new Date(),
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function buildRelay() {
  const prisma = {
    auditOutbox: {
      findMany: jest.fn().mockResolvedValue([]),
      // Phase B5: the single-flight claim. `{ count: 1 }` = this caller won the
      // claim; a test overrides it with `{ count: 0 }` or a rejection.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const auditPort = {
    record: jest.fn().mockResolvedValue({ status: 'recorded' as const }),
    read: jest.fn(),
  };

  // The doubles are method-shaped; the classes carry nominal private state a
  // test double cannot (and should not) carry, so each collaborator crosses
  // this ONE boundary as its class — the recorded mocks remain the source of
  // truth for every assertion below.
  const relay = new ProductionAuditOutboxRelayService(
    prisma as unknown as ProductionPrismaService,
    auditPort as unknown as AuditPort,
  );

  return { relay, prisma, auditPort };
}

describe('ProductionAuditOutboxRelayService', () => {
  describe('relay — successful delivery', () => {
    it('deletes the outbox row after the platform records the event', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);

      await relay.relay();

      expect(auditPort.record).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: AUDIT_ID_1, tenantId: TENANT_A }),
      );
      expect(prisma.auditOutbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('preserves tenant identity through the relay', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const rowA = makeRow({ id: 'r-a', tenantId: TENANT_A, auditId: AUDIT_ID_1, payload: { tenantId: TENANT_A, auditId: AUDIT_ID_1 } });
      const rowB = makeRow({ id: 'r-b', tenantId: TENANT_B, auditId: AUDIT_ID_2, payload: { tenantId: TENANT_B, auditId: AUDIT_ID_2 } });
      prisma.auditOutbox.findMany.mockResolvedValue([rowA, rowB]);

      await relay.relay();

      expect(auditPort.record).toHaveBeenCalledTimes(2);
      const firstCall = auditPort.record.mock.calls[0][0];
      const secondCall = auditPort.record.mock.calls[1][0];
      expect(firstCall.tenantId).toBe(TENANT_A);
      expect(secondCall.tenantId).toBe(TENANT_B);
    });
  });

  describe('relay — duplicate delivery (idempotent)', () => {
    it('deletes the outbox row when the platform reports duplicate', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'duplicate' });

      await relay.relay();

      expect(prisma.auditOutbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });
  });

  describe('relay — failed delivery', () => {
    it('reschedules with incremented attempts on rejection', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ attempts: 2 });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'rejected', code: 'SOME_ERROR' });

      await relay.relay();

      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: expect.objectContaining({
          attempts: 3,
          nextAt: expect.any(Date),
        }),
      });
    });

    it('reschedules on transport error', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockRejectedValue(new Error('connection refused'));

      await relay.relay();

      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: expect.objectContaining({
          attempts: 1,
          nextAt: expect.any(Date),
        }),
      });
    });
  });

  describe('relay — conflict delivery', () => {
    it('parks a conflict IMMEDIATELY — an integrity incident is never hot-looped', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'conflict', code: 'DIGEST_MISMATCH' });

      const before = Date.now();
      await relay.relay();

      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
      // Phase B5: the SAME row parked at the 100th attempt before — a conflict is
      // deterministic (same auditId, different digest), so retrying it 100 times
      // every 5 minutes was pure poison. It parks on attempt 1.
      expect(updateCall.data.attempts).toBe(1);
      expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
    });

    it('reschedules on conflict and does NOT delete', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'conflict', code: 'DIGEST_MISMATCH' });

      await relay.relay();

      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.update).toHaveBeenCalled();
    });
  });

  describe('relay — single-flight claim (Phase B5)', () => {
    it('claims the row before dispatching — a lost claim means no dispatch', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      // Another tick/instance won the claim for this row.
      prisma.auditOutbox.updateMany.mockResolvedValueOnce({ count: 0 });

      await relay.relay();

      expect(auditPort.record).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.update).not.toHaveBeenCalled();
    });

    it('a failed claim is logged and leaves the row for the next tick', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow();
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      prisma.auditOutbox.updateMany.mockRejectedValueOnce(new Error('db gone'));

      // Never throws: the relay must survive a claim failure.
      await expect(relay.relay()).resolves.toBeUndefined();

      expect(auditPort.record).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.update).not.toHaveBeenCalled();
    });

    it('claims with the attempts value it READ and leases nextAt to the winner', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ attempts: 7 });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'recorded' });

      const before = Date.now();
      await relay.relay();

      const claimCall = prisma.auditOutbox.updateMany.mock.calls[0][0];
      expect(claimCall.where.id).toBe('row-1');
      expect(claimCall.where.attempts).toBe(7);
      expect(claimCall.where.nextAt).toEqual({ lte: expect.any(Date) });
      expect(claimCall.data.attempts).toBe(8);
      // The lease is shorter than the first backoff step (60s), so a crash
      // between claim and dispatch costs latency — never the event.
      expect(claimCall.data.nextAt.getTime() - before).toBeLessThanOrEqual(31_000);
    });
  });

  describe('relay — invalid payload', () => {
    it('parks a malformed payload — kept, never dispatched, retried once a day', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ payload: null });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);

      const before = Date.now();
      await relay.relay();

      expect(auditPort.record).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
      // The row is preserved but parked ~24h out — it must not stay due for
      // the next 10-second poll tick.
      const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
      expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
    });
  });

  describe('relay — outbox read failure', () => {
    it('does not crash when the outbox query fails', async () => {
      const { relay, prisma } = buildRelay();
      prisma.auditOutbox.findMany.mockRejectedValue(new Error('db gone'));

      // Should not throw
      await relay.relay();
    });
  });

  describe('relay — backoff is bounded', () => {
    it('caps backoff at MAX_BACKOFF_MS (5 minutes)', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ attempts: 50 });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'rejected', code: 'ERROR' });

      const before = Date.now();
      await relay.relay();

      const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
      const nextAt = updateCall.data.nextAt.getTime();
      // MAX_BACKOFF is 300_000 ms (5 minutes). The backoff is capped below the
      // park threshold rather than growing linearly forever.
      expect(nextAt - before).toBeLessThanOrEqual(300_000 + 5_000); // 5s tolerance
    });

    it('parks a row rejected 100+ times — next retry is a day away, not 5 minutes', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ attempts: 99 });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'rejected', code: 'FK_VIOLATION' });

      const before = Date.now();
      await relay.relay();

      const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
      // The row is kept (never deleted) but parked: REJECTED_PARK_MS is 24h.
      expect(updateCall.data.attempts).toBe(100);
      expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
    });
  });
});
