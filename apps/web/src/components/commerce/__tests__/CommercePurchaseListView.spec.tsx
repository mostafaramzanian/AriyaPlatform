import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommercePurchaseListView } from '../CommercePurchaseListView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchCommercePurchaseDocuments, type CommercePurchaseQuery } from '@/lib/commerce-api';
import { purchaseDocument, purchasePage } from './commerce-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommercePurchaseDocuments: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchCommercePurchaseDocuments as jest.MockedFunction<
  typeof fetchCommercePurchaseDocuments
>;

/**
 * PHASE UI-1: the purchase register (`/admin/commerce/purchases`).
 *
 * WHAT THESE SPECS ARE FOR: the register must present exactly what the route supports —
 * server paging with the server's own total, the two server-side filters, real table
 * semantics, and a mobile rendering that is a deliberate alternative rather than a
 * squashed table. Rows are deliberately NOT links (the detail page is UI-2), and the
 * specs pin that absence so a later phase adds it consciously.
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

function authState(user: { userId?: string } | null = { userId: 'u-1' }) {
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

/** Echoes the requested window back, so a page change is visible in the response too. */
function answerWith(total: number, items = [purchaseDocument()]) {
  fetchMock.mockImplementation(async (query: CommercePurchaseQuery = {}) =>
    purchasePage(items, total, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    })
  );
}

const money = (value: number) =>
  new Intl.NumberFormat('fa-IR', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(value);

beforeEach(() => {
  jest.clearAllMocks();
  grant(['commerce.read']);
  authMock.mockReturnValue(authState());
  answerWith(1);
});

describe('CommercePurchaseListView', () => {
  it('refuses without commerce.read and issues NO request', async () => {
    grant([]);

    render(<CommercePurchaseListView />);

    expect(await screen.findByText(/commerce\.read/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a structured loading state before the first page arrives', async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));

    render(<CommercePurchaseListView />);

    expect(await screen.findByRole('heading', { name: 'درخواست‌های خرید' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a real table with real headers and the row the server returned', async () => {
    render(<CommercePurchaseListView />);

    const table = await screen.findByRole('table');
    expect(table).toBeInTheDocument();

    expect(screen.getByRole('columnheader', { name: 'شمارهٔ سند' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'وضعیت' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'درخواست‌کننده' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'جمع کل' })).toBeInTheDocument();

    // The mobile cards render the same facts, so the table's cells are asserted WITHIN it.
    const cells = within(table);
    const numberChip = cells.getByText('PR-1405-0001');
    // Mixed identifiers are isolated: the document number is an LTR island in RTL text.
    expect(numberChip).toHaveAttribute('dir', 'ltr');
    expect(cells.getByText('سارا محمدی')).toBeInTheDocument();
    expect(cells.getByText('۱')).toBeInTheDocument(); // one line, Persian digits
    expect(cells.getByText(`${money(1000)} IRR`)).toBeInTheDocument();
    expect(cells.getByText('پیش‌نویس')).toBeInTheDocument();

    // UI-2: the row's document number is a real link into the detail route — the detail
    // page exists now, so a row that opened nothing would be the broken promise instead.
    const rowLink = within(table).getByRole('link', { name: 'مشاهدهٔ سند PR-1405-0001' });
    expect(rowLink).toHaveAttribute('href', '/admin/commerce/purchases/doc-1');
  });

  it('offers the create CTA to commerce.manage holders, and hides it without the grant', async () => {
    render(<CommercePurchaseListView />);
    await screen.findByRole('table');

    // Default grant here is commerce.read only.
    expect(screen.queryByTestId('commerce-purchase-create-cta')).not.toBeInTheDocument();
  });

  it('renders the create CTA with the real route for a commerce.manage holder', async () => {
    grant(['commerce.read', 'commerce.manage']);

    render(<CommercePurchaseListView />);

    expect(await screen.findByTestId('commerce-purchase-create-cta')).toHaveAttribute(
      'href',
      '/admin/commerce/purchases/new'
    );
  });

  it('renders a dense alternative for small screens instead of squashing the table', async () => {
    render(<CommercePurchaseListView />);

    await screen.findByRole('table');
    expect(screen.getByTestId('commerce-purchase-card-PR-1405-0001')).toBeInTheDocument();
  });

  it('drives pagination from the server total and the requested page', async () => {
    answerWith(45);
    const user = userEvent.setup();

    render(<CommercePurchaseListView />);
    await screen.findByRole('table');

    // 45 documents at 20 per page — the pager repeats the SERVER's arithmetic.
    expect(screen.getByTestId('commerce-page-status')).toHaveTextContent('صفحهٔ ۱ از ۳');
    expect(screen.getByTestId('commerce-page-prev')).toBeDisabled();

    await user.click(screen.getByTestId('commerce-page-next'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith({ page: 2, pageSize: 20 }));
    expect(await screen.findByText('صفحهٔ ۲ از ۳')).toBeInTheDocument();
  });

  it('applies the server-side status filter and resets to page one', async () => {
    answerWith(30);
    const user = userEvent.setup();

    render(<CommercePurchaseListView />);
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'SUBMITTED');

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: 'SUBMITTED' })
    );
    expect(screen.getByTestId('commerce-clear-filters')).toBeInTheDocument();
  });

  it('submits the search as the register\u2019s own search parameter', async () => {
    const user = userEvent.setup();

    render(<CommercePurchaseListView />);
    await screen.findByRole('table');

    await user.type(screen.getByLabelText('جستجو بر اساس شمارهٔ سند'), 'PR-1405-0002');
    await user.click(screen.getByRole('button', { name: 'جستجو' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({ page: 1, pageSize: 20, search: 'PR-1405-0002' })
    );
  });

  it('states WHICH emptiness the register is in — untouched vs filtered', async () => {
    fetchMock.mockImplementation(async () => purchasePage([], 0));
    const user = userEvent.setup();

    render(<CommercePurchaseListView />);

    expect(await screen.findByText('هنوز درخواست خریدی ثبت نشده است.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('وضعیت'), 'APPROVED');

    expect(await screen.findByText('درخواستی با این فیلترها یافت نشد.')).toBeInTheDocument();
  });

  it('renders a dash for a requester whose profile did not resolve — never a fabricated name', async () => {
    answerWith(1, [purchaseDocument({ requester: { id: 'u-9', profile: null } })]);

    render(<CommercePurchaseListView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('—')).toBeInTheDocument();
  });

  it('keeps the filters in place across a failure and retries the same request', async () => {
    answerWith(5);
    const user = userEvent.setup();

    render(<CommercePurchaseListView />);
    await screen.findByRole('table');

    await user.type(screen.getByLabelText('جستجو بر اساس شمارهٔ سند'), 'PR-9');
    fetchMock.mockRejectedValueOnce(new Error('شبکه در دسترس نیست'));
    await user.click(screen.getByRole('button', { name: 'جستجو' }));

    expect(await screen.findByText('شبکه در دسترس نیست')).toBeInTheDocument();

    // The retry re-runs the SAME query — the typed filter was not lost to the failure.
    answerWith(5);
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({ page: 1, pageSize: 20, search: 'PR-9' })
    );
  });
});
