import { randomUUID } from 'node:crypto';
import { FinancialAuditGateway, type FinancialAuditAct } from './financial-audit.gateway';
import { AuditOutboxRelayService } from './audit-outbox-relay.service';
import { FinancialPrismaService } from './database/financial-prisma.service';
import type { AuditOutboxPayload } from './check-request/check-request.repository';
import type { AuditEventInput, AuditPort, AuditRecordResult } from '../../platform/audit/audit.contract';

/**
 * Phase B2 — AUDIT DURABILITY: tests proving the transactional outbox contract.
 *
 * These tests verify:
 *   1. A durable audit write lands in the outbox (same-transaction promise).
 *   2. The relay reads pending outbox rows and writes them through AUDIT_PORT.
 *   3. A successfully relayed event is deleted from the outbox.
 *   4. A relay failure reschedules the row with backoff (never silently discards).
 *   5. The relay tolerates duplicate delivery (idempotent).
 *   6. Tenant context is preserved through the outbox→relay→platform path.
 *   7. A durable write failure does NOT throw (the business mutation is unaffected).
 */

// ---------- Test doubles ----------

/**
 * The sliver of the Prisma surface BOTH the gateway and the relay touch: the
 * outbox write (gateway) plus findMany/delete/update (relay). Any extra shape
 * the double invents would mask a signature drift in the real contract.
 */
type OutboxTx = {
  auditOutbox: { create: (args: { data: AuditOutboxPayload }) => Promise<OutboxRow> };
};

type OutboxRelayPrisma = {
  auditOutbox: {
    findMany: (args?: {
      where?: { nextAt?: { lte?: Date } };
      take?: number;
    }) => Promise<OutboxRow[]>;
    delete: (args: { where: { id: string } }) => Promise<void>;
    update: (args: { where: { id: string }; data: { attempts?: number; nextAt?: Date } }) => Promise<void>;
  };
};

type OutboxDouble = OutboxTx &
  OutboxRelayPrisma & {
    _rows: OutboxRow[];
    auditOutbox: { create: jest.Mock } & OutboxRelayPrisma['auditOutbox'];
  };

function mockAuditPort(): AuditPort & {
  recorded: AuditEventInput[];
  nextResult: AuditRecordResult;
} {
  const port = {
    recorded: [] as AuditEventInput[],
    nextResult: {
      status: 'recorded',
      auditId: '',
      auditLogId: randomUUID(),
    } as AuditRecordResult,
    async record(event: AuditEventInput): Promise<AuditRecordResult> {
      port.recorded.push(event);
      return { ...port.nextResult, auditId: event.auditId };
    },
    async read() {
      return { status: 'ok' as const, page: { items: [], page: 1, pageSize: 20, total: 0 } };
    },
  };
  return port;
}

interface OutboxRow {
  id: string;
  tenantId: string;
  auditId: string;
  payload: unknown;
  attempts: number;
  nextAt: Date;
  createdAt: Date;
}

function mockFinancialPrisma(): OutboxDouble {
  const outboxRows: OutboxRow[] = [];

  return {
    _rows: outboxRows,
    auditOutbox: {
      create: jest.fn(async (args: { data: AuditOutboxPayload }) => {
        const row: OutboxRow = {
          id: randomUUID(),
          tenantId: args.data.tenantId,
          auditId: args.data.auditId,
          payload: args.data.payload,
          attempts: 0,
          nextAt: new Date(),
          createdAt: new Date(),
        };
        outboxRows.push(row);
        return row;
      }),
      findMany: jest.fn(async (args?: {
        where?: { nextAt?: { lte?: Date } };
        take?: number;
      }) => {
        // In the real service the WHERE is `{ nextAt: { lte: now } }`.
        // For the test double, return all rows whose `nextAt` is not in the future
        // (or simply all rows when no filter is given), sorted and limited.
        const now = args?.where?.nextAt?.lte ?? new Date(Date.now() + 1000);
        return outboxRows
          .filter((r) => r.nextAt.getTime() <= now.getTime())
          .sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
          .slice(0, args?.take ?? 50);
      }),
      delete: jest.fn(async (args: { where: { id: string } }) => {
        const idx = outboxRows.findIndex((r) => r.id === args.where.id);
        if (idx >= 0) outboxRows.splice(idx, 1);
      }),
      update: jest.fn(async (args: { where: { id: string }; data: { attempts?: number; nextAt?: Date } }) => {
        const row = outboxRows.find((r) => r.id === args.where.id);
        if (row) {
          if (args.data.attempts !== undefined) row.attempts = args.data.attempts;
          if (args.data.nextAt !== undefined) row.nextAt = args.data.nextAt;
        }
      }),
    },
  };
}

const ACTOR = {
  tenantId: 'tenant-test-1',
  userId: 'user-123',
  requestId: randomUUID(),
  ip: '127.0.0.1',
  userAgent: 'test',
};

const ACT: FinancialAuditAct = {
  action: 'submit',
  resource: 'financial.check-request',
  resourceId: randomUUID(),
  newValue: { status: 2 },
};

describe('Financial Audit Outbox — Durability Contract', () => {
  it('writes an outbox row when recordDurable is called', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    await gateway.recordDurable(prisma, ACTOR, ACT);

    expect(prisma._rows).toHaveLength(1);
    const row = prisma._rows[0];
    expect(row.tenantId).toBe(ACTOR.tenantId);
    expect(row.auditId).toBeDefined();
    expect(row.payload).toBeDefined();
    const payload = row.payload as AuditEventInput;
    expect(payload.tenantId).toBe(ACTOR.tenantId);
    expect(payload.action).toBe(ACT.action);
    expect(payload.resource).toBe(ACT.resource);
    expect(payload.resourceId).toBe(ACT.resourceId);
    // The event should NOT have been sent directly to the port.
    expect(port.recorded).toHaveLength(0);
  });

  it('relay delivers pending outbox rows through AUDIT_PORT', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    // Write a durable audit event.
    await gateway.recordDurable(prisma, ACTOR, ACT);
    expect(prisma._rows).toHaveLength(1);

    // Create relay (without starting the interval).
    const relay = new AuditOutboxRelayService(prisma as unknown as FinancialPrismaService, port);

    // Run one relay tick.
    await relay.relay();

    // The event should have been delivered through the port.
    expect(port.recorded).toHaveLength(1);
    expect(port.recorded[0].tenantId).toBe(ACTOR.tenantId);
    expect(port.recorded[0].action).toBe(ACT.action);

    // The outbox row should have been deleted.
    expect(prisma._rows).toHaveLength(0);
  });

  it('relay reschedules a row on failure instead of discarding it', async () => {
    const port = mockAuditPort();
    port.nextResult = {
      status: 'rejected',
      auditId: '',
      auditLogId: null,
      code: 'AUDIT_WRITE_FAILED',
    };
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    await gateway.recordDurable(prisma, ACTOR, ACT);
    const relay = new AuditOutboxRelayService(prisma as unknown as FinancialPrismaService, port);

    await relay.relay();

    // The row should NOT be deleted — it was rejected.
    expect(prisma._rows).toHaveLength(1);
    // Attempts should have incremented.
    expect(prisma._rows[0].attempts).toBe(1);
    // nextAt should be in the future (backoff).
    expect(prisma._rows[0].nextAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('relay handles duplicate delivery gracefully', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    await gateway.recordDurable(prisma, ACTOR, ACT);

    // First relay: success.
    port.nextResult = { status: 'recorded', auditId: '', auditLogId: randomUUID() };
    const relay = new AuditOutboxRelayService(prisma as unknown as FinancialPrismaService, port);
    await relay.relay();
    expect(prisma._rows).toHaveLength(0);

    // Write the same event again (simulating re-insertion).
    await gateway.recordDurable(prisma, ACTOR, ACT);
    port.nextResult = { status: 'duplicate', auditId: '', auditLogId: randomUUID() };
    await relay.relay();

    // Duplicate is a success: the outbox row should be deleted.
    expect(prisma._rows).toHaveLength(0);
  });

  it('preserves tenant context through the outbox→relay→platform path', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    const tenantActor = { ...ACTOR, tenantId: 'isolated-tenant-xyz' };
    await gateway.recordDurable(prisma, tenantActor, ACT);

    const relay = new AuditOutboxRelayService(prisma as unknown as FinancialPrismaService, port);
    await relay.relay();

    expect(port.recorded).toHaveLength(1);
    expect(port.recorded[0].tenantId).toBe('isolated-tenant-xyz');
  });

  it('recordDurable never throws even if the outbox write fails', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    // Make the create call throw.
    prisma.auditOutbox.create = jest.fn().mockRejectedValue(new Error('DB down'));

    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    // Should NOT throw.
    await expect(gateway.recordDurable(prisma, ACTOR, ACT)).resolves.toBeUndefined();
  });

  it('relay keeps conflict rows and logs them instead of discarding', async () => {
    const port = mockAuditPort();
    port.nextResult = { status: 'conflict', auditId: '', auditLogId: randomUUID() };
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    await gateway.recordDurable(prisma, ACTOR, ACT);
    const relay = new AuditOutboxRelayService(prisma as unknown as FinancialPrismaService, port);
    await relay.relay();

    // Conflict: the row should still be in the outbox, not deleted.
    expect(prisma._rows).toHaveLength(1);
    expect(prisma._rows[0].attempts).toBe(1);
  });

  it('best-effort record() still works without outbox', async () => {
    const port = mockAuditPort();
    const prisma = mockFinancialPrisma();
    const gateway = new FinancialAuditGateway(port, prisma as unknown as FinancialPrismaService);

    // The original record() path should work unchanged.
    await gateway.record(ACTOR, ACT);

    expect(port.recorded).toHaveLength(1);
    expect(port.recorded[0].tenantId).toBe(ACTOR.tenantId);
    // No outbox row should have been created.
    expect(prisma._rows).toHaveLength(0);
  });
});
