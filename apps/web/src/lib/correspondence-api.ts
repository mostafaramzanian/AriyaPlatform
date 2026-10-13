import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 50: Official Correspondence client.
 *
 * Mirrors the backend contract exactly. No function here accepts a senderId,
 * tenantId, status-on-create or workflow override: the backend derives the actor
 * from the authenticated identity and the letter number from its own counter, and
 * every query DTO runs under `forbidNonWhitelisted`. The client is structurally
 * incapable of acting as someone else, of numbering its own letter, or of forcing a
 * lifecycle state.
 */

export type LetterStatus = 'DRAFT' | 'READY_TO_SEND' | 'SENT' | 'CANCELLED';
export type LetterUrgency = 'NORMAL' | 'IMPORTANT' | 'URGENT' | 'CRITICAL';
export type LetterClassification = 'NORMAL' | 'CONFIDENTIAL' | 'SECRET';
export type RecipientKind = 'TO' | 'CC' | 'BCC';
export type RecipientState =
  | 'DELIVERED'
  | 'VIEWED'
  | 'READ'
  | 'ACTION_REQUIRED'
  | 'REFERRED'
  | 'ACTED';
export type ReferralLevel =
  | 'NORMAL'
  | 'INFORM'
  | 'REVIEW'
  | 'DECIDE'
  | 'EXECUTE'
  | 'FINAL_APPROVE';
export type ReferralStatus = 'PENDING' | 'VIEWED' | 'ACTED';

export interface CorrUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
}

export interface CorrRecipient {
  id: string;
  user: CorrUser;
  kind: RecipientKind;
  state: string;
  deliveredAt: string | null;
  viewedAt: string | null;
  readAt: string | null;
}

export interface CorrLetter {
  id: string;
  letterNumber: string | null;
  subject: string;
  category: string | null;
  urgency: LetterUrgency;
  classification: LetterClassification;
  status: LetterStatus;
  letterDate: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  sender: CorrUser;
  signatureId?: string | null;
  recipients?: CorrRecipient[];
  canSeeBcc?: boolean;
  viewerEdge?: 'SENDER' | 'RECIPIENT' | 'REFERRAL_TARGET' | 'MANAGER' | null;
  viewerState?: string | null;
}

export interface CorrList<T> {
  items: T[];
  hasMore: boolean;
}

export interface CorrReferral {
  id: string;
  letterId: string;
  from: CorrUser;
  to: CorrUser;
  urgency: LetterUrgency;
  level: ReferralLevel;
  instruction: string | null;
  isConfidential: boolean;
  status: ReferralStatus;
  viewedAt: string | null;
  actedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CorrTrackingEvent {
  id: string;
  type: string;
  actor: CorrUser | null;
  recipientUserId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface CorrArchiveFolder {
  id: string;
  name: string;
  parentId: string | null;
  entryCount: number;
  createdAt: string;
  children?: CorrArchiveFolder[];
}

export interface CorrArchiveEntry {
  id: string;
  letterId: string;
  folderId: string | null;
  archivedAt: string;
  removedAt: string | null;
  letter: CorrLetter;
}

export interface CorrAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface CorrLetterContent extends CorrLetter {
  bodyHtml: string;
  attachments: CorrAttachment[];
  canEdit: boolean;
  canSend: boolean;
  canRefer: boolean;
  canArchive: boolean;
  canMarkRead: boolean;
  referralHistoryVisible: boolean;
}

export interface InboxItem {
  source: 'RECIPIENT' | 'REFERRAL';
  itemId: string;
  letter: CorrLetter;
  myState?: string;
  myKind?: string;
  viewedAt?: string | null;
  readAt?: string | null;
  attachmentCount: number;
  referral?: {
    id: string;
    level: ReferralLevel;
    urgency: LetterUrgency;
    instruction: string | null;
    isConfidential: boolean;
    status: ReferralStatus;
    createdAt: string;
    from: CorrUser;
  };
}

// -- Labels (single source of truth for badge rendering) ---------------------

export const URGENCY_LABELS: Record<LetterUrgency, string> = {
  NORMAL: 'عادی',
  IMPORTANT: 'مهم',
  URGENT: 'فوری',
  CRITICAL: 'خیلی فوری',
};

export const CLASSIFICATION_LABELS: Record<LetterClassification, string> = {
  NORMAL: 'عادی',
  CONFIDENTIAL: 'محرمانه',
  SECRET: 'سری',
};

export const STATUS_LABELS: Record<LetterStatus, string> = {
  DRAFT: 'پیش‌نویس',
  READY_TO_SEND: 'آماده ارسال',
  SENT: 'ارسال شده',
  CANCELLED: 'لغو شده',
};

export const RECIPIENT_STATE_LABELS: Record<string, string> = {
  DELIVERED: 'تحویل شده',
  VIEWED: 'مشاهده شده',
  READ: 'خوانده شده',
  ACTION_REQUIRED: 'نیازمند اقدام',
  REFERRED: 'ارجاع شده',
  ACTED: 'اقدام شده',
};

export const REFERRAL_LEVEL_LABELS: Record<ReferralLevel, string> = {
  NORMAL: 'عادی',
  INFORM: 'اطلاع‌رسانی',
  REVIEW: 'بررسی',
  DECIDE: 'تصمیم‌گیری',
  EXECUTE: 'اجرا',
  FINAL_APPROVE: 'تأیید نهایی',
};

export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  PENDING: 'در حال بررسی',
  VIEWED: 'مشاهده شده',
  ACTED: 'اقدام شده',
};

export const TRACKING_EVENT_LABELS: Record<string, string> = {
  CREATED: 'ایجاد',
  SENT: 'ارسال',
  VIEWED: 'مشاهده',
  READ: 'خواندن',
  REFERRED: 'ارجاع',
  REFERRAL_ACTED: 'اقدام روی ارجاع',
  CLASSIFICATION_CHANGED: 'تغییر طبقه‌بندی',
  ARCHIVED: 'بایگانی',
  UNARCHIVED: 'خروج از بایگانی',
};

export const LETTER_CATEGORIES = [
  'مکاتبات اداری',
  'درخواست مرخصی',
  'گزارش مالی',
  'درخواست خرید',
  'اطلاعیه',
  'بخشنامه',
  'سایر',
] as const;

/** Mirrors the backend DTO bounds (letter.dto.ts) so the UI never asks for more. */
export const MAX_SUBJECT_LENGTH = 255;
export const MAX_BODY_LENGTH = 200000;

// -- Shared helpers ----------------------------------------------------------

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export function corrUserName(user: CorrUser | null | undefined): string {
  if (!user) return 'نامشخص';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'کاربر';
}

/** Persian absolute date/time — the same convention as formatSurveyTime (49H). */
export function formatCorrTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function formatCorrDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} بایت`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} کیلوبایت`;
  return `${(size / (1024 * 1024)).toFixed(1)} مگابایت`;
}

/** New idempotency key for send/referral double-click protection. */
export function newCorrKey(): string {
  return `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// -- Drafts / outgoing -------------------------------------------------------

export interface LetterDraftInput {
  subject: string;
  body: string;
  category?: string | null;
  urgency?: LetterUrgency;
  classification?: LetterClassification;
  letterDate?: string | null;
  recipientIds?: string[];
  ccIds?: string[];
  bccIds?: string[];
  letterNumber?: string | null;
  signatureId?: string | null;
  tempAttachmentIds?: string[];
  scheduledAtDate?: string | null;
  scheduledAtTime?: string | null;
}

export async function createDraft(input: LetterDraftInput): Promise<CorrLetter> {
  return corePost<CorrLetter>('/correspondence/drafts', input);
}

export async function updateDraft(
  id: string,
  input: Partial<LetterDraftInput>,
): Promise<CorrLetter> {
  return corePatch<CorrLetter>(`/correspondence/drafts/${encodeURIComponent(id)}`, input);
}

export async function deleteDraft(id: string): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/correspondence/drafts/${encodeURIComponent(id)}`,
  );
}

/** Idempotent via sendKey — a retried click returns the already-sent or scheduled letter. */
export async function sendLetter(
  id: string,
  sendKey?: string,
  scheduledAtDate?: string | null,
  scheduledAtTime?: string | null,
): Promise<CorrLetter> {
  return corePost<CorrLetter>(`/correspondence/drafts/${encodeURIComponent(id)}/send`, {
    sendKey: sendKey ?? null,
    scheduledAtDate: scheduledAtDate ?? null,
    scheduledAtTime: scheduledAtTime ?? null,
  });
}

export async function changeLetterStatus(
  id: string,
  status: 'READY_TO_SEND' | 'DRAFT' | 'CANCELLED',
): Promise<CorrLetter> {
  return corePatch<CorrLetter>(`/correspondence/drafts/${encodeURIComponent(id)}/status`, {
    status,
  });
}

export async function listDrafts(
  query: { cursor?: string; limit?: number; status?: string } = {},
): Promise<CorrList<CorrLetter>> {
  return coreGet<CorrList<CorrLetter>>(`/correspondence/drafts${buildQuery(query)}`);
}

export async function listSent(
  query: { cursor?: string; limit?: number } = {},
): Promise<CorrList<CorrLetter>> {
  return coreGet<CorrList<CorrLetter>>(`/correspondence/sent${buildQuery(query)}`);
}

/** "حذف از لیست" — soft, per-sender; the letter itself is never destroyed. */
export async function removeSentFromList(id: string): Promise<{ removed: true; id: string }> {
  return corePatch<{ removed: true; id: string }>(
    `/correspondence/sent/${encodeURIComponent(id)}/remove`,
    {},
  );
}

// -- Inbox / cartable --------------------------------------------------------

export async function listInbox(
  query: { cursor?: string; limit?: number } = {},
): Promise<CorrList<InboxItem>> {
  return coreGet<CorrList<InboxItem>>(`/correspondence/inbox${buildQuery(query)}`);
}

export async function listReferralInbox(
  query: { cursor?: string; limit?: number } = {},
): Promise<CorrList<InboxItem>> {
  return coreGet<CorrList<InboxItem>>(`/correspondence/inbox/referrals${buildQuery(query)}`);
}

export async function fetchInboxUnreadCount(): Promise<{ count: number }> {
  return coreGet<{ count: number }>('/correspondence/inbox/unread-count');
}

export async function removeInboxItem(letterId: string): Promise<{ removed: boolean; id: string }> {
  return corePatch<{ removed: boolean; id: string }>(
    `/correspondence/inbox/${encodeURIComponent(letterId)}/remove`,
    {},
  );
}

export async function markLetter(
  id: string,
  mark: 'VIEWED' | 'READ',
): Promise<{ id: string; state: string; at: string }> {
  return corePatch<{ id: string; state: string; at: string }>(
    `/correspondence/${encodeURIComponent(id)}/mark`,
    { mark },
  );
}

// -- Detail / tracking -------------------------------------------------------

export async function fetchLetterDetail(id: string): Promise<CorrLetter> {
  return coreGet<CorrLetter>(`/correspondence/${encodeURIComponent(id)}`);
}

export async function fetchLetterContent(id: string): Promise<CorrLetterContent> {
  return coreGet<CorrLetterContent>(`/correspondence/${encodeURIComponent(id)}/content`);
}

export async function fetchTracking(id: string): Promise<CorrTrackingEvent[]> {
  return coreGet<CorrTrackingEvent[]>(`/correspondence/${encodeURIComponent(id)}/tracking`);
}

// -- Referrals ---------------------------------------------------------------

export async function createReferral(
  letterId: string,
  input: {
    toUserId: string;
    level: ReferralLevel;
    urgency?: LetterUrgency;
    instruction?: string | null;
    removeFromInbox?: boolean;
    clientKey?: string | null;
  },
): Promise<CorrReferral> {
  return corePost<CorrReferral>(
    `/correspondence/${encodeURIComponent(letterId)}/referrals`,
    input,
  );
}

export async function listReferrals(letterId: string): Promise<CorrReferral[]> {
  return coreGet<CorrReferral[]>(`/correspondence/${encodeURIComponent(letterId)}/referrals`);
}

export async function updateReferralStatus(
  referralId: string,
  status: ReferralStatus,
): Promise<CorrReferral> {
  return corePatch<CorrReferral>(
    `/correspondence/referrals/${encodeURIComponent(referralId)}/status`,
    { status },
  );
}

// -- Archive -----------------------------------------------------------------

export async function listArchiveFolders(): Promise<CorrArchiveFolder[]> {
  return coreGet<CorrArchiveFolder[]>('/correspondence/archive/folders');
}

export async function createArchiveFolder(input: {
  name: string;
  parentId?: string | null;
}): Promise<CorrArchiveFolder> {
  return corePost<CorrArchiveFolder>('/correspondence/archive/folders', input);
}

export async function renameArchiveFolder(id: string, name: string): Promise<CorrArchiveFolder> {
  return corePatch<CorrArchiveFolder>(`/correspondence/archive/folders/${encodeURIComponent(id)}`, {
    name,
  });
}

export async function deleteArchiveFolder(id: string): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/correspondence/archive/folders/${encodeURIComponent(id)}`,
  );
}

export async function listArchive(
  folderId: string | null,
  query: { cursor?: string; limit?: number } = {},
): Promise<CorrList<CorrArchiveEntry>> {
  const params: Record<string, string | number | undefined> = { ...query };
  if (folderId) params.folderId = folderId;
  return coreGet<CorrList<CorrArchiveEntry>>(`/correspondence/archive${buildQuery(params)}`);
}

export async function archiveLetter(
  letterId: string,
  folderId: string | null,
): Promise<unknown> {
  return corePost(`/correspondence/${encodeURIComponent(letterId)}/archive`, { folderId });
}

export async function unarchiveLetter(letterId: string): Promise<{ removed: true; id: string }> {
  return coreDelete<{ removed: true; id: string }>(
    `/correspondence/${encodeURIComponent(letterId)}/archive`,
  );
}

// -- Search ------------------------------------------------------------------

export interface CorrSearchQuery {
  q?: string;
  letterNumber?: string;
  subject?: string;
  senderId?: string;
  recipientId?: string;
  status?: string;
  urgency?: LetterUrgency;
  classification?: LetterClassification;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachments?: 'any' | 'yes' | 'no';
  confidential?: 'any' | 'yes' | 'no';
  scope?: 'visible' | 'all';
  limit?: number;
  cursor?: string;
}

export async function searchLetters(
  query: CorrSearchQuery,
): Promise<CorrList<CorrLetter & { attachmentCount: number }>> {
  return coreGet<CorrList<CorrLetter & { attachmentCount: number }>>(
    `/correspondence/search${buildQuery(query as Record<string, string | undefined>)}`,
  );
}

// -- Attachments (multipart through the single auth mechanism) ---------------

export async function uploadAttachment(letterId: string, file: File): Promise<CorrAttachment> {
  const { API_ENDPOINT } = await import('./constants');
  const { authenticatedFetch } = await import('./auth-api');
  const { CoreApiError } = await import('./core-http');

  const form = new FormData();
  form.append('letterId', letterId);
  form.append('file', file);

  let response: Response;
  try {
    response = await authenticatedFetch(`${API_ENDPOINT}/correspondence/attachments`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new CoreApiError('نشست شما منقضی شده است. لطفاً دوباره وارد شوید.', 401);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : 'بارگذاری پیوست ناموفق بود.';
    throw new CoreApiError(message, response.status);
  }

  return (body as { data?: CorrAttachment } | null)?.data ?? (body as CorrAttachment);
}

async function multipartPost(path: string, file: File): Promise<unknown> {
  const { API_ENDPOINT } = await import('./constants');
  const { authenticatedFetch } = await import('./auth-api');
  const { CoreApiError } = await import('./core-http');

  const form = new FormData();
  form.append('file', file);

  let response: Response;
  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new CoreApiError('نشست شما منقضی شده است. لطفاً دوباره وارد شوید.', 401);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body &&
      typeof body === 'object' &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : 'بارگذاری فایل ناموفق بود.';
    throw new CoreApiError(message, response.status);
  }

  return (body as { data?: unknown } | null)?.data ?? body;
}

export interface AttachmentDownload {
  url: string;
  fileName: string;
  mimeType: string;
}

/** Metadata listing for one letter — server applies the letter's own read edge. */
export async function listLetterAttachments(letterId: string): Promise<CorrAttachment[]> {
  return coreGet<CorrAttachment[]>(
    `/correspondence/${encodeURIComponent(letterId)}/attachments`,
  );
}

export async function downloadAttachment(attachmentId: string): Promise<AttachmentDownload> {
  return coreGet<AttachmentDownload>(
    `/correspondence/attachments/${encodeURIComponent(attachmentId)}/download`,
  );
}

export async function deleteAttachment(
  attachmentId: string,
): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/correspondence/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export async function uploadTempAttachment(file: File): Promise<CorrAttachment> {
  return multipartPost('/correspondence/attachments/temp', file) as Promise<CorrAttachment>;
}

export interface CorrSignature {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url?: string;
}

export async function uploadSignature(file: File): Promise<CorrSignature> {
  return multipartPost('/correspondence/signatures', file) as Promise<CorrSignature>;
}

export async function downloadSignature(signatureId: string): Promise<{ url: string; fileName: string; mimeType: string }> {
  return coreGet<{ url: string; fileName: string; mimeType: string }>(
    `/correspondence/signatures/${encodeURIComponent(signatureId)}/download`,
  );
}

export async function deleteSignature(signatureId: string): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(
    `/correspondence/signatures/${encodeURIComponent(signatureId)}`,
  );
}