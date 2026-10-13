'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import {
  archiveCommerceWorkflowVersion,
  COMMERCE_WORKFLOW_PARALLEL_JOIN_POLICIES,
  COMMERCE_WORKFLOW_TRIGGER_EVENTS,
  deleteCommerceWorkflowStep,
  fetchCommerceWorkflowVersion,
  publishCommerceWorkflowVersion,
  readCommerceWorkflowValidationReport,
  reorderCommerceWorkflowSteps,
  updateCommerceWorkflowVersion,
  validateCommerceWorkflowVersion,
  type CommerceWorkflowStep,
  type CommerceWorkflowValidationIssue,
  type CommerceWorkflowVersion,
  type CommerceWorkflowVersionPatch,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceInstantLabel,
  commerceWorkflowParallelJoinPolicyLabel,
  commerceWorkflowActorSourceLabel,
  commerceWorkflowRefusalLabel,
  commerceWorkflowStepExecutionModeLabel,
  commerceWorkflowTriggerEventLabel,
  commerceWorkflowVersionStatusLabel,
  commerceWorkflowVersionStatusHint,
  commerceWorkflowVersionStatusTone,
} from '@/lib/commerce-labels';
import { toPersianDigits } from '@/lib/calendar-api';
import { CommerceBadge, CommerceFeedback, CommerceSectionHeading } from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useCommerceDirtyFlag, useCommerceSettingsGuard } from './CommerceSettingsGuard';
import { CommerceWorkflowStepEditor } from './CommerceWorkflowStepEditor';
import { useCommerceMemberNames } from './CommerceMemberPicker';

/**
 * PHASE UI-4: the VERSION EDITOR — «نسخه → مرحله → جزئیات» made concrete.
 *
 * WHAT THE ADMINISTRATOR SEES, IN ORDER: the version's identity and state (label,
 * status word, hint), then — while it is a DRAFT — the routing form (which event starts
 * this version, how parallel branches join, its selection rating) and the ordered list
 * of STEPS with explicit move up/down controls; then the lifecycle actions. The
 * technical ids live in a secondary strip, not in the headline.
 *
 * THE THREE LIFECYCLE RULES THIS UI ENFORCES VISUALLY (all backend facts):
 *  1. Only a DRAFT is editable — the form and every step action disappear on
 *     VALIDATED/PUBLISHED/ARCHIVED and the hint sentence says why.
 *  2. Publication walks DRAFT → VALIDATED → PUBLISHED: a DRAFT offers «اعتبارسنجی» and
 *     only a VALIDATED version offers «انتشار».
 *  3. A refusal from validate/publish carries a structured report; every finding is
 *     rendered as «چه چیزی باید اصلاح شود» + «کدام مرحله» + the technical location as
 *     secondary text. Never a bare «خطا».
 *
 * NO WORKFLOW EXECUTION. This screen configures definitions; it cannot start, decide or
 * timeline a workflow instance — those routes do not exist yet (UI-0 GAP-1) and no
 * control here pretends they do.
 */
export function CommerceWorkflowEditor({
  versionId,
  canWorkflowManage,
  canReadDirectory,
  onBack,
  onChanged,
  onRequestNewVersion,
}: {
  versionId: string;
  canWorkflowManage: boolean;
  canReadDirectory: boolean;
  onBack: () => void;
  /** Called after any successful mutation so the parent list re-reads its rows. */
  onChanged: () => void;
  /** «ایجاد نسخهٔ جدید» — closes this editor into the parent's create-version dialog. */
  onRequestNewVersion: () => void;
}) {
  const { requestGuard } = useCommerceSettingsGuard();

  const [version, setVersion] = React.useState<CommerceWorkflowVersion | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  // Record-change reset happens here, synchronously during render (guarded by
  // the previous id) — never in the fetch effect body
  // (`react-hooks/set-state-in-effect`): dropping the stale version and clearing
  // the previous error before the new read settles. The fetch effect below only
  // settles. (The routing-form re-seed stays keyed on
  // `formInitializedFor.current !== next.id` inside the settle callback.)
  const [prevVersionId, setPrevVersionId] = React.useState(versionId);
  if (prevVersionId !== versionId) {
    setPrevVersionId(versionId);
    setVersion(null);
    setLoadError(null);
  }
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<CommerceWorkflowValidationIssue[]>([]);
  const [issuesTruncated, setIssuesTruncated] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<
    'save' | 'validate' | 'publish' | 'archive' | 'reorder' | null
  >(null);

  // The routing form (DRAFT only). The form is NOT the row: it is stated separately and
  // saved explicitly, so a half-typed value never reaches the wire by accident.
  const [triggerEvent, setTriggerEvent] = React.useState('');
  const [parallelJoinPolicy, setParallelJoinPolicy] = React.useState('');
  const [selectionPriority, setSelectionPriority] = React.useState('');
  const formInitializedFor = React.useRef<string | null>(null);

  const [publishOpen, setPublishOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<CommerceWorkflowStep | null>(null);
  const [deletePending, setDeletePending] = React.useState(false);
  const [stepDrawer, setStepDrawer] = React.useState<
    { step: CommerceWorkflowStep | null; key: number } | null
  >(null);

  const applyFormFrom = React.useCallback((next: CommerceWorkflowVersion) => {
    setTriggerEvent(next.triggerEvent ?? '');
    setParallelJoinPolicy(next.parallelJoinPolicy ?? '');
    setSelectionPriority(next.selectionPriority === null ? '' : String(next.selectionPriority));
    formInitializedFor.current = next.id;
  }, []);

  const takeIssues = React.useCallback((err: unknown) => {
    const report = readCommerceWorkflowValidationReport(err);
    setIssues(report?.issues ?? []);
    setIssuesTruncated(report?.truncated ?? false);
  }, []);

  React.useEffect(() => {
    let active = true;

    fetchCommerceWorkflowVersion(versionId)
      .then((next) => {
        if (!active) return;
        setVersion(next);
        // The form is re-seeded only for a NEW version id (or a forced reload): an
        // unrelated refresh must never wipe what someone is typing.
        if (formInitializedFor.current !== next.id) applyFormFrom(next);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : 'دریافت نسخه با خطا مواجه شد.');
      });

    return () => {
      active = false;
    };
  }, [versionId, reloadToken, applyFormFrom]);

  const isDraft = version?.status === 'DRAFT';

  const routingDirty = Boolean(
    version &&
      isDraft &&
      ((version.triggerEvent ?? '') !== triggerEvent ||
        (version.parallelJoinPolicy ?? '') !== parallelJoinPolicy ||
        (version.selectionPriority === null ? '' : String(version.selectionPriority)) !==
          selectionPriority)
  );

  useCommerceDirtyFlag(`workflow-routing-${versionId}`, routingDirty);

  // The order a reader sees is the ORDERED steps the server returned (§5.6: order is
  // stated, never implied).
  const steps = React.useMemo(
    () =>
      [...(version?.steps ?? [])].sort((left, right) =>
        left.ordering === right.ordering ? 0 : left.ordering - right.ordering
      ),
    [version]
  );

  // The configured-user display names for the step rows (bounded by the step count).
  const actorNameIds = React.useMemo(
    () => steps.map((step) => (step.actorSource === 'CONFIGURED_USER' ? step.actorUserId : null)),
    [steps]
  );
  const actorNames = useCommerceMemberNames(actorNameIds, canReadDirectory);

  const saveRouting = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!version || !isDraft || pendingAction) return;

    const priorityText = selectionPriority.trim();
    if (priorityText !== '') {
      const priority = Number(priorityText);
      if (!Number.isSafeInteger(priority)) {
        setActionError('امتیاز انتخاب باید یک عدد صحیح باشد.');
        return;
      }
    }

    const patch: CommerceWorkflowVersionPatch = {};
    if ((version.triggerEvent ?? '') !== triggerEvent) {
      patch.triggerEvent = triggerEvent
        ? (triggerEvent as NonNullable<CommerceWorkflowVersionPatch['triggerEvent']>)
        : null;
    }
    if ((version.parallelJoinPolicy ?? '') !== parallelJoinPolicy) {
      patch.parallelJoinPolicy = parallelJoinPolicy
        ? (parallelJoinPolicy as NonNullable<CommerceWorkflowVersionPatch['parallelJoinPolicy']>)
        : null;
    }
    if (
      (version.selectionPriority === null ? '' : String(version.selectionPriority)) !== priorityText
    ) {
      patch.selectionPriority = priorityText === '' ? null : Number(priorityText);
    }

    setPendingAction('save');
    setActionError(null);
    setIssues([]);
    updateCommerceWorkflowVersion(versionId, patch)
      .then((next) => {
        setPendingAction(null);
        setVersion(next);
        applyFormFrom(next);
        setFeedback('تنظیمات نسخه ذخیره شد.');
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingAction(null);
        setActionError(commerceActionErrorMessage(err, 'ذخیرهٔ تنظیمات نسخه انجام نشد.'));
      });
  };

  const runValidate = () => {
    if (!version || pendingAction) return;
    setPendingAction('validate');
    setActionError(null);
    setIssues([]);
    validateCommerceWorkflowVersion(versionId)
      .then((next) => {
        setPendingAction(null);
        setVersion(next);
        applyFormFrom(next);
        setFeedback('نسخه اعتبارسنجی شد و اکنون آمادهٔ انتشار است.');
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingAction(null);
        takeIssues(err);
        setActionError(commerceActionErrorMessage(err, 'نسخه از اعتبارسنجی عبور نکرد.'));
      });
  };

  const runPublish = () => {
    if (!version || pendingAction) return;
    setPendingAction('publish');
    setActionError(null);
    setIssues([]);
    publishCommerceWorkflowVersion(versionId)
      .then((next) => {
        setPendingAction(null);
        setPublishOpen(false);
        setVersion(next);
        applyFormFrom(next);
        setFeedback('نسخه منتشر شد و از این پس نسخهٔ در جریان فرآیند است.');
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingAction(null);
        takeIssues(err);
        setActionError(commerceActionErrorMessage(err, 'انتشار نسخه انجام نشد.'));
      });
  };

  const runArchive = () => {
    if (!version || pendingAction) return;
    setPendingAction('archive');
    setActionError(null);
    archiveCommerceWorkflowVersion(versionId)
      .then((next) => {
        setPendingAction(null);
        setArchiveOpen(false);
        setVersion(next);
        applyFormFrom(next);
        setFeedback('نسخه آرشیو شد و از جریان فرآیند خارج گردید.');
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingAction(null);
        setActionError(commerceActionErrorMessage(err, 'آرشیو نسخه انجام نشد.'));
      });
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    if (!version || pendingAction) return;
    const order = steps.map((step) => step.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];

    setPendingAction('reorder');
    setActionError(null);
    reorderCommerceWorkflowSteps(versionId, order)
      .then((next) => {
        setPendingAction(null);
        setVersion(next);
        setFeedback('ترتیب مراحل به‌روزرسانی شد.');
        onChanged();
      })
      .catch((err: unknown) => {
        setPendingAction(null);
        setActionError(commerceActionErrorMessage(err, 'تغییر ترتیب مراحل انجام نشد.'));
      });
  };

  /**
   * The step editor answers with the ONE row it wrote; the drawer's host merges it into
   * the ordered list instead of re-reading the version — a refetch here would reseed the
   * routing form and could drop edits the administrator has not saved yet.
   */
  const mergeSavedStep = (saved: CommerceWorkflowStep) => {
    setVersion((current) => {
      if (!current) return current;
      const existing = current.steps.find((step) => step.id === saved.id);
      const stepsNext = existing
        ? current.steps.map((step) => (step.id === saved.id ? saved : step))
        : [...current.steps, saved];
      return { ...current, steps: stepsNext };
    });
    setStepDrawer(null);
    setFeedback('مرحله ذخیره شد.');
    onChanged();
  };

  const runDeleteStep = () => {
    if (!version || !deleteTarget || deletePending) return;
    setDeletePending(true);
    const stepId = deleteTarget.id;
    // The deletion route answers with `{deleted, stepId}` — the row is gone, so the
    // local list drops it without a refetch (same non-clobbering rule as mergeSavedStep).
    deleteCommerceWorkflowStep(versionId, stepId)
      .then(() => {
        setDeletePending(false);
        setDeleteTarget(null);
        setVersion((current) =>
          current
            ? { ...current, steps: current.steps.filter((step) => step.id !== stepId) }
            : current
        );
        setFeedback('مرحله حذف شد.');
        onChanged();
      })
      .catch((err: unknown) => {
        setDeletePending(false);
        setActionError(commerceActionErrorMessage(err, 'حذف مرحله انجام نشد.'));
      });
  };

  if (loadError) {
    return (
      <CoreError
        message={loadError}
        onRetry={() => {
          // Retry re-arms in the same commit as the token bump (the removed
          // in-effect `setLoadError(null)` used to arm one render later).
          setLoadError(null);
          setReloadToken((value) => value + 1);
        }}
        retryLabel="تلاش دوباره"
      />
    );
  }

  if (!version) {
    return <CoreLoading lines={6} />;
  }

  const busy = pendingAction !== null;

  return (
    <div className="space-y-core-gap" data-testid="commerce-workflow-editor">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => requestGuard(onBack)}
            data-testid="commerce-workflow-editor-back"
            className="rounded-lg text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
          >
            → بازگشت به فهرست نسخه‌ها
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">نسخهٔ «{version.versionLabel}»</h4>
            <CommerceBadge
              tone={commerceWorkflowVersionStatusTone(version.status)}
              testId={`commerce-workflow-editor-status-${version.status}`}
            >
              {commerceWorkflowVersionStatusLabel(version.status)}
            </CommerceBadge>
          </div>
          <p className="text-xs text-muted-foreground">
            {commerceWorkflowVersionStatusHint(version.status)}
          </p>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span title={version.updatedAt}>
              آخرین تغییر: {commerceInstantLabel(version.updatedAt)}
            </span>
            <span dir="ltr" className="rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
              {version.id}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isDraft && canWorkflowManage && (
            <>
              <Button
                type="button"
                onClick={() => saveRouting()}
                disabled={!routingDirty || busy}
                aria-busy={busy && pendingAction === 'save'}
                data-testid="commerce-workflow-save"
                className={
                  routingDirty ? 'text-xs' : 'border border-border bg-background text-xs text-foreground'
                }
              >
                ذخیرهٔ تنظیمات نسخه
              </Button>
              <Button
                type="button"
                onClick={runValidate}
                disabled={busy || routingDirty}
                aria-busy={busy && pendingAction === 'validate'}
                data-testid="commerce-workflow-validate"
                className="text-xs"
              >
                اعتبارسنجی و بررسی
              </Button>
            </>
          )}
          {version.status === 'VALIDATED' && canWorkflowManage && (
            <Button
              type="button"
              onClick={() => {
                setActionError(null);
                setPublishOpen(true);
              }}
              disabled={busy}
              data-testid="commerce-workflow-publish-open"
              className="text-xs"
            >
              بررسی و انتشار
            </Button>
          )}
          {version.status === 'PUBLISHED' && canWorkflowManage && (
            <Button
              type="button"
              onClick={() => {
                setActionError(null);
                setArchiveOpen(true);
              }}
              disabled={busy}
              data-testid="commerce-workflow-archive-open"
              className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
            >
              آرشیو کردن نسخه
            </Button>
          )}
          {!isDraft && canWorkflowManage && (
            <Button
              type="button"
              onClick={() => requestGuard(onRequestNewVersion)}
              data-testid="commerce-workflow-new-version"
              className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
            >
              ایجاد نسخهٔ جدید
            </Button>
          )}
        </div>
      </div>

      <CommerceFeedback message={feedback} testId="commerce-workflow-editor-feedback" />

      {actionError && (
        <p
          role="alert"
          data-testid="commerce-workflow-editor-error"
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </p>
      )}

      {routingDirty && isDraft && (
        <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
          تغییرات ذخیره‌نشده دارید؛ برای اعتبارسنجی یا انتشار، ابتدا «ذخیرهٔ تنظیمات نسخه» را
          بزنید.
        </p>
      )}

      {issues.length > 0 && (
        <section
          role="alert"
          data-testid="commerce-workflow-issues"
          className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4"
        >
          <h4 className="text-sm font-semibold text-destructive">مواردی که باید اصلاح شوند</h4>
          <ul className="mt-3 space-y-2">
            {issues.map((issue, index) => {
              const step = issue.stepKey
                ? steps.find((candidate) => candidate.stepKey === issue.stepKey)
                : undefined;
              return (
                <li key={`${issue.refusal}-${issue.stepKey ?? ''}-${index}`} className="text-xs">
                  <p className="text-foreground">
                    {commerceWorkflowRefusalLabel(issue.refusal)}
                    {step && (
                      <span className="text-muted-foreground"> — مرحلهٔ «{step.displayName}»</span>
                    )}
                  </p>
                  {(issue.path || issue.detail) && (
                    <p dir="ltr" className="mt-0.5 break-all text-[11px] text-muted-foreground">
                      {[issue.path, issue.detail].filter(Boolean).join(': ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {issuesTruncated && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              فهرست کامل نیست؛ پس از اصلاح این موارد، دوباره اعتبارسنجی کنید.
            </p>
          )}
        </section>
      )}

      {isDraft ? (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
          <CommerceSectionHeading
            title="تنظیمات نسخه"
            description="این تنظیمات مشخص می‌کنند این نسخه چه زمانی انتخاب شود و شاخه‌های موازی چگونه جمع‌بندی شوند."
          />
          <form
            id="commerce-workflow-routing-form"
            onSubmit={saveRouting}
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          >
            <div className="space-y-1">
              <label
                htmlFor="commerce-workflow-trigger"
                className="block text-sm font-medium text-foreground"
              >
                رویداد آغاز
              </label>
              <select
                id="commerce-workflow-trigger"
                name="triggerEvent"
                value={triggerEvent}
                onChange={(event) => setTriggerEvent(event.target.value)}
                data-testid="commerce-workflow-trigger"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                <option value="">تعیین نشده</option>
                {COMMERCE_WORKFLOW_TRIGGER_EVENTS.map((event) => (
                  <option key={event} value={event}>
                    {commerceWorkflowTriggerEventLabel(event)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                نسخه فقط زمانی نامزد انتخاب می‌شود که این رویداد رخ دهد؛ برای انتشار الزامی است.
              </p>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="commerce-workflow-join-policy"
                className="block text-sm font-medium text-foreground"
              >
                سیاست اتصال شاخه‌های موازی
              </label>
              <select
                id="commerce-workflow-join-policy"
                name="parallelJoinPolicy"
                value={parallelJoinPolicy}
                onChange={(event) => setParallelJoinPolicy(event.target.value)}
                data-testid="commerce-workflow-join-policy"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                <option value="">تعیین نشده</option>
                {COMMERCE_WORKFLOW_PARALLEL_JOIN_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {commerceWorkflowParallelJoinPolicyLabel(policy)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                فقط زمانی لازم است که فرآیند مرحلهٔ موازی داشته باشد.
              </p>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="commerce-workflow-selection-priority"
                className="block text-sm font-medium text-foreground"
              >
                امتیاز انتخاب نسخه (اختیاری)
              </label>
              <input
                id="commerce-workflow-selection-priority"
                name="selectionPriority"
                type="number"
                step={1}
                value={selectionPriority}
                onChange={(event) => setSelectionPriority(event.target.value)}
                data-testid="commerce-workflow-selection-priority"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
              <p className="text-xs text-muted-foreground">
                عدد صحیحی برای ترجیح این نسخه هنگام هم‌پوشانی با نسخه‌های هم‌شرط.
              </p>
            </div>
          </form>
        </section>
      ) : (
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
          <CommerceSectionHeading
            title="تنظیمات نسخه"
            description="این نسخه دیگر قابل ویرایش نیست؛ مقادیر ثبت‌شده فقط برای مطالعه نمایش داده می‌شوند."
          />
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">رویداد آغاز</dt>
              <dd className="text-foreground">
                {version.triggerEvent
                  ? commerceWorkflowTriggerEventLabel(version.triggerEvent)
                  : 'تعیین نشده'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">سیاست اتصال شاخه‌ها</dt>
              <dd className="text-foreground">
                {version.parallelJoinPolicy
                  ? commerceWorkflowParallelJoinPolicyLabel(version.parallelJoinPolicy)
                  : 'تعیین نشده'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">امتیاز انتخاب</dt>
              <dd className="text-foreground">
                {version.selectionPriority === null
                  ? 'تعیین نشده'
                  : toPersianDigits(String(version.selectionPriority))}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
        <CommerceSectionHeading
          title="مراحل فرآیند"
          description="ترتیب نمایش‌داده‌شده همان ترتیب اجرای درخواست است. در نسخهٔ پیش‌نویس می‌توانید مرحله اضافه، ویرایش و جابه‌جا کنید."
          actions={
            isDraft && canWorkflowManage ? (
              <Button
                type="button"
                onClick={() => setStepDrawer({ step: null, key: Date.now() })}
                data-testid="commerce-workflow-step-add"
                className="text-xs"
              >
                افزودن مرحله
              </Button>
            ) : undefined
          }
        />

        {steps.length === 0 ? (
          <div data-testid="commerce-workflow-steps-empty">
            <p className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-8 text-center text-sm text-muted-foreground">
              {isDraft ? 'این نسخه هنوز مرحله‌ای ندارد.' : 'این نسخه بدون مرحله منتشر شده است.'}
            </p>
            {isDraft && canWorkflowManage && (
              <div className="mt-4 flex justify-center">
                <Button
                  type="button"
                  onClick={() => setStepDrawer({ step: null, key: Date.now() })}
                  className="text-xs"
                >
                  افزودن مرحله
                </Button>
              </div>
            )}
          </div>
        ) : (

          <ol className="space-y-2" data-testid="commerce-workflow-steps">
            {steps.map((step, index) => {
              const actorName =
                step.actorSource === 'CONFIGURED_USER' && step.actorUserId
                  ? actorNames.get(step.actorUserId)
                  : undefined;
              const hasCondition = step.condition !== null && step.condition !== undefined;
              return (
                <li
                  key={step.id}
                  data-testid={`commerce-workflow-step-${step.stepKey}`}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-[11px] text-muted-foreground">
                        {toPersianDigits(index + 1)}
                      </span>
                      <span className="text-sm font-medium text-foreground">{step.displayName}</span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {commerceWorkflowStepExecutionModeLabel(step.executionMode)}
                      </span>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {step.mandatory ? 'اجباری' : 'اختیاری'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {step.actorSource && (
                        <span>
                          مسئول: {commerceWorkflowActorSourceLabel(step.actorSource)}
                          {actorName ? ` — ${actorName}` : ''}
                        </span>
                      )}
                      {hasCondition && <span>دارای شرط فعال‌سازی</span>}
                      {step.parallelGroup && (
                        <span>
                          شاخهٔ موازی: <span dir="ltr">{step.parallelGroup}</span>
                        </span>
                      )}
                      <span dir="ltr" className="text-[11px]">
                        {step.stepKey}
                      </span>
                    </div>
                  </div>

                  {isDraft && canWorkflowManage && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0 || busy}
                        aria-label={`جابه‌جایی «${step.displayName}» به بالا`}
                        data-testid={`commerce-workflow-step-up-${step.stepKey}`}
                        className="h-8 rounded-lg border border-border px-2 text-xs text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        ↑ بالا
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === steps.length - 1 || busy}
                        aria-label={`جابه‌جایی «${step.displayName}» به پایین`}
                        data-testid={`commerce-workflow-step-down-${step.stepKey}`}
                        className="h-8 rounded-lg border border-border px-2 text-xs text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        ↓ پایین
                      </button>
                      <button
                        type="button"
                        onClick={() => setStepDrawer({ step, key: Date.now() })}
                        aria-label={`ویرایش مرحلهٔ «${step.displayName}»`}
                        data-testid={`commerce-workflow-step-edit-${step.stepKey}`}
                        className="h-8 rounded-lg border border-border px-2 text-xs text-foreground transition hover:bg-secondary"
                      >
                        ویرایش
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(step)}
                        aria-label={`حذف مرحلهٔ «${step.displayName}»`}
                        data-testid={`commerce-workflow-step-delete-${step.stepKey}`}
                        className="h-8 rounded-lg border border-destructive/30 px-2 text-xs text-destructive transition hover:bg-destructive/10"
                      >
                        حذف
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <CommerceSettingsDialog
        open={publishOpen}
        title="بررسی پیش از انتشار"
        description="پیش از انتشار، محتوای این نسخه را مرور کنید."
        pending={pendingAction === 'publish'}
        onCancel={() => {
          if (pendingAction !== 'publish') setPublishOpen(false);
        }}
        testId="commerce-workflow-publish-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={pendingAction === 'publish'}
              onClick={() => setPublishOpen(false)}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={runPublish}
              disabled={pendingAction === 'publish'}
              aria-busy={pendingAction === 'publish'}
              data-testid="commerce-workflow-publish-confirm"
            >
              {pendingAction === 'publish' ? 'در حال انتشار…' : 'انتشار نسخه'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <dl className="space-y-2 rounded-xl border border-border bg-secondary/40 p-3 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">نسخه</dt>
              <dd className="font-medium text-foreground">{version.versionLabel}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">وضعیت</dt>
              <dd>{commerceWorkflowVersionStatusLabel(version.status)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">تعداد مراحل</dt>
              <dd>{toPersianDigits(steps.length)}</dd>
            </div>
          </dl>

          <div>
            <p className="text-xs font-medium text-foreground">ترتیب مراحل</p>
            <ol className="mt-1 space-y-1 text-xs text-muted-foreground">
              {steps.map((step, index) => (
                <li key={step.id}>
                  {toPersianDigits(index + 1)}. {step.displayName}
                </li>
              ))}
            </ol>
          </div>

          <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
            پس از انتشار، این نسخه نسخهٔ در جریان فرآیند می‌شود و قابل ویرایش نخواهد بود؛ برای هر
            تغییر بعدی باید نسخهٔ جدیدی بسازید.
          </p>
        </div>
      </CommerceSettingsDialog>

      <CommerceConfirmDialog
        open={archiveOpen}
        title="آرشیو کردن نسخه"
        description={`نسخهٔ «${version.versionLabel}» از جریان فرآیند خارج می‌شود.`}
        consequences="این اقدام بازگشت‌پذیر نیست؛ بازگرداندن نسخه امکان‌پذیر نیست."
        confirmLabel="آرشیو کن"
        confirmTone="danger"
        pending={pendingAction === 'archive'}
        onConfirm={runArchive}
        onCancel={() => {
          if (pendingAction !== 'archive') setArchiveOpen(false);
        }}
        testId="commerce-workflow-archive-dialog"
      />

      <CommerceConfirmDialog
        open={deleteTarget !== null}
        title="حذف مرحله"
        description={
          deleteTarget ? `مرحلهٔ «${deleteTarget.displayName}» از این نسخه حذف می‌شود.` : undefined
        }
        consequences="این مرحله دیگر در درخواست‌هایی که از این نسخه استفاده می‌کنند ظاهر نمی‌شود."
        confirmLabel="حذف مرحله"
        confirmTone="danger"
        pending={deletePending}
        onConfirm={runDeleteStep}
        onCancel={() => {
          if (!deletePending) setDeleteTarget(null);
        }}
        testId="commerce-workflow-delete-step-dialog"
      />

      {stepDrawer && (
        <CommerceWorkflowStepEditor
          key={stepDrawer.key}
          versionId={versionId}
          step={stepDrawer.step}
          nextOrdering={
            steps.length > 0
              ? Math.max(...steps.map((step) => step.ordering)) + 1
              : 1
          }
          canReadDirectory={canReadDirectory}
          onClose={() => setStepDrawer(null)}
          onSaved={mergeSavedStep}
        />
      )}
    </div>
  );
}
