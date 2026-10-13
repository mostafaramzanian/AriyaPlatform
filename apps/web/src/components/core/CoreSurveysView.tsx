'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  SURVEY_PAGE_SIZE,
  formatSurveyTime,
  listSurveys,
  surveyStatusLabel,
  surveyUserName,
  type Survey,
  type SurveyQuery,
  type SurveyStatus,
} from '@/lib/surveys-api';
import { cn } from '@/lib/utils';
import { useCorePermissions } from './useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49H: survey list.
 *
 * Read-only discovery over `GET /surveys`. What a caller sees is decided entirely
 * server-side: a participant gets published, in-window surveys in their own tenant; a
 * manager can additionally ask for drafts and for `scope=all`. This view sends no
 * user or tenant identifier and has no "view as" control, so it cannot ask for another
 * tenant's surveys — and a non-manager choosing `all` is silently narrowed back to
 * `available` by the backend rather than being granted anything.
 *
 * The only permission this view consults is `admin.surveys.manage`, and only to decide
 * whether to show the create link. That is presentation: `POST /surveys` enforces the
 * same permission itself.
 *
 * Pagination mirrors the convention used by the directory (49D-1), notification (49E)
 * and support (49G) lists: a cursor stack over `{ items, hasMore }`.
 *
 * Titles and descriptions are rendered as text. No `dangerouslySetInnerHTML`.
 */

const MANAGE_PERMISSION = 'admin.surveys.manage';

const SCOPE_FILTERS: Array<{ value: NonNullable<SurveyQuery['scope']>; label: string }> = [
  { value: 'available', label: 'قابل پاسخ' },
  { value: 'mine', label: 'ساخته‌شده توسط من' },
  { value: 'all', label: 'همه' },
];

const STATUS_FILTERS: Array<{ value: SurveyStatus | 'all'; label: string }> = [
  { value: 'all', label: 'همه' },
  { value: 'DRAFT', label: surveyStatusLabel('DRAFT') },
  { value: 'PUBLISHED', label: surveyStatusLabel('PUBLISHED') },
  { value: 'CLOSED', label: surveyStatusLabel('CLOSED') },
];

const STATUS_TONE: Record<SurveyStatus, string> = {
  DRAFT: 'border-border bg-muted text-muted-foreground',
  PUBLISHED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  CLOSED: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

export function SurveyStatusBadge({ status }: { status: SurveyStatus }) {
  return (
    <span
      data-testid="survey-status"
      className={cn('rounded-full border px-2.5 py-0.5 text-[11px]', STATUS_TONE[status])}
    >
      {surveyStatusLabel(status)}
    </span>
  );
}

export function CoreSurveysView() {
  const { permissions } = useCorePermissions(true);
  const [scope, setScope] = React.useState<NonNullable<SurveyQuery['scope']>>('available');
  const [status, setStatus] = React.useState<SurveyStatus | 'all'>('all');

  const [items, setItems] = React.useState<Survey[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  // Cursor stack: index i holds the cursor used to fetch page i (undefined = first).
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the pagination/retry handlers below (same commit
  // as the token bump), so the list effect needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const currentCursor = cursors[cursors.length - 1];

  // A filter change invalidates the cursor stack: a cursor from a different
  // predicate would point into a different result set — and it re-arms the list
  // load. Applied during render, guarded by the previous filters: mount is a
  // no-op, and an effect-body setter is barred by
  // `react-hooks/set-state-in-effect`.
  const [prevPred, setPrevPred] = React.useState({ scope, status });
  if (prevPred.scope !== scope || prevPred.status !== status) {
    setPrevPred({ scope, status });
    setCursors([undefined]);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    listSurveys({
      cursor: currentCursor,
      limit: SURVEY_PAGE_SIZE,
      scope,
      ...(status === 'all' ? {} : { status }),
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items ?? []);
        setHasMore(Boolean(result.hasMore));
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setItems([]);
        setHasMore(false);
        setError({
          message: err instanceof Error ? err.message : 'دریافت نظرسنجی‌ها با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentCursor, scope, status, reloadToken]);

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

  // Authoring affordance. `canManage` on any listed row is the server's own verdict and
  // is preferred, but an empty or participant-only page would then hide the create link
  // from a genuine manager — including the bootstrap case where the tenant has no
  // surveys yet. So the permission read is used as the fallback. Both are presentation
  // only: `POST /surveys` enforces `admin.surveys.manage` regardless.
  const canAuthor = items.some((item) => item.canManage) || permissions.includes(MANAGE_PERMISSION);

  if (error?.status === 403) {
    return <CoreForbidden message="شما به بخش نظرسنجی‌ها دسترسی ندارید." />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">نظرسنجی‌ها</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            نظرسنجی‌های سازمانی و مشارکت در آن‌ها
          </p>
        </div>

        {canAuthor && (
          <Link
            href="/admin/surveys/new"
            data-testid="survey-create-link"
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            نظرسنجی جدید
          </Link>
        )}
      </header>

      <section
        aria-label="پالایه‌ها"
        className="flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-card p-4"
      >
        <div className="space-y-1">
          <label htmlFor="survey-scope" className="block text-xs text-muted-foreground">
            نمایش
          </label>
          <select
            id="survey-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as NonNullable<SurveyQuery['scope']>)}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SCOPE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="survey-status" className="block text-xs text-muted-foreground">
            وضعیت
          </label>
          <select
            id="survey-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as SurveyStatus | 'all')}
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {isLoading && <CoreLoading label="در حال بارگذاری نظرسنجی‌ها..." lines={4} />}

      {!isLoading && error && (
        <CoreError message={error.message} onRetry={reload} />
      )}

      {!isLoading && !error && items.length === 0 && (
        <CoreEmpty message="نظرسنجی‌ای برای نمایش وجود ندارد." />
      )}

      {!isLoading && !error && items.length > 0 && (
        <ul className="space-y-3" data-testid="survey-list">
          {items.map((survey) => (
            <li key={survey.id}>
              <Link
                href={`/admin/surveys/${survey.id}`}
                className="block rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{survey.title}</span>
                  <div className="flex items-center gap-2">
                    {survey.hasResponded && (
                      <span
                        data-testid="survey-responded"
                        className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
                      >
                        پاسخ داده‌اید
                      </span>
                    )}
                    {survey.isAnonymous && (
                      <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
                        بی‌نام
                      </span>
                    )}
                    <SurveyStatusBadge status={survey.status} />
                  </div>
                </div>

                {survey.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {survey.description}
                  </p>
                )}

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <div className="flex gap-1">
                    <dt>سازنده:</dt>
                    <dd>{surveyUserName(survey.createdBy)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>پرسش‌ها:</dt>
                    <dd>{survey.questionCount.toLocaleString('fa-IR')}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>ایجاد:</dt>
                    <dd>{formatSurveyTime(survey.createdAt)}</dd>
                  </div>
                  {survey.endsAt && (
                    <div className="flex gap-1">
                      <dt>پایان:</dt>
                      <dd>{formatSurveyTime(survey.endsAt)}</dd>
                    </div>
                  )}
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && !error && (cursors.length > 1 || hasMore) && (
        <nav aria-label="صفحه‌بندی" className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={goPrevious}
            disabled={cursors.length === 1}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            صفحه قبل
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!hasMore}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            صفحه بعد
          </button>
        </nav>
      )}
    </div>
  );
}
