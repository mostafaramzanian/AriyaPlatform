'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/button';
import {
  fetchCommerceAssignments,
  fetchCommerceCommercialApprovals,
  fetchCommerceCommercialGroups,
  fetchCommercePayments,
  fetchCommercePurchaseDocument,
  fetchCommerceReceipts,
  fetchCommerceReturns,
  pendingApprovalsForUser,
  submitCommercePurchaseDocument,
  type CommerceCommercialGroup,
  type CommercePaymentsRead,
  type CommercePurchaseDocument,
  type CommerceReceiptsRead,
  type CommerceReturnsRead,
} from '@/lib/commerce-api';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  commerceActionErrorMessage,
  commerceDateLabel,
  commerceDisplayName,
  commerceDocumentKindLabel,
  commerceInstantLabel,
  commerceMoneyLabel,
} from '@/lib/commerce-labels';
import { decimalDisplayLabel } from '@/lib/commerce-decimals';
import {
  CommerceCard,
  CommerceDocumentStatusBadge,
  CommerceFeedback,
  CommercePageHeading,
  CommercePaymentStatusBadge,
  CommerceReceivingStatusBadge,
  CommerceReturnStateBadge,
} from './commerce-ui';
import { CommerceConfirmDialog } from './CommerceConfirmDialog';
import { CommercePurchaseLinesTable } from './purchase/CommercePurchaseLinesTable';
import { CommerceCommercialSection } from './purchase/CommerceCommercialSection';
import { CommercePaymentsSection } from './purchase/CommercePaymentsSection';
import { CommerceReceiptsSection } from './purchase/CommerceReceiptsSection';
import { CommerceReturnsSection } from './purchase/CommerceReturnsSection';
import { initialSectionState, type SectionState } from './purchase/section-state';

/**
 * PHASE UI-2: Purchase Detail — `/admin/commerce/purchases/[id]`, the CENTRAL workspace
 * for one document (UI-0 §10). NOT a giant CRUD page: the header answers identity and
 * state, then every operational domain lives behind its own tab with its OWN loading,
 * error and empty state — so a failed payments read never blanks a document the user can
 * otherwise understand (UI-2 §28), and a mutation refetches only the section it changed.
 *
 * WHAT IS DELIBERATELY ABSENT. Workflow execution UI (GAP-1: no HTTP surface — no fake
 * stepper, actor or approver anywhere), the commercial DECISION workspace (UI-3), and a
 * fabricated audit timeline (GAP-7): the «رویدادها» tab lists only facts of reads this
 * page already performs, labelled as such. Lifecycle dimensions stay independent —
 * document status, payment projection, receiving projection, returns, commercial — and
 * are never collapsed into one global status.
 *
 * PHASE UI-5 (§9/§11): the header now also answers «چه کاری میتوانم انجام دهم؟». When the
 * page's own approvals read reports a PENDING commercial record assigned to the session
 * user and the session holds `commerce.approve`, one callout states it and opens the
 * Commercial tab — no extra request, no invented assignee, and the decision is still
 * registered only in the one decision panel.
 */

const DETAIL_BASE = '/admin/commerce/purchases';
const LIST_BASE = '/admin/commerce/purchases';

type TabId = 'overview' | 'lines' | 'commercial' | 'payments' | 'receipts' | 'returns' | 'events';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'خلاصه' },
  { id: 'lines', label: 'ردیف‌ها' },
  { id: 'commercial', label: 'بازرگانی' },
  { id: 'payments', label: 'پرداخت‌ها' },
  { id: 'receipts', label: 'دریافت‌ها' },
  { id: 'returns', label: 'مرجوعی‌ها' },
  { id: 'events', label: 'رویدادها' },
];

type SectionKey = 'payments' | 'receipts' | 'returns' | 'assignments' | 'approvals' | 'groups';

interface DetailSections {
  payments: SectionState<CommercePaymentsRead>;
  receipts: SectionState<CommerceReceiptsRead>;
  returns: SectionState<CommerceReturnsRead>;
  assignments: SectionState<Awaited<ReturnType<typeof fetchCommerceAssignments>>>;
  approvals: SectionState<Awaited<ReturnType<typeof fetchCommerceCommercialApprovals>>>;
  groups: SectionState<CommerceCommercialGroup[]>;
}

function freshSections(): DetailSections {
  return {
    payments: initialSectionState(),
    receipts: initialSectionState(),
    returns: initialSectionState(),
    assignments: initialSectionState(),
    approvals: initialSectionState(),
    groups: initialSectionState(),
  };
}

/** What the document's own status means, in one honest sentence — no actors invented. */
function documentStatusHint(status: string): string {
  if (status === 'DRAFT') return 'پیش‌نویس است و تا زمان ارسال قابل ویرایش می‌ماند.';
  if (status === 'SUBMITTED') return 'ارسال شده و در انتظار تصمیم است.';
  if (status === 'APPROVED') return 'تصمیم مثبت برای این سند ثبت شده است.';
  if (status === 'REJECTED') return 'تصمیم منفی برای این سند ثبت شده است.';
  if (status === 'CANCELLED') return 'این سند لغو شده است.';
  if (status === 'CLOSED') return 'این سند بسته شده است.';
  return '';
}

export function CommercePurchaseDetailView({
  documentId,
  decisionId = null,
}: {
  documentId: string;
  /** `?decision=<approvalId>` — the My Tasks deep link into the decision panel (§17). */
  decisionId?: string | null;
}) {
  const { user, isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('commerce.read');
  const canManage = rbac.permissions.includes('commerce.manage');
  const canApprove = rbac.permissions.includes('commerce.approve') && canRead;

  const [purchase, setPurchase] = React.useState<CommercePurchaseDocument | null>(null);
  const [docStatus, setDocStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [docError, setDocError] = React.useState<string | null>(null);
  const [docToken, setDocToken] = React.useState(0);
  // Record-change re-arm happens here, synchronously during render (guarded by
  // the previous id) — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect below only settles. First
  // mount is covered by the initial `docStatus: 'loading'`; retries re-arm in
  // their handlers below.
  const [prevDocumentId, setPrevDocumentId] = React.useState(documentId);
  if (prevDocumentId !== documentId) {
    setPrevDocumentId(documentId);
    setDocStatus('loading');
    setDocError(null);
  }

  const [sections, setSections] = React.useState<DetailSections>(freshSections);
  const [tokens, setTokens] = React.useState<Record<SectionKey, number>>({
    payments: 0,
    receipts: 0,
    returns: 0,
    assignments: 0,
    approvals: 0,
    groups: 0,
  });

  // The My Tasks deep link (`?decision=<approvalId>`) lands the user straight in the
  // Commercial tab: the decision panel lives there behind conditional tab rendering, so
  // opening on 'overview' would leave the deep link staring at a page whose panel never
  // mounts. Without the parameter the entry point stays the overview (browser QA run3).
  const [activeTab, setActiveTab] = React.useState<TabId>(
    decisionId ? 'commercial' : 'overview'
  );
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [commercialOpen, setCommercialOpen] = React.useState(false);

  const [confirmSubmit, setConfirmSubmit] = React.useState(false);
  const [submitPending, setSubmitPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{
    message: string;
    tone: 'ok' | 'danger';
  } | null>(null);

  const reloadSection = React.useCallback((key: SectionKey) => {
    setTokens((prev) => ({ ...prev, [key]: prev[key] + 1 }));
    // The section re-arm that used to run inside the loader effect (one render
    // later, `react-hooks/set-state-in-effect`) now happens in the SAME event
    // commit that requests the refetch: clear a stale error when data exists,
    // or return to the loading skeleton when the section never loaded.
    setSections((prev) => ({
      ...prev,
      [key]: prev[key].data
        ? { ...prev[key], error: null }
        : { status: 'loading', data: null, error: null },
    }));
  }, []);

  // The PRIMARY read. Its failure replaces the page (there is nothing to render); every
  // other failure stays inside its own section.
  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;
    let active = true;

    fetchCommercePurchaseDocument(documentId)
      .then((loaded) => {
        if (!active) return;
        setPurchase(loaded);
        setDocStatus('ready');
      })
      .catch((err: unknown) => {
        if (!active) return;
        setDocError(commerceActionErrorMessage(err, 'دریافت سند درخواست خرید با خطا مواجه شد.'));
        setDocStatus('error');
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated, rbac.isLoading, canRead, documentId, docToken]);

  /**
   * One targeted loader per section. On a refetch the previous data is KEPT (only the
   * error clears — armed by `reloadSection` in the requesting handler) so a section never
   * blanks while reloading; a FIRST failure becomes the section's own error state, and a
   * later failure keeps the last good data with the message recorded. This callback only
   * starts the read and settles it — no synchronous setters.
   */
  const runSection = React.useCallback(
    <K extends SectionKey>(
      key: K,
      isActive: () => boolean,
      loader: () => Promise<DetailSections[K]['data']>
    ) => {
      loader()
        .then((data) => {
          if (!isActive()) return;
          setSections((prev) => ({ ...prev, [key]: { status: 'ready', data, error: null } }));
        })
        .catch((err: unknown) => {
          if (!isActive()) return;
          const message = commerceActionErrorMessage(
            err,
            'دریافت اطلاعات این بخش با خطا مواجه شد.'
          );
          setSections((prev) => ({
            ...prev,
            [key]: prev[key].data
              ? { status: 'ready', data: prev[key].data, error: message }
              : { status: 'error', data: null, error: message },
          }));
        });
    },
    []
  );

  React.useEffect(() => {
    if (docStatus !== 'ready') return;
    let active = true;
    const isActive = () => active;
    runSection('payments', isActive, () => fetchCommercePayments(documentId, { pageSize: 100 }));
    return () => {
      active = false;
    };
  }, [docStatus, documentId, tokens.payments, runSection]);

  React.useEffect(() => {
    if (docStatus !== 'ready') return;
    let active = true;
    const isActive = () => active;
    runSection('receipts', isActive, () => fetchCommerceReceipts(documentId));
    return () => {
      active = false;
    };
  }, [docStatus, documentId, tokens.receipts, runSection]);

  React.useEffect(() => {
    if (docStatus !== 'ready') return;
    let active = true;
    const isActive = () => active;
    runSection('returns', isActive, () => fetchCommerceReturns(documentId));
    return () => {
      active = false;
    };
  }, [docStatus, documentId, tokens.returns, runSection]);

  React.useEffect(() => {
    if (docStatus !== 'ready') return;
    let active = true;
    const isActive = () => active;
    runSection('assignments', isActive, () => fetchCommerceAssignments(documentId));
    runSection('approvals', isActive, () => fetchCommerceCommercialApprovals(documentId));
    return () => {
      active = false;
    };
  }, [docStatus, documentId, tokens.assignments, tokens.approvals, runSection]);

  // Groups are read ONLY when the commercial tab has actually been opened and the caller
  // may manage — a bounded read for the assign form, never a page-wide prefetch.
  React.useEffect(() => {
    if (docStatus !== 'ready' || !commercialOpen || !canManage) return;
    let active = true;
    const isActive = () => active;
    runSection('groups', isActive, async () => {
      const page = await fetchCommerceCommercialGroups({ pageSize: 100 });
      return page.items;
    });
    return () => {
      active = false;
    };
  }, [docStatus, commercialOpen, canManage, tokens.groups, runSection]);

  const handleTabChange = React.useCallback((next: TabId) => {
    setActiveTab(next);
    if (next === 'commercial') setCommercialOpen(true);
  }, []);

  /** WAI-ARIA tabs, RTL-aware: ArrowLeft advances in RTL (the shell's own convention). */
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const isRtl = window.document.documentElement.getAttribute('dir') === 'rtl';
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forward) next = (index + 1) % TABS.length;
    else if (event.key === backward) next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    handleTabChange(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const handleSubmit = async () => {
    if (submitPending) return;
    setConfirmSubmit(false);
    setSubmitPending(true);
    setFeedback(null);
    try {
      const submitted = await submitCommercePurchaseDocument(documentId);
      setFeedback({ message: 'درخواست خرید ارسال شد.', tone: 'ok' });
      setPurchase(submitted);
      /*
       * PHASE UI-5 (§7/§29): SUBMIT HAS CONSEQUENCES OUTSIDE THE DOCUMENT. The server routes
       * the lines and runs the configured commercial activation in the same write, so the
       * approvals this page renders were just created — a header that kept the pre-submit
       * reads would tell the approver «تأیید بازرگانی ثبت نشده است» about a decision that
       * exists, and would hide the callout that says it is theirs. Only the two sections the
       * submit actually changes are refetched; it is still a targeted invalidation.
       */
      reloadSection('assignments');
      reloadSection('approvals');
    } catch (err: unknown) {
      setFeedback({
        message: commerceActionErrorMessage(err, 'ارسال سند انجام نشد؛ وضعیت را بازخوانی کنید.'),
        tone: 'danger',
      });
      // Re-arm the primary read in the same commit as the token bump (the
      // removed in-effect setters used to establish this state one render later).
      setDocStatus('loading');
      setDocError(null);
      setDocToken((token) => token + 1);
    } finally {
      setSubmitPending(false);
    }
  };

  if (rbac.isLoading) {
    return <CoreLoading lines={6} />;
  }

  if (!canRead) {
    return (
      <CoreForbidden message="برای مشاهدهٔ سند درخواست خرید به مجوز commerce.read نیاز دارید." />
    );
  }

  if (docStatus === 'loading' && purchase === null) {
    return <CoreLoading lines={6} />;
  }

  if (docStatus === 'error' && purchase === null) {
    return (
      <div data-testid="commerce-purchase-detail-error">
        <CommercePageHeading title="سند درخواست خرید" />
        <CoreError
          message={docError ?? 'خطا'}
          onRetry={() => {
            setDocStatus('loading');
            setDocError(null);
            setDocToken((t) => t + 1);
          }}
        />
        <Link
          href={LIST_BASE}
          className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          بازگشت به فهرست
        </Link>
      </div>
    );
  }

  if (!purchase) return <CoreLoading lines={6} />;

  const isDraft = purchase.status === 'DRAFT';
  const lineCount = purchase.lines.length;

  /**
   * PHASE UI-5 (§9/§11): THE OBVIOUS NEXT ACTION. The commercial approvals read this page
   * already performs (one document-scoped call, the SAME one the Commercial tab renders)
   * states which PENDING records the activation assigned to THIS user — the exact filter
   * the decision route enforces server-side. When at least one exists, the header says so
   * and opens the Commercial tab; the panel itself stays the one place a decision is
   * registered. A reader without `commerce.approve` sees nothing, and a document with no
   * pending decision for this user gains no decoration.
   */
  const myPendingApprovals =
    canApprove && sections.approvals.status === 'ready' && sections.approvals.data
      ? pendingApprovalsForUser(
          sections.approvals.data.approvals,
          user?.userId ?? user?.sub ?? null
        )
      : [];

  return (
    <div data-testid="commerce-purchase-detail">
      <CommercePageHeading
        title="سند درخواست خرید"
        actions={
          <>
            <Link
              href={LIST_BASE}
              data-testid="commerce-detail-back"
              className="inline-flex h-10 items-center gap-1 rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
              بازگشت به فهرست درخواست‌ها
            </Link>
            {isDraft && canManage && (
              <>
                <Link
                  href={`${DETAIL_BASE}/new?edit=${encodeURIComponent(documentId)}`}
                  data-testid="commerce-detail-edit"
                  className="inline-flex h-10 items-center rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary"
                >
                  ویرایش پیش‌نویس
                </Link>
                <Button
                  type="button"
                  onClick={() => setConfirmSubmit(true)}
                  disabled={submitPending}
                  aria-busy={submitPending}
                  data-testid="commerce-detail-submit"
                >
                  {submitPending ? 'در حال ارسال…' : 'ارسال درخواست'}
                </Button>
              </>
            )}
          </>
        }
      />

      <CommerceCard testId="commerce-detail-identity" className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            dir="ltr"
            data-testid="commerce-detail-number"
            className="rounded-md bg-muted px-2 py-0.5 text-sm text-foreground"
          >
            {purchase.documentNumber}
          </span>
          <CommerceDocumentStatusBadge status={purchase.status} />
          <span className="text-sm text-muted-foreground">
            {commerceDocumentKindLabel(purchase.kind)}
          </span>
          {purchase.editable && (
            <span className="text-xs text-muted-foreground">قابل ویرایش (پیش‌نویس)</span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{documentStatusHint(purchase.status)}</p>

        {myPendingApprovals.length > 0 && (
          <div
            data-testid="commerce-detail-pending-decision"
            className="mt-3 flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm text-foreground">
              {toPersianDigits(myPendingApprovals.length)} تصمیم بازرگانی در انتظار شماست.
            </p>
            <Button
              type="button"
              onClick={() => handleTabChange('commercial')}
              data-testid="commerce-detail-pending-decision-open"
              className="h-9 w-fit text-xs"
            >
              بررسی و تصمیم‌گیری
            </Button>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">درخواست‌کننده</dt>
            <dd className="mt-1 text-foreground">
              {commerceDisplayName(purchase.requester.profile, purchase.requester.id)}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">جمع کل</dt>
            <dd className="mt-1 text-foreground">
              {commerceMoneyLabel(purchase.totalAmount, purchase.currency)}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">تعداد ردیف</dt>
            <dd className="mt-1 text-foreground">{toPersianDigits(lineCount)}</dd>
          </div>
          <div className="rounded-xl border border-border bg-secondary/30 p-3">
            <dt className="text-xs text-muted-foreground">آخرین به‌روزرسانی</dt>
            <dd className="mt-1 text-foreground" title={purchase.updatedAt}>
              {commerceDateLabel(purchase.updatedAt)}
            </dd>
          </div>
        </dl>

        {purchase.supplierId && (
          <p className="mt-3 text-xs text-muted-foreground">
            تأمین‌کننده: <span dir="ltr">{purchase.supplierId}</span>
          </p>
        )}
      </CommerceCard>

      {feedback && (
        <CommerceFeedback
          message={feedback.message}
          tone={feedback.tone}
          testId="commerce-detail-feedback"
        />
      )}

      <div
        role="tablist"
        aria-label="بخش‌های سند درخواست خرید"
        className="mt-6 mb-4 flex gap-2 overflow-x-auto border-b border-border"
      >
        {TABS.map((tab, index) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`commerce-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`commerce-tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => handleTabChange(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              data-testid={`commerce-detail-tab-${tab.id}`}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'overview' && (
        <div role="tabpanel" id="commerce-tabpanel-overview" aria-labelledby="commerce-tab-overview">
          <CommerceCard title="چرخه‌های سند" testId="commerce-detail-lifecycle">
            <p className="mb-4 text-xs text-muted-foreground">
              هر چرخه مستقل است؛ وضعیت یکی، وضعیت دیگری را تعیین نمی‌کند.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div
                className="rounded-xl border border-border p-3"
                data-testid="commerce-lifecycle-document"
              >
                <p className="text-xs text-muted-foreground">وضعیت سند</p>
                <div className="mt-2">
                  <CommerceDocumentStatusBadge status={purchase.status} />
                </div>
              </div>

              <div
                className="rounded-xl border border-border p-3"
                data-testid="commerce-lifecycle-payment"
              >
                <p className="text-xs text-muted-foreground">پرداخت</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sections.payments.status === 'loading' && !sections.payments.data ? (
                    <span className="text-xs text-muted-foreground">در حال بارگذاری…</span>
                  ) : sections.payments.status === 'error' && !sections.payments.data ? (
                    <span className="text-xs text-muted-foreground">در دسترس نیست</span>
                  ) : (
                    <>
                      <CommercePaymentStatusBadge
                        status={sections.payments.data?.paymentStatus.status ?? null}
                      />
                      <span className="text-xs text-muted-foreground">
                        {decimalDisplayLabel(
                          sections.payments.data?.paymentStatus.paidAmount ?? null
                        )}
                        {' از '}
                        {decimalDisplayLabel(
                          sections.payments.data?.paymentStatus.totalAmount ?? null
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div
                className="rounded-xl border border-border p-3"
                data-testid="commerce-lifecycle-receiving"
              >
                <p className="text-xs text-muted-foreground">دریافت</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sections.receipts.status === 'loading' && !sections.receipts.data ? (
                    <span className="text-xs text-muted-foreground">در حال بارگذاری…</span>
                  ) : sections.receipts.status === 'error' && !sections.receipts.data ? (
                    <span className="text-xs text-muted-foreground">در دسترس نیست</span>
                  ) : (
                    (() => {
                      const rows = sections.receipts.data?.lines ?? [];
                      const full = rows.filter(
                        (r) => r.receivingStatus === 'FULLY_RECEIVED'
                      ).length;
                      const worst =
                        rows.length === 0
                          ? null
                          : rows.some((r) => r.receivingStatus === 'PARTIALLY_RECEIVED')
                            ? 'PARTIALLY_RECEIVED'
                            : rows.some((r) => r.receivingStatus === 'NOT_RECEIVED')
                              ? 'NOT_RECEIVED'
                              : 'FULLY_RECEIVED';
                      return (
                        <>
                          {worst && <CommerceReceivingStatusBadge status={worst} />}
                          <span className="text-xs text-muted-foreground">
                            {toPersianDigits(full)} از {toPersianDigits(rows.length)} ردیف کامل
                          </span>
                        </>
                      );
                    })()
                  )}
                </div>
              </div>

              <div
                className="rounded-xl border border-border p-3"
                data-testid="commerce-lifecycle-returns"
              >
                <p className="text-xs text-muted-foreground">مرجوعی</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sections.returns.status === 'loading' && !sections.returns.data ? (
                    <span className="text-xs text-muted-foreground">در حال بارگذاری…</span>
                  ) : sections.returns.status === 'error' && !sections.returns.data ? (
                    <span className="text-xs text-muted-foreground">در دسترس نیست</span>
                  ) : (sections.returns.data?.returns ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">مرجوعی‌ای ثبت نشده است</span>
                  ) : (
                    (() => {
                      const returns = sections.returns.data?.returns ?? [];
                      return (
                        <>
                          <CommerceReturnStateBadge state={returns[returns.length - 1].state} />
                          <span className="text-xs text-muted-foreground">
                            {toPersianDigits(returns.length)} مرجوعی
                          </span>
                        </>
                      );
                    })()
                  )}
                </div>
              </div>
            </div>
            <div
              className="mt-3 rounded-xl border border-border p-3"
              data-testid="commerce-lifecycle-commercial"
            >
              <p className="text-xs text-muted-foreground">بازرگانی</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {sections.approvals.status === 'loading' && !sections.approvals.data ? (
                  <span className="text-xs text-muted-foreground">در حال بارگذاری…</span>
                ) : sections.approvals.status === 'error' && !sections.approvals.data ? (
                  <span className="text-xs text-muted-foreground">در دسترس نیست</span>
                ) : (sections.approvals.data?.approvals ?? []).length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    برای این سند تأیید بازرگانی ثبت نشده است
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {toPersianDigits(
                      (sections.approvals.data?.approvals ?? []).filter(
                        (approval) => approval.status === 'PENDING'
                      ).length
                    )}
                    {' در انتظار تصمیم · '}
                    {toPersianDigits((sections.approvals.data?.approvals ?? []).length)} تأیید
                  </span>
                )}
              </div>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              جزئیات گردش کار از طریق سرویس‌های فعلی در دسترس نیست و در این صفحه نمایش داده
              نمی‌شود.
            </p>
          </CommerceCard>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">جمع اقلام (بدون مالیات)</p>
              <p className="mt-1 text-sm text-foreground">
                {commerceMoneyLabel(purchase.subtotalAmount, purchase.currency)}
              </p>
            </div>
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">مالیات</p>
              <p className="mt-1 text-sm text-foreground">
                {commerceMoneyLabel(purchase.taxAmount, purchase.currency)}
              </p>
            </div>
            <div className="rounded-xl border border-border p-3">
              <p className="text-xs text-muted-foreground">جمع کل</p>
              <p className="mt-1 text-sm text-foreground">
                {commerceMoneyLabel(purchase.totalAmount, purchase.currency)}
              </p>
            </div>
          </div>
        </div>
      )}
      {activeTab === 'lines' && (
        <div role="tabpanel" id="commerce-tabpanel-lines" aria-labelledby="commerce-tab-lines">
          <CommerceCard title="ردیف‌های سند" testId="commerce-detail-lines">
            <CommercePurchaseLinesTable
              lines={purchase.lines}
              receiving={sections.receipts.data?.lines ?? null}
              receivingState={
                sections.receipts.status === 'ready'
                  ? 'ready'
                  : sections.receipts.status === 'error'
                    ? 'error'
                    : 'loading'
              }
              assignments={sections.assignments.data?.assignments ?? null}
            />
          </CommerceCard>
        </div>
      )}

      {activeTab === 'commercial' && (
        <div
          role="tabpanel"
          id="commerce-tabpanel-commercial"
          aria-labelledby="commerce-tab-commercial"
        >
          <CommerceCard title="بازرگانی" testId="commerce-detail-commercial">
            <CommerceCommercialSection
              assignmentsState={sections.assignments}
              approvalsState={sections.approvals}
              groupsState={sections.groups}
              purchaseLines={purchase.lines}
              documentNumber={purchase.documentNumber}
              currentUserId={user?.userId ?? user?.sub ?? null}
              canApprove={canApprove}
              canManage={canManage}
              initialDecisionId={decisionId}
              onRetry={() => {
                reloadSection('assignments');
                reloadSection('approvals');
              }}
              onMutated={() => reloadSection('assignments')}
              onDecisionRecorded={() => reloadSection('approvals')}
            />
          </CommerceCard>
        </div>
      )}

      {activeTab === 'payments' && (
        <div role="tabpanel" id="commerce-tabpanel-payments" aria-labelledby="commerce-tab-payments">
          <CommerceCard title="پرداخت‌ها" testId="commerce-detail-payments">
            <CommercePaymentsSection
              documentId={documentId}
              state={sections.payments}
              canManage={canManage}
              onRetry={() => reloadSection('payments')}
              onMutated={() => reloadSection('payments')}
            />
          </CommerceCard>
        </div>
      )}

      {activeTab === 'receipts' && (
        <div role="tabpanel" id="commerce-tabpanel-receipts" aria-labelledby="commerce-tab-receipts">
          <CommerceCard title="دریافت‌ها" testId="commerce-detail-receipts">
            <CommerceReceiptsSection
              documentId={documentId}
              state={sections.receipts}
              purchaseLines={purchase.lines}
              canManage={canManage}
              onRetry={() => reloadSection('receipts')}
              onMutated={() => reloadSection('receipts')}
            />
          </CommerceCard>
        </div>
      )}

      {activeTab === 'returns' && (
        <div role="tabpanel" id="commerce-tabpanel-returns" aria-labelledby="commerce-tab-returns">
          <CommerceCard title="مرجوعی‌ها" testId="commerce-detail-returns">
            <CommerceReturnsSection
              documentId={documentId}
              state={sections.returns}
              receiptsState={sections.receipts}
              paymentsState={sections.payments}
              purchaseLines={purchase.lines}
              canManage={canManage}
              onRetry={() => reloadSection('returns')}
              onMutated={() => reloadSection('returns')}
              onPaymentsMutated={() => reloadSection('payments')}
            />
          </CommerceCard>
        </div>
      )}
      {activeTab === 'events' && (
        <div role="tabpanel" id="commerce-tabpanel-events" aria-labelledby="commerce-tab-events">
          <CommerceCard title="رویدادهای ثبت‌شده" testId="commerce-detail-events">
            <p className="mb-4 text-xs text-muted-foreground">
              این فهرست فقط از اطلاعات خوانده‌شدهٔ همین صفحه ساخته شده است (تاریخ ساخت و
              به‌روزرسانی سند، پرداخت‌ها، دریافت‌ها و گذارهای مرجوعی)؛ تاریخچهٔ کامل ممیزی از
              طریق Commerce در دسترس نیست.
            </p>
            {(() => {
              const events: Array<{ id: string; label: string; instant: string }> = [
                { id: 'created', label: 'ساخت سند', instant: purchase.createdAt },
                { id: 'updated', label: 'آخرین به‌روزرسانی سند', instant: purchase.updatedAt },
              ];
              for (const row of sections.payments.data?.items ?? []) {
                events.push({
                  id: `payment-${row.id}`,
                  label: row.reversesPaymentId
                    ? 'ثبت رویداد جبرانی پرداخت'
                    : 'ثبت پرداخت',
                  instant: row.paymentDate ?? row.createdAt,
                });
              }
              for (const receipt of sections.receipts.data?.receipts ?? []) {
                events.push({
                  id: `receipt-${receipt.id}`,
                  label: receipt.lines.some((line) => line.reversesReceiptLineId)
                    ? 'ثبت رویداد جبرانی دریافت'
                    : 'ثبت دریافت',
                  instant: receipt.receivedAt,
                });
              }
              for (const ret of sections.returns.data?.returns ?? []) {
                for (const transition of ret.transitions) {
                  events.push({
                    id: `return-transition-${transition.id}`,
                    label: `مرجوعی: ${transition.state}`,
                    instant: transition.createdAt,
                  });
                }
              }
              const ordered = [...events].sort(
                (left, right) => new Date(right.instant).getTime() - new Date(left.instant).getTime()
              );
              return (
                <ul data-testid="commerce-events-list" className="divide-y divide-border">
                  {ordered.map((event) => (
                    <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="text-sm text-foreground">{event.label}</span>
                      <span className="text-xs text-muted-foreground" title={event.instant}>
                        {commerceInstantLabel(event.instant)}
                      </span>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </CommerceCard>
        </div>
      )}

      <CommerceConfirmDialog
        open={confirmSubmit}
        testId="commerce-detail-confirm-submit"
        title="ارسال درخواست خرید"
        description="سند از پیش‌نویس خارج و برای بررسی بعدی ثبت می‌شود."
        consequences="پس از ارسال، سند دیگر قابل ویرایش نیست و امکان بازگشت به پیش‌نویس وجود ندارد."
        confirmLabel="ارسال درخواست"
        pending={submitPending}
        onConfirm={() => void handleSubmit()}
        onCancel={() => setConfirmSubmit(false)}
      />
    </div>
  );
}
