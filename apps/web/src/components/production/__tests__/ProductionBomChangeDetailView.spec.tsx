import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomChangeDetailView } from '../ProductionBomChangeDetailView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import {
  createProductionBomChangeItem,
  decideProductionBomChange,
  deleteProductionBomChangeItem,
  fetchProductionBom,
  fetchProductionBomChangeRequest,
  fetchProductionBomChangeTimeline,
  fetchProductionBomItems,
  submitProductionBomChange,
  updateProductionBomChangeItem,
  type ProductionBomChangeDetail,
  type ProductionBomItem,
} from '@/lib/production-api';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-api', () => ({
  ...jest.requireActual('@/lib/production-api'),
  fetchProductionBomChangeRequest: jest.fn(),
  fetchProductionBom: jest.fn(),
  fetchProductionBomItems: jest.fn(),
  createProductionBomChangeItem: jest.fn(),
  updateProductionBomChangeItem: jest.fn(),
  deleteProductionBomChangeItem: jest.fn(),
  submitProductionBomChange: jest.fn(),
  decideProductionBomChange: jest.fn(),
  fetchProductionBomChangeTimeline: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const loadMock = fetchProductionBomChangeRequest as jest.MockedFunction<
  typeof fetchProductionBomChangeRequest
>;
const bomMock = fetchProductionBom as jest.MockedFunction<typeof fetchProductionBom>;
const searchMock = fetchProductionBomItems as jest.MockedFunction<typeof fetchProductionBomItems>;
const addItemMock = createProductionBomChangeItem as jest.MockedFunction<
  typeof createProductionBomChangeItem
>;
const updateItemMock = updateProductionBomChangeItem as jest.MockedFunction<
  typeof updateProductionBomChangeItem
>;
const deleteItemMock = deleteProductionBomChangeItem as jest.MockedFunction<
  typeof deleteProductionBomChangeItem
>;
const submitMock = submitProductionBomChange as jest.MockedFunction<
  typeof submitProductionBomChange
>;
const decideMock = decideProductionBomChange as jest.MockedFunction<
  typeof decideProductionBomChange
>;
const timelineMock = fetchProductionBomChangeTimeline as jest.MockedFunction<
  typeof fetchProductionBomChangeTimeline
>;

/**
 * PHASE PRODUCTION-BOM-CHANGE: the change-request screen.
 *
 * WHAT THESE SPECS PIN, and why each is falsifiable:
 *  1. THE PERMISSION GATE issues NO request without `production.bom.read`, and the mutating
 *     sections additionally require `production.bom.manage` / `production.bom.approve` — the
 *     SERVER refuses regardless, but a screen that offers an action which can only 403 is a
 *     screen that lies about what it can do.
 *  2. DRAFT IS EDITABLE AND SUBMITTED IS NOT. The search form, the detail form and the submit
 *     button appear only on a DRAFT; a SUBMITTED row renders the same data read-only.
 *  3. A CORRECTION PUTS IT BACK: the same row, with `status: 'DRAFT'`, is editable again —
 *     which is the whole point of correction not being a fifth state.
 *  4. REFUSALS ARE RENDERED FROM THEIR TYPED CODE — «اقلامی جهت تغییر ثبت نشده است!» and
 *     «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید» arrive as Persian sentences.
 *  5. THE DERIVED TOTAL IS SHOWN, NOT SENT: `original + delta`, a null delta counting as `0`,
 *     and NO floor at zero.
 *  6. THE APPROVAL ACTIONS APPEAR ONLY to a `production.bom.approve` holder on a SUBMITTED
 *     row, and each decision goes to its OWN route.
 */

function grant(permissions: string[], isLoading = false) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

function authState(user: { userId?: string } | null = { userId: 'u-approver' }) {
  return {
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const BOM_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const DETAIL_ID = '22222222-2222-4222-8222-222222222222';

function detail(overrides: Partial<ProductionBomChangeDetail> = {}): ProductionBomChangeDetail {
  return {
    id: REQUEST_ID,
    bomId: BOM_ID,
    title: 'تغییر اقلام پروژه الف',
    projectRef: '42',
    productTreeRef: '771',
    requesterUserId: 'u-requester',
    approverUserId: 'u-approver',
    status: 'DRAFT',
    managerOpinion: null,
    notes: 'یادداشت',
    requestDate: '2026-02-01T00:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    items: [],
    ...overrides,
  };
}

function bomItem(overrides: Partial<ProductionBomItem> = {}): ProductionBomItem {
  return {
    id: ITEM_ID,
    bomId: BOM_ID,
    projectRef: '42',
    productTreeRef: '771',
    partName: 'Bracket',
    industryPartName: 'Bracket-S',
    standardPartCode: null,
    partType: 'STRUCTURAL',
    specifications: 'details',
    manufacturer: 'MakerCo',
    material: 'Steel',
    measurementUnit: 'pcs',
    drawingConsumptionCoefficient: 4,
    spareConsumptionCoefficient: 2,
    suggestedSupplier: null,
    suggestedSupplierPrice: null,
    controlPlan: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withItem(overrides: Partial<ProductionBomChangeDetail> = {}): ProductionBomChangeDetail {
  return detail({
    items: [
      {
        id: DETAIL_ID,
        changeRequestId: REQUEST_ID,
        bomItemId: ITEM_ID,
        partName: 'Bracket',
        changeType: 'QUANTITY_CHANGE',
        originalDrawingCoefficient: 4,
        originalSpareCoefficient: 2,
        drawingCoefficientDelta: -6,
        spareCoefficientDelta: 1,
        createdAt: '2026-02-03T00:00:00.000Z',
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
    ],
    ...overrides,
  });
}


beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read', 'production.bom.manage']);
  authMock.mockReturnValue(authState());
  loadMock.mockResolvedValue(detail());
  bomMock.mockResolvedValue({ id: BOM_ID, title: 'اقلام پروژه الف' } as never);
  timelineMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  searchMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  addItemMock.mockResolvedValue(withItem());
  updateItemMock.mockResolvedValue(withItem());
  deleteItemMock.mockResolvedValue({ id: DETAIL_ID });
  submitMock.mockResolvedValue(detail({ status: 'SUBMITTED' }));
  decideMock.mockResolvedValue(detail({ status: 'APPROVED' }));
});

describe('ProductionBomChangeDetailView — permission gate', () => {
  it('refuses without production.bom.read and issues NO request', async () => {
    grant([]);

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByText(/production\.bom\.read/)).toBeInTheDocument();
    expect(loadMock).not.toHaveBeenCalled();
    expect(timelineMock).not.toHaveBeenCalled();
  });
});

describe('ProductionBomChangeDetailView — the header', () => {
  it('renders every documented header field as READ-ONLY text', async () => {
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-title')).toHaveTextContent(
      'تغییر اقلام پروژه الف'
    );
    expect(screen.getByTestId('production-change-project')).toHaveTextContent('42');
    expect(screen.getByTestId('production-change-tree')).toHaveTextContent('771');
    expect(screen.getByTestId('production-change-requester')).toHaveTextContent('u-requester');
    expect(screen.getByTestId('production-change-approver')).toHaveTextContent('u-approver');
    expect(screen.getByTestId('production-change-date')).toBeInTheDocument();
    expect(screen.getByTestId('production-change-opinion')).toHaveTextContent('—');
    expect(screen.getByTestId('production-change-notes')).toHaveTextContent('یادداشت');
    expect(screen.getByTestId('production-bom-status-DRAFT')).toBeInTheDocument();
    // The BOM's own title is shown when it loads, with the raw id as the honest fallback.
    expect(screen.getByTestId('production-change-bom-link')).toHaveTextContent(
      'اقلام پروژه الف'
    );
  });

  it('renders a refusal from its TYPED code when the request cannot be read', async () => {
    loadMock.mockRejectedValue(
      new CoreApiError('not found', 404, {
        error: { code: 'BOM_CHANGE_REQUEST_NOT_FOUND', message: 'Change request not found.' },
      })
    );

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByText('درخواست تغییر مورد نظر یافت نشد.')).toBeInTheDocument();
    // The mapped Persian sentence, never the raw code or the server's English text.
    expect(screen.queryByText('BOM_CHANGE_REQUEST_NOT_FOUND')).toBeNull();
    expect(screen.queryByText('Change request not found.')).toBeNull();
  });
});

describe('ProductionBomChangeDetailView — the selected changes and the derived total', () => {
  it('shows both coefficient PAIRS and derives the total as `original + delta`', async () => {
    loadMock.mockResolvedValue(withItem());

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-item-count')).toHaveTextContent('۱');

    // drawing: 4 + (-6) = -2 — NOT clamped at zero, because the source warned and never
    // blocked (S8). spare: 2 + 1 = 3.
    expect(
      screen.getByTestId(`production-change-item-total-drawing-${DETAIL_ID}`)
    ).toHaveTextContent('-۲');
    expect(
      screen.getByTestId(`production-change-item-total-spare-${DETAIL_ID}`)
    ).toHaveTextContent('۳');
    expect(screen.getByTestId(`production-change-item-type-${DETAIL_ID}`)).toHaveTextContent(
      'تغییر موجودی'
    );
  });

  it('renders the empty state when nothing has been selected yet', async () => {
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-items-empty')).toBeInTheDocument();
  });

  it('renders the section read-only when the row is no longer a DRAFT', async () => {
    loadMock.mockResolvedValue(withItem({ status: 'SUBMITTED' }));

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-item-row')).toBeInTheDocument();
    // No detail mutations, no search, no submit — the row is frozen (S10).
    expect(screen.queryByTestId('production-change-detail-submit')).toBeNull();
    expect(screen.queryByTestId(`production-change-item-delete-${DETAIL_ID}`)).toBeNull();
    expect(screen.queryByTestId(`production-change-item-edit-${DETAIL_ID}`)).toBeNull();
    expect(screen.queryByTestId('production-change-search')).toBeNull();
    expect(screen.queryByTestId('production-change-detail-form')).toBeNull();
    expect(screen.queryByTestId('production-change-submit')).toBeNull();
  });
});

describe('ProductionBomChangeDetailView — the timeline', () => {
  it('renders the history section for a reader who holds production.bom.read', async () => {
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-timeline')).toBeInTheDocument();
    expect(timelineMock).toHaveBeenCalledWith(REQUEST_ID, {
      page: 1,
      pageSize: 20,
    });
  });
});


describe('ProductionBomChangeDetailView — searching and adding a detail', () => {
  const searchResponse = { items: [bomItem()], total: 1, page: 1, pageSize: 20 };

  async function searchFor(keyword: string) {
    searchMock.mockResolvedValue(searchResponse);
    await userEvent.type(
      screen.getByLabelText('نام قطعه'),
      keyword
    );
    await userEvent.click(screen.getByTestId('production-change-item-search-submit'));
    expect(await screen.findByTestId('production-change-search-results')).toBeInTheDocument();
  }

  it('searches THIS REQUEST\u2019S BOM server-side, never an arbitrary one', async () => {
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-search');

    await searchFor('Bracket');

    // The scope is the request's own `bomId`, read from the row — not from a field the
    // screen could be pointed at.
    expect(searchMock).toHaveBeenCalledWith(BOM_ID, {
      search: 'Bracket',
      page: 1,
      pageSize: 20,
    });
    expect(screen.getByText('Bracket')).toBeInTheDocument();
    expect(screen.getByText('Bracket-S')).toBeInTheDocument();
    // `standardPartCode` is RESERVED and read-only: it renders `—` INSIDE THE RESULT ROW,
    // and there is no control for it — the deferred code is visible, not hidden.
    const results = screen.getByTestId('production-change-search-results');
    expect(within(results).getByText('Bracket')).toBeInTheDocument();
    expect(within(results).getByText('—')).toBeInTheDocument();
    expect(within(results).queryByRole('textbox')).toBeNull();
  });

  it('picks a row, then adds the detail with BOTH deltas the operator stated', async () => {
    loadMock.mockResolvedValue(withItem());
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-search');

    await searchFor('Bracket');
    await userEvent.click(screen.getByTestId(`production-change-pick-${ITEM_ID}`));

    expect(screen.getByTestId('production-change-form-target')).toHaveTextContent(
      'Bracket'
    );

    await userEvent.type(screen.getByLabelText(/در نقشه/), '-6');
    await userEvent.type(screen.getByLabelText(/یدکی\/تست/), '1');
    await userEvent.click(screen.getByTestId('production-change-detail-submit'));

    await waitFor(() => expect(addItemMock).toHaveBeenCalledTimes(1));
    expect(addItemMock).toHaveBeenCalledWith(REQUEST_ID, {
      bomItemId: ITEM_ID,
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: -6,
      spareCoefficientDelta: 1,
    });
    // The screen never sends an original or a total: both are the SERVER's to derive.
    const payload = addItemMock.mock.calls[0][1];
    expect(payload).not.toHaveProperty('originalDrawingCoefficient');
    expect(payload).not.toHaveProperty('originalSpareCoefficient');
    expect(payload).not.toHaveProperty('total');
  });

  it('disables both delta inputs for «غیر فعال سازی», where the source checks nothing', async () => {
    loadMock.mockResolvedValue(withItem());
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-search');

    await searchFor('Bracket');
    await userEvent.click(screen.getByTestId(`production-change-pick-${ITEM_ID}`));
    await userEvent.click(screen.getByTestId('production-change-type-DEACTIVATE'));

    expect(screen.getByLabelText(/در نقشه/)).toBeDisabled();
    expect(screen.getByLabelText(/یدکی\/تست/)).toBeDisabled();
  });

  it('refuses a QUANTITY_CHANGE with NEITHER delta, by the source\u2019s own sentence', async () => {
    addItemMock.mockRejectedValue(
      new CoreApiError('bad request', 400, {
        error: {
          code: 'BOM_CHANGE_ITEM_DELTA_REQUIRED',
          message: 'At least one of the drawing or spare consumption-coefficient deltas must be stated.',
        },
      })
    );
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-search');

    await searchFor('Bracket');
    await userEvent.click(screen.getByTestId(`production-change-pick-${ITEM_ID}`));
    await userEvent.click(screen.getByTestId('production-change-detail-submit'));

    expect(await screen.findByTestId('production-change-action-error')).toHaveTextContent(
      'حداقل یکی از دو ضریب مصرف'
    );
    expect(screen.queryByText(/At least one of the drawing/)).toBeNull();
  });

  it('prevents a DUPLICATE detail and reports it with the legacy sentence', async () => {
    addItemMock.mockRejectedValue(
      new CoreApiError('conflict', 409, {
        error: {
          code: 'BOM_CHANGE_ITEM_DUPLICATE',
          message: 'This item is already detailed in this change request.',
        },
      })
    );
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-search');

    await searchFor('Bracket');
    await userEvent.click(screen.getByTestId(`production-change-pick-${ITEM_ID}`));
    await userEvent.click(screen.getByTestId('production-change-detail-submit'));

    expect(await screen.findByTestId('production-change-action-error')).toHaveTextContent(
      'شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید'
    );
    expect(screen.queryByText(/already detailed in this change request/)).toBeNull();
  });

  it('removes a detail through its own route', async () => {
    loadMock.mockResolvedValue(withItem());
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId(`production-change-item-delete-${DETAIL_ID}`);

    await userEvent.click(screen.getByTestId(`production-change-item-delete-${DETAIL_ID}`));

    await waitFor(() => expect(deleteItemMock).toHaveBeenCalledWith(REQUEST_ID, DETAIL_ID));
  });

  it('edits an existing detail, prefilled, and PATCHes only the stated field', async () => {
    loadMock.mockResolvedValue(withItem());
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId(`production-change-item-edit-${DETAIL_ID}`);

    await userEvent.click(screen.getByTestId(`production-change-item-edit-${DETAIL_ID}`));

    // The form is prefilled from the STORED row, and the operator is in edit mode rather
    // than adding a second detail for the same item.
    expect(screen.getByTestId('production-change-form-target')).toHaveTextContent(
      'در حال ویرایش'
    );
    expect(screen.getByLabelText(/در نقشه/)).toHaveValue(-6);

    // Clearing ONE delta of a QUANTITY_CHANGE that still has the spare one stated is a legal
    // edit; the SERVER re-checks the effective pair, so the screen only has to send it.
    await userEvent.clear(screen.getByLabelText(/در نقشه/));
    await userEvent.click(screen.getByTestId('production-change-detail-submit'));

    await waitFor(() => expect(updateItemMock).toHaveBeenCalledTimes(1));
    expect(updateItemMock).toHaveBeenCalledWith(REQUEST_ID, DETAIL_ID, {
      changeType: 'QUANTITY_CHANGE',
      drawingCoefficientDelta: null,
      spareCoefficientDelta: 1,
    });
    expect(addItemMock).not.toHaveBeenCalled();
  });
});


describe('ProductionBomChangeDetailView — submit, correction and the freeze', () => {
  it('submits a DRAFT that already holds a detail', async () => {
    loadMock.mockResolvedValue(withItem());
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-submit');

    await userEvent.click(screen.getByTestId('production-change-submit'));

    await waitFor(() => expect(submitMock).toHaveBeenCalledWith(REQUEST_ID));
  });

  it('surfaces an EMPTY request as the source\u2019s own sentence', async () => {
    submitMock.mockRejectedValue(
      new CoreApiError('bad request', 400, {
        error: {
          code: 'BOM_CHANGE_REQUEST_ITEMS_REQUIRED',
          message: 'A change request must contain at least one item before it can be submitted.',
        },
      })
    );
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    await screen.findByTestId('production-change-submit');

    await userEvent.click(screen.getByTestId('production-change-submit'));

    expect(await screen.findByTestId('production-change-action-error')).toHaveTextContent(
      'اقلامی جهت تغییر ثبت نشده است!'
    );
    expect(
      screen.queryByText(/must contain at least one item before it can be submitted/)
    ).toBeNull();
  });

  it('makes the row editable again after a correction — no separate unfreeze step', async () => {
    loadMock.mockResolvedValue(
      withItem({ status: 'DRAFT', managerOpinion: 'NEEDS_CORRECTION' })
    );
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-search')).toBeInTheDocument();
    expect(screen.getByTestId('production-change-detail-form')).toBeInTheDocument();
    expect(screen.getByTestId('production-change-submit')).toBeInTheDocument();
    // The decision is still on the row, so "returned for correction" is distinguishable from
    // "never submitted".
    expect(screen.getByTestId('production-change-opinion')).toHaveTextContent('نیاز به اصلاح');
  });
});

describe('ProductionBomChangeDetailView — the approval section', () => {
  const READ_AND_APPROVE = ['production.bom.read', 'production.bom.approve'];

  it('shows NO decision action on a DRAFT, even to an approver', async () => {
    grant(READ_AND_APPROVE);
    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-approval')).toBeInTheDocument();
    expect(screen.queryByTestId('production-change-approve')).toBeNull();
    expect(screen.queryByTestId('production-change-reject')).toBeNull();
    expect(screen.queryByTestId('production-change-correction')).toBeNull();
  });

  it('shows all three decisions on a SUBMITTED row, but only to an approver', async () => {
    grant(READ_AND_APPROVE);
    loadMock.mockResolvedValue(withItem({ status: 'SUBMITTED' }));

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-approve')).toBeInTheDocument();
    expect(screen.getByTestId('production-change-reject')).toBeInTheDocument();
    expect(screen.getByTestId('production-change-correction')).toBeInTheDocument();
    // …and the frozen state still hides every mutation.
    expect(screen.queryByTestId('production-change-detail-form')).toBeNull();
  });

  it('hides every decision from a reader without production.bom.approve', async () => {
    grant(['production.bom.read', 'production.bom.manage']);
    loadMock.mockResolvedValue(withItem({ status: 'SUBMITTED' }));

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    expect(await screen.findByTestId('production-change-approval')).toBeInTheDocument();
    expect(screen.queryByTestId('production-change-approve')).toBeNull();
    expect(screen.queryByTestId('production-change-reject')).toBeNull();
    expect(screen.queryByTestId('production-change-correction')).toBeNull();
  });

  it('sends each decision to its OWN route', async () => {
    grant(READ_AND_APPROVE);
    loadMock.mockResolvedValue(withItem({ status: 'SUBMITTED' }));
    decideMock.mockResolvedValue(withItem({ status: 'APPROVED', managerOpinion: 'APPROVED' }));

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);
    const section = await screen.findByTestId('production-change-approval');

    await userEvent.click(within(section).getByTestId('production-change-approve'));

    await waitFor(() =>
      expect(decideMock).toHaveBeenCalledWith(REQUEST_ID, 'approve')
    );
  });

  it('states plainly that approving does NOT apply anything to the BOM', async () => {
    grant(READ_AND_APPROVE);
    loadMock.mockResolvedValue(withItem({ status: 'SUBMITTED' }));

    render(<ProductionBomChangeDetailView requestId={REQUEST_ID} />);

    // `DEFERRED / CONTRACT NOT ESTABLISHED`, surfaced so an operator is not told the BOM
    // has already changed when it has not.
    expect(await screen.findByTestId('production-change-apply-note')).toBeInTheDocument();
  });
});

