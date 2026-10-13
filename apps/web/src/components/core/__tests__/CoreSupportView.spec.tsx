import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreSupportView } from '../CoreSupportView';
import { CoreApiError } from '@/lib/core-http';
import { getTicketByTrackingNumber, listTickets, type Ticket } from '@/lib/support-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/support',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Every pure helper stays real.
jest.mock('@/lib/support-api', () => ({
  ...jest.requireActual('@/lib/support-api'),
  listTickets: jest.fn(),
  getTicketByTrackingNumber: jest.fn(),
}));

const listMock = listTickets as jest.MockedFunction<typeof listTickets>;
const trackingMock = getTicketByTrackingNumber as jest.MockedFunction<
  typeof getTicketByTrackingNumber
>;

function person(id: string) {
  return { id, firstName: 'بهار', lastName: 'نوری', avatarUrl: null, jobTitle: null };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    trackingNumber: 'TK-ABCDEFGHJK',
    type: 'SUPPORT',
    priority: 'NORMAL',
    status: 'NEW',
    subject: 'موضوع تیکت',
    body: 'متن تیکت',
    category: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    requester: person('u1'),
    assignee: null,
    canManage: false,
    availableTransitions: [],
    ...overrides,
  };
}

describe('CoreSupportView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state before the first page resolves', () => {
    listMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreSupportView />);

    expect(screen.getByTestId('tickets-skeleton')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری تیکت‌ها...')).toBeInTheDocument();
  });

  it('requests the first page with the default limit and no filters', async () => {
    listMock.mockResolvedValue({ items: [ticket()], hasMore: false });

    render(<CoreSupportView />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(listMock).toHaveBeenCalledWith({ cursor: undefined, limit: 20 });
  });

  it('never sends a requester or tenant identifier', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreSupportView />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const args = listMock.mock.calls[0][0] ?? {};
    expect(args).not.toHaveProperty('requesterId');
    expect(args).not.toHaveProperty('userId');
    expect(args).not.toHaveProperty('tenantId');
  });

  it('renders the ticket row with its tracking number and status', async () => {
    listMock.mockResolvedValue({ items: [ticket()], hasMore: false });

    render(<CoreSupportView />);

    expect(await screen.findByText('موضوع تیکت')).toBeInTheDocument();
    expect(screen.getByText('TK-ABCDEFGHJK')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-status')).toHaveTextContent('جدید');
  });

  it('renders an empty state rather than placeholder rows', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreSupportView />);

    expect(await screen.findByText('تیکتی برای نمایش وجود ندارد.')).toBeInTheDocument();
    expect(screen.queryByTestId('tickets-list')).not.toBeInTheDocument();
  });

  it('renders a forbidden state on 403 instead of an error with retry', async () => {
    listMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreSupportView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('دسترسی ندارید');
  });

  it('renders an error state with retry on a server failure', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    listMock.mockResolvedValueOnce({ items: [ticket()], hasMore: false });

    render(<CoreSupportView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('خطای سرور');

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByText('موضوع تیکت')).toBeInTheDocument();
  });

  it('re-requests with the status filter and resets the cursor', async () => {
    listMock.mockResolvedValue({ items: [ticket()], hasMore: false });

    render(<CoreSupportView />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'حل‌شده' }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 20,
        status: 'RESOLVED',
      }),
    );
  });

  it('pages forward using the last id as the cursor', async () => {
    listMock.mockResolvedValueOnce({
      items: [ticket({ id: 't1' }), ticket({ id: 't2' })],
      hasMore: true,
    });
    listMock.mockResolvedValueOnce({ items: [ticket({ id: 't3' })], hasMore: false });

    render(<CoreSupportView />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ cursor: 't2', limit: 20 }),
    );
  });

  /**
   * A hit and a miss are the same 404 on the backend, so the UI shows one message for
   * either — the box cannot be used to probe whether a number belongs to someone else.
   */
  it('links to the ticket when a tracking number resolves', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });
    trackingMock.mockResolvedValue({
      ...ticket(),
      attachments: [],
      statusHistory: [],
      satisfaction: null,
    });

    render(<CoreSupportView />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('پیگیری با شماره تیکت'), 'TK-ABCDEFGHJK');
    await userEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    expect(await screen.findByTestId('ticket-tracking-hit')).toHaveAttribute(
      'href',
      '/admin/support/t1',
    );
  });

  it('shows one neutral message when a tracking number does not resolve', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });
    trackingMock.mockRejectedValue(new CoreApiError('Ticket not found', 404));

    render(<CoreSupportView />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText('پیگیری با شماره تیکت'), 'TK-ZZZZZZZZZZ');
    await userEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    expect(
      await screen.findByText('تیکتی با این شماره پیگیری برای شما یافت نشد.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-tracking-hit')).not.toBeInTheDocument();
  });

  /**
   * Phase 49G-2: the row's subject link was a bare inline anchor and collapsed to a
   * 20px line box, under the Core mobile 32px interactive floor. jsdom does not lay
   * out, so the guarantee is asserted structurally on the class that provides it.
   */
  it('gives the row subject link a touch-sized target', async () => {
    listMock.mockResolvedValue({ items: [ticket()], hasMore: false });

    render(<CoreSupportView />);

    const link = await screen.findByRole('link', { name: 'موضوع تیکت' });
    expect(link.className).toContain('min-h-[2rem]');
    expect(link.className).toContain('inline-flex');
    // Typography and hierarchy must be untouched.
    expect(link.className).toContain('text-sm');
    expect(link.className).toContain('font-semibold');
  });
});

