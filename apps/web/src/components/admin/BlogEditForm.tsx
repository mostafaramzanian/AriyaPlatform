'use client';

import * as React from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { FeaturedImagePicker } from './FeaturedImagePicker';
import {
  AdminBlogPost,
  BLOG_STATUS_LABELS,
  CmsApiError,
  archivePost,
  canArchive,
  canPublish,
  canSchedule,
  canSendToReview,
  deletePost,
  formatAdminDate,
  getAdminPost,
  omitEmpty,
  publishPost,
  restorePost,
  schedulePost,
  updatePost,
} from '@/lib/cms-api';

/**
 * Editable fields are only the ones BlogService.updatePost() actually applies:
 * title, slug, content, excerpt. SEO writes through PATCH are still out of
 * scope (updatePost ignores them); the SEO title input below exists solely
 * because publishPost() requires one.
 *
 * `expectedUpdatedAt` is sent from the loaded record, so the existing backend
 * optimistic lock (409 CONFLICT in assertOptimisticLock) protects against
 * silently overwriting newer server state.
 *
 * Workflow actions are gated by the real backend state machine
 * (BlogService.isValidTransition), mirrored in `canPublish`/`canSchedule`/
 * `canArchive`/`canSendToReview`:
 *   DRAFT     → REVIEW      (PATCH /blog/:id, no dedicated endpoint exists)
 *   REVIEW    → SCHEDULED   (POST /blog/:id/schedule)
 *   REVIEW    → PUBLISHED   (POST /blog/:id/publish)
 *   SCHEDULED → PUBLISHED   (POST /blog/:id/publish)
 *   PUBLISHED → ARCHIVED    (POST /blog/:id/archive)
 * DRAFT → PUBLISHED is rejected by the backend, so no Publish control is
 * rendered for a draft.
 */
type WorkflowAction = 'review' | 'publish' | 'schedule' | 'archive' | 'delete' | 'restore';

/** Explains which transitions the backend accepts from the current status. */
function workflowHint(status: string): string {
  switch (status) {
    case 'DRAFT':
      return 'پیش‌نویس ابتدا باید برای بازبینی ارسال شود؛ انتشار مستقیم پیش‌نویس در سرور مجاز نیست.';
    case 'REVIEW':
      return 'این مطلب آماده انتشار یا زمان‌بندی است.';
    case 'SCHEDULED':
      return 'مطلب زمان‌بندی شده است و می‌توانید آن را همین حالا منتشر یا زمان آن را تغییر دهید.';
    case 'PUBLISHED':
      return 'مطلب منتشر شده است؛ تنها گذار مجاز، بایگانی است.';
    case 'ARCHIVED':
      return 'مطلب بایگانی شده است.';
    default:
      return 'گذار مجاز دیگری برای این وضعیت وجود ندارد.';
  }
}

export function BlogEditForm({ id }: { id: string }) {
  const [post, setPost] = React.useState<AdminBlogPost | null>(null);
  const [values, setValues] = React.useState({ title: '', slug: '', content: '', excerpt: '' });
  const [featuredImageId, setFeaturedImageId] = React.useState<string | null>(null);
  const [metaTitle, setMetaTitle] = React.useState('');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [loadError, setLoadError] = React.useState<CmsApiError | null>(null);
  const [saveError, setSaveError] = React.useState<CmsApiError | null>(null);
  const [isSaved, setIsSaved] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<WorkflowAction | null>(null);
  const [actionError, setActionError] = React.useState<CmsApiError | null>(null);
  const [actionNotice, setActionNotice] = React.useState<string | null>(null);
  // Archive sets `deletedAt` as well as `status = ARCHIVED`, and delete is a
  // soft delete: in both cases GET /blog/admin/:id starts returning 404, so the
  // form is replaced by a short-lived restore panel.
  const [removed, setRemoved] = React.useState<'archived' | 'deleted' | null>(null);

  const applyPost = React.useCallback((loaded: AdminBlogPost) => {
    setPost(loaded);
    setValues({
      title: loaded.title ?? '',
      slug: loaded.slug ?? '',
      content: loaded.content ?? '',
      excerpt: loaded.excerpt ?? '',
    });
    setFeaturedImageId(loaded.featuredImageId ?? null);
    setMetaTitle(loaded.seoMetadata?.metaTitle ?? '');
  }, []);

  // Loading/error re-arm for record changes lives here — synchronously during
  // render, guarded by the previous id — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect below only settles. The
  // initial `useState` values already arm the first load (isLoading: true).
  const [prevId, setPrevId] = React.useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setIsLoading(true);
    setLoadError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    getAdminPost(id)
      .then((loaded) => {
        if (!cancelled) applyPost(loaded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof CmsApiError
            ? err
            : new CmsApiError(0, 'UNKNOWN', 'بارگذاری مطلب ناموفق بود.'),
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, applyPost]);

  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) {
    const { name, value } = event.target;
    setIsSaved(false);
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError(null);
    setIsSaved(false);
    setIsSubmitting(true);
    try {
      const updated = await updatePost(
        id,
        omitEmpty({
          title: values.title,
          slug: values.slug,
          content: values.content,
          excerpt: values.excerpt,
          featuredImageId: featuredImageId ?? null,
          expectedUpdatedAt: post?.updatedAt ?? undefined,
        }),
      );
      // Re-read the authoritative record so the next save carries a fresh
      // expectedUpdatedAt instead of the now-stale one.
      const fresh = await getAdminPost(updated.id ?? id).catch(() => updated);
      applyPost(fresh);
      setIsSaved(true);
    } catch (err) {
      setSaveError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'به‌روزرسانی مطلب ناموفق بود.'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function reloadFromServer() {
    setSaveError(null);
    setActionError(null);
    setIsLoading(true);
    try {
      applyPost(await getAdminPost(id));
    } catch (err) {
      setLoadError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'بارگذاری مطلب ناموفق بود.'),
      );
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Every workflow call runs through here so a 401/403/404/409/400 from the
   * server is surfaced instead of being swallowed: the frontend has no
   * permission metadata, so authorization is only ever decided by the API.
   */
  async function runAction(
    action: WorkflowAction,
    call: () => Promise<unknown>,
    options: { notice: string; refresh: boolean; removes?: 'archived' | 'deleted' },
  ) {
    setActionError(null);
    setActionNotice(null);
    setIsSaved(false);
    setPendingAction(action);
    try {
      await call();
      setActionNotice(options.notice);
      if (options.removes) {
        setRemoved(options.removes);
      } else if (options.refresh) {
        applyPost(await getAdminPost(id));
      }
    } catch (err) {
      setActionError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'انجام این عملیات ناموفق بود.'),
      );
    } finally {
      setPendingAction(null);
    }
  }

  function handleSendToReview() {
    return runAction(
      'review',
      () =>
        updatePost(id, {
          status: 'REVIEW',
          expectedUpdatedAt: post?.updatedAt ?? undefined,
        }),
      { notice: 'مطلب برای بازبینی ارسال شد.', refresh: true },
    );
  }

  function handlePublish() {
    // publishPost() rejects the request when neither the stored SEO title nor
    // dto.metaTitle exists, so the local value is sent when the post has none.
    const payload = omitEmpty({
      metaTitle: post?.seoMetadata?.metaTitle ? undefined : metaTitle,
      expectedUpdatedAt: post?.updatedAt ?? undefined,
    });
    return runAction('publish', () => publishPost(id, payload), {
      notice: 'مطلب منتشر شد.',
      refresh: true,
    });
  }

  function handleSchedule() {
    // `datetime-local` yields a local wall-clock string; the DTO requires an
    // ISO-8601 instant strictly in the future.
    const parsed = new Date(scheduledAt);
    if (!scheduledAt || Number.isNaN(parsed.getTime())) {
      setActionNotice(null);
      setActionError(new CmsApiError(0, 'INVALID_INPUT', 'زمان انتشار را مشخص کنید.'));
      return Promise.resolve();
    }
    if (parsed.getTime() <= Date.now()) {
      setActionNotice(null);
      setActionError(
        new CmsApiError(0, 'INVALID_INPUT', 'زمان انتشار باید در آینده باشد.'),
      );
      return Promise.resolve();
    }
    return runAction('schedule', () => schedulePost(id, { scheduledAt: parsed.toISOString() }), {
      notice: 'زمان انتشار ثبت شد.',
      refresh: true,
    });
  }

  function handleArchive() {
    if (!window.confirm('این مطلب بایگانی شود؟ پس از بایگانی از سایت حذف می‌شود.')) return;
    // BlogRepository.archive() also stamps `deletedAt`, so the record is no
    // longer readable through GET /blog/admin/:id afterwards.
    void runAction('archive', () => archivePost(id), {
      notice: 'مطلب بایگانی شد.',
      refresh: false,
      removes: 'archived',
    });
  }

  function handleDelete() {
    if (!window.confirm('این مطلب حذف شود؟ حذف قابل بازگردانی است.')) return;
    void runAction('delete', () => deletePost(id), {
      notice: 'مطلب حذف شد.',
      refresh: false,
      removes: 'deleted',
    });
  }

  async function handleRestore() {
    setActionError(null);
    setActionNotice(null);
    setPendingAction('restore');
    try {
      await restorePost(id);
      // restore() only clears `deletedAt`; the status is whatever it was before,
      // so the authoritative record is re-read rather than assumed.
      applyPost(await getAdminPost(id));
      setRemoved(null);
      setActionNotice('مطلب بازگردانی شد.');
    } catch (err) {
      setActionError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'بازگردانی مطلب ناموفق بود.'),
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (isLoading) {
    return (
      <div className="card-panel p-8 text-center" role="status" aria-live="polite">
        <p className="text-sm text-muted-foreground">در حال بارگذاری مطلب...</p>
      </div>
    );
  }

  if (loadError) {
    const message =
      loadError.status === 404 ? 'این مطلب یافت نشد یا حذف شده است.' : loadError.message;
    return (
      <div className="space-y-4">
        <Alert type={loadError.status === 403 ? 'warning' : 'error'} message={message} />
        <Link href="/admin/blog" className="btn-secondary inline-flex">
          بازگشت به فهرست
        </Link>
      </div>
    );
  }

  // Archive and delete both stamp `deletedAt`, after which GET /blog/admin/:id
  // returns 404 — the record is only reachable through POST /blog/:id/restore.
  if (removed) {
    return (
      <div className="space-y-4">
        <Alert
          type="success"
          message={removed === 'archived' ? 'مطلب بایگانی شد.' : 'مطلب حذف شد.'}
        />
        {actionError && (
          <Alert
            type={actionError.status === 403 ? 'warning' : 'error'}
            message={actionError.message}
          />
        )}
        <div className="card-panel space-y-3 p-4 text-sm">
          <p className="text-muted-foreground">
            این مطلب دیگر در فهرست مدیریت و در سایت نمایش داده نمی‌شود. در صورت نیاز می‌توانید آن را
            بازگردانی کنید.
          </p>
          <div className="flex items-center gap-3">
            <Button type="button" onClick={handleRestore} disabled={pendingAction !== null}>
              {pendingAction === 'restore' ? 'در حال بازگردانی...' : 'بازگردانی مطلب'}
            </Button>
            <Link href="/admin/blog" className="btn-secondary">
              بازگشت به فهرست
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!post) return null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/blog" className="text-sm text-primary hover:underline">
          ← بازگشت به فهرست
        </Link>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">ویرایش مطلب</h1>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt>وضعیت:</dt>
            <dd>{BLOG_STATUS_LABELS[post.status] ?? post.status}</dd>
          </div>
          <div className="flex gap-1">
            <dt>آخرین به‌روزرسانی:</dt>
            <dd>{formatAdminDate(post.updatedAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>تاریخ انتشار:</dt>
            <dd>{formatAdminDate(post.publishedAt)}</dd>
          </div>
        </dl>
      </div>

      {isSaved && <Alert type="success" message="تغییرات ذخیره شد." />}

      {actionNotice && <Alert type="success" message={actionNotice} />}

      {actionError && (
        <Alert
          type={actionError.status === 403 ? 'warning' : 'error'}
          message={actionError.message}
        />
      )}

      <section className="card-panel space-y-4 p-4 md:p-6" aria-labelledby="workflow-heading">
        <h2 id="workflow-heading" className="text-sm font-semibold text-foreground">
          گردش کار انتشار
        </h2>
        <p className="text-xs text-muted-foreground">
          {workflowHint(post.status)}
        </p>

        {canPublish(post.status) && !post.seoMetadata?.metaTitle && (
          <Input
            label="عنوان سئو (برای انتشار لازم است)"
            name="metaTitle"
            id="metaTitle"
            value={metaTitle}
            onChange={(event) => setMetaTitle(event.target.value)}
            maxLength={60}
            disabled={pendingAction !== null}
          />
        )}

        {canSchedule(post.status) && (
          <Input
            label="زمان انتشار"
            name="scheduledAt"
            id="scheduledAt"
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
            disabled={pendingAction !== null}
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          {canSendToReview(post.status) && (
            <Button type="button" onClick={handleSendToReview} disabled={pendingAction !== null}>
              {pendingAction === 'review' ? 'در حال ارسال...' : 'ارسال برای بازبینی'}
            </Button>
          )}

          {canPublish(post.status) && (
            <Button type="button" onClick={handlePublish} disabled={pendingAction !== null}>
              {pendingAction === 'publish' ? 'در حال انتشار...' : 'انتشار'}
            </Button>
          )}

          {canSchedule(post.status) && (
            <Button type="button" onClick={handleSchedule} disabled={pendingAction !== null}>
              {pendingAction === 'schedule' ? 'در حال زمان‌بندی...' : 'زمان‌بندی انتشار'}
            </Button>
          )}

          {canArchive(post.status) && (
            <Button
              type="button"
              onClick={handleArchive}
              disabled={pendingAction !== null}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {pendingAction === 'archive' ? 'در حال بایگانی...' : 'بایگانی'}
            </Button>
          )}

          <Button
            type="button"
            onClick={handleDelete}
            disabled={pendingAction !== null}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pendingAction === 'delete' ? 'در حال حذف...' : 'حذف'}
          </Button>
        </div>
      </section>

      {saveError && (
        <Alert type={saveError.status === 403 ? 'warning' : 'error'} message={saveError.message} />
      )}

      {saveError?.status === 409 && (
        <div className="card-panel space-y-3 p-4 text-sm">
          <p className="text-muted-foreground">
            برای جلوگیری از بازنویسی تغییرات دیگران، ابتدا نسخه جدید سرور را بارگذاری کنید.
          </p>
          <Button type="button" onClick={reloadFromServer} disabled={isSubmitting}>
            بارگذاری نسخه جدید
          </Button>
        </div>
      )}

      {saveError?.details && saveError.details.length > 0 && (
        <ul className="card-panel space-y-1 p-4 text-sm text-destructive">
          {saveError.details.map((detail, index) => (
            <li key={`${detail.property ?? 'field'}-${index}`}>
              {detail.property}: {Object.values(detail.constraints ?? {}).join('، ')}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="card-panel space-y-5 p-6 md:p-8">
        <Input
          label="عنوان"
          name="title"
          id="title"
          value={values.title}
          onChange={handleChange}
          required
          minLength={5}
          maxLength={200}
          disabled={isSubmitting}
        />

        <Input
          label="نامک"
          name="slug"
          id="slug"
          value={values.slug}
          onChange={handleChange}
          maxLength={120}
          disabled={isSubmitting}
        />

        <Textarea
          label="محتوا (Markdown)"
          name="content"
          id="content"
          value={values.content}
          onChange={handleChange}
          required
          minLength={20}
          rows={14}
          disabled={isSubmitting}
        />

        <Textarea
          label="خلاصه"
          name="excerpt"
          id="excerpt"
          value={values.excerpt}
          onChange={handleChange}
          maxLength={500}
          rows={3}
          disabled={isSubmitting}
        />

        <FeaturedImagePicker value={featuredImageId} onChange={setFeaturedImageId} />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'در حال ذخیره...' : 'ذخیره تغییرات'}
          </Button>
          <Link href="/admin/blog" className="btn-secondary">
            بازگشت
          </Link>
        </div>
      </form>
    </div>
  );
}
