'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  PRODUCTION_MAX_PAGE_SIZE,
  fetchProductionBoms,
  type ProductionBomPage,
  type ProductionBomStatus,
} from '@/lib/production-api';
import {
  PRODUCTION_BOM_STATUSES,
  productionBomStatusLabel,
  productionDateLabel,
} from '@/lib/production-labels';
import {
  ProductionBomStatusBadge,
  ProductionCard,
  ProductionEmptyState,
  ProductionPageHeading,
  ProductionPagination,
} from './production-ui';

/**
 * Phase PRODUCTION-BOM: the BOM register — `/admin/production`.
 *
 * ONLY THE FILTERS THE ROUTE SUPPORTS. `GET /production/boms` takes `page`, `pageSize`,
 * `search` (matched against the TITLE — the DTO says exactly that) and `status`; the UI
 * therefore offers exactly those and NOTHING else. A client-side filter over one page would
 * silently describe a subset while looking like the whole register.
 *
 * ROWS OPEN THE DETAIL. The title is a real link to `/admin/production/[id]`, where the
 * items grid and the lifecycle actions live.
 *
 * REFETCH KEEPS THE CONTEXT. Filters and the page live in state across failures, an in-place
 * refetch keeps the previous rows visible instead of blanking the table, and retry re-runs
 * the same request rather than resetting anything.
 */
export function ProductionBomListView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');
  const canManage = enforcePermissions && rbac.permissions.includes('production.bom.manage');

  const [statusFilter, setStatusFilter] = React.useState<ProductionBomStatus | ''>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PRODUCTION_DEFAULT_PAGE_SIZE);

  const [data, setData] = React.useState<ProductionBomPage | null>(null);
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

    fetchProductionBoms({
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

  if (rbac.isLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ فهرست BOM به مجوز production.bom.read نیاز دارید." />
    );
  }

  // Identical truth table to `isLoading && data === null` (busy is false once an
  // error lands or during in-place refetch that keeps previous rows visible).
  const showInitialLoading = busy && data === null;
  const boms = data?.items ?? [];
  const emptyMessage = hasActiveFilters
    ? 'BOM‌ای با این فیلترها یافت نشد.'
    : 'هنوز فهرست مواد و قطعاتی ثبت نشده است.';

  return (
    <div data-testid="production-bom-list">
      <ProductionPageHeading
        title="فهرست مواد و قطعات (BOM)"
        description="فهرست BOMهای ثبت‌شده در سازمان"
        testId="production-bom-list-heading"
        actions={
          canManage ? (
            <Link
              href="/admin/production/new"
              data-testid="production-bom-create-cta"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              BOM جدید
            </Link>
          ) : undefined
        }
      />

      <ProductionCard className="mb-6" testId="production-bom-filters">
        <form onSubmit={submitSearch} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="production-search" className="text-xs text-muted-foreground">
                جستجو بر اساس عنوان
              </label>
              <input
                id="production-search"
                name="search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="مثلاً اقلام پروژه"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="production-status" className="text-xs text-muted-foreground">
                وضعیت
              </label>
              <select
                id="production-status"
                name="status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as ProductionBomStatus | '');
                  setPage(1);
                }}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                <option value="">همه</option>
                {PRODUCTION_BOM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {productionBomStatusLabel(status)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="production-page-size" className="text-xs text-muted-foreground">
                تعداد در صفحه
              </label>
              <select
                id="production-page-size"
                name="pageSize"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                {[PRODUCTION_DEFAULT_PAGE_SIZE, 50, PRODUCTION_MAX_PAGE_SIZE].map((size) => (
                  <option key={size} value={size}>
                    {toPersianDigits(String(size))}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="production-search-submit"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              جستجو
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                data-testid="production-search-clear"
                onClick={clearFilters}
                className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
              >
                پاک‌کردن فیلترها
              </button>
            )}
          </div>
        </form>
      </ProductionCard>

      {error && (
        <div className="mb-6" data-testid="production-bom-list-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {showInitialLoading ? (
        <CoreLoading lines={5} />
      ) : boms.length === 0 && !error ? (
        <ProductionEmptyState message={emptyMessage} testId="production-bom-list-empty" />
      ) : (
        <ProductionCard testId="production-bom-list-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">عنوان</th>
                  <th className="px-3 py-2 font-medium">پروژه</th>
                  <th className="px-3 py-2 font-medium">درخت محصول</th>
                  <th className="px-3 py-2 font-medium">وضعیت</th>
                  <th className="px-3 py-2 font-medium">آخرین ویرایش</th>
                </tr>
              </thead>
              <tbody aria-busy={busy}>
                {boms.map((bom) => (
                  <tr
                    key={bom.id}
                    data-testid="production-bom-row"
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/production/${bom.id}`}
                        data-testid={`production-bom-link-${bom.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {bom.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{bom.projectRef}</td>
                    <td className="px-3 py-3 text-muted-foreground">{bom.productTreeRef}</td>
                    <td className="px-3 py-3">
                      <ProductionBomStatusBadge status={bom.status} />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {productionDateLabel(bom.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ProductionPagination
            page={data?.page ?? 1}
            pageSize={data?.pageSize ?? pageSize}
            total={data?.total ?? 0}
            onPageChange={setPage}
            disabled={busy}
          />
        </ProductionCard>
      )}
    </div>
  );
}

