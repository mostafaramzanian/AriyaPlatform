
/**
 * Phase B2.4 — PRODUCTION AUDIT OUTBOX RELAY: unit tests for the relay service
 * that drains the Production audit outbox and delivers events through AUDIT_PORT.
 *
 * These tests verify:
 *   - successful relay deletes the outbox row
 *   - duplicate delivery deletes the outbox row (idempotent)
 *   - failed delivery reschedules with backoff
 *   - conflict delivery reschedules and logs
 *   - invalid payload is logged and skipped
 *   - tenant identity is preserved through the relay
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

  describe('relay — invalid payload', () => {
    it('skips rows with null payload without crashing', async () => {
      const { relay, prisma, auditPort } = buildRelay();
      const row = makeRow({ payload: null });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);

      await relay.relay();

      expect(auditPort.record).not.toHaveBeenCalled();
      expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
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
      const row = makeRow({ attempts: 100 });
      prisma.auditOutbox.findMany.mockResolvedValue([row]);
      auditPort.record.mockResolvedValue({ status: 'rejected', code: 'ERROR' });

      const before = Date.now();
      await relay.relay();

      const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
      const nextAt = updateCall.data.nextAt.getTime();
      // MAX_BACKOFF is 300_000 ms (5 minutes). Even at attempt 100, the backoff should be
      // capped, not grow to 100*60_000 = 100 minutes.
      expect(nextAt - before).toBeLessThanOrEqual(300_000 + 5_000); // 5s tolerance
    });
  });
});
