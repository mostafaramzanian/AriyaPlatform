'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  fetchProductionBomChangeRequests,
  type ProductionBomChangePage,
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
 * Phase PRODUCTION-BOM-CHANGE: the change-request register — `/admin/production/changes`.
 *
 * ONLY THE FILTERS THE ROUTE SUPPORTS. `GET /production/bom-change-requests` takes `page`,
 * `pageSize`, `search` (matched against the TITLE), `status`, `projectRef` and `bomId`; the
 * UI therefore offers exactly those and NOTHING else. A client-side filter over one page
 * would silently describe a subset while looking like the whole register.
 *
 * THE STATUS VOCABULARY IS THE BOM HEADER'S, AND THAT IS THE POINT. The change request walks
 * the same four states (DRAFT / SUBMITTED / APPROVED / REJECTED), so re-declaring a second
 * list here would be a second answer to "which states exist" — the labels, the tones and the
 * filter options all come from the SAME map the BOM register already renders.
 *
 * ROWS OPEN THE DETAIL. The title is a real link to `/admin/production/changes/[id]`, where
 * the search, the selected changes, the approval actions and the timeline live.
 *
 * REFETCH KEEPS THE CONTEXT. Filters and the page survive a failure, an in-place refetch
 * keeps the previous rows visible instead of blanking the table, and retry re-runs the same
 * request rather than resetting anything.
 */
export function ProductionBomChangeListView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('production.bom.read');
  const canManage = enforcePermissions && rbac.permissions.includes('production.bom.manage');

  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [searchInput, setSearchInput] = React.useState('');
  const [appliedSearch, setAppliedSearch] = React.useState('');
  const [projectInput, setProjectInput] = React.useState('');
  const [appliedProject, setAppliedProject] = React.useState('');
  const [bomInput, setBomInput] = React.useState('');
  const [appliedBom, setAppliedBom] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PRODUCTION_DEFAULT_PAGE_SIZE);

  const [data, setData] = React.useState<ProductionBomChangePage | null>(null);
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

    fetchProductionBomChangeRequests({
      page,
      pageSize,
      search: appliedSearch,
      status: statusFilter === '' ? undefined : statusFilter,
      projectRef: appliedProject,
      bomId: appliedBom,
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setPageSize(result.pageSize);
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
  }, [
    isAuthenticated,
    rbac.isLoading,
    canRead,
    statusFilter,
    appliedSearch,
    appliedProject,
    appliedBom,
    page,
    pageSize,
    reloadToken,
  ]);

  if (!enforcePermissions && rbac.isLoading) return <CoreLoading lines={5} />;
  if (enforcePermissions && !canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ درخواست‌های تغییر BOM به مجوز production.bom.read نیاز دارید." />
    );
  }

  const rows = data?.items ?? [];
  // Whether a request cycle is meaningfully in flight. `isLoading` covers retries
  // (armed by the hook above, settled by the fetch effect); the derived term covers
  // the FIRST load, where no handler ever arms it: once the gate has settled and
  // neither data nor error has arrived, the view is by definition waiting for its
  // first response. This replaces the previous in-effect `setLoading(true)` reset
  // (`react-hooks/set-state-in-effect`): the effect body now only settles (and keeps
  // `setPageSize(result.pageSize)` inside the `active` guard).
  const gateSettled = isAuthenticated && !rbac.isLoading && canRead;
  const busy = isLoading || (gateSettled && data === null && error === null);
  // IDENTICAL truth table to the previous `isLoading && data === null`: the skeleton
  // shows while the FIRST response is pending, hides once rows arrive, after an error
  // (busy is false) and during in-place refetches that keep the previous rows visible.
  const showInitialLoading = busy && data === null;
  const hasActiveFilters =
    appliedSearch.length > 0 ||
    appliedProject.length > 0 ||
    appliedBom.length > 0 ||
    statusFilter !== '';
  const emptyMessage = hasActiveFilters
    ? 'درخواست تغییری با این فیلترها یافت نشد.'
    : 'هنوز درخواست تغییری ثبت نشده است.';

  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput);
    setAppliedProject(projectInput);
    setAppliedBom(bomInput);
  };

  const clearFilters = () => {
    setSearchInput('');
    setProjectInput('');
    setBomInput('');
    setStatusFilter('');
    setPage(1);
    setAppliedSearch('');
    setAppliedProject('');
    setAppliedBom('');
  };

  const inputClass =
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring';

  return (
    <div data-testid="production-change-list">
      <ProductionPageHeading
        title="درخواست‌های تغییر BOM"
        description="ثبت، پیگیری و تصمیم‌گیری روی تغییر اقلام BOM"
        testId="production-change-list-heading"
        actions={
          canManage ? (
            <Link
              href="/admin/production/changes/new"
              data-testid="production-change-create-cta"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              ثبت درخواست تغییر
            </Link>
          ) : null
        }
      />

      <ProductionCard className="mb-6" testId="production-change-filters">
        <form onSubmit={applyFilters} className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-search" className="text-xs text-muted-foreground">
              جستجو بر اساس عنوان
            </label>
            <input
              id="production-change-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-project" className="text-xs text-muted-foreground">
              پروژه
            </label>
            <input
              id="production-change-project"
              value={projectInput}
              onChange={(event) => setProjectInput(event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-bom" className="text-xs text-muted-foreground">
              شناسه BOM
            </label>
            <input
              id="production-change-bom"
              value={bomInput}
              onChange={(event) => setBomInput(event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="production-change-status" className="text-xs text-muted-foreground">
              وضعیت
            </label>
            <select
              id="production-change-status"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              className={inputClass}
            >
              <option value="">همه</option>
              {PRODUCTION_BOM_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {productionBomStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <button
              type="submit"
              data-testid="production-change-search-submit"
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              جستجو
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                data-testid="production-change-search-clear"
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
        <div className="mb-6" data-testid="production-change-list-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      {showInitialLoading ? (
        <CoreLoading lines={5} />
      ) : rows.length === 0 && !error ? (
        <ProductionEmptyState message={emptyMessage} testId="production-change-list-empty" />
      ) : (
        <ProductionCard testId="production-change-list-table">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">عنوان</th>
                  <th className="px-3 py-2 font-medium">پروژه</th>
                  <th className="px-3 py-2 font-medium">BOM</th>
                  <th className="px-3 py-2 font-medium">درخواست‌کننده</th>
                  <th className="px-3 py-2 font-medium">تاییدکننده</th>
                  <th className="px-3 py-2 font-medium">وضعیت</th>
                  <th className="px-3 py-2 font-medium">تاریخ درخواست</th>
                </tr>
              </thead>
              <tbody aria-busy={busy}>
                {rows.map((change) => (
                  <tr
                    key={change.id}
                    data-testid="production-change-row"
                    className="border-b border-border/60 last:border-b-0"
                  >
                    <td className="px-3 py-3">
                      <Link
                        href={`/admin/production/changes/${change.id}`}
                        data-testid={`production-change-link-${change.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {change.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{change.projectRef}</td>
                    <td className="px-3 py-3 text-muted-foreground">{change.bomId}</td>
                    <td className="px-3 py-3 text-muted-foreground">{change.requesterUserId}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {change.approverUserId ?? '—'}
                    </td>
                    <td className="px-3 py-3">
                      <ProductionBomStatusBadge status={change.status as ProductionBomStatus} />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {productionDateLabel(change.requestDate)}
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

