'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { Button } from '@/components/ui/button';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_DOCUMENT_STATUSES,
  COMMERCE_MAX_PAGE_SIZE,
  fetchCommercePurchaseDocuments,
  type CommerceDocumentStatus,
  type CommercePurchasePage,
} from '@/lib/commerce-api';
import {
  commerceDateLabel,
  commerceDisplayName,
  commerceDocumentStatusLabel,
  commerceMoneyLabel,
} from '@/lib/commerce-labels';
import {
  CommerceCard,
  CommerceDocumentStatusBadge,
  CommerceEmptyState,
  CommercePageHeading,
  CommercePagination,
} from './commerce-ui';

/**
 * PHASE UI-1: the purchase register — `/admin/commerce/purchases`.
 *
 * ONLY THE FILTERS THE ROUTE SUPPORTS. `GET /commerce/purchase-documents` takes `page`,
 * `pageSize`, `search` (matched against the document NUMBER — the DTO says exactly that)
 * and `status`; the UI therefore offers search, a status select and the page window, and
 * NOTHING else. No date range, no requester picker and no sort control exist, because the
 * contract has none — and a client-side filter over one page would silently describe a
 * subset while looking like the whole register (UI-0 §9).
 *
 * ROWS OPEN THE DETAIL. UI-2 shipped `/admin/commerce/purchases/[id]` and `/…/new`, so the
 * register's document number is a real link to the document (and a create CTA appears for
 * `commerce.manage` holders) — the UI-1 note that a link would point nowhere no longer
 * holds; a row that does not open its document is now the broken promise.
 *
 * REFETCH KEEPS THE CONTEXT. Filters and the page live in state across failures, an
 * in-place refetch keeps the previous rows visible (with `aria-busy`) instead of blanking
 * the table, and the retry button re-runs the same request rather than resetting anything.
 */

interface PurchaseListData {
  page: CommercePurchasePage;
}

const PAGE_SIZE_OPTIONS = [COMMERCE_DEFAULT_PAGE_SIZE, 50, COMMERCE_MAX_PAGE_SIZE];

export function CommercePurchaseListView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');
  const canManage = rbac.permissions.includes('commerce.manage');

  const [statusFilter, setStatusFilter] = React.useState<CommerceDocumentStatus | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(COMMERCE_DEFAULT_PAGE_SIZE);

  const [data, setData] = React.useState<PurchaseListData | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in every retry/filter handler (same commit as the
  // token bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route demands;
    // retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchCommercePurchaseDocuments({
      page,
      pageSize,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(appliedSearch ? { search: appliedSearch } : {}),
    })
      .then((result) => {
        if (!active) return;
        setData({ page: result });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, statusFilter, appliedSearch, page, pageSize, reloadToken]);

  const hasActiveFilters = statusFilter !== '' || appliedSearch !== '';
  // Whether a request cycle is meaningfully in flight. `isLoading` covers retries
  // and re-submits (armed by the hook above, settled by the fetch effect); the
  // derived term covers the FIRST load, where no handler ever arms it: once the
  // gate has settled and neither data nor error has arrived, the view is by
  // definition waiting for its first response. This replaces the previous
  // in-effect `setLoading(true)` reset (`react-hooks/set-state-in-effect`): the
  // effect body now only settles.
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead;
  const busy = isLoading || (gateSettled && data === null && error === null);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedSearch(searchInput.trim());
    setPage(1);
    // Unconditional bump: re-submitting the same query must still ask again.
    reload();
  };

  const clearFilters = () => {
    setStatusFilter('');
    setSearchInput('');
    setAppliedSearch('');
    setPage(1);
    reload();
  };

  if (rbac.isLoading) {
    return <CoreLoading lines={5} />;
  }

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ درخواست‌های خرید به مجوز commerce.read نیاز دارید." />
    );
  }

  // Identical truth table to `isLoading && data === null` (busy is false once an
  // error lands or during in-place refetch that keeps previous rows visible).
  const showInitialLoading = busy && data === null;
  const documents = data?.page.items ?? [];
  const emptyMessage = hasActiveFilters
    ? 'درخواستی با این فیلترها یافت نشد.'
    : 'هنوز درخواست خریدی ثبت نشده است.';

  return (
    <div data-testid="commerce-purchase-list">
      <CommercePageHeading
        title="درخواست‌های خرید"
        description="فهرست درخواست‌های خرید ثبت‌شده در سازمان"
        actions={
          canManage ? (
            <Link
              href="/admin/commerce/purchases/new"
              data-testid="commerce-purchase-create-cta"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              درخواست خرید جدید
            </Link>
          ) : undefined
        }
      />

      <CommerceCard className="mb-6" testId="commerce-purchase-filters">
        <form onSubmit={submitSearch} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="commerce-search" className="text-xs text-muted-foreground">
                جستجو بر اساس شمارهٔ سند
              </label>
              <input
                id="commerce-search"
                name="search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="مثلاً PR-1405-0001"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="commerce-status" className="text-xs text-muted-foreground">
                وضعیت
              </label>
              <select
                id="commerce-status"
                name="status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as CommerceDocumentStatus | '');
                  setPage(1);
                }}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                <option value="">همهٔ وضعیت‌ها</option>
                {COMMERCE_DOCUMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {commerceDocumentStatusLabel(status)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="commerce-page-size" className="text-xs text-muted-foreground">
                تعداد در هر صفحه
              </label>
              <select
                id="commerce-page-size"
                name="pageSize"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {toPersianDigits(size)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy} className="text-sm">
              {busy ? 'در حال جستجو…' : 'جستجو'}
            </Button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                data-testid="commerce-clear-filters"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                حذف فیلترها
              </button>
            )}
          </div>
        </form>
      </CommerceCard>

      {showInitialLoading ? (
        <CoreLoading lines={6} />
      ) : error && data === null ? (
        <CoreError message={error} onRetry={reload} />
      ) : (
        <CommerceCard testId="commerce-purchase-results">
          {error && (
            <div className="mb-4">
              <CoreError message={error} onRetry={reload} />
            </div>
          )}

          {documents.length === 0 ? (
            <CommerceEmptyState
              testId="commerce-purchase-empty"
              message={emptyMessage}
              action={
                hasActiveFilters ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    حذف فیلترها
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div aria-busy={busy}>
              {/* Desktop: a real table with real headers (sticky identities, aligned numbers). */}
              <table className="hidden w-full border-collapse text-sm md:table">
                <caption className="sr-only">فهرست درخواست‌های خرید</caption>
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th scope="col" className="py-3 pe-3 text-start font-medium">
                      شمارهٔ سند
                    </th>
                    <th scope="col" className="py-3 pe-3 text-start font-medium">
                      وضعیت
                    </th>
                    <th scope="col" className="py-3 pe-3 text-start font-medium">
                      درخواست‌کننده
                    </th>
                    <th scope="col" className="py-3 pe-3 text-end font-medium">
                      تعداد ردیف
                    </th>
                    <th scope="col" className="py-3 pe-3 text-end font-medium">
                      جمع کل
                    </th>
                    <th scope="col" className="py-3 text-end font-medium">
                      آخرین به‌روزرسانی
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => (
                    <tr
                      key={document.id}
                      data-testid={`commerce-purchase-row-${document.documentNumber}`}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-3 pe-3">
                        <Link
                          href={`/admin/commerce/purchases/${document.id}`}
                          data-testid={`commerce-purchase-open-${document.documentNumber}`}
                          aria-label={`مشاهدهٔ سند ${document.documentNumber}`}
                          dir="ltr"
                          className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                        >
                          {document.documentNumber}
                        </Link>
                      </td>
                      <td className="py-3 pe-3">
                        <CommerceDocumentStatusBadge status={document.status} />
                      </td>
                      <td className="max-w-[14rem] truncate py-3 pe-3 text-foreground">
                        {commerceDisplayName(document.requester.profile, '—')}
                      </td>
                      <td className="py-3 pe-3 text-end text-foreground">
                        {toPersianDigits(document.lines.length)}
                      </td>
                      <td className="py-3 pe-3 text-end text-foreground">
                        {commerceMoneyLabel(document.totalAmount, document.currency)}
                      </td>
                      <td className="py-3 text-end text-muted-foreground">
                        <span title={document.updatedAt}>
                          {commerceDateLabel(document.updatedAt)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile: the same rows as stacked definition cards — never a squashed table. */}
              <ul className="divide-y divide-border md:hidden">
                {documents.map((document) => (
                  <li
                    key={document.id}
                    data-testid={`commerce-purchase-card-${document.documentNumber}`}
                    className="flex flex-col gap-2 py-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/admin/commerce/purchases/${document.id}`}
                        aria-label={`مشاهدهٔ سند ${document.documentNumber}`}
                        dir="ltr"
                        className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                      >
                        {document.documentNumber}
                      </Link>
                      <CommerceDocumentStatusBadge status={document.status} />
                    </div>
                    <dl className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">درخواست‌کننده</dt>
                        <dd className="truncate text-foreground">
                          {commerceDisplayName(document.requester.profile, '—')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">تعداد ردیف</dt>
                        <dd className="text-foreground">
                          {toPersianDigits(document.lines.length)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">جمع کل</dt>
                        <dd className="text-foreground">
                          {commerceMoneyLabel(document.totalAmount, document.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">آخرین به‌روزرسانی</dt>
                        <dd className="text-foreground" title={document.updatedAt}>
                          {commerceDateLabel(document.updatedAt)}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>

              {data && (
                <CommercePagination
                  page={data.page.page}
                  pageSize={data.page.pageSize}
                  total={data.page.total}
                  onPageChange={setPage}
                  disabled={busy}
                />
              )}
            </div>
          )}
        </CommerceCard>
      )}
    </div>
  );
}


