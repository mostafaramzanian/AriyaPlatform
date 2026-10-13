'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import {
  assignCommerceLine,
  type CommerceAssignment,
  type CommerceAssignmentsRead,
  type CommerceApprovalsRead,
  type CommerceCommercialGroup,
  type CommercePurchaseLine,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceAssignmentSourceLabel,
  commerceInstantLabel,
} from '@/lib/commerce-labels';
import {
  CommerceApprovalStatusBadge,
  CommerceAssignmentStatusBadge,
  CommerceSectionHeading,
} from '../commerce-ui';
import { CommerceCommercialDecisionPanel } from './CommerceCommercialDecisionPanel';
import type { SectionState } from './section-state';

function lineLabel(line: CommercePurchaseLine): string {
  const description = line.technicalDescription?.trim();
  return `ردیف ${line.lineNumber}${description ? ` — ${description}` : ''}`;
}

/**
 * PHASE UI-2 → UI-3: «بازرگانی» — assignments, their APPEND-ONLY history, the approval
 * records, and — since UI-3 — the DECISION itself.
 *
 * TWO MUTATIONS LIVE HERE, EACH EXACTLY AS THE BACKEND DEFINES IT:
 *  1. manual assign / reassign (UI-2, `commerce.manage`, J6);
 *  2. commercial DECISION (UI-3, `commerce.approve`, J5): the panel below renders only
 *     for an approval that is `PENDING` AND whose stored `approverUserId` equals the
 *     session user — presentation gating only; `POST commercial-approvals/:id/decision`
 *     re-checks both server-side and remains authoritative.
 *
 * DECISION ENTRY POINTS. The inline action card («بررسی و تصمیم‌گیری») opens the panel
 * in place — the decider never leaves the Purchase — and `initialDecisionId` (from
 * `?decision=`) lets My Tasks deep-link straight into the same panel.
 *
 * APPROVAL ROWS WHITELIST THEIR FIELDS. The read returns the raw stored row; only the
 * fields this screen renders are consumed (`tenantId` and configuration metadata are
 * never read, never rendered, never sent anywhere).
 */
export function CommerceCommercialSection({
  assignmentsState,
  approvalsState,
  groupsState,
  purchaseLines,
  documentNumber,
  currentUserId,
  canApprove,
  canManage,
  initialDecisionId = null,
  onRetry,
  onMutated,
  onDecisionRecorded,
}: {
  assignmentsState: SectionState<CommerceAssignmentsRead>;
  approvalsState: SectionState<CommerceApprovalsRead>;
  groupsState: SectionState<CommerceCommercialGroup[]>;
  purchaseLines: CommercePurchaseLine[];
  documentNumber: string;
  /** The session's own user id — presentation gating ONLY (§3). */
  currentUserId: string | null;
  canApprove: boolean;
  canManage: boolean;
  /** `?decision=<approvalId>` deep link from My Tasks. */
  initialDecisionId?: string | null;
  onRetry: () => void;
  onMutated: () => void;
  /** Refetch approvals after a recorded decision OR a stale-state conflict. */
  onDecisionRecorded: () => void;
}) {
  const [assigning, setAssigning] = React.useState<CommercePurchaseLine | null>(null);
  const [groupId, setGroupId] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /** The approval whose decision panel is open, plus the trigger that opened it (§21). */
  const [decidingId, setDecidingId] = React.useState<string | null>(null);
  const decisionTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  // Per-approval trigger elements, so the My Tasks deep link (which opens the panel
  // WITHOUT a click) can still restore focus to the right button on close — browser QA
  // run4 caught focus falling to <body> because only the click path filled the ref.
  const decisionTriggerRefs = React.useRef(new Map<string, HTMLButtonElement>());
  // Focus fallback target: after a RECORDED decision the trigger button unmounts with
  // the entry card, so closing the panel must not strand focus on <body>.
  const sectionRef = React.useRef<HTMLDivElement | null>(null);

  // Memoized on the DATA identity so downstream effect/render derivations get a
  // stable array (`?? []` on every render would mint a fresh literal and defeat
  // `react-hooks/exhaustive-deps` consumers).
  const liveApprovals = React.useMemo(
    () => approvalsState.data?.approvals ?? [],
    [approvalsState.data]
  );
  /** Presentation gating ONLY (§3): pending AND stored approver is the session user. */
  const actionableApprovals =
    canApprove && currentUserId
      ? liveApprovals.filter(
          (approval) => approval.status === 'PENDING' && approval.approverUserId === currentUserId
        )
      : [];
  const liveDeciding = decidingId
    ? (liveApprovals.find((approval) => approval.id === decidingId) ?? null)
    : null;

  // Deep link from My Tasks: open the panel once the authoritative read has
  // landed. Applied during render, guarded by the already-applied marker —
  // never as an effect-body setter (`react-hooks/set-state-in-effect`). The
  // close handler resolves the focus target from the trigger map at close time,
  // so no ref arming is needed here (the map is populated by then; the original
  // effect's ref-arm was a fallback that produced the same outcome).
  const [appliedDecisionId, setAppliedDecisionId] = React.useState<string | null>(null);
  const deepLinkTarget = initialDecisionId
    ? (liveApprovals.find((approval) => approval.id === initialDecisionId) ?? null)
    : null;
  if (
    initialDecisionId &&
    appliedDecisionId !== initialDecisionId &&
    approvalsState.status === 'ready' &&
    deepLinkTarget &&
    deepLinkTarget.status === 'PENDING' &&
    canApprove &&
    currentUserId &&
    deepLinkTarget.approverUserId === currentUserId
  ) {
    setAppliedDecisionId(initialDecisionId);
    setDecidingId(initialDecisionId);
  }

  /** A purchase line's human label for an approval, or `null` when the line is unknown. */
  const lineLabelFor = (purchaseLineId: string): string | null => {
    const line = purchaseLines.find((candidate) => candidate.id === purchaseLineId);
    return line ? lineLabel(line) : null;
  };

  const history = assignmentsState.data?.history ?? [];

  // The assignments array is built INSIDE the memo (keyed on the data identity)
  // so the memo's dependency stays stable across renders — a `?? []` literal
  // outside would mint a fresh array every render
  // (`react-hooks/exhaustive-deps`).
  const assignmentByLine = React.useMemo(() => {
    const map = new Map<string, CommerceAssignment>();
    for (const row of assignmentsState.data?.assignments ?? []) {
      map.set(row.purchaseLineId, row);
    }
    return map;
  }, [assignmentsState.data]);

  /** A purchase-line id into its human label; the raw id when the line is unknown. */
  const lineByIdLabel = (id: string): string => {
    const line = purchaseLines.find((item) => item.id === id);
    return line ? lineLabel(line) : id;
  };

  const handleAssign = async () => {
    if (!assigning || pending) return;
    if (!groupId) {
      setError('برای واگذاری، یک گروه بازرگانی انتخاب کنید.');
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      await assignCommerceLine({
        lineId: assigning.id,
        groupId,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setMessage('واگذاری ردیف ثبت شد و وضعیت از سرور بازخوانی شد.');
      setAssigning(null);
      setGroupId('');
      setReason('');
      onMutated();
    } catch (err: unknown) {
      setError(
        commerceActionErrorMessage(err, 'واگذاری ردیف انجام نشد؛ مقادیر انتخاب‌شده حفظ شده است.')
      );
    } finally {
      setPending(false);
    }
  };

  if (assignmentsState.status === 'loading') return <CoreLoading lines={4} />;
  if (assignmentsState.status === 'error') {
    return <CoreError message={assignmentsState.error ?? 'خطا'} onRetry={onRetry} />;
  }

  const groups = groupsState.data ?? [];

  return (
    <div
      ref={sectionRef}
      tabIndex={-1}
      className="focus:outline-none"
      data-testid="commerce-commercial-section"
    >
      {/* THE DECISION SURFACE — open for exactly one approval at a time (§11). */}
      {liveDeciding && (
        <div className="mb-6">
          <CommerceCommercialDecisionPanel
            approval={liveDeciding}
            documentNumber={documentNumber}
            lineLabel={lineLabelFor(liveDeciding.purchaseLineId)}
            onDecided={() => onDecisionRecorded()}
            onStale={() => onDecisionRecorded()}
            onClose={() => {
              // Resolve the restore target AT CLOSE TIME from the ref map: a re-render can
              // have swapped the button node after the single ref was armed (browser QA
              // run6), while the map's callback always tracks the current element.
              const trigger =
                (decidingId ? decisionTriggerRefs.current.get(decidingId) : null) ??
                decisionTriggerRef.current;
              setDecidingId(null);
              if (trigger?.isConnected) trigger.focus();
              else sectionRef.current?.focus();
            }}
          />
        </div>
      )}

      {actionableApprovals.length > 0 && (
        <div className="mb-6 space-y-3" data-testid="commerce-decision-entry">
          {actionableApprovals.map((approval) => {
            const isOpen = decidingId === approval.id;
            return (
              <div
                key={approval.id}
                className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    این مورد در انتظار تصمیم شماست.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    سند{' '}
                    <span dir="ltr" className="rounded-md bg-muted px-2 py-0.5 text-foreground">
                      {documentNumber}
                    </span>
                    {lineLabelFor(approval.purchaseLineId)
                      ? ` — ${lineLabelFor(approval.purchaseLineId)}`
                      : ''}
                    {' — '}
                    <span title={approval.createdAt}>
                      از {commerceInstantLabel(approval.createdAt)}
                    </span>
                  </p>
                </div>
                <Button
                  type="button"
                  aria-expanded={isOpen}
                  ref={(element) => {
                    if (element) decisionTriggerRefs.current.set(approval.id, element);
                    else decisionTriggerRefs.current.delete(approval.id);
                  }}
                  onClick={(event) => {
                    decisionTriggerRef.current = event.currentTarget;
                    setDecidingId(isOpen ? null : approval.id);
                  }}
                  data-testid={`commerce-decision-open-${approval.id}`}
                  className="h-10 shrink-0"
                >
                  {isOpen ? 'بستن' : 'بررسی و تصمیم‌گیری'}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <CommerceSectionHeading
        title="واگذاری ردیف‌ها"
        description="وضعیت کنونی هر ردیف؛ تاریخچهٔ واگذاری‌های قبلی در ادامه حفظ می‌شود."
      />
      <ul data-testid="commerce-assignments-list" className="divide-y divide-border">
        {purchaseLines.map((line) => {
          const row = assignmentByLine.get(line.id);
          const isAssigning = assigning?.id === line.id;
          return (
            <li
              key={line.id}
              data-testid={`commerce-assignment-line-${line.lineNumber}`}
              className="py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-foreground">{lineLabel(line)}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {row ? (
                    <>
                      <CommerceAssignmentStatusBadge status={row.status} />
                      <span className="text-xs text-muted-foreground">
                        {commerceAssignmentSourceLabel(row.source)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">بدون واگذاری ثبت‌شده</span>
                  )}
                  {canManage && !isAssigning && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        setAssigning(line);
                        setGroupId(row?.commercialGroupId ?? '');
                        setReason('');
                      }}
                      data-testid={`commerce-assign-open-${line.lineNumber}`}
                      className="h-8 rounded-lg border border-border px-2 text-xs text-foreground transition hover:bg-secondary disabled:opacity-50"
                    >
                      {row ? 'تغییر واگذاری' : 'واگذاری'}
                    </button>
                  )}
                </span>
              </div>

              {row && (
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span dir="ltr">گروه: {row.commercialGroupId ?? '—'}</span>
                  <span dir="ltr">رابط: {row.resolvedUserId ?? '—'}</span>
                  {row.matchedRuleLabel && <span>قاعده: {row.matchedRuleLabel}</span>}
                  <span title={row.updatedAt}>{commerceInstantLabel(row.updatedAt)}</span>
                </p>
              )}
              {isAssigning && (
                <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
                  <p className="text-xs text-muted-foreground">
                    واگذاری دستی تاریخچهٔ قبلی را حذف نمی‌کند؛ در سند نهایی‌شده ممکن نیست.
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label
                        htmlFor="commerce-assign-group"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        گروه بازرگانی
                      </label>
                      <select
                        id="commerce-assign-group"
                        value={groupId}
                        disabled={pending}
                        onChange={(event) => setGroupId(event.target.value)}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                      >
                        <option value="">انتخاب کنید…</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name} ({group.code})
                          </option>
                        ))}
                      </select>
                      {groupsState.status === 'loading' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          در حال بارگذاری گروه‌ها…
                        </p>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor="commerce-assign-reason"
                        className="mb-1 block text-xs text-muted-foreground"
                      >
                        دلیل (اختیاری)
                      </label>
                      <input
                        id="commerce-assign-reason"
                        type="text"
                        maxLength={500}
                        value={reason}
                        disabled={pending}
                        onChange={(event) => setReason(event.target.value)}
                        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring disabled:opacity-60"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <Button
                        type="button"
                        disabled={pending || groupsState.status !== 'ready'}
                        onClick={() => void handleAssign()}
                        aria-busy={pending}
                        data-testid="commerce-assign-submit"
                      >
                        {pending ? 'در حال ثبت…' : 'ثبت واگذاری'}
                      </Button>
                      <button
                        type="button"
                        onClick={() => setAssigning(null)}
                        disabled={pending}
                        className="h-10 rounded-xl border border-border px-3 text-xs text-foreground hover:bg-secondary disabled:opacity-50"
                      >
                        انصراف
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <details className="mt-6" data-testid="commerce-assignment-history">
        <summary className="cursor-pointer text-sm font-medium text-primary">
          تاریخچهٔ واگذاری ({history.length})
        </summary>
        <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
          {history.map((entry) => (
            <li key={entry.id} className="rounded-xl border border-border p-3">
              {lineByIdLabel(entry.purchaseLineId)} —{' '}
              {commerceAssignmentSourceLabel(entry.source)} —{' '}
              <span title={entry.changedAt}>{commerceInstantLabel(entry.changedAt)}</span>
              <br />
              <span dir="ltr">گروه: {entry.commercialGroupId ?? '—'}</span>
              {entry.actorUserId && <span dir="ltr"> · عامل: {entry.actorUserId}</span>}
              {entry.reason && <span> · دلیل: {entry.reason}</span>}
            </li>
          ))}
        </ul>
      </details>

      <div className="mt-6">
        <CommerceSectionHeading
          title="تأییدهای بازرگانی"
          description="وضعیت ثبت‌شدهٔ هر تأیید؛ تصمیم‌گیری در بخشی جداگانه انجام می‌شود."
        />
        {approvalsState.status === 'loading' ? (
          <CoreLoading lines={2} />
        ) : approvalsState.status === 'error' ? (
          <CoreError message={approvalsState.error ?? 'خطا'} onRetry={onRetry} />
        ) : (approvalsState.data?.approvals ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            برای این سند تأیید بازرگانی ثبت نشده است.
          </p>
        ) : (
          <ul data-testid="commerce-approvals-list" className="divide-y divide-border">
            {(approvalsState.data?.approvals ?? []).map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span className="text-sm text-foreground">
                  {lineByIdLabel(approval.purchaseLineId)}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <CommerceApprovalStatusBadge status={approval.status} />
                  <span dir="ltr" className="text-xs text-muted-foreground">
                    {approval.approverUserId}
                  </span>
                  {approval.decidedAt && (
                    <span className="text-xs text-muted-foreground" title={approval.decidedAt}>
                      {commerceInstantLabel(approval.decidedAt)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {message && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-commercial-message"
          className="mt-4 text-xs text-emerald-600 dark:text-emerald-400"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="status"
          aria-live="polite"
          data-testid="commerce-commercial-error"
          className="mt-4 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}