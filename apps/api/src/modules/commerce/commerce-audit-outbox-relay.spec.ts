/**
 * COMMERCE AUDIT OUTBOX RELAY: unit tests for the relay that drains the
 * Commerce audit outbox and delivers events through AUDIT_PORT — the same
 * failure semantics the Production/Financial/HR relays are pinned to:
 *   - successful / duplicate delivery deletes the outbox row
 *   - transient exceptions reschedule with bounded backoff
 *   - a deterministic `rejected` is PARKED to a once-a-day retry after 100
 *     attempts (never deleted, stays inspectable)
 *   - a `conflict` is a deterministic integrity incident — parked IMMEDIATELY
 *     (once-a-day retry, never hot-looped)
 *   - each row is CLAIMED (single flight) before dispatch, so two poll ticks —
 *     or two API instances sharing `commerce_db` — never publish the same event
 *     twice
 *   - a malformed payload is parked immediately — never dispatched, never
 *     left due for the next poll tick
 */

import { CommerceAuditOutboxRelayService } from './commerce-audit-outbox-relay.service';
import type { CommercePrismaService } from './database/commerce-prisma.service';
// The platform audit contract is deliberately NOT imported here: a Commerce spec must
// never become a second consumer of AUDIT_PORT (pinned by commerce-gateways.spec.ts).
// The injected port type is derived from the relay's own constructor instead.
type RelayAuditPort = ConstructorParameters<typeof CommerceAuditOutboxRelayService>[1];

const TENANT_A = 'tenant-a';
const AUDIT_ID_1 = 'audit-id-1';

function makeRow(overrides: Partial<{
  id: string;
  tenantId: string;
  auditId: string;
  payload: unknown;
  attempts: number;
  nextAt: Date;
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
          resource: 'commerce.purchase_document',
          resourceId: 'doc-1',
        },
    attempts: overrides.attempts ?? 0,
    nextAt: overrides.nextAt ?? new Date(),
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
  const relay = new CommerceAuditOutboxRelayService(
    prisma as unknown as CommercePrismaService,
    auditPort as unknown as RelayAuditPort,
  );
  return { relay, prisma, auditPort };
}

describe('CommerceAuditOutboxRelayService', () => {
  it('deletes the outbox row after the platform records the event', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    const row = makeRow();
    prisma.auditOutbox.findMany.mockResolvedValue([row]);
    auditPort.record.mockResolvedValue({ status: 'recorded' });

    await relay.relay();

    expect(auditPort.record).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: row.auditId, tenantId: TENANT_A }),
    );
    expect(prisma.auditOutbox.delete).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it('deletes the outbox row when the platform reports a duplicate', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow()]);
    auditPort.record.mockResolvedValue({ status: 'duplicate' });

    await relay.relay();

    expect(prisma.auditOutbox.delete).toHaveBeenCalled();
  });

  it('reschedules with bounded backoff on a transient exception', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow({ attempts: 2 })]);
    auditPort.record.mockRejectedValue(new Error('connection refused'));

    await relay.relay();

    expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
    expect(prisma.auditOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attempts: 3 }) }),
    );
  });

  it('parks a deterministic rejection after 100 attempts — daily retry, row kept', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow({ attempts: 99 })]);
    auditPort.record.mockResolvedValue({ status: 'rejected', code: 'FK_VIOLATION' });

    const before = Date.now();
    await relay.relay();

    const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
    expect(updateCall.data.attempts).toBe(100);
    expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
    expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
  });

  it('parks a conflict IMMEDIATELY — an integrity incident is never hot-looped', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow()]);
    auditPort.record.mockResolvedValue({ status: 'conflict', code: 'DIGEST_MISMATCH' });

    const before = Date.now();
    await relay.relay();

    const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
    // Phase B5: a conflict is deterministic (same auditId, different digest) — it
    // parked on its 100th attempt before; now it parks on the first one.
    expect(updateCall.data.attempts).toBe(1);
    expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
    expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
  });

  it('claims the row before dispatching — a lost claim means no dispatch', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow()]);
    prisma.auditOutbox.updateMany.mockResolvedValueOnce({ count: 0 });

    await relay.relay();

    expect(auditPort.record).not.toHaveBeenCalled();
    expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
    expect(prisma.auditOutbox.update).not.toHaveBeenCalled();
  });

  it('a failed claim is logged and leaves the row for the next tick', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow()]);
    prisma.auditOutbox.updateMany.mockRejectedValueOnce(new Error('db gone'));

    await expect(relay.relay()).resolves.toBeUndefined();

    expect(auditPort.record).not.toHaveBeenCalled();
    expect(prisma.auditOutbox.update).not.toHaveBeenCalled();
  });

  it('parks a malformed payload immediately — kept, never dispatched, never left due', async () => {
    const { relay, prisma, auditPort } = buildRelay();
    prisma.auditOutbox.findMany.mockResolvedValue([makeRow({ payload: null })]);

    const before = Date.now();
    await relay.relay();

    expect(auditPort.record).not.toHaveBeenCalled();
    expect(prisma.auditOutbox.delete).not.toHaveBeenCalled();
    const updateCall = prisma.auditOutbox.update.mock.calls[0][0];
    expect(updateCall.data.nextAt.getTime() - before).toBeGreaterThanOrEqual(86_000_000);
  });
});
