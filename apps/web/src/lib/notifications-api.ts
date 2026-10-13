import { coreGet, corePost } from './core-http';

/**
 * Phase 49E: Notification Center client.
 *
 * Mirrors the backend contract exactly (`GET /notifications`,
 * `GET /notifications/unread-count`, `POST /notifications/:id/read`,
 * `POST /notifications/read-all`).
 *
 * No function here accepts a `userId` or a tenant identifier: the backend derives
 * the recipient from the authenticated identity and `NotificationQueryDto` runs
 * under `forbidNonWhitelisted`, so sending one would be rejected. The client is
 * therefore structurally incapable of asking for someone else's notifications.
 *
 * Requests go through `coreGet`/`corePost`, which reuse the single existing
 * session/token mechanism and unwrap the `{ data }` envelope.
 */

export type NotificationState = 'unread' | 'read';

/**
 * Exactly the fields the backend projection returns. `userId`/`tenantId` are
 * deliberately absent — they are never sent to the client.
 */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string;
}

export interface NotificationListResult {
  items: NotificationItem[];
  hasMore: boolean;
}

export interface NotificationQuery {
  cursor?: string;
  limit?: number;
  state?: NotificationState;
}

export interface UnreadCountResult {
  count: number;
}

export interface MarkReadResult {
  id: string;
  readAt: string;
}

export interface MarkAllReadResult {
  updated: number;
}

/** Backend default and cap; mirrored so the UI never asks for more. */
export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

export function buildNotificationQuery(query: NotificationQuery): string {
  const params = new URLSearchParams();

  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, NOTIFICATION_MAX_PAGE_SIZE)));
  }
  if (query.state) params.set('state', query.state);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export async function listNotifications(
  query: NotificationQuery = {},
): Promise<NotificationListResult> {
  return coreGet<NotificationListResult>(`/notifications${buildNotificationQuery(query)}`);
}

export async function getUnreadCount(): Promise<UnreadCountResult> {
  return coreGet<UnreadCountResult>('/notifications/unread-count');
}

export async function markNotificationRead(id: string): Promise<MarkReadResult> {
  return corePost<MarkReadResult>(`/notifications/${encodeURIComponent(id)}/read`);
}

export async function markAllNotificationsRead(): Promise<MarkAllReadResult> {
  return corePost<MarkAllReadResult>('/notifications/read-all');
}

/** True when the notification has not been read yet. */
export function isUnread(item: NotificationItem): boolean {
  return item.readAt === null;
}

/**
 * Badge text. Counts above the cap are shown as `۹۹+` so a large number can
 * never widen the header chrome.
 */
export const UNREAD_BADGE_CAP = 99;

export function formatUnreadBadge(count: number): string {
  if (count <= 0) return '';
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count);
}

/**
 * Persian absolute date/time for a notification. Deliberately absolute rather
 * than relative: no new date library is introduced, and the value stays stable
 * between renders.
 */
export function formatNotificationTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
