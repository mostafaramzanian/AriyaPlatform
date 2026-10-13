'use client';

import * as React from 'react';
import Link from 'next/link';
import { Phone, Search } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  DIRECTORY_PAGE_SIZE,
  directoryFullName,
  distinctValues,
  fetchDirectory,
  type DirectoryMember,
} from '@/lib/directory-api';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';
import { DirectoryAvatar } from './DirectoryAvatar';

/**
 * Phase 49D-1: Organization Directory list.
 *
 * Read-only discovery over `GET /users/directory`. No administrative editing,
 * no employee lifecycle and no HR data — the payload is limited to the approved
 * directory projection returned by the backend.
 *
 * Pagination mirrors the repository convention used by the blog list: a cursor
 * stack drives forward/back navigation over `{ items, hasMore }`, so the whole
 * tenant user population is never loaded client-side.
 */

const SEARCH_DEBOUNCE_MS = 350;

interface Filters {
  q: string;
  department: string;
  jobTitle: string;
}

const EMPTY_FILTERS: Filters = { q: '', department: '', jobTitle: '' };

/**
 * Skeleton rows/cards while a page loads. Uses the shared CoreLoading primitive
 * so the announcement (`role="status"`) and shimmer match the rest of Core UI.
 */
function DirectorySkeleton() {
  return (
    <div className="core-card p-4 sm:p-core-card" data-testid="directory-skeleton">
      <CoreLoading label="در حال بارگذاری فهرست همکاران..." lines={6} />
    </div>
  );
}

function MemberFields({ member }: { member: DirectoryMember }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">واحد:</dt>
        <dd className="text-foreground">{member.department || '—'}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">سمت:</dt>
        <dd className="text-foreground">{member.jobTitle || '—'}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">داخلی:</dt>
        <dd className="text-foreground">{member.extension || '—'}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">مدیر:</dt>
        <dd className="text-foreground">
          {member.manager ? directoryFullName(member.manager) ?? '—' : '—'}
        </dd>
      </div>
    </dl>
  );
}

export function CoreDirectoryView() {
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  // `q` is debounced separately so typing does not fire a request per keystroke.
  const [searchInput, setSearchInput] = React.useState('');
  const [items, setItems] = React.useState<DirectoryMember[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // Cursor stack: index i holds the cursor used to fetch page i (undefined = first page).
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect needs no in-effect setter resets. First mount
  // is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const currentCursor = cursors[cursors.length - 1];

  React.useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((prev) => (prev.q === searchInput ? prev : { ...prev, q: searchInput }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Any filter change invalidates the cursor stack — a cursor from a different
  // predicate would point into a different result set — and re-arms the list
  // load. Applied during render, guarded by the previous filter value: the
  // debounce path changes `filters` from a timer, so no event handler could
  // arm it there, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`. Mount is a no-op (identity equal).
  const [prevFilters, setPrevFilters] = React.useState(filters);
  if (prevFilters !== filters) {
    setPrevFilters(filters);
    setCursors([undefined]);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    fetchDirectory({
      cursor: currentCursor,
      limit: DIRECTORY_PAGE_SIZE,
      q: filters.q,
      department: filters.department,
      jobTitle: filters.jobTitle,
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setHasMore(result.hasMore);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setHasMore(false);
        setError({
          message: err instanceof Error ? err.message : 'دریافت فهرست همکاران با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentCursor, filters.q, filters.department, filters.jobTitle, reloadToken]);

  // Filter options come from the loaded page only, so every option is a value
  // that actually exists. No extra endpoint and no full-population fetch.
  const departments = React.useMemo(() => distinctValues(items, 'department'), [items]);
  const jobTitles = React.useMemo(() => distinctValues(items, 'jobTitle'), [items]);

  const goNext = () => {
    const last = items[items.length - 1];
    if (!hasMore || !last) return;
    // Re-arm in the same handler commit (the removed in-effect setters used to
    // arm one render later).
    setIsLoading(true);
    setError(null);
    setCursors((prev) => [...prev, last.id]);
  };

  const goPrevious = () => {
    if (cursors.length <= 1) return;
    setIsLoading(true);
    setError(null);
    setCursors((prev) => prev.slice(0, -1));
  };

  const resetFilters = () => {
    setSearchInput('');
    setFilters(EMPTY_FILTERS);
  };

  const hasActiveFilters = filters.q !== '' || filters.department !== '' || filters.jobTitle !== '';

  if (error?.status === 403) {
    return <CoreForbidden message="شما به دفترچه سازمانی دسترسی ندارید." />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">دفترچه سازمانی</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            جست‌وجوی همکاران بر اساس نام، ایمیل، تلفن، داخلی، واحد و سمت
          </p>
        </div>
      </header>

      <section className="core-card p-4 sm:p-core-card" aria-labelledby="directory-filters-heading">
        <h2 id="directory-filters-heading" className="sr-only">
          جست‌وجو و فیلترها
        </h2>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <label
              htmlFor="directory-search"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              جست‌وجو
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                id="directory-search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="نام، ایمیل، تلفن یا داخلی"
                className="w-full rounded-xl border border-input bg-surface px-4 py-2 pe-10 text-foreground transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="directory-department"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              واحد
            </label>
            <select
              id="directory-department"
              value={filters.department}
              onChange={(event) => setFilters((prev) => ({ ...prev, department: event.target.value }))}
              className="w-full rounded-xl border border-input bg-surface px-4 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
            >
              <option value="">همه واحدها</option>
              {departments.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="directory-job-title"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              سمت
            </label>
            <select
              id="directory-job-title"
              value={filters.jobTitle}
              onChange={(event) => setFilters((prev) => ({ ...prev, jobTitle: event.target.value }))}
              className="w-full rounded-xl border border-input bg-surface px-4 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
            >
              <option value="">همه سمت‌ها</option>
              {jobTitles.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="mt-4">
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              حذف فیلترها
            </button>
          </div>
        )}
      </section>

      {/* Result count is announced politely so screen-reader users hear the
          outcome of a search without moving focus. */}
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {isLoading
          ? 'در حال جست‌وجو...'
          : error
            ? ''
            : `${items.length.toLocaleString('fa-IR')} همکار در این صفحه`}
      </p>

      {isLoading && <DirectorySkeleton />}

      {!isLoading && error && (
        <CoreError
          message={error.message}
          onRetry={error.status === 401 ? undefined : reload}
        />
      )}

      {!isLoading && !error && items.length === 0 && (
        <CoreEmpty
          message={
            hasActiveFilters
              ? 'همکاری با این جست‌وجو یا فیلترها یافت نشد.'
              : 'هنوز همکاری در دفترچه سازمانی ثبت نشده است.'
          }
        />
      )}

      {!isLoading && !error && items.length > 0 && (
        <>
          {/* Mobile/tablet: cards. Below lg the table would overflow
              horizontally, so it is not rendered at all rather than scrolled. */}
          <ul className="grid gap-4 sm:grid-cols-2 lg:hidden" data-testid="directory-cards">
            {items.map((member) => (
              <li key={member.id} className="core-card p-4">
                <Link
                  href={`/admin/directory/${member.id}`}
                  className="flex items-start gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <DirectoryAvatar member={member} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {directoryFullName(member) ?? member.email}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {member.email}
                    </span>
                  </span>
                </Link>
                <div className="mt-3 border-t border-border pt-3">
                  <MemberFields member={member} />
                </div>
              </li>
            ))}
          </ul>

          <div className="core-card hidden p-0 lg:block" data-testid="directory-table">
            <table className="w-full text-right text-sm">
              <caption className="sr-only">فهرست همکاران سازمان</caption>
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">همکار</th>
                  <th scope="col" className="px-4 py-3 font-medium">واحد</th>
                  <th scope="col" className="px-4 py-3 font-medium">سمت</th>
                  <th scope="col" className="px-4 py-3 font-medium">داخلی</th>
                  <th scope="col" className="px-4 py-3 font-medium">مدیر</th>
                  <th scope="col" className="px-4 py-3 font-medium">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {items.map((member) => (
                  <tr key={member.id} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="px-4 py-3 text-right font-normal">
                      <span className="flex items-center gap-3">
                        <DirectoryAvatar member={member} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">
                            {directoryFullName(member) ?? member.email}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        </span>
                      </span>
                    </th>
                    <td className="px-4 py-3 text-muted-foreground">{member.department || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{member.jobTitle || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.extension ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                          {member.extension}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.manager ? directoryFullName(member.manager) ?? '—' : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/directory/${member.id}`}
                        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        مشاهده پروفایل
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!error && (cursors.length > 1 || hasMore) && (
        <nav className="flex items-center justify-between gap-3" aria-label="صفحه‌بندی همکاران">
          <button
            type="button"
            onClick={goPrevious}
            disabled={cursors.length === 1 || isLoading}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            صفحه قبل
          </button>
          <span className="text-xs text-muted-foreground">
            صفحه {cursors.length.toLocaleString('fa-IR')}
          </span>
          <button
            type="button"
            onClick={goNext}
            disabled={!hasMore || isLoading}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            صفحه بعد
          </button>
        </nav>
      )}
    </div>
  );
}
