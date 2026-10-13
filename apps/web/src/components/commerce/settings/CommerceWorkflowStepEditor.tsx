'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  addCommerceWorkflowStep,
  COMMERCE_WORKFLOW_ACTOR_SOURCES,
  COMMERCE_WORKFLOW_CONDITION_FALSE_BEHAVIORS,
  COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES,
  COMMERCE_WORKFLOW_MAX_DISPLAY_NAME_LENGTH,
  COMMERCE_WORKFLOW_MAX_PARALLEL_GROUP_LENGTH,
  COMMERCE_WORKFLOW_MAX_STEP_KEY_LENGTH,
  COMMERCE_WORKFLOW_STEP_EXECUTION_MODES,
  readCommerceSimpleCondition,
  readCommerceWorkflowValidationReport,
  updateCommerceWorkflowStep,
  type CommerceWorkflowActorSource,
  type CommerceWorkflowConditionFalseBehavior,
  type CommerceWorkflowStep,
  type CommerceWorkflowStepExecutionMode,
  type CommerceWorkflowStepPatch,
  type CommerceWorkflowValidationIssue,
  type CommerceSimpleConditionDraft,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceInstantLabel,
  commerceWorkflowActorSourceLabel,
  commerceWorkflowConditionFalseBehaviorLabel,
  commerceWorkflowRefusalLabel,
  commerceWorkflowStepExecutionModeLabel,
} from '@/lib/commerce-labels';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useCommerceDirtyFlag, useCommerceSettingsGuard } from './CommerceSettingsGuard';
import { CommerceMemberPicker } from './CommerceMemberPicker';
import {
  CommerceWorkflowConditionEditor,
  conditionPayloadFor,
} from './CommerceWorkflowConditionEditor';

/**
 * PHASE UI-4 (§10): the STEP EDITOR — a drawer, not a modal maze.
 *
 * THE PROGRESSIVE DISCLOSURE THE BRIEF ASKS FOR, in order: اطلاعات پایه (name, handle,
 * order, mandatory, mode), تنظیم مسئول (source + its ONE parameter), شرط (only when the
 * mode can have one), and پیشرفته (the technical facts, read-only). Raw JSON is never
 * the authoring surface: conditions go through the type-paired
 * `CommerceWorkflowConditionEditor`, and the payloads this backend stores WITHOUT a
 * vocabulary (thresholds, lineFilters, visibleFields) are displayed read-only — an
 * administrator cannot meaningfully author a shape no specification states, and a
 * textarea pretending otherwise would be a fake editor.
 *
 * EVERY CLIENT RULE MIRRORS THE BACKEND'S WRITETIME RULES (`workflow-configuration.ts`,
 * DRAFT level): non-empty bounded names, integer order ≥ 1, a branch label exactly for
 * PARALLEL, a condition exactly for CONDITIONAL, the actor source's own parameter
 * present, and a parameter cleared when the source stops asking for it. Nothing stricter
 * and nothing looser — the walk runs again server-side and its structured report is
 * rendered verbatim under the form when a refusal still comes back.
 */
type ConditionKind = 'none' | 'simple' | 'complex';

function initialConditionKind(step: CommerceWorkflowStep | null): ConditionKind {
  if (!step || step.condition === null || step.condition === undefined) return 'none';
  return readCommerceSimpleCondition(step.condition) ? 'simple' : 'complex';
}

export function CommerceWorkflowStepEditor({
  versionId,
  step,
  nextOrdering,
  canReadDirectory,
  onClose,
  onSaved,
}: {
  versionId: string;
  /** `null` = creating a step. */
  step: CommerceWorkflowStep | null;
  nextOrdering: number;
  canReadDirectory: boolean;
  onClose: () => void;
  onSaved: (saved: CommerceWorkflowStep) => void;
}) {
  const { requestGuard } = useCommerceSettingsGuard();

  const [stepKey, setStepKey] = React.useState(step?.stepKey ?? '');
  const [displayName, setDisplayName] = React.useState(step?.displayName ?? '');
  const [ordering, setOrdering] = React.useState(
    step ? String(step.ordering) : String(nextOrdering)
  );
  const [mandatory, setMandatory] = React.useState(step?.mandatory ?? true);
  const [executionMode, setExecutionMode] = React.useState<string>(
    step?.executionMode ?? 'SEQUENTIAL'
  );
  const [parallelGroup, setParallelGroup] = React.useState(step?.parallelGroup ?? '');
  const [actorSource, setActorSource] = React.useState(step?.actorSource ?? '');
  const [actorUserId, setActorUserId] = React.useState<string | null>(step?.actorUserId ?? null);
  const [actorRoleCode, setActorRoleCode] = React.useState(step?.actorRoleCode ?? '');
  const [conditionKind, setConditionKind] = React.useState<ConditionKind>(() =>
    initialConditionKind(step)
  );
  const [simpleCondition, setSimpleCondition] = React.useState<CommerceSimpleConditionDraft | null>(
    () => (step?.condition ? readCommerceSimpleCondition(step.condition) : null)
  );
  const [onConditionFalse, setOnConditionFalse] = React.useState(step?.onConditionFalse ?? '');

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitIssues, setSubmitIssues] = React.useState<CommerceWorkflowValidationIssue[]>([]);

  /*
   * DIRTY STATE is a pure serialization comparison against the form's first render —
   * the editor never decides anything else, and `useCommerceDirtyFlag` publishes it to
   * the domain guard so every exit (drawer close, sub-navigation, version switch) can
   * ask before discarding.
   */
  const serializeForm = React.useCallback(
    () =>
      JSON.stringify({
        stepKey,
        displayName,
        ordering,
        mandatory,
        executionMode,
        parallelGroup,
        actorSource,
        actorUserId,
        actorRoleCode,
        conditionKind,
        simpleCondition,
        onConditionFalse,
      }),
    [
      stepKey,
      displayName,
      ordering,
      mandatory,
      executionMode,
      parallelGroup,
      actorSource,
      actorUserId,
      actorRoleCode,
      conditionKind,
      simpleCondition,
      onConditionFalse,
    ]
  );

  // The baseline is captured ONCE per mount, in render, as component STATE —
  // not a ref (reading/writing refs during render is forbidden by
  // `react-hooks/refs`, and state gives byte-identical semantics here: the
  // lazy initializer runs on the first render only, and nothing ever mutates
  // it afterwards).
  const [initialForm] = React.useState(() => serializeForm());
  const dirty = serializeForm() !== initialForm;
  useCommerceDirtyFlag(`step-editor-${step?.id ?? 'new'}`, dirty);

  const opTakesValue =
    simpleCondition !== null &&
    simpleCondition.op !== 'isEmpty' &&
    simpleCondition.op !== 'isNotEmpty';

  /**
   * THE MIRROR OF THE DRAFT-LEVEL WALK — and ONLY that. Completeness rules the backend
   * judges at PUBLISH time (trigger, join policy, false-behaviour, executable actor
   * source) are NOT enforced here; they arrive as the publish report, which the editor
   * above renders in full. A client rule stricter than the server would be a semantic
   * invention; a looser one is already covered by the server.
   */
  const validate = (): boolean => {
    const next: Record<string, string> = {};
    const name = displayName.trim();
    const key = stepKey.trim();
    const order = Number(ordering);

    if (!name) {
      next.displayName = 'نام مرحله را وارد کنید.';
    } else if (name.length > COMMERCE_WORKFLOW_MAX_DISPLAY_NAME_LENGTH) {
      next.displayName = `نام مرحله حداکثر ${COMMERCE_WORKFLOW_MAX_DISPLAY_NAME_LENGTH} نویسه است.`;
    }
    if (!key) {
      next.stepKey = 'کلید مرحله را وارد کنید.';
    } else if (key.length > COMMERCE_WORKFLOW_MAX_STEP_KEY_LENGTH) {
      next.stepKey = `کلید مرحله حداکثر ${COMMERCE_WORKFLOW_MAX_STEP_KEY_LENGTH} نویسه است.`;
    }
    if (!Number.isInteger(order) || order < 1) {
      next.ordering = 'ترتیب باید یک عدد صحیح بزرگ‌تر یا مساوی ۱ باشد.';
    }
    if (executionMode === 'PARALLEL') {
      const group = parallelGroup.trim();
      if (!group) {
        next.parallelGroup = 'برای مرحلهٔ موازی، برچسب شاخه لازم است.';
      } else if (group.length > COMMERCE_WORKFLOW_MAX_PARALLEL_GROUP_LENGTH) {
        next.parallelGroup = `برچسب شاخه حداکثر ${COMMERCE_WORKFLOW_MAX_PARALLEL_GROUP_LENGTH} نویسه است.`;
      }
    }
    if (executionMode === 'CONDITIONAL') {
      if (conditionKind === 'none') {
        next.condition = 'مرحلهٔ شرطی باید شرط داشته باشد.';
      } else if (conditionKind === 'simple') {
        if (!simpleCondition) {
          next.condition = 'شرط را کامل کنید.';
        } else if (opTakesValue) {
          const value = simpleCondition.value;
          if (value === undefined || value === '') {
            next.condition = 'مقدار شرط را وارد کنید.';
          } else if (typeof value === 'number' && !Number.isFinite(value)) {
            next.condition = 'مقدار شرط باید یک عدد معتبر باشد.';
          } else if (typeof value === 'string' && value.length > 256) {
            // RULE_LIMITS.maxStringOperandLength — the engine's own bound, mirrored so
            // the refusal happens at the field instead of at publish.
            next.condition = 'مقدار شرط حداکثر ۲۵۶ نویسه است.';
          }
        }
      }
    }
    if (actorSource === 'CONFIGURED_USER' && !(actorUserId ?? '').trim()) {
      next.actorUserId = 'برای «کاربر مشخص»، انتخاب کاربر لازم است.';
    }
    if (actorSource === 'CONFIGURED_ROLE') {
      const role = actorRoleCode.trim();
      if (!role) {
        next.actorRoleCode = 'کد نقش را وارد کنید.';
      } else if (role.length > 128) {
        next.actorRoleCode = 'کد نقش حداکثر ۱۲۸ نویسه است.';
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const isConditional = executionMode === 'CONDITIONAL';
  const isParallel = executionMode === 'PARALLEL';

  const save = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (pending) return;
    setSubmitError(null);
    setSubmitIssues([]);
    if (!validate()) return;

    setPending(true);

    if (!step) {
      // CREATE — every field the DTO states, with the backend's own conditional
      // inclusion rules (a branch label exactly for PARALLEL, a condition exactly for
      // CONDITIONAL, and the actor source's own parameter).
      addCommerceWorkflowStep(versionId, {
        stepKey: stepKey.trim(),
        displayName: displayName.trim(),
        ordering: Number(ordering),
        mandatory,
        executionMode: executionMode as CommerceWorkflowStepExecutionMode,
        ...(isParallel ? { parallelGroup: parallelGroup.trim() } : {}),
        ...(isConditional
          ? {
              condition: conditionPayloadFor(conditionKind, simpleCondition),
              ...(onConditionFalse
                ? { onConditionFalse: onConditionFalse as CommerceWorkflowConditionFalseBehavior }
                : {}),
            }
          : {}),
        ...(actorSource
          ? { actorSource: actorSource as CommerceWorkflowActorSource }
          : {}),
        ...(actorSource === 'CONFIGURED_USER' && actorUserId ? { actorUserId } : {}),
        ...(actorSource === 'CONFIGURED_ROLE'
          ? { actorRoleCode: actorRoleCode.trim() }
          : {}),
      })
        .then(onSaved)
        .catch((err: unknown) => {
          setPending(false);
          const report = readCommerceWorkflowValidationReport(err);
          setSubmitIssues(report?.issues ?? []);
          setSubmitError(commerceActionErrorMessage(err, 'افزودن مرحله انجام نشد.'));
        });
      return;
    }

    // UPDATE — a DIFF patch: only what changed, plus the clears the backend requires
    // (a parameter or a branch label that the new mode/source no longer asks for).
    const patch: CommerceWorkflowStepPatch = {};
    if (stepKey.trim() !== step.stepKey) patch.stepKey = stepKey.trim();
    if (displayName.trim() !== step.displayName) patch.displayName = displayName.trim();
    if (Number(ordering) !== step.ordering) patch.ordering = Number(ordering);
    if (mandatory !== step.mandatory) patch.mandatory = mandatory;
    if (executionMode !== step.executionMode) {
      patch.executionMode = executionMode as CommerceWorkflowStepExecutionMode;
    }

    const storedGroup = step.parallelGroup ?? '';
    if (isParallel) {
      if (parallelGroup.trim() !== storedGroup) patch.parallelGroup = parallelGroup.trim();
    } else if (storedGroup) {
      patch.parallelGroup = null;
    }

    const storedCondition = step.condition ?? null;
    if (isConditional) {
      if (conditionKind === 'simple') {
        const desired = conditionPayloadFor('simple', simpleCondition);
        if (JSON.stringify(desired) !== JSON.stringify(storedCondition)) {
          patch.condition = desired;
        }
      }
    } else if (storedCondition) {
      patch.condition = null;
    }

    const storedFalse = step.onConditionFalse ?? '';
    if (onConditionFalse !== storedFalse) {
      patch.onConditionFalse = onConditionFalse
        ? (onConditionFalse as CommerceWorkflowConditionFalseBehavior)
        : null;
    }

    const storedSource = step.actorSource ?? '';
    if (actorSource !== storedSource) {
      patch.actorSource = (actorSource || null) as CommerceWorkflowStepPatch['actorSource'];
    }

    const storedUser = step.actorUserId ?? null;
    if (actorSource === 'CONFIGURED_USER') {
      if (actorUserId !== storedUser) patch.actorUserId = actorUserId;
    } else if (storedUser) {
      patch.actorUserId = null;
    }

    const storedRole = step.actorRoleCode ?? '';
    if (actorSource === 'CONFIGURED_ROLE') {
      if (actorRoleCode.trim() !== storedRole) patch.actorRoleCode = actorRoleCode.trim();
    } else if (storedRole) {
      patch.actorRoleCode = null;
    }

    updateCommerceWorkflowStep(versionId, step.id, patch)
      .then(onSaved)
      .catch((err: unknown) => {
        setPending(false);
        const report = readCommerceWorkflowValidationReport(err);
        setSubmitIssues(report?.issues ?? []);
        setSubmitError(commerceActionErrorMessage(err, 'ذخیرهٔ مرحله انجام نشد.'));
      });
  };

  const initialKind = initialConditionKind(step);

  return (
    <CommerceSettingsDialog
      open
      variant="drawer"
      title={step ? `مرحلهٔ «${step.displayName}»` : 'افزودن مرحله'}
      description={
        step
          ? 'مشخصات، مسئول و شرط فعال‌سازی این مرحله را ویرایش کنید.'
          : 'مرحلهٔ جدید با ترتیب پیشنهادی ساخته می‌شود؛ پیش از ذخیره قابل تغییر است.'
      }
      pending={pending}
      onCancel={() => requestGuard(onClose)}
      testId="commerce-workflow-step-drawer"
      footer={
        <>
          <Button
            type="button"
            disabled={pending}
            onClick={() => requestGuard(onClose)}
            className="border border-border bg-background text-foreground hover:bg-secondary"
          >
            انصراف
          </Button>
          <Button
            type="button"
            onClick={() => save()}
            disabled={pending}
            aria-busy={pending}
            data-testid="commerce-workflow-step-save"
          >
            {pending ? 'در حال ذخیره…' : step ? 'ذخیرهٔ مرحله' : 'افزودن مرحله'}
          </Button>
        </>
      }
    >
      <form id="commerce-workflow-step-form" onSubmit={save} className="space-y-6">
        {submitError && (
          <p
            role="alert"
            data-testid="commerce-workflow-step-error"
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {submitError}
          </p>
        )}

        {submitIssues.length > 0 && (
          <ul
            className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            data-testid="commerce-workflow-step-issues"
          >
            {submitIssues.map((issue, index) => (
              <li key={`${issue.refusal}-${index}`}>
                {commerceWorkflowRefusalLabel(issue.refusal)}
                {issue.path ? (
                  <span dir="ltr" className="opacity-70">
                    {' '}
                    ({issue.path})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}


        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">اطلاعات پایه</h3>

          <div className="space-y-1">
            <label
              htmlFor="commerce-step-display-name"
              className="block text-sm font-medium text-foreground"
            >
              نام مرحله{' '}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </label>
            <input
              id="commerce-step-display-name"
              name="displayName"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-invalid={errors.displayName ? true : undefined}
              aria-describedby={
                errors.displayName ? 'commerce-step-display-name-error' : undefined
              }
              disabled={pending}
              data-testid="commerce-workflow-step-display-name"
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            />
            {errors.displayName && (
              <p id="commerce-step-display-name-error" className="text-xs text-destructive">
                {errors.displayName}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor="commerce-step-key"
                className="block text-sm font-medium text-foreground"
              >
                کلید مرحله{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id="commerce-step-key"
                name="stepKey"
                type="text"
                dir="ltr"
                value={stepKey}
                onChange={(event) => setStepKey(event.target.value)}
                aria-invalid={errors.stepKey ? true : undefined}
                aria-describedby={
                  errors.stepKey ? 'commerce-step-key-error' : 'commerce-step-key-hint'
                }
                disabled={pending}
                data-testid="commerce-workflow-step-key"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
              {errors.stepKey ? (
                <p id="commerce-step-key-error" className="text-xs text-destructive">
                  {errors.stepKey}
                </p>
              ) : (
                <p id="commerce-step-key-hint" className="text-xs text-muted-foreground">
                  شناسهٔ فنی و یکتای مرحله داخل این نسخه؛ برای ارجاع‌های فنی استفاده می‌شود.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label
                htmlFor="commerce-step-ordering"
                className="block text-sm font-medium text-foreground"
              >
                ترتیب{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id="commerce-step-ordering"
                name="ordering"
                type="number"
                min={1}
                step={1}
                value={ordering}
                onChange={(event) => setOrdering(event.target.value)}
                aria-invalid={errors.ordering ? true : undefined}
                aria-describedby={errors.ordering ? 'commerce-step-ordering-error' : undefined}
                disabled={pending}
                data-testid="commerce-workflow-step-ordering"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
              {errors.ordering && (
                <p id="commerce-step-ordering-error" className="text-xs text-destructive">
                  {errors.ordering}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="commerce-step-mode"
                className="block text-sm font-medium text-foreground"
              >
                حالت اجرا
              </label>
              <select
                id="commerce-step-mode"
                name="executionMode"
                value={executionMode}
                onChange={(event) => setExecutionMode(event.target.value)}
                disabled={pending}
                data-testid="commerce-workflow-step-mode"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              >
                {COMMERCE_WORKFLOW_STEP_EXECUTION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {commerceWorkflowStepExecutionModeLabel(mode)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                «ترتیبی» یکی‌پس‌ازدیگر؛ «موازی» هم‌زمان در یک شاخه؛ «شرطی» فقط هنگام برقراری شرط.
              </p>
            </div>

            <div className="space-y-2">
              <label className="inline-flex items-center gap-2 pt-7 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={mandatory}
                  onChange={(event) => setMandatory(event.target.checked)}
                  disabled={pending}
                  data-testid="commerce-workflow-step-mandatory"
                  className="h-4 w-4 rounded border-border"
                />
                مرحلهٔ اجباری است (بدون آن، فرآیند کامل نمی‌شود)
              </label>
            </div>
          </div>

          {isParallel && (
            <div className="space-y-1">
              <label
                htmlFor="commerce-step-parallel-group"
                className="block text-sm font-medium text-foreground"
              >
                برچسب شاخهٔ موازی{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id="commerce-step-parallel-group"
                name="parallelGroup"
                type="text"
                dir="ltr"
                value={parallelGroup}
                onChange={(event) => setParallelGroup(event.target.value)}
                aria-invalid={errors.parallelGroup ? true : undefined}
                aria-describedby={
                  errors.parallelGroup
                    ? 'commerce-step-parallel-group-error'
                    : 'commerce-step-parallel-group-hint'
                }
                disabled={pending}
                data-testid="commerce-workflow-step-parallel-group"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
              {errors.parallelGroup ? (
                <p id="commerce-step-parallel-group-error" className="text-xs text-destructive">
                  {errors.parallelGroup}
                </p>
              ) : (
                <p id="commerce-step-parallel-group-hint" className="text-xs text-muted-foreground">
                  مراحل هم‌گروه با یک برچسب، هم‌زمان اجرا و با سیاست نسخه جمع‌بندی می‌شوند.
                </p>
              )}
            </div>
          )}
        </section>


        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">تنظیم مسئول</h3>

          <div className="space-y-1">
            <label
              htmlFor="commerce-step-actor-source"
              className="block text-sm font-medium text-foreground"
            >
              روش تعیین مسئول
            </label>
            <select
              id="commerce-step-actor-source"
              name="actorSource"
              value={actorSource}
              onChange={(event) => setActorSource(event.target.value)}
              disabled={pending}
              data-testid="commerce-workflow-step-actor-source"
              className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
            >
              <option value="">تعیین نشده</option>
              {COMMERCE_WORKFLOW_ACTOR_SOURCES.filter(
                (source) => source !== 'RULE_RESOLVER' || Boolean(step?.actorRule)
              ).map((source) => (
                <option key={source} value={source}>
                  {commerceWorkflowActorSourceLabel(source)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {!actorSource
                ? 'تا زمان تعیین مسئول، این نسخه قابل انتشار نیست.'
                : COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES.includes(
                      actorSource as (typeof COMMERCE_WORKFLOW_EXECUTABLE_ACTOR_SOURCES)[number]
                    )
                  ? 'این روش در نسخهٔ فعلی موتور گردش کار قابل اجرا و انتشار است.'
                  : 'در پیش‌نویس قابل ثبت است، اما انتشار نسخه با این روش در نسخهٔ فعلی موتور گردش کار پذیرفته نمی‌شود.'}
            </p>
            {!step?.actorRule && (
              <p className="text-xs text-muted-foreground">
                روش «تعیین بر اساس قاعده» فقط برای مراحلی که این قاعده را از قبل دارند نمایش
                داده می‌شود.
              </p>
            )}
          </div>

          {actorSource === 'CONFIGURED_USER' && (
            <CommerceMemberPicker
              id="commerce-step-actor-user"
              label="کاربر مسئول"
              value={actorUserId}
              onChange={setActorUserId}
              enabled={canReadDirectory}
              disabled={pending}
              limitationText="برای انتخاب کاربر از فهرست سازمانی، مجوز مشاهدهٔ دایرکتوری (admin.users.read) لازم است؛ این روش بدون آن قابل تنظیم نیست."
              testId="commerce-workflow-step-actor-user"
            />
          )}
          {errors.actorUserId && (
            <p
              role="alert"
              data-testid="commerce-workflow-step-actor-user-error"
              className="text-xs text-destructive"
            >
              {errors.actorUserId}
            </p>
          )}

          {actorSource === 'CONFIGURED_ROLE' && (
            <div className="space-y-1">
              <label
                htmlFor="commerce-step-actor-role"
                className="block text-sm font-medium text-foreground"
              >
                کد نقش{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <input
                id="commerce-step-actor-role"
                name="actorRoleCode"
                type="text"
                dir="ltr"
                value={actorRoleCode}
                onChange={(event) => setActorRoleCode(event.target.value)}
                aria-invalid={errors.actorRoleCode ? true : undefined}
                aria-describedby={
                  errors.actorRoleCode ? 'commerce-step-actor-role-error' : undefined
                }
                disabled={pending}
                data-testid="commerce-workflow-step-actor-role"
                className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
              />
              {errors.actorRoleCode ? (
                <p id="commerce-step-actor-role-error" className="text-xs text-destructive">
                  {errors.actorRoleCode}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  کد نقش سازمانی (مثلاً finance_approver)؛ اینکه چه کسی امروز این نقش را دارد،
                  موضوع سمت سرور است.
                </p>
              )}
            </div>
          )}

          {actorSource === 'RULE_RESOLVER' && (
            <p className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              قاعدهٔ ثبت‌شدهٔ این مرحله برای تعیین مسئول استفاده می‌شود و از این رابط قابل ویرایش
              نیست.
            </p>
          )}
        </section>

        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">شرط فعال‌سازی</h3>

          {isConditional ? (
            <>
              <CommerceWorkflowConditionEditor
                kind={conditionKind}
                simple={simpleCondition}
                complexPresent={initialKind === 'complex'}
                allowNone={false}
                disabled={pending}
                onKindChange={(kind) => {
                  setConditionKind(kind);
                  if (kind === 'simple' && !simpleCondition) {
                    setSimpleCondition({ field: 'totalAmount', op: 'greaterThan', value: 0 });
                  }
                }}
                onSimpleChange={setSimpleCondition}
                testId="commerce-workflow-step-condition"
              />
              {errors.condition && (
                <p
                  role="alert"
                  data-testid="commerce-workflow-step-condition-error"
                  className="text-xs text-destructive"
                >
                  {errors.condition}
                </p>
              )}

              <div className="space-y-1">
                <label
                  htmlFor="commerce-step-on-condition-false"
                  className="block text-sm font-medium text-foreground"
                >
                  اگر شرط برقرار نشد
                </label>
                <select
                  id="commerce-step-on-condition-false"
                  name="onConditionFalse"
                  value={onConditionFalse}
                  onChange={(event) => setOnConditionFalse(event.target.value)}
                  disabled={pending}
                  data-testid="commerce-workflow-step-on-condition-false"
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                >
                  <option value="">انتخاب نشده</option>
                  {COMMERCE_WORKFLOW_CONDITION_FALSE_BEHAVIORS.map((behavior) => (
                    <option key={behavior} value={behavior}>
                      {commerceWorkflowConditionFalseBehaviorLabel(behavior)}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  رفتار وقتی شرط برقرار نشود؛ برای انتشار این نسخه الزامی است.
                </p>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              شرط فقط برای حالت اجرای «شرطی» تعریف می‌شود؛ مراحل ترتیبی و موازی همیشه اجرا
              می‌شوند.
            </p>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">جزئیات فنی</h3>
          <p className="text-xs text-muted-foreground">
            این مقادیر بخشی از پیکربندی ثبت‌شده هستند و در حال حاضر فقط برای مطالعه نمایش داده
            می‌شوند.
          </p>

          {step && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span dir="ltr" className="rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
                {step.id}
              </span>
              <span title={step.updatedAt}>
                آخرین تغییر: {commerceInstantLabel(step.updatedAt)}
              </span>
            </div>
          )}

          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {step?.thresholds !== null && step?.thresholds !== undefined && (
              <li>آستانه‌هایی برای این مرحله ثبت شده است (ویرایش از این رابط پشتیبانی نمی‌شود).</li>
            )}
            {step?.lineFilters !== null && step?.lineFilters !== undefined && (
              <li className="text-destructive">
                محدودهٔ ردیف ثبت شده است؛ انتشار نسخه‌ای که این مقدار را داشته باشد در نسخهٔ فعلی
                موتور پذیرفته نمی‌شود.
              </li>
            )}
            {(() => {
              const configuration = step?.configuration;
              const visibleFields =
                configuration && typeof configuration === 'object' && !Array.isArray(configuration)
                  ? (configuration as { visibleFields?: unknown }).visibleFields
                  : undefined;
              return Array.isArray(visibleFields) && visibleFields.length > 0 ? (
                <li>
                  فیلدهای نمایشی:{' '}
                  {visibleFields
                    .filter((field): field is string => typeof field === 'string')
                    .join('، ')}
                </li>
              ) : null;
            })()}
            {(!step || (step.thresholds == null && step.lineFilters == null)) && (
              <li>مقادیر پیشرفته‌ای برای این مرحله ثبت نشده است.</li>
            )}
          </ul>
        </section>
      </form>
    </CommerceSettingsDialog>
  );
}
