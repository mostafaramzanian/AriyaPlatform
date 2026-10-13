'use client';

import * as React from 'react';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { useReloadToken } from '@/hooks/use-reload-token';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  allocateFinancialCheckRequest,
  completeFinancialCheckDelivery,
  decideFinancialCheckRequest,
  decideFinancialExecutiveApproval,
  deleteFinancialCheckChequeImage,
  deleteFinancialCheckDeliveryReceipt,
  fetchFinancialCheckAvailableActions,
  fetchFinancialCheckProcess,
  fetchFinancialCheckRequest,
  issueFinancialCheck,
  reviewFinancialCheckDocuments,
  submitFinancialCheckRequest,
  uploadFinancialCheckChequeImage,
  uploadFinancialCheckDeliveryReceipt,
  type FinancialCheckAvailableAction,
  type FinancialCheckProcessDefinition,
  type FinancialCheckRequest,
} from '@/lib/financial-api';
import {
  FINANCIAL_ISSUE_TYPE_LABELS,
  FINANCIAL_PURCHASE_TYPE_LABELS,
  financialDateLabel,
  financialDocumentReviewLabel,
  financialExecutiveDecisionLabel,
  financialErrorMessage,
  financialManagerDecisionLabel,
  financialRequesterOpinionLabel,
} from '@/lib/financial-labels';
import { CheckRequestAttachments } from './CheckRequestAttachments';
import { CheckRequestTimeline } from './CheckRequestTimeline';
import {
  FinancialCard,
  FinancialCheckRequestStatusBadge,
  FinancialPageHeading,
} from './financial-ui';

/**
 * Phase CHECK-ISSUATION — the CONFIGURATION-DRIVEN Check Issuance wizard (brief §13–§15).
 *
 * The stepper, titles, fields, document sections and action labels all come from
 * `GET /financial/check-process` (the published, frozen definition); the BUTTONS come from
 * `GET …/:id/available-actions`, further filtered by the viewer's RBAC permission. There is
 * no `if (status === N)` anywhere: the only state lookup is INSIDE configuration
 * (`steps.find(s => s.states.includes(status))`), and panels switch on the resolved step
 * KEY — a configuration value — never on an ordinal.
 *
 * NOT ONE FIELD IS INVENTED: the allocation form is the source's six controls, issue and
 * delivery are the source's two checkboxes, and there is no cheque number / bank / IBAN /
 * Sayad / deliveredTo anywhere (brief §41). Self-approval stays VISIBLE and reads the
 * server's typed refusal — the authority rule lives in the service.
 */
export function CheckRequestWizard({ requestId }: { requestId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const has = (permission: string) => !enforcePermissions || rbac.permissions.includes(permission);
  const canRead = has('financial.check.read');

  const [request, setRequest] = React.useState<FinancialCheckRequest | null>(null);
  const [definition, setDefinition] = React.useState<FinancialCheckProcessDefinition | null>(null);
  const [available, setAvailable] = React.useState<FinancialCheckAvailableAction[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Loading/error arming lives in the action/retry handlers below (same commit
  // as the token bump) and in the requestId-change reset — never in the effect
  // body (`react-hooks/set-state-in-effect`): the effect only settles. First
  // mount is covered by the initial `loading: true`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRequestId, setPrevRequestId] = React.useState(requestId);
  if (prevRequestId !== requestId) {
    setPrevRequestId(requestId);
    setLoading(true);
    setError(null);
  }

  // Which step the reader is LOOKING AT: null = the current one. Completed steps open
  // read-only; a live form exists only on the current step.
  const [viewingKey, setViewingKey] = React.useState<string | null>(null);

  const [comment, setComment] = React.useState(''); // manager-review comment
  const [reviewComment, setReviewComment] = React.useState('');
  const [executiveComment, setExecutiveComment] = React.useState('');
  const [issueConfirmed, setIssueConfirmed] = React.useState(false);
  const [deliveryCompleted, setDeliveryCompleted] = React.useState(false);
  const [allocation, setAllocation] = React.useState({
    allocationPlace: '',
    balance: '',
    checkDate: '',
    checkDescription: '',
    checkAmount: '',
    payableTo: '',
  });

  const reportFailure = (err: unknown) => {
    const body = (err as { details?: { code?: string } }).details;
    setError(
      financialErrorMessage(
        body?.code,
        err instanceof Error ? err.message : 'عملیات با خطا مواجه شد.'
      )
    );
  };

  /** A typed refusal built CLIENT-side, shaped exactly like the server's (`details.code`). */
  const typedFailure = (code: string) => Object.assign(new Error(code), { details: { code } });

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;
    let active = true;

    Promise.all([
      fetchFinancialCheckProcess(),
      fetchFinancialCheckRequest(requestId),
      fetchFinancialCheckAvailableActions(requestId),
    ])
      .then(([nextDefinition, row, actions]) => {
        if (!active) return;
        setDefinition(nextDefinition);
        setRequest(row);
        setAvailable(actions.actions);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        reportFailure(err);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [requestId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  /**
   * Runs ONE wire action. The `switch` is on the action KEY the configuration declares —
   * never on a status ordinal — and every arm posts to its OWN route.
   */
  async function execute(actionKey: string): Promise<void> {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      let updated: FinancialCheckRequest;
      switch (actionKey) {
        case 'submit':
          updated = await submitFinancialCheckRequest(request.id);
          break;
        case 'approve':
          updated = await decideFinancialCheckRequest(
            request.id,
            'approve',
            comment.trim() ? { comment: comment.trim() } : {}
          );
          break;
        case 'reject':
          updated = await decideFinancialCheckRequest(
            request.id,
            'reject',
            comment.trim() ? { comment: comment.trim() } : {}
          );
          break;
        case 'request-correction':
          updated = await decideFinancialCheckRequest(
            request.id,
            'request-correction',
            comment.trim() ? { comment: comment.trim() } : {}
          );
          break;
        case 'allocate': {
          // V9 / V10 client pre-checks with the SOURCE'S OWN sentences; V11 (balance) is
          // the server's alone — only the server holds the ledger.
          if (!allocation.allocationPlace.trim()) {
            throw typedFailure('CHECK_REQUEST_ALLOCATION_PLACE_REQUIRED');
          }
          if (!allocation.checkAmount.trim()) {
            throw typedFailure('CHECK_REQUEST_ALLOCATION_AMOUNT_REQUIRED');
          }
          updated = await allocateFinancialCheckRequest(request.id, {
            allocationPlace: allocation.allocationPlace.trim(),
            checkAmount: allocation.checkAmount.trim(),
            ...(allocation.balance.trim() ? { balance: allocation.balance.trim() } : {}),
            ...(allocation.checkDate.trim() ? { checkDate: allocation.checkDate.trim() } : {}),
            ...(allocation.checkDescription.trim()
              ? { checkDescription: allocation.checkDescription.trim() }
              : {}),
            ...(allocation.payableTo.trim() ? { payableTo: allocation.payableTo.trim() } : {}),
          });
          break;
        }
        case 'document-review':
          updated = await reviewFinancialCheckDocuments(request.id, {
            decision: 'APPROVE',
            ...(reviewComment.trim() ? { comment: reviewComment.trim() } : {}),
          });
          break;
        case 'document-review-correction':
          updated = await reviewFinancialCheckDocuments(request.id, {
            decision: 'CORRECTION',
            ...(reviewComment.trim() ? { comment: reviewComment.trim() } : {}),
          });
          break;
        case 'executive-approve':
          updated = await decideFinancialExecutiveApproval(request.id, {
            decision: 'APPROVE',
            ...(executiveComment.trim() ? { comment: executiveComment.trim() } : {}),
          });
          break;
        case 'executive-reject':
          updated = await decideFinancialExecutiveApproval(request.id, {
            decision: 'REJECT',
            ...(executiveComment.trim() ? { comment: executiveComment.trim() } : {}),
          });
          break;
        case 'issue':
          if (!issueConfirmed) {
            throw typedFailure('CHECK_REQUEST_ISSUE_CONFIRMATION_REQUIRED');
          }
          updated = await issueFinancialCheck(request.id, { confirmed: true });
          break;
        case 'deliver':
          if (!deliveryCompleted) {
            throw typedFailure('CHECK_REQUEST_DELIVERY_CONFIRMATION_REQUIRED');
          }
          updated = await completeFinancialCheckDelivery(request.id, { completed: true });
          break;
        default:
          return;
      }
      setRequest(updated);
      setViewingKey(null);
      setComment('');
      setReviewComment('');
      setExecutiveComment('');
      setIssueConfirmed(false);
      setDeliveryCompleted(false);
      setAllocation({
        allocationPlace: '',
        balance: '',
        checkDate: '',
        checkDescription: '',
        checkAmount: '',
        payableTo: '',
      });
      // Refresh the process pin + available actions — re-armed through the
      // hook so the post-action refetch shows the same loading state the
      // removed in-effect `setLoading(true)` used to establish.
      reload();
    } catch (err) {
      reportFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (!isAuthenticated || rbac.isLoading) return <CoreLoading lines={4} />;
  if (!canRead) return <CoreForbidden />;
  if (loading) return <CoreLoading lines={6} />;
  if (!request || !definition) {
    return (
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <div data-testid="financial-check-detail-error">
          <CoreError
            message={error ?? 'درخواست مورد نظر یافت نشد.'}
            onRetry={reload}
          />
        </div>
      </div>
    );
  }

  // ---- CONFIGURATION RESOLUTION (the ONLY place a status ordinal appears) --------------
  const currentStep =
    definition.steps.find((step) => step.states.includes(request.status)) ?? null;
  const activeStepKey = viewingKey ?? currentStep?.key ?? null;
  const isCurrentView = activeStepKey === currentStep?.key;
  /** An action as the viewer may execute it: offered by the wire AND permitted by RBAC. */
  const usableAction = (key: string) =>
    available.find((candidate) => candidate.action === key && has(candidate.permission));
  const sectionConfig = (section: number) =>
    definition.documentSections.find((candidate) => candidate.section === section) ?? null;
  const sectionOpen = (section: number) =>
    sectionConfig(section)?.states.includes(request.status) ?? false;
  // The edit link opens the REQUEST edit form — it exists exactly while the REQUEST
  // document section (2) is open for this state and the viewer may manage it. The
  // section's own `states` window IS the editability window (states 0/1 in v1), so a
  // decision stage with its own editable comment (manager-review) never shows the form
  // link — configuration decides, never an ordinal literal.
  const editable =
    sectionOpen(2) && has(sectionConfig(2)?.permission ?? 'financial.check.manage');

  /** One action button, rendered ONLY when the wire offered it to this viewer. */
  const stageButton = (
    key: string,
    testId: string,
    className: string,
    fallbackLabel: string
  ) => {
    const action = usableAction(key);
    if (!action) return null;
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={busy || !action.enabled}
        title={action.reason ?? undefined}
        onClick={() => void execute(key)}
        className={className}
      >
        {action.label || fallbackLabel}
      </button>
    );
  };

  const steps = definition.steps.filter((step) => step.visible);
  const allocationStage = request.stages?.allocation ?? null;
  const reviewStage = request.stages?.documentReview ?? null;
  const executiveStage = request.stages?.executiveApproval ?? null;
  const issueStage = request.stages?.issue ?? null;
  const deliveryStage = request.stages?.delivery ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <FinancialPageHeading
        testId="financial-check-detail-heading"
        title={request.title}
        description={`شناسه درخواست: ${request.id}`}
        actions={
          <span className="flex items-center gap-2">
            <FinancialCheckRequestStatusBadge status={request.status} />
            {editable && (
              <Link
                href={`/admin/financial/check-requests/${request.id}/edit`}
                data-testid="financial-check-edit-link"
                className="inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium transition hover:bg-secondary"
              >
                ویرایش
              </Link>
            )}
          </span>
        }
      />

      {/* THE STEPPER — every label, order and visibility from the published definition. */}
      <nav
        data-testid="financial-check-stepper"
        aria-label="مراحل گردش کار صدور چک"
        className="flex flex-wrap items-center gap-2"
      >
        {steps.map((step) => {
          const done = currentStep !== null && step.order < currentStep.order;
          const isCurrent = currentStep !== null && step.key === currentStep.key;
          const active = activeStepKey === step.key;
          const reachable = done || isCurrent;
          return (
            <button
              key={step.key}
              type="button"
              data-testid={`financial-check-step-${step.key}`}
              aria-current={active ? 'step' : undefined}
              disabled={!reachable}
              onClick={() => {
                if (!reachable) return;
                setViewingKey(isCurrent ? null : step.key);
              }}
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition ${
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : done
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-border bg-muted text-muted-foreground'
              } ${reachable ? 'hover:bg-secondary' : 'cursor-default opacity-60'}`}
            >
              <span>{toPersianDigits(step.order)}</span>
              <span>{step.progressLabel}</span>
              {done && <span aria-hidden>✓</span>}
            </button>
          );
        })}
        {viewingKey && (
          <button
            type="button"
            data-testid="financial-check-step-back"
            onClick={() => setViewingKey(null)}
            className="rounded-xl border border-border px-3 py-2 text-xs font-medium transition hover:bg-secondary"
          >
            بازگشت به مرحله فعلی
          </button>
        )}
      </nav>

      {error && (
        <div data-testid="financial-check-detail-error">
          <CoreError message={error} onRetry={reload} />
        </div>
      )}

      <FinancialCard testId="financial-check-detail-facts">
        <dl className="grid gap-3 text-sm md:grid-cols-2">
          <Fact
            label="نوع صدور چک"
            value={FINANCIAL_ISSUE_TYPE_LABELS[request.checkIssueType]}
            testId="financial-check-detail-issue-type"
          />
          <Fact
            label="نوع خرید"
            value={
              request.purchaseType ? FINANCIAL_PURCHASE_TYPE_LABELS[request.purchaseType] : '—'
            }
            testId="financial-check-detail-purchase-type"
          />
          <Fact
            label="شناسه سفارش"
            value={request.orderReference ?? '—'}
            testId="financial-check-detail-order-reference"
          />
          <Fact
            label="پروژه"
            value={request.projectReference ?? '—'}
            testId="financial-check-detail-project-reference"
          />
          <Fact
            label="مدیر پروژه"
            value={request.projectManagerUserId ?? '—'}
            testId="financial-check-detail-project-manager"
          />
          <Fact
            label="درخواست‌کننده"
            value={request.requesterUserId}
            testId="financial-check-detail-requester"
          />
          <Fact
            label="تاریخ درخواست"
            value={financialDateLabel(request.requestDate)}
            testId="financial-check-detail-request-date"
          />
          <Fact
            label="نظر درخواست‌کننده"
            value={financialRequesterOpinionLabel(request.requesterOpinion) ?? '—'}
            testId="financial-check-detail-requester-opinion"
          />
          <Fact
            label="تصمیم مدیر"
            value={financialManagerDecisionLabel(request.managerDecision) ?? '—'}
            testId="financial-check-detail-manager-decision"
          />
          <Fact
            label="نظر مدیر"
            value={request.managerComment ?? '—'}
            testId="financial-check-detail-manager-comment"
          />
          {request.process && (
            <Fact
              label="گردش کار"
              value={`${request.process.processKey} نسخه ${toPersianDigits(
                request.process.processVersion
              )}`}
              testId="financial-check-detail-process"
            />
          )}
        </dl>
      </FinancialCard>

      {/* A COMPLETED step opens READ-ONLY — its recorded stage data, never a live form. */}
      {!isCurrentView && (
        <FinancialCard testId="financial-check-step-summary">
          <FinancialPageHeading
            title={`مرحله ${
              steps.find((step) => step.key === activeStepKey)?.title ?? ''
            } — فقط‌خواندنی`}
            description="این مرحله قبلاً ثبت شده است؛ برای بازگشت به مرحله فعلی از نوار مراحل بالا اقدام کنید."
          />
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            {activeStepKey === 'allocation' && (
              <>
                <Fact label="محل تخصیص" value={allocationStage?.allocationPlace ?? '—'} />
                <Fact
                  label="مانده"
                  value={allocationStage?.balance ? toPersianDigits(allocationStage.balance) : '—'}
                />
                <Fact
                  label="تاریخ چک"
                  value={financialDateLabel(allocationStage?.checkDate ?? null)}
                />
                <Fact label="شرح" value={allocationStage?.checkDescription ?? '—'} />
                <Fact
                  label="مبلغ"
                  value={
                    allocationStage ? `${toPersianDigits(allocationStage.checkAmount)} ریال` : '—'
                  }
                />
                <Fact label="در وجه" value={allocationStage?.payableTo ?? '—'} />
              </>
            )}
            {activeStepKey === 'document-review' && (
              <>
                <Fact
                  label="تصمیم بررسی اسناد"
                  value={financialDocumentReviewLabel(reviewStage?.decision ?? null) ?? '—'}
                />
                <Fact label="نظر بررسی" value={reviewStage?.comment ?? '—'} />
              </>
            )}
            {activeStepKey === 'executive-approval' && (
              <>
                <Fact
                  label="تصمیم ریاست"
                  value={financialExecutiveDecisionLabel(executiveStage?.decision ?? null) ?? '—'}
                />
                <Fact label="نظر" value={executiveStage?.comment ?? '—'} />
              </>
            )}
            {activeStepKey === 'issue' && (
              <Fact
                label="تأیید چک صادر شده"
                value={issueStage ? (issueStage.issuedCheckConfirmed ? 'بله' : 'خیر') : '—'}
              />
            )}
            {activeStepKey === 'delivery' && (
              <Fact
                label="خاتمه صدور چک"
                value={deliveryStage ? (deliveryStage.deliveryCompleted ? 'بله' : 'خیر') : '—'}
              />
            )}
            {(activeStepKey === 'request' ||
              activeStepKey === 'manager-review' ||
              activeStepKey === 'completed' ||
              activeStepKey === 'terminated') && (
              <Fact
                label="وضعیت"
                value={steps.find((step) => step.key === activeStepKey)?.title ?? '—'}
              />
            )}
          </dl>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'request' && (
        <FinancialCard testId="financial-check-request-step">
          <FinancialPageHeading
            title={currentStep.title}
            description="درخواست ثبت شده است؛ برای ادامه آن را برای تصمیم مدیر ارجاع دهید."
          />
          <div className="flex flex-wrap gap-2">
            {stageButton(
              'submit',
              'financial-check-submit',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'ارجاع برای تصمیم مدیر'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'manager-review' && (
        <FinancialCard testId="financial-check-manager-panel">
          <FinancialPageHeading
            title="تصمیم مدیر"
            description="آیا چک صادر شود؟ (بله / خیر / نیازمند اصلاح است)"
          />
          {usableAction('approve') ||
          usableAction('reject') ||
          usableAction('request-correction') ? (
            <div className="space-y-4">
              <label className="flex flex-col gap-1 text-sm">
                <span>نظر مدیر (اختیاری)</span>
                <textarea
                  data-testid="financial-check-manager-comment-input"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={3}
                  className="rounded-xl border border-border bg-background p-3 text-sm"
                  placeholder="نظر یا دلیل تصمیم (اختیاری)"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {stageButton(
                  'approve',
                  'financial-check-approve',
                  'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
                  'بله'
                )}
                {stageButton(
                  'reject',
                  'financial-check-reject',
                  'inline-flex h-10 items-center rounded-xl border border-destructive/40 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50',
                  'خیر'
                )}
                {stageButton(
                  'request-correction',
                  'financial-check-request-correction',
                  'inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium transition hover:bg-secondary disabled:opacity-50',
                  'نیازمند اصلاح است'
                )}
              </div>
            </div>
          ) : (
            <p
              data-testid="financial-check-manager-waiting"
              className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground"
            >
              در انتظار تصمیم مدیر…
            </p>
          )}
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'allocation' && (
        <FinancialCard testId="financial-check-allocation">
          <FinancialPageHeading
            title={currentStep.title}
            description="فرم تخصیص را مطابق منبع تکمیل کنید؛ مبلغ به ریال و با ارقام انگلیسی."
          />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>
                محل تخصیص <span className="text-destructive">*</span>
              </span>
              <input
                data-testid="financial-check-allocation-place"
                value={allocation.allocationPlace}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, allocationPlace: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>مانده</span>
              <input
                data-testid="financial-check-allocation-balance"
                inputMode="numeric"
                value={allocation.balance}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, balance: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>تاریخ چک</span>
              <input
                data-testid="financial-check-allocation-date"
                type="date"
                value={allocation.checkDate}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, checkDate: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>شرح</span>
              <input
                data-testid="financial-check-allocation-description"
                value={allocation.checkDescription}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, checkDescription: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>
                مبلغ چک <span className="text-destructive">*</span>
              </span>
              <input
                data-testid="financial-check-allocation-amount"
                inputMode="numeric"
                value={allocation.checkAmount}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, checkAmount: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>در وجه</span>
              <input
                data-testid="financial-check-allocation-payable-to"
                value={allocation.payableTo}
                onChange={(event) =>
                  setAllocation((prev) => ({ ...prev, payableTo: event.target.value }))
                }
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {stageButton(
              'allocate',
              'financial-check-allocation-submit',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'ثبت فرم تخصیص'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'document-review' && (
        <FinancialCard testId="financial-check-document-review">
          <FinancialPageHeading
            title={currentStep.title}
            description="اسناد مرحله قبل را بررسی کنید: تایید یا اصلاح (بدون رد)."          />
          <label className="flex flex-col gap-1 text-sm">
            <span>نظر بررسی (اختیاری)</span>
            <textarea
              data-testid="financial-check-review-comment"
              value={reviewComment}
              onChange={(event) => setReviewComment(event.target.value)}
              rows={3}
              className="rounded-xl border border-border bg-background p-3 text-sm"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            {stageButton(
              'document-review',
              'financial-check-review-approve',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'تایید'
            )}
            {stageButton(
              'document-review-correction',
              'financial-check-review-correction',
              'inline-flex h-10 items-center rounded-xl border border-border px-4 text-sm font-medium transition hover:bg-secondary disabled:opacity-50',
              'اصلاح'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'executive-approval' && (
        <FinancialCard testId="financial-check-executive">
          <FinancialPageHeading
            title={currentStep.title}
            description="تصمیم ریاست: تایید یا رد. («نیازمند اصلاح» مغایر منبع است و در این نسخه ارائه نمی‌شود.)"
          />
          <label className="flex flex-col gap-1 text-sm">
            <span>نظر (اختیاری)</span>
            <textarea
              data-testid="financial-check-executive-comment"
              value={executiveComment}
              onChange={(event) => setExecutiveComment(event.target.value)}
              rows={3}
              className="rounded-xl border border-border bg-background p-3 text-sm"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            {stageButton(
              'executive-approve',
              'financial-check-executive-approve',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'تایید'
            )}
            {stageButton(
              'executive-reject',
              'financial-check-executive-reject',
              'inline-flex h-10 items-center rounded-xl border border-destructive/40 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50',
              'رد'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'issue' && (
        <FinancialCard testId="financial-check-issuance">
          <FinancialPageHeading
            title={currentStep.title}
            description="تصویر چک صادرشده را بارگذاری و صدور را تایید کنید."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="financial-check-issue-confirm"
              checked={issueConfirmed}
              onChange={(event) => setIssueConfirmed(event.target.checked)}
              className="h-4 w-4"
            />
            تایید چک صادر شده
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            {stageButton(
              'issue',
              'financial-check-issuance-submit',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'ثبت صدور چک'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'delivery' && (
        <FinancialCard testId="financial-check-delivery">
          <FinancialPageHeading
            title={currentStep.title}
            description="تصویر رسید تحویل را بارگذاری و خاتمه صدور چک را تایید کنید."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="financial-check-delivery-confirm"
              checked={deliveryCompleted}
              onChange={(event) => setDeliveryCompleted(event.target.checked)}
              className="h-4 w-4"
            />
            خاتمه صدور چک
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            {stageButton(
              'deliver',
              'financial-check-delivery-submit',
              'inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50',
              'ثبت تحویل'
            )}
          </div>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'completed' && (
        <FinancialCard testId="financial-check-completed-message">
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            تحویل چک ثبت شد؛ گردش کار صدور چک با موفقیت پایان یافت.
          </p>
        </FinancialCard>
      )}

      {isCurrentView && currentStep?.key === 'terminated' && (
        <FinancialCard testId="financial-check-terminated-message">
          <p className="text-sm text-muted-foreground">
            درخواست خاتمه یافته است.
            {request.managerDecision && (
              <>
                {' '}
                تصمیم مدیر: {financialManagerDecisionLabel(request.managerDecision)}
                {request.managerComment ? ` — ${request.managerComment}` : ''}
              </>
            )}
          </p>
        </FinancialCard>
      )}

      {/* DOCUMENT SECTIONS — which sections are open, and their titles, come from the
          definition; stage sections (6/7) take their own typed uploader/remover. */}
      {sectionOpen(2) && (
        <CheckRequestAttachments
          requestId={request.id}
          editable={has(sectionConfig(2)?.permission ?? 'financial.check.manage')}
          title={sectionConfig(2)?.title ?? 'اسناد پیوست'}
        />
      )}
      {sectionOpen(6) && (
        <CheckRequestAttachments
          requestId={request.id}
          section={6}
          editable={has(sectionConfig(6)?.permission ?? 'financial.check.issue')}
          title={sectionConfig(6)?.title ?? 'تصویر چک'}
          uploader={uploadFinancialCheckChequeImage}
          remover={deleteFinancialCheckChequeImage}
        />
      )}
      {sectionOpen(7) && (
        <CheckRequestAttachments
          requestId={request.id}
          section={7}
          editable={has(sectionConfig(7)?.permission ?? 'financial.check.deliver')}
          title={sectionConfig(7)?.title ?? 'رسید تحویل'}
          uploader={uploadFinancialCheckDeliveryReceipt}
          remover={deleteFinancialCheckDeliveryReceipt}
        />
      )}

      <CheckRequestTimeline requestId={request.id} />
    </div>
  );
}

/** A label/value row inside a `dl` — F1's Fact, unchanged in shape. */
function Fact({
  label,
  value,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2"
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
