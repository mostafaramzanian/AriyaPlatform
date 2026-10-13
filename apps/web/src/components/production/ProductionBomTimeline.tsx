'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { CoreApiError } from '@/lib/core-http';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  fetchProductionBomTimeline,
  type ProductionBomTimelineEntry,
  type ProductionBomTimelinePage,
} from '@/lib/production-api';
import {
  productionAuditTimestampLabel,
  productionBomAuditActionLabel,
  productionErrorCode,
  productionErrorMessage,
  productionServerMessage,
} from '@/lib/production-labels';
import { ProductionCard, ProductionEmptyState, ProductionPagination } from './production-ui';

/**
 * Phase PRODUCTION-BOM-AUDIT-TIMELINE: the BOM's event history — a READ-ONLY section of
 * `/admin/production/[id]`.
 *
 * WHY IT IS ITS OWN COMPONENT
 * ---------------------------
 * The detail view already renders the header, the lifecycle actions and the item grid.
 * The timeline has its own request, its own loading state, its own error state and its own
 * pager, and mixing them into the parent's would mean one `useEffect` juggling three
 * independent reads. The parent keeps the section visible and this owns everything inside
 * it — including its own pagination, so paging the history never refetches the BOM.
 *
 * WHAT IT RENDERS, AND WHAT IT REFUSES TO INVENT
 * ---------------------------------------------
 *   * The ORDER is the server's (`createdAt ASC, id ASC`) — chronological, as the brief
 *     requires. Nothing here re-sorts: a client-side sort would be a second ordering
 *     opinion, and the API has no parameter for a different one.
 *   * The LABEL comes from `productionBomAuditActionLabel`, which falls back to the raw
 *     audit token for a verb it does not know. An unknown action renders as the token
 *     rather than as a plausible-sounding sentence nobody defined.
 *   * ONLY what the audit read contract exposes is shown: the verb, the instant, the actor
 *     id, the outcome, the reason and the changed field NAMES. There is no payload to
 *     redact because the platform projection does not carry one, and this component does
 *     not ask for one.
 *   * EMPTY and FAILED are DIFFERENT. Zero events says «رویدادی ثبت نشده است»; a rejected
 *     read shows the refusal (503 «تاریخچه موقتاً در دسترس نیست»). Rendering the second as
 *     the first would tell a reader nothing happened when the truth is nothing could be
 *     asked.
 *
 * PERMISSION: the parent hides the section without `production.bom.read`, and the endpoint
 * refuses independently. This component does not re-check the grant — a page-level
 * decision belongs to the page, and a second check here would be a second opinion about
 * who may read a BOM.
 */
export function ProductionBomTimeline({ bomId }: { bomId: string }) {
  const [page, setPage] = React.useState<ProductionBomTimelinePage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [pageNumber, setPageNumber] = React.useState(1);

  const load = React.useCallback(
    async (target: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchProductionBomTimeline(bomId, {
          page: target,
          pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
        });
        setPage(result);
      } catch (err: unknown) {
        const details = err instanceof CoreApiError ? err.details : undefined;
        setError(
          productionErrorMessage(
            productionErrorCode(details),
            productionServerMessage(details) ??
              (err instanceof Error ? err.message : undefined)
          )
        );
        // The page is cleared rather than kept: showing the PREVIOUS page's rows beside a
        // failure would imply those rows are this page's answer.
        setPage(null);
      } finally {
        setLoading(false);
      }
    },
    [bomId]
  );

  React.useEffect(() => {
    // Deferred to a microtask so the loader's own `setLoading(true)`/`setError(null)`
    // arm does not run synchronously inside the effect body
    // (`react-hooks/set-state-in-effect`); the flag cancels an unmount.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load(pageNumber);
    });
    return () => {
      cancelled = true;
    };
  }, [load, pageNumber]);

  const entries = page?.items ?? [];

  return (
    <ProductionCard testId="production-bom-timeline" className="mt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">تاریخچه رویدادها</h2>
        {page && (
          <span data-testid="production-timeline-count" className="text-xs text-muted-foreground">
            {toPersianDigits(String(page.total))} رویداد
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4" data-testid="production-bom-timeline-error">
          <CoreError message={error} onRetry={() => void load(pageNumber)} />
        </div>
      )}

      {!error && isLoading && page === null ? (
        <CoreLoading lines={4} />
      ) : !error && entries.length === 0 ? (
        <ProductionEmptyState
          message="هنوز رویدادی برای این BOM ثبت نشده است."
          testId="production-bom-timeline-empty"
        />
      ) : (
        <>
          <ol aria-busy={isLoading} className="flex flex-col gap-3">
            {entries.map((entry) => (
              <ProductionTimelineRow key={entry.id} entry={entry} />
            ))}
          </ol>

          {page && (
            <ProductionPagination
              page={page.page}
              pageSize={page.pageSize}
              total={page.total}
              onPageChange={setPageNumber}
              disabled={isLoading}
            />
          )}
        </>
      )}
    </ProductionCard>
  );
}

/**
 * One event. Chronological, and every fact it shows came off the row.
 *
 * `changedFields` renders NAMES only, because names are all the contract exposes — the
 * before/after values are deliberately absent from the platform projection, so there is
 * nothing to reveal and nothing to redact. A row that changed nothing (a transition)
 * simply omits the list rather than showing an empty «فیلدهای تغییریافته».
 *
 * `reason` is the refusal's own text when an act failed, shown verbatim: it is the
 * operator's own vocabulary from the trail, not a sentence this screen composes.
 */
function ProductionTimelineRow({ entry }: { entry: ProductionBomTimelineEntry }) {
  return (
    <li
      data-testid="production-timeline-entry"
      data-action={entry.action}
      className="border-b border-border/60 pb-3 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          data-testid="production-timeline-action"
          className="text-sm font-medium text-foreground"
        >
          {productionBomAuditActionLabel(entry.action)}
        </span>
        <span className="text-xs text-muted-foreground">
          {productionAuditTimestampLabel(entry.createdAt)}
        </span>
        <span data-testid="production-timeline-actor" className="text-xs text-muted-foreground">
          {entry.actorId ?? '—'}
        </span>
        {!entry.success && (
          <span data-testid="production-timeline-failed" className="text-xs text-destructive">
            ناموفق
          </span>
        )}
      </div>

      {entry.reason && (
        <p
          data-testid="production-timeline-reason"
          className="mt-1 text-xs text-muted-foreground"
        >
          {entry.reason}
        </p>
      )}

      {entry.changedFields.length > 0 && (
        <p
          data-testid="production-timeline-changed-fields"
          className="mt-1 text-xs text-muted-foreground"
        >
          فیلدهای تغییریافته: {entry.changedFields.join('، ')}
        </p>
      )}
    </li>
  );
}