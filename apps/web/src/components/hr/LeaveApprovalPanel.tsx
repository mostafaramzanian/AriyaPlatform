'use client';

import * as React from 'react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  approveLeaveRequest,
  fetchLeaveApproval,
  leaveApprovalInstanceStatusLabel,
  leaveApprovalInstanceStatusTone,
  leaveApprovalResolutionReasonLabel,
  leaveApprovalStepStatusLabel,
  leaveApprovalStepStatusTone,
  leaveUndecidableReasonLabel,
  rejectLeaveRequest,
  type HrLeaveApprovalInstance,
  type HrLeaveApprovalStep,
} from '@/lib/hr-leave-approval-api';
import { HrBadge, HrCard, HrField, HrNotice } from './hr-ui';

/**
 * Phase 54-J (§9, §10, §11): the DECISION panel for ONE leave request, mounted inline on the
 * register row rather than behind a route of its own.
 *
 * WHY THERE IS NO `/admin/hr/leave/[id]/approval` ROUTE
 * ----------------------------------------------------
 * The flow is a property of a request the operator is already looking at, and the register row
 * already names the employee, the type, the days and the reason — everything a decider needs in
 * order to decide. A separate route would either re-fetch all of that or show the flow stripped of
 * its subject, so the flow is EXPANDED IN PLACE and the row stays the unit of work.
 *
 * WHY THE PANEL READS ON OPEN RATHER THAN WITH THE REGISTER
 * --------------------------------------------------------
 * `GET :id/approval` is a second, more expensive read: it resolves approvers and composes the live
 * instance. Fetching it for every row would pay that cost for the many requests nobody opens — and
 * now that A1's `STEP_LABEL` correction is in force the read no longer even carries the relations
 * it once did, so it is a strictly-worse thing to fetch speculatively. Opening is the intent, so
 * the fetch happens on open.
 *
 * WHAT THIS PANEL DECIDES, AND WHAT IT REFUSES TO DECIDE (§3, §5, §8)
 * -------------------------------------------------------------------
 * The controls appear when — and only when — ALL THREE of these hold:
 *
 *   1. the actor holds `hr.leave.approve` (the caller passes `canApprove`), AND
 *   2. the server says `decidableByActor === true`, AND
 *   3. the instance is `'ACTIVE'`.
 *
 * The second condition is the important one. This component NEVER inspects an employee id, never
 * compares the actor to an approver, and never infers a self-approval rule: the server ran the ONE
 * shared predicate and sent the answer, so the panel renders it. A local re-derivation would be a
 * second authorization model that can disagree with the one guarding the write (§8).
 *
 * When the answer is `false` the panel states the server's OWN reason — `NOT_RESOLVED` or
 * `AWAITING_OTHER` — and when the reason is `null` it says the flow simply has no step being asked,
 * which is a fact about `status` rather than a refusal. A blank space would read as a bug.
 */

/** Shown instead of a decision reason the flow never recorded — the absence is data, not a gap. */
const NO_REASON = 'دلیلی ثبت نشده است.';

/** Formats an ISO instant in the reader's locale, or states that the step is undecided. */
function instantLabel(iso: string | null): string {
  if (iso === null) return '—';

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  return parsed.toLocaleString('fa-IR');
}

/** One step row: its order, who was asked, how it was resolved, and what it recorded. */
function StepRow({ step }: { step: HrLeaveApprovalStep }) {
  return (
    <tr className="border-t border-border" data-testid={`hr-leave-approval-step-${step.order}`}>
      <td className="px-3 py-2 text-sm text-foreground">{step.order.toLocaleString('fa-IR')}</td>
      <td className="px-3 py-2 text-sm">
        <HrBadge
          tone={leaveApprovalStepStatusTone(step.status)}
          testId={`hr-leave-approval-step-status-${step.order}`}
        >
          {leaveApprovalStepStatusLabel(step.status)}
        </HrBadge>
      </td>
      <td className="px-3 py-2 text-sm">
        {/* The ID, rendered as the ID it is. This read carries NO relation label (A1 §5), so a
            "name" here would have to be invented by this file — and there is nothing to invent it
            FROM. Stating the identifier is the honest rendering of what the server sent. */}
        {step.resolvedApproverEmployeeId ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {leaveApprovalResolutionReasonLabel(step.resolutionReason)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {step.decidedAt === null ? (
          '—'
        ) : (
          <span data-testid={`hr-leave-approval-step-decided-${step.order}`}>
            {instantLabel(step.decidedAt)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {step.decisionReason ?? NO_REASON}
      </td>
    </tr>
  );
}

/**
 * The panel itself. Mounted by the register row ONLY once the operator asks for it, so its read
 * and its state are per-row and disappear with the row.
 */
export function LeaveApprovalPanel({
  leaveRequestId,
  reason,
  canApprove,
  onDecided,
}: {
  leaveRequestId: string;
  /**
   * THE EMPLOYEE'S OWN REASON, passed in by the register row that already holds it.
   *
   * REQUIRED, NOT OPTIONAL, and that is a statement about the data rather than a convenience:
   * `LeaveRequest.reason` is `NOT NULL` in `hr_db`, `HrLeaveRequest.reason` is typed `string`, and
   * `LeaveRequest_reason_check` refuses a blank — so "a request without a stated reason" is not a
   * state this system can produce. An optional prop would be this component inventing a case the
   * domain does not have, and the only thing it could buy would be a fallback sentence no reader
   * should ever see.
   *
   * WHY IT IS A PROP RATHER THAN A SECOND FETCH. The panel is mounted INLINE inside the register
   * row, and that row renders this same string two columns to the left (`hr-leave-reason-<id>`).
   * Fetching it again would be a second read of a value already in scope, and the approval read is
   * the more expensive one — it resolves approvers and composes the live instance, so it is the
   * worst possible place to carry a field the caller already has. The reason also belongs to the
   * REQUEST, never to the flow: `LeaveApprovalInstance` has no `reason` column, holds only
   * `leaveRequestId`, and copying it into approval storage would be a second answer to "why was
   * this asked for" that could disagree with the request's own.
   */
  reason: string;
  /** Whether the actor holds `hr.leave.approve`. The server decides too; this only gates the UI. */
  canApprove: boolean;
  /** Called after a successful decision so the register can refresh the row's own status. */
  onDecided: () => void;
}) {
  const [flow, setFlow] = React.useState<HrLeaveApprovalInstance | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in `reload` (same commit as the
  // token bump — the error-state retry), so the flow effect needs no
  // in-effect setter resets. First mount is covered by `isLoading: true`.
  const { token: reloadToken, reload: reloadFlow } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadFlow();
    setStatus(null);
  };

  // A new request id is a NEW read: re-arm during render, guarded by the
  // previous prop. Mount is a no-op (isLoading already armed by its initial
  // value, and the effect settles it).
  const [prevLeaveRequestId, setPrevLeaveRequestId] = React.useState(leaveRequestId);
  if (prevLeaveRequestId !== leaveRequestId) {
    setPrevLeaveRequestId(leaveRequestId);
    setLoading(true);
    setError(null);
    setStatus(null);
  }

  const [isRejecting, setRejecting] = React.useState(false);
  /**
   * The DECIDER'S OWN note — «دلیل رد» — and NOT the request's reason.
   *
   * Named `decisionNote` rather than `reason` because the panel now holds BOTH facts at once: the
   * employee's `reason` (a prop) and the note this decider is typing. Two variables called `reason`
   * would be a scope collision the compiler refuses, and — worse — a shape in which a refactor could
   * bind the employee's text into the reject textarea. The names state which is which.
   */
  const [decisionNote, setDecisionNote] = React.useState('');
  const [isDeciding, setDeciding] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; message: string } | null>(
    null
  );

  React.useEffect(() => {
    let active = true;

    fetchLeaveApproval(leaveRequestId)
      .then((result) => {
        if (!active) return;
        setFlow(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت گردش تأیید با خطا مواجه شد.');
        setStatus(err instanceof CoreApiError ? err.status : null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [leaveRequestId, reloadToken]);

  /**
   * The ONE guard both decision handlers share, and it is deliberately NOT a permission check:
   * `canApprove` gates whether the controls are DRAWN, while this returns early on a flow that is
   * not decidable or not active — the same conditions that hide the buttons. A double click cannot
   * send two decisions because `isDeciding` is set before the await AND re-checked here.
   *
   * The client sends ONLY the reason. The decider is the authenticated actor and the step is read
   * from the live instance server-side, so there is nothing else this component could name.
   */
  const decide = async (kind: 'approve' | 'reject') => {
    if (flow === null || isDeciding) return;
    if (!flow.decidableByActor || flow.status !== 'ACTIVE') return;

    setDeciding(true);
    setNotice(null);

    const stated = decisionNote.trim();

    try {
      const updated =
        kind === 'approve'
          ? await approveLeaveRequest(leaveRequestId, stated === '' ? {} : { reason: stated })
          : await rejectLeaveRequest(leaveRequestId, { reason: stated });

      setFlow(updated);
      setRejecting(false);
      setDecisionNote('');
      setNotice({
        tone: 'ok',
        message: kind === 'approve' ? 'مرحلهٔ جاری تأیید شد.' : 'درخواست رد شد.',
      });
      onDecided();
    } catch (err: unknown) {
      // A 403 is a missing grant and a 409 is a step somebody else already decided: both are states
      // the panel must SHOW rather than retry into, because a retry cannot change either.
      setNotice({
        tone: 'error',
        message: err instanceof Error ? err.message : 'ثبت تصمیم با خطا مواجه شد.',
      });
    } finally {
      setDeciding(false);
    }
  };

  if (error !== null && status === 403) {
    return (
      <HrCard className="mt-2" testId={`hr-leave-approval-panel-${leaveRequestId}`}>
        <CoreForbidden />
      </HrCard>
    );
  }

  if (error !== null) {
    return (
      <HrCard className="mt-2" testId={`hr-leave-approval-panel-${leaveRequestId}`}>
        <CoreError message={error} onRetry={reload} />
      </HrCard>
    );
  }

  if (isLoading) {
    return (
      <HrCard className="mt-2" testId={`hr-leave-approval-panel-${leaveRequestId}`}>
        <CoreLoading lines={4} />
      </HrCard>
    );
  }

  // `null` is the server saying this request has NO approval flow at all: this tenant has no
  // applicable definition (§18.5). That is a different fact from "a flow exists with no steps",
  // and it is stated as the absence of a REQUIREMENT rather than as an error.
  if (flow === null) {
    return (
      <HrCard className="mt-2" testId={`hr-leave-approval-panel-${leaveRequestId}`}>
        <CoreEmpty message="برای این درخواست گردش تأییدی تعریف نشده است؛ نیازی به تصمیم نیست." />
      </HrCard>
    );
  }

  const undecidable = leaveUndecidableReasonLabel(flow.undecidableReason);
  const canDecide = canApprove && flow.decidableByActor && flow.status === 'ACTIVE';

  return (
    <HrCard className="mt-2" testId={`hr-leave-approval-panel-${leaveRequestId}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <HrBadge
          tone={leaveApprovalInstanceStatusTone(flow.status)}
          testId={`hr-leave-approval-status-${leaveRequestId}`}
        >
          {leaveApprovalInstanceStatusLabel(flow.status)}
        </HrBadge>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <HrField label="تعداد مراحل">{flow.stepCount.toLocaleString('fa-IR')}</HrField>
          <HrField label="بازهٔ درخواست">
            <span
              className="font-mono text-xs"
              data-testid={`hr-leave-approval-period-${leaveRequestId}`}
            >
              {flow.requestStartDate} – {flow.requestEndDate}
            </span>
          </HrField>
          {/* THE EMPLOYEE'S REASON, beside the days it explains (§6). It sits in the request SUMMARY
              rather than in the steps table below because it is a fact about the REQUEST, not about
              any one decision — the steps table's «دلیل تصمیم» column is the DECIDER's note, and the
              two must never be confused. Plain text in the same `<dl>` the period uses: no input,
              no control, nothing an approver could edit, and the label names whose reason it is
              («دلیل درخواست مرخصی») so it cannot read as a manager-entered justification. */}
          <HrField label="دلیل درخواست مرخصی">
            <span
              className="max-w-prose whitespace-pre-wrap text-sm"
              data-testid={`hr-leave-approval-request-reason-${leaveRequestId}`}
            >
              {reason}
            </span>
          </HrField>
        </dl>
      </div>

      {notice !== null && <HrNotice tone={notice.tone} message={notice.message} />}

      {/* The server's OWN answer, rendered as it arrived. When it is `false` the panel explains WHY
          with the server's reason; when the reason is `null` the flow simply has no step being
          asked, so the sentence is about the STATE rather than about the reader (§7.3). */}
      {!flow.decidableByActor && (
        <p
          className="mb-4 rounded-xl border border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
          data-testid={`hr-leave-approval-undecidable-${leaveRequestId}`}
        >
          {undecidable ?? 'در حال حاضر مرحله‌ای در نوبت تصمیم این کاربر نیست.'}
        </p>
      )}

      {flow.steps.length === 0 ? (
        <CoreEmpty message="این گردش هیچ مرحله‌ای ندارد." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table
            className="w-full min-w-[48rem] text-right"
            data-testid={`hr-leave-approval-steps-${leaveRequestId}`}
          >
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">ترتیب</th>
                <th className="px-3 py-2 font-medium">وضعیت</th>
                <th className="px-3 py-2 font-medium">تصمیم‌گیرنده</th>
                <th className="px-3 py-2 font-medium">علت انتساب</th>
                <th className="px-3 py-2 font-medium">زمان تصمیم</th>
                <th className="px-3 py-2 font-medium">دلیل تصمیم</th>
              </tr>
            </thead>
            <tbody>
              {flow.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* THE ONE THING THIS PANEL CANNOT DO BY ITSELF: decide. Everything above is a read. The
          read-only holder still sees the whole flow and is told why there are no controls, rather
          than being shown buttons that would 403. */}
      {canDecide ? (
        <div className="mt-4">
          {isRejecting ? (
            <form
              className="flex w-full max-w-lg flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (decisionNote.trim() === '') return;
                void decide('reject');
              }}
            >
              <Textarea
                id={`hr-leave-approval-reason-${leaveRequestId}`}
                name={`approvalReason-${leaveRequestId}`}
                label="دلیل رد (الزامی)"
                value={decisionNote}
                rows={3}
                onChange={(event) => setDecisionNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  data-testid={`hr-leave-approval-reject-submit-${leaveRequestId}`}
                  // The API refuses a blank rejection, so this button refuses to send one: the
                  // server's rule is stated here rather than discovered through a 400.
                  disabled={isDeciding || decisionNote.trim() === ''}
                >
                  ثبت رد
                </Button>
                <Button
                  type="button"
                  data-testid={`hr-leave-approval-reject-dismiss-${leaveRequestId}`}
                  onClick={() => {
                    setRejecting(false);
                    setDecisionNote('');
                  }}
                  className="bg-muted text-foreground hover:bg-muted/80"
                >
                  انصراف
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-testid={`hr-leave-approval-approve-${leaveRequestId}`}
                disabled={isDeciding}
                onClick={() => void decide('approve')}
              >
                تأیید مرحله
              </Button>
              <Button
                type="button"
                data-testid={`hr-leave-approval-reject-${leaveRequestId}`}
                disabled={isDeciding}
                onClick={() => setRejecting(true)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                رد درخواست
              </Button>
            </div>
          )}
        </div>
      ) : (
        !canApprove &&
        flow.status === 'ACTIVE' && (
          <p
            className="mt-4 text-xs text-muted-foreground"
            data-testid={`hr-leave-approval-readonly-${leaveRequestId}`}
          >
            برای ثبت تصمیم، مجوز hr.leave.approve لازم است.
          </p>
        )
      )}
    </HrCard>
  );
}
