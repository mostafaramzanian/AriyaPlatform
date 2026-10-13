import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreNotificationsView } from '../CoreNotificationsView';
import { CoreApiError } from '@/lib/core-http';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/notifications-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/notifications',
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. Every pure helper stays real.
jest.mock('@/lib/notifications-api', () => ({
  ...jest.requireActual('@/lib/notifications-api'),
  listNotifications: jest.fn(),
  getUnreadCount: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
}));

const listMock = listNotifications as jest.MockedFunction<typeof listNotifications>;
const countMock = getUnreadCount as jest.MockedFunction<typeof getUnreadCount>;
const markReadMock = markNotificationRead as jest.MockedFunction<typeof markNotificationRead>;
const markAllMock = markAllNotificationsRead as jest.MockedFunction<
  typeof markAllNotificationsRead
>;

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    type: 'SYSTEM',
    title: 'اعلان اول',
    body: 'متن اعلان اول',
    readAt: null,
    sourceType: null,
    sourceId: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

describe('CoreNotificationsView', () => {
  beforeEach(() => {
    countMock.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state before the first page resolves', () => {
    listMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreNotificationsView />);

    expect(screen.getByTestId('notifications-skeleton')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری اعلان‌ها...')).toBeInTheDocument();
  });

  it('requests the first page with the default limit, no cursor and no state', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });

    render(<CoreNotificationsView />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock).toHaveBeenCalledWith({ cursor: undefined, limit: 20 });
  });

  it('renders the notification title, body and time as text', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });

    render(<CoreNotificationsView />);

    expect(await screen.findByText('اعلان اول')).toBeInTheDocument();
    expect(screen.getByText('متن اعلان اول')).toBeInTheDocument();
  });

  it('never renders a sensitive field even if the API returns one', async () => {
    listMock.mockResolvedValue({
      items: [item({ userId: 'user-a', tenantId: 'tenant-a' } as never)],
      hasMore: false,
    });

    render(<CoreNotificationsView />);

    await screen.findByText('اعلان اول');
    expect(screen.queryByText('user-a')).not.toBeInTheDocument();
    expect(screen.queryByText('tenant-a')).not.toBeInTheDocument();
  });

  it('renders markup-looking content literally instead of as HTML', async () => {
    listMock.mockResolvedValue({
      items: [item({ body: '<img src=x onerror=alert(1)>' })],
      hasMore: false,
    });

    const { container } = render(<CoreNotificationsView />);

    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('marks the unread rows visually distinct from the read ones', async () => {
    listMock.mockResolvedValue({
      items: [item(), item({ id: 'n2', readAt: '2026-08-28T09:00:00.000Z' })],
      hasMore: false,
    });

    render(<CoreNotificationsView />);

    const rows = await screen.findAllByTestId('notification-row');
    expect(rows[0]).toHaveAttribute('data-unread', 'true');
    expect(rows[1]).toHaveAttribute('data-unread', 'false');
  });

  it('shows an empty state instead of placeholder rows', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreNotificationsView />);

    expect(await screen.findByText('اعلانی برای نمایش وجود ندارد.')).toBeInTheDocument();
  });

  it('shows an error with a retry that refetches', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای شبکه', 500));
    render(<CoreNotificationsView />);

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    await userEvent.click(retry);

    expect(await screen.findByText('اعلان اول')).toBeInTheDocument();
  });

  it('renders the forbidden state on 403 rather than an error', async () => {
    listMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreNotificationsView />);

    expect(await screen.findByText('شما به مرکز اعلان‌ها دسترسی ندارید.')).toBeInTheDocument();
  });

  it('sends the state filter when a tab is selected', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    render(<CoreNotificationsView />);
    await screen.findByText('اعلان اول');

    await userEvent.click(screen.getByRole('button', { name: 'خوانده‌نشده' }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({
        cursor: undefined,
        limit: 20,
        state: 'unread',
      }),
    );
  });

  it('marks a single notification read and reflects it in the row', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    markReadMock.mockResolvedValue({ id: 'n1', readAt: '2026-08-28T11:00:00.000Z' });

    render(<CoreNotificationsView />);
    await screen.findByText('اعلان اول');

    await userEvent.click(screen.getByRole('button', { name: /خوانده شد/ }));

    expect(markReadMock).toHaveBeenCalledWith('n1');
    await waitFor(() =>
      expect(screen.getByTestId('notification-row')).toHaveAttribute('data-unread', 'false'),
    );
  });

  it('marks all read and reloads the page from the server', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    markAllMock.mockResolvedValue({ updated: 1 });

    render(<CoreNotificationsView />);
    await screen.findByText('اعلان اول');
    const callsBefore = listMock.mock.calls.length;

    await userEvent.click(screen.getByTestId('notifications-mark-all'));

    expect(markAllMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('disables mark-all when nothing on the page is unread', async () => {
    listMock.mockResolvedValue({
      items: [item({ readAt: '2026-08-28T09:00:00.000Z' })],
      hasMore: false,
    });

    render(<CoreNotificationsView />);
    await screen.findByText('اعلان اول');

    expect(screen.getByTestId('notifications-mark-all')).toBeDisabled();
  });

  it('paginates forward with the last id as the cursor', async () => {
    listMock.mockResolvedValue({
      items: [item(), item({ id: 'n2', title: 'اعلان دوم' })],
      hasMore: true,
    });

    render(<CoreNotificationsView />);
    await screen.findByText('اعلان دوم');

    await userEvent.click(screen.getByRole('button', { name: 'صفحه بعد' }));

    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ cursor: 'n2', limit: 20 }));
  });

  it('never sends a userId or tenantId in any request', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });

    render(<CoreNotificationsView />);
    await screen.findByText('اعلان اول');

    for (const call of listMock.mock.calls) {
      expect(call[0] ?? {}).not.toHaveProperty('userId');
      expect(call[0] ?? {}).not.toHaveProperty('tenantId');
    }
  });
});
