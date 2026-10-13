import { ProductionAuditGateway } from './production-audit.gateway';

/**
 * Phase PRODUCTION-BOM-HEADER: the ONE Production audit surface.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  * THE ENVELOPE IS BUILT HERE, ONCE. `tenantId` comes off the ACTOR, never off `act`
 *    — a caller-supplied tenant would be a cross-tenant audit row. `auditId` is a fresh
 *    UUID per call (NOT the `requestId`), because one request legitimately emits several
 *    events and a re-delivered event must be recognisable rather than duplicated.
 *  * `record` NEVER THROWS. A trail write is best-effort by contract; an implementation
 *    that let a port rejection escape would turn an audit outage into a failed BOM
 *    mutation, coupling a business write to a separate system's availability.
 *  * `read` DELEGATES. The query reaches the port verbatim, so scope, pagination and
 *    ordering stay the platform contract's single opinion.
 *  * a port that THROWS on read (violating the never-throw promise) is CLASSIFIED as
 *    `AUDIT_READ_FAILED` — never an empty `ok` page, which would falsely say "nothing
 *    was recorded".
 *
 * The port double is structural on purpose: `ConstructorParameters` derives the exact
 * port type from the gateway's own constructor, so the fake has to satisfy the real
 * contract without this spec naming it.
 */
type AuditPortDouble = ConstructorParameters<typeof ProductionAuditGateway>[0];

function build(record?: jest.Mock, read?: jest.Mock) {
  const port: AuditPortDouble = {
    record: record ?? jest.fn().mockResolvedValue({ status: 'recorded' }),
    read: read ?? jest.fn(),
  };
  return { gateway: new ProductionAuditGateway(port), record: port.record as jest.Mock, read: port.read as jest.Mock };
}

const ACTOR = {
  tenantId: 'tenant-a',
  userId: 'user-1',
  requestId: 'req-1',
  correlationId: 'corr-1',
  ip: '10.0.0.7',
  userAgent: 'jest',
};

describe('ProductionAuditGateway.record — envelope construction', () => {
  it('stamps the event with the ACTOR tenant and request, never the act', async () => {
    const { gateway, record } = build();

    await gateway.record(ACTOR, {
      action: 'create',
      resource: 'production.bom',
      resourceId: '11111111-1111-4111-8111-111111111111',
      // A caller that (incorrectly) states a tenant must not be able to redirect the row.
      tenantId: 'tenant-b',
    } as Parameters<ProductionAuditGateway['record']>[1] & { tenantId?: string });

    expect(record).toHaveBeenCalledTimes(1);
    const event = record.mock.calls[0][0];
    expect(event.tenantId).toBe('tenant-a');
    expect(event.requestId).toBe('req-1');
    expect(event.correlationId).toBe('corr-1');
    expect(event.actorId).toBe('user-1');
    expect(event.ip).toBe('10.0.0.7');
    expect(event.userAgent).toBe('jest');
  });

  it('generates a FRESH auditId per event, distinct from the request id', async () => {
    const { gateway, record } = build();
    const act = {
      action: 'approve',
      resource: 'production.bom',
      resourceId: '11111111-1111-4111-8111-111111111111',
    } as Parameters<ProductionAuditGateway['record']>[1];

    await gateway.record(ACTOR, act);
    await gateway.record(ACTOR, act);

    const [first, second] = record.mock.calls.map((call) => call[0].auditId);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(ACTOR.requestId);
    // Two events in one request are two rows, not one idempotency-digest collision.
    expect(first).not.toBe(second);
  });

  it('passes the act through unchanged and never throws when the port rejects', async () => {
    const record = jest.fn().mockRejectedValue(new Error('audit store is down'));
    const { gateway } = build(record);

    await expect(
      gateway.record(ACTOR, {
        action: 'reject',
        resource: 'production.bom',
        resourceId: '11111111-1111-4111-8111-111111111111',
        newValue: { status: 'REJECTED' },
      } as Parameters<ProductionAuditGateway['record']>[1])
    ).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('ProductionAuditGateway.read — the read half of the same port', () => {
  const page = {
    status: 'ok' as const,
    page: { items: [], page: 1, pageSize: 20, total: 0 },
  };

  it('delegates the query to the port verbatim and returns its page', async () => {
    const { gateway, read } = build(undefined, jest.fn().mockResolvedValue(page));

    const query = {
      tenantId: 'tenant-a',
      resource: 'production.bom',
      resourceId: '11111111-1111-4111-8111-111111111111',
      page: 2,
      pageSize: 5,
    };
    const result = await gateway.read(
      query as Parameters<ProductionAuditGateway['read']>[0]
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(query);
    expect(result).toBe(page);
  });

  it('passes a rejection through unchanged, never an empty ok page', async () => {
    const rejection = { status: 'rejected' as const, code: 'AUDIT_READ_FAILED' as const };
    const { gateway } = build(undefined, jest.fn().mockResolvedValue(rejection));

    const result = await gateway.read({
      tenantId: 'tenant-a',
      resource: 'production.bom',
      resourceId: '11111111-1111-4111-8111-111111111111',
    } as Parameters<ProductionAuditGateway['read']>[0]);

    expect(result).toBe(rejection);
    expect(result.status).toBe('rejected');
  });

  it('classifies a throwing port as AUDIT_READ_FAILED instead of letting it escape', async () => {
    const { gateway, read } = build(undefined, jest.fn().mockRejectedValue(new Error('down')));

    const result = await gateway.read({
      tenantId: 'tenant-a',
      resource: 'production.bom',
      resourceId: '11111111-1111-4111-8111-111111111111',
    } as Parameters<ProductionAuditGateway['read']>[0]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'rejected', code: 'AUDIT_READ_FAILED' });
  });
});
