'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  FINANCIAL_DEFAULT_PAGE_SIZE,
  fetchFinancialCheckRequests,
  type FinancialCheckRequestPage,
} from '@/lib/financial-api';
import {
  FINANCIAL_CHECK_REQUEST_STATUSES,
  financialDateLabel,
  financialErrorMessage,
  financialManagerDecisionLabel,
  financialStatusLabel,
} from '@/lib/financial-labels';
import {
  FinancialCard,
  FinancialCheckRequestStatusBadge,
  FinancialEmptyState,
  FinancialPageHeading,
  FinancialPagination,
} from './financial-ui';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the check-request register —
 * `/admin/financial/check-requests`.
 *
 * ONLY THE FILTERS THE ROUTE SUPPORTS. `GET /financial/check-requests` takes `page`,
 * `pageSize`, `search` (matched against the TITLE — the DTO says exactly that) and
 * `status`; the UI therefore offers exactly those and NOTHING else. A client-side filter
 * over one page would silently describe a subset while looking like the whole register —
 * and `status` is limited to the five ordinals F1 implements, so a deferred stage cannot
 * even be asked for.
 *
 * ROWS OPEN THE DETAIL. The title is a real link to `/admin/financial/check-requests/[id]`,
 * where the lifecycle actions live.
 *
 * REFETCH KEEPS THE CONTEXT. Filters and the page live in state across failures, an
 * in-place refetch keeps the previous rows visible instead of blanking the table, and
 * retry re-runs the same request rather than resetting anything.
 */
export function CheckRequestListView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('financial.check.read');
  const canManage = enforcePermissions && rbac.permissions.includes('financial.check.manage');

  const [statusFilter, setStatusFilter] = React.useState<number | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const pageSize = FINANCIAL_DEFAULT_PAGE_SIZE;

  const [data, setData] = React.useState<FinancialCheckRequestPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);

  React.useEffect(() => {
    // No request before the grants are known, and none without the read the route demands;
    // retrying a 403 cannot succeed.
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchFinancialCheckRequests({
      page,
      pageSize,
      search: appliedSearch,
      status: statusFilter === '' ? undefined : statusFilter,
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const body = (err as { details?: { code?: string } }).details;
        setError(
          financialErrorMessage(
            body?.code,
            err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.'
          )
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    isAuthenticated,
    rbac.isLoading,
    canRead,
    page,
    pageSize,
    statusFilter,
    appliedSearch,
    reloadToken,
  ]);

  if (!isAuthenticated || rbac.isLoading) return <CoreLoading lines={4} />;
  if (!canRead) return <CoreForbidden />;

  const items = data?.items ?? [];
  // Whether a request cycle is meaningfully in flight. The early returns above
  // guarantee the three-condition gate is settled for every render that reaches
  // this line, so `isLoading` (armed only by the retry handler above, settled by
  // the fetch effect) plus the derived first-load term cover every state: no
  // handler ever arms the first load, so once the gate has settled and neither
  // data nor error has arrived, the view is by definition waiting for its first
  // response. This replaces the previous in-effect `setLoading(true)` reset
  // (`react-hooks/set-state-in-effect`): the effect body now only settles.
  const busy = isLoading || (data === null && error === null);
  const hasActiveFilters = statusFilter !== '' || appliedSearch.length > 0;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <FinancialPageHeading
        testId="financial-check-list-heading"
        title="درخواست‌های صدور چک"
        description="ایجاد، ارجاع و پیگیری درخواست صدور چک"
        actions={
          canManage ? (
            <Link
              href="/admin/financial/check-requests/new"
              data-testid="financial-check-new"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              درخواست جدید
            </Link>
          ) : null
        }
      />

      <FinancialCard testId="financial-check-list-filters">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setAppliedSearch(searchInput.trim());
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">جستجو در عنوان</span>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              data-testid="financial-check-search-input"
              className="h-10 w-64 rounded-xl border border-border bg-background px-3 text-sm"
              placeholder="عنوان درخواست"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">وضعیت</span>
            <select
              value={statusFilter === '' ? '' : String(statusFilter)}
              onChange={(event) => {
                setPage(1);
                setStatusFilter(event.target.value === '' ? '' : Number(event.target.value));
              }}
              data-testid="financial-check-status-filter"
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
            >
              <option value="">همه</option>
              {FINANCIAL_CHECK_REQUEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {financialStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            data-testid="financial-check-search-submit"
            className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            جستجو
          </button>
          {hasActiveFilters && (
            <button
              type="button"
              data-testid="financial-check-search-clear"
              onClick={() => {
                setSearchInput('');
                setAppliedSearch('');
                setStatusFilter('');
                setPage(1);
              }}
              className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
            >
              پاک‌کردن فیلترها
            </button>
          )}
        </form>
      </FinancialCard>

      {error && (
        <div className="mb-6" data-testid="financial-check-list-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {busy && items.length === 0 ? (
        <CoreLoading lines={5} />
      ) : items.length === 0 && !error ? (
        <FinancialEmptyState
          message="درخواست صدور چکی ثبت نشده است."
          testId="financial-check-list-empty"
        />
      ) : (
        <FinancialCard testId="financial-check-list-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">عنوان</th>
                  <th className="px-3 py-2 font-medium">نوع صدور چک</th>
                  <th className="px-3 py-2 font-medium">وضعیت</th>
                  <th className="px-3 py-2 font-medium">تصمیم مدیر</th>
                  <th className="px-3 py-2 font-medium">تاریخ درخواست</th>
                </tr>
              </thead>
              <tbody aria-busy={busy}>
                {items.map((request) => (
                  <tr
                    key={request.id}
                    data-testid="financial-check-row"
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/financial/check-requests/${request.id}`}
                        data-testid={`financial-check-link-${request.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {request.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {request.checkIssueType === 'PURCHASE'
                        ? 'خرید'
                        : request.checkIssueType === 'PETTY_CASH'
                          ? 'تنخواه'
                          : 'حقوق'}
                    </td>
                    <td className="px-3 py-3">
                      <FinancialCheckRequestStatusBadge status={request.status} />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {financialManagerDecisionLabel(request.managerDecision) ?? '—'}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {financialDateLabel(request.requestDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <FinancialPagination
            page={data?.page ?? 1}
            pageSize={data?.pageSize ?? pageSize}
            total={data?.total ?? 0}
            onPageChange={setPage}
            disabled={busy}
          />
        </FinancialCard>
      )}
    </div>
  );
}
