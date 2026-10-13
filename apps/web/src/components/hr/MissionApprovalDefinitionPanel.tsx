'use client';

import * as React from 'react';

import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  createMissionApprovalDefinition,
  fetchMissionApprovalDefinitions,
  replaceMissionApprovalDefinitionSteps,
  updateMissionApprovalDefinition,
  type CreateMissionApprovalDefinitionInput,
  type HrMissionApprovalDefinition,
  type HrMissionDefinitionStatus,
  type HrMissionRoutingMode,
  type MissionApprovalStepDefinitionInput,
  type UpdateMissionApprovalDefinitionInput,
} from '@/lib/hr-mission-api';
import {
  missionDefinitionStatusLabel,
  missionDefinitionStatusTone,
  missionRoutingModeLabel,
} from '@/lib/hr-mission-labels';
import { HrBadge, HrCard, HrNotice } from './hr-ui';

/**
 * Phase 55 Step 8D: DOMAIN 2 — Mission APPROVAL DEFINITION configuration (`hr.mission.policy`).
 *
 * A DEFINITION IS CONFIGURATION; IT IS NOT THE ENGINE. This panel authors a flow's name, routing
 * mode, self-approval mode, status and ordered steps, and it stops there. It does not compute whose
 * turn it is, does not resolve an approver, does not decide what `PARALLEL` means for completion and
 * does not predict which step is active. Those are `mission-approval.service.ts`'s answers, and a
 * client that derived them would be a second, weaker approval engine.
 *
 * STEPS ARE REPLACED, NOT PATCHED — AND THE UI SAYS SO
 * --------------------------------------------------
 * `replaceMissionApprovalDefinitionSteps` posts to `.../approval-definitions/:definitionId/steps`,
 * whose controller handler takes a `CreateMissionApprovalDefinitionDto` and reads ONLY `dto.steps`
 * as the definition's new, complete step list. A step omitted from that array is therefore REMOVED,
 * not left alone. That is why the editor below edits the WHOLE list — with a delete control on every
 * row and a warning naming the consequence before the save. Presenting it as "add a step" would let
 * an operator delete steps by accident, and no part of this contract supports incremental step
 * mutation.
 *
 * `selfApprovalMode` IS A REQUIRED FIELD OF THIS DTO. It was refused in the EMPLOYEE request body
 * because a requester must not decide their own eligibility; here it is the administrator's own
 * statement about the flow, so it is configured and sent. Two contexts, two rules — and the control
 * is labelled as flow configuration so it cannot read as a request field.
 *
 * APPROVERS: ONLY `approverEmployeeId` IS EXECUTABLE. The DTO also accepts `approverRole` and the
 * response carries it, so a stored role may be DISPLAYED — but `mission-approval.service.ts` REFUSES
 * to open a flow whose step names no employee, which makes a role-only step configuration that
 * cannot run. The editor therefore takes an employee id as the approver reference, renders any
 * stored role as explicitly non-executable, and blocks a save that would leave a step with neither.
 * It offers NO role picker: this client has no contract mapping a role to the people who hold it,
 * and inventing one would be exactly the "manager hierarchy resolution" this step forbids.
 *
 * WHAT IT NEVER SENDS: `tenantId`, `actorId`, `projectId`, `parallelCompletionMode`, a step `id`, a
 * revision, or any server-derived field. `parallelCompletionMode` is in the RESPONSE as a frozen
 * `'ALL_REQUIRED'` and in neither request DTO, so it is rendered and never posted.
 */

const ROUTING_MODES: readonly HrMissionRoutingMode[] = ['SEQUENTIAL', 'PARALLEL'];
const SELF_APPROVAL_MODES = ['NOT_ALLOWED', 'ALLOWED'] as const;
const DEFINITION_STATUSES: readonly HrMissionDefinitionStatus[] = ['ACTIVE', 'INACTIVE', 'DRAFT'];

type SelfApprovalMode = (typeof SELF_APPROVAL_MODES)[number];

/**
 * The Persian wording for the two self-approval modes.
 *
 * THE VALUES are `@IsIn(MISSION_SELF_APPROVAL_MODES)` server-side and are sent verbatim; only the
 * labels are translated, and the `NOT_ALLOWED` sentence names the consequence rather than the enum,
 * because "not allowed" alone does not tell an administrator what will happen.
 */
const SELF_APPROVAL_LABELS: Record<SelfApprovalMode, string> = {
  NOT_ALLOWED: 'درخواست‌دهنده نمی‌تواند تأییدکننده باشد',
  ALLOWED: 'درخواست‌دهنده می‌تواند تأییدکننده باشد',
};

/** The API's own message when it gave one, and this panel's Persian sentence otherwise. */
function describe(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// The step drafts, and the bodies they become
// ---------------------------------------------------------------------------

/**
 * One step as the EDITOR holds it.
 *
 * EVERY VALUE IS A STRING because every value comes from an input, and the conversion to the DTO's
 * types happens once, in `buildSteps`. Two consequences worth stating:
 *
 *   * `order` and `approverEmployeeId` are strings here and `number`/`string` in the DTO, so nothing
 *     coerces a blank field into `0` — or a half-typed id into a step the server would reject with a
 *     less useful message than this screen gives.
 *   * `draftId` is LOCAL and never serialised. React needs a key that survives reordering, and a
 *     step's server `id` is absent on an unsaved row, so the key is a counter that exists only in
 *     this component's state and `buildSteps` drops it.
 */
interface StepDraft {
  draftId: number;
  order: string;
  name: string;
  approverEmployeeId: string;
  /** A stored role: shown as a fact, never offered as a picker — see the file header. */
  approverRole: string | null;
  required: boolean;
}

let nextDraftId = 1;

function blankStep(order: number): StepDraft {
  return {
    draftId: nextDraftId++,
    order: String(order),
    name: '',
    approverEmployeeId: '',
    approverRole: null,
    required: true,
  };
}

function draftFromStep(step: HrMissionApprovalDefinition['steps'][number]): StepDraft {
  return {
    draftId: nextDraftId++,
    order: String(step.order),
    name: step.name,
    approverEmployeeId: step.approverEmployeeId ?? '',
    approverRole: step.approverRole,
    required: step.required,
  };
}

/**
 * The step array the DTO receives — a REPLACEMENT list, so every row here becomes a step and every
 * row the operator removed is gone.
 *
 * `approverRole` is carried through ONLY when the row also names an employee: the DTO accepts a role
 * alone, but the server refuses to route such a step, so posting one would be writing a step that
 * cannot execute. `required` is always sent because the UI presents it as a checkbox — an explicit
 * `false` is the operator's statement rather than an omission, and the DTO's `@IsOptional()` permits
 * either.
 */
function buildSteps(drafts: StepDraft[]): MissionApprovalStepDefinitionInput[] {
  return drafts.map((draft) => {
    const employeeId = draft.approverEmployeeId.trim();
    const step: MissionApprovalStepDefinitionInput = {
      order: Number(draft.order),
      name: draft.name.trim(),
      required: draft.required,
    };
    if (employeeId !== '') step.approverEmployeeId = employeeId;
    if (employeeId !== '' && draft.approverRole !== null) step.approverRole = draft.approverRole;
    return step;
  });
}

/**
 * `CreateMissionApprovalDefinitionDto` — `name`, `routingMode`, `selfApprovalMode`, `steps`.
 *
 * All four are required by that DTO, so all four are always present. This is ALSO the body the
 * replace-steps route takes: its handler reads only `steps`, and sending the definition-level fields
 * beside it is what the contract literally specifies rather than a client's assumption about it.
 */
function buildDefinitionBody(
  name: string,
  routingMode: HrMissionRoutingMode,
  selfApprovalMode: SelfApprovalMode,
  drafts: StepDraft[]
): CreateMissionApprovalDefinitionInput {
  return {
    name: name.trim(),
    routingMode,
    selfApprovalMode,
    steps: buildSteps(drafts),
  };
}

/**
 * `UpdateMissionApprovalDefinitionDto` — `name?`, `routingMode?`, `selfApprovalMode?`, `status?`.
 *
 * THE STEPS ARE NOT HERE. They move through their own route, because replacing a definition's
 * ordered steps is a different act from renaming it; a body carrying both would imply the rename and
 * the step rewrite were one decision.
 */
function buildDefinitionPatch(
  name: string,
  routingMode: HrMissionRoutingMode,
  selfApprovalMode: SelfApprovalMode,
  status: HrMissionDefinitionStatus
): UpdateMissionApprovalDefinitionInput {
  return { name: name.trim(), routingMode, selfApprovalMode, status };
}

/**
 * A row's own problem, or `null` when it is complete enough to submit.
 *
 * THESE ARE THE DTO'S OWN CONSTRAINTS, not invented policy: `name` is `@MinLength(1)`, `order` is
 * integers `@Min(1)`, and a step with neither an employee nor a role is one the service refuses to
 * route. Catching them here turns "the server said 400" into a sentence naming the offending row.
 */
function stepProblem(step: StepDraft): string | null {
  if (step.name.trim() === '') return 'عنوان مرحله الزامی است.';
  if (!/^\d+$/.test(step.order.trim()) || Number(step.order) < 1) {
    return 'ترتیب مرحله باید عددی و حداقل ۱ باشد.';
  }
  if (step.approverEmployeeId.trim() === '') {
    return step.approverRole === null
      ? 'این مرحله هیچ تأییدکننده‌ای ندارد؛ شناسهٔ کارمند تأییدکننده را وارد کنید.'
      : 'این مرحله فقط نقش دارد و اجرایی نیست؛ شناسهٔ کارمند تأییدکننده را وارد کنید.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The step editor — a WHOLE-LIST editor, because the route replaces the whole list
// ---------------------------------------------------------------------------

/**
 * The ordered steps of one definition, edited as a COMPLETE LIST.
 *
 * WHY THERE IS A DELETE CONTROL ON EVERY ROW. The route replaces the list, so omitting a step IS
 * deleting it. Giving the operator no way to omit a row would leave hand-writing a request as the
 * only way to remove a step — and giving them an explicit control, beside a warning that names the
 * consequence, is how the replacement semantics become visible instead of surprising.
 */
function MissionApprovalStepsEditor({
  drafts,
  onChange,
  disabled,
}: {
  drafts: StepDraft[];
  onChange: (next: StepDraft[]) => void;
  disabled: boolean;
}) {
  const update = (draftId: number, patch: Partial<StepDraft>) => {
    onChange(drafts.map((draft) => (draft.draftId === draftId ? { ...draft, ...patch } : draft)));
  };

  return (
    <div className="flex flex-col gap-3">
      <p
        data-testid="hr-mission-steps-replacement-note"
        className="rounded-xl border border-border bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
      >
        این فهرست به‌طور کامل جایگزین مراحل تعریف می‌شود: هر مرحله‌ای که در این فهرست نباشد حذف
        می‌شود. برای نگه‌داشتن یک مرحله باید در همین فهرست بماند.
      </p>

      {drafts.length === 0 ? (
        <CoreEmpty message="این تعریف هیچ مرحله‌ای ندارد." />
      ) : (
        <ol className="flex flex-col gap-3" data-testid="hr-mission-steps">
          {drafts.map((draft) => {
            const problem = stepProblem(draft);
            return (
              <li
                key={draft.draftId}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3"
                data-testid={`hr-mission-step-${draft.draftId}`}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    label="ترتیب"
                    id={`hr-mission-step-order-${draft.draftId}`}
                    data-testid={`hr-mission-step-order-${draft.draftId}`}
                    value={draft.order}
                    inputMode="numeric"
                    disabled={disabled}
                    onChange={(event) => update(draft.draftId, { order: event.target.value })}
                  />
                  <Input
                    label="عنوان مرحله"
                    id={`hr-mission-step-name-${draft.draftId}`}
                    data-testid={`hr-mission-step-name-${draft.draftId}`}
                    value={draft.name}
                    disabled={disabled}
                    onChange={(event) => update(draft.draftId, { name: event.target.value })}
                  />
                  <Input
                    label="شناسهٔ کارمند تأییدکننده"
                    id={`hr-mission-step-approver-${draft.draftId}`}
                    data-testid={`hr-mission-step-approver-${draft.draftId}`}
                    value={draft.approverEmployeeId}
                    disabled={disabled}
                    onChange={(event) =>
                      update(draft.draftId, { approverEmployeeId: event.target.value })
                    }
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    data-testid={`hr-mission-step-required-${draft.draftId}`}
                    checked={draft.required}
                    disabled={disabled}
                    onChange={(event) => update(draft.draftId, { required: event.target.checked })}
                  />
                  تصمیم این مرحله الزامی است
                </label>

                {/* A STORED ROLE IS RENDERED AS A FACT AND MARKED NON-EXECUTABLE. The DTO accepts
                    `approverRole` and the response carries it, so hiding it would misreport a row
                    that has one — but the service refuses to open a flow through a step naming no
                    employee, so presenting the role as a working assignment would be a lie the
                    operator discovers only when a request stalls. */}
                {draft.approverRole !== null && (
                  <p
                    data-testid={`hr-mission-step-role-${draft.draftId}`}
                    className="rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
                  >
                    نقش ثبت‌شدهٔ این مرحله: «{draft.approverRole}» — نقش به‌تنهایی اجرایی نیست و
                    گردش تأیید با آن باز نمی‌شود؛ شناسهٔ کارمند تأییدکننده لازم است.
                  </p>
                )}

                {problem !== null && (
                  <p
                    data-testid={`hr-mission-step-problem-${draft.draftId}`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {problem}
                  </p>
                )}

                <div>
                  <Button
                    type="button"
                    data-testid={`hr-mission-step-remove-${draft.draftId}`}
                    disabled={disabled}
                    onClick={() => onChange(drafts.filter((row) => row.draftId !== draft.draftId))}
                    className="bg-muted text-foreground hover:bg-muted/80"
                  >
                    حذف این مرحله
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div>
        <Button
          type="button"
          data-testid="hr-mission-step-add"
          disabled={disabled}
          onClick={() => onChange([...drafts, blankStep(drafts.length + 1)])}
        >
          افزودن مرحله
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One definition
// ---------------------------------------------------------------------------

/**
 * ONE definition: its server-declared facts, its settings editor, and its step editor.
 *
 * THE TWO EDITORS ARE SEPARATE FORMS because the two routes are separate — the settings go to
 * `PATCH .../approval-definitions/:definitionId` and the steps to its `/steps` child — so a single
 * save button would have to choose which act it was performing. Each names its own consequence.
 */
function MissionApprovalDefinitionRow({
  definition,
  isBusy,
  onSaved,
  onError,
}: {
  definition: HrMissionApprovalDefinition;
  isBusy: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [isEditingSettings, setEditingSettings] = React.useState(false);
  const [name, setName] = React.useState(definition.name);
  const [routingMode, setRoutingMode] = React.useState<HrMissionRoutingMode>(
    definition.routingMode
  );
  const [selfApprovalMode, setSelfApprovalMode] = React.useState<SelfApprovalMode>(
    definition.selfApprovalMode
  );
  const [status, setStatus] = React.useState<HrMissionDefinitionStatus>(definition.status);
  const [isSavingSettings, setSavingSettings] = React.useState(false);

  const [isEditingSteps, setEditingSteps] = React.useState(false);
  const [drafts, setDrafts] = React.useState<StepDraft[]>([]);
  const [isSavingSteps, setSavingSteps] = React.useState(false);

  const openSettings = () => {
    setName(definition.name);
    setRoutingMode(definition.routingMode);
    setSelfApprovalMode(definition.selfApprovalMode);
    setStatus(definition.status);
    setEditingSettings(true);
  };

  const openSteps = () => {
    setDrafts(definition.steps.map(draftFromStep));
    setEditingSteps(true);
  };

  const saveSettings = async () => {
    if (isSavingSettings) return;
    setSavingSettings(true);
    try {
      await updateMissionApprovalDefinition(
        definition.id,
        buildDefinitionPatch(name, routingMode, selfApprovalMode, status)
      );
      setEditingSettings(false);
      onSaved();
    } catch (err: unknown) {
      onError(describe(err, 'ویرایش تعریف گردش تأیید با خطا مواجه شد.'));
    } finally {
      setSavingSettings(false);
    }
  };

  const saveSteps = async () => {
    if (isSavingSteps) return;
    setSavingSteps(true);
    try {
      // The WHOLE definition body, exactly as the create route takes it: the controller reads only
      // `steps`, and taking that route's own DTO is what states the replacement at the call site.
      await replaceMissionApprovalDefinitionSteps(
        definition.id,
        buildDefinitionBody(
          definition.name,
          definition.routingMode,
          definition.selfApprovalMode,
          drafts
        )
      );
      setEditingSteps(false);
      onSaved();
    } catch (err: unknown) {
      onError(describe(err, 'جایگزینی مراحل گردش تأیید با خطا مواجه شد.'));
    } finally {
      setSavingSteps(false);
    }
  };

  const hasStepProblem = drafts.some((draft) => stepProblem(draft) !== null);

  return (
    <HrCard testId={`hr-mission-definition-${definition.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3
          className="text-base font-semibold text-foreground"
          data-testid={`hr-mission-definition-name-${definition.id}`}
        >
          {definition.name}
        </h3>
        <HrBadge
          tone={missionDefinitionStatusTone(definition.status)}
          testId={`hr-mission-definition-status-${definition.id}`}
        >
          {missionDefinitionStatusLabel(definition.status)}
        </HrBadge>
        <HrBadge tone="muted" testId={`hr-mission-definition-routing-${definition.id}`}>
          {missionRoutingModeLabel(definition.routingMode)}
        </HrBadge>
        {/* `parallelCompletionMode` is a FROZEN server value (`'ALL_REQUIRED'`) that appears in no
            request DTO. It is rendered because it is part of what the flow does, and never posted. */}
        <HrBadge tone="muted" testId={`hr-mission-definition-completion-${definition.id}`}>
          تکمیل موازی: همهٔ مراحل الزامی
        </HrBadge>
        <HrBadge tone="muted" testId={`hr-mission-definition-self-approval-${definition.id}`}>
          {SELF_APPROVAL_LABELS[definition.selfApprovalMode]}
        </HrBadge>
        <Button
          type="button"
          data-testid={`hr-mission-definition-edit-${definition.id}`}
          onClick={openSettings}
          className="bg-muted text-foreground hover:bg-muted/80"
        >
          ویرایش تنظیمات
        </Button>
        <Button
          type="button"
          data-testid={`hr-mission-definition-edit-steps-${definition.id}`}
          onClick={openSteps}
        >
          ویرایش مراحل
        </Button>
      </div>

      {/* The steps the SERVER returned, in the order it returned them. `order` is the definition's
          own statement about sequence and this panel does not re-sort by it: re-arranging a list the
          server already ordered would be a second opinion about the flow's shape. */}
      <div className="mt-4" data-testid={`hr-mission-definition-steps-${definition.id}`}>
        {definition.steps.length === 0 ? (
          <CoreEmpty message="این تعریف هیچ مرحله‌ای ندارد." />
        ) : (
          <ol className="flex flex-col gap-2">
            {definition.steps.map((step) => (
              <li
                key={step.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"
                data-testid={`hr-mission-definition-step-${step.id}`}
              >
                <span className="font-mono text-xs text-muted-foreground">{step.order}</span>
                <span className="text-foreground">{step.name}</span>
                {/* THE EXECUTABLE REFERENCE. When it is null the row STATES that the step resolves to
                    nobody rather than drawing an empty cell, because an empty cell reads as a missing
                    relation while this is a configuration the flow refuses to open. */}
                {step.approverEmployeeId === null ? (
                  <HrBadge tone="danger" testId={`hr-mission-definition-step-approver-${step.id}`}>
                    بدون تأییدکنندهٔ اجرایی
                  </HrBadge>
                ) : (
                  <span
                    className="font-mono text-xs text-muted-foreground"
                    data-testid={`hr-mission-definition-step-approver-${step.id}`}
                  >
                    {step.approverEmployeeId}
                  </span>
                )}
                {/* The role, when the row has one, labelled non-executable for the reason the editor
                    warns about it. */}
                {step.approverRole !== null && (
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid={`hr-mission-definition-step-role-${step.id}`}
                  >
                    نقش (غیراجرایی): {step.approverRole}
                  </span>
                )}
                {!step.required && (
                  <span className="text-xs text-muted-foreground">تصمیم این مرحله الزامی نیست</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {isEditingSettings && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="نام تعریف"
              id={`hr-mission-definition-name-input-${definition.id}`}
              data-testid={`hr-mission-definition-name-input-${definition.id}`}
              value={name}
              disabled={isSavingSettings}
              onChange={(event) => setName(event.target.value)}
            />
            <Select
              label="حالت گردش"
              id={`hr-mission-definition-routing-input-${definition.id}`}
              data-testid={`hr-mission-definition-routing-input-${definition.id}`}
              value={routingMode}
              disabled={isSavingSettings}
              onChange={(event) => setRoutingMode(event.target.value as HrMissionRoutingMode)}
              options={ROUTING_MODES.map((mode) => ({
                value: mode,
                label: missionRoutingModeLabel(mode),
              }))}
            />
            <Select
              label="تأیید توسط درخواست‌دهنده"
              id={`hr-mission-definition-self-approval-input-${definition.id}`}
              data-testid={`hr-mission-definition-self-approval-input-${definition.id}`}
              value={selfApprovalMode}
              disabled={isSavingSettings}
              onChange={(event) => setSelfApprovalMode(event.target.value as SelfApprovalMode)}
              options={SELF_APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: SELF_APPROVAL_LABELS[mode],
              }))}
            />
            <Select
              label="وضعیت تعریف"
              id={`hr-mission-definition-status-input-${definition.id}`}
              data-testid={`hr-mission-definition-status-input-${definition.id}`}
              value={status}
              disabled={isSavingSettings}
              onChange={(event) => setStatus(event.target.value as HrMissionDefinitionStatus)}
              options={DEFINITION_STATUSES.map((value) => ({
                value,
                label: missionDefinitionStatusLabel(value),
              }))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-definition-settings-save-${definition.id}`}
              onClick={saveSettings}
              disabled={isSavingSettings || isBusy || name.trim() === ''}
            >
              ذخیره تنظیمات
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-definition-settings-cancel-${definition.id}`}
              onClick={() => setEditingSettings(false)}
              disabled={isSavingSettings}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </div>
      )}

      {isEditingSteps && (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
          <MissionApprovalStepsEditor
            drafts={drafts}
            onChange={setDrafts}
            disabled={isSavingSteps}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              data-testid={`hr-mission-definition-steps-save-${definition.id}`}
              onClick={saveSteps}
              disabled={isSavingSteps || isBusy || hasStepProblem}
            >
              ذخیرهٔ مراحل (جایگزینی کامل)
            </Button>
            <Button
              type="button"
              data-testid={`hr-mission-definition-steps-cancel-${definition.id}`}
              onClick={() => setEditingSteps(false)}
              disabled={isSavingSteps}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              انصراف
            </Button>
          </div>
        </div>
      )}
    </HrCard>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * DOMAIN 2's surface: the flow definitions, and the create form above them.
 *
 * IT IS MOUNTED BY A VIEW THAT HOLDS `hr.mission.policy`, and this platform's convention (see
 * `HrMissionApprovalView`) is that the GRANT is checked at the view and this surface is not rendered
 * otherwise. `canWrite` is therefore `true` in production; the guard is kept because these tests
 * mount the panel directly and the step requires the FORBIDDEN state to be provable on the surface
 * the grant applies to — a read that would 403 is a request the grants do not cover, so the panel
 * must issue NOTHING rather than let the server refuse it.
 */
export function MissionApprovalDefinitionPanel({ canWrite }: { canWrite: boolean }) {
  const [definitions, setDefinitions] = React.useState<HrMissionApprovalDefinition[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // Re-arms loading/cleared in `refresh` (same commit as the token bump), so
  // the list effect needs no in-effect setter resets. First mount is covered
  // by `isLoading: true`, and the `!canWrite` render gate precedes the spinner.
  const { token: reloadToken, reload: refresh } = useReloadToken(setLoading, setError);

  const [isCreating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newRoutingMode, setNewRoutingMode] = React.useState<HrMissionRoutingMode>('SEQUENTIAL');
  const [newSelfApprovalMode, setNewSelfApprovalMode] =
    React.useState<SelfApprovalMode>('NOT_ALLOWED');
  const [newSteps, setNewSteps] = React.useState<StepDraft[]>(() => [blankStep(1)]);
  const [isSavingNew, setSavingNew] = React.useState(false);

  /**
   * The list read: issued ONCE per load and ONCE per successful mutation — the SAME read that
   * produced the rows, re-issued. After a write the authoritative state is whatever the server now
   * returns, and a client that patched its own copy would be reporting its own guess.
   */
  React.useEffect(() => {
    if (!canWrite) return;

    let active = true;

    fetchMissionApprovalDefinitions()
      .then((result) => {
        if (!active) return;
        setDefinitions(result.items);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setDefinitions([]);
        setError(describe(err, 'دریافت تعریف‌های گردش تأیید ماموریت با خطا مواجه شد.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canWrite, reloadToken]);

  const afterWrite = React.useCallback(
    (message: string) => {
      setNotice(message);
      refresh();
    },
    [refresh]
  );

  const createDefinition = async () => {
    if (isSavingNew) return;
    setSavingNew(true);
    setError(null);
    setNotice(null);
    try {
      await createMissionApprovalDefinition(
        buildDefinitionBody(newName, newRoutingMode, newSelfApprovalMode, newSteps)
      );
      setNewName('');
      setNewRoutingMode('SEQUENTIAL');
      setNewSelfApprovalMode('NOT_ALLOWED');
      setNewSteps([blankStep(1)]);
      setCreating(false);
      afterWrite('تعریف گردش تأیید ایجاد شد.');
    } catch (err: unknown) {
      setError(describe(err, 'ایجاد تعریف گردش تأیید با خطا مواجه شد.'));
    } finally {
      setSavingNew(false);
    }
  };

  if (!canWrite) {
    return (
      <HrCard testId="hr-mission-approval-definitions-forbidden">
        <CoreEmpty message="برای پیکربندی تعریف‌های گردش تأیید ماموریت به مجوز hr.mission.policy نیاز دارید." />
      </HrCard>
    );
  }

  const hasNewStepProblem = newSteps.some((draft) => stepProblem(draft) !== null);

  return (
    <div className="flex flex-col gap-4">
      {notice !== null && <HrNotice tone="ok" message={notice} />}

      {error !== null && !isLoading && <CoreError message={error} onRetry={refresh} />}

      <HrCard testId="hr-mission-approval-definitions">
        {isLoading ? (
          <CoreLoading lines={5} />
        ) : definitions.length === 0 ? (
          <CoreEmpty message="هیچ تعریف گردش تأیید ماموریتی ثبت نشده است." />
        ) : (
          <div className="flex flex-col gap-4">
            {definitions.map((definition) => (
              <MissionApprovalDefinitionRow
                key={definition.id}
                definition={definition}
                isBusy={isLoading}
                onSaved={() => afterWrite('تغییرات ذخیره شد.')}
                onError={(message) => setError(message)}
              />
            ))}
          </div>
        )}
      </HrCard>

      {isCreating ? (
        <HrCard title="تعریف جدید گردش تأیید" testId="hr-mission-approval-definition-create">
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="نام تعریف"
                id="hr-mission-definition-new-name"
                data-testid="hr-mission-definition-new-name"
                value={newName}
                disabled={isSavingNew}
                onChange={(event) => setNewName(event.target.value)}
              />
              <Select
                label="حالت گردش"
                id="hr-mission-definition-new-routing"
                data-testid="hr-mission-definition-new-routing"
                value={newRoutingMode}
                disabled={isSavingNew}
                onChange={(event) => setNewRoutingMode(event.target.value as HrMissionRoutingMode)}
                options={ROUTING_MODES.map((mode) => ({
                  value: mode,
                  label: missionRoutingModeLabel(mode),
                }))}
              />
              <Select
                label="تأیید توسط درخواست‌دهنده"
                id="hr-mission-definition-new-self-approval"
                data-testid="hr-mission-definition-new-self-approval"
                value={newSelfApprovalMode}
                disabled={isSavingNew}
                onChange={(event) => setNewSelfApprovalMode(event.target.value as SelfApprovalMode)}
                options={SELF_APPROVAL_MODES.map((mode) => ({
                  value: mode,
                  label: SELF_APPROVAL_LABELS[mode],
                }))}
              />
            </div>

            <MissionApprovalStepsEditor
              drafts={newSteps}
              onChange={setNewSteps}
              disabled={isSavingNew}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                data-testid="hr-mission-definition-create-submit"
                onClick={createDefinition}
                disabled={
                  isSavingNew || newName.trim() === '' || newSteps.length === 0 || hasNewStepProblem
                }
              >
                ایجاد تعریف
              </Button>
              <Button
                type="button"
                data-testid="hr-mission-definition-create-cancel"
                onClick={() => setCreating(false)}
                disabled={isSavingNew}
                className="bg-muted text-foreground hover:bg-muted/80"
              >
                انصراف
              </Button>
            </div>
          </div>
        </HrCard>
      ) : (
        <div>
          <Button
            type="button"
            data-testid="hr-mission-definition-create-open"
            onClick={() => setCreating(true)}
          >
            تعریف جدید
          </Button>
        </div>
      )}
    </div>
  );
}
