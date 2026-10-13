'use client';

import * as React from 'react';
import Link from 'next/link';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { HrBadge, HrCard, HrField, HrPageHeading } from '@/components/hr/hr-ui';
import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { fetchHrLeaveTypes, type HrLeaveType } from '@/lib/hr-api';
import {
  fetchEffectiveLeavePolicy,
  hrLeaveLimitCountingBasisLabel,
  hrLeavePolicyVersionStatusLabel,
  hrLeavePolicyVersionStatusMeaning,
  hrLeavePolicyVersionStatusTone,
  hrLimitEmploymentScopeLabel,
  type HrEffectiveLeavePolicy,
  type HrLeaveLimit,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I (§12, §15.4, §27, §30): the ENTRY SURFACE for leave-policy configuration and simulation.
 *
 * WHY THIS PAGE ASKS A QUESTION INSTEAD OF SHOWING A LIST
 * ------------------------------------------------------
 * There is deliberately no `GET /hr/leave-policies`, so there is no directory to render — and that is
 * §12's design rather than a gap: policy selection is a RESOLUTION, and the authoritative question is
 * "which policy governs this leave type on this day?". An operator therefore enters through the
 * question the API is built to answer, and the answer carries the policy's own id.
 *
 * WHAT THIS PAGE THEREFORE IS NOT. It is not a directory and does not pretend to be one: it issues ONE
 * resolution for ONE leave type and ONE day, and shows that answer. It does not enumerate policies, and
 * a "directory" assembled by querying many leave types would be a fabricated artefact built out of a
 * resolution endpoint — explicitly out of scope.
 *
 * THE TWO PERMISSIONS ARE DIFFERENT AND BOTH HONEST (§25).
 *   * `hr.leave.read` — the ACTUAL gate on both reads this page performs (`/hr/leave-types` and
 *     `/hr/leave-policies/effective`). Without it no question here can be asked at all.
 *   * `hr.leave.policy` — the CONFIGURATION authority. It decides whether the link INTO the
 *     configuration surface is offered, because that destination is gated on it. Offering a link that
 *     would 403 is worse than not offering it (§27.2's doctrine), while this page still performs its
 *     own read for a person holding only the read grant.
 *
 * NOTHING HERE IS ESTABLISHED CLIENT-SIDE: the day defaults to the server's today by OMITTING `asOf`
 * (a blank value would fail the server's date validator), and every state word, limit and window comes
 * from the response.
 */

/** The read both calls on this page answer to. */
const LEAVE_READ = 'hr.leave.read';
/** The configuration authority that gates the destination — not this page's own read. */
const LEAVE_POLICY = 'hr.leave.policy';

interface Resolution {
  /** The leave type the question was asked about, kept so the answer reads on its own. */
  leaveType: HrLeaveType | null;
  answer: HrEffectiveLeavePolicy;
}

/** The HTTP status of a failed call, when the failure carries one. */
function statusOf(err: unknown): number | null {
  return err instanceof CoreApiError ? err.status : null;
}

export function HrLeavePolicyEntryView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(LEAVE_READ);
  const canConfigure = permissions.includes(LEAVE_POLICY);

  const [types, setTypes] = React.useState<HrLeaveType[]>([]);
  const [leaveTypeId, setLeaveTypeId] = React.useState('');
  const [asOf, setAsOf] = React.useState('');
  const [resolution, setResolution] = React.useState<Resolution | null>(null);

  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  const [isResolving, setResolving] = React.useState(false);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  // Re-arms loading/cleared/error-status in the retry handler (same commit as
  // the token bump) — the mount effect below needs no in-effect setter resets;
  // first mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadList();
    setStatus(null);
  };

  /**
   * THE TENANT'S OWN CATALOGUE, read with the REGISTER's grant.
   *
   * `fetchHrLeaveTypes` is the EXISTING client the leave register already uses, so this page needs no
   * new backend surface to populate its selector — which is what kept the entry point inside the frozen
   * scope. The read is bounded by one page at the API's own maximum, the same bound the attendance
   * screen's employee picker uses.
   */
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchHrLeaveTypes({ status: 'ACTIVE', pageSize: 100 })
      .then((page) => {
        if (!active) return;
        setTypes(page.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت انواع مرخصی با خطا مواجه شد.');
        setStatus(statusOf(err));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canRead, isPermissionsLoading, reloadToken]);

  /**
   * ONE RESOLUTION, ON DEMAND.
   *
   * NOT RUN ON MOUNT AND NOT RE-RUN PER KEYSTROKE: a resolution answers a QUESTION, so it is asked
   * deliberately. Submitting re-asks it, and nothing here issues a request the operator did not start.
   */
  const resolve = async (event: React.FormEvent) => {
    event.preventDefault();
    if (leaveTypeId === '' || isResolving) return;

    setResolving(true);
    setResolveError(null);

    try {
      const answer = await fetchEffectiveLeavePolicy({
        leaveTypeId,
        // ABSENT rather than blank when the operator named no day: the server then answers for today,
        // whereas `asOf=` would be a malformed date rather than a question.
        ...(asOf === '' ? {} : { asOf }),
      });

      setResolution({
        leaveType: types.find((entry) => entry.id === leaveTypeId) ?? null,
        answer,
      });
    } catch (err: unknown) {
      setResolution(null);
      setResolveError(err instanceof Error ? err.message : 'انجام بررسی با خطا مواجه شد.');
    } finally {
      setResolving(false);
    }
  };

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return <CoreForbidden message="برای بررسی سیاست‌های مرخصی به مجوز hr.leave.read نیاز دارید." />;
  }

  if (isLoading) return <CoreLoading lines={5} />;

  if (error !== null) {
    // A 403 is a MISSING GRANT, so a retry could never succeed — the register's own distinction.
    if (status === 403) return <CoreForbidden />;

    return <CoreError message={error} onRetry={reload} />;
  }

  return (
    <div data-testid="hr-leave-policy-entry">
      <HrPageHeading
        title="سیاست‌های مرخصی"
        description="نوع مرخصی و در صورت نیاز یک روز را انتخاب کنید تا ببینید کدام سیاست اعمال می‌شود."
      />

      <HrCard title="کدام سیاست اعمال می‌شود؟" testId="hr-leave-policy-resolve">
        <form onSubmit={resolve} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="hr-policy-leave-type">
              نوع مرخصی
            </label>
            <select
              id="hr-policy-leave-type"
              data-testid="hr-policy-leave-type"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              value={leaveTypeId}
              onChange={(event) => setLeaveTypeId(event.target.value)}
              required
            >
              <option value="">— انتخاب کنید —</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground" htmlFor="hr-policy-as-of">
              روز (اختیاری)
            </label>
            <input
              id="hr-policy-as-of"
              data-testid="hr-policy-as-of"
              type="date"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              خالی بماند، امروز سرور در نظر گرفته می‌شود.
            </p>
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              data-testid="hr-policy-resolve-submit"
              disabled={isResolving || leaveTypeId === ''}
              className="rounded-lg border border-border bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {isResolving ? 'در حال بررسی…' : 'بررسی'}
            </button>
          </div>
        </form>

        {resolveError !== null && (
          <p
            data-testid="hr-policy-resolve-error"
            role="alert"
            className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
          >
            {resolveError}
          </p>
        )}
      </HrCard>

      {resolution === null ? (
        <div className="mt-6">
          <CoreEmpty message="برای دیدن سیاست، یک نوع مرخصی و در صورت نیاز یک روز انتخاب کنید." />
        </div>
      ) : (
        <ResolutionPanel resolution={resolution} canConfigure={canConfigure} />
      )}
    </div>
  );
}

/**
 * THE ANSWER, rendered as the four things it actually says (§12, §15.8, §16.6).
 *
 * AN UNGOVERNED DAY IS NOT AN ERROR, and this panel is where that distinction is kept: `version: null`
 * means the tenant has stated NO policy for this leave type on this day (§15.8), rendered as that
 * sentence rather than as a failure or a blank. Anything else would tell an operator the configuration
 * is broken when it is merely silent.
 */
function ResolutionPanel({
  resolution,
  canConfigure,
}: {
  resolution: Resolution;
  canConfigure: boolean;
}) {
  const { answer, leaveType } = resolution;
  const version = answer.version;

  if (version === null) {
    return (
      <div className="mt-6">
        <CoreEmpty
          message={`برای «${leaveType?.name ?? 'این نوع مرخصی'}» در ${answer.asOf} سیاستی ثبت نشده است.`}
        />
      </div>
    );
  }

  const policy = answer.policy;

  return (
    <div className="mt-6 flex flex-col gap-4" data-testid="hr-policy-resolution">
      <HrCard title="سیاست اعمال‌شده" testId="hr-policy-effective">
        <dl className="grid gap-4 sm:grid-cols-2">
          <HrField label="سیاست">
            {policy === null ? '—' : `${policy.name} (${policy.code})`}
          </HrField>
          <HrField label="روز بررسی">{answer.asOf}</HrField>
          <HrField label="نسخه">
            <span className="flex flex-wrap items-center gap-2">
              <span data-testid="hr-policy-version-label">{version.versionLabel}</span>
              <HrBadge
                tone={hrLeavePolicyVersionStatusTone(version.status)}
                testId={`hr-policy-version-status-${version.status}`}
              >
                {hrLeavePolicyVersionStatusLabel(version.status)}
              </HrBadge>
              {answer.historical && (
                <span
                  data-testid="hr-policy-version-historical"
                  className="text-xs text-muted-foreground"
                >
                  پرسش تاریخی
                </span>
              )}
            </span>
          </HrField>
          <HrField label="بازه اعتبار نسخه">
            {version.effectiveFrom} — {version.effectiveTo ?? 'باز'}
          </HrField>
        </dl>

        {/* §30.4: a state is shown WITH its consequence, never as a bare word. */}
        <p className="mt-4 text-xs text-muted-foreground" data-testid="hr-policy-version-meaning">
          {hrLeavePolicyVersionStatusMeaning(version.status)}
        </p>

        {/*
          THE LINK IS OFFERED ONLY TO SOMEONE WHO MAY USE THE DESTINATION. The per-policy surface is
          gated on `hr.leave.policy`, so rendering it for a read-only operator would be a link that
          403s — the "no request that could only 403" rule the register already follows.
        */}
        {policy !== null &&
          (canConfigure ? (
            <div className="mt-4">
              <Link
                href={`/admin/hr/leave-policies/${policy.id}`}
                data-testid="hr-policy-open"
                className="text-sm font-medium text-primary underline"
              >
                باز کردن تنظیمات و شبیه‌سازی این سیاست
              </Link>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground" data-testid="hr-policy-open-denied">
              برای تنظیم و شبیه‌سازی این سیاست به مجوز hr.leave.policy نیاز دارید.
            </p>
          ))}
      </HrCard>

      <LimitList
        title="محدودیت‌های قابل اعمال"
        testId="hr-policy-limits"
        limits={answer.limits}
        emptyMessage="این نسخه برای این نوع مرخصی محدودیتی ثبت نکرده است."
      />

      {/*
        SHOWN ONLY WHEN NON-EMPTY: an empty list of indecidable limits is the normal case, and a
        permanently visible empty box would train an operator to ignore it. But when it is non-empty it
        is a REFUSAL on the request path (§16.6), so it cannot be folded into the list above.
      */}
      {answer.undecidableLimits.length > 0 && (
        <LimitList
          title="محدودیت‌هایی که قابل ارزیابی نیستند"
          testId="hr-policy-undecidable-limits"
          limits={answer.undecidableLimits}
          emptyMessage=""
        />
      )}
    </div>
  );
}

/**
 * The limits of one version, each shown as §32.3 requires.
 *
 * A MAXIMUM IS NEVER DISPLAYED ALONE. The basis and the window accompany it, because §16.1/D7 make the
 * basis part of the type — "3" is unreadable without knowing whether it counts requests or calendar
 * days — and §32.3 states the requirement in exactly those words. `consumesStates` is shown as a
 * FILTER the limit applies, which is what it is: the resolved 54-H decision keeps it in the rule's own
 * `where` clause rather than as a fact, so the UI presents it as the authored condition it expresses.
 */
function LimitList({
  title,
  testId,
  limits,
  emptyMessage,
}: {
  title: string;
  testId: string;
  limits: HrLeaveLimit[];
  emptyMessage: string;
}) {
  return (
    <HrCard title={title} testId={testId}>
      {limits.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[48rem] text-right text-sm"
            data-testid={`${testId}-table`}
          >
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-2 py-2 font-medium">سقف مجاز</th>
                <th className="px-2 py-2 font-medium">مبنای شمارش</th>
                <th className="px-2 py-2 font-medium">بازه پنجره</th>
                <th className="px-2 py-2 font-medium">دامنه استخدام</th>
                <th className="px-2 py-2 font-medium">وضعیت‌های مصرف‌کننده</th>
              </tr>
            </thead>
            <tbody>
              {limits.map((limit) => (
                <tr key={limit.id} className="border-b border-border/50">
                  <td className="px-2 py-2" data-testid={`${testId}-row-${limit.id}`}>
                    {limit.maximum}
                  </td>
                  <td className="px-2 py-2">
                    {hrLeaveLimitCountingBasisLabel(limit.countingBasis)}
                  </td>
                  <td className="px-2 py-2">
                    {limit.windowStart} — {limit.windowEnd}
                  </td>
                  <td className="px-2 py-2">{hrLimitEmploymentScopeLabel(limit.employmentType)}</td>
                  <td className="px-2 py-2">
                    {limit.consumesStates.length === 0 ? '—' : limit.consumesStates.join('، ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </HrCard>
  );
}
