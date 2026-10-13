'use client';

import * as React from 'react';
import { Send, Users } from 'lucide-react';

import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  MAX_MESSAGE_BODY,
  MESSAGE_PAGE_SIZE,
  conversationTitle,
  formatMessageTime,
  formatUnreadBadge,
  listConversations,
  listMessages,
  markConversationRead,
  memberDisplayName,
  newClientMessageId,
  sendMessage as sendMessageOverHttp,
  type Conversation,
  type Message,
} from '@/lib/messaging-api';
import { MessagingSocket, type SocketStatus } from '@/lib/messaging-socket';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreLoading } from './CoreStates';

/**
 * Phase 49F: Internal Messaging page.
 *
 * Reads and writes only conversations the caller belongs to. No request from here
 * carries a user, sender or tenant identifier — scope comes exclusively from the
 * authenticated identity, and membership is re-checked server-side on every call.
 *
 * The WebSocket is an optimisation, never a requirement: the rail, the thread, the
 * composer and read-marking all work over HTTP alone. When a socket is available it
 * removes the need to poll; when it is not, everything still functions and a
 * reconnect recovers the gap via `after`.
 *
 * Message bodies are rendered as text. No `dangerouslySetInnerHTML` anywhere.
 */

/** Newest-first, the order both the API and the rail use. */
function sortMessagesDescending(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  });
}

/**
 * Merges arriving messages into the current list.
 *
 * Deduplicates on both `id` and `clientMessageId`, so a message that arrives over
 * the socket AND comes back from the HTTP fallback appears once — that overlap is
 * expected, not exceptional.
 */
function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  const clientKeys = new Set(
    existing.map((message) => message.clientMessageId).filter(Boolean) as string[],
  );

  for (const message of incoming) {
    if (byId.has(message.id)) continue;
    if (message.clientMessageId && clientKeys.has(message.clientMessageId)) continue;

    byId.set(message.id, message);
    if (message.clientMessageId) clientKeys.add(message.clientMessageId);
  }

  return sortMessagesDescending([...byId.values()]);
}

export function CoreMessagesView() {
  const { user } = useAuth();
  const selfId = user?.sub ?? '';

  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = React.useState(false);
  const [typingUsers, setTypingUsers] = React.useState<string[]>([]);
  const [socketStatus, setSocketStatus] = React.useState<SocketStatus>('idle');

  const [isLoadingRail, setIsLoadingRail] = React.useState(true);
  const [isLoadingThread, setIsLoadingThread] = React.useState(false);
  const [isSending, setIsSending] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the rail effect needs no in-effect setter resets. First mount is
  // covered by the initial `isLoadingRail: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoadingRail, setError);
  // Thread-load arming for conversation switches happens here, synchronously
  // during render (guarded by the previous id) — never in the effect body
  // (`react-hooks/set-state-in-effect`): selecting arms the skeleton and
  // clears typing, deselecting empties the thread. Mount (null → null) is a
  // no-op.
  const [prevActiveId, setPrevActiveId] = React.useState(activeId);
  if (prevActiveId !== activeId) {
    setPrevActiveId(activeId);
    if (!activeId) {
      setMessages([]);
      setHasMoreMessages(false);
    } else {
      setIsLoadingThread(true);
      setTypingUsers([]);
    }
  }

  const socketRef = React.useRef<MessagingSocket | null>(null);
  // The active conversation is read inside socket callbacks, which are created once;
  // a ref keeps them looking at the current value instead of a stale closure. The
  // ref is written only in this effect (never during render — `react-hooks/refs`),
  // and because it is a DIRECT useRef the callbacks below do not need it in their
  // dependency arrays. The callbacks run strictly post-effect, so no read observes
  // a stale value on first paint.
  const activeIdRef = React.useRef<string | null>(activeId);
  React.useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const describeError = (err: unknown, fallback: string) => ({
    message: err instanceof Error ? err.message : fallback,
    status: err instanceof CoreApiError ? err.status : null,
  });

  /** Replaces one conversation in the rail, keeping newest-activity ordering. */
  const upsertConversation = React.useCallback((conversation: Conversation) => {
    setConversations((prev) => {
      const next = prev.some((item) => item.id === conversation.id)
        ? prev.map((item) => (item.id === conversation.id ? conversation : item))
        : [conversation, ...prev];

      return [...next].sort((a, b) => {
        const aTime = new Date(a.lastMessageAt ?? a.createdAt).getTime();
        const bTime = new Date(b.lastMessageAt ?? b.createdAt).getTime();
        return bTime - aTime;
      });
    });
  }, []);

  // Rail load. Also selects the first conversation, so the page is never an empty
  // frame when the user does have threads.
  React.useEffect(() => {
    let cancelled = false;

    listConversations({ limit: 100 })
      .then((result) => {
        if (cancelled) return;
        const items = result.items ?? [];
        setConversations(items);
        setActiveId((current) => current ?? items[0]?.id ?? null);
        setIsLoadingRail(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConversations([]);
        setError(describeError(err, 'دریافت گفت‌وگوها با خطا مواجه شد.'));
        setIsLoadingRail(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // One socket for the lifetime of the page. Handlers are registered once and read
  // mutable state through refs, so the connection is never torn down and rebuilt
  // just because a different conversation was selected.
  React.useEffect(() => {
    const socket = new MessagingSocket({
      onStatusChange: setSocketStatus,
      onMessage: (message) => {
        if (message.conversationId === activeIdRef.current) {
          setMessages((prev) => mergeMessages(prev, [message]));
        }
      },
      onRecovered: (conversationId, recovered) => {
        // Everything that arrived while the socket was down, re-read from Postgres.
        if (conversationId === activeIdRef.current) {
          setMessages((prev) => mergeMessages(prev, recovered));
        }
      },
      onConversationUpdated: upsertConversation,
      onTyping: ({ conversationId, userId, isTyping }) => {
        if (conversationId !== activeIdRef.current) return;
        setTypingUsers((prev) =>
          isTyping
            ? prev.includes(userId)
              ? prev
              : [...prev, userId]
            : prev.filter((id) => id !== userId),
        );
      },
    });

    socketRef.current = socket;
    void socket.connect();

    return () => {
      socket.dispose();
      socketRef.current = null;
    };
  }, [upsertConversation]);

  // Thread load. Marks the conversation read and subscribes the socket to it, so the
  // first page and the authorization probe are one round trip. The arming/reset
  // for a conversation switch lives in the render-time adjustment above; this
  // effect only settles.
  React.useEffect(() => {
    if (!activeId) return;

    let cancelled = false;

    listMessages(activeId, { limit: MESSAGE_PAGE_SIZE })
      .then(async (result) => {
        if (cancelled) return;
        const items = sortMessagesDescending(result.items ?? []);
        setMessages(items);
        setHasMoreMessages(Boolean(result.hasMore));
        setIsLoadingThread(false);

        // Seed the recovery anchor with the newest message actually rendered.
        socketRef.current?.subscribe(activeId, items[0]?.id ?? null);

        try {
          await markConversationRead(activeId);
          setConversations((prev) =>
            prev.map((item) => (item.id === activeId ? { ...item, unreadCount: 0 } : item)),
          );
        } catch {
          // A failed read-mark leaves the badge as it was; it is not worth surfacing
          // an error over, and the next open retries.
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMessages([]);
        setHasMoreMessages(false);
        setError(describeError(err, 'دریافت پیام‌ها با خطا مواجه شد.'));
        setIsLoadingThread(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const activeConversation = conversations.find((item) => item.id === activeId) ?? null;

  /**
   * Sends the draft.
   *
   * ALWAYS goes over HTTP. The socket has no acknowledgement, so a socket-only send
   * cannot tell the difference between delivered and dropped; the HTTP call returns
   * the persisted message, which is what the thread renders. `clientMessageId` makes
   * this safe: the server treats a repeat as the same message rather than a second
   * one, so nothing is duplicated when the socket also delivers it.
   */
  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();

    const body = draft.trim();
    if (!activeId || body.length === 0 || body.length > MAX_MESSAGE_BODY) return;

    setIsSending(true);
    try {
      const created = await sendMessageOverHttp(activeId, {
        body,
        clientMessageId: newClientMessageId(),
      });

      setMessages((prev) => mergeMessages(prev, [created]));
      setDraft('');
      socketRef.current?.setTyping(activeId, false);
    } catch (err: unknown) {
      setError(describeError(err, 'ارسال پیام با خطا مواجه شد.'));
    } finally {
      setIsSending(false);
    }
  };

  /** Loads one older page. Cursor is the oldest message currently held. */
  const loadOlder = async () => {
    if (!activeId || messages.length === 0) return;

    const oldest = messages[messages.length - 1];
    try {
      const page = await listMessages(activeId, {
        cursor: oldest.id,
        limit: MESSAGE_PAGE_SIZE,
      });
      setMessages((prev) => mergeMessages(prev, page.items ?? []));
      setHasMoreMessages(Boolean(page.hasMore));
    } catch (err: unknown) {
      setError(describeError(err, 'دریافت پیام‌های قبلی با خطا مواجه شد.'));
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    // Typing is ephemeral and best-effort: if there is no socket, nothing is sent and
    // nothing breaks.
    if (activeId) socketRef.current?.setTyping(activeId, value.trim().length > 0);
  };

  const typingLabel = React.useMemo(() => {
    if (!activeConversation || typingUsers.length === 0) return null;

    const names = typingUsers
      .map((id) => activeConversation.members.find((member) => member.id === id))
      .filter(Boolean)
      .map((member) => memberDisplayName(member!));

    if (names.length === 0) return null;
    return `${names.join('، ')} در حال نوشتن...`;
  }, [activeConversation, typingUsers]);

  if (isLoadingRail) {
    return <CoreLoading label="در حال بارگذاری گفت‌وگوها..." lines={4} />;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">پیام‌ها</h1>
          <p className="text-xs text-muted-foreground">
            گفت‌وگوهای شما. تنها اعضای هر گفت‌وگو به آن دسترسی دارند.
          </p>
        </div>
        {/* Transport state is informational only — the page works either way. */}
        <span className="text-xs text-muted-foreground" data-testid="socket-status">
          {socketStatus === 'open' ? 'متصل' : 'حالت بازخوانی'}
        </span>
      </header>

      {error && (
        <CoreError
          message={error.message}
          onRetry={
            error.status === 401
              ? undefined
              : reload
          }
        />
      )}

      {conversations.length === 0 && !error && <CoreEmpty message="هنوز گفت‌وگویی ندارید." />}

      {conversations.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="فهرست گفت‌وگوها" className="space-y-2" data-testid="conversation-rail">
            {conversations.map((conversation) => {
              const badge = formatUnreadBadge(conversation.unreadCount);

              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setActiveId(conversation.id)}
                  aria-current={conversation.id === activeId ? 'true' : undefined}
                  data-testid="conversation-row"
                  className={cn(
                    'core-card flex w-full items-start justify-between gap-3 p-3 text-right transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    conversation.id === activeId && 'border-primary/40 bg-primary/5',
                  )}
                >
                  <span className="min-w-0 space-y-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {conversation.type === 'GROUP' && (
                        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">{conversationTitle(conversation, selfId)}</span>
                    </span>
                    {conversation.lastMessage && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {conversation.lastMessage.body}
                      </span>
                    )}
                  </span>
                  {badge && (
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <section className="core-card flex min-h-[24rem] flex-col p-4" aria-label="گفت‌وگو">
            {activeConversation && (
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                {conversationTitle(activeConversation, selfId)}
              </h2>
            )}

            {isLoadingThread && <CoreLoading label="در حال بارگذاری پیام‌ها..." lines={3} />}

            {!isLoadingThread && messages.length === 0 && (
              <CoreEmpty message="در این گفت‌وگو پیامی وجود ندارد." />
            )}

            {!isLoadingThread && messages.length > 0 && (
              <>
                {hasMoreMessages && (
                  <button
                    type="button"
                    onClick={() => void loadOlder()}
                    className="mb-3 self-center rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    پیام‌های قبلی
                  </button>
                )}

                {/* Rendered oldest-first for reading, though the data is newest-first. */}
                <ul className="flex flex-1 flex-col gap-2" data-testid="message-list">
                  {[...messages].reverse().map((message) => (
                    <li
                      key={message.id}
                      data-testid="message-row"
                      data-own={message.senderId === selfId ? 'true' : 'false'}
                      className={cn(
                        'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                        message.senderId === selfId
                          ? 'self-start bg-primary/10 text-foreground'
                          : 'self-end bg-muted text-foreground',
                      )}
                    >
                      {/* Text node only — message bodies are never rendered as HTML. */}
                      <p className="whitespace-pre-line break-words">{message.body}</p>
                      {message.attachments.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          {message.attachments.map((attachment) => (
                            <li key={attachment.id}>{attachment.fileName}</li>
                          ))}
                        </ul>
                      )}
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {formatMessageTime(message.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {typingLabel && (
              <p aria-live="polite" className="pt-2 text-xs text-muted-foreground">
                {typingLabel}
              </p>
            )}

            {activeId && (
              <form onSubmit={handleSend} className="mt-3 flex items-end gap-2">
                <label htmlFor="message-draft" className="sr-only">
                  متن پیام
                </label>
                <textarea
                  id="message-draft"
                  value={draft}
                  onChange={(event) => handleDraftChange(event.target.value)}
                  maxLength={MAX_MESSAGE_BODY}
                  rows={2}
                  className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="پیام خود را بنویسید..."
                />
                <button
                  type="submit"
                  disabled={isSending || draft.trim().length === 0}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  ارسال
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
