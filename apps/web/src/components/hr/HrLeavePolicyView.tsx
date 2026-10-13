'use client';

import * as React from 'react';
import Link from 'next/link';
import { CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { HrBadge, HrCard, HrField, HrPageHeading } from '@/components/hr/hr-ui';
import { LeavePolicySimulationPanel } from '@/components/hr/LeavePolicySimulationPanel';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchLeavePolicy,
  fetchLeavePolicyVersion,
  fetchPublishedLeavePolicyVersion,
  hrLeaveLimitCountingBasisLabel,
  hrLeavePolicyVersionStatusLabel,
  hrLeavePolicyVersionStatusMeaning,
  hrLeavePolicyVersionStatusTone,
  hrLimitEmploymentScopeLabel,
  type HrLeaveLimit,
  type HrLeavePolicy,
  type HrLeavePolicyVersion,
} from '@/lib/hr-leave-policy-api';

/**
 * Phase 54-I (§27, §30, §32): the PER-POLICY configuration and simulation surface.
 *
 * WHY THIS SURFACE IS REACHED BY ID RATHER THAN FROM A DIRECTORY
 * --------------------------------------------------------------
 * This is the destination of the entry surface's resolution: an operator asks "which policy governs
 * this leave type on this day?", receives a policy id, and arrives here. It is ID-ADDRESSED because the
 * API is: the tenant's policy set is deliberately not enumerable (§12), so a page that listed policies
 * would need a contract that does not exist and must not be invented.
 *
 * CONFIGURATION ONLY, AND READ-ONLY
 * ---------------------------------
 * 54-I presents a surface the backend already serves. So this page renders the policy and its versions
 * and offers SIMULATION — and deliberately offers NO authoring, validation, publishing or archiving
 * controls, even though the API supports them: exposing a lifecycle transition is a product decision
 * about who may approve and what an operator is told, and its UI is separate work with its own audit
 * surface (§25.6, §30.5). Adding it here would smuggle that decision into a phase authorized for
 * integration.
 *
 * THE VERSIONS OFFERED ARE THE ONES THIS PAGE LEGITIMATELY KNOWS: the version that answered the
 * governance question, and the one currently in force. The API has no "all versions of a policy" read —
 * `GET /:policyId/versions/:versionId` is version-addressed, `GET /:policyId/published` returns the
 * effective one — so offering more would mean inventing a read.
 */

const LEAVE_READ = 'hr.leave.read';
const LEAVE_POLICY = 'hr.leave.policy';

export function HrLeavePolicyView({
  policyId,
  /** The leave type the operator arrived through, so the simulation form starts pre-filled. */
  leaveTypeId,
  /** The version the entry surface's resolution named, offered alongside the published one. */
  focusVersionId,
}: {
  policyId: string;
  leaveTypeId: string;
  focusVersionId: string | null;
}) {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  /**
   * BOTH GRANTS ARE REQUIRED HERE, AND FOR DIFFERENT REASONS.
   *
   * `hr.leave.read` gates the reads this page performs. `hr.leave.policy` is the CONFIGURATION
   * authority this surface exists to exercise, and the simulation endpoint is gated on it server-side.
   * Checking it here means an operator without it is told plainly rather than shown a form whose every
   * submission would 403 — the "no request that could only fail" rule. The check is a UX AFFORDANCE,
   * NOT the security boundary: the server enforces both regardless of what this component renders.
   */
  const canRead = permissions.includes(LEAVE_READ);
  const canConfigure = permissions.includes(LEAVE_POLICY);

  const [policy, setPolicy] = React.useState<HrLeavePolicy | null>(null);
  const [published, setPublished] = React.useState<HrLeavePolicyVersion | null>(null);
  const [publishedLimits, setPublishedLimits] = React.useState<HrLeaveLimit[]>([]);
  const [focus, setFocus] = React.useState<HrLeavePolicyVersion | null>(null);
  const [focusLimits, setFocusLimits] = React.useState<HrLeaveLimit[]>([]);

  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // `policyId`/`focusVersionId` changes re-arm in the render adjustment below
  // (same commit), so the reads effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const [prevPolicyKey, setPrevPolicyKey] = React.useState({ policyId, focusVersionId });
  if (prevPolicyKey.policyId !== policyId || prevPolicyKey.focusVersionId !== focusVersionId) {
    setPrevPolicyKey({ policyId, focusVersionId });
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  /**
   * THE READS, WHICH ARE INDEPENDENT AND THEREFORE PARALLEL (§34: no serial waterfall, no N+1).
   *
   * The published read may legitimately 404 — a policy with no published version is a normal state for
   * one still being drafted — so it is caught locally rather than failing the page. Only the POLICY read
   * is fatal: without it there is nothing to render.
   */
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead || !canConfigure) return;

    let active = true;

    const reads: Promise<unknown>[] = [
      fetchLeavePolicy(policyId).then((value) => {
        if (active) setPolicy(value);
      }),
      fetchPublishedLeavePolicyVersion(policyId)
        .then(async (version) => {
          if (!active) return;
          setPublished(version);
          /*
            THE PUBLISHED VERSION'S LIMITS COME FROM THE VERSION-ADDRESSED READ, because
            `/published` returns the version WITHOUT its limits — a deliberate wire shape, since that
            route answers "which version is in force" and not "what does it say". Fetching the limits
            through the version id keeps the two questions separate and reads the limits the same way
            the focused version is read, so the two tables cannot disagree.
          */
          const detailed = await fetchLeavePolicyVersion(policyId, version.id).catch(() => null);
          if (active && detailed !== null) setPublishedLimits(detailed.limits);
        })
        .catch(() => {
          // No published version yet — a legitimate configuration state, not a page failure.
        }),
      focusVersionId === null
        ? Promise.resolve()
        : fetchLeavePolicyVersion(policyId, focusVersionId)
            .then((value) => {
              if (!active) return;
              setFocus(value.version);
              setFocusLimits(value.limits);
            })
            .catch(() => {
              // The named version may have been archived out of availability; the published one remains.
            }),
    ];

    Promise.allSettled(reads).then((results) => {
      if (!active) return;
      const first = results[0];
      if (first !== undefined && first.status === 'rejected') {
        const reason: unknown = first.reason;
        setError(reason instanceof Error ? reason.message : 'دریافت سیاست با خطا مواجه شد.');
        setStatus(reason instanceof CoreApiError ? reason.status : null);
      }
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [canRead, canConfigure, isPermissionsLoading, policyId, focusVersionId]);

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  if (!canRead) {
    return <CoreForbidden message="برای دیدن سیاست مرخصی به مجوز hr.leave.read نیاز دارید." />;
  }

  if (!canConfigure) {
    return (
      <CoreForbidden message="برای تنظیم و شبیه‌سازی سیاست مرخصی به مجوز hr.leave.policy نیاز دارید." />
    );
  }

  if (isLoading) return <CoreLoading lines={5} />;

  if (error !== null) {
    if (status === 403) return <CoreForbidden />;
    if (status === 404) {
      return <CoreForbidden message="این سیاست مرخصی در سازمان شما یافت نشد." />;
    }
    return <CoreError message={error} />;
  }

  if (policy === null) return <CoreError message="دریافت سیاست با خطا مواجه شد." />;

  /**
   * THE SELECTOR'S VERSIONS, DE-DUPLICATED BY ID. The focused version and the published one may be the
   * same row — the common case for a policy whose current configuration answered the question — and a
   * selector offering it twice would imply two distinct choices.
   */
  const offered = [focus, published].filter(
    (entry): entry is HrLeavePolicyVersion => entry !== null
  );
  const distinct = offered.filter(
    (entry, index) => offered.findIndex((other) => other.id === entry.id) === index
  );

  return (
    <div data-testid="hr-leave-policy">
      <nav className="mb-4 text-xs text-muted-foreground" aria-label="مسیر">
        <Link href="/admin/hr/leave-policies" className="underline" data-testid="hr-policy-back">
          بازگشت به بررسی سیاست
        </Link>
      </nav>

      <HrPageHeading
        title={policy.name}
        description={`کد سیاست: ${policy.code}`}
        actions={
          <Link
            href={`/admin/hr/leave-policies?leaveTypeId=${encodeURIComponent(leaveTypeId)}`}
            className="text-sm underline"
          >
            بررسی دوباره
          </Link>
        }
      />

      <HrCard title="مشخصات سیاست" testId="hr-policy-detail">
        <dl className="grid gap-4 sm:grid-cols-2">
          <HrField label="نام">{policy.name}</HrField>
          <HrField label="کد">{policy.code}</HrField>
        </dl>
      </HrCard>

      {/*
        THE VERSION IN CONTEXT. When the operator arrived through a resolution for a specific version,
        that version is shown as the one under inspection — with its STATE MEANING beside it, because
        §30.4 requires the four states to be visible "with their consequences stated" and a bare
        "بایگانی‌شده" does not tell an operator that history governs nothing today.
      */}
      {focus !== null && (
        <div className="mt-4">
          <HrCard title="نسخه در بررسی" testId="hr-policy-focus-version">
            <dl className="grid gap-4 sm:grid-cols-2">
              <HrField label="برچسب نسخه">{focus.versionLabel}</HrField>
              <HrField label="وضعیت">
                <HrBadge
                  tone={hrLeavePolicyVersionStatusTone(focus.status)}
                  testId={`hr-policy-focus-status-${focus.status}`}
                >
                  {hrLeavePolicyVersionStatusLabel(focus.status)}
                </HrBadge>
              </HrField>
              <HrField label="شروع اعتبار">{focus.effectiveFrom}</HrField>
              <HrField label="پایان اعتبار">{focus.effectiveTo ?? 'باز'}</HrField>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground" data-testid="hr-policy-focus-meaning">
              {hrLeavePolicyVersionStatusMeaning(focus.status)}
            </p>
            <LimitTable limits={focusLimits} testId="hr-policy-focus-limits" />
          </HrCard>
        </div>
      )}

      {/* The published version, when there is one, because it is what governs runtime today. */}
      {published !== null && (
        <div className="mt-4">
          <HrCard
            title="نسخه منتشرشده (حاکم بر تصمیم‌های جدید)"
            testId="hr-policy-published-version"
          >
            <dl className="grid gap-4 sm:grid-cols-2">
              <HrField label="برچسب نسخه">{published.versionLabel}</HrField>
              <HrField label="وضعیت">
                <HrBadge
                  tone={hrLeavePolicyVersionStatusTone(published.status)}
                  testId="hr-policy-published-status"
                >
                  {hrLeavePolicyVersionStatusLabel(published.status)}
                </HrBadge>
              </HrField>
            </dl>
            <LimitTable limits={publishedLimits} testId="hr-policy-published-limits" />
          </HrCard>
        </div>
      )}

      <div className="mt-4">
        <LeavePolicySimulationPanel
          policyId={policyId}
          versions={distinct}
          defaultLeaveTypeId={leaveTypeId}
        />
      </div>
    </div>
  );
}

/**
 * The limits of a version, each shown as §32.3 requires.
 *
 * A MAXIMUM IS NEVER DISPLAYED ALONE. The basis and the window accompany it, because §16.1/D7 make the
 * basis part of the limit's type — "5" is unreadable without knowing whether it counts requests or
 * calendar days — and §32.3 states that requirement in exactly those words. `consumesStates` is shown
 * as the FILTER the limit applies, which is what it is: the resolved 54-H decision keeps it in the
 * rule's own matching semantics rather than as a fact, so the UI presents the authored condition.
 */
function LimitTable({ limits, testId }: { limits: HrLeaveLimit[]; testId: string }) {
  if (limits.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
        این نسخه برای این نوع مرخصی محدودیتی ثبت نکرده است.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[48rem] text-right text-sm" data-testid={`${testId}-table`}>
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
            <tr
              key={limit.id}
              className="border-b border-border/50"
              data-testid={`${testId}-row-${limit.id}`}
            >
              <td className="px-2 py-2">{limit.maximum}</td>
              <td className="px-2 py-2">{hrLeaveLimitCountingBasisLabel(limit.countingBasis)}</td>
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
  );
}
