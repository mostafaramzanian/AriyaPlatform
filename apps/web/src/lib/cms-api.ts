import { API_ENDPOINT } from './constants';
import { authenticatedFetch } from './auth-api';

/**
 * Phase 34F: authenticated client for the existing CMS Blog admin contracts.
 *
 * Backend routes reused as-is (apps/api/src/modules/cms/blog/blog.controller.ts):
 *   GET    /blog/admin?status=&cursor=&limit=  (blog.write)
 *   GET    /blog/admin/trash?cursor=&limit=    (blog.write)
 *   GET    /blog/admin/:id                     (blog.write)
 *   POST   /blog                               (blog.write)
 *   PATCH  /blog/:id                           (blog.write)
 *   POST   /blog/:id/publish                   (blog.publish)
 *   POST   /blog/:id/schedule                  (blog.publish)
 *   POST   /blog/:id/archive                   (blog.write)
 *   POST   /blog/:id/restore                   (blog.write)
 *   DELETE /blog/:id                           (blog.delete)
 *
 * No new endpoint, permission or token layer is introduced here: every call
 * goes through the existing `authenticatedFetch` (Bearer + localStorage token)
 * from `auth-api.ts`.
 */

export const BLOG_STATUSES = ['DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;

export type BlogStatus = (typeof BLOG_STATUSES)[number];

/**
 * Shape of one row of GET /blog/admin. Mirrors exactly the `select` used by
 * BlogRepository.list() — `updatedAt` is intentionally absent because the
 * backend list projection does not return it.
 */
export interface AdminBlogListItem {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  publishedAt: string | null;
  status: BlogStatus | string;
  readingTimeMin: number;
  featuredImageId: string | null;
  authorId: string | null;
}

export interface AdminBlogListResult {
  items: AdminBlogListItem[];
  hasMore: boolean;
}

export interface AdminBlogSeoMetadata {
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
}

/** Shape of GET /blog/admin/:id (BlogRepository.findById + relations). */
export interface AdminBlogPost {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt: string | null;
  status: BlogStatus | string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  authorId: string | null;
  readingTimeMin: number;
  featuredImageId: string | null;
  seoMetadata?: AdminBlogSeoMetadata | null;
  categories?: Array<{ categoryId: string }>;
  tags?: Array<{ tagId: string }>;
}

/** Fields of CreateBlogDto that this slice submits. */
export interface MediaAsset {
  id: string;
  name?: string | null;
  mimeType?: string | null;
  type?: string | null;
  size?: number | null;
  url?: string | null;
  path?: string | null;
  uploadedBy?: string | null;
  deletedAt?: string | null;
}

export interface CreateBlogPayload {
  title: string;
  content: string;
  slug?: string;
  excerpt?: string;
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  featuredImageId?: string | null;
}

/**
 * Fields of UpdateBlogDto that BlogService.updatePost() actually applies.
 * SEO fields are accepted by the DTO but ignored by the update path, so they
 * are deliberately not sent from the edit form.
 *
 * `status` is applied by updatePost() but is still validated through
 * isValidTransition(), so it is only used here for the one transition that has
 * no dedicated endpoint: DRAFT → REVIEW.
 */
export interface UpdateBlogPayload {
  title?: string;
  content?: string;
  slug?: string;
  excerpt?: string;
  status?: BlogStatus;
  featuredImageId?: string | null;
  expectedUpdatedAt?: string;
}

/**
 * Fields of PublishBlogDto used by POST /blog/:id/publish.
 *
 * BlogService.publishPost() requires an SEO title: it rejects the request when
 * neither the stored `seoMetadata.metaTitle` nor `dto.metaTitle` is present, so
 * `metaTitle` is sent whenever the post has none yet. `expectedUpdatedAt` is
 * honoured by publishPost() via assertOptimisticLock (409 on mismatch).
 */
export interface PublishBlogPayload {
  metaTitle?: string;
  metaDescription?: string;
  expectedUpdatedAt?: string;
}

/**
 * POST /blog/:id/schedule. The controller only forwards `dto.scheduledAt` to
 * BlogService.schedulePost(), so no other field of PublishBlogDto has any
 * effect on this route — notably `expectedUpdatedAt` is *not* enforced here.
 * `scheduledAt` must be a future ISO-8601 instant (DTO `@IsFutureDate()` plus a
 * second `<= Date.now()` check in the service).
 */
export interface ScheduleBlogPayload {
  scheduledAt: string;
}

export interface ValidationDetail {
  property?: string;
  constraints?: Record<string, string>;
}

export class CmsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ValidationDetail[];

  constructor(status: number, code: string, message: string, details?: ValidationDetail[]) {
    super(message);
    this.name = 'CmsApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

/**
 * The backend uses two shapes depending on whether the failure was produced by
 * StandardExceptionFilter (`{ success, error: { code, message, details } }`)
 * or by a route outside that filter (plain Nest `{ statusCode, message }`).
 * Both are handled so no error surfaces as "undefined".
 */
function toCmsApiError(status: number, body: unknown): CmsApiError {
  const record = (body ?? {}) as Record<string, unknown>;
  const wrapped = record.error as Record<string, unknown> | undefined;

  const code =
    (typeof wrapped?.code === 'string' && wrapped.code) ||
    (typeof record.code === 'string' && record.code) ||
    `HTTP_${status}`;

  const rawMessage = wrapped?.message ?? record.message;
  const message = Array.isArray(rawMessage)
    ? rawMessage.join('، ')
    : typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : defaultMessage(status);

  const rawDetails = (wrapped?.details ?? record.details) as ValidationDetail[] | undefined;
  const details = Array.isArray(rawDetails) ? rawDetails : undefined;

  return new CmsApiError(status, code, message, details);
}

function defaultMessage(status: number): string {
  switch (status) {
    case 401:
      return 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.';
    case 403:
      return 'شما اجازه دسترسی به این بخش را ندارید.';
    case 404:
      return 'موردی یافت نشد.';
    case 409:
      return 'این مطلب توسط کاربر دیگری تغییر کرده است.';
    case 422:
      return 'اطلاعات ارسالی معتبر نیست.';
    default:
      return status >= 500 ? 'خطای سرور. لطفاً بعداً دوباره تلاش کنید.' : 'درخواست ناموفق بود.';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await authenticatedFetch(`${API_ENDPOINT}${path}`, init);
  } catch (err) {
    // authenticatedFetch throws when no valid token is present locally; treat
    // it as an unauthenticated call rather than a network failure.
    if (err instanceof Error && err.message === 'Unauthorized') {
      throw new CmsApiError(401, 'UNAUTHORIZED', defaultMessage(401));
    }
    throw new CmsApiError(0, 'NETWORK_ERROR', 'ارتباط با سرور برقرار نشد.');
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw toCmsApiError(response.status, body);
  }

  const envelope = body as SuccessEnvelope<T>;
  if (!envelope || envelope.data === undefined) {
    throw new CmsApiError(response.status, 'INVALID_RESPONSE', 'ساختار پاسخ سرور نامعتبر است.');
  }
  return envelope.data;
}

export async function listAdminPosts(params: {
  status: BlogStatus;
  cursor?: string;
  limit?: number;
}): Promise<AdminBlogListResult> {
  const query = new URLSearchParams({ status: params.status, limit: String(params.limit ?? 20) });
  if (params.cursor) query.set('cursor', params.cursor);
  return request<AdminBlogListResult>(`/blog/admin?${query.toString()}`);
}

export async function getAdminPost(id: string): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/admin/${encodeURIComponent(id)}`);
}

/**
 * GET /blog/admin/trash (permission `blog.write`).
 *
 * Phase 34H. Archived and soft-deleted posts carry `deletedAt`, and every
 * status list filters `deletedAt: null` — so `listAdminPosts({ status:
 * 'ARCHIVED' })` is structurally always empty and these rows are invisible to
 * every other listing. This is the only listing that returns them, which makes
 * `restorePost` reachable after a page reload instead of only inside the same
 * page session.
 *
 * There is deliberately no `status` parameter: a soft-deleted post keeps
 * whatever status it had (`softDelete()` does not touch `status`), so all
 * statuses are returned together and the row's own `status` distinguishes an
 * archived post from a deleted draft.
 */
export async function listTrashedPosts(
  params: { cursor?: string; limit?: number } = {},
): Promise<AdminBlogListResult> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 20) });
  if (params.cursor) query.set('cursor', params.cursor);
  return request<AdminBlogListResult>(`/blog/admin/trash?${query.toString()}`);
}

export async function uploadMedia(file: File): Promise<MediaAsset> {
  const formData = new FormData();
  formData.append('file', file);

  return request<MediaAsset>('/media', {
    method: 'POST',
    body: formData,
  });
}

export async function getMedia(id: string): Promise<MediaAsset> {
  return request<MediaAsset>(`/media/${encodeURIComponent(id)}`);
}

export async function deleteMedia(id: string): Promise<MediaAsset> {
  return request<MediaAsset>(`/media/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function createPost(payload: CreateBlogPayload): Promise<AdminBlogPost> {
  return request<AdminBlogPost>('/blog', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updatePost(id: string, payload: UpdateBlogPayload): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * POST /blog/:id/publish (permission `blog.publish`).
 *
 * BlogService.isValidTransition() only accepts PUBLISHED from REVIEW,
 * SCHEDULED or PUBLISHED itself, so this must not be offered on a DRAFT —
 * see `canPublish()` below.
 */
export async function publishPost(
  id: string,
  payload: PublishBlogPayload = {},
): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /blog/:id/schedule (permission `blog.publish`). */
export async function schedulePost(
  id: string,
  payload: ScheduleBlogPayload,
): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}/schedule`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * POST /blog/:id/archive (permission `blog.write`).
 *
 * BlogRepository.archive() sets `status = ARCHIVED` *and* `deletedAt = now()`,
 * so an archived post is also soft-deleted: GET /blog/admin/:id then returns
 * 404 (getAdminPost rejects `deletedAt`) and only `restorePost` can bring it
 * back. The UI must therefore leave the edit page after archiving.
 */
export async function archivePost(id: string): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });
}

/**
 * POST /blog/:id/restore (permission `blog.write`).
 *
 * BlogRepository.restore() only clears `deletedAt`; it does not change
 * `status`. A restored post therefore keeps the status it had when it was
 * archived/deleted (ARCHIVED after archive, unchanged after delete).
 */
export async function restorePost(id: string): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
  });
}

/**
 * DELETE /blog/:id (permission `blog.delete`). Soft delete: BlogService
 * .deletePost() sets `deletedAt` and leaves `status` untouched, so the post
 * disappears from every admin status list (all list queries filter
 * `deletedAt: null`) but is still restorable by id.
 */
export async function deletePost(id: string): Promise<AdminBlogPost> {
  return request<AdminBlogPost>(`/blog/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * Client-side mirror of BlogService.isValidTransition() so the UI only offers
 * transitions the backend actually accepts:
 *
 *   DRAFT     → REVIEW
 *   REVIEW    → SCHEDULED | PUBLISHED
 *   SCHEDULED → PUBLISHED
 *   PUBLISHED → ARCHIVED
 *   X         → X (no-op)
 *
 * Nothing else is allowed; in particular DRAFT → PUBLISHED and
 * DRAFT → SCHEDULED are rejected with 400 by the API.
 */
export function isValidBlogTransition(from: string | null | undefined, to: string): boolean {
  if (!from) return to === 'DRAFT';
  if (from === to) return true;
  if (from === 'DRAFT' && to === 'REVIEW') return true;
  if (from === 'REVIEW' && (to === 'SCHEDULED' || to === 'PUBLISHED')) return true;
  if (from === 'SCHEDULED' && to === 'PUBLISHED') return true;
  if (from === 'PUBLISHED' && to === 'ARCHIVED') return true;
  return false;
}

/** Publish is only reachable from REVIEW or SCHEDULED (PUBLISHED is a no-op). */
export function canPublish(status: string | null | undefined): boolean {
  return status === 'REVIEW' || status === 'SCHEDULED';
}

/** Schedule is only reachable from REVIEW (or SCHEDULED itself, as a re-schedule). */
export function canSchedule(status: string | null | undefined): boolean {
  return status === 'REVIEW' || status === 'SCHEDULED';
}

/** Archive is only reachable from PUBLISHED (archivePost also rejects ARCHIVED). */
export function canArchive(status: string | null | undefined): boolean {
  return status === 'PUBLISHED';
}

/** `DRAFT → REVIEW` is done through PATCH /blog/:id with `status`. */
export function canSendToReview(status: string | null | undefined): boolean {
  return status === 'DRAFT';
}

/**
 * The global ValidationPipe runs with `forbidNonWhitelisted` and DTO-level
 * `@IsUrl()`/`@MaxLength()` rules, so empty optional strings must be dropped
 * instead of sent as `''`.
 */
export function omitEmpty<T extends Record<string, unknown>>(payload: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    result[key] = value;
  }
  return result as T;
}

export function formatAdminDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

export const BLOG_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'پیش‌نویس',
  REVIEW: 'در بازبینی',
  SCHEDULED: 'زمان‌بندی‌شده',
  PUBLISHED: 'منتشرشده',
  ARCHIVED: 'بایگانی‌شده',
};
