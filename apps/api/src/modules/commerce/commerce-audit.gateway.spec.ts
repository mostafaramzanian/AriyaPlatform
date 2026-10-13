import { CommerceAuditGateway } from './commerce-audit.gateway';

/**
 * PHASE C7 (GAP-7): the read half of the ONE Commerce audit surface.
 *
 * `record` is already pinned by the Step-H file scan (`commerce-gateways.spec.ts`) and
 * by every writer service's spec; what is new here is `read`, and the three claims that
 * make it safe to consume:
 *
 *  * it DELEGATES — the gateway decides nothing: the query it was given reaches the
 *    port verbatim, so scope, pagination, ordering and projection stay the platform
 *    contract's single opinion;
 *  * a rejection is passed through UNCHANGED — `{ status: 'rejected', code }` arrives
 *    at the service intact, which is what lets a failed read become a 503 rather than
 *    an empty timeline;
 *  * a port that THROWS (violating the platform's never-throw promise) is CLASSIFIED
 *    as `AUDIT_READ_FAILED` and logged — it never escapes the gateway as an
 *    unclassified exception and is never converted into `status: 'ok'`.
 *
 * The port fake is structural on purpose: this spec lives inside the Commerce module,
 * where the Step-H guard forbids importing the platform audit contract directly.
 * `ConstructorParameters` derives the exact port type from the gateway's own
 * constructor, so the fake still has to SATISFY `AuditPort` without naming it.
 */
type AuditPortDouble = ConstructorParameters<typeof CommerceAuditGateway>[0];

function build(read?: jest.Mock, record?: jest.Mock) {
  const port: AuditPortDouble = {
    record: record ?? jest.fn().mockResolvedValue({ status: 'recorded' }),
    read: read ?? jest.fn(),
  };
  return { gateway: new CommerceAuditGateway(port), port, read: port.read as jest.Mock };
}

describe('CommerceAuditGateway.read (C7) — the single audit surface, read side', () => {
  it('delegates the query to AUDIT_PORT.read verbatim and returns its page', async () => {
    const page = {
      status: 'ok' as const,
      page: { items: [], page: 1, pageSize: 20, total: 0 },
    };
    const { gateway, read } = build(jest.fn().mockResolvedValue(page));

    const query = {
      tenantId: 'tenant-a',
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
      page: 2,
      pageSize: 5,
    };
    const result = await gateway.read(query);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(query);
    expect(result).toBe(page);
  });

  it('passes a rejection through unchanged, never an empty ok page', async () => {
    const rejection = { status: 'rejected' as const, code: 'AUDIT_READ_FAILED' as const };
    const { gateway } = build(jest.fn().mockResolvedValue(rejection));

    const result = await gateway.read({
      tenantId: 'tenant-a',
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
    });

    expect(result).toBe(rejection);
    expect(result.status).toBe('rejected');
  });

  it('classifies a throwing port as AUDIT_READ_FAILED instead of letting it escape', async () => {
    const { gateway, read } = build(
      jest.fn().mockRejectedValue(new Error('database is down'))
    );

    const result = await gateway.read({
      tenantId: 'tenant-a',
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'rejected', code: 'AUDIT_READ_FAILED' });
  });

  it('stays a pure adapter: reading records nothing through the write half', async () => {
    const record = jest.fn();
    const { gateway } = build(jest.fn().mockResolvedValue({ status: 'ok', page: {
      items: [], page: 1, pageSize: 20, total: 0,
    } }), record);

    await gateway.read({
      tenantId: 'tenant-a',
      resource: 'commerce.purchase_document',
      resourceId: 'doc-1',
    });

    expect(record).not.toHaveBeenCalled();
  });
});