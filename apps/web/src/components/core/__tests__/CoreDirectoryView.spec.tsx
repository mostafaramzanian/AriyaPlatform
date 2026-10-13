import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreDirectoryView } from '../CoreDirectoryView';
import { CoreApiError } from '@/lib/core-http';
import { fetchDirectory, type DirectoryMember } from '@/lib/directory-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/directory',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Every pure helper stays real.
jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectory: jest.fn(),
}));

const fetchDirectoryMock = fetchDirectory as jest.MockedFunction<typeof fetchDirectory>;

function member(overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    id: 'u1',
    firstName: 'بهار',
    lastName: 'نوری',
    email: 'bahar@example.com',
    phone: '021-2001',
    avatarUrl: null,
    status: 'EMPLOYEE',
    department: 'مالی',
    jobTitle: 'حسابدار',
    extension: '201',
    managerId: 'mgr-1',
    manager: {
      id: 'mgr-1',
      firstName: 'آرش',
      lastName: 'کریمی',
      avatarUrl: null,
      jobTitle: 'مدیر مالی',
    },
    ...overrides,
  };
}

describe('CoreDirectoryView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state before the first page resolves', () => {
    fetchDirectoryMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreDirectoryView />);

    expect(screen.getByTestId('directory-skeleton')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری فهرست همکاران...')).toBeInTheDocument();
  });

  it('renders members and their organization attributes', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);

    expect(await screen.findAllByText('بهار نوری')).not.toHaveLength(0);
    expect(screen.getAllByText('bahar@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('حسابدار').length).toBeGreaterThan(0);
    expect(screen.getAllByText('201').length).toBeGreaterThan(0);
    expect(screen.getAllByText('آرش کریمی').length).toBeGreaterThan(0);
  });

  it('requests the first page with the default limit and no cursor', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);

    await waitFor(() => expect(fetchDirectoryMock).toHaveBeenCalled());
    expect(fetchDirectoryMock).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 20,
      q: '',
      department: '',
      jobTitle: '',
    });
  });

  it('never renders a sensitive field even if the API returns one', async () => {
    fetchDirectoryMock.mockResolvedValue({
      items: [member({ passwordHash: 'leaked-hash', tenantId: 'tenant-a' } as never)],
      hasMore: false,
    });

    render(<CoreDirectoryView />);

    await screen.findAllByText('بهار نوری');
    expect(screen.queryByText('leaked-hash')).not.toBeInTheDocument();
    expect(screen.queryByText('tenant-a')).not.toBeInTheDocument();
  });

  it('renders the empty state when the tenant has no members', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreDirectoryView />);

    expect(
      await screen.findByText('هنوز همکاری در دفترچه سازمانی ثبت نشده است.'),
    ).toBeInTheDocument();
  });

  it('shows a retryable error and re-fetches on retry', async () => {
    fetchDirectoryMock.mockRejectedValueOnce(new CoreApiError('خطای شبکه', 500));

    render(<CoreDirectoryView />);

    expect(await screen.findByText('خطای شبکه')).toBeInTheDocument();

    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findAllByText('بهار نوری')).not.toHaveLength(0);
  });

  it('renders the forbidden state on 403 without a retry affordance', async () => {
    fetchDirectoryMock.mockRejectedValue(new CoreApiError('دسترسی ندارید', 403));

    render(<CoreDirectoryView />);

    expect(await screen.findByText('شما به دفترچه سازمانی دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('debounces search input into a single request', async () => {
    jest.useFakeTimers();
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<CoreDirectoryView />);

    await user.type(screen.getByLabelText('جست‌وجو'), 'بهار');
    // Only the initial unfiltered load so far — the debounce has not elapsed.
    expect(fetchDirectoryMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'بهار', cursor: undefined }),
      ),
    );
    expect(fetchDirectoryMock).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('filters by department using only values present in the page', async () => {
    fetchDirectoryMock.mockResolvedValue({
      items: [member(), member({ id: 'u2', department: 'فروش', jobTitle: 'کارشناس فروش' })],
      hasMore: false,
    });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    const select = screen.getByLabelText('واحد');
    expect(select).toHaveTextContent('مالی');
    expect(select).toHaveTextContent('فروش');

    await userEvent.selectOptions(select, 'فروش');

    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ department: 'فروش' }),
      ),
    );
  });

  it('resets to the first page when a filter changes', async () => {
    fetchDirectoryMock.mockResolvedValue({
      items: [member(), member({ id: 'u2', department: 'فروش' })],
      hasMore: true,
    });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));
    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'u2' })),
    );

    await userEvent.selectOptions(screen.getByLabelText('واحد'), 'فروش');

    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: undefined, department: 'فروش' }),
      ),
    );
  });

  it('pages forward with the last item id as the cursor and back again', async () => {
    fetchDirectoryMock.mockResolvedValue({
      items: [member(), member({ id: 'u2' })],
      hasMore: true,
    });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));
    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'u2' })),
    );

    await userEvent.click(screen.getByRole('button', { name: 'صفحه قبل' }));
    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: undefined }),
      ),
    );
  });

  it('disables the next control on the last page', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    // No pagination controls at all when there is a single page.
    expect(screen.queryByRole('button', { name: 'صفحه بعد' })).not.toBeInTheDocument();
  });

  it('shows a filtered-empty message distinct from the unfiltered one', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreDirectoryView />);
    await screen.findByText('هنوز همکاری در دفترچه سازمانی ثبت نشده است.');

    await userEvent.type(screen.getByLabelText('جست‌وجو'), 'ناموجود');

    // The 350ms debounce plus a re-fetch can exceed the default 1s poll window
    // on a loaded machine, so the wait is given explicit headroom.
    expect(
      await screen.findByText('همکاری با این جست‌وجو یا فیلترها یافت نشد.', undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
  });

  it('clears all filters via the reset control', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    await userEvent.selectOptions(screen.getByLabelText('واحد'), 'مالی');
    await userEvent.click(await screen.findByRole('button', { name: 'حذف فیلترها' }));

    await waitFor(() =>
      expect(fetchDirectoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: '', department: '', jobTitle: '' }),
      ),
    );
  });

  it('renders both the desktop table and the mobile card list, each hidden at the other breakpoint', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);
    await screen.findAllByText('بهار نوری');

    // The table is lg-only and the cards are below-lg, so exactly one is visible
    // at any viewport and neither needs horizontal scrolling.
    expect(screen.getByTestId('directory-table').className).toContain('hidden');
    expect(screen.getByTestId('directory-table').className).toContain('lg:block');
    expect(screen.getByTestId('directory-cards').className).toContain('lg:hidden');
  });

  it('links each member to its detail route', async () => {
    fetchDirectoryMock.mockResolvedValue({ items: [member()], hasMore: false });

    render(<CoreDirectoryView />);

    const link = (await screen.findAllByRole('link', { name: /مشاهده پروفایل/ }))[0];
    expect(link).toHaveAttribute('href', '/admin/directory/u1');
  });
});
