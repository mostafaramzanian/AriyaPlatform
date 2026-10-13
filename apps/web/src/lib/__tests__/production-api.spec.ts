import {
  PRODUCTION_MAX_PAGE_SIZE,
  buildProductionBomItemQuery,
  buildProductionBomQuery,
  buildProductionBomTimelineQuery,
  createProductionBom,
  createProductionBomItem,
  decideProductionBom,
  deleteProductionBomItem,
  fetchProductionBom,
  fetchProductionBomItem,
  fetchProductionBomItems,
  fetchProductionBomTimeline,
  fetchProductionBoms,
  submitProductionBom,
  updateProductionBom,
  updateProductionBomItem,
} from '../production-api';
import { coreDelete, coreGet, corePatch, corePost } from '../core-http';

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
  coreDelete: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;
const deleteMock = coreDelete as jest.MockedFunction<typeof coreDelete>;

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * PHASE PRODUCTION-BOM: the Production client's wire contract.
 *
 * WHAT THESE SPECS PIN: the EXACT paths (so a typo cannot ship), the query serialization
 * (Persian encoded, blanks dropped, `pageSize` capped by the declared constant), the
 * `tenantId`-free request shape (the actor is server-derived), and that the decision routes
 * each carry their OWN opinion. Nothing here calls the network: `core-http` is mocked and
 * every function runs untouched.
 */
describe('production-api — query serialization', () => {
  it('builds an empty query for a bare read', () => {
    expect(buildProductionBomQuery()).toBe('');
    expect(buildProductionBomQuery({})).toBe('');
  });

  it('serializes the exact supported header filters, in a stable order', () => {
    expect(
      buildProductionBomQuery({ page: 2, pageSize: 20, search: 'اقلام', status: 'SUBMITTED' })
    ).toBe(`?page=2&pageSize=20&search=${encodeURIComponent('اقلام')}&status=SUBMITTED`);
  });

  it('drops a blank search instead of sending an empty filter', () => {
    expect(buildProductionBomQuery({ search: '   ' })).toBe('');
    expect(buildProductionBomItemQuery({ search: '' })).toBe('');
  });

  it('caps pageSize with the constant the API declares', () => {
    expect(buildProductionBomQuery({ pageSize: 5000 })).toBe(
      `?pageSize=${PRODUCTION_MAX_PAGE_SIZE}`
    );
    expect(buildProductionBomItemQuery({ pageSize: 5000 })).toBe(
      `?pageSize=${PRODUCTION_MAX_PAGE_SIZE}`
    );
    expect(PRODUCTION_MAX_PAGE_SIZE).toBe(100);
  });

  it('never sends a tenant (the actor is resolved server-side)', () => {
    expect(buildProductionBomQuery({ page: 1, search: 'x', status: 'DRAFT' })).not.toMatch(
      /tenant/i
    );
    expect(buildProductionBomItemQuery({ page: 1, search: 'x' })).not.toMatch(/tenant/i);
  });
});

describe('production-api — header routes', () => {
  it('reads the register from the route the header controller owns', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchProductionBoms({ page: 1, pageSize: 5 });

    expect(getMock).toHaveBeenCalledWith('/production/boms?page=1&pageSize=5');
  });

  it('reads one header by its opaque id', async () => {
    getMock.mockResolvedValue({ id: 'bom-1' });

    await fetchProductionBom('bom-1');

    expect(getMock).toHaveBeenCalledWith('/production/boms/bom-1');
  });

  it('creates through POST and updates through PATCH — never the other way round', async () => {
    postMock.mockResolvedValue({ id: 'bom-1' });
    patchMock.mockResolvedValue({ id: 'bom-1' });

    await createProductionBom({
      title: 't',
      projectRef: 'p',
      productTreeRef: 'tr',
      requesterUserId: 'r',
      approverUserId: 'a',
    });
    await updateProductionBom('bom-1', { title: 'renamed' });

    expect(postMock).toHaveBeenCalledWith('/production/boms', {
      title: 't',
      projectRef: 'p',
      productTreeRef: 'tr',
      requesterUserId: 'r',
      approverUserId: 'a',
    });
    expect(patchMock).toHaveBeenCalledWith('/production/boms/bom-1', { title: 'renamed' });
  });

  it('submits with a BODY-LESS POST: the approver is the row snapshot, not a field', async () => {
    postMock.mockResolvedValue({ id: 'bom-1' });

    await submitProductionBom('bom-1');

    expect(postMock).toHaveBeenCalledWith('/production/boms/bom-1/submit');
  });

  it('sends each decision to its OWN route with the matching opinion', async () => {
    postMock.mockResolvedValue({ id: 'bom-1' });

    await decideProductionBom('bom-1', 'approve', { opinion: 'APPROVED' });
    await decideProductionBom('bom-1', 'reject', { opinion: 'REJECTED' });
    await decideProductionBom('bom-1', 'request-correction', { opinion: 'NEEDS_CORRECTION' });

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      '/production/boms/bom-1/approve',
      '/production/boms/bom-1/reject',
      '/production/boms/bom-1/request-correction',
    ]);
    expect(postMock.mock.calls.map((call) => call[1])).toEqual([
      { opinion: 'APPROVED' },
      { opinion: 'REJECTED' },
      { opinion: 'NEEDS_CORRECTION' },
    ]);
  });
});

describe('production-api — item routes (nested under ONE header)', () => {
  it('reads a page of items through the BOM-scoped route', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchProductionBomItems('bom-1', { page: 2, pageSize: 5 });

    expect(getMock).toHaveBeenCalledWith('/production/boms/bom-1/items?page=2&pageSize=5');
  });

  it('reads one item by BOTH ids, so another BOM is not reachable', async () => {
    getMock.mockResolvedValue({ id: 'item-1' });

    await fetchProductionBomItem('bom-1', 'item-1');

    expect(getMock).toHaveBeenCalledWith('/production/boms/bom-1/items/item-1');
  });

  it('creates, updates and deletes an item through its own verbs', async () => {
    postMock.mockResolvedValue({ id: 'item-1' });
    patchMock.mockResolvedValue({ id: 'item-1' });
    deleteMock.mockResolvedValue({ id: 'item-1' });

    await createProductionBomItem('bom-1', {
      partName: 'Bracket',
      partType: 'STRUCTURAL',
      material: 'Steel',
      measurementUnit: 'pcs',
      drawingConsumptionCoefficient: 2,
      spareConsumptionCoefficient: 1,
    });
    await updateProductionBomItem('bom-1', 'item-1', { partName: 'v2' });
    const removed = await deleteProductionBomItem('bom-1', 'item-1');

    expect(postMock.mock.calls[0][0]).toBe('/production/boms/bom-1/items');
    expect(patchMock).toHaveBeenCalledWith('/production/boms/bom-1/items/item-1', { partName: 'v2' });
    expect(deleteMock).toHaveBeenCalledWith('/production/boms/bom-1/items/item-1');
    expect(removed).toEqual({ id: 'item-1' });
  });
});

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the timeline read's wire contract.
 *
 * WHAT THESE SPECS PIN: the EXACT path, that the query carries ONLY a page window (the
 * scope is the path plus the session), that `pageSize` is capped by the declared constant,
 * and that an audit outage surfaces as a REJECTED promise rather than as an empty page.
 */
describe('production-api — the audit timeline', () => {
  it('serializes only a page window, never a scope', () => {
    expect(buildProductionBomTimelineQuery()).toBe('');
    expect(buildProductionBomTimelineQuery({ page: 2, pageSize: 30 })).toBe(
      '?page=2&pageSize=30'
    );
    // Capped by the constant the API declares, exactly like every other list.
    expect(buildProductionBomTimelineQuery({ pageSize: 5000 })).toBe(
      `?pageSize=${PRODUCTION_MAX_PAGE_SIZE}`
    );
  });

  it('reads the timeline from the BOM-scoped route', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    const page = await fetchProductionBomTimeline('bom-1', { page: 1 });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0][0]).toBe('/production/boms/bom-1/timeline?page=1');
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('encodes the id and carries no tenant, no resource and no action', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchProductionBomTimeline('bom/1', {});

    const path = getMock.mock.calls[0][0] as string;
    expect(path).toBe('/production/boms/bom%2F1/timeline');
    // None of the three scope inputs is expressible through this client: they are bound
    // server-side, and the backend's DTO would refuse them as query parameters anyway.
    for (const forbidden of ['tenantId', 'resource', 'resourceId', 'action']) {
      expect(path).not.toContain(forbidden);
    }
  });

  it('lets an audit outage REJECT rather than resolving to an empty page', async () => {
    // "Nothing recorded" and "we could not ask" must not be the same outcome for a caller.
    getMock.mockRejectedValue(new Error('503'));

    await expect(fetchProductionBomTimeline('bom-1', {})).rejects.toThrow();
  });
});

