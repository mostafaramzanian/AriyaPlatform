'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  COMMERCE_DEFAULT_PAGE_SIZE,
  fetchCommerceCommercialApprovals,
  fetchCommercePurchaseDocuments,
  pendingApprovalsForUser,
  type CommerceApprovalStatus,
  type CommerceDocumentStatus,
} from '@/lib/commerce-api';
import { commerceInstantLabel, commerceLineTypeLabel } from '@/lib/commerce-labels';
import {
  CommerceApprovalStatusBadge,
  CommerceCard,
  CommerceDocumentStatusBadge,
  CommerceEmptyState,
  CommercePageHeading,
} from './commerce-ui';

/**
 * PHASE UI-1: the task workspace — `/admin/commerce/tasks`.
 *
 * WHAT THIS SCREEN HONESTLY IS. The backend has NO global "pending decision for me"
 * endpoint (UI-0 BACKEND GAP-1b) and no workflow-instance read at all (GAP-1), so this
 * screen uses UI-0 §8.1's Option A verbatim: read the most recent SUBMITTED documents from
 * the register (one page — the documented 20-document ceiling), read each document's
 * commercial approvals, and show the PENDING rows whose stored `approverUserId` equals the
 * session's own user. Every row is therefore a REAL decision record the backend created for
 * this person — and the copy states the scan's bound so nobody can mistake it for a
 * complete inbox. There is deliberately no «همه کارهای شما» claim, no SLA, no assignee, no
 * workflow actor and no overdue marker: none of those facts exists in the supported reads,
 * and UI-1 renders no fact it did not receive.
 *
 * THE ACTION OPENS THE REAL DECISION (UI-3). Each actionable row now carries ONE primary
 * action — «مشاهده و تصمیم‌گیری» — which deep-links into the SAME document's commercial
 * section (`?decision=<approvalId>`) where UI-3's decision panel opens; the decision is
 * registered there, in the Purchase context, never in a detached approval route. The
 * limitation note stays: this list is still a bounded composition, never a global inbox.
 *
 * THE WORKFLOW TAB IS ABSENT, NOT EMPTY-STATEFUL. GAP-1 means no read could back it; a
 * placeholder would be a promise the API cannot keep (UI-0 §8.1: hidden beats fake).
 */

type TaskTabKey = 'approvals' | 'drafts';

interface ApprovalTaskRow {
  key: string;
  /** The document this approval lives on — the destination of the action (§17). */
  documentId: string;
  documentNumber: string;
  /** «ردیف ۳ — استاندارد», or a bare «ردیف» when the document payload lacks that line. */
  lineLabel: string;
  documentStatus: CommerceDocumentStatus;
  approvalStatus: CommerceApprovalStatus;
  createdAt: string;
}

interface DraftTaskRow {
  key: string;
  documentId: string;
  documentNumber: string;
  lineCount: number;
  updatedAt: string;
}

interface ApprovalsScan {
  rows: ApprovalTaskRow[];
  /** How many SUBMITTED documents were actually scanned in this run. */
  scanned: number;
  /** The server's total SUBMITTED count — larger than `scanned` when the cap bites. */
  total: number;
}

export function CommerceTasksView() {
  const { user, isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');
  const canApprove = rbac.permissions.includes('commerce.approve') && canRead;

  const userId = user?.userId ?? user?.sub ?? null;

  /**
   * «پیش‌نویس‌های من» is a claim about a PERSON, so the tab exists only when the session
   * has a person id to scope it with — without one, a drafts read would show the tenant's
   * drafts under a «mine» label, which is exactly the kind of lie this phase forbids
   * (machine sessions do not browse; interactive ones always carry an id).
   */
  const canManageDrafts =
    rbac.permissions.includes('commerce.manage') && canRead && userId !== null;

  const visibleTabs = React.useMemo<Array<{ key: TaskTabKey; label: string }>>(() => {
    const tabs: Array<{ key: TaskTabKey; label: string }> = [];
    if (canApprove) tabs.push({ key: 'approvals', label: 'تصمیم‌های بازرگانی من' });
    if (canManageDrafts) tabs.push({ key: 'drafts', label: 'پیش‌نویس‌های من' });
    return tabs;
  }, [canApprove, canManageDrafts]);

  const [requestedTab, setRequestedTab] = React.useState<TaskTabKey>('approvals');
  const activeTab: TaskTabKey | null = visibleTabs.some((tab) => tab.key === requestedTab)
    ? requestedTab
    : visibleTabs[0]?.key ?? null;

  const [approvals, setApprovals] = React.useState<ApprovalsScan | null>(null);
  const [approvalsLoading, setApprovalsLoading] = React.useState(false);
  const [approvalsError, setApprovalsError] = React.useState<string | null>(null);

  const [drafts, setDrafts] = React.useState<DraftTaskRow[] | null>(null);
  const [draftsLoading, setDraftsLoading] = React.useState(false);
  const [draftsError, setDraftsError] = React.useState<string | null>(null);

  // Re-arms loading/cleared in each tab's retry handler (same commit as the
  // token bump), so the fetch effects below need no in-effect setter resets.
  const approvalsReload = useReloadToken(setApprovalsLoading, setApprovalsError);
  const draftsReload = useReloadToken(setDraftsLoading, setDraftsError);

  /**
   * Option A's composition, bounded by the documented page ceiling: one register page of
   * SUBMITTED documents, one approvals read per document — both reads of the SAME grants
   * (`commerce.read`), plus the client-side `pending && approverUserId === me` filter. A
   * failed approvals read fails the TAB (retryable) rather than silently under-reporting
   * somebody's work.
   */
  React.useEffect(() => {
    if (activeTab !== 'approvals' || !canApprove) return;

    let active = true;

    (async () => {
      const page = await fetchCommercePurchaseDocuments({
        page: 1,
        pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
        status: 'SUBMITTED',
      });
      const reads = await Promise.all(
        page.items.map((document) => fetchCommerceCommercialApprovals(document.id))
      );

      const rows: ApprovalTaskRow[] = [];
      page.items.forEach((document, index) => {
        const mine = pendingApprovalsForUser(reads[index]?.approvals ?? [], userId);
        for (const approval of mine) {
          const line = document.lines.find((candidate) => candidate.id === approval.purchaseLineId);
          rows.push({
            key: approval.id,
            documentId: document.id,
            documentNumber: document.documentNumber,
            lineLabel: line
              ? `ردیف ${toPersianDigits(line.lineNumber)} — ${commerceLineTypeLabel(line.lineType)}`
              : 'ردیف —',
            documentStatus: document.status,
            approvalStatus: approval.status,
            createdAt: approval.createdAt,
          });
        }
      });

      return {
        rows: rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        scanned: page.items.length,
        total: page.total,
      };
    })()
      .then((scan) => {
        if (!active) return;
        setApprovals(scan);
        setApprovalsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setApprovals(null);
        setApprovalsError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setApprovalsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTab, canApprove, userId, approvalsReload.token]);

  /** The drafts tab: the caller's own DRAFT documents, straight from the register filter. */
  React.useEffect(() => {
    if (activeTab !== 'drafts' || !canManageDrafts) return;

    let active = true;

    fetchCommercePurchaseDocuments({
      page: 1,
      pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
      status: 'DRAFT',
      ...(userId ? { requesterId: userId } : {}),
    })
      .then((page) => {
        if (!active) return;
        setDrafts(
          page.items.map((document) => ({
            key: document.id,
            documentId: document.id,
            documentNumber: document.documentNumber,
            lineCount: document.lines.length,
            updatedAt: document.updatedAt,
          }))
        );
        setDraftsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setDrafts(null);
        setDraftsError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setDraftsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTab, canManageDrafts, userId, draftsReload.token]);

  // Whether each tab is meaningfully waiting for a response. `xLoading`
  // covers retries (armed by the hooks above, settled by the fetch effects);
  // the derived term covers the FIRST load of the visible tab, where no
  // handler ever arms it: once the tab is active and its grant is held and
  // neither data nor error has arrived, the panel is by definition waiting
  // for its first response. This replaces the previous in-effect
  // `setLoading(true)` resets (`react-hooks/set-state-in-effect`).
  const approvalsBusy =
    approvalsLoading ||
    (activeTab === 'approvals' && canApprove && approvals === null && approvalsError === null);
  const draftsBusy =
    draftsLoading ||
    (activeTab === 'drafts' && canManageDrafts && drafts === null && draftsError === null);

  /**
   * Roving focus for the tablist (the APG pattern): arrows move BOTH selection and focus.
   * Under `dir="rtl"` the NEXT tab lies to the LEFT, so ArrowLeft advances and ArrowRight
   * retreats — and since the row wraps, both keys work from either end.
   */
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const moveTab = (direction: 1 | -1) => {
    if (!activeTab || visibleTabs.length === 0) return;
    const index = visibleTabs.findIndex((tab) => tab.key === activeTab);
    const next = visibleTabs[(index + direction + visibleTabs.length) % visibleTabs.length];
    setRequestedTab(next.key);
    tabRefs.current[next.key]?.focus();
  };

  if (rbac.isLoading) {
    return <CoreLoading lines={5} />;
  }

  if (!canRead || visibleTabs.length === 0) {
    return (
      <CoreForbidden message="برای این بخش به مجوز commerce.approve یا commerce.manage نیاز دارید." />
    );
  }

  return (
    <div data-testid="commerce-tasks">
      <CommercePageHeading
        title="نیازمند اقدام من"
        description="مواردی که از داده‌های در دسترس سیستم برای شما قابل شناسایی است"
      />

      <div
        role="tablist"
        aria-label="نیازمند اقدام"
        className="mb-4 inline-flex rounded-xl border border-border bg-secondary/40 p-1"
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            moveTab(1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            moveTab(-1);
          }
        }}
      >
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            ref={(node) => {
              tabRefs.current[tab.key] = node;
            }}
            type="button"
            role="tab"
            id={`commerce-tab-${tab.key}`}
            aria-selected={activeTab === tab.key}
            aria-controls={`commerce-tabpanel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => setRequestedTab(tab.key)}
            className={`rounded-lg px-4 py-2 text-xs font-medium transition ${
              activeTab === tab.key
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'approvals' && (
        <div
          role="tabpanel"
          id="commerce-tabpanel-approvals"
          aria-labelledby="commerce-tab-approvals"
        >
          <CommerceCard testId="commerce-tasks-approvals">
            <p
              data-testid="commerce-tasks-limitation-note"
              className="mb-4 rounded-xl border border-border bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground"
            >
              این فهرست از داده‌های در دسترس ساخته می‌شود: درخواست‌های ارسال‌شدهٔ اخیر بررسی
              می‌شوند و ممکن است موارد خارج از این بازه در آن نباشند. برای ثبت تصمیم، روی
              «مشاهده و تصمیم‌گیری» بزنید؛ تصمیم در بخش بازرگانیِ همان سند درخواست خرید ثبت
              می‌شود.
            </p>

            {approvalsBusy ? (
              <CoreLoading lines={4} />
            ) : approvalsError ? (
              <CoreError message={approvalsError} onRetry={approvalsReload.reload} />
            ) : approvals && approvals.rows.length > 0 ? (
              <>
                {approvals.total > approvals.scanned && (
                  <p
                    data-testid="commerce-tasks-cap-note"
                    className="mb-3 text-xs text-muted-foreground"
                  >
                    {toPersianDigits(approvals.scanned)} درخواست اخیر بررسی شد؛ در مجموع{' '}
                    {toPersianDigits(approvals.total)} درخواست ارسال‌شده ثبت شده است.
                  </p>
                )}
                <ul className="divide-y divide-border" data-testid="commerce-tasks-approval-rows">
                  {approvals.rows.map((row) => (
                    <li
                      key={row.key}
                      data-testid={`commerce-task-approval-${row.key}`}
                      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <span
                          dir="ltr"
                          className="w-fit rounded-md bg-muted px-2 py-0.5 text-xs text-foreground"
                        >
                          {row.documentNumber}
                        </span>
                        <span className="text-sm text-foreground">{row.lineLabel}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        <CommerceDocumentStatusBadge status={row.documentStatus} />
                        <CommerceApprovalStatusBadge status={row.approvalStatus} />
                        <span className="text-xs text-muted-foreground" title={row.createdAt}>
                          از {commerceInstantLabel(row.createdAt)}
                        </span>
                        <Link
                          href={`/admin/commerce/purchases/${row.documentId}?decision=${encodeURIComponent(
                            row.key
                          )}`}
                          data-testid={`commerce-task-action-${row.key}`}
                          className="inline-flex h-9 items-center rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
                        >
                          مشاهده و تصمیم‌گیری
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <CommerceEmptyState
                testId="commerce-tasks-approvals-empty"
                message="در حال حاضر موردی در انتظار تصمیم بازرگانی شما نیست."
                action={
                  <Link
                    href="/admin/commerce/purchases"
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    مشاهدهٔ درخواست‌های خرید
                  </Link>
                }
              />
            )}
          </CommerceCard>
        </div>
      )}

      {activeTab === 'drafts' && (
        <div role="tabpanel" id="commerce-tabpanel-drafts" aria-labelledby="commerce-tab-drafts">
          <CommerceCard testId="commerce-tasks-drafts">
            {draftsBusy ? (
              <CoreLoading lines={4} />
            ) : draftsError ? (
              <CoreError message={draftsError} onRetry={draftsReload.reload} />
            ) : drafts && drafts.length > 0 ? (
              <ul className="divide-y divide-border" data-testid="commerce-tasks-draft-rows">
                {drafts.map((row) => (
                  <li
                    key={row.key}
                    data-testid={`commerce-task-draft-${row.documentNumber}`}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <Link
                        href={`/admin/commerce/purchases/${row.documentId}`}
                        aria-label={`مشاهدهٔ سند ${row.documentNumber}`}
                        dir="ltr"
                        className="w-fit rounded-md bg-muted px-2 py-0.5 text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                      >
                        {row.documentNumber}
                      </Link>
                      <span className="text-sm text-muted-foreground">
                        {toPersianDigits(row.lineCount)} ردیف
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground" title={row.updatedAt}>
                      آخرین تغییر: {commerceInstantLabel(row.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <CommerceEmptyState
                testId="commerce-tasks-drafts-empty"
                message="پیش‌نویس فعالی برای شما وجود ندارد."
              />
            )}
          </CommerceCard>
        </div>
      )}
    </div>
  );
}



