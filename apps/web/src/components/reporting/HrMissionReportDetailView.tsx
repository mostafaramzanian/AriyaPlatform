'use client';

import * as React from 'react';
import { useReloadToken } from '@/hooks/use-reload-token';
import Link from 'next/link';

import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  fetchHrMissionReportRow,
  type ReportingMissionRow,
} from '@/lib/hr-mission-report-api';
import {
  missionDurationLabel,
  missionEngagementLabel,
  missionLocationLabel,
  missionRequestStatusLabel,
  missionRequestStatusTone,
} from '@/lib/hr-mission-labels';
import { hrLeaveInstantLabel, type HrTone } from '@/lib/hr-api';
import { HrMissionReportTimeline } from './HrMissionReportTimeline';

/**
 * Phase REPORTING-HR-MISSION-REQUEST: the READ-ONLY detail for ONE register row in
 * the report — `/admin/reporting/hr/mission-requests/[id]`.
 *
 * WHAT THIS PAGE IS FOR: understanding and reviewing the record (person identity,
 * classification, mission period with clock times, status, the row's own decision
 * reasons). WHAT IT IS NOT: an HR workspace — no submit/resubmit/approve/reject/
 * cancel, and no link into HR's own register screens. The data is the contract's
 * whitelist projection; no duration is computed and no cost is shown — a request
 * row knows WHAT was asked for, never what it cost.
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

export function HrMissionReportDetailView({ rowId }: { rowId: string }) {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);

  const enforcePermissions = !rbac.isLoading && !rbac.error;
  const canRead = !enforcePermissions || rbac.permissions.includes('hr.mission.read');

  const [row, setRow] = React.useState<ReportingMissionRow | null>(null);
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

    fetchHrMissionReportRow(rowId)
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
      <div data-testid="hr-mission-report-detail">
        <CoreForbidden message="برای مشاهده این گزارش به مجوز hr.mission.read نیاز دارید." />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div data-testid="hr-mission-report-detail">
        <CoreLoading label="در حال بارگذاری جزئیات…" lines={5} />
      </div>
    );
  }

  if (error || !row) {
    return (
      <div data-testid="hr-mission-report-detail-error">
        <CoreError
          message={error ?? 'این درخواست یافت نشد.'}
          onRetry={reload}
        />
      </div>
    );
  }

  const hasTimes = row.startTime !== null && row.endTime !== null;

  return (
    <div data-testid="hr-mission-report-detail" className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/reporting/hr/mission-requests"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          بازگشت به گزارش درخواست‌های مأموریت
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-foreground sm:text-2xl">
          مأموریت {row.employeeCode}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {toPersianDigits(row.startDate)} — {toPersianDigits(row.endDate)}{' '}
          {hasTimes && (
            <span className="tabular-nums">
              ({toPersianDigits(row.startTime!)} — {toPersianDigits(row.endTime!)})
            </span>
          )}{' '}
          <span
            data-testid={`hr-mission-report-status-${row.status}`}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[missionRequestStatusTone(row.status)]}`}
          >
            {missionRequestStatusLabel(row.status)}
          </span>
        </p>
      </div>

      <ReportCard title="مشخصات مأموریت" testId="hr-mission-report-detail-card">
        <Field label="کد پرسنلی" value={row.employeeCode} />
        <Field label="حالت مدت" value={missionDurationLabel(row.durationMode)} />
        <Field label="محل" value={missionLocationLabel(row.locationType)} />
        <Field label="نوع همکاری" value={missionEngagementLabel(row.engagementType)} />
        <Field
          label="بازه مأموریت"
          value={
            <span className="tabular-nums">
              {toPersianDigits(row.startDate)} — {toPersianDigits(row.endDate)}
            </span>
          }
        />
        <Field
          label="ساعت‌ها"
          value={
            hasTimes ? (
              <span className="tabular-nums">
                {toPersianDigits(row.startTime!)} — {toPersianDigits(row.endTime!)}
              </span>
            ) : (
              'این مأموریت ساعت شروع و پایان ثبت‌شده ندارد.'
            )
          }
        />
        <Field
          label="مقصد"
          value={row.destination !== null ? row.destination : '—'}
        />
        <Field
          label="شرح"
          value={row.description !== null ? row.description : '—'}
        />
        <Field
          label="وضعیت"
          value={
            <span data-testid={`hr-mission-report-detail-status-${row.status}`}>
              {missionRequestStatusLabel(row.status)}
            </span>
          }
        />
        <Field
          label="نسخه ارسالی"
          value={
            row.submittedRevision !== null
              ? `نسخه ${toPersianDigits(row.submittedRevision)}`
              : 'هنوز ارسالی ثبت نشده است.'
          }
        />
        <Field
          label="دلیل اصلاح"
          value={
            row.correctionReason !== null ? (
              row.correctionReason
            ) : (
              'برای این درخواست دلیل اصلاحی ثبت نشده است.'
            )
          }
        />
        <Field
          label="دلیل رد"
          value={
            row.rejectionReason !== null ? (
              row.rejectionReason
            ) : (
              'برای این درخواست دلیل ردی ثبت نشده است.'
            )
          }
        />
        <Field
          label="ثبت"
          // The SHARED instant formatter (`hrLeaveInstantLabel` is named for its first
          // register): the day read in the API's own zone + the time, with the raw ISO
          // string kept in the DOM as the cell's title.
          value={
            <span className="tabular-nums" title={row.createdAt}>
              {hrLeaveInstantLabel(row.createdAt)}
            </span>
          }
        />
      </ReportCard>

      <HrMissionReportTimeline rowId={row.id} />
    </div>
  );
}
