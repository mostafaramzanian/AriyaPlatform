import {
  PRODUCTION_MAX_PAGE_SIZE,
  buildProductionBomChangeQuery,
  createProductionBomChange,
  createProductionBomChangeItem,
  decideProductionBomChange,
  deleteProductionBomChangeItem,
  fetchProductionBomChangeRequest,
  fetchProductionBomChangeRequests,
  fetchProductionBomChangeTimeline,
  submitProductionBomChange,
  updateProductionBomChange,
  updateProductionBomChangeItem,
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
 * PHASE PRODUCTION-BOM-CHANGE: the change-request client's wire contract.
 *
 * WHAT THESE SPECS PIN: the EXACT paths (so a typo cannot ship), the query serialization
 * (Persian encoded, blanks dropped, `pageSize` capped by the declared constant), the
 * `tenantId`-free and requester-free request shapes (both are server-derived), and — the
 * phase's own rule — that NEITHER an `original*` coefficient NOR a `total` is ever sent:
 * the snapshot is taken from the item server-side and the total is a display derivation.
 *
 * Nothing here calls the network: `core-http` is mocked and every function runs untouched.
 */
describe('production-change-api — query serialization', () => {
  it('builds an empty query for a bare read', () => {
    expect(buildProductionBomChangeQuery()).toBe('');
    expect(buildProductionBomChangeQuery({})).toBe('');
  });

  it('serializes the exact supported filters, in a stable order', () => {
    expect(
      buildProductionBomChangeQuery({
        page: 2,
        pageSize: 20,
        bomId: 'bom-1',
        projectRef: '42',
        status: 'SUBMITTED',
        search: 'تغییر',
      })
    ).toBe(
      `?page=2&pageSize=20&bomId=bom-1&projectRef=42&status=SUBMITTED&search=${encodeURIComponent(
        'تغییر'
      )}`
    );
  });

  it('drops a blank filter instead of sending an empty one', () => {
    expect(buildProductionBomChangeQuery({ search: '   ', projectRef: '' })).toBe('');
  });

  it('caps pageSize with the constant the API declares', () => {
    expect(buildProductionBomChangeQuery({ pageSize: 5000 })).toBe(
      `?pageSize=${PRODUCTION_MAX_PAGE_SIZE}`
    );
    expect(PRODUCTION_MAX_PAGE_SIZE).toBe(100);
  });

  it('never sends a tenant (the actor is resolved server-side)', () => {
    const query = buildProductionBomChangeQuery({ page: 1, search: 'x', status: 'DRAFT' });
    expect(query).not.toMatch(/tenant/i);
  });
});

describe('production-change-api — the register and the detail', () => {
  const LIST = { items: [], total: 0, page: 1, pageSize: 20 };

  it('reads the register from the route the controller owns', async () => {
    getMock.mockResolvedValue(LIST);

    await fetchProductionBomChangeRequests({ page: 1, pageSize: 5 });

    expect(getMock).toHaveBeenCalledWith('/production/bom-change-requests?page=1&pageSize=5');
  });

  it('reads one request by its opaque id, encoded', async () => {
    getMock.mockResolvedValue({ id: 'c-1' });

    await fetchProductionBomChangeRequest('c/1');

    expect(getMock).toHaveBeenCalledWith('/production/bom-change-requests/c%2F1');
  });

  it('carries no tenant, no resource and no action on any read', async () => {
    getMock.mockResolvedValue(LIST);

    await fetchProductionBomChangeRequests({});
    await fetchProductionBomChangeRequest('c-1');

    for (const call of getMock.mock.calls) {
      const path = call[0] as string;
      for (const forbidden of ['tenantId', 'resource', 'resourceId', 'action']) {
        expect({ path, forbidden, present: path.includes(forbidden) }).toEqual({
          path,
          forbidden,
          present: false,
        });
      }
    }
  });
});

describe('production-change-api — the mutations', () => {
  const DETAIL = { id: 'c-1', items: [] };

  it('creates with ONLY the four caller-owned fields', async () => {
    postMock.mockResolvedValue(DETAIL);

    await createProductionBomChange({
      bomId: 'bom-1',
      title: 'تغییر اقلام پروژه الف',
      approverUserId: 'user-approver',
      notes: 'note',
    });

    expect(postMock).toHaveBeenCalledWith('/production/bom-change-requests', {
      bomId: 'bom-1',
      title: 'تغییر اقلام پروژه الف',
      approverUserId: 'user-approver',
      notes: 'note',
    });
    // The requester, the project and the product tree are all read server-side.
    const payload = postMock.mock.calls[0][1] as Record<string, unknown>;
    for (const forbidden of ['tenantId', 'requesterUserId', 'projectRef', 'productTreeRef']) {
      expect({ forbidden, present: forbidden in payload }).toEqual({ forbidden, present: false });
    }
  });

  it('patches the header through its own verb', async () => {
    patchMock.mockResolvedValue(DETAIL);

    await updateProductionBomChange('c-1', { title: 'v2', approverUserId: 'user-b' });

    expect(patchMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1', {
      title: 'v2',
      approverUserId: 'user-b',
    });
  });

  it('adds a detail with NO original coefficient and NO total', async () => {
    postMock.mockResolvedValue(DETAIL);

    await createProductionBomChangeItem('c-1', {
      bomItemId: 'item-1',
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: -1,
      spareCoefficientDelta: null,
    });

    expect(postMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1/items', {
      bomItemId: 'item-1',
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: -1,
      spareCoefficientDelta: null,
    });
    const payload = postMock.mock.calls[0][1] as Record<string, unknown>;
    for (const forbidden of [
      'originalDrawingCoefficient',
      'originalSpareCoefficient',
      'total',
      'changeRequestId',
      'tenantId',
    ]) {
      expect({ forbidden, present: forbidden in payload }).toEqual({ forbidden, present: false });
    }
  });

  it('edits a detail through its own verb, so an explicit `null` CLEARS a delta', async () => {
    patchMock.mockResolvedValue(DETAIL);

    await updateProductionBomChangeItem('c-1', 'd-1', { drawingCoefficientDelta: null });

    expect(patchMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1/items/d-1', {
      drawingCoefficientDelta: null,
    });
  });

  it('deletes a detail and returns the removed id', async () => {
    deleteMock.mockResolvedValue({ id: 'd-1' });

    const removed = await deleteProductionBomChangeItem('c-1', 'd-1');

    expect(deleteMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1/items/d-1');
    expect(removed).toEqual({ id: 'd-1' });
  });

  it('submits with NO body — the approver is the row\u2019s own frozen snapshot', async () => {
    postMock.mockResolvedValue(DETAIL);

    await submitProductionBomChange('c-1');

    expect(postMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1/submit');
    expect(postMock.mock.calls[0]).toHaveLength(1);
  });

  it('routes each decision to its OWN path, so no payload can rewrite the opinion', async () => {
    postMock.mockResolvedValue(DETAIL);

    await decideProductionBomChange('c-1', 'approve');
    await decideProductionBomChange('c-1', 'reject', { notes: 'no' });
    await decideProductionBomChange('c-1', 'request-correction');

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      '/production/bom-change-requests/c-1/approve',
      '/production/bom-change-requests/c-1/reject',
      '/production/bom-change-requests/c-1/request-correction',
    ]);
    // Only `notes` is ever sent, and only when the caller states one.
    expect(postMock.mock.calls[0][1]).toEqual({});
    expect(postMock.mock.calls[1][1]).toEqual({ notes: 'no' });
    expect(postMock.mock.calls[2][1]).toEqual({});
    for (const call of postMock.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('opinion');
      expect(payload).not.toHaveProperty('status');
    }
  });
});

describe('production-change-api — the timeline', () => {
  it('reads from the change-request-scoped route, with only a page window', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchProductionBomChangeTimeline('c-1', { page: 2, pageSize: 30 });

    expect(getMock).toHaveBeenCalledWith(
      '/production/bom-change-requests/c-1/timeline?page=2&pageSize=30'
    );
  });

  it('sends ONLY a page window — never a resource, a resourceId or an action', async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    await fetchProductionBomChangeTimeline('c-1', {});

    expect(getMock).toHaveBeenCalledWith('/production/bom-change-requests/c-1/timeline');
    for (const forbidden of ['resource', 'resourceId', 'action', 'tenantId']) {
      expect((getMock.mock.calls[0][0] as string).includes(forbidden)).toBe(false);
    }
  });

  it('lets an audit outage REJECT rather than resolving to an empty page', async () => {
    // "Nothing recorded" and "we could not ask" must not be the same outcome for a caller.
    getMock.mockRejectedValue(new Error('503'));

    await expect(fetchProductionBomChangeTimeline('c-1', {})).rejects.toThrow();
  });
});

