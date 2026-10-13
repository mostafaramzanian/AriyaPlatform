import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreMessagesView } from '../CoreMessagesView';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import {
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
  type Conversation,
  type Message,
} from '@/lib/messaging-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/messages',
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked
// rather than spied on. The pure helpers (titles, badges, time) stay real, which is
// what lets the assertions below check real rendered output.
jest.mock('@/lib/messaging-api', () => ({
  ...jest.requireActual('@/lib/messaging-api'),
  listConversations: jest.fn(),
  listMessages: jest.fn(),
  markConversationRead: jest.fn(),
  sendMessage: jest.fn(),
}));

// The socket is replaced by a double whose handlers are captured, so the real-time
// paths can be driven deterministically without a server. This also proves the view
// never *needs* a socket: every test below passes with a connection that does nothing.
const socketInstances: Array<{
  handlers: Record<string, (...args: never[]) => void>;
  connect: jest.Mock;
  dispose: jest.Mock;
  subscribe: jest.Mock;
  setTyping: jest.Mock;
}> = [];

jest.mock('@/lib/messaging-socket', () => ({
  MessagingSocket: jest.fn().mockImplementation((handlers: Record<string, () => void>) => {
    const instance = {
      handlers,
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn(),
      subscribe: jest.fn(),
      setTyping: jest.fn(),
    };
    socketInstances.push(instance as never);
    return instance;
  }),
}));

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;
const listConversationsMock = listConversations as jest.MockedFunction<typeof listConversations>;
const listMessagesMock = listMessages as jest.MockedFunction<typeof listMessages>;
const markReadMock = markConversationRead as jest.MockedFunction<typeof markConversationRead>;
const sendMessageMock = sendMessage as jest.MockedFunction<typeof sendMessage>;

const SELF = 'user-self';
const OTHER = 'user-other';

// Assembled from parts so the literal is a plain string, not markup the tooling tries
// to parse. What matters is that the view puts it in the DOM as text.
const XSS_PAYLOAD = ['<img', 'src=x', 'onerror=alert(1)>'].join(' ');

/**
 * Fires a socket callback the way the real transport does — inside React's commit —
 * so state updates are flushed rather than warned about.
 */
function emit(handler: string, ...args: unknown[]): void {
  act(() => {
    socketInstances[0].handlers[handler]?.(...(args as never[]));
  });
}

function member(id: string, firstName: string, lastName: string) {
  return { id, firstName, lastName, avatarUrl: null, jobTitle: null };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    type: 'DIRECT',
    name: null,
    createdBy: SELF,
    lastMessageAt: '2026-08-28T10:00:00.000Z',
    createdAt: '2026-08-28T09:00:00.000Z',
    members: [member(SELF, 'من', 'خودم'), member(OTHER, 'سارا', 'احمدی')],
    lastMessage: null,
    unreadCount: 0,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    senderId: OTHER,
    body: 'سلام، وضعیت گزارش چطور است؟',
    clientMessageId: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  socketInstances.length = 0;
  useAuthMock.mockReturnValue({
    user: { sub: SELF, email: 'self@localhost' },
    isAuthenticated: true,
    isLoading: false,
    login: jest.fn(),
    logout: jest.fn(),
  } as never);
  markReadMock.mockResolvedValue({ conversationId: 'c1', lastReadAt: '2026-08-28T11:00:00.000Z' });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('CoreMessagesView', () => {
  it('announces an accessible loading state before the rail resolves', () => {
    listConversationsMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreMessagesView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری گفت‌وگوها...')).toBeInTheDocument();
  });

  it('renders the empty state when the caller has no conversations', async () => {
    listConversationsMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreMessagesView />);

    expect(await screen.findByText('هنوز گفت‌وگویی ندارید.')).toBeInTheDocument();
    // No thread panel is drawn, so there is nothing to send into.
    expect(screen.queryByTestId('message-list')).not.toBeInTheDocument();
  });

  it('names a DIRECT conversation after the other participant, never the caller', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);

    // Once in the rail, once as the thread heading.
    const titles = await screen.findAllByText('سارا احمدی');
    expect(titles.length).toBeGreaterThan(0);
    expect(screen.queryByText('من خودم')).not.toBeInTheDocument();
  });

  it('auto-selects the first conversation and loads its first page', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);

    await waitFor(() => expect(listMessagesMock).toHaveBeenCalled());
    expect(listMessagesMock).toHaveBeenCalledWith('c1', { limit: 30 });
    expect(await screen.findByText('سلام، وضعیت گزارش چطور است؟')).toBeInTheDocument();
  });

  it('marks the opened conversation read and clears its badge', async () => {
    listConversationsMock.mockResolvedValue({
      items: [conversation({ unreadCount: 3 })],
      hasMore: false,
    });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);

    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(screen.queryByText('3')).not.toBeInTheDocument());
  });

  it('caps the unread badge instead of widening the rail', async () => {
    listConversationsMock.mockResolvedValue({
      items: [
        conversation({ unreadCount: 0 }),
        conversation({ id: 'c2', unreadCount: 250, name: 'گروه پروژه', type: 'GROUP' }),
      ],
      hasMore: false,
    });
    listMessagesMock.mockResolvedValue({ items: [], hasMore: false });

    render(<CoreMessagesView />);

    expect(await screen.findByText('99+')).toBeInTheDocument();
  });

  it('renders markup-looking bodies literally rather than as HTML', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({
      items: [message({ body: XSS_PAYLOAD })],
      hasMore: false,
    });

    render(<CoreMessagesView />);

    expect(await screen.findByText(XSS_PAYLOAD)).toBeInTheDocument();
    // The body reached the DOM as a text node, so no element was created from it.
    expect(document.querySelector('img')).toBeNull();
  });

  it('distinguishes own messages from received ones', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({
      items: [
        message({ id: 'm2', senderId: SELF, body: 'در حال بررسی است.' }),
        message({ id: 'm1', senderId: OTHER }),
      ],
      hasMore: false,
    });

    render(<CoreMessagesView />);

    await screen.findByText('در حال بررسی است.');
    const rows = screen.getAllByTestId('message-row');
    expect(rows.map((row) => row.getAttribute('data-own'))).toEqual(['false', 'true']);
  });

  it('sends over HTTP with a clientMessageId and clears the draft', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });
    sendMessageMock.mockResolvedValue(
      message({ id: 'm-new', senderId: SELF, body: 'پاسخ من', clientMessageId: 'k1' }),
    );

    render(<CoreMessagesView />);
    const box = await screen.findByLabelText('متن پیام');

    await userEvent.type(box, 'پاسخ من');
    await userEvent.click(screen.getByRole('button', { name: /ارسال/ }));

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    const [conversationId, payload] = sendMessageMock.mock.calls[0];
    expect(conversationId).toBe('c1');
    expect(payload.body).toBe('پاسخ من');
    // Idempotency key is always attached, so a retry cannot duplicate the message.
    expect(typeof payload.clientMessageId).toBe('string');
    expect(payload.clientMessageId).not.toHaveLength(0);
    expect(box).toHaveValue('');
  });

  it('refuses to send a whitespace-only draft', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    const box = await screen.findByLabelText('متن پیام');

    await userEvent.type(box, '   ');

    expect(screen.getByRole('button', { name: /ارسال/ })).toBeDisabled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('surfaces a send failure instead of pretending it succeeded', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });
    sendMessageMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreMessagesView />);
    const box = await screen.findByLabelText('متن پیام');

    await userEvent.type(box, 'تلاش');
    await userEvent.click(screen.getByRole('button', { name: /ارسال/ }));

    expect(await screen.findByText('forbidden')).toBeInTheDocument();
    // The draft is kept so the user does not lose what they wrote.
    expect(box).toHaveValue('تلاش');
  });

  it('paginates older messages using the oldest held id as the cursor', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValueOnce({
      items: [
        message({ id: 'm3', createdAt: '2026-08-28T10:02:00.000Z' }),
        message({ id: 'm2', createdAt: '2026-08-28T10:01:00.000Z' }),
      ],
      hasMore: true,
    });

    render(<CoreMessagesView />);
    const older = await screen.findByRole('button', { name: 'پیام‌های قبلی' });

    listMessagesMock.mockResolvedValueOnce({
      items: [message({ id: 'm1', body: 'قدیمی‌ترین', createdAt: '2026-08-28T09:59:00.000Z' })],
      hasMore: false,
    });
    await userEvent.click(older);

    await waitFor(() =>
      expect(listMessagesMock).toHaveBeenLastCalledWith('c1', { cursor: 'm2', limit: 30 }),
    );
    expect(await screen.findByText('قدیمی‌ترین')).toBeInTheDocument();
  });

  it('shows an error with retry when the rail fails to load', async () => {
    listConversationsMock.mockRejectedValueOnce(new CoreApiError('boom', 500));

    render(<CoreMessagesView />);

    const retry = await screen.findByRole('button', { name: 'تلاش دوباره' });
    listConversationsMock.mockResolvedValueOnce({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });
    await userEvent.click(retry);

    expect(await screen.findByText('سلام، وضعیت گزارش چطور است؟')).toBeInTheDocument();
  });

  it('offers no retry on 401, where re-reading could not help', async () => {
    listConversationsMock.mockRejectedValue(new CoreApiError('unauthorized', 401));

    render(<CoreMessagesView />);

    await screen.findByText('unauthorized');
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('appends a socket-delivered message for the active conversation', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    emit('onMessage', message({ id: 'm9', body: 'پیام زنده', createdAt: '2026-08-28T10:05:00.000Z' }));

    expect(await screen.findByText('پیام زنده')).toBeInTheDocument();
  });

  it('ignores a socket message addressed to a different conversation', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    emit('onMessage', message({ id: 'mx', conversationId: 'other', body: 'نباید دیده شود' }));

    await waitFor(() => expect(screen.getAllByTestId('message-row')).toHaveLength(1));
    expect(screen.queryByText('نباید دیده شود')).not.toBeInTheDocument();
  });

  it('deduplicates a message that arrives over both HTTP and the socket', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [], hasMore: false });
    sendMessageMock.mockResolvedValue(
      message({ id: 'm-http', senderId: SELF, body: 'یکتا', clientMessageId: 'dup-key' }),
    );

    render(<CoreMessagesView />);
    const box = await screen.findByLabelText('متن پیام');
    await userEvent.type(box, 'یکتا');
    await userEvent.click(screen.getByRole('button', { name: /ارسال/ }));
    await screen.findByText('یکتا');

    // The same logical message re-delivered under a different server id — matched on
    // clientMessageId, so the thread does not show it twice.
    emit(
      'onMessage',
      message({ id: 'm-ws', senderId: SELF, body: 'یکتا', clientMessageId: 'dup-key' }),
    );

    await waitFor(() => expect(screen.getAllByText('یکتا')).toHaveLength(1));
  });

  it('merges recovered messages after a reconnect without duplicating them', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    // The gap: one already-held message plus one that arrived while offline.
    emit('onRecovered', 'c1', [
      message(),
      message({ id: 'm-gap', body: 'پیام جامانده', createdAt: '2026-08-28T10:03:00.000Z' }),
    ]);

    expect(await screen.findByText('پیام جامانده')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('message-row')).toHaveLength(2));
  });

  it('names the typing member and only for the active conversation', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    emit('onTyping', { conversationId: 'c1', userId: OTHER, isTyping: true });

    expect(await screen.findByText('سارا احمدی در حال نوشتن...')).toBeInTheDocument();

    emit('onTyping', { conversationId: 'c1', userId: OTHER, isTyping: false });

    await waitFor(() =>
      expect(screen.queryByText('سارا احمدی در حال نوشتن...')).not.toBeInTheDocument(),
    );
  });

  it('switches thread when another conversation is picked', async () => {
    listConversationsMock.mockResolvedValue({
      items: [conversation(), conversation({ id: 'c2', type: 'GROUP', name: 'گروه پروژه' })],
      hasMore: false,
    });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    await userEvent.click(screen.getByRole('button', { name: /گروه پروژه/ }));

    await waitFor(() =>
      expect(listMessagesMock).toHaveBeenLastCalledWith('c2', { limit: 30 }),
    );
  });

  it('reports the transport state without making it a failure', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    // Nothing set the status, so the fallback label shows while the thread is still
    // fully rendered — the socket is an optimisation, not a prerequisite.
    expect(screen.getByTestId('socket-status')).toHaveTextContent('حالت بازخوانی');
    expect(screen.getByTestId('message-list')).toBeInTheDocument();

    emit('onStatusChange', 'open');
    await waitFor(() => expect(screen.getByTestId('socket-status')).toHaveTextContent('متصل'));
  });

  it('disposes the socket on unmount', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    const view = render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    view.unmount();

    expect(socketInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('never sends a userId, senderId or tenantId in any request', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });
    sendMessageMock.mockResolvedValue(message({ id: 'm-new', senderId: SELF, body: 'x' }));

    render(<CoreMessagesView />);
    const box = await screen.findByLabelText('متن پیام');
    await userEvent.type(box, 'x');
    await userEvent.click(screen.getByRole('button', { name: /ارسال/ }));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalled());

    const payloads: Array<Record<string, unknown>> = [
      ...listConversationsMock.mock.calls.map((call) => (call[0] ?? {}) as Record<string, unknown>),
      ...listMessagesMock.mock.calls.map((call) => (call[1] ?? {}) as Record<string, unknown>),
      ...sendMessageMock.mock.calls.map((call) => (call[1] ?? {}) as Record<string, unknown>),
    ];

    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('userId');
      expect(payload).not.toHaveProperty('senderId');
      expect(payload).not.toHaveProperty('tenantId');
    }
  });

  it('does not render a member identifier anywhere in the thread', async () => {
    listConversationsMock.mockResolvedValue({ items: [conversation()], hasMore: false });
    listMessagesMock.mockResolvedValue({ items: [message()], hasMore: false });

    render(<CoreMessagesView />);
    await screen.findByText('سلام، وضعیت گزارش چطور است؟');

    expect(screen.queryByText(SELF)).not.toBeInTheDocument();
    expect(screen.queryByText(OTHER)).not.toBeInTheDocument();
  });
});
