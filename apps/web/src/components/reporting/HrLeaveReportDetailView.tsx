'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchHrLeaveReportRow,
  type ReportingLeaveRow,
} from '@/lib/hr-leave-report-api';
import {
  hrLeaveInstantLabel,
  hrLeavePeriodLabel,
  hrLeaveRequestStatusLabel,
  hrLeaveRequestStatusTone,
  type HrTone,
} from '@/lib/hr-api';
import { HrLeaveReportTimeline } from './HrLeaveReportTimeline';

/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the READ-ONLY detail for ONE register row in
 * the report — `/admin/reporting/hr/leave-requests/[id]`.
 *
 * WHAT THIS PAGE IS FOR: understanding and reviewing the record (person identity,
 * leave kind, requested period, status, record/withdrawal instants). WHAT IT IS
 * NOT: an HR workspace — no submit/edit/withdraw/decide, and no link into HR's
 * own register screens. The data is the contract's whitelist projection; no
 * duration is computed (§13) and no balance is shown — a request row knows WHAT
 * was asked for, never what remains.
 */
const TONE_CLASSES: Record<HrTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="min-w-32 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

function ReportCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="core-card p-4 sm:p-6" data-testid={testId}>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <dl className="mt-2 divide-y divide-border/60">{children}</dl>
    </section>
  );
}

export function HrLeaveReportDetailView({ rowId }: { rowId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('hr.leave.read');

  const [row, setRow] = React.useState<ReportingLeaveRow | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Loading/error arming lives in event handlers (retry) and in the id-change
  // reset below — never in the effect body (`react-hooks/set-state-in-effect`):
  // the effect only settles.

  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [prevRowId, setPrevRowId] = React.useState(rowId);
  // Preserve the pre-Batch-10 arm for record changes: a new id re-arms loading
  // and clears the previous error/row synchronously during render (one extra
  // render, no effect setter). Retries arm through reload() in the retry
  // handler, so every path that used to clear state still does.
  if (prevRowId !== rowId) {
    setPrevRowId(rowId);
    setRow(null);
    setLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    if (!isAuthenticated || rbac.isLoading || !canRead) return;

    let active = true;

    fetchHrLeaveReportRow(rowId)
      .then((result) => {
        if (!active) return;
        setRow(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت جزئیات گزارش با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [rowId, isAuthenticated, rbac.isLoading, canRead, reloadToken]);

  if (isAuthenticated && enforcePermissions && !canRead) {
    return (
      <div data-testid="hr-leave-report-detail">
        <CoreForbidden />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="hr-leave-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="hr-leave-report-detail-error">
        <CoreError
          message={error ?? 'این درخواست یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  return (
    <div data-testid="hr-leave-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/hr/leave-requests"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش درخواست‌های مرخصی
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          درخواست {row.employeeCode}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hrLeavePeriodLabel(row.startDate, row.endDate)} —{' '}
          <span
            data-testid={`hr-leave-report-status-${row.status}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[hrLeaveRequestStatusTone(row.status)]}`}
          >
            {hrLeaveRequestStatusLabel(row.status)}
          </span>
        </p>
      </div>

      <ReportCard title="مشخصات درخواست" testId="hr-leave-report-detail-card">
        <Field label="کد پرسنلی" value={row.employeeCode} />
        <Field
          label="نوع مرخصی"
          value={
            <span>
              {row.leaveTypeName} <span className="text-xs opacity-70">({row.leaveTypeCode})</span>
            </span>
          }
        />
        <Field
          label="بازه درخواست"
          value={
            <span className="tabular-nums">{hrLeavePeriodLabel(row.startDate, row.endDate)}</span>
          }
        />
        <Field
          label="وضعیت"
          value={
            <span data-testid={`hr-leave-report-detail-status-${row.status}`}>
              {hrLeaveRequestStatusLabel(row.status)}
            </span>
          }
        />
        <Field label="دلیل درخواست" value={row.reason} />
        <Field
          label="ثبت"
          value={<span className="tabular-nums">{hrLeaveInstantLabel(row.createdAt)}</span>}
        />
        <Field
          label="لغو"
          value={
            row.cancelledAt !== null ? (
              <span className="tabular-nums">{hrLeaveInstantLabel(row.cancelledAt)}</span>
            ) : (
              'این درخواست لغو نشده است.'
            )
          }
        />
      </ReportCard>

      <HrLeaveReportTimeline rowId={row.id} />
    </div>
  );
}
