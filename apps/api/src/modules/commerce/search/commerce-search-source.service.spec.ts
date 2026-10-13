import {
  SEARCH_OWNER_MODULE_ID_PATTERN,
  SEARCH_SOURCE_KEY_PATTERN,
  SearchSourceRegistrationError,
  composeRouteHref,
  validateSearchProjectionRecord,
  validateSearchSourceAdapter,
  validateSearchSourceAuthorizationResult,
  validateSearchSourceDescriptor,
  validateSearchSourceRouteTemplate,
  type RegisteredSearchSource,
  type SearchSourceAdapter,
} from '../../../platform/search-source/search-source.contract';
import {
  SEARCH_WEIGHT_CLASSES,
  SEARCH_WEIGHT_CLASS_FACTORS,
} from '../../../search/search.constants';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import {
  COMMERCE_SEARCH_SOURCE_KEY,
  COMMERCE_SEARCH_SOURCE_ROUTE_TEMPLATE,
  COMMERCE_SEARCH_SOURCE_WEIGHT_CLASS,
  CommerceSearchSourceService,
  purchaseSearchProjection,
  type SearchablePurchaseDocument,
} from './commerce-search-source.service';

/**
 * PHASE C9 (GAP-5): the Commerce Search Source Adapter, pinned item by item against the
 * P-SEARCH-SOURCE contract it consumes.
 *
 * WHAT THESE TESTS ARE FOR. The adapter is the ONE surface where Commerce talks to the
 * platform's Global Search, so every claim the C9 contract makes about it is asserted
 * here against the PLATFORM'S OWN validators and grammars — not against a re-typed
 * expectation. A descriptor that stopped satisfying `validateSearchSourceDescriptor`,
 * a route template the platform would refuse, a projection that grew a field, an
 * authorization answer that mentions an id the platform never asked about: each of those
 * fails here, before it can reach a running search.
 *
 * THE PORT IS A DOUBLE, THE CONTRACT IS REAL. The port double records what the adapter
 * registers and what it pushes; every shape crossing it is then run through the
 * platform's `validate*` functions, so the fake cannot agree with an adapter that
 * production would refuse.
 */

/** The port, typed exactly as the constructor declares it — no re-typed copy. */
type PortDouble = ConstructorParameters<typeof CommerceSearchSourceService>[0];

interface Built {
  readonly service: CommerceSearchSourceService;
  readonly register: jest.Mock;
  readonly project: jest.Mock;
  readonly remove: jest.Mock;
  readonly repository: { findDocumentSearchRowsByIds: jest.Mock };
  readonly permissions: { getEffectivePermissions: jest.Mock };
  /** The adapter the port received, for direct assertions. */
  readonly adapter: () => SearchSourceAdapter;
}

function build(): Built {
  let registered: SearchSourceAdapter | undefined;

  const project = jest.fn().mockResolvedValue({
    status: 'indexed',
    indexed: 1,
    embedded: 0,
    skipped: [],
  });
  const remove = jest.fn().mockResolvedValue({ status: 'removed', removed: 0 });

  const register = jest.fn((adapter: SearchSourceAdapter): RegisteredSearchSource => {
    registered = adapter;
    // The handle the REAL binding returns: BOUND to the registered key — `project` and
    // `remove` take no source key, which is exactly why the adapter cannot write into
    // another namespace.
    return { descriptor: adapter.descriptor, project, remove };
  });

  const port = { register } as unknown as PortDouble;

  const repository = { findDocumentSearchRowsByIds: jest.fn().mockResolvedValue(new Map()) };
  const permissions = {
    getEffectivePermissions: jest.fn().mockResolvedValue([Permissions.COMMERCE_READ]),
  };

  const service = new CommerceSearchSourceService(port, repository as never, permissions as never);

  return {
    service,
    register,
    project,
    remove,
    repository,
    permissions,
    adapter: () => {
      if (!registered) throw new Error('the adapter did not register');
      return registered;
    },
  };
}

const DOCUMENT: SearchablePurchaseDocument = {
  id: '0d5f1f9e-3a63-4c4f-9a7d-4b1c2d3e4f50',
  tenantId: 'tenant-a',
  documentNumber: 'PR-1405-00042',
  updatedAt: new Date('2026-09-30T08:30:00.000Z'),
};

describe('PHASE C9 — the descriptor Commerce declares (P-SEARCH-SOURCE §D)', () => {
  it('declares a well-formed descriptor the PLATFORM accepts, key and all', () => {
    const { adapter } = build();
    const descriptor = adapter().descriptor;

    // The platform's OWN validator — the same call `register` makes in production.
    expect(validateSearchSourceDescriptor(descriptor)).toEqual({ ok: true });
    expect(validateSearchSourceAdapter(adapter())).toEqual({ ok: true });

    expect(descriptor.key).toMatch(SEARCH_SOURCE_KEY_PATTERN);
    expect(descriptor.key).toBe(COMMERCE_SEARCH_SOURCE_KEY);
    expect(descriptor.ownerModuleId).toBe('commerce');
    expect(descriptor.ownerModuleId).toMatch(SEARCH_OWNER_MODULE_ID_PATTERN);
    // The stable, source-owned key — a constant, never a request value and never a label.
    expect(descriptor.key).toBe('commerce.purchase-document');
    expect(descriptor.key.length).toBeLessThanOrEqual(64);
  });

  it('participates under the PRIMARY class only — a class, never a number (platform §AA.1)', () => {
    const { adapter } = build();
    const descriptor = adapter().descriptor;

    expect(SEARCH_WEIGHT_CLASSES).toContain(COMMERCE_SEARCH_SOURCE_WEIGHT_CLASS);
    expect(descriptor.weightClass).toBe('PRIMARY');
    // The class maps to the multiplier 49J already owns; Commerce chose no magnitude.
    expect(SEARCH_WEIGHT_CLASS_FACTORS[descriptor.weightClass]).toBe(1);
  });

  it('targets the EXISTING purchase detail route — a template the platform validates', () => {
    const { adapter } = build();
    const descriptor = adapter().descriptor;

    expect(descriptor.routeTemplate).toBe('/admin/commerce/purchases/:id');
    expect(COMMERCE_SEARCH_SOURCE_ROUTE_TEMPLATE).toBe('/admin/commerce/purchases/:id');
    expect(validateSearchSourceRouteTemplate(descriptor.routeTemplate)).toEqual({ ok: true });

    // The source supplies a template; the PLATFORM composes and encodes the href. An id
    // that contains path-significant characters becomes opaque text, not structure — the
    // property that makes "no arbitrary URL" structural rather than a promise.
    expect(composeRouteHref(descriptor.routeTemplate, DOCUMENT.id)).toBe(
      `/admin/commerce/purchases/${DOCUMENT.id}`
    );
    expect(composeRouteHref(descriptor.routeTemplate, 'a/b?c#d')).toBe(
      '/admin/commerce/purchases/a%2Fb%3Fc%23d'
    );
  });

  it('registers ONCE, at composition, with ITSELF — and a refused registration escapes', () => {
    const { register, adapter } = build();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(adapter());

    // Registration is composition: the platform's typed failure must reach the boot, not
    // be swallowed into a silently unsearchable module.
    const refusing = {
      register: jest.fn(() => {
        throw new SearchSourceRegistrationError('SOURCE_DUPLICATE', 'duplicate');
      }),
    } as unknown as PortDouble;
    expect(
      () =>
        new CommerceSearchSourceService(
          refusing,
          { findDocumentSearchRowsByIds: jest.fn() } as never,
          { getEffectivePermissions: jest.fn() } as never
        )
    ).toThrow(SearchSourceRegistrationError);
  });
});


describe('PHASE C9 — the projection Commerce pushes (§E, §S)', () => {
  it('carries the document NUMBER and nothing else — verbatim, un-normalized', () => {
    // A row as `PurchaseService` holds it: the projection must pick the three fields it
    // is allowed to know and DROP everything else, without transforming the number.
    const row = {
      id: DOCUMENT.id,
      tenantId: DOCUMENT.tenantId,
      documentNumber: '  PR-1405-00042  ',
      updatedAt: DOCUMENT.updatedAt,
      requesterId: 'user-9',
      supplierId: 'supplier-1',
      currency: 'EUR',
      status: 'SUBMITTED',
      subtotalAmount: '25.0000',
      lines: [{ id: 'line-1' }],
    } as unknown as SearchablePurchaseDocument;

    const record = purchaseSearchProjection(row);

    expect(Object.keys(record).sort()).toEqual([
      'entityId',
      'searchContent',
      'sourceUpdatedAt',
      'tenantId',
    ]);
    expect(record).toEqual({
      entityId: DOCUMENT.id,
      tenantId: DOCUMENT.tenantId,
      // Verbatim: no trim, no case fold, no digit translation. The PLATFORM's one
      // `buildSearchText` pipeline normalizes; a second normalizer here is the drift the
      // contract forbids.
      searchContent: ['  PR-1405-00042  '],
      sourceUpdatedAt: DOCUMENT.updatedAt,
    });

    // No requester, supplier, currency, status, amount or line text anywhere — asserted
    // over the SERIALIZED record, which is what would cross the boundary.
    const serialized = JSON.stringify(record);
    for (const forbidden of ['user-9', 'supplier-1', 'EUR', 'SUBMITTED', '25.0000', 'line-1']) {
      expect(serialized).not.toContain(forbidden);
    }

    // The platform's OWN record validator accepts exactly this shape.
    expect(validateSearchProjectionRecord(record)).toEqual({ ok: true });
  });

  it('pushes ONE single-record batch through the handle, and never removes', async () => {
    const { service, project, remove } = build();

    await service.projectDocument(DOCUMENT);

    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith([purchaseSearchProjection(DOCUMENT)]);
    // No deletion path exists for a purchase document, so no removal is ever issued —
    // "inactive" or "closed" states are not removal, and inventing one would be a new
    // lifecycle semantic.
    expect(remove).not.toHaveBeenCalled();
  });

  it('survives a refusal, a skip and a storage failure — the write that committed stands', async () => {
    const refused = build();
    refused.project.mockResolvedValueOnce({ status: 'rejected', code: 'PROJECTION_CONTENT_INVALID' });
    await expect(refused.service.projectDocument(DOCUMENT)).resolves.toBeUndefined();

    const skipped = build();
    skipped.project.mockResolvedValueOnce({
      status: 'indexed',
      indexed: 0,
      embedded: 0,
      skipped: [DOCUMENT.id],
    });
    await expect(skipped.service.projectDocument(DOCUMENT)).resolves.toBeUndefined();

    const failed = build();
    failed.project.mockRejectedValueOnce(new Error('index unavailable'));
    await expect(failed.service.projectDocument(DOCUMENT)).resolves.toBeUndefined();
  });
});


describe('PHASE C9 — the answer it gives back (§H, §I)', () => {
  const actor = { userId: 'user-1', tenantId: 'tenant-a' };

  const rowsFor = (ids: readonly string[]) =>
    new Map(
      ids.map((id) => [id, { documentNumber: `PR-1405-${id}`, updatedAt: DOCUMENT.updatedAt }])
    );

  it('returns the authoritative number and timestamp for requested ids, in requested order', async () => {
    const { service, repository, permissions } = build();
    repository.findDocumentSearchRowsByIds.mockResolvedValue(rowsFor(['d2', 'd1']));

    const result = await service.authorize({ actor, entityIds: ['d1', 'd2'] });

    expect(result).toEqual({
      entries: [
        {
          entityId: 'd1',
          title: 'PR-1405-d1',
          snippetFields: ['PR-1405-d1'],
          timestamp: DOCUMENT.updatedAt,
        },
        {
          entityId: 'd2',
          title: 'PR-1405-d2',
          snippetFields: ['PR-1405-d2'],
          timestamp: DOCUMENT.updatedAt,
        },
      ],
    });

    // The answer satisfies the platform's own validator for the ids it was asked about.
    expect(validateSearchSourceAuthorizationResult(result, ['d1', 'd2'])).toEqual({ ok: true });

    // ONE tenant-scoped batch read, tenant FIRST — never a query per row.
    expect(repository.findDocumentSearchRowsByIds).toHaveBeenCalledTimes(1);
    expect(repository.findDocumentSearchRowsByIds).toHaveBeenCalledWith('tenant-a', ['d1', 'd2']);

    // `commerce.read` — the module's existing read permission — asked through the guard's
    // own seam, with no claims (the actor context carries none) and NO invented permission.
    expect(permissions.getEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(permissions.getEffectivePermissions).toHaveBeenCalledWith('user-1', null);
  });

  it('returns NOTHING for an actor without `commerce.read`, before reading any row', async () => {
    const { service, repository, permissions } = build();
    permissions.getEffectivePermissions.mockResolvedValue([Permissions.COMMERCE_MANAGE]);

    const result = await service.authorize({ actor, entityIds: ['d1'] });

    expect(result).toEqual({ entries: [] });
    // The permission question is asked FIRST: an unreadable candidate must not cause a
    // database read the caller has no licence for.
    expect(repository.findDocumentSearchRowsByIds).not.toHaveBeenCalled();
  });

  it('returns NOTHING for a tenant-less actor and for an empty id list, without any call', async () => {
    const tenantless = build();
    await expect(
      tenantless.service.authorize({
        actor: { userId: 'user-1', tenantId: null },
        entityIds: ['d1'],
      })
    ).resolves.toEqual({ entries: [] });
    expect(tenantless.permissions.getEffectivePermissions).not.toHaveBeenCalled();
    expect(tenantless.repository.findDocumentSearchRowsByIds).not.toHaveBeenCalled();

    const empty = build();
    await expect(empty.service.authorize({ actor, entityIds: [] })).resolves.toEqual({
      entries: [],
    });
    expect(empty.permissions.getEffectivePermissions).not.toHaveBeenCalled();
    expect(empty.repository.findDocumentSearchRowsByIds).not.toHaveBeenCalled();
  });

  it('drops a stale projection, another tenant’s id and a removed row alike', async () => {
    const { service, repository } = build();
    // The repository answers for the ACTOR'S tenant only: an id it does not return is a
    // stale index row, an id from another tenant, or a row that is gone — all "nothing".
    repository.findDocumentSearchRowsByIds.mockResolvedValue(rowsFor(['d1']));

    const result = await service.authorize({ actor, entityIds: ['d1', 'gone', 'tenant-b-id'] });

    expect(result.entries.map((entry) => entry.entityId)).toEqual(['d1']);
  });

  it('answers a duplicated id ONCE — a duplicate would invalidate the whole answer', async () => {
    const { service, repository } = build();
    repository.findDocumentSearchRowsByIds.mockResolvedValue(rowsFor(['d1']));

    const result = await service.authorize({ actor, entityIds: ['d1', 'd1'] });

    expect(result.entries).toHaveLength(1);
    expect(validateSearchSourceAuthorizationResult(result, ['d1', 'd1'])).toEqual({ ok: true });
  });

  it('does NOT swallow a repository failure — the platform’s fail-closed path owns it', async () => {
    const { service, repository } = build();
    repository.findDocumentSearchRowsByIds.mockRejectedValue(new Error('commerce_db down'));

    // A throw from `authorize` makes the platform drop EVERY candidate from this source
    // (`SearchSourceService` logs it under the source key); converting it into an empty
    // answer here would hide an outage behind "no results".
    await expect(service.authorize({ actor, entityIds: ['d1'] })).rejects.toThrow(
      'commerce_db down'
    );
  });
});

