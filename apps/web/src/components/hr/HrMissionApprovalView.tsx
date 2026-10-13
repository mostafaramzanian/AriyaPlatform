'use client';

import * as React from 'react';

import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { fetchPendingMissionApprovals, type HrMissionRequest } from '@/lib/hr-mission-api';
import {
  missionDurationLabel,
  missionRangeLabel,
  missionRequestStatusLabel,
  missionRequestStatusTone,
} from '@/lib/hr-mission-labels';
import { MissionApprovalPanel } from './MissionApprovalPanel';
import { HrBadge, HrCard, HrPageHeading } from './hr-ui';

/**
 * Phase 55 Step 8C: the MANAGER's Mission approval QUEUE (`/admin/hr/missions/approvals`).
 *
 * WHY THIS IS A QUEUE AND NOT A FILTERED REGISTER
 * ----------------------------------------------
 * `GET /hr/missions/approvals/pending` takes NO parameter and reads no query: the server resolves
 * the rows from the AUTHENTICATED ACTOR and returns exactly the requests whose active step is this
 * person's. That is not a search an operator narrows — it is a list of things waiting on them — so
 * the screen has no employee picker, no status filter and no paging: it renders what the queue
 * returned, in the order the server gave it.
 *
 * The register at `/admin/hr/missions` answers the opposite question ("what missions exist?") under
 * `hr.mission.read`; this screen answers "what must I decide?" under `hr.mission.approve`. Two
 * questions, two grants, two reads — which is why they are two screens rather than one with a tab.
 *
 * ONE GRANT, ONE READ, AND NO REQUEST WITHOUT IT
 * ---------------------------------------------
 * Every route behind this screen — the queue and all three decision routes — answers to
 * `hr.mission.approve`, so a caller without it gets the refusal sentence and the client is never
 * asked for anything. The check is asserted as an ABSENT call, not merely a hidden control: a read
 * that would 403 is a request the grants do not cover.
 *
 * `hr.mission.read` IS DELIBERATELY NOT CONSULTED. Holding it would let the actor see the register,
 * which is a different surface; needing it here would make the approval grant alone insufficient to
 * do the job it names. This screen shows ONLY the requests the server queued for this actor, so it
 * needs nothing beyond the grant that produced them.
 *
 * WHAT THIS SCREEN DOES NOT DECIDE. It does not compute whose turn it is, does not resolve
 * approvers, does not infer self-approval legality and does not predict which step is active. The
 * queue is the server's answer to "what is mine", and each row's flow is the server's answer to
 * "what does it look like" — both rendered as received (§3, §8).
 */

/** The ONE grant this surface answers to — the same one guarding the queue and every decision. */
const MISSION_APPROVE = 'hr.mission.approve';

/** The API's own message when it gave one, and this screen's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * ONE queue row, plus the flow it can expand into.
 *
 * The flow is NOT read with the queue: `GET :id/approval` resolves the live instance, its steps and
 * a decisionability answer per step, which is a second, more expensive read nobody needs for the
 * rows they never open. Opening is the intent, so it is mounted on demand and its state disappears
 * with the row — the same choice `LeaveRequestRow` made in 54-J.
 */
function MissionApprovalQueueRow({
  row,
  canApprove,
  onDecided,
}: {
  row: HrMissionRequest;
  canApprove: boolean;
  onDecided: () => void;
}) {
  const [isFlowOpen, setFlowOpen] = React.useState(false);

  return (
    <>
      <tr className="border-t border-border" data-testid={`hr-mission-approval-row-${row.id}`}>
        <td className="px-4 py-3 text-sm">
          <span className="font-mono text-xs" data-testid={`hr-mission-approval-code-${row.id}`}>
            {row.employee?.employeeCode ?? '—'}
          </span>
        </td>
        <td
          className="px-4 py-3 font-mono text-xs text-muted-foreground"
          data-testid={`hr-mission-approval-row-range-${row.id}`}
        >
          {missionRangeLabel(row.startDate, row.endDate)}
        </td>
        <td className="px-4 py-3 text-sm">{missionDurationLabel(row.durationMode)}</td>
        <td className="px-4 py-3 text-sm text-muted-foreground">{row.destination ?? '—'}</td>
        <td className="px-4 py-3 text-sm">
          <HrBadge
            tone={missionRequestStatusTone(row.status)}
            testId={`hr-mission-approval-row-status-${row.id}`}
          >
            {missionRequestStatusLabel(row.status)}
          </HrBadge>
        </td>
        <td className="px-4 py-3 text-sm">
          <Button
            type="button"
            data-testid={`hr-mission-approval-toggle-${row.id}`}
            aria-expanded={isFlowOpen}
            onClick={() => setFlowOpen((open) => !open)}
            className="bg-muted text-foreground hover:bg-muted/80"
          >
            {isFlowOpen ? 'بستن گردش تأیید' : 'گردش تأیید'}
          </Button>
        </td>
      </tr>

      {/* The flow, expanded IN PLACE and only when asked for. It spans the full width because it is a
          detail OF the row above rather than another column of the queue. */}
      {isFlowOpen && (
        <tr className="border-t-0">
          <td colSpan={6} className="px-4 pb-4">
            <MissionApprovalPanel
              missionRequestId={row.id}
              canApprove={canApprove}
              onDecided={onDecided}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * THE MANAGER APPROVAL SCREEN.
 *
 * ONE READ, ONE GRANT. The queue answers to `hr.mission.approve` and nothing else, so there is no
 * second read whose failure has to be tolerated and no degradation path to design: without the grant
 * the screen refuses and issues nothing, and with it the queue is the only thing it fetches.
 */
export function HrMissionApprovalView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canApprove = permissions.includes(MISSION_APPROVE);

  const [items, setItems] = React.useState<HrMissionRequest[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry/decision handlers (same commit as the
  // token bump), so the queue effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: refresh } = useReloadToken(setLoading, setError);

  // The queue. Read only once the grant is known to be held, so a 403 is never requested.
  React.useEffect(() => {
    if (isPermissionsLoading || !canApprove) return;

    let active = true;

    fetchPendingMissionApprovals()
      .then((result) => {
        if (!active) return;
        setItems(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setItems([]);
        setError(describe(err, 'دریافت صف تأیید ماموریت‌ها با خطا مواجه شد.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canApprove, reloadToken]);

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  // The screen's own grant. Without it BOTH the queue and every decision refuse, so the refusal is
  // stated ONCE here — and, crucially, no request is issued: a read that would 403 is a request the
  // grants do not cover, and the queue is a `hr.mission.approve` read.
  if (!canApprove) {
    return (
      <CoreForbidden message="برای مشاهدهٔ صف تأیید ماموریت‌ها به مجوز hr.mission.approve نیاز دارید." />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <HrPageHeading
        title="تأیید ماموریت‌ها"
        description="درخواست‌های ماموریتی که مرحلهٔ جاری آن‌ها در نوبت تصمیم شماست"
      />

      {/* NO TOTAL AND NO PAGINATION, deliberately. The endpoint returns a bare array — the queue IS
          the whole set waiting on this actor — so a count over it would be a count over the complete
          answer, and page controls would offer navigation the route does not implement. */}
      <HrCard>
        {error !== null ? (
          <CoreError message={error} onRetry={refresh} />
        ) : isLoading ? (
          <CoreLoading lines={6} />
        ) : items.length === 0 ? (
          /* An EMPTY queue is the normal, healthy state — it is the absence of work, not a failure,
             and it is stated as such rather than as an error or an empty table. */
          <CoreEmpty message="در حال حاضر درخواست ماموریتی در نوبت تأیید شما نیست." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table
              className="w-full min-w-[48rem] text-right"
              data-testid="hr-mission-approval-queue"
            >
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">کارمند</th>
                  <th className="px-4 py-3 font-medium">بازه (میلادی)</th>
                  <th className="px-4 py-3 font-medium">ماهیت</th>
                  <th className="px-4 py-3 font-medium">مقصد</th>
                  <th className="px-4 py-3 font-medium">وضعیت</th>
                  <th className="px-4 py-3 font-medium">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <MissionApprovalQueueRow
                    key={row.id}
                    row={row}
                    canApprove={canApprove}
                    onDecided={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </HrCard>
    </div>
  );
}
