import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import type { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';
import type { CommerceUnitOfWork } from '../database/commerce-transaction';
import { SUPPLIER_AUDIT_ACTION, SUPPLIER_FAILURE } from './supplier.constants';
import { SupplierNationalCodeConflictError } from './supplier.repository';
import { SupplierService } from './supplier.service';

/**
 * The supplier directory service at the seam where it decides — fakes for the
 * repository, a spy for the audit gateway. Pinned: the named refusals,
 * tenant-first arguments, server-derived actor, normalisation, the DURABLE
 * outbox travelling inside the unit of work, and — above all — that the
 * ordinary projections NEVER carry banking fields while `banking()` carries
 * exactly them.
 */
const actor: CommerceActor = {
  tenantId: 't1',
  userId: 'u-actor',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

const machineActor: CommerceActor = { ...actor, userId: null };

function storedSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    tenantId: 't1',
    entityType: 'INDIVIDUAL',
    name: 'علی رضایی',
    companyName: null,
    nationalCode: '1234567890',
    shebaNumber: 'IR123456789012345678901234',
    cardNumber: '6037991234567890',
    bankName: 'بانک ملت',
    address: 'تهران',
    phone: '02155551234',
    email: null,
    notes: null,
    status: 'ACTIVE',
    createdByUserId: 'u-recorder',
    updatedByUserId: null,
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    ...overrides,
  };
}

type SupplierRepositoryLike = ConstructorParameters<typeof SupplierService>[0];

function build() {
  const repository = {
    findSupplierById: jest.fn(),
    findExactIdentity: jest.fn(),
    listSuppliers: jest.fn(),
    createSupplier: jest.fn(),
    updateSupplierIn: jest.fn(),
    listPurchasesForSupplier: jest.fn(),
    listQuotationsForSupplier: jest.fn(),
    listPurchaseSupplierRefs: jest.fn(),
    listAllForReconciliation: jest.fn(),
  };
  const audit = {
    buildOutboxPayload: jest.fn().mockImplementation((_actor: CommerceActor, act: unknown) => ({
      tenantId: 't1',
      auditId: 'outbox-audit-id',
      payload: act,
    })),
  };
  const unitOfWork = {
    run: jest.fn(async (fn: (tx: unknown) => unknown) => fn('tx-handle')),
  };
  const service = new SupplierService(
    repository as unknown as SupplierRepositoryLike,
    audit as unknown as CommerceAuditGateway,
    unitOfWork as unknown as CommerceUnitOfWork
  );
  return { service, repository, audit, unitOfWork };
}

const expectConflict = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ response: expect.objectContaining({ code }) });

describe('supplier create', () => {
  it('refuses a machine context before touching the repository', async () => {
    const { service, repository } = build();

    await expect(
      service.create(machineActor, { entityType: 'INDIVIDUAL', name: 'x' } as never)
    ).rejects.toThrow(ForbiddenException);
    expect(repository.findExactIdentity).not.toHaveBeenCalled();
  });

  it('refuses a LEGAL supplier without a company name', async () => {
    const { service, repository } = build();

    await expectConflict(
      service.create(actor, { entityType: 'LEGAL', name: 'شرکت الف' } as never),
      SUPPLIER_FAILURE.COMPANY_NAME_REQUIRED
    );
    expect(repository.createSupplier).not.toHaveBeenCalled();
  });

  it('refuses an EXACT-identity duplicate but lets a merely similar name through', async () => {
    const { service, repository } = build();

    repository.findExactIdentity.mockResolvedValue({ id: 's-existing', name: 'علی رضایی' });
    await expectConflict(
      service.create(actor, { entityType: 'INDIVIDUAL', name: 'علی رضایی' } as never),
      SUPPLIER_FAILURE.DUPLICATE_IDENTITY
    );
    // The identity lookup is tenant-first, and asked with the EXACT (trimmed) identity.
    expect(repository.findExactIdentity).toHaveBeenCalledWith('t1', 'INDIVIDUAL', 'علی رضایی', null);

    // No twin (a different name/code) — creation proceeds: fuzzy neighbours are ALLOWED.
    repository.findExactIdentity.mockResolvedValue(null);
    repository.createSupplier.mockResolvedValue(storedSupplier());
    await expect(
      service.create(actor, { entityType: 'INDIVIDUAL', name: 'علی رضايی' } as never)
    ).resolves.toMatchObject({ id: 's1' });
  });

  it('creates tenant-first, normalised, with the server actor, and the outbox INSIDE the unit of work', async () => {
    const { service, repository, unitOfWork, audit } = build();
    repository.findExactIdentity.mockResolvedValue(null);
    repository.createSupplier.mockResolvedValue(
      storedSupplier({ name: 'علی رضایی', shebaNumber: 'IR123456789012345678901234' })
    );

    await service.create(actor, {
      entityType: 'INDIVIDUAL',
      name: '  علی رضایی  ',
      nationalCode: '1234567890',
      shebaNumber: 'ir123456789012345678901234',
      cardNumber: '6037991234567890',
      bankName: ' بانک ملت ',
    } as never);

    expect(unitOfWork.run).toHaveBeenCalledTimes(1);
    const [tenantId, data, buildOutbox, tx] = repository.createSupplier.mock.calls[0] as [
      string,
      Record<string, unknown>,
      (id: string) => unknown,
      string,
    ];
    expect(tenantId).toBe('t1');
    expect(data).toMatchObject({
      name: 'علی رضایی', // trimmed
      shebaNumber: 'IR123456789012345678901234', // uppercased, IR-prefixed
      bankName: 'بانک ملت',
      status: 'ACTIVE', // default applied SERVER-side
      createdByUserId: 'u-actor', // server-resolved actor, never client-stated
    });
    expect(tx).toBe('tx-handle');
    const outbox = buildOutbox('s1');
    expect(audit.buildOutboxPayload).toHaveBeenCalled();
    expect(outbox).toMatchObject({
      tenantId: 't1',
      payload: expect.objectContaining({
        action: SUPPLIER_AUDIT_ACTION.CREATED,
        resource: COMMERCE_AUDIT_RESOURCE.SUPPLIER,
        resourceId: 's1',
      }),
    });
  });

  it('maps the structural national-code collision to the named 409', async () => {
    const { service, repository } = build();
    repository.findExactIdentity.mockResolvedValue(null);
    repository.createSupplier.mockRejectedValue(new SupplierNationalCodeConflictError());

    await expectConflict(
      service.create(actor, { entityType: 'INDIVIDUAL', name: 'x', nationalCode: '1234567890' } as never),
      SUPPLIER_FAILURE.NATIONAL_CODE_EXISTS
    );
  });

  it('the created projection carries NO banking fields — they exist only on banking()', async () => {
    const { service, repository } = build();
    repository.findExactIdentity.mockResolvedValue(null);
    repository.createSupplier.mockResolvedValue(storedSupplier());

    const result = (await service.create(actor, {
      entityType: 'INDIVIDUAL',
      name: 'علی رضایی',
    } as never)) as Record<string, unknown>;

    expect(result).not.toHaveProperty('nationalCode');
    expect(result).not.toHaveProperty('shebaNumber');
    expect(result).not.toHaveProperty('cardNumber');
    expect(result).not.toHaveProperty('bankName');
    expect(result).toMatchObject({ id: 's1', name: 'علی رضایی', status: 'ACTIVE' });
  });
});

describe('supplier update', () => {
  it('refuses an empty body by name and a machine context before any read', async () => {
    const { service, repository } = build();

    await expectConflict(service.update(actor, 's1', {} as never), SUPPLIER_FAILURE.UPDATE_EMPTY);
    await expect(service.update(machineActor, 's1', { notes: 'x' } as never)).rejects.toThrow(
      ForbiddenException
    );
    expect(repository.findSupplierById).not.toHaveBeenCalled();
  });

  it('404s an unknown or foreign supplier', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(null);

    await expect(service.update(actor, 'missing', { notes: 'x' } as never)).rejects.toThrow(
      NotFoundException
    );
    expect(repository.findSupplierById).toHaveBeenCalledWith('t1', 'missing');
  });

  it('re-runs the duplicate rule against the MERGED row, refusing only a DIFFERENT twin', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(storedSupplier());

    // A different supplier already holds the merged identity → refusal.
    repository.findExactIdentity.mockResolvedValue({ id: 's-other', name: 'علی رضایی' });
    await expectConflict(
      service.update(actor, 's1', { phone: '02155559999' } as never),
      SUPPLIER_FAILURE.DUPLICATE_IDENTITY
    );

    // The twin is THIS row (renaming back to its own identity) → allowed.
    repository.findExactIdentity.mockResolvedValue({ id: 's1', name: 'علی رضایی' });
    repository.updateSupplierIn.mockResolvedValue(storedSupplier());
    await expect(service.update(actor, 's1', { notes: 'یادداشت' } as never)).resolves.toMatchObject(
      { id: 's1' }
    );
    // ...and the write is conditional, tenant-first, with the server actor.
    const [tenantId, id, data, , tx] = repository.updateSupplierIn.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      unknown,
      string,
    ];
    expect(tenantId).toBe('t1');
    expect(id).toBe('s1');
    expect(data).toMatchObject({ notes: 'یادداشت', updatedByUserId: 'u-actor' });
    expect(tx).toBe('tx-handle');
  });

  it('404s when the conditional write matches nothing (row vanished between read and write)', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(storedSupplier());
    repository.findExactIdentity.mockResolvedValue(null);
    repository.updateSupplierIn.mockResolvedValue(null);

    await expect(service.update(actor, 's1', { notes: 'x' } as never)).rejects.toThrow(
      NotFoundException
    );
  });

  it('records the changed field NAMES in the audited act, without banking values', async () => {
    const { service, repository, audit } = build();
    repository.findSupplierById.mockResolvedValue(storedSupplier());
    repository.findExactIdentity.mockResolvedValue(null);
    repository.updateSupplierIn.mockResolvedValue(storedSupplier());

    await service.update(actor, 's1', { bankName: 'بانک ملی', notes: 'x' } as never);

    expect(audit.buildOutboxPayload).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: SUPPLIER_AUDIT_ACTION.UPDATED,
        resource: COMMERCE_AUDIT_RESOURCE.SUPPLIER,
        resourceId: 's1',
        changedFields: expect.arrayContaining(['bankName', 'notes']),
      })
    );
  });
});

describe('supplier reads — banking is a separate projection', () => {
  it('get() 404s a foreign row and NEVER returns banking fields', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(null);
    await expect(service.get(actor, 'missing')).rejects.toThrow(NotFoundException);

    repository.findSupplierById.mockResolvedValue(storedSupplier());
    const detail = (await service.get(actor, 's1')) as Record<string, unknown>;
    expect(detail).not.toHaveProperty('nationalCode');
    expect(detail).not.toHaveProperty('shebaNumber');
    expect(detail).not.toHaveProperty('cardNumber');
    expect(detail).not.toHaveProperty('bankName');
  });

  it('banking() returns exactly the sensitive five and still scopes by tenant', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(null);
    await expect(service.banking(actor, 'missing')).rejects.toThrow(NotFoundException);
    expect(repository.findSupplierById).toHaveBeenCalledWith('t1', 'missing');

    repository.findSupplierById.mockResolvedValue(storedSupplier());
    await expect(service.banking(actor, 's1')).resolves.toEqual({
      id: 's1',
      name: 'علی رضایی',
      nationalCode: '1234567890',
      shebaNumber: 'IR123456789012345678901234',
      cardNumber: '6037991234567890',
      bankName: 'بانک ملت',
    });
  });

  it('list() clamps an oversized page for an internal caller and passes filters tenant-first', async () => {
    const { service, repository } = build();
    repository.listSuppliers.mockResolvedValue({ items: [], total: 0 });

    await service.list(actor, {
      search: '  البرز ',
      entityType: 'LEGAL',
      pageSize: COMMERCE_MAX_PAGE_SIZE * 10,
    } as never);

    const [tenantId, filters, window] = repository.listSuppliers.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, number>,
    ];
    expect(tenantId).toBe('t1');
    expect(filters).toEqual({ search: 'البرز', entityType: 'LEGAL', status: undefined });
    expect(window).toEqual({ skip: 0, take: COMMERCE_MAX_PAGE_SIZE });
  });
});

describe('supplier history reads', () => {
  it('purchaseHistory 404s an unknown supplier and reads tenant-first', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(null);
    await expect(service.purchaseHistory(actor, 'missing', {})).rejects.toThrow(NotFoundException);

    repository.findSupplierById.mockResolvedValue(storedSupplier());
    repository.listPurchasesForSupplier.mockResolvedValue({ items: [], total: 0 });
    await expect(service.purchaseHistory(actor, 's1', {})).resolves.toMatchObject({ total: 0 });
    expect(repository.listPurchasesForSupplier).toHaveBeenCalledWith(
      't1',
      's1',
      expect.objectContaining({ skip: 0 })
    );
  });

  it('quotationHistory 404s an unknown supplier and reads tenant-first', async () => {
    const { service, repository } = build();
    repository.findSupplierById.mockResolvedValue(null);
    await expect(service.quotationHistory(actor, 'missing', {})).rejects.toThrow(NotFoundException);

    repository.findSupplierById.mockResolvedValue(storedSupplier());
    repository.listQuotationsForSupplier.mockResolvedValue({ items: [], total: 0 });
    await expect(service.quotationHistory(actor, 's1', {})).resolves.toMatchObject({ total: 0 });
    expect(repository.listQuotationsForSupplier).toHaveBeenCalledWith(
      't1',
      's1',
      expect.objectContaining({ skip: 0 })
    );
  });
});

describe('PHASE W2-C — supplier reconciliation (read-only)', () => {
  it('classifies every distinct purchase reference — resolved, suggested, ambiguous, unresolved', async () => {
    const { service, repository } = build();
    repository.listPurchaseSupplierRefs.mockResolvedValue([
      { supplierId: 'sup-real', _count: { supplierId: 3 } },
      { supplierId: 'شرکت الف', _count: { supplierId: 2 } },
      { supplierId: 'shared-name', _count: { supplierId: 1 } },
      { supplierId: 'GHOST-9', _count: { supplierId: 4 } },
    ]);
    repository.listAllForReconciliation.mockResolvedValue([
      { id: 'sup-real', name: 'Real Co', nationalCode: '1000000001', status: 'ACTIVE' },
      { id: 'sup-alfa', name: 'شرکت الف', nationalCode: null, status: 'ACTIVE' },
      { id: 'sup-b1', name: 'shared-name', nationalCode: null, status: 'ACTIVE' },
      { id: 'sup-b2', name: 'shared-name', nationalCode: null, status: 'INACTIVE' },
    ]);

    const report = await service.reconcile(actor);

    const byRef = new Map(report.items.map((i: { reference: string }) => [i.reference, i]));
    expect(byRef.get('sup-real')).toMatchObject({ resolution: 'RESOLVED', documentCount: 3 });
    expect(byRef.get('شرکت الف')).toMatchObject({
      resolution: 'SUGGESTED',
      matches: [{ id: 'sup-alfa' }],
    });
    expect(byRef.get('shared-name')).toMatchObject({ resolution: 'AMBIGUOUS' });
    expect(
      (byRef.get('shared-name') as unknown as { matches: unknown[] }).matches
    ).toHaveLength(2);
    expect(byRef.get('GHOST-9')).toMatchObject({ resolution: 'UNRESOLVED', matches: [] });
    expect(report.summary).toEqual({
      distinctReferences: 4,
      resolved: 1,
      suggested: 1,
      ambiguous: 1,
      unresolved: 1,
    });
  });

  it('scopes both reads to the actor tenant and writes nothing', async () => {
    const { service, repository } = build();
    repository.listPurchaseSupplierRefs.mockResolvedValue([]);
    repository.listAllForReconciliation.mockResolvedValue([]);

    const report = await service.reconcile(actor);

    expect(repository.listPurchaseSupplierRefs).toHaveBeenCalledWith('t1');
    expect(repository.listAllForReconciliation).toHaveBeenCalledWith('t1');
    expect(repository.updateSupplierIn).not.toHaveBeenCalled();
    expect(report.items).toEqual([]);
  });
});
