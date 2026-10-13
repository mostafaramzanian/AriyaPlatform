'use client';

import * as React from 'react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fetchHrEmployees, HR_MAX_PAGE_SIZE, hrDisplayName } from '@/lib/hr-api';
import {
  cancelMission,
  createMission,
  fetchMission,
  fetchMissionOptionGroups,
  fetchMissions,
  resubmitMission,
  submitMission,
  submitMissionReport,
  updateMission,
  type HrMissionOptionGroup,
  type HrMissionOptionSelection,
  type HrMissionRequest,
  type HrMissionRequestStatus,
} from '@/lib/hr-mission-api';
import {
  correctionReasonFor,
  canCancelMission,
  canEditMission,
  canResubmitMission,
  canSubmitMission,
  canSubmitMissionReport,
  rejectionReasonFor,
} from '@/lib/hr-mission-eligibility';
import {
  missionDayLabel,
  missionDurationLabel,
  missionEngagementLabel,
  missionLocationLabel,
  missionRangeLabel,
  missionRequestStatusLabel,
  missionRequestStatusTone,
  missionTimeRangeLabel,
} from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrField, HrNotice, HrPageHeading } from './hr-ui';

/**
 * Phase 55 Step 8B: the EMPLOYEE Mission surface â€” register, detail, and the employee's own acts.
 *
 * WHAT THIS SCREEN IS, AND WHAT IT IS NOT
 * --------------------------------------
 * It is the REQUEST-FACING surface: what was asked for, where it stands, why it came back, and the
 * four acts the employee owns (create, edit, submit/resubmit, withdraw) plus the mission report.
 * The manager's decision surface and the administrator's configuration surface are NOT here â€” they
 * are separate grants over separate objects, and a screen that offered them would be offering
 * controls whose calls it cannot make.
 *
 * THE SERVER OWNS EVERY AUTHORITY ANSWER. Nothing below resolves an approver, derives a route,
 * decides self-approval legality, predicts an active step or computes decisionability. Where the
 * screen needs to know whether an act is possible it reads a predicate in
 * `hr-mission-eligibility.ts`, each of which names the one service check it mirrors â€” and, for the
 * approval flow, it renders `instance.canDecide` / per-step `decidableByActor` exactly as received.
 *
 * THE CLASSIFICATION IS READ, NOT DERIVED. `durationMode`, `locationType` and `engagementType`
 * arrive on the response as the server's own reading of the saved selections, so this screen never
 * reconstructs them from option codes. «پروژه‌ای» is a LABEL for project work: Phase 55 configures no
 * project linkage, so there is deliberately no project picker, no project id and no project endpoint
 * anywhere on this surface.
 *
 * NO `COMPLETED`. The status vocabulary is the domain's seven members; a mission ends at APPROVED,
 * REJECTED or CANCELLED.
 */

/** The two grants this surface answers to, named once. */
const MISSION_READ = 'hr.mission.read';
const MISSION_MANAGE = 'hr.mission.manage';

/** Mirrors `HR_MAX_PAGE_SIZE`: the ceiling the register reads its catalogue with. */
const CATALOGUE_PAGE_SIZE = 100;

/** The API's own message when it gave one, and this screen's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/** `YYYY-MM-DD` and a real calendar day â€” the same shape the DTO's `HR_ISO_DATE_PATTERN` accepts. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:mm` â€” what the DTO's time pattern accepts, and what the server stores. */
const ISO_TIME = /^\d{2}:\d{2}$/;

/** The employee's own request draft, exactly the fields the employee authored. */
interface RequestDraft {
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  destination: string;
  description: string;
  /** `optionGroupId` â†’ the chosen `missionOptionId`. One choice per group, by construction. */
  selections: Record<string, string>;
}

const EMPTY_DRAFT: RequestDraft = {
  startDate: '',
  endDate: '',
  startTime: '',
  endTime: '',
  destination: '',
  description: '',
  selections: {},
};

/** The draft's selections as the DTO's array, in a STABLE group order. */
function toSelections(
  draft: RequestDraft,
  groups: HrMissionOptionGroup[]
): HrMissionOptionSelection[] {
  return groups
    .filter((group) => draft.selections[group.id])
    .map((group) => ({
      optionGroupId: group.id,
      missionOptionId: draft.selections[group.id],
    }));
}

/**
 * A saved request, loaded back into the form for EDIT or RESUBMIT.
 *
 * The selections come from the request's OWN `selections`, which the server already resolved, so the
 * form opens on what was recorded rather than on what the catalogue happens to offer today.
 */
function draftFromRequest(request: HrMissionRequest): RequestDraft {
  const selections: Record<string, string> = {};
  for (const selection of request.selections) {
    selections[selection.optionGroupId] = selection.missionOptionId;
  }
  return {
    startDate: request.startDate,
    endDate: request.endDate,
    startTime: request.startTime ?? '',
    endTime: request.endTime ?? '',
    destination: request.destination ?? '',
    description: request.description ?? '',
    selections,
  };
}

/**
 * THE REASON A REQUEST CAME BACK â€” or a refusal, never both, and never a substitute.
 *
 * `correctionReasonFor` / `rejectionReasonFor` return `null` unless the status is the one that owns
 * the column, so this component can render the ABSENCE as absence. There is no fallback sentence and
 * no borrowing of the other reason: a manager who said nothing must not appear to have said
 * something, and "fix this" must never be shown as "no".
 */
function DecisionReasonNotice({
  status,
  correctionReason,
  rejectionReason,
  requestId,
}: {
  status: HrMissionRequestStatus;
  correctionReason: string | null;
  rejectionReason: string | null;
  requestId: string;
}) {
  const correction = correctionReasonFor({ status, correctionReason });
  const rejection = rejectionReasonFor({ status, rejectionReason });

  if (correction !== null) {
    return (
      <div data-testid={`hr-mission-correction-reason-${requestId}`}>
        <HrNotice tone="error" message={correction} />
      </div>
    );
  }

  if (rejection !== null) {
    return (
      <div data-testid={`hr-mission-rejection-reason-${requestId}`}>
        <HrNotice tone="error" message={rejection} />
      </div>
    );
  }

  return null;
}

/** The read-only summary of a saved request: what was asked for, and how the server classified it. */
function RequestFacts({ request }: { request: HrMissionRequest }) {
  const timeRange = missionTimeRangeLabel(request.startTime, request.endTime);

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      <HrField label="Ù…Ø¯Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª">{missionDurationLabel(request.durationMode)}</HrField>
      <HrField label="Ù…Ø­Ù„ Ù…Ø§Ù…ÙˆØ±ÛŒØª">{missionLocationLabel(request.locationType)}</HrField>
      <HrField label="Ù†ÙˆØ¹ Ù‡Ù…Ú©Ø§Ø±ÛŒ">
        {missionEngagementLabel(request.engagementType)}
      </HrField>
      <HrField label="ØªØ§Ø±ÛŒØ® Ø´Ø±ÙˆØ¹">{missionDayLabel(request.startDate)}</HrField>
      <HrField label="ØªØ§Ø±ÛŒØ® Ù¾Ø§ÛŒØ§Ù†">{missionDayLabel(request.endDate)}</HrField>
      {/* The two stored days VERBATIM beside the Persian rendering â€” the range is INCLUSIVE, so a
          single-day mission legitimately repeats its day and hiding that would hide the contract. */}
      <HrField label="Ø¨Ø§Ø²Ù‡ (Ù…ÛŒÙ„Ø§Ø¯ÛŒ)">
        <span className="font-mono text-xs" data-testid={`hr-mission-range-${request.id}`}>
          {missionRangeLabel(request.startDate, request.endDate)}
        </span>
      </HrField>
      {/* Present only on an HOURLY mission: a DAILY one has no hours to render, and showing empty
          clock fields would imply they were lost rather than never applicable. */}
      {timeRange !== null && (
        <HrField label="Ø³Ø§Ø¹Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª">
          <span className="font-mono text-xs" data-testid={`hr-mission-time-${request.id}`}>
            {timeRange}
          </span>
        </HrField>
      )}
      <HrField label="Ù…Ù‚ØµØ¯">
        {request.destination ?? <span className="text-muted-foreground">â€”</span>}
      </HrField>
      <HrField label="Ø´Ø±Ø­ Ù…Ø§Ù…ÙˆØ±ÛŒØª">
        {request.description ?? <span className="text-muted-foreground">â€”</span>}
      </HrField>
    </dl>
  );
}

/**
 * ONE option group as a required single choice.
 *
 * EVERY group is rendered the way the catalogue declares it: one choice, never several, and an
 * INACTIVE option is not selectable at all â€” a disabled `<option>` rather than one the server would
 * refuse after the employee had already submitted. Which groups exist, what they are called and which
 * are required all come from the catalogue, so nothing here hardcodes `DURATION` or `LOCATION`.
 */
function OptionGroupSelect({
  group,
  value,
  disabled,
  onChange,
}: {
  group: HrMissionOptionGroup;
  value: string;
  disabled: boolean;
  onChange: (missionOptionId: string) => void;
}) {
  const options: SelectOption[] = (group.options ?? [])
    .filter((option) => option.active)
    .map((option) => ({ value: option.id, label: option.label }));

  return (
    <Select
      id={`hr-mission-group-${group.id}`}
      name={`missionGroup-${group.id}`}
      label={group.required ? `${group.label} (Ø§Ù„Ø²Ø§Ù…ÛŒ)` : group.label}
      options={options}
      value={value}
      disabled={disabled}
      data-testid={`hr-mission-group-${group.id}`}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * THE REQUEST FORM â€” create, edit and resubmit, in one component.
 *
 * WHY ONE FORM FOR THREE ACTS. All three author the same fields; what differs is which ROUTE is
 * called and whether the request already exists. Three copies of this layout would be three places to
 * change when a field is added, and the three would drift â€” so the act is a PROP and the layout is
 * written once.
 *
 * WHAT THE FORM DOES NOT DECIDE. It does not derive `durationMode`, `locationType` or
 * `engagementType`: those are the server's reading of the `selections` this form collects, so the
 * classifications appear only in the read-only summary of a SAVED request. It also does not offer a
 * project picker when the engagement is project work â€” Phase 55 links no project.
 */
function RequestForm({
  draft,
  groups,
  submitLabel,
  isBusy,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  draft: RequestDraft;
  groups: HrMissionOptionGroup[];
  submitLabel: string;
  isBusy: boolean;
  busyLabel: string;
  onSubmit: (draft: RequestDraft) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = React.useState<RequestDraft>(draft);

  // Re-opening the form on a different request must not keep the previous request's answers in the
  // fields: the draft IS the identity of what is being edited. Applied during
  // render, guarded by the previous draft — never as an effect-body setter
  // (`react-hooks/set-state-in-effect`). Mount is a no-op (identity equal).
  const [prevDraft, setPrevDraft] = React.useState(draft);
  if (prevDraft !== draft) {
    setPrevDraft(draft);
    setForm(draft);
  }

  const set = <K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const requiredGroups = groups.filter((group) => group.required);
  const missingGroups = requiredGroups.filter((group) => !form.selections[group.id]);
  const hasStart = ISO_DAY.test(form.startDate);
  const hasEnd = ISO_DAY.test(form.endDate);

  /**
   * The date rule mirroring `validateMissionDateTime`, expressed for IMMEDIATE feedback only.
   *
   * The server re-validates and remains the authority â€” this exists so an employee learns about a
   * cross-midnight hourly mission in the form rather than through a `400`. The MODE comes from the
   * `DURATION` group's own selection, which is the same source the server reads it from; when the
   * catalogue has no duration group, or none is chosen yet, NO date rule is applied here rather than
   * one being guessed.
   */
  const durationGroup = groups.find((group) => group.code === 'DURATION');
  const chosenDuration = durationGroup
    ? (durationGroup.options ?? []).find(
        (option) => option.id === form.selections[durationGroup.id]
      )?.code
    : undefined;
  const isHourly = chosenDuration === 'HOURLY';

  let dateIssue: string | null = null;
  if (hasStart && hasEnd) {
    if (isHourly) {
      // An HOURLY mission is ONE day: the server refuses a range, so the form states the same rule
      // and keeps `endDate` pinned to `startDate` rather than letting a second day be chosen.
      if (form.startDate !== form.endDate) {
        dateIssue =
          'Ø¨Ø±Ø§ÛŒ Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø³Ø§Ø¹ØªÛŒØŒ ØªØ§Ø±ÛŒØ® Ø´Ø±ÙˆØ¹ Ùˆ Ù¾Ø§ÛŒØ§Ù† Ø¨Ø§ÛŒØ¯ ÛŒÚ© Ø±ÙˆØ² Ø¨Ø§Ø´Ø¯.';
      } else if (!ISO_TIME.test(form.startTime) || !ISO_TIME.test(form.endTime)) {
        dateIssue =
          'Ø¨Ø±Ø§ÛŒ Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø³Ø§Ø¹ØªÛŒØŒ Ø³Ø§Ø¹Øª Ø´Ø±ÙˆØ¹ Ùˆ Ù¾Ø§ÛŒØ§Ù† Ù„Ø§Ø²Ù… Ø§Ø³Øª.';
      } else if (form.startTime >= form.endTime) {
        dateIssue = 'Ø³Ø§Ø¹Øª Ù¾Ø§ÛŒØ§Ù† Ø¨Ø§ÛŒØ¯ Ø¨Ø¹Ø¯ Ø§Ø² Ø³Ø§Ø¹Øª Ø´Ø±ÙˆØ¹ Ø¨Ø§Ø´Ø¯.';
      }
    } else if (form.endDate < form.startDate) {
      dateIssue =
        'ØªØ§Ø±ÛŒØ® Ù¾Ø§ÛŒØ§Ù† Ù†Ù…ÛŒâ€ŒØªÙˆØ§Ù†Ø¯ Ù‚Ø¨Ù„ Ø§Ø² ØªØ§Ø±ÛŒØ® Ø´Ø±ÙˆØ¹ Ø¨Ø§Ø´Ø¯.';
    }
  }

  const canSubmit =
    hasStart && hasEnd && missingGroups.length === 0 && dateIssue === null && !isBusy;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(form);
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex flex-wrap gap-4">
        <Input
          id="hr-mission-start-date"
          name="startDate"
          label="ØªØ§Ø±ÛŒØ® Ø´Ø±ÙˆØ¹"
          type="date"
          value={form.startDate}
          disabled={isBusy}
          onChange={(event) => {
            const value = event.target.value;
            // Starting an HOURLY mission moves `endDate` with it â€” the same-day rule is the
            // server's, and letting the form hold a different day would only produce a refusal.
            setForm((prev) => ({
              ...prev,
              startDate: value,
              endDate: prev.endDate === '' || isHourly ? value : prev.endDate,
            }));
          }}
        />
        <Input
          id="hr-mission-end-date"
          name="endDate"
          label="ØªØ§Ø±ÛŒØ® Ù¾Ø§ÛŒØ§Ù†"
          type="date"
          value={form.endDate}
          disabled={isBusy || isHourly}
          onChange={(event) => set('endDate', event.target.value)}
        />
        {isHourly && (
          <>
            <Input
              id="hr-mission-start-time"
              name="startTime"
              label="Ø³Ø§Ø¹Øª Ø´Ø±ÙˆØ¹"
              type="time"
              value={form.startTime}
              disabled={isBusy}
              onChange={(event) => set('startTime', event.target.value)}
            />
            <Input
              id="hr-mission-end-time"
              name="endTime"
              label="Ø³Ø§Ø¹Øª Ù¾Ø§ÛŒØ§Ù†"
              type="time"
              value={form.endTime}
              disabled={isBusy}
              onChange={(event) => set('endTime', event.target.value)}
            />
          </>
        )}
      </div>

      {/* The catalogue's own groups, in the order the server returned them. A REQUIRED group with no
          choice blocks submission â€” the same rule the server enforces, stated before the request is
          sent rather than learned from a refusal. */}
      <div className="flex flex-wrap gap-4">
        {groups.map((group) => (
          <OptionGroupSelect
            key={group.id}
            group={group}
            value={form.selections[group.id] ?? ''}
            disabled={isBusy}
            onChange={(missionOptionId) =>
              set('selections', { ...form.selections, [group.id]: missionOptionId })
            }
          />
        ))}
      </div>

      <Input
        id="hr-mission-destination"
        name="destination"
        label="Ù…Ù‚ØµØ¯"
        value={form.destination}
        disabled={isBusy}
        onChange={(event) => set('destination', event.target.value)}
      />
      <Textarea
        id="hr-mission-description"
        name="description"
        label="Ø´Ø±Ø­ Ù…Ø§Ù…ÙˆØ±ÛŒØª"
        rows={3}
        value={form.description}
        disabled={isBusy}
        onChange={(event) => set('description', event.target.value)}
      />

      {dateIssue !== null && (
        <p className="text-xs text-destructive" data-testid="hr-mission-date-issue">
          {dateIssue}
        </p>
      )}
      {missingGroups.length > 0 && (
        <p className="text-xs text-destructive" data-testid="hr-mission-group-issue">
          Ø§Ù†ØªØ®Ø§Ø¨ Ù…ÙˆØ§Ø±Ø¯ Ø§Ù„Ø²Ø§Ù…ÛŒ Ù…Ø§Ù†Ø¯Ù‡ Ø§Ø³Øª:{' '}
          {missingGroups.map((group) => group.label).join('ØŒ ')}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-testid="hr-mission-form-submit" disabled={!canSubmit}>
          {isBusy ? busyLabel : submitLabel}
        </Button>
        {onCancel && (
          <Button
            type="button"
            data-testid="hr-mission-form-cancel"
            disabled={isBusy}
            onClick={onCancel}
            className="bg-muted text-foreground hover:bg-muted/80"
          >
            Ø§Ù†ØµØ±Ø§Ù
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * ONE REQUEST'S DETAIL â€” the read half of the surface, and the half the employee acts FROM.
 *
 * THE ORDER IS DELIBERATE: the DECISION REASON comes first, above the facts. On a returned or
 * refused request that reason is the single most important thing on the screen, and burying it under
 * the destination would make the employee hunt for it. Everything below is the immutable record.
 *
 * THE ACTS ARE GATED BY THE ELIGIBILITY PREDICATES, never by a status test written inline: each
 * predicate names the one service check it mirrors, so this component cannot develop a fourth opinion
 * about when a request may be submitted.
 */
function MissionDetail({
  request,
  isBusy,
  isReportBusy,
  canManage,
  reportContent,
  onReportContent,
  onEdit,
  onSubmit,
  onResubmit,
  onCancel,
  onReport,
}: {
  request: HrMissionRequest;
  isBusy: boolean;
  isReportBusy: boolean;
  /**
   * The write grant. Status eligibility and authority are DIFFERENT questions, and a control is
   * offered only when both answers are yes: a status-eligible request still belongs to someone else
   * if the actor holds no `hr.mission.manage`, and offering the button would offer a call this
   * screen cannot make.
   */
  canManage: boolean;
  reportContent: string;
  onReportContent: (value: string) => void;
  onEdit: () => void;
  onSubmit: () => void;
  onResubmit: () => void;
  onCancel: () => void;
  onReport: () => void;
}) {
  const reportable = canSubmitMissionReport(request.status);

  return (
    <HrCard className="mt-4" testId={`hr-mission-detail-${request.id}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <HrBadge
          tone={missionRequestStatusTone(request.status)}
          testId={`hr-mission-status-${request.id}`}
        >
          {missionRequestStatusLabel(request.status)}
        </HrBadge>
        {request.employee !== null && (
          <span className="font-mono text-xs text-muted-foreground">
            {request.employee.employeeCode}
          </span>
        )}
      </div>

      {/* THE REASON THE EMPLOYEE MUST ACT ON, above everything else it applies to. */}
      <div className="mb-4">
        <DecisionReasonNotice
          status={request.status}
          correctionReason={request.correctionReason}
          rejectionReason={request.rejectionReason}
          requestId={request.id}
        />
      </div>

      <RequestFacts request={request} />

      {/* The flow SUMMARY the detail read carries â€” an object, not an approval. The status beside it
          is the REQUEST's, because whether the mission stands is `status` and not the instance. */}
      {request.approval != null && (
        <p
          className="mt-4 text-xs text-muted-foreground"
          data-testid={`hr-mission-flow-${request.id}`}
        >
          Ú¯Ø±Ø¯Ø´ ØªØ£ÛŒÛŒØ¯ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¨Ø§Ø² Ø´Ø¯Ù‡ Ø§Ø³Øª.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {canManage && canEditMission(request.status) && (
          <Button
            type="button"
            data-testid={`hr-mission-edit-${request.id}`}
            disabled={isBusy}
            onClick={onEdit}
            className="bg-muted text-foreground hover:bg-muted/80"
          >
            ÙˆÛŒØ±Ø§ÛŒØ´
          </Button>
        )}
        {canManage && canSubmitMission(request.status) && (
          <Button
            type="button"
            data-testid={`hr-mission-submit-${request.id}`}
            disabled={isBusy}
            onClick={onSubmit}
          >
            Ø§Ø±Ø³Ø§Ù„ Ø¨Ø±Ø§ÛŒ ØªØ£ÛŒÛŒØ¯
          </Button>
        )}
        {canManage && canResubmitMission(request.status) && (
          <Button
            type="button"
            data-testid={`hr-mission-resubmit-${request.id}`}
            disabled={isBusy}
            onClick={onResubmit}
          >
            ÙˆÛŒØ±Ø§ÛŒØ´ Ùˆ Ø§Ø±Ø³Ø§Ù„ Ø¯ÙˆØ¨Ø§Ø±Ù‡
          </Button>
        )}
        {canManage && canCancelMission(request.status) && (
          <Button
            type="button"
            data-testid={`hr-mission-cancel-${request.id}`}
            disabled={isBusy}
            onClick={onCancel}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Ù„ØºÙˆ Ø¯Ø±Ø®ÙˆØ§Ø³Øª
          </Button>
        )}
      </div>

      {/* THE REPORT, offered only where the server accepts one: `submitReport` refuses anything that
          is not APPROVED. There is no report LIST here, because the backend exposes creation and no
          employee-readable read â€” inventing a history would be inventing a contract. */}
      {canManage && reportable && (
        <div className="mt-4 flex flex-col gap-3">
          <Textarea
            id={`hr-mission-report-${request.id}`}
            name={`missionReport-${request.id}`}
            label="Ú¯Ø²Ø§Ø±Ø´ Ù…Ø§Ù…ÙˆØ±ÛŒØª"
            rows={3}
            value={reportContent}
            disabled={isReportBusy}
            onChange={(event) => onReportContent(event.target.value)}
          />
          <div>
            <Button
              type="button"
              data-testid={`hr-mission-report-submit-${request.id}`}
              // The API refuses an empty report (`MinLength(1)`), so this refuses to send one.
              disabled={isReportBusy || reportContent.trim() === ''}
              onClick={onReport}
            >
              Ø«Ø¨Øª Ú¯Ø²Ø§Ø±Ø´
            </Button>
          </div>
        </div>
      )}
    </HrCard>
  );
}

/**
 * THE EMPLOYEE MISSION SCREEN.
 *
 * TWO READS, TWO GRANTS. The register answers to `hr.mission.read`; every write answers to
 * `hr.mission.manage`. The catalogue is read with the REGISTER's grant and its own failure is
 * tolerated â€” without options nothing can be CREATED, but the existing requests are still perfectly
 * readable, so a catalogue refusal must not blank the screen. That is why the two reads are separate
 * effects with separate failure flags rather than one combined "page state".
 */
export function HrMissionView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);

  const canRead = permissions.includes(MISSION_READ);
  const canManage = permissions.includes(MISSION_MANAGE);
  // The directory grant, needed ONLY for the "who is this for" picker on the create form. Absent, the
  // register and every existing request are unaffected â€” only creating is unavailable, which is
  // honest rather than a picker that would 403.
  const canReadEmployees = permissions.includes('hr.employees.read');

  const [items, setItems] = React.useState<HrMissionRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the register's refresh handler
  // (same commit as the token bump), so the register effect needs no in-effect
  // setter resets. The detail effect below stays untouched — its own arming
  // moved into the selection/decision handlers. First mount is covered by the
  // initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);

  /** The register is RE-READ rather than patched: it is the server's list, and a locally edited row
   *  would briefly show a state the server had not confirmed. When a detail is
   *  open, its read is re-armed in the same commit (the removed in-effect arm
   *  used to run one render later).
   */
  const refresh = () => {
    reloadList();
    setStatus(null);
    // The catalogue read re-arms off the same token: clearing its failure flag
    // here is what the removed in-effect setter did on every refetch.
    setCatalogueFailed(false);
    if (selectedId !== null) {
      setDetailLoading(true);
      setDetailError(null);
    }
  };

  const [groups, setGroups] = React.useState<HrMissionOptionGroup[]>([]);
  const [isCatalogueFailed, setCatalogueFailed] = React.useState(false);

  /**
   * WHO THE MISSION IS FOR.
   *
   * `CreateMissionRequestDto.employeeId` is REQUIRED, and this screen cannot derive it: the register
   * says which employee a request belongs to, but nothing on this surface resolves the CALLER's own
   * personnel record â€” `hr.mission.read` does not imply `hr.employees.read`, and inferring identity
   * from the session is exactly what the brief forbids. So the employee chooses, from the directory
   * the SAME way `HrLeaveView` does, and the server validates tenancy when the request is made.
   */
  const [employeeId, setEmployeeId] = React.useState('');
  const [employees, setEmployees] = React.useState<SelectOption[]>([]);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<HrMissionRequest | null>(null);
  const [isDetailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  // Selection changes reset/arm the detail read synchronously during render,
  // guarded by the previous id — never in the effect body
  // (`react-hooks/set-state-in-effect`): closing clears the row, opening arms
  // the skeleton. Mount (null → null) is a no-op.
  const [prevSelectedId, setPrevSelectedId] = React.useState(selectedId);
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    if (selectedId === null) {
      setSelected(null);
    } else {
      setDetailLoading(true);
      setDetailError(null);
    }
  }

  /** Which act the open form is performing, and for which request. */
  const [formMode, setFormMode] = React.useState<'create' | 'edit' | 'resubmit' | null>(null);
  const [formDraft, setFormDraft] = React.useState<RequestDraft>(EMPTY_DRAFT);
  const [isSubmitting, setSubmitting] = React.useState(false);
  const [isBusy, setBusy] = React.useState(false);
  const [isReporting, setReporting] = React.useState(false);
  const [reportContent, setReportContent] = React.useState('');
  /** The withdrawal form's own open state and required reason. */
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState('');
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; message: string } | null>(
    null
  );

  // The register. One request per (page, pageSize, reload) â€” the effective page facts come BACK from
  // the server, so a clamped page size is reported rather than assumed.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchMissions({ page, pageSize })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setPage(result.page);
        setPageSize(result.pageSize);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setItems([]);
        setTotal(0);
        setError(
          describe(err, 'Ø¯Ø±ÛŒØ§ÙØª ÙÙ‡Ø±Ø³Øª Ù…Ø§Ù…ÙˆØ±ÛŒØªâ€ŒÙ‡Ø§ Ø¨Ø§ Ø®Ø·Ø§ Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.')
        );
        setStatus(err instanceof CoreApiError ? err.status : null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, page, pageSize, reloadToken]);

  // The catalogue. Read once with the register's grant; a failure degrades to "no form", not to a
  // blank register, because the two reads answer different questions.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    fetchMissionOptionGroups({ active: true, pageSize: CATALOGUE_PAGE_SIZE })
      .then((result) => {
        if (active) setGroups(result.items);
      })
      .catch(() => {
        if (!active) return;
        setGroups([]);
        setCatalogueFailed(true);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, reloadToken]);

  // The personnel directory, for the create form's person picker ONLY. Its failure degrades to "no
  // create form" rather than to an error: every existing request is still readable, and a picker that
  // 403s would be worse than one that is simply absent. Gated on the directory grant as well, so this
  // never performs a tenant-wide read to render nothing.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead || !canReadEmployees) return;

    let active = true;

    fetchHrEmployees({ pageSize: HR_MAX_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setEmployees(
          result.items.map((employee) => ({
            value: employee.id,
            label: `${employee.employeeCode} — ${hrDisplayName(
              employee.identity,
              employee.employeeCode
            )}`,
          }))
        );
      })
      .catch(() => {
        if (active) setEmployees([]);
      });

    return () => {
      active = false;
    };
  }, [isPermissionsLoading, canRead, canReadEmployees]);

  // The selected request's own read. Fetched on selection, so opening one row is one request rather
  // than a read of every row the register returned.
  React.useEffect(() => {
    if (selectedId === null) return;

    let active = true;

    fetchMission(selectedId)
      .then((request) => {
        if (active) setSelected(request);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setSelected(null);
        setDetailError(
          describe(err, 'Ø¯Ø±ÛŒØ§ÙØª Ø¬Ø²Ø¦ÛŒØ§Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø¨Ø§ Ø®Ø·Ø§ Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.')
        );
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedId, reloadToken]);

  const openCreate = () => {
    if (!canManage) return;
    setFormDraft(EMPTY_DRAFT);
    setFormMode('create');
    setNotice(null);
  };

  const openEdit = () => {
    if (!canManage || selected === null) return;
    setFormDraft(draftFromRequest(selected));
    setFormMode('edit');
    setNotice(null);
  };

  const openResubmit = () => {
    if (!canManage || selected === null) return;
    setFormDraft(draftFromRequest(selected));
    setFormMode('resubmit');
    setNotice(null);
  };

  /**
   * CREATE. The body carries the employee the mission is FOR and the authored fields â€” nothing else.
   * There is no `tenantId`, no `actorId`, no `approverId`, no `projectId` and no status: the actor is
   * derived server-side, the initial status is a domain constant, and the classification is the
   * server's own reading of `selections`.
   *
   * WHO THE REQUEST IS FOR is the EMPLOYEE'S OWN RECORD, and that is the one thing this screen
   * cannot read for itself: the register tells us which employee a request belongs to, but nothing
   * here resolves the CALLER's own personnel record. So the employee picks the person the mission is
   * for from the employee directory â€” the same shape `HrLeaveView` uses â€” and the server validates
   * that the id belongs to the caller's tenant.
   */
  const submitCreate = async (draft: RequestDraft) => {
    if (!canManage || isSubmitting) return;

    setSubmitting(true);
    setNotice(null);

    try {
      const created = await createMission({
        employeeId: employeeId,
        startDate: draft.startDate,
        endDate: draft.endDate,
        ...(draft.startTime ? { startTime: draft.startTime } : {}),
        ...(draft.endTime ? { endTime: draft.endTime } : {}),
        ...(draft.destination ? { destination: draft.destination } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        selections: toSelections(draft, groups),
      });

      setFormMode(null);
      setNotice({ tone: 'ok', message: 'Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø«Ø¨Øª Ø´Ø¯.' });
      setSelectedId(created.id);
      refresh();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'Ø«Ø¨Øª Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø¨Ø§ Ø®Ø·Ø§ Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  /** CANCEL â€” the reason is the DTO's required field, audited rather than stored on the request. */
  const cancelNow = async () => {
    if (!canManage || selected === null || isBusy) return;
    if (cancelReason.trim() === '') return;

    setBusy(true);
    setNotice(null);

    try {
      await cancelMission(selected.id, { reason: cancelReason.trim() });
      setCancelReason('');
      setCancelling(false);
      setNotice({ tone: 'ok', message: 'Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª Ù„ØºÙˆ Ø´Ø¯.' });
      refresh();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'Ù„ØºÙˆ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø¨Ø§ Ø®Ø·Ø§ Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.'),
      });
    } finally {
      setBusy(false);
    }
  };

  /** The mission report â€” content and nothing else. The server accepts it only for an APPROVED
   *  mission, and its refusal arrives as a `409` this screen shows rather than pre-empts. */
  const reportNow = async () => {
    if (!canManage || selected === null || isReporting) return;
    if (reportContent.trim() === '') return;

    setReporting(true);
    setNotice(null);

    try {
      await submitMissionReport(selected.id, { content: reportContent.trim() });
      setReportContent('');
      setNotice({ tone: 'ok', message: 'Ú¯Ø²Ø§Ø±Ø´ Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø«Ø¨Øª Ø´Ø¯.' });
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'Ø«Ø¨Øª Ú¯Ø²Ø§Ø±Ø´ Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø¨Ø§ Ø®Ø·Ø§ Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.'),
      });
    } finally {
      setReporting(false);
    }
  };

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  /** EDIT — `PATCH`, sending only the fields the employee authored. */
  const submitEdit = async (draft: RequestDraft) => {
    if (!canManage || selected === null || isSubmitting) return;

    setSubmitting(true);
    setNotice(null);

    try {
      await updateMission(selected.id, {
        startDate: draft.startDate,
        endDate: draft.endDate,
        ...(draft.startTime ? { startTime: draft.startTime } : {}),
        ...(draft.endTime ? { endTime: draft.endTime } : {}),
        ...(draft.destination ? { destination: draft.destination } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        selections: toSelections(draft, groups),
      });

      setFormMode(null);
      setNotice({ tone: 'ok', message: 'درخواست ماموریت به‌روزرسانی شد.' });
      refresh();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'ویرایش درخواست ماموریت با خطا مواجه شد.'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * SUBMIT — bodyless, because the path names the request, the actor is the session and the routing
   * is the policy's decision. Nothing is sent, so nothing can be volunteered.
   */
  const submitNow = async () => {
    if (!canManage || selected === null || isBusy) return;

    setBusy(true);
    setNotice(null);

    try {
      await submitMission(selected.id);
      setNotice({ tone: 'ok', message: 'درخواست ماموریت برای تأیید ارسال شد.' });
      refresh();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'ارسال درخواست ماموریت با خطا مواجه شد.'),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * RESUBMIT — the corrected content and the act of sending it, in one call.
   *
   * `correctionReason` IS NOT SENT, and there is no field for it: the reason is the MANAGER's
   * statement about the previous revision, the employee cannot overwrite it, and the server records
   * the new revision's own submission. The screen keeps showing it until the resubmission lands.
   */
  const submitResubmit = async (draft: RequestDraft) => {
    if (!canManage || selected === null || isSubmitting) return;

    setSubmitting(true);
    setNotice(null);

    try {
      await resubmitMission(selected.id, {
        startDate: draft.startDate,
        endDate: draft.endDate,
        ...(draft.startTime ? { startTime: draft.startTime } : {}),
        ...(draft.endTime ? { endTime: draft.endTime } : {}),
        ...(draft.destination ? { destination: draft.destination } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        selections: toSelections(draft, groups),
      });

      setFormMode(null);
      setNotice({ tone: 'ok', message: 'درخواست اصلاح‌شده دوباره ارسال شد.' });
      refresh();
    } catch (err: unknown) {
      setNotice({
        tone: 'error',
        message: describe(err, 'ارسال دوباره درخواست با خطا مواجه شد.'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const table =
    error !== null && status === 403 ? (
      <CoreForbidden />
    ) : error !== null ? (
      <CoreError message={error} onRetry={refresh} />
    ) : isLoading ? (
      <CoreLoading lines={6} />
    ) : items.length === 0 ? (
      <CoreEmpty message="Ù‡Ù†ÙˆØ² Ù…Ø§Ù…ÙˆØ±ÛŒØªÛŒ Ø«Ø¨Øª Ù†Ø´Ø¯Ù‡ Ø§Ø³Øª." />
    ) : (
      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full min-w-[48rem] text-right" data-testid="hr-mission-table">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Ú©Ø§Ø±Ù…Ù†Ø¯</th>
              <th className="px-4 py-3 font-medium">Ø¨Ø§Ø²Ù‡ (Ù…ÛŒÙ„Ø§Ø¯ÛŒ)</th>
              <th className="px-4 py-3 font-medium">Ù…Ø¯Øª</th>
              <th className="px-4 py-3 font-medium">Ù…Ù‚ØµØ¯</th>
              <th className="px-4 py-3 font-medium">ÙˆØ¶Ø¹ÛŒØª</th>
              <th className="px-4 py-3 font-medium">Ø§Ù‚Ø¯Ø§Ù…</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr
                key={row.id}
                className="border-t border-border"
                data-testid={`hr-mission-row-${row.id}`}
              >
                <td className="px-4 py-3 text-sm">
                  {row.employee?.employeeCode ?? <span className="text-muted-foreground">â€”</span>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {missionRangeLabel(row.startDate, row.endDate)}
                </td>
                <td className="px-4 py-3 text-sm">{missionDurationLabel(row.durationMode)}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {row.destination ?? 'â€”'}
                </td>
                <td className="px-4 py-3 text-sm">
                  <HrBadge
                    tone={missionRequestStatusTone(row.status)}
                    testId={`hr-mission-status-${row.id}`}
                  >
                    {missionRequestStatusLabel(row.status)}
                  </HrBadge>
                </td>
                <td className="px-4 py-3 text-sm">
                  <Button
                    type="button"
                    data-testid={`hr-mission-open-${row.id}`}
                    onClick={() => {
                      setSelectedId(row.id);
                      setFormMode(null);
                      setCancelling(false);
                      setNotice(null);
                    }}
                    className="bg-muted text-foreground hover:bg-muted/80"
                  >
                    Ø¬Ø²Ø¦ÛŒØ§Øª
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return renderMissionView({
    canRead,
    canManage,
    canReadEmployees,
    isPermissionsLoading,
    groups,
    isCatalogueFailed,
    notice,
    formMode,
    employees,
    employeeId,
    setEmployeeId,
    formDraft,
    isSubmitting,
    openCreate,
    submitCreate,
    submitEdit,
    submitResubmit,
    setFormMode,
    table,
    total,
    page,
    setPage: (action: React.SetStateAction<number>) => {
      // Paging is always a NEW register read: re-arm in the same commit the
      // page moves (the buttons are disabled when it cannot).
      setLoading(true);
      setError(null);
      setStatus(null);
      setPage(action);
    },
    pageCount,
    isLoading,
    isDetailLoading,
    detailError,
    refresh,
    selected,
    isBusy,
    isReporting,
    reportContent,
    setReportContent,
    openEdit,
    submitNow,
    openResubmit,
    cancelling,
    setCancelling,
    cancelReason,
    setCancelReason,
    cancelNow,
    reportNow,
  });
}

/**
 * The view's own props, gathered so the render can live beside â€” rather than inside â€” the hundred
 * lines of state and handlers that produce them. Nothing here is derived from the request's status:
 * every flag is either a grant or an in-flight/failed read.
 */
interface MissionViewProps {
  canRead: boolean;
  canManage: boolean;
  canReadEmployees: boolean;
  isPermissionsLoading: boolean;
  groups: HrMissionOptionGroup[];
  isCatalogueFailed: boolean;
  notice: { tone: 'ok' | 'error'; message: string } | null;
  formMode: 'create' | 'edit' | 'resubmit' | null;
  employees: SelectOption[];
  employeeId: string;
  setEmployeeId: (value: string) => void;
  formDraft: RequestDraft;
  isSubmitting: boolean;
  openCreate: () => void;
  submitCreate: (draft: RequestDraft) => void;
  submitEdit: (draft: RequestDraft) => void;
  submitResubmit: (draft: RequestDraft) => void;
  setFormMode: (mode: 'create' | 'edit' | 'resubmit' | null) => void;
  table: React.ReactNode;
  total: number;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  pageCount: number;
  isLoading: boolean;
  isDetailLoading: boolean;
  detailError: string | null;
  refresh: () => void;
  selected: HrMissionRequest | null;
  isBusy: boolean;
  isReporting: boolean;
  reportContent: string;
  setReportContent: (value: string) => void;
  openEdit: () => void;
  submitNow: () => void;
  openResubmit: () => void;
  cancelling: boolean;
  setCancelling: (value: boolean) => void;
  cancelReason: string;
  setCancelReason: (value: string) => void;
  cancelNow: () => void;
  reportNow: () => void;
}

function renderMissionView(props: MissionViewProps): React.ReactElement {
  const {
    canRead,
    canManage,
    canReadEmployees,
    isPermissionsLoading,
    groups,
    isCatalogueFailed,
    notice,
    formMode,
    employees,
    employeeId,
    setEmployeeId,
    formDraft,
    isSubmitting,
    openCreate,
    submitCreate,
    submitEdit,
    submitResubmit,
    setFormMode,
    table,
    total,
    page,
    setPage,
    pageCount,
    isLoading,
    isDetailLoading,
    detailError,
    refresh,
    selected,
    isBusy,
    isReporting,
    reportContent,
    setReportContent,
    openEdit,
    submitNow,
    openResubmit,
    cancelling,
    setCancelling,
    cancelReason,
    setCancelReason,
    cancelNow,
    reportNow,
  } = props;

  if (isPermissionsLoading) return <CoreLoading lines={5} />;

  // The register's own grant. Without it every read on this screen refuses, so the refusal is stated
  // ONCE here rather than as four separate failures.
  if (!canRead) {
    return (
      <CoreForbidden message="Ø¨Ø±Ø§ÛŒ Ù…Ø´Ø§Ù‡Ø¯Ù‡ Ù…Ø§Ù…ÙˆØ±ÛŒØªâ€ŒÙ‡Ø§ Ø¨Ù‡ Ù…Ø¬ÙˆØ² hr.mission.read Ù†ÛŒØ§Ø² Ø¯Ø§Ø±ÛŒØ¯." />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <HrPageHeading
        title="Ù…Ø§Ù…ÙˆØ±ÛŒØªâ€ŒÙ‡Ø§"
        description="Ø«Ø¨Øª Ùˆ Ù¾ÛŒÚ¯ÛŒØ±ÛŒ Ù…Ø§Ù…ÙˆØ±ÛŒØªâ€ŒÙ‡Ø§ÛŒ Ø§Ø¯Ø§Ø±ÛŒ"
        actions={
          canManage && canReadEmployees && groups.length > 0 ? (
            <Button type="button" data-testid="hr-mission-create-open" onClick={openCreate}>
              Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø¬Ø¯ÛŒØ¯
            </Button>
          ) : undefined
        }
      />

      {notice !== null && <HrNotice tone={notice.tone} message={notice.message} />}

      {/* The catalogue could not be read: creating is impossible, and saying so is the honest
          response. The register below is unaffected, which is why this is a notice and not an error. */}
      {canManage && isCatalogueFailed && (
        <HrNotice
          tone="error"
          message="Ù¾ÛŒÚ©Ø±Ø¨Ù†Ø¯ÛŒ Ú¯Ø²ÛŒÙ†Ù‡â€ŒÙ‡Ø§ÛŒ Ù…Ø§Ù…ÙˆØ±ÛŒØª Ø®ÙˆØ§Ù†Ø¯Ù‡ Ù†Ø´Ø¯Ø› Ø«Ø¨Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª ØªØ§Ø²Ù‡ Ù…Ù…Ú©Ù† Ù†ÛŒØ³Øª."
        />
      )}

      {formMode === 'create' && (
        <HrCard testId="hr-mission-create-card">
          <div className="mb-4">
            <Select
              id="hr-mission-employee"
              name="employeeId"
              label="Ú©Ø§Ø±Ù…Ù†Ø¯"
              options={employees}
              value={employeeId}
              disabled={isSubmitting}
              onChange={(event) => setEmployeeId(event.target.value)}
            />
          </div>
          <RequestForm
            draft={formDraft}
            groups={groups}
            submitLabel="Ø«Ø¨Øª Ù…Ø§Ù…ÙˆØ±ÛŒØª"
            isBusy={isSubmitting || employeeId === ''}
            busyLabel="Ø¯Ø± Ø­Ø§Ù„ Ø«Ø¨Øª..."
            onSubmit={submitCreate}
            onCancel={() => setFormMode(null)}
          />
        </HrCard>
      )}

      <HrCard>{table}</HrCard>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-muted-foreground" data-testid="hr-mission-total">
          {/* The SERVER's total for the query â€” never a count of the rows on screen. */}
          {total.toLocaleString('fa-IR')} Ù…Ø§Ù…ÙˆØ±ÛŒØª
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="hr-mission-prev"
            disabled={page <= 1 || isLoading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
          >
            Ù‚Ø¨Ù„ÛŒ
          </Button>
          <span className="text-muted-foreground">
            ØµÙØ­Ù‡ {page.toLocaleString('fa-IR')} Ø§Ø² {pageCount.toLocaleString('fa-IR')}
          </span>
          <Button
            type="button"
            data-testid="hr-mission-next"
            disabled={page >= pageCount || isLoading}
            onClick={() => setPage((value) => value + 1)}
            className="bg-muted text-foreground hover:bg-muted/80 disabled:opacity-40"
          >
            Ø¨Ø¹Ø¯ÛŒ
          </Button>
        </div>
      </div>

      {isDetailLoading && <CoreLoading lines={5} />}
      {detailError !== null && <CoreError message={detailError} onRetry={refresh} />}

      {selected !== null && !isDetailLoading && (
        <>
          {formMode === 'edit' || formMode === 'resubmit' ? (
            <HrCard className="mt-4" testId={`hr-mission-form-${formMode}`}>
              <RequestForm
                draft={formDraft}
                groups={groups}
                submitLabel={
                  formMode === 'edit' ? 'Ø°Ø®ÛŒØ±Ù‡ ØªØºÛŒÛŒØ±Ø§Øª' : 'Ø§Ø±Ø³Ø§Ù„ Ø¯ÙˆØ¨Ø§Ø±Ù‡'
                }
                isBusy={isSubmitting}
                busyLabel="Ø¯Ø± Ø­Ø§Ù„ Ø§Ø±Ø³Ø§Ù„..."
                onSubmit={formMode === 'edit' ? submitEdit : submitResubmit}
                onCancel={() => setFormMode(null)}
              />
            </HrCard>
          ) : (
            <MissionDetail
              request={selected}
              isBusy={isBusy}
              isReportBusy={isReporting}
              canManage={canManage}
              reportContent={reportContent}
              onReportContent={setReportContent}
              onEdit={openEdit}
              onSubmit={submitNow}
              onResubmit={openResubmit}
              onCancel={() => {
                setCancelReason('');
                setCancelling(true);
              }}
              onReport={reportNow}
            />
          )}
        </>
      )}

      {/* THE WITHDRAWAL REASON â€” required by `CancelMissionRequestDto`, so the control refuses to send
          an empty one and no reason is ever manufactured on the employee's behalf. */}
      {selected !== null && cancelling && (
        <HrCard className="mt-4" testId={`hr-mission-cancel-form-${selected.id}`}>
          <Textarea
            id={`hr-mission-cancel-reason-${selected.id}`}
            name={`cancelReason-${selected.id}`}
            label="Ø¯Ù„ÛŒÙ„ Ù„ØºÙˆ (Ø§Ù„Ø²Ø§Ù…ÛŒ)"
            rows={3}
            value={cancelReason}
            disabled={isBusy}
            onChange={(event) => setCancelReason(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-cancel-submit-${selected.id}`}
              disabled={isBusy || cancelReason.trim() === ''}
              onClick={cancelNow}
            >
              Ø«Ø¨Øª Ù„ØºÙˆ
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-cancel-dismiss-${selected.id}`}
              disabled={isBusy}
              onClick={() => {
                setCancelling(false);
                setCancelReason('');
              }}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              Ø§Ù†ØµØ±Ø§Ù
            </Button>
          </div>
        </HrCard>
      )}
    </div>
  );
}

export default HrMissionView;
