import { coreGet, corePost } from './core-http';

/**
 * Phase 49F: Internal Messaging HTTP client.
 *
 * Mirrors the backend contract exactly (`GET /conversations`,
 * `GET /conversations/unread-count`, `GET /conversations/:id`,
 * `GET /conversations/:id/messages`, `POST /conversations`,
 * `POST /conversations/:id/messages`, `POST /conversations/:id/read`,
 * `GET /conversations/:id/presence`,
 * `GET /conversations/attachments/:attachmentId`).
 *
 * No function here accepts a `userId`, `senderId` or tenant identifier: the
 * backend derives the actor from the authenticated identity, and the query DTOs run
 * under `forbidNonWhitelisted`, so sending one would be rejected outright. The
 * client is therefore structurally incapable of acting as someone else.
 *
 * This module is a COMPLETE alternative to the WebSocket. The socket is a delivery
 * optimisation; every capability here works with no socket at all, which is why a
 * failed connection degrades to re-reading rather than to a broken page.
 */

export type ConversationType = 'DIRECT' | 'GROUP';

/**
 * Exactly the member fields the backend projects. Email, status, tokenVersion and
 * tenantId are deliberately absent — they never reach the client.
 */
export interface MessagingUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

export interface MessageAttachmentRef {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** `storageKey` is absent by design: downloads go through the authorized route. */
export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string | null;
  createdAt: string;
  attachments: MessageAttachmentRef[];
}

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  createdBy: string;
  lastMessageAt: string | null;
  createdAt: string;
  members: MessagingUser[];
  lastMessage: Message | null;
  /** Per-member count: messages the caller did not send and has not read. */
  unreadCount: number;
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

/**
 * `after` is a message id, not a timestamp — a client clock cannot be trusted, and
 * an id resolves to an exact server-known position. This is the reconnect recovery
 * parameter: everything strictly newer than the last message already held.
 */
export interface MessageQuery extends PageQuery {
  after?: string;
}

export interface UnreadCountResult {
  count: number;
}

export interface MarkReadResult {
  conversationId: string;
  lastReadAt: string;
}

export interface PresenceEntry {
  userId: string;
  status: 'online' | 'offline';
}

export interface AttachmentDownload {
  url: string;
  fileName: string;
  mimeType: string;
}

/** Backend defaults and caps, mirrored so the UI never asks for more. */
export const MESSAGE_PAGE_SIZE = 30;
export const MESSAGE_MAX_PAGE_SIZE = 100;
export const MAX_MESSAGE_BODY = 4000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_GROUP_PARTICIPANTS = 49;

function buildQuery(query: MessageQuery): string {
  const params = new URLSearchParams();

  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, MESSAGE_MAX_PAGE_SIZE)));
  }
  if (query.after) params.set('after', query.after);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function listConversations(query: PageQuery = {}): Promise<PageResult<Conversation>> {
  return coreGet<PageResult<Conversation>>(`/conversations${buildQuery(query)}`);
}

export function getUnreadCount(): Promise<UnreadCountResult> {
  return coreGet<UnreadCountResult>('/conversations/unread-count');
}

export function getConversation(id: string): Promise<Conversation> {
  return coreGet<Conversation>(`/conversations/${encodeURIComponent(id)}`);
}

export function listMessages(id: string, query: MessageQuery = {}): Promise<PageResult<Message>> {
  return coreGet<PageResult<Message>>(
    `/conversations/${encodeURIComponent(id)}/messages${buildQuery(query)}`,
  );
}

/**
 * Creates a GROUP, or resolves the caller's existing DIRECT conversation.
 *
 * DIRECT create is idempotent on the server (deterministic UNIQUE `directKey`), so
 * calling this twice is safe and returns the same conversation rather than a
 * duplicate thread.
 */
export function createConversation(input: {
  type: ConversationType;
  participantIds: string[];
  name?: string;
}): Promise<Conversation> {
  return corePost<Conversation>('/conversations', input);
}

/**
 * Sends over HTTP. Identical server-side path to `message.send` over the socket, so
 * the two cannot diverge in validation, membership, idempotency or fan-out.
 *
 * `clientMessageId` makes a retry safe: the same key from the same sender in the
 * same conversation returns the stored message instead of inserting a second one.
 */
export function sendMessage(
  id: string,
  input: { body: string; clientMessageId?: string; attachmentIds?: string[] },
): Promise<Message> {
  return corePost<Message>(`/conversations/${encodeURIComponent(id)}/messages`, input);
}

export function markConversationRead(id: string): Promise<MarkReadResult> {
  return corePost<MarkReadResult>(`/conversations/${encodeURIComponent(id)}/read`);
}

export function getPresence(id: string): Promise<PresenceEntry[]> {
  return coreGet<PresenceEntry[]>(`/conversations/${encodeURIComponent(id)}/presence`);
}

export function getAttachmentDownload(attachmentId: string): Promise<AttachmentDownload> {
  return coreGet<AttachmentDownload>(
    `/conversations/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

/** Generates a `clientMessageId`. Random per attempt, stable across retries. */
export function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Display name for a member. Falls back to a neutral label, never to an email. */
export function memberDisplayName(user: MessagingUser): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'کاربر';
}

/**
 * Title for a conversation row. A DIRECT conversation has no stored name — it is
 * named after the other participant here, in the UI, which is why the backend never
 * persists one.
 */
export function conversationTitle(conversation: Conversation, selfId: string): string {
  if (conversation.type === 'GROUP') {
    return conversation.name ?? 'گفت‌وگوی گروهی';
  }

  const other = conversation.members.find((member) => member.id !== selfId);
  return other ? memberDisplayName(other) : 'گفت‌وگو';
}

/** Badge text. Counts above the cap render as `۹۹+` so chrome never widens. */
export const UNREAD_BADGE_CAP = 99;

export function formatUnreadBadge(count: number): string {
  if (count <= 0) return '';
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}

/**
 * Persian absolute date/time. Deliberately absolute rather than relative: no new
 * date library is introduced and the value stays stable between renders.
 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
