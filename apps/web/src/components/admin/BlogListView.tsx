'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  AdminBlogListItem,
  BLOG_STATUSES,
  BLOG_STATUS_LABELS,
  BlogStatus,
  CmsApiError,
  archivePost,
  canArchive,
  deletePost,
  formatAdminDate,
  listAdminPosts,
  listTrashedPosts,
  restorePost,
} from '@/lib/cms-api';

/**
 * GET /blog/admin requires an explicit `status` (the backend rejects anything
 * outside the enum and exposes no "ALL" value), so a valid status must always
 * be selected. DRAFT is the default because BlogService.createPost() always
 * creates posts as DRAFT — this is the status an editor lands on after
 * creating content.
 */
const DEFAULT_STATUS: BlogStatus = 'DRAFT';

/**
 * Phase 34H: an extra pseudo-status for the same filter control, backed by
 * GET /blog/admin/trash instead of GET /blog/admin?status=.
 *
 * It is not a real BlogStatus. Archive stamps `deletedAt` alongside
 * `status = ARCHIVED` and delete stamps `deletedAt` alone, so those rows leave
 * every `status`-based list (all of which filter `deletedAt: null`) —
 * `status=ARCHIVED` is therefore always empty in practice. This view is the
 * only place a removed post can be found and restored after a page reload.
 */
const TRASH_VIEW = 'TRASH' as const;

type ListView = BlogStatus | typeof TRASH_VIEW;

const statusOptions = [
  ...BLOG_STATUSES.map((value) => ({
    value: value as string,
    label: BLOG_STATUS_LABELS[value] ?? value,
  })),
  { value: TRASH_VIEW, label: 'بایگانی/حذف‌شده (قابل بازگردانی)' },
];

/**
 * Only the payload-free workflow actions are exposed inline. Publish and
 * schedule stay on the edit page because publishPost() needs an SEO title and
 * schedulePost() needs a future `scheduledAt`, neither of which is present in
 * the admin list projection.
 *
 * `restore` is only offered in the trash view, since POST /blog/:id/restore
 * rejects a post that is not soft-deleted with 400.
 */
type RowAction = 'archive' | 'delete' | 'restore';

export function BlogListView() {
  const [view, setView] = React.useState<ListView>(DEFAULT_STATUS);
  const [items, setItems] = React.useState<AdminBlogListItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // Cursor stack: index i holds the cursor used to fetch page i (undefined = first page).
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<CmsApiError | null>(null);
  // Re-arms loading/cleared in the retry/row-action handler (same commit as
  // the token bump); filter and pagination handlers re-arm directly below, so
  // the fetch effect needs no in-effect setter resets. First mount is covered
  // by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [pending, setPending] = React.useState<{ id: string; action: RowAction } | null>(null);
  const [actionError, setActionError] = React.useState<CmsApiError | null>(null);
  const [actionNotice, setActionNotice] = React.useState<string | null>(null);

  const currentCursor = cursors[cursors.length - 1];
  const isTrashView = view === TRASH_VIEW;

  React.useEffect(() => {
    let cancelled = false;

    // The trash view uses a different endpoint (GET /blog/admin/trash), because
    // GET /blog/admin?status= can only ever return rows with `deletedAt: null`.
    const load =
      view === TRASH_VIEW
        ? listTrashedPosts({ cursor: currentCursor })
        : listAdminPosts({ status: view, cursor: currentCursor });

    load
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setHasMore(result.hasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setHasMore(false);
        setError(
          err instanceof CmsApiError
            ? err
            : new CmsApiError(0, 'UNKNOWN', 'بارگذاری فهرست مطالب ناموفق بود.'),
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [view, currentCursor, reloadToken]);

  function handleStatusChange(next: string) {
    setView(next as ListView);
    setCursors([undefined]);
    setActionError(null);
    setActionNotice(null);
    // Same-commit re-arm that the removed in-effect setters used to provide.
    setIsLoading(true);
    setError(null);
  }

  /**
   * Archive/delete both soft-delete the row, so it leaves every admin status
   * list and appears in the trash view; restore does the reverse. The list is
   * re-fetched afterwards rather than mutated in place, which also keeps
   * `hasMore` and the cursor page honest.
   */
  async function runRowAction(
    post: AdminBlogListItem,
    action: RowAction,
    call: () => Promise<unknown>,
    notice: string,
  ) {
    setActionError(null);
    setActionNotice(null);
    setPending({ id: post.id, action });
    try {
      await call();
      setActionNotice(notice);
      reload();
    } catch (err) {
      setActionError(
        err instanceof CmsApiError
          ? err
          : new CmsApiError(0, 'UNKNOWN', 'انجام این عملیات ناموفق بود.'),
      );
    } finally {
      setPending(null);
    }
  }

  function handleArchive(post: AdminBlogListItem) {
    if (!window.confirm(`«${post.title}» بایگانی شود؟ پس از بایگانی از سایت حذف می‌شود.`)) return;
    void runRowAction(post, 'archive', () => archivePost(post.id), 'مطلب بایگانی شد.');
  }

  function handleDelete(post: AdminBlogListItem) {
    if (!window.confirm(`«${post.title}» حذف شود؟ حذف قابل بازگردانی است.`)) return;
    void runRowAction(post, 'delete', () => deletePost(post.id), 'مطلب حذف شد.');
  }

  /**
   * POST /blog/:id/restore only clears `deletedAt`; it never changes `status`.
   * The row therefore returns to whatever status it had (ARCHIVED after an
   * archive, the original status after a delete) and leaves this view, so the
   * list is re-fetched instead of being patched locally.
   */
  function handleRestore(post: AdminBlogListItem) {
    if (!window.confirm(`«${post.title}» بازگردانی شود؟`)) return;
    void runRowAction(post, 'restore', () => restorePost(post.id), 'مطلب بازگردانی شد.');
  }

  function goNext() {
    const last = items[items.length - 1];
    if (!last) return;
    setCursors((prev) => [...prev, last.id]);
    setIsLoading(true);
    setError(null);
  }

  function goPrevious() {
    setCursors((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    setIsLoading(true);
    setError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">مدیریت وبلاگ</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isTrashView
              ? 'مطالب بایگانی‌شده و حذف‌شده — قابل بازگردانی'
              : 'فهرست مطالب بر اساس وضعیت انتخاب‌شده'}
          </p>
        </div>
        <Link href="/admin/blog/new" className="btn-primary">
          مطلب جدید
        </Link>
      </div>

      <div className="max-w-xs">
        <Select
          label="وضعیت"
          name="status"
          id="status"
          value={view}
          options={statusOptions}
          onChange={(event) => handleStatusChange(event.target.value)}
          disabled={isLoading}
        />
      </div>

      {error && (
        <Alert type={error.status === 403 ? 'warning' : 'error'} message={error.message} />
      )}

      {actionNotice && <Alert type="success" message={actionNotice} />}

      {actionError && (
        <Alert
          type={actionError.status === 403 ? 'warning' : 'error'}
          message={
            actionError.status === 404 ? 'این مطلب یافت نشد یا پیش‌تر حذف شده است.' : actionError.message
          }
        />
      )}

      {isLoading && (
        <div className="card-panel p-8 text-center" role="status" aria-live="polite">
          <p className="text-sm text-muted-foreground">در حال بارگذاری مطالب...</p>
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="card-panel p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {isTrashView
              ? 'مطلب بایگانی‌شده یا حذف‌شده‌ای وجود ندارد.'
              : `مطلبی با وضعیت «${BLOG_STATUS_LABELS[view] ?? view}» یافت نشد.`}
          </p>
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <div className="card-panel overflow-x-auto p-0">
          <table className="w-full text-right text-sm">
            <caption className="sr-only">فهرست مطالب وبلاگ</caption>
            <thead className="border-b border-border/70 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">عنوان</th>
                <th scope="col" className="px-4 py-3 font-medium">نامک</th>
                <th scope="col" className="px-4 py-3 font-medium">وضعیت</th>
                <th scope="col" className="px-4 py-3 font-medium">تاریخ انتشار</th>
                <th scope="col" className="px-4 py-3 font-medium">مدت مطالعه</th>
                <th scope="col" className="px-4 py-3 font-medium">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {items.map((post) => (
                <tr key={post.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">{post.title}</td>
                  <td className="px-4 py-3 text-muted-foreground">{post.slug}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {BLOG_STATUS_LABELS[post.status] ?? post.status}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatAdminDate(post.publishedAt)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{post.readingTimeMin} دقیقه</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {/*
                        In the trash view the row is soft-deleted, so
                        GET /blog/admin/:id returns 404 and the edit page cannot
                        load it; archive/delete are rejected as well
                        ("Cannot archive deleted post" / "Post already
                        deleted"). Restore is the only action the backend
                        accepts, so it is the only one offered.
                      */}
                      {isTrashView ? (
                        <button
                          type="button"
                          onClick={() => handleRestore(post)}
                          disabled={pending !== null}
                          className="text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
                        >
                          {pending?.id === post.id && pending.action === 'restore'
                            ? 'در حال بازگردانی...'
                            : 'بازگردانی'}
                        </button>
                      ) : (
                        <>
                          <Link
                            href={`/admin/blog/${post.id}/edit`}
                            className="text-primary hover:underline"
                          >
                            ویرایش
                          </Link>

                          {canArchive(post.status) && (
                            <button
                              type="button"
                              onClick={() => handleArchive(post)}
                              disabled={pending !== null}
                              className="text-warning hover:underline disabled:pointer-events-none disabled:opacity-50"
                            >
                              {pending?.id === post.id && pending.action === 'archive'
                                ? 'در حال بایگانی...'
                                : 'بایگانی'}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => handleDelete(post)}
                            disabled={pending !== null}
                            className="text-destructive hover:underline disabled:pointer-events-none disabled:opacity-50"
                          >
                            {pending?.id === post.id && pending.action === 'delete'
                              ? 'در حال حذف...'
                              : 'حذف'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && (cursors.length > 1 || hasMore) && (
        <div className="flex items-center justify-between gap-3">
          <Button type="button" onClick={goPrevious} disabled={cursors.length === 1 || isLoading}>
            صفحه قبل
          </Button>
          <span className="text-xs text-muted-foreground">صفحه {cursors.length}</span>
          <Button type="button" onClick={goNext} disabled={!hasMore || isLoading}>
            صفحه بعد
          </Button>
        </div>
      )}
    </div>
  );
}
