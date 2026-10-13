import { coreGet, corePatch, corePost, corePostForm } from './core-http';

/**
 * Phase 49G: Support / Ticketing client.
 *
 * Mirrors the backend contract exactly (`GET /tickets`,
 * `GET /tickets/tracking/:trackingNumber`, `GET /tickets/attachments/:id`,
 * `POST /tickets`, `GET /tickets/:id`, `PATCH /tickets/:id`,
 * `PATCH /tickets/:id/status`, `GET|POST /tickets/:id/comments`,
 * `POST /tickets/:id/attachments`, `POST /tickets/:id/satisfaction`).
 *
 * No function here accepts a `requesterId`, `authorId` or tenant identifier: the
 * backend derives the actor from the authenticated identity, and the query DTOs run
 * under `forbidNonWhitelisted`, so sending one would be rejected outright. The client
 * is therefore structurally incapable of acting as someone else.
 *
 * `trackingNumber` is likewise never sent on create — it is minted server-side.
 */

export type TicketType =
  | 'BUG'
  | 'SUPPORT'
  | 'SUGGESTION'
  | 'CRITICISM'
  | 'COMPLAINT'
  | 'FEATURE_REQUEST';

export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type TicketStatus =
  | 'NEW'
  | 'TRIAGED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_REQUESTER'
  | 'RESOLVED'
  | 'CLOSED';

/**
 * Exactly the person fields the backend projects. Email, status, tokenVersion and
 * tenantId are deliberately absent — they never reach the client.
 */
export interface TicketUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

/** `storageKey` is absent by design: downloads go through the authorized route. */
export interface TicketAttachmentRef {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  commentId: string | null;
}

/**
 * Phase 49G-2: what `POST /tickets/:id/attachments` returns.
 *
 * Narrower than `TicketAttachmentRef` on purpose — the upload projection has no
 * `commentId`, because a freshly uploaded attachment is not bound to a comment yet.
 * `storageKey` is likewise absent server-side, so it cannot be rendered.
 */
export interface PendingTicketAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface Ticket {
  id: string;
  trackingNumber: string;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string;
  body: string;
  category: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requester: TicketUser;
  assignee: TicketUser | null;
  /** True when the caller may perform the agent-only actions. */
  canManage: boolean;
  /** Transitions the caller can actually perform right now; empty for a requester. */
  availableTransitions: TicketStatus[];
}

export interface TicketComment {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  createdAt: string;
  author: TicketUser;
  attachments: TicketAttachmentRef[];
}

export interface TicketStatusHistoryEntry {
  id: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  note: string | null;
  createdAt: string;
  changedBy: TicketUser;
}

export interface TicketSatisfaction {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface TicketDetail extends Ticket {
  attachments: TicketAttachmentRef[];
  statusHistory: TicketStatusHistoryEntry[];
  satisfaction: TicketSatisfaction | null;
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface TicketQuery {
  cursor?: string;
  limit?: number;
  scope?: 'mine' | 'assigned' | 'all';
  status?: TicketStatus;
  type?: TicketType;
  priority?: TicketPriority;
}

export interface AttachmentDownload {
  url: string;
  fileName: string;
  mimeType: string;
}

/** Backend defaults and caps, mirrored so the UI never asks for more. */
export const TICKET_PAGE_SIZE = 20;
export const TICKET_MAX_PAGE_SIZE = 100;
export const MAX_TICKET_SUBJECT = 160;
export const MAX_TICKET_BODY = 4000;
export const MAX_TICKET_COMMENT_BODY = 4000;
export const MAX_ATTACHMENTS_PER_COMMENT = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Phase 49G-2: mirror of the backend MIME allowlist
 * (`ALLOWED_TICKET_MIME_TYPES` in `support-attachment.service.ts`).
 *
 * This exists so the picker can refuse an obviously-unusable file immediately instead
 * of spending an upload on it. It is a UX affordance only — the backend re-checks the
 * exact same set, the Multer `limits`, and a database CHECK. SVG is absent here for
 * the same reason it is absent there: it is an executable document.
 */
export const ALLOWED_TICKET_ATTACHMENT_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** `accept` value for the file input, derived from the allowlist (never a superset). */
export const TICKET_ATTACHMENT_ACCEPT = ALLOWED_TICKET_ATTACHMENT_MIME_TYPES.join(',');

/** Short Persian type labels for display. Falls back to nothing rather than guessing. */
const ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
  'text/plain': 'متن',
  'text/csv': 'CSV',
  'application/zip': 'ZIP',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
};

export function ticketAttachmentTypeLabel(mimeType: string): string {
  return ATTACHMENT_TYPE_LABELS[mimeType] ?? 'فایل';
}

/** Persian byte size, bounded to one decimal. Presentation only. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes.toLocaleString('fa-IR')} بایت`;

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Number(kb.toFixed(1)).toLocaleString('fa-IR')} کیلوبایت`;
  }

  const mb = kb / 1024;
  return `${Number(mb.toFixed(1)).toLocaleString('fa-IR')} مگابایت`;
}

/**
 * Immediate, client-side sanity check on a picked file. Returns a Persian reason, or
 * `null` when the file looks acceptable.
 *
 * This never replaces server enforcement: it only avoids a pointless round trip and
 * gives the user an answer without waiting for one.
 */
export function validateTicketAttachment(file: File): string | null {
  if (file.size === 0) {
    return 'فایل خالی است.';
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `حجم فایل بیشتر از ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} است.`;
  }

  if (!ALLOWED_TICKET_ATTACHMENT_MIME_TYPES.includes(file.type)) {
    return 'نوع این فایل پذیرفته نمی‌شود.';
  }

  return null;
}

function buildTicketQuery(query: TicketQuery): string {
  const params = new URLSearchParams();

  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, TICKET_MAX_PAGE_SIZE)));
  }
  if (query.scope) params.set('scope', query.scope);
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.priority) params.set('priority', query.priority);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function listTickets(query: TicketQuery = {}): Promise<PageResult<Ticket>> {
  return coreGet<PageResult<Ticket>>(`/tickets${buildTicketQuery(query)}`);
}

export function getTicket(id: string): Promise<TicketDetail> {
  return coreGet<TicketDetail>(`/tickets/${encodeURIComponent(id)}`);
}

/**
 * Lookup by the quotable tracking number. Still scoped server-side to what the
 * caller may see, so a number alone never grants access.
 */
export function getTicketByTrackingNumber(trackingNumber: string): Promise<TicketDetail> {
  return coreGet<TicketDetail>(`/tickets/tracking/${encodeURIComponent(trackingNumber)}`);
}

/** Files a ticket. `trackingNumber`, `status` and the requester are all server-set. */
export function createTicket(input: {
  type: TicketType;
  subject: string;
  body: string;
  priority?: TicketPriority;
}): Promise<Ticket> {
  return corePost<Ticket>('/tickets', input);
}

export function listTicketComments(
  id: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<PageResult<TicketComment>> {
  const params = new URLSearchParams();
  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, TICKET_MAX_PAGE_SIZE)));
  }
  const serialized = params.toString();

  return coreGet<PageResult<TicketComment>>(
    `/tickets/${encodeURIComponent(id)}/comments${serialized ? `?${serialized}` : ''}`,
  );
}

/**
 * Adds a comment. `isInternal` is agent-only and is REFUSED server-side for a
 * requester rather than silently downgraded, so the UI only ever offers it when
 * `canManage` is true.
 */
export function addTicketComment(
  id: string,
  input: { body: string; isInternal?: boolean; attachmentIds?: string[] },
): Promise<TicketComment> {
  return corePost<TicketComment>(`/tickets/${encodeURIComponent(id)}/comments`, input);
}

export function submitTicketSatisfaction(
  id: string,
  input: { rating: number; comment?: string },
): Promise<TicketSatisfaction> {
  return corePost<TicketSatisfaction>(`/tickets/${encodeURIComponent(id)}/satisfaction`, input);
}

export function getTicketAttachmentDownload(attachmentId: string): Promise<AttachmentDownload> {
  return coreGet<AttachmentDownload>(`/tickets/attachments/${encodeURIComponent(attachmentId)}`);
}

/**
 * Phase 49G-2: uploads one file for a ticket and returns its reference.
 *
 * Only the file itself is sent. No tenant, uploader or storage key crosses the wire:
 * the backend derives the uploader from the authenticated identity, re-checks ticket
 * visibility before storing anything, and mints the storage key itself.
 *
 * The returned attachment is PENDING — inert until a comment claims it via
 * `addTicketComment({ attachmentIds })`.
 */
export function uploadTicketAttachment(
  ticketId: string,
  file: File,
): Promise<PendingTicketAttachment> {
  const form = new FormData();
  form.append('file', file);

  return corePostForm<PendingTicketAttachment>(
    `/tickets/${encodeURIComponent(ticketId)}/attachments`,
    form,
  );
}

/**
 * Agent-only patch. The UI only calls this when the ticket reports `canManage`, and
 * the backend re-checks `admin.support.manage` plus tenant scope regardless — hiding
 * the control is presentation, never authorization.
 */
export function updateTicket(
  id: string,
  input: { assigneeId?: string; priority?: TicketPriority; category?: string },
): Promise<Ticket> {
  return corePatch<Ticket>(`/tickets/${encodeURIComponent(id)}`, input);
}

/**
 * Agent-only lifecycle transition. Only statuses listed in the ticket's
 * `availableTransitions` are offered, so the UI cannot propose a move the server
 * would refuse.
 */
export function changeTicketStatus(
  id: string,
  input: { status: TicketStatus; note?: string },
): Promise<Ticket> {
  return corePatch<Ticket>(`/tickets/${encodeURIComponent(id)}/status`, input);
}

/** Display name for a person. Falls back to a neutral label, never to an email. */
export function ticketUserName(user: TicketUser | null | undefined): string {
  if (!user) return 'تعیین‌نشده';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'کاربر';
}

/**
 * Persian absolute date/time. Deliberately absolute rather than relative: no new
 * date library is introduced and the value stays stable between renders.
 */
export function formatTicketTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/** Persian labels. Kept beside the client so the UI never invents a status name. */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  NEW: 'جدید',
  TRIAGED: 'بررسی اولیه',
  ASSIGNED: 'ارجاع‌شده',
  IN_PROGRESS: 'در حال بررسی',
  WAITING_FOR_REQUESTER: 'در انتظار پاسخ شما',
  RESOLVED: 'حل‌شده',
  CLOSED: 'بسته‌شده',
};

export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  BUG: 'خطای نرم‌افزاری',
  SUPPORT: 'پشتیبانی',
  SUGGESTION: 'پیشنهاد',
  CRITICISM: 'نقد',
  COMPLAINT: 'شکایت',
  FEATURE_REQUEST: 'درخواست قابلیت',
};

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: 'کم',
  NORMAL: 'معمولی',
  HIGH: 'زیاد',
  URGENT: 'فوری',
};

/** True when the requester may still rate the outcome. */
export function canSubmitSatisfaction(ticket: TicketDetail, selfId: string | null): boolean {
  return (
    ticket.satisfaction === null &&
    (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') &&
    ticket.requester.id === selfId
  );
}


