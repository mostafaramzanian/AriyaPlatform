import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreNotificationBell } from '../CoreNotificationBell';
import { CoreApiError, hasLocalSession } from '@/lib/core-http';
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '@/lib/notifications-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin',
}));

jest.mock('@/lib/core-http', () => ({
  ...jest.requireActual('@/lib/core-http'),
  hasLocalSession: jest.fn(() => true),
}));

jest.mock('@/lib/notifications-api', () => ({
  ...jest.requireActual('@/lib/notifications-api'),
  listNotifications: jest.fn(),
  getUnreadCount: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
}));

const sessionMock = hasLocalSession as jest.MockedFunction<typeof hasLocalSession>;
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

describe('CoreNotificationBell', () => {
  beforeEach(() => {
    sessionMock.mockReturnValue(true);
    countMock.mockResolvedValue({ count: 0 });
    listMock.mockResolvedValue({ items: [], hasMore: false });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the bell with no badge when nothing is unread', async () => {
    render(<CoreNotificationBell />);

    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    await waitFor(() => expect(countMock).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });

  it('shows the real unread count in the badge', async () => {
    countMock.mockResolvedValue({ count: 3 });

    render(<CoreNotificationBell />);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('3');
  });

  it('caps a very large count instead of widening the header', async () => {
    countMock.mockResolvedValue({ count: 1250 });

    render(<CoreNotificationBell />);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('99+');
  });

  it('announces the unread count to assistive technology', async () => {
    countMock.mockResolvedValue({ count: 2 });

    render(<CoreNotificationBell />);

    await waitFor(() =>
      expect(screen.getByTestId('notification-bell')).toHaveAttribute(
        'aria-label',
        'اعلان‌ها، 2 اعلان خوانده‌نشده',
      ),
    );
  });

  it('keeps the header usable when the unread count request fails', async () => {
    countMock.mockRejectedValue(new CoreApiError('boom', 500));

    render(<CoreNotificationBell />);

    await waitFor(() => expect(countMock).toHaveBeenCalled());
    // No badge, no error surface, and the bell is still there.
    expect(screen.getByTestId('notification-bell')).toBeEnabled();
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('skips the count request entirely when there is no local session', async () => {
    sessionMock.mockReturnValue(false);

    render(<CoreNotificationBell />);

    await waitFor(() => expect(screen.getByTestId('notification-bell')).toBeInTheDocument());
    expect(countMock).not.toHaveBeenCalled();
  });

  it('does not load the list until the panel is opened', async () => {
    render(<CoreNotificationBell />);

    await waitFor(() => expect(countMock).toHaveBeenCalled());
    expect(listMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('notification-bell'));

    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ limit: 8 }));
    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();
  });

  it('shows an empty state in the panel rather than placeholder rows', async () => {
    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));

    expect(await screen.findByText('اعلانی برای نمایش وجود ندارد.')).toBeInTheDocument();
  });

  it('shows a panel-local error with a retry when the list fails', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای شبکه', 500));

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    await userEvent.click(retry);

    expect(await screen.findByText('اعلان اول')).toBeInTheDocument();
  });

  it('renders markup-looking content literally instead of as HTML', async () => {
    listMock.mockResolvedValue({
      items: [item({ body: '<img src=x onerror=alert(1)>' })],
      hasMore: false,
    });

    const { container } = render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));

    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('never renders a sensitive field even if the API returns one', async () => {
    listMock.mockResolvedValue({
      items: [item({ userId: 'user-a', tenantId: 'tenant-a' } as never)],
      hasMore: false,
    });

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));

    await screen.findByText('اعلان اول');
    expect(screen.queryByText('user-a')).not.toBeInTheDocument();
    expect(screen.queryByText('tenant-a')).not.toBeInTheDocument();
  });

  it('marks one notification read and refreshes the badge', async () => {
    countMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
    listMock.mockResolvedValue({ items: [item()], hasMore: false });
    markReadMock.mockResolvedValue({ id: 'n1', readAt: '2026-08-28T11:00:00.000Z' });

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    await screen.findByText('اعلان اول');

    await userEvent.click(screen.getByRole('button', { name: 'خوانده شد: اعلان اول' }));

    expect(markReadMock).toHaveBeenCalledWith('n1');
    await waitFor(() =>
      expect(screen.getByTestId('notification-item')).toHaveAttribute('data-unread', 'false'),
    );
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument());
  });

  it('marks all read and refreshes the badge', async () => {
    countMock.mockResolvedValueOnce({ count: 2 }).mockResolvedValue({ count: 0 });
    listMock.mockResolvedValue({
      items: [item(), item({ id: 'n2', title: 'اعلان دوم' })],
      hasMore: false,
    });
    markAllMock.mockResolvedValue({ updated: 2 });

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    await screen.findByText('اعلان دوم');

    await userEvent.click(screen.getByTestId('notification-mark-all'));

    expect(markAllMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getAllByTestId('notification-item').every(
          (node) => node.getAttribute('data-unread') === 'false',
        ),
      ).toBe(true),
    );
  });

  it('disables mark-all when nothing in the panel is unread', async () => {
    listMock.mockResolvedValue({
      items: [item({ readAt: '2026-08-28T09:00:00.000Z' })],
      hasMore: false,
    });

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    await screen.findByText('اعلان اول');

    expect(screen.getByTestId('notification-mark-all')).toBeDisabled();
  });

  it('links to the full notification center', async () => {
    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));

    const link = await screen.findByRole('link', { name: /اعلان/ });
    expect(link).toHaveAttribute('href', '/admin/notifications');
  });

  it('closes the panel on Escape', async () => {
    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    expect(await screen.findByTestId('notification-panel')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument(),
    );
  });

  it('never sends a userId or tenantId in any request', async () => {
    listMock.mockResolvedValue({ items: [item()], hasMore: false });

    render(<CoreNotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    await screen.findByText('اعلان اول');

    for (const call of listMock.mock.calls) {
      expect(call[0] ?? {}).not.toHaveProperty('userId');
      expect(call[0] ?? {}).not.toHaveProperty('tenantId');
    }
    // The count endpoint takes no argument at all.
    for (const call of countMock.mock.calls) {
      expect(call).toHaveLength(0);
    }
  });
});
