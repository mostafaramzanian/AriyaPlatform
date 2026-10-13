'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { CoreApiError } from '@/lib/core-http';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  PRODUCTION_DEFAULT_PAGE_SIZE,
  fetchProductionBomChangeTimeline,
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
 * Phase PRODUCTION-BOM-CHANGE: a change request's event history — a READ-ONLY section of
 * `/admin/production/changes/[id]`.
 *
 * WHY IT IS NOT `ProductionBomTimeline` WITH A DIFFERENT ID
 * -------------------------------------------------------
 * That component is bound to `fetchProductionBomTimeline(bomId, …)` and to test ids the BOM
 * detail screen already owns; parameterising it would make its props a union of two contracts
 * rather than one. The two screens differ in exactly one way that matters — which
 * SERVER-BOUND resource the read is scoped to — and a second, identical-shaped component
 * states that once, in its own type, without weakening the first.
 *
 * WHAT IS DIFFERENT FROM THE BOM'S TIMELINE, AND WHY
 * -------------------------------------------------
 * This timeline carries ALL NINE action families — the header's six AND the three DETAIL
 * acts (`add_item`, `update_item`, `remove_item`) — because every one of them is recorded
 * under the request's own `resourceId`. The BOM header's timeline structurally cannot reach
 * its item events; this one is complete.
 *
 * WHAT IT RENDERS, AND WHAT IT REFUSES TO INVENT
 * ---------------------------------------------
 *   * The ORDER is the server's (`createdAt ASC, id ASC`) — chronological. Nothing re-sorts.
 *   * The LABEL comes from `productionBomAuditActionLabel`, which falls back to the raw audit
 *     token for a verb it does not know rather than inventing a sentence.
 *   * ONLY what the audit read contract exposes: verb, instant, actor id, outcome, reason and
 *     changed field NAMES. There is no payload to redact because the projection carries none.
 *   * EMPTY and FAILED are DIFFERENT. Zero events says «رویدادی ثبت نشده است»; a rejected read
 *     shows the refusal. Rendering the second as the first would tell a reader nothing
 *     happened when the truth is nothing could be asked.
 *
 * PERMISSION: the parent hides the section without `production.bom.read`, and the endpoint
 * refuses independently. This component does not re-check the grant — a page-level decision
 * belongs to the page.
 */
export function ProductionBomChangeTimeline({ requestId }: { requestId: string }) {
  const [page, setPage] = React.useState<ProductionBomTimelinePage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [pageNumber, setPageNumber] = React.useState(1);

  const load = React.useCallback(
    async (target: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchProductionBomChangeTimeline(requestId, {
          page: target,
          pageSize: PRODUCTION_DEFAULT_PAGE_SIZE,
        });
        setPage(result);
      } catch (err: unknown) {
        const details = err instanceof CoreApiError ? err.details : undefined;
        setError(
          productionErrorMessage(
            productionErrorCode(details),
            productionServerMessage(details) ?? 'دریافت تاریخچه رویدادها با خطا مواجه شد.'
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [requestId]
  );

  React.useEffect(() => {
    // Deferred to a microtask so the loader's own `setLoading(true)`/`setError(null)`
    // arm does not run synchronously inside the effect body
    // (`react-hooks/set-state-in-effect`); the flag cancels an unmount.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load(1);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  React.useEffect(() => {
    if (pageNumber !== 1) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) void load(pageNumber);
      });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [pageNumber, load]);

  const entries = page?.items ?? [];

  return (
    <ProductionCard testId="production-change-timeline">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">تاریخچه رویدادها</h2>
        {page && (
          <span
            data-testid="production-change-timeline-count"
            className="text-xs text-muted-foreground"
          >
            {toPersianDigits(String(page.total))} رویداد
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4" data-testid="production-change-timeline-error">
          <CoreError message={error} onRetry={() => void load(pageNumber)} />
        </div>
      )}

      {!error && isLoading && page === null ? (
        <CoreLoading lines={4} />
      ) : !error && entries.length === 0 ? (
        <ProductionEmptyState
          message="هنوز رویدادی برای این درخواست تغییر ثبت نشده است."
          testId="production-change-timeline-empty"
        />
      ) : (
        <>
          <ol aria-busy={isLoading} className="flex flex-col gap-3">
            {entries.map((entry) => (
              <ChangeTimelineRow key={entry.id} entry={entry} />
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
 * One event. Chronological, and every fact it shows came off the row — `changedFields`
 * renders NAMES only, because names are all the contract exposes.
 */
function ChangeTimelineRow({ entry }: { entry: ProductionBomTimelineEntry }) {
  return (
    <li
      data-testid="production-change-timeline-entry"
      data-action={entry.action}
      className="border-b border-border/60 pb-3 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          data-testid="production-change-timeline-action"
          className="text-sm font-medium text-foreground"
        >
          {productionBomAuditActionLabel(entry.action)}
        </span>
        <span className="text-xs text-muted-foreground">
          {productionAuditTimestampLabel(entry.createdAt)}
        </span>
        <span
          data-testid="production-change-timeline-actor"
          className="text-xs text-muted-foreground"
        >
          {entry.actorId ?? '—'}
        </span>
        {!entry.success && (
          <span
            data-testid="production-change-timeline-failed"
            className="text-xs text-destructive"
          >
            ناموفق
          </span>
        )}
      </div>

      {entry.reason && (
        <p
          data-testid="production-change-timeline-reason"
          className="mt-1 text-xs text-muted-foreground"
        >
          {entry.reason}
        </p>
      )}

      {entry.changedFields.length > 0 && (
        <p
          data-testid="production-change-timeline-changed-fields"
          className="mt-1 text-xs text-muted-foreground"
        >
          فیلدهای تغییریافته: {entry.changedFields.join('، ')}
        </p>
      )}
    </li>
  );
}

