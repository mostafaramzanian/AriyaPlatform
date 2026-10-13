'use client';

import * as React from 'react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  approveMission,
  correctMission,
  fetchMissionApproval,
  rejectMission,
  type HrMissionApprovalInstance,
  type HrMissionApprovalStep,
  type HrMissionRequest,
} from '@/lib/hr-mission-api';
import {
  missionApprovalInstanceStatusLabel,
  missionApprovalInstanceStatusTone,
  missionApprovalResolutionReasonLabel,
  missionApprovalStepStatusLabel,
  missionApprovalStepStatusTone,
  missionDayLabel,
  missionDurationLabel,
  missionRangeLabel,
  missionRequestStatusLabel,
  missionRequestStatusTone,
  missionRoutingModeLabel,
} from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrField, HrNotice } from './hr-ui';

/**
 * Phase 55 Step 8C: the DECISION panel for ONE mission request, mounted INLINE on the approver's
 * queue row rather than behind a route of its own.
 *
 * WHY THERE IS NO `/admin/hr/missions/[id]/approval` ROUTE
 * ------------------------------------------------------
 * The flow is a property of a request the approver is already looking at, and the queue row already
 * names the employee, the range, the duration and the destination — everything a decider needs in
 * order to decide. A separate route would either re-fetch all of that or show the flow stripped of
 * its subject, so the flow is EXPANDED IN PLACE and the row stays the unit of work. This is the same
 * decision `LeaveApprovalPanel` made in 54-J, for the same reason.
 *
 * WHY THE PANEL READS ON OPEN RATHER THAN WITH THE QUEUE
 * -----------------------------------------------------
 * `GET :id/approval` is a second, more expensive read: it resolves the live instance, its steps and
 * a per-step decisionability answer for THIS actor. Paying that for every queued row would be paid
 * for the many rows nobody opens. Opening is the intent, so the fetch happens on open.
 *
 * WHAT THIS PANEL DECIDES, AND WHAT IT REFUSES TO DECIDE (§3, §5, §8)
 * -----------------------------------------------------------------
 * The controls appear when — and only when — ALL THREE of these hold:
 *
 *   1. the actor holds `hr.mission.approve` (the caller passes `canApprove`), AND
 *   2. the server says `instance.canDecide === true`, AND
 *   3. the instance is `'ACTIVE'`.
 *
 * The second condition is the important one. This component NEVER inspects an employee id, never
 * compares the actor to `resolvedApproverEmployeeId`, never reads `decidedByEmployeeId` to work out
 * whose turn it is, and never infers a self-approval rule from `request.employee`. The server ran
 * the ONE shared predicate — `isDecider` in `mission-approval.service.ts` — and sent the answer, so
 * the panel renders it. A local re-derivation would be a second authorization model that can
 * disagree with the one guarding the write.
 *
 * `decidableByActor` IS READ PER STEP and `canDecide` is read once for the actor: both are the
 * server's, and the per-step flag is rendered as a fact about THAT row rather than folded into any
 * conclusion of this component's own.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. `MissionApprovalInstance` carries no `resolutionReason` at
 * instance level — that reason exists only PER STEP — so nothing here invents a flow-wide one.
 * Likewise the approver's own decided note is `step.decisionReason`; the request's
 * `correctionReason` and `rejectionReason` are the EMPLOYEE-facing columns, and the panel keeps the
 * three apart rather than letting one stand in for another.
 */

/** Shown instead of a decision reason the flow never recorded — the absence is data, not a gap. */
const NO_REASON = 'دلیلی ثبت نشده است.';

/** Shown instead of a resolved approver when the server resolved nobody for the step. */
const NO_APPROVER = '—';

/** The reason an approver types is a mandatory, non-blank act: the API refuses an empty one. */
const REASON_MAX_LENGTH = 500;

/**
 * NOTES ON WHAT THIS READ DOES **NOT** CARRY, so nobody adds a column for it.
 *
 * `HrMissionApprovalStep` has no `decidedAt` and no relation label — unlike the leave surface's step
 * shape — so the table below has no «زمان تصمیم» column and renders the decider as the employee ID
 * the server sent. Fabricating either would mean a timestamp or a name the API never provided, and a
 * plausible-looking cell is worse than an absent one: an empty `decidedAt` would read as "this step
 * was decided at an unknown time" rather than "this read does not report it".
 */

/**
 * One step row: its order, how it stands, WHO was resolved to decide, WHY that person, and what the
 * step recorded.
 *
 * The approver is rendered as the EMPLOYEE ID the server sent, because that is all this read
 * carries — there is deliberately no relation label to render, and inventing a name would be
 * inventing data. `resolutionReason` sits beside it so «جانشین موقت» explains a decider the reader
 * did not expect, and «بدون جانشین» explains an id that is absent.
 */
function StepRow({ step, requestId }: { step: HrMissionApprovalStep; requestId: string }) {
  return (
    <tr
      className="border-t border-border"
      data-testid={`hr-mission-approval-step-${requestId}-${step.order}`}
    >
      <td className="px-3 py-2 text-sm text-foreground">{step.order.toLocaleString('fa-IR')}</td>
      <td className="px-3 py-2 text-sm">
        <HrBadge
          tone={missionApprovalStepStatusTone(step.status)}
          testId={`hr-mission-approval-step-status-${requestId}-${step.order}`}
        >
          {missionApprovalStepStatusLabel(step.status)}
        </HrBadge>
      </td>
      <td className="px-3 py-2 text-sm">
        {step.resolvedApproverEmployeeId ?? (
          <span className="text-muted-foreground">{NO_APPROVER}</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {missionApprovalResolutionReasonLabel(step.resolutionReason)}
      </td>
      {/* WHO ACTUALLY DECIDED, which is not always who was ASKED: a substitute may have decided a
          step whose resolved approver was somebody else, so the two columns are not duplicates. */}
      <td className="px-3 py-2 text-sm">
        {step.decidedByEmployeeId ?? <span className="text-muted-foreground">{NO_APPROVER}</span>}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {step.decisionReason ?? NO_REASON}
      </td>
      {/* THE SERVER'S ANSWER for THIS step, rendered as received (§8). It is deliberately shown even
          where the panel would never draw a control — a read-only holder learns which step is theirs
          rather than having to infer it. */}
      <td className="px-3 py-2 text-xs">
        {step.decidableByActor ? (
          <span
            className="text-emerald-700 dark:text-emerald-300"
            data-testid={`hr-mission-approval-step-mine-${requestId}-${step.order}`}
          >
            نوبت شما
          </span>
        ) : (
          <span className="text-muted-foreground">{NO_APPROVER}</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The request being decided, stated in full before any control is offered.
 *
 * WHY THE WHOLE REQUEST IS RE-STATED. The panel is expanded under a queue row, but the rows above
 * and below it are other missions, and a decider acting on the wrong one is the single most
 * expensive mistake this screen can host. Restating the employee, range, duration, destination and
 * description pins the subject beside the buttons.
 */
function RequestFacts({ request }: { request: HrMissionRequest }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      <HrField label="کارمند">
        <span
          className="font-mono text-xs"
          data-testid={`hr-mission-approval-employee-${request.id}`}
        >
          {request.employee?.employeeCode ?? NO_APPROVER}
        </span>
      </HrField>
      <HrField label="وضعیت درخواست">
        <HrBadge
          tone={missionRequestStatusTone(request.status)}
          testId={`hr-mission-approval-request-status-${request.id}`}
        >
          {missionRequestStatusLabel(request.status)}
        </HrBadge>
      </HrField>
      <HrField label="ماهیت ماموریت">{missionDurationLabel(request.durationMode)}</HrField>
      <HrField label="تاریخ شروع">{missionDayLabel(request.startDate)}</HrField>
      <HrField label="تاریخ پایان">{missionDayLabel(request.endDate)}</HrField>
      {/* The two stored days VERBATIM beside the Persian rendering — the range is INCLUSIVE, so a
          single-day mission legitimately repeats its day and hiding that would hide the contract. */}
      <HrField label="بازه (میلادی)">
        <span className="font-mono text-xs" data-testid={`hr-mission-approval-range-${request.id}`}>
          {missionRangeLabel(request.startDate, request.endDate)}
        </span>
      </HrField>
      <HrField label="مقصد">
        {request.destination ?? <span className="text-muted-foreground">{NO_APPROVER}</span>}
      </HrField>
      {/* THE EMPLOYEE'S OWN DESCRIPTION — read-only text, and the reason a mission is ever asked for.
          It is drawn as a `span` in a `<dd>`, never as a control, and it is labelled as the
          employee's so it cannot read as the approver's own note. The approver's note is a separate
          state this panel owns, and the two must never be bound together. */}
      <HrField label="شرح درخواست کارمند">
        <span
          className="max-w-prose whitespace-pre-wrap text-sm"
          data-testid={`hr-mission-approval-description-${request.id}`}
        >
          {request.description ?? <span className="text-muted-foreground">{NO_REASON}</span>}
        </span>
      </HrField>
    </dl>
  );
}

/**
 * A reason a MANAGER previously wrote on this request, shown beside the flow.
 *
 * WHY THIS IS A SEPARATE, LABELLED BLOCK. `MissionRequest.correctionReason` and
 * `MissionRequest.rejectionReason` are the EMPLOYEE-facing columns: they are what the requestor
 * reads when the mission comes back. A resubmitted request can therefore carry a correction reason
 * from an EARLIER round while its current step is being asked — so the panel shows the recorded
 * reason, under the status that owns the column, and never lets it stand in for the current
 * approver's note or for anything the flow says.
 *
 * Nothing is rendered when the column is `null`, and the two columns are never merged: «این را
 * اصلاح کن» and «نه» are different outcomes, and a reader must be able to tell which they received.
 * The column is only read when its OWN status is current, so a stale value from a superseded round
 * is never presented as a live refusal.
 */
function RecordedManagerReason({
  status,
  correctionReason,
  rejectionReason,
  requestId,
}: {
  status: HrMissionRequest['status'];
  correctionReason: string | null;
  rejectionReason: string | null;
  requestId: string;
}) {
  if (status === 'CORRECTION_REQUIRED' && correctionReason !== null) {
    return (
      <div data-testid={`hr-mission-approval-correction-reason-${requestId}`}>
        <HrNotice tone="error" message={`دلیل بازگشت برای اصلاح: ${correctionReason}`} />
      </div>
    );
  }

  if (status === 'REJECTED' && rejectionReason !== null) {
    return (
      <div data-testid={`hr-mission-approval-rejection-reason-${requestId}`}>
        <HrNotice tone="error" message={`دلیل رد درخواست: ${rejectionReason}`} />
      </div>
    );
  }

  return null;
}

/**
 * The panel itself. Mounted by the queue row ONLY once the approver asks for it, so its read and
 * its state are per-row and disappear with the row.
 */
export function MissionApprovalPanel({
  missionRequestId,
  canApprove,
  onDecided,
}: {
  missionRequestId: string;
  /**
   * Whether the actor holds `hr.mission.approve`. The SERVER decides too — every route behind this
   * panel answers to this one grant — so this prop gates only what is DRAWN, and never what is
   * allowed. A caller that passed `true` wrongly would still be refused by the API.
   */
  canApprove: boolean;
  /** Called after a successful decision so the queue can refresh its own row and its count. */
  onDecided: () => void;
}) {
  const [request, setRequest] = React.useState<HrMissionRequest | null>(null);
  const [instance, setInstance] = React.useState<HrMissionApprovalInstance | null>(null);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in `reload` (same commit as the
  // token bump — used by the decision handlers and the error-state retry), so
  // the flow effect needs no in-effect setter resets. First mount is covered
  // by `isLoading: true`.
  const { token: reloadToken, reload: reloadFlow } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadFlow();
    setStatus(null);
  };

  // A new request id — or a grant arriving — is a NEW read: re-arm during
  // render, guarded by the previous values. Mount is a no-op (isLoading is
  // already true); the closing direction (grant withdrawn) arms nothing, as
  // the effect early-returns and the `!canApprove` render gate precedes the
  // spinner.
  const [prevMissionRequestId, setPrevMissionRequestId] = React.useState(missionRequestId);
  const [prevCanApprove, setPrevCanApprove] = React.useState(canApprove);
  if (prevMissionRequestId !== missionRequestId || prevCanApprove !== canApprove) {
    setPrevMissionRequestId(missionRequestId);
    setPrevCanApprove(canApprove);
    if (canApprove) {
      setLoading(true);
      setError(null);
      setStatus(null);
    }
  }

  /**
   * WHICH ACT the panel is composing, and the approver's OWN note.
   *
   * `decisionNote` rather than `reason`, because the panel holds several strings at once: the
   * employee's `description`, the request's recorded `correctionReason` / `rejectionReason`, and the
   * per-step `decisionReason`. A single variable called `reason` would invite a refactor that bound
   * the employee's words into the approver's box. The name states whose text it is.
   */
  const [act, setAct] = React.useState<'approve' | 'reject' | 'correct' | null>(null);
  const [decisionNote, setDecisionNote] = React.useState('');
  const [isDeciding, setDeciding] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; message: string } | null>(
    null
  );

  React.useEffect(() => {
    // NO REQUEST WITHOUT THE GRANT. `GET :id/approval` answers to `hr.mission.approve`, so a caller
    // without it gets the refusal sentence and no read at all — stated by the render below rather
    // than discovered through a 403.
    if (!canApprove) return;

    let active = true;

    fetchMissionApproval(missionRequestId)
      .then((detail) => {
        if (!active) return;
        setRequest(detail.request);
        setInstance(detail.instance);
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
  }, [missionRequestId, canApprove, reloadToken]);

  /**
   * The ONE guard all three decision handlers share, and it is deliberately NOT a permission check:
   * `canApprove` gates whether the controls are DRAWN, while this returns early on a flow that is
   * not decidable or not active — the same conditions that hide the buttons. A double click cannot
   * send two decisions because `isDeciding` is set before the await AND re-checked here.
   *
   * The client sends ONLY the reason. The decider is the authenticated actor and the step is read
   * from the live instance server-side, so there is nothing else this component could name — and,
   * following `forbidNonWhitelisted`, naming one would be REFUSED rather than ignored.
   */
  const decide = async (kind: 'approve' | 'reject' | 'correct') => {
    if (request === null || instance === null || isDeciding) return;
    if (!instance.canDecide || instance.status !== 'ACTIVE') return;

    const stated = decisionNote.trim();
    // Approving may state nothing; refusing and returning MUST state why — the API's own rule,
    // enforced here rather than discovered through a 400.
    if (kind !== 'approve' && stated === '') return;

    setDeciding(true);
    setNotice(null);

    try {
      // Approving keeps the body EMPTY when nothing was typed, so an optional note is ABSENT rather
      // than an empty string the server would have to interpret.
      const updated =
        kind === 'approve'
          ? await approveMission(missionRequestId, stated === '' ? {} : { reason: stated })
          : kind === 'reject'
            ? await rejectMission(missionRequestId, { reason: stated })
            : await correctMission(missionRequestId, { reason: stated });

      // The WRITE returns the REQUEST, not the flow — so the request is adopted from it, and the
      // flow is RE-READ through the reload token: only the server knows how the route advanced, and
      // a locally computed step state would be exactly the second model this panel refuses to be.
      setRequest(updated);
      setAct(null);
      setDecisionNote('');
      reload();
      setNotice({
        tone: 'ok',
        message:
          kind === 'approve'
            ? 'مرحلهٔ جاری تأیید شد.'
            : kind === 'reject'
              ? 'درخواست رد شد.'
              : 'درخواست برای اصلاح بازگردانده شد.',
      });
      onDecided();
    } catch (err: unknown) {
      // A 403 is a missing grant, and a 409 is a step somebody else already decided or a request
      // that moved on: both are states the panel must SHOW rather than retry into, because a retry
      // cannot change either.
      setNotice({
        tone: 'error',
        message: err instanceof Error ? err.message : 'ثبت تصمیم با خطا مواجه شد.',
      });
    } finally {
      setDeciding(false);
    }
  };

  /**
   * WHAT A CALLER WITHOUT THE GRANT SEES.
   *
   * The refusal is stated BEFORE any read, and NO request is issued: `GET :id/approval` answers to
   * `hr.mission.approve`, so fetching it only to explain a 403 would be a request the grants do not
   * cover. That is the same discipline the queue screen keeps, applied at the row.
   */
  if (!canApprove) {
    return (
      <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
        <CoreForbidden message="برای مشاهده و ثبت تصمیم ماموریت به مجوز hr.mission.approve نیاز دارید." />
      </HrCard>
    );
  }

  if (error !== null && status === 403) {
    return (
      <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
        <CoreForbidden />
      </HrCard>
    );
  }

  if (error !== null) {
    return (
      <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
        <CoreError message={error} onRetry={reload} />
      </HrCard>
    );
  }

  if (isLoading) {
    return (
      <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
        <CoreLoading lines={4} />
      </HrCard>
    );
  }

  if (request === null) {
    return (
      <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
        <CoreEmpty message="اطلاعات این درخواست ماموریت در دسترس نیست." />
      </HrCard>
    );
  }

  /**
   * THE THREE CONDITIONS, in one place.
   *
   * `instance.canDecide` is the SERVER's actor-level answer and `instance.status === 'ACTIVE'` says
   * the flow still has a step being asked. Nothing here compares employee ids or consults
   * `request.status`: the request's own status is a different fact, and inferring decisionability
   * from it would be a second authority.
   */
  const canDecide = instance !== null && instance.canDecide && instance.status === 'ACTIVE';
  /** Refusing and returning must STATE WHY; approving may state nothing at all. */
  const requiresReason = act === 'reject' || act === 'correct';

  return (
    <HrCard className="mt-2" testId={`hr-mission-approval-panel-${missionRequestId}`}>
      <div className="mb-4">
        <RequestFacts request={request} />
      </div>

      {/* A manager's own earlier words on THIS request, kept apart from anything the flow records and
          from anything the current approver is about to type. */}
      <RecordedManagerReason
        status={request.status}
        correctionReason={request.correctionReason}
        rejectionReason={request.rejectionReason}
        requestId={missionRequestId}
      />

      {notice !== null && <HrNotice tone={notice.tone} message={notice.message} />}

      {instance === null ? (
        /* `instance: null` is the server saying this request has NO LIVE FLOW — it may never have
           been routed, or its flow has already closed. That is a different fact from "a flow exists
           with no steps", and it is stated as the absence of anything to decide rather than as an
           error, with the request above still fully readable. */
        <CoreEmpty message="برای این درخواست گردش تأیید فعالی وجود ندارد؛ تصمیمی در نوبت نیست." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <HrBadge
              tone={missionApprovalInstanceStatusTone(instance.status)}
              testId={`hr-mission-approval-flow-status-${missionRequestId}`}
            >
              {missionApprovalInstanceStatusLabel(instance.status)}
            </HrBadge>
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              {/* The ROUTE the server is following — rendered, never re-derived. Which step is «در
                  نوبت تصمیم» depends on this mode, so the decider is told the mode rather than the
                  screen guessing a route from step ordering. */}
              <HrField label="شیوهٔ گردش">
                <span data-testid={`hr-mission-approval-routing-${missionRequestId}`}>
                  {missionRoutingModeLabel(instance.routingMode)}
                </span>
              </HrField>
              <HrField label="شمارهٔ دور">
                <span data-testid={`hr-mission-approval-sequence-${missionRequestId}`}>
                  {instance.sequenceNumber.toLocaleString('fa-IR')}
                </span>
              </HrField>
              <HrField label="تعداد مراحل">{instance.steps.length.toLocaleString('fa-IR')}</HrField>
            </dl>
          </div>

          {/* The server's OWN answer, rendered as it arrived. When it is `false` the panel states
              that no step is currently this actor's rather than leaving a blank space that would
              read as a bug — and it does NOT explain why, because this read carries no flow-level
              refusal code (that vocabulary is per-step on the leave surface, not here), so inventing
              one would be inventing a contract. */}
          {!instance.canDecide && (
            <p
              className="mb-4 rounded-xl border border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground"
              data-testid={`hr-mission-approval-undecidable-${missionRequestId}`}
            >
              در حال حاضر مرحله‌ای در نوبت تصمیم این کاربر نیست.
            </p>
          )}

          {instance.steps.length === 0 ? (
            <CoreEmpty message="این گردش هیچ مرحله‌ای ندارد." />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-card">
              <table
                className="w-full min-w-[52rem] text-right"
                data-testid={`hr-mission-approval-steps-${missionRequestId}`}
              >
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">ترتیب</th>
                    <th className="px-3 py-2 font-medium">وضعیت</th>
                    <th className="px-3 py-2 font-medium">تصمیم‌گیرنده</th>
                    <th className="px-3 py-2 font-medium">علت انتساب</th>
                    <th className="px-3 py-2 font-medium">تصمیم‌گیرندهٔ بالفعل</th>
                    <th className="px-3 py-2 font-medium">دلیل تصمیم</th>
                    <th className="px-3 py-2 font-medium">نوبت</th>
                  </tr>
                </thead>
                <tbody>
                  {instance.steps.map((step) => (
                    <StepRow key={step.order} step={step} requestId={missionRequestId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DecisionControls
            missionRequestId={missionRequestId}
            canDecide={canDecide}
            canDecideByServer={instance.canDecide}
            isFlowActive={instance.status === 'ACTIVE'}
            act={act}
            setAct={setAct}
            decisionNote={decisionNote}
            setDecisionNote={setDecisionNote}
            requiresReason={requiresReason}
            isDeciding={isDeciding}
            onDecide={decide}
          />
        </>
      )}
    </HrCard>
  );
}

/**
 * THE ONE THING THE PANEL CANNOT DO BY ITSELF: decide.
 *
 * Separated from the read block above for the same reason `LeaveApprovalPanel` keeps its controls
 * last: everything before this point is a READ, and the boundary between "what the flow says" and
 * "what this actor may do about it" should be visible in the source, not inferred from a nesting.
 *
 * WHY THE PROPS ARE SPLIT THE WAY THEY ARE. `canDecide` is the ANDED answer that draws the
 * controls; `canDecideByServer` and `isFlowActive` are the two terms it was built from, passed
 * separately so the read-only sentence can name the RIGHT reason for their absence. Without that
 * split the panel would have to say "you may not" to a finished flow, which is not what is true —
 * a `COMPLETED` instance has no step left for anybody, and the actor's answer may even still be
 * `true`.
 */
function DecisionControls({
  missionRequestId,
  canDecide,
  canDecideByServer,
  isFlowActive,
  act,
  setAct,
  decisionNote,
  setDecisionNote,
  requiresReason,
  isDeciding,
  onDecide,
}: {
  missionRequestId: string;
  canDecide: boolean;
  canDecideByServer: boolean;
  isFlowActive: boolean;
  act: 'approve' | 'reject' | 'correct' | null;
  setAct: (act: 'approve' | 'reject' | 'correct' | null) => void;
  decisionNote: string;
  setDecisionNote: (value: string) => void;
  requiresReason: boolean;
  isDeciding: boolean;
  onDecide: (kind: 'approve' | 'reject' | 'correct') => void;
}) {
  if (!canDecide) {
    // A read-only holder is told the reason that ACTUALLY applies: the flow is finished (nothing to
    // decide for ANYBODY), or it is still open and the step being asked is somebody else's. The
    // queue screen has already refused a caller without the grant before this panel is mounted.
    return (
      <p
        className="mt-4 text-xs text-muted-foreground"
        data-testid={`hr-mission-approval-readonly-${missionRequestId}`}
      >
        {isFlowActive && !canDecideByServer
          ? 'تصمیم‌گیری برای این مرحله در نوبت شما نیست.'
          : 'این گردش پایان یافته است و مرحله‌ای برای تصمیم باقی نمانده است.'}
      </p>
    );
  }

  if (act === null) {
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          data-testid={`hr-mission-approval-approve-${missionRequestId}`}
          disabled={isDeciding}
          onClick={() => onDecide('approve')}
        >
          تأیید مرحله
        </Button>
        <Button
          type="button"
          data-testid={`hr-mission-approval-reject-${missionRequestId}`}
          disabled={isDeciding}
          onClick={() => {
            setAct('reject');
            setDecisionNote('');
          }}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        >
          رد درخواست
        </Button>
        {/* A SEPARATE act from rejection, and a separate reason — «این را اصلاح کن» and «نه» are
            different outcomes, and merging them would leave the employee unable to tell which one
            they received. */}
        <Button
          type="button"
          data-testid={`hr-mission-approval-correct-${missionRequestId}`}
          disabled={isDeciding}
          onClick={() => {
            setAct('correct');
            setDecisionNote('');
          }}
          className="bg-muted text-foreground hover:bg-muted/80"
        >
          بازگرداندن برای اصلاح
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4 flex w-full max-w-lg flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (requiresReason && decisionNote.trim() === '') return;
        onDecide(act);
      }}
    >
      <Textarea
        id={`hr-mission-approval-reason-${missionRequestId}`}
        name={`approvalReason-${missionRequestId}`}
        // The label states WHOSE note this is, so it can never read as the employee's own
        // description or as a reason already recorded on the request.
        label={act === 'reject' ? 'دلیل رد (الزامی)' : 'دلیل بازگرداندن (الزامی)'}
        value={decisionNote}
        rows={3}
        maxLength={REASON_MAX_LENGTH}
        onChange={(event) => setDecisionNote(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          data-testid={`hr-mission-approval-${act}-submit-${missionRequestId}`}
          // The API refuses a blank rejection or correction, so this button refuses to send one:
          // the server's rule is stated here rather than learned from a 400.
          disabled={isDeciding || (requiresReason && decisionNote.trim() === '')}
        >
          {act === 'reject' ? 'ثبت رد' : 'ثبت بازگشت'}
        </Button>
        <Button
          type="button"
          data-testid={`hr-mission-approval-${act}-dismiss-${missionRequestId}`}
          onClick={() => {
            setAct(null);
            setDecisionNote('');
          }}
          className="bg-muted text-foreground hover:bg-muted/80"
        >
          انصراف
        </Button>
      </div>
    </form>
  );
}
