'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_WORKFLOW_TRIGGER_EVENTS,
  COMMERCE_WORKFLOW_VERSION_STATUSES,
  createCommerceWorkflowVersion,
  fetchCommerceWorkflowVersions,
  type CommerceWorkflowDefinition,
  type CommerceWorkflowVersionStatus,
  type CommerceWorkflowVersionSummary,
  type CommerceWorkflowVersionsPage,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceInstantLabel,
  commerceWorkflowTriggerEventLabel,
  commerceWorkflowVersionStatusLabel,
  commerceWorkflowVersionStatusHint,
  commerceWorkflowVersionStatusTone,
} from '@/lib/commerce-labels';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  CommerceBadge,
  CommerceEmptyState,
  CommerceFeedback,
  CommercePagination,
} from '../commerce-ui';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCommerceSettingsGuard } from './CommerceSettingsGuard';
import { CommerceWorkflowEditor } from './CommerceWorkflowEditor';

/**
 * PHASE UI-4: the VERSION HISTORY of one «فرآیند خرید» — where the draft/published
 * distinction becomes visible.
 *
 * EACH ROW STATES WHAT THE BACKEND RETURNS: the label, the status word (badge +
 * hint sentence), the step COUNT, `publishedAt` when the publish transition recorded one,
 * and the last update. Nothing else: no invented "active" flag, no per-row totals, no
 * timestamps the row does not carry.
 *
 * THE ONE RULE THE LIST TEACHES (§8): a published/archived version is READ-ONLY and the
 * way to change a process is a NEW version — so the row's own action is «مشاهده و
 * مدیریت», and «ایجاد نسخهٔ جدید» sits above the list where it belongs, available
 * regardless of which row you are looking at.
 */

export function CommerceWorkflowVersionList({
  definition,
  canWorkflowManage,
  canReadDirectory,
}: {
  definition: CommerceWorkflowDefinition;
  canWorkflowManage: boolean;
  canReadDirectory: boolean;
}) {
  const { requestGuard } = useCommerceSettingsGuard();

  const [statusFilter, setStatusFilter] = React.useState<CommerceWorkflowVersionStatus | ''>('');
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<CommerceWorkflowVersionsPage | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  // Re-arms loading/cleared in every list-refresh handler below (same commit
  // as the token bump) — the version effect needs no in-effect setter resets —
  // and derives the mount skeleton from the cold `data: null`.
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const busy = isLoading || (data === null && error === null);

  const [selected, setSelected] = React.useState<CommerceWorkflowVersionSummary | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createLabel, setCreateLabel] = React.useState('');
  const [createTrigger, setCreateTrigger] = React.useState('');
  const [createPending, setCreatePending] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  // Reset the selection when the parent definition changes (the list is remounted per
  // definition, but the state survives a parent re-render keyed the same way) —
  // and re-arm the list load in the same commit, since `definition.id` also
  // drives the fetch effect below. Render-time adjustment, never an
  // effect-body setter (`react-hooks/set-state-in-effect`).
  const [prevDefinitionId, setPrevDefinitionId] = React.useState(definition.id);
  if (prevDefinitionId !== definition.id) {
    setPrevDefinitionId(definition.id);
    setSelected(null);
    setPage(1);
    setStatusFilter('');
    setLoading(true);
    setError(null);
    setData(null);
  }

  React.useEffect(() => {
    let active = true;

    fetchCommerceWorkflowVersions(definition.id, {
      page,
      pageSize: COMMERCE_DEFAULT_PAGE_SIZE,
      ...(statusFilter ? { status: statusFilter } : {}),
    })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت نسخه‌ها با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [definition.id, page, statusFilter, reloadToken]);

  const openEditor = (version: CommerceWorkflowVersionSummary) => {
    if (selected?.id === version.id) return;
    requestGuard(() => setSelected(version));
  };

  const closeEditor = () => {
    requestGuard(() => {
      setSelected(null);
      reload();
    });
  };

  const submitCreate = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (createPending) return;

    const versionLabel = createLabel.trim();
    if (!versionLabel) {
      setCreateError('برچسب نسخه را وارد کنید.');
      return;
    }

    setCreatePending(true);
    setCreateError(null);
    createCommerceWorkflowVersion(definition.id, {
      versionLabel,
      ...(createTrigger
        ? { triggerEvent: createTrigger as (typeof COMMERCE_WORKFLOW_TRIGGER_EVENTS)[number] }
        : {}),
    })
      .then((created) => {
        setCreatePending(false);
        setCreateOpen(false);
        setCreateLabel('');
        setCreateTrigger('');
        setFeedback(`نسخهٔ «${created.versionLabel}» به‌صورت پیش‌نویس ساخته شد. مراحل آن را اضافه کنید.`);
        reload();
        setSelected(created);
      })
      .catch((err: unknown) => {
        setCreatePending(false);
        setCreateError(commerceActionErrorMessage(err, 'ایجاد نسخه انجام نشد.'));
      });
  };

  const versions = data?.items ?? [];
  // Mount is fetch-driven with a cold `data: null`, so derive the skeleton for
  // the very first response — `isLoading` starts false and arms only retries.
  const showInitialLoading = busy;

  /*
   * The editor REPLACES the list — one thing at a time inside the settings panel — and
   * carries its own back action, which routes through the guard like every other exit.
   */
  if (selected) {
    return (
      <CommerceWorkflowEditor
        versionId={selected.id}
        canWorkflowManage={canWorkflowManage}
        canReadDirectory={canReadDirectory}
        onBack={closeEditor}
        onChanged={reload}
        onRequestNewVersion={() =>
          requestGuard(() => {
            setSelected(null);
            setCreateError(null);
            setCreateOpen(true);
          })
        }
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="commerce-workflow-versions">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">نسخه‌های «{definition.name}»</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            نسخهٔ منتشرشده مبنای انتخاب درخواست‌های جدید است؛ برای تغییر فرآیند، یک نسخهٔ جدید
            ایجاد کنید.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="commerce-workflow-status-filter" className="sr-only">
            وضعیت نسخه
          </label>
          <select
            id="commerce-workflow-status-filter"
            name="status"
            value={statusFilter}
            onChange={(event) => {
              // Filter changes re-arm in the same handler commit (the removed
              // in-effect setters used to arm one render later).
              setLoading(true);
              setError(null);
              setStatusFilter(event.target.value as CommerceWorkflowVersionStatus | '');
              setPage(1);
            }}
            data-testid="commerce-workflow-status-filter"
            className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">همهٔ وضعیت‌ها</option>
            {COMMERCE_WORKFLOW_VERSION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {commerceWorkflowVersionStatusLabel(status)}
              </option>
            ))}
          </select>
          {canWorkflowManage && (
            <Button
              type="button"
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
              data-testid="commerce-workflow-create-version-open"
              className="text-xs"
            >
              ایجاد نسخهٔ جدید
            </Button>
          )}
        </div>
      </div>

      <CommerceFeedback message={feedback} testId="commerce-workflow-version-feedback" />

      {showInitialLoading ? (
        <CoreLoading lines={4} />
      ) : error ? (
        <CoreError message={error} onRetry={reload} />
      ) : versions.length === 0 ? (
        <CommerceEmptyState
          testId="commerce-workflow-versions-empty"
          message={
            statusFilter
              ? 'نسخه‌ای با این وضعیت وجود ندارد.'
              : 'هنوز نسخه‌ای برای این فرآیند ساخته نشده است.'
          }
          action={
            !statusFilter && canWorkflowManage ? (
              <Button
                type="button"
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
                className="text-xs"
              >
                ایجاد نسخه
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2" data-testid="commerce-workflow-version-rows">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`commerce-workflow-version-${version.versionLabel}`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{version.versionLabel}</span>
                  <CommerceBadge
                    tone={commerceWorkflowVersionStatusTone(version.status)}
                    testId={`commerce-workflow-version-status-${version.status}`}
                  >
                    {commerceWorkflowVersionStatusLabel(version.status)}
                  </CommerceBadge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {commerceWorkflowVersionStatusHint(version.status)}
                </p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{toPersianDigits(version.stepCount)} مرحله</span>
                  {version.publishedAt && (
                    <span title={version.publishedAt}>
                      تاریخ انتشار: {commerceInstantLabel(version.publishedAt)}
                    </span>
                  )}
                  <span title={version.updatedAt}>
                    آخرین تغییر: {commerceInstantLabel(version.updatedAt)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={() => openEditor(version)}
                  data-testid={`commerce-workflow-version-open-${version.versionLabel}`}
                  className={
                    version.status === 'DRAFT'
                      ? 'text-xs'
                      : 'border border-border bg-background text-xs text-foreground hover:bg-secondary'
                  }
                >
                  {version.status === 'DRAFT' ? 'ویرایش و انتشار' : 'مشاهده و مدیریت'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {versions.length > 0 && (data?.total ?? 0) > (data?.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE) ? (
        <CommercePagination
          page={data?.page ?? page}
          pageSize={data?.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE}
          total={data?.total ?? 0}
          onPageChange={(next) =>
            requestGuard(() => {
              // Same-commit re-arm (the removed in-effect setters used to arm
              // one render later).
              setLoading(true);
              setError(null);
              setPage(next);
            })
          }
          disabled={isLoading}
        />
      ) : null}

      <CommerceSettingsDialog
        open={createOpen}
        title="ایجاد نسخهٔ جدید"
        description={
          <>
            نسخهٔ جدید به‌صورت پیش‌نویس ساخته می‌شود و هنوز هیچ مرحله‌ای ندارد؛ مراحل آن را پس از
            ایجاد اضافه کنید. نسخهٔ منتشرشدهٔ فعلی تا انتشار این نسخه دست‌نخورده می‌ماند.
          </>
        }
        pending={createPending}
        onCancel={() => {
          if (!createPending) setCreateOpen(false);
        }}
        testId="commerce-workflow-create-version-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={createPending}
              onClick={() => setCreateOpen(false)}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => submitCreate()}
              disabled={createPending}
              aria-busy={createPending}
              data-testid="commerce-workflow-create-version-submit"
            >
              {createPending ? 'در حال ایجاد…' : 'ایجاد نسخه'}
            </Button>
          </>
        }
      >
        <form
          id="commerce-workflow-create-version-form"
          onSubmit={submitCreate}
          className="space-y-4"
        >
          <Input
            id="commerce-workflow-version-label"
            name="versionLabel"
            label="برچسب نسخه"
            value={createLabel}
            onChange={(event) => setCreateLabel(event.target.value)}
            placeholder="مثلاً 1404-01"
            required
          />
          <p className="-mt-3 text-xs text-muted-foreground">
            برچسب، نام این نسخه در فهرست نسخه‌هاست و بعداً قابل تغییر نیست.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="commerce-workflow-version-trigger"
              className="block text-sm font-medium text-foreground"
            >
              رویداد آغاز (اختیاری)
            </label>
            <select
              id="commerce-workflow-version-trigger"
              name="triggerEvent"
              value={createTrigger}
              onChange={(event) => setCreateTrigger(event.target.value)}
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              <option value="">بعداً در ویرایشگر تعیین می‌کنم</option>
              {COMMERCE_WORKFLOW_TRIGGER_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {commerceWorkflowTriggerEventLabel(event)}
                </option>
              ))}
            </select>
          </div>
          {createError && (
            <p
              role="alert"
              data-testid="commerce-workflow-create-version-error"
              className="text-xs text-destructive"
            >
              {createError}
            </p>
          )}
        </form>
      </CommerceSettingsDialog>
    </div>
  );
}