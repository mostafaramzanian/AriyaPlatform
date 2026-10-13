'use client';

import * as React from 'react';

import { CoreError, CoreLoading } from '@/components/core/CoreStates';
import { Button } from '@/components/ui/button';
import {
  archiveCommerceCommercialConfiguration,
  COMMERCE_COMMERCIAL_APPROVAL_ACTIVATIONS,
  COMMERCE_COMMERCIAL_APPROVAL_APPROVERS,
  COMMERCE_COMMERCIAL_ASSIGNMENT_TRIGGERS,
  COMMERCE_COMMERCIAL_MATCH_BEHAVIORS,
  COMMERCE_COMMERCIAL_MAX_PRIORITY,
  COMMERCE_COMMERCIAL_MAX_RULE_LABEL_LENGTH,
  COMMERCE_COMMERCIAL_MAX_VERSION_LABEL_LENGTH,
  COMMERCE_COMMERCIAL_MIN_PRIORITY,
  COMMERCE_COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS,
  COMMERCE_COMMERCIAL_PROJECTION_POLICIES,
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_WORKFLOW_DOCUMENT_FACTS,
  COMMERCE_WORKFLOW_LINE_FACTS,
  createCommerceCommercialConfiguration,
  fetchCommerceCommercialConfigurations,
  fetchCommerceCommercialGroups,
  publishCommerceCommercialConfiguration,
  readCommerceCommercialAssignmentRules,
  readCommerceSimpleCondition,
  updateCommerceCommercialConfiguration,
  validateCommerceCommercialConfiguration,
  type CommerceCommercialApprovalActivation,
  type CommerceCommercialApprovalApprover,
  type CommerceCommercialAssignmentTrigger,
  type CommerceCommercialConfigurationInput,
  type CommerceCommercialConfigurationRecord,
  type CommerceCommercialGroup,
  type CommerceCommercialMatchBehavior,
  type CommerceCommercialNoAssignmentBehavior,
  type CommerceCommercialProjectionPolicy,
  type CommerceSimpleConditionDraft,
} from '@/lib/commerce-api';
import {
  commerceActionErrorMessage,
  commerceCommercialApprovalActivationLabel,
  commerceCommercialApprovalApproverLabel,
  commerceCommercialAssignmentTriggerLabel,
  commerceCommercialMatchBehaviorLabel,
  commerceCommercialNoAssignmentBehaviorLabel,
  commerceCommercialProjectionPolicyLabel,
  commerceInstantLabel,
  commerceWorkflowVersionStatusLabel,
  commerceWorkflowVersionStatusHint,
  commerceWorkflowVersionStatusTone,
} from '@/lib/commerce-labels';
import {
  CommerceBadge,
  CommerceFeedback,
  CommercePagination,
  CommerceSectionHeading,
} from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';
import { CommerceSettingsDialog } from './CommerceSettingsDialog';
import { useReloadToken } from '@/hooks/use-reload-token';
import { useCommerceDirtyFlag, useCommerceSettingsGuard } from './CommerceSettingsGuard';
import {
  CommerceWorkflowConditionEditor,
  conditionPayloadFor,
} from './CommerceWorkflowConditionEditor';
import { CommerceMemberPicker } from './CommerceMemberPicker';

/**
 * PHASE UI-4 (§13): پیکربندی بازرگانی — the six C1-P configuration routes, following the
 * EXACT backend lifecycle: create → DRAFT (editable) → validate (§7 checklist →
 * VALIDATED) → publish (archives the previously published version in the same act) →
 * PUBLISHED (immutable) → archive (one way). `VALIDATED` is a checkpoint, not a draft:
 * the form disappears at it, exactly as the service refuses any further edit.
 *
 * NO INVENTED DEFAULTS: every required select starts EMPTY («انتخاب کنید») and must be
 * chosen deliberately — pre-selecting a policy the administrator never picked would be
 * the UI deciding business semantics.
 *
 * CONDITION AUTHORING goes through the shared, type-paired condition editor: rules speak
 * the frozen LINE catalogue, the applicability bound speaks the frozen DOCUMENT
 * catalogue, and a stored composite tree is shown read-only rather than rewritten.
 */
type ConditionKind = 'none' | 'simple' | 'complex';

interface FormRule {
  /** Client-only identity for React keys (indexes churn under add/remove). */
  key: string;
  label: string;
  priority: string;
  commercialGroupId: string;
  conditionKind: ConditionKind;
  simpleCondition: CommerceSimpleConditionDraft | null;
  /** The STORED condition of a composite rule — kept so a save never rewrites it. */
  storedCondition?: Record<string, unknown> | null;
}

interface CommercialFormState {
  versionLabel: string;
  assignmentTrigger: string;
  noAssignmentBehavior: string;
  matchBehavior: string;
  approvalActivation: string;
  approvalApprover: string;
  approverUserId: string | null;
  projectionPolicy: string;
  rules: FormRule[];
  applicabilityKind: 'all' | 'simple' | 'complex';
  applicabilitySimple: CommerceSimpleConditionDraft | null;
  /** The STORED applicability bound when it is composite — preserved, never rewritten. */
  applicabilityStored: Record<string, unknown> | null;
}

let ruleSequence = 0;
function emptyRule(): FormRule {
  ruleSequence += 1;
  return {
    key: `rule-${ruleSequence}`,
    label: '',
    priority: '0',
    commercialGroupId: '',
    conditionKind: 'none',
    simpleCondition: null,
  };
}

function emptyForm(): CommercialFormState {
  return {
    versionLabel: '',
    assignmentTrigger: '',
    noAssignmentBehavior: '',
    matchBehavior: '',
    approvalActivation: '',
    approvalApprover: '',
    approverUserId: null,
    projectionPolicy: '',
    rules: [emptyRule()],
    applicabilityKind: 'all',
    applicabilitySimple: null,
    applicabilityStored: null,
  };
}

function conditionKindOf(value: unknown): ConditionKind {
  if (value === null || value === undefined) return 'none';
  return readCommerceSimpleCondition(value) ? 'simple' : 'complex';
}

function formFromRecord(record: CommerceCommercialConfigurationRecord): CommercialFormState {
  const applicability = record.applicabilityCondition;
  const applicabilityKind = conditionKindOf(applicability);
  return {
    versionLabel: record.versionLabel,
    assignmentTrigger: record.assignmentTrigger,
    noAssignmentBehavior: record.noAssignmentBehavior,
    matchBehavior: record.matchBehavior,
    approvalActivation: record.approvalActivation,
    approvalApprover: record.approvalApprover ?? '',
    approverUserId: record.approverUserId,
    projectionPolicy: record.projectionPolicy,
    rules: readCommerceCommercialAssignmentRules(record.assignmentRules).map((rule) => ({
      ...emptyRule(),
      label: rule.label,
      priority: String(rule.priority),
      commercialGroupId: rule.commercialGroupId,
      conditionKind: conditionKindOf(rule.condition),
      simpleCondition: rule.condition ? readCommerceSimpleCondition(rule.condition) : null,
      storedCondition:
        rule.condition && !readCommerceSimpleCondition(rule.condition)
          ? (rule.condition as Record<string, unknown>)
          : null,
    })),
    applicabilityKind: applicabilityKind === 'none' ? 'all' : applicabilityKind,
    applicabilitySimple:
      applicability && typeof applicability === 'object'
        ? readCommerceSimpleCondition(applicability)
        : null,
    applicabilityStored:
      applicability && typeof applicability === 'object' && !readCommerceSimpleCondition(applicability)
        ? (applicability as Record<string, unknown>)
        : null,
  };
}

export function CommerceCommercialConfigurationSettings({
  canConfigure,
  canReadDirectory,
}: {
  canConfigure: boolean;
  canReadDirectory: boolean;
}) {
  const { requestGuard } = useCommerceSettingsGuard();

  // LIST
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<{
    items: CommerceCommercialConfigurationRecord[];
    page: number;
    pageSize: number;
    total: number;
  } | null>(null);
  const [isLoading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in every list-refresh handler below (same commit
  // as the token bump) — the mount effect needs no in-effect setter resets,
  // and the mount itself is skeleton-armed (see `busy`).
  const { token: reloadToken, reload } = useReloadToken(setLoading, setError);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<CommerceCommercialConfigurationRecord | null>(
    null
  );

  // GROUPS — the options every assignment rule picks from.
  const [groups, setGroups] = React.useState<CommerceCommercialGroup[]>([]);
  const [groupsError, setGroupsError] = React.useState<string | null>(null);

  /*
   * ONE form model for BOTH surfaces (the create dialog and the draft editor): they are
   * never open at once, and two models would be two answers to "what did the user type".
   * `mode` says which surface owns it — and therefore which dirty flag is registered.
   */
  const [mode, setMode] = React.useState<'idle' | 'create' | 'edit'>('idle');
  const [form, setForm] = React.useState<CommercialFormState>(() => emptyForm());
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});
  const [formPending, setFormPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The baseline is component STATE with a lazy initializer: captured once
  // during the first render, never read/written as a ref during render
  // (`react-hooks/refs`), and re-baselined only inside event handlers and
  // settled callbacks — byte-identical behaviour to the previous ref.
  const [initialForm, setInitialForm] = React.useState(() => JSON.stringify(emptyForm()));

  const [publishOpen, setPublishOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [lifecyclePending, setLifecyclePending] = React.useState<
    'validate' | 'publish' | 'archive' | null
  >(null);
  const [lifecycleError, setLifecycleError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;

    fetchCommerceCommercialConfigurations({ page, pageSize: COMMERCE_DEFAULT_PAGE_SIZE })
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت پیکربندی‌ها با خطا مواجه شد.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [page, reloadToken]);

  React.useEffect(() => {
    let active = true;
    // The group catalogue for the rule selects: one page is the whole tenant catalogue
    // for any realistic configuration, and the API caps it at the shared ceiling.
    fetchCommerceCommercialGroups({ page: 1, pageSize: 100 })
      .then((result) => {
        if (!active) return;
        setGroups(result.items);
        setGroupsError(null);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setGroupsError(
          err instanceof Error ? err.message : 'دریافت گروه‌های بازرگانی با خطا مواجه شد.'
        );
      });

    return () => {
      active = false;
    };
  }, [reloadToken]);

  const dirty = mode !== 'idle' && JSON.stringify(form) !== initialForm;
  useCommerceDirtyFlag(`commercial-config-${mode}`, dirty);

  const openCreate = () => {
    const next = emptyForm();
    setForm(next);
    setInitialForm(JSON.stringify(next));
    setFormErrors({});
    setFormError(null);
    setMode('create');
  };

  const openEditor = (record: CommerceCommercialConfigurationRecord) => {
    if (selected?.id === record.id) return;
    requestGuard(() => {
      const next = formFromRecord(record);
      setForm(next);
      setInitialForm(JSON.stringify(next));
      setFormErrors({});
      setFormError(null);
      setLifecycleError(null);
      setSelected(record);
      setMode('edit');
    });
  };

  const closeSurface = () => {
    requestGuard(() => {
      setMode('idle');
      setSelected(null);
      reload();
    });
  };

  /**
   * THE CLIENT HALF OF §19: mirrors the DTO's SHAPE rules (bounds, closed vocabularies,
   * at least one rule, an integer priority inside the engine's own range). The §7
   * checklist — group membership, catalogue-allowed facts, approver timing — is NOT
   * pre-empted here: it belongs to `validate`/`publish`, which report it with the
   * backend's own words, and a browser that guessed those verdicts would be a second
   * evaluator.
   */
  const validateForm = (): boolean => {
    const next: Record<string, string> = {};
    const label = form.versionLabel.trim();
    if (!label) {
      next.versionLabel = 'برچسب نسخه را وارد کنید.';
    } else if (label.length > COMMERCE_COMMERCIAL_MAX_VERSION_LABEL_LENGTH) {
      next.versionLabel = `برچسب نسخه حداکثر ${COMMERCE_COMMERCIAL_MAX_VERSION_LABEL_LENGTH} نویسه است.`;
    }
    if (!form.assignmentTrigger) next.assignmentTrigger = 'زمان واگذاری ردیف‌ها را انتخاب کنید.';
    if (!form.noAssignmentBehavior) next.noAssignmentBehavior = 'رفتار «بدون گروه» را انتخاب کنید.';
    if (!form.matchBehavior) next.matchBehavior = 'رفتار «چند قاعده هم‌زمان» را انتخاب کنید.';
    if (!form.approvalActivation) next.approvalActivation = 'زمان فعال‌سازی تأیید بازرگانی را انتخاب کنید.';
    if (!form.projectionPolicy) next.projectionPolicy = 'سیاست نتیجه‌گیری سند را انتخاب کنید.';

    form.rules.forEach((rule, index) => {
      const ruleLabel = rule.label.trim();
      if (!ruleLabel) {
        next[`rule-${index}-label`] = 'برچسب قاعده را وارد کنید.';
      } else if (ruleLabel.length > COMMERCE_COMMERCIAL_MAX_RULE_LABEL_LENGTH) {
        next[`rule-${index}-label`] = `برچسب قاعده حداکثر ${COMMERCE_COMMERCIAL_MAX_RULE_LABEL_LENGTH} نویسه است.`;
      }
      const priority = Number(rule.priority);
      if (
        rule.priority.trim() === '' ||
        !Number.isSafeInteger(priority) ||
        priority < COMMERCE_COMMERCIAL_MIN_PRIORITY ||
        priority > COMMERCE_COMMERCIAL_MAX_PRIORITY
      ) {
        next[`rule-${index}-priority`] = 'اولویت باید عددی صحیح در بازهٔ مجاز موتور باشد.';
      }
      if (!rule.commercialGroupId) {
        next[`rule-${index}-group`] = 'گروه این قاعده را انتخاب کنید.';
      }
      if (rule.conditionKind === 'simple' && rule.simpleCondition) {
        const value = rule.simpleCondition.value;
        const takesValue = rule.simpleCondition.op !== 'isEmpty' && rule.simpleCondition.op !== 'isNotEmpty';
        if (takesValue && (value === undefined || value === '')) {
          next[`rule-${index}-condition`] = 'مقدار شرط این قاعده را وارد کنید.';
        } else if (typeof value === 'number' && !Number.isFinite(value)) {
          next[`rule-${index}-condition`] = 'مقدار شرط باید عددی معتبر باشد.';
        }
      }
    });

    setFormErrors(next);
    return Object.keys(next).length === 0;
  };

  /** Every field the form models, as the wire shape both POST and PATCH accept. */
  const buildPayload = (): CommerceCommercialConfigurationInput => ({
    versionLabel: form.versionLabel.trim(),
    assignmentTrigger: form.assignmentTrigger as CommerceCommercialAssignmentTrigger,
    noAssignmentBehavior: form.noAssignmentBehavior as CommerceCommercialNoAssignmentBehavior,
    matchBehavior: form.matchBehavior as CommerceCommercialMatchBehavior,
    assignmentRules: form.rules.map((rule) => ({
      label: rule.label.trim(),
      priority: Number(rule.priority),
      commercialGroupId: rule.commercialGroupId,
      condition:
        rule.conditionKind === 'simple'
          ? conditionPayloadFor('simple', rule.simpleCondition)
          : rule.conditionKind === 'complex'
            ? (rule.storedCondition ?? null)
            : null,
    })),
    approvalActivation: form.approvalActivation as CommerceCommercialApprovalActivation,
    approvalApprover: (form.approvalApprover === ''
      ? null
      : (form.approvalApprover as CommerceCommercialApprovalApprover)),
    approverUserId: form.approvalApprover === 'CONFIGURED_USER' ? form.approverUserId : null,
    applicabilityCondition:
      form.applicabilityKind === 'simple'
        ? conditionPayloadFor('simple', form.applicabilitySimple)
        : form.applicabilityKind === 'complex'
          ? (form.applicabilityStored ?? null)
          : null,
    projectionPolicy: form.projectionPolicy as CommerceCommercialProjectionPolicy,
  });

  const submitCreate = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (formPending) return;
    if (!validateForm()) return;

    setFormPending(true);
    setFormError(null);
    createCommerceCommercialConfiguration(buildPayload())
      .then((created) => {
        setFormPending(false);
        setMode('idle');
        setFeedback(
          `پیکربندی «${created.versionLabel}» به‌صورت پیش‌نویس ساخته شد؛ پس از تکمیل، آن را اعتبارسنجی و منتشر کنید.`
        );
        reload();
      })
      .catch((err: unknown) => {
        setFormPending(false);
        setFormError(commerceActionErrorMessage(err, 'ایجاد پیکربندی انجام نشد.'));
      });
  };

  const submitSave = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!selected || formPending) return;
    if (!validateForm()) return;

    setFormPending(true);
    setFormError(null);
    updateCommerceCommercialConfiguration(selected.id, buildPayload())
      .then((updated) => {
        setFormPending(false);
        setSelected(updated);
        const next = formFromRecord(updated);
        setForm(next);
        setInitialForm(JSON.stringify(next));
        setFeedback('پیش‌نویس پیکربندی ذخیره شد.');
        reload();
      })
      .catch((err: unknown) => {
        setFormPending(false);
        setFormError(commerceActionErrorMessage(err, 'ذخیرهٔ پیکربندی انجام نشد.'));
      });
  };

  const runValidate = () => {
    if (!selected || lifecyclePending) return;
    setLifecyclePending('validate');
    setLifecycleError(null);
    validateCommerceCommercialConfiguration(selected.id)
      .then((updated) => {
        setLifecyclePending(null);
        setSelected(updated);
        const next = formFromRecord(updated);
        setForm(next);
        setInitialForm(JSON.stringify(next));
        setFeedback('پیکربندی اعتبارسنجی شد و اکنون آمادهٔ انتشار است.');
        reload();
      })
      .catch((err: unknown) => {
        setLifecyclePending(null);
        setLifecycleError(commerceActionErrorMessage(err, 'اعتبارسنجی پیکربندی انجام نشد.'));
      });
  };

  const runPublish = () => {
    if (!selected || lifecyclePending) return;
    setLifecyclePending('publish');
    setLifecycleError(null);
    publishCommerceCommercialConfiguration(selected.id)
      .then((updated) => {
        setLifecyclePending(null);
        setPublishOpen(false);
        setSelected(updated);
        const next = formFromRecord(updated);
        setForm(next);
        setInitialForm(JSON.stringify(next));
        setFeedback(
          'پیکربندی منتشر شد؛ نسخهٔ منتشرشدهٔ پیشین به‌صورت خودکار آرشیو شد و این نسخه دیگر قابل ویرایش نیست.'
        );
        reload();
      })
      .catch((err: unknown) => {
        setLifecyclePending(null);
        setLifecycleError(commerceActionErrorMessage(err, 'انتشار پیکربندی انجام نشد.'));
      });
  };

  const runArchive = () => {
    if (!selected || lifecyclePending) return;
    setLifecyclePending('archive');
    setLifecycleError(null);
    archiveCommerceCommercialConfiguration(selected.id)
      .then((updated) => {
        setLifecyclePending(null);
        setArchiveOpen(false);
        setSelected(updated);
        const next = formFromRecord(updated);
        setForm(next);
        setInitialForm(JSON.stringify(next));
        setFeedback('پیکربندی آرشیو شد و از جریان خارج گردید.');
        reload();
      })
      .catch((err: unknown) => {
        setLifecyclePending(null);
        setLifecycleError(commerceActionErrorMessage(err, 'آرشیو پیکربندی انجام نشد.'));
      });
  };

  const configurations = data?.items ?? [];
  const showInitialLoading = isLoading && data === null;
  // Mount is fetch-driven with a cold `data: null`, so derive the skeleton for
  // the very first response (`isLoading` starts false and arms only retries —
  // see the hook above). This mirrors the `busy` term of every other list view.
  const busy = isLoading || (data === null && error === null);
  const selectedIsDraft = selected?.status === 'DRAFT';

  const updateForm = <K extends keyof CommercialFormState>(key: K, next: CommercialFormState[K]) =>
    setForm((current) => ({ ...current, [key]: next }));

  const updateRule = (index: number, patch: Partial<FormRule>) =>
    setForm((current) => ({
      ...current,
      rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }));

  const fieldDisabled = mode === 'edit' && !selectedIsDraft;

  /*
   * ONE control block for BOTH surfaces — the create dialog and the draft editor render
   * the identical fields, so the two can never drift on what a configuration states.
   */
  const formFields = (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-label"
            className="block text-sm font-medium text-foreground"
          >
            برچسب نسخه{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <input
            id="commerce-commercial-label"
            name="versionLabel"
            type="text"
            value={form.versionLabel}
            onChange={(event) => updateForm('versionLabel', event.target.value)}
            aria-invalid={formErrors.versionLabel ? true : undefined}
            aria-describedby={
              formErrors.versionLabel ? 'commerce-commercial-label-error' : undefined
            }
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-version-label"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          />
          {formErrors.versionLabel && (
            <p id="commerce-commercial-label-error" className="text-xs text-destructive">
              {formErrors.versionLabel}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-trigger"
            className="block text-sm font-medium text-foreground"
          >
            زمان واگذاری ردیف‌ها{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <select
            id="commerce-commercial-trigger"
            name="assignmentTrigger"
            value={form.assignmentTrigger}
            onChange={(event) => updateForm('assignmentTrigger', event.target.value)}
            aria-invalid={formErrors.assignmentTrigger ? true : undefined}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-assignment-trigger"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">انتخاب کنید</option>
            {COMMERCE_COMMERCIAL_ASSIGNMENT_TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>
                {commerceCommercialAssignmentTriggerLabel(trigger)}
              </option>
            ))}
          </select>
          {formErrors.assignmentTrigger && (
            <p className="text-xs text-destructive">{formErrors.assignmentTrigger}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-no-assignment"
            className="block text-sm font-medium text-foreground"
          >
            ردیف بدون گروه{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <select
            id="commerce-commercial-no-assignment"
            name="noAssignmentBehavior"
            value={form.noAssignmentBehavior}
            onChange={(event) => updateForm('noAssignmentBehavior', event.target.value)}
            aria-invalid={formErrors.noAssignmentBehavior ? true : undefined}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-no-assignment-behavior"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">انتخاب کنید</option>
            {COMMERCE_COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS.map((behavior) => (
              <option key={behavior} value={behavior}>
                {commerceCommercialNoAssignmentBehaviorLabel(behavior)}
              </option>
            ))}
          </select>
          {formErrors.noAssignmentBehavior && (
            <p className="text-xs text-destructive">{formErrors.noAssignmentBehavior}</p>
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-match"
            className="block text-sm font-medium text-foreground"
          >
            چند قاعدهٔ هم‌زمان{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <select
            id="commerce-commercial-match"
            name="matchBehavior"
            value={form.matchBehavior}
            onChange={(event) => updateForm('matchBehavior', event.target.value)}
            aria-invalid={formErrors.matchBehavior ? true : undefined}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-match-behavior"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">انتخاب کنید</option>
            {COMMERCE_COMMERCIAL_MATCH_BEHAVIORS.map((behavior) => (
              <option key={behavior} value={behavior}>
                {commerceCommercialMatchBehaviorLabel(behavior)}
              </option>
            ))}
          </select>
          {formErrors.matchBehavior && (
            <p className="text-xs text-destructive">{formErrors.matchBehavior}</p>
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-activation"
            className="block text-sm font-medium text-foreground"
          >
            فعال‌سازی تأیید بازرگانی{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <select
            id="commerce-commercial-activation"
            name="approvalActivation"
            value={form.approvalActivation}
            onChange={(event) => updateForm('approvalActivation', event.target.value)}
            aria-invalid={formErrors.approvalActivation ? true : undefined}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-approval-activation"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">انتخاب کنید</option>
            {COMMERCE_COMMERCIAL_APPROVAL_ACTIVATIONS.map((activation) => (
              <option key={activation} value={activation}>
                {commerceCommercialApprovalActivationLabel(activation)}
              </option>
            ))}
          </select>
          {formErrors.approvalActivation && (
            <p className="text-xs text-destructive">{formErrors.approvalActivation}</p>
          )}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-projection"
            className="block text-sm font-medium text-foreground"
          >
            نتیجه‌گیری سند پس از تأییدها{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </label>
          <select
            id="commerce-commercial-projection"
            name="projectionPolicy"
            value={form.projectionPolicy}
            onChange={(event) => updateForm('projectionPolicy', event.target.value)}
            aria-invalid={formErrors.projectionPolicy ? true : undefined}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-projection-policy"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">انتخاب کنید</option>
            {COMMERCE_COMMERCIAL_PROJECTION_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {commerceCommercialProjectionPolicyLabel(policy)}
              </option>
            ))}
          </select>
          {formErrors.projectionPolicy && (
            <p className="text-xs text-destructive">{formErrors.projectionPolicy}</p>
          )}
        </div>
      </div>


      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="commerce-commercial-approver"
            className="block text-sm font-medium text-foreground"
          >
            تصمیم‌گیرندهٔ تأیید بازرگانی
          </label>
          <select
            id="commerce-commercial-approver"
            name="approvalApprover"
            value={form.approvalApprover}
            onChange={(event) => updateForm('approvalApprover', event.target.value)}
            disabled={formPending || fieldDisabled}
            data-testid="commerce-commercial-approval-approver"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
          >
            <option value="">تعیین نشده</option>
            {COMMERCE_COMMERCIAL_APPROVAL_APPROVERS.map((approver) => (
              <option key={approver} value={approver}>
                {commerceCommercialApprovalApproverLabel(approver)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {form.approvalActivation !== '' && form.approvalActivation !== 'NOT_REQUIRED' && !form.approvalApprover
              ? 'برای این زمان فعال‌سازی، تعیین تصمیم‌گیرنده در اعتبارسنجی و انتشار لازم است.'
              : 'بدون تأیید بازرگانی، این مقدار خوانده نمی‌شود.'}
          </p>
        </div>
      </div>

      {form.approvalApprover === 'CONFIGURED_USER' && (
        <CommerceMemberPicker
          id="commerce-commercial-approver-user"
          label="کاربر تصمیم‌گیرنده"
          value={form.approverUserId}
          onChange={(id) => updateForm('approverUserId', id)}
          enabled={canReadDirectory}
          disabled={formPending || fieldDisabled}
          limitationText="برای انتخاب کاربر، مجوز مشاهدهٔ فهرست سازمانی (admin.users.read) لازم است؛ با این تصمیم‌گیرنده، اعتبارسنجی و انتشار بدون انتخاب کاربر انجام نمی‌شود."
          helper="این کاربر باید عضو همین سازمان باشد."
          testId="commerce-commercial-approver-user"
        />
      )}


      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">قواعد واگذاری ردیف‌ها</h4>
          {!fieldDisabled && (
            <Button
              type="button"
              onClick={() =>
                setForm((current) => ({ ...current, rules: [...current.rules, emptyRule()] }))
              }
              disabled={formPending}
              data-testid="commerce-commercial-rule-add"
              className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
            >
              افزودن قاعده
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          هر ردیف خرید بر اساس این قواعد به یک گروه بازرگانی هدایت می‌شود؛ حداقل یک قاعده لازم
          است.
        </p>
        {groupsError && (
          <p
            role="alert"
            data-testid="commerce-commercial-groups-error"
            className="text-xs text-destructive"
          >
            دریافت گروه‌های بازرگانی ممکن نشد؛ تا رفع آن، انتخاب گروه در قواعد ممکن نیست.
          </p>
        )}

        <ul className="space-y-3">
          {form.rules.map((rule, index) => (
            <li
              key={rule.key}
              data-testid={`commerce-commercial-rule-${index}`}
              className="space-y-3 rounded-xl border border-border bg-background p-3"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <label
                    htmlFor={`commerce-commercial-rule-label-${index}`}
                    className="block text-xs font-medium text-foreground"
                  >
                    برچسب قاعده
                  </label>
                  <input
                    id={`commerce-commercial-rule-label-${index}`}
                    type="text"
                    value={rule.label}
                    onChange={(event) => updateRule(index, { label: event.target.value })}
                    aria-invalid={formErrors[`rule-${index}-label`] ? true : undefined}
                    disabled={formPending || fieldDisabled}
                    data-testid={`commerce-commercial-rule-label-${index}`}
                    className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                  />
                  {formErrors[`rule-${index}-label`] && (
                    <p className="text-xs text-destructive">{formErrors[`rule-${index}-label`]}</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor={`commerce-commercial-rule-priority-${index}`}
                    className="block text-xs font-medium text-foreground"
                  >
                    اولویت
                  </label>
                  <input
                    id={`commerce-commercial-rule-priority-${index}`}
                    type="number"
                    step={1}
                    value={rule.priority}
                    onChange={(event) => updateRule(index, { priority: event.target.value })}
                    aria-invalid={formErrors[`rule-${index}-priority`] ? true : undefined}
                    disabled={formPending || fieldDisabled}
                    data-testid={`commerce-commercial-rule-priority-${index}`}
                    className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                  />
                  {formErrors[`rule-${index}-priority`] && (
                    <p className="text-xs text-destructive">
                      {formErrors[`rule-${index}-priority`]}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor={`commerce-commercial-rule-group-${index}`}
                    className="block text-xs font-medium text-foreground"
                  >
                    گروه بازرگانی
                  </label>
                  <select
                    id={`commerce-commercial-rule-group-${index}`}
                    value={rule.commercialGroupId}
                    onChange={(event) =>
                      updateRule(index, { commercialGroupId: event.target.value })
                    }
                    aria-invalid={formErrors[`rule-${index}-group`] ? true : undefined}
                    disabled={formPending || fieldDisabled || groups.length === 0}
                    data-testid={`commerce-commercial-rule-group-${index}`}
                    className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                  >
                    <option value="">انتخاب کنید</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  {formErrors[`rule-${index}-group`] && (
                    <p className="text-xs text-destructive">
                      {formErrors[`rule-${index}-group`]}
                    </p>
                  )}
                </div>
              </div>

              <CommerceWorkflowConditionEditor
                kind={rule.conditionKind}
                simple={rule.simpleCondition}
                complexPresent={rule.conditionKind === 'complex' && Boolean(rule.storedCondition)}
                facts={COMMERCE_WORKFLOW_LINE_FACTS}
                onKindChange={(kind) =>
                  updateRule(index, {
                    conditionKind: kind,
                    ...(kind === 'simple' && !rule.simpleCondition
                      ? { simpleCondition: { field: 'lineType', op: 'equals', value: 'STANDARD' } }
                      : {}),
                  })
                }
                onSimpleChange={(draft) => updateRule(index, { simpleCondition: draft })}
                disabled={formPending || fieldDisabled}
                testId={`commerce-commercial-rule-condition-${index}`}
              />
              {formErrors[`rule-${index}-condition`] && (
                <p className="text-xs text-destructive">{formErrors[`rule-${index}-condition`]}</p>
              )}

              {!fieldDisabled && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        rules: current.rules.filter((_, position) => position !== index),
                      }))
                    }
                    disabled={formPending || form.rules.length <= 1}
                    data-testid={`commerce-commercial-rule-remove-${index}`}
                    className="border border-destructive/30 bg-background text-xs text-destructive hover:bg-destructive/10"
                  >
                    حذف قاعده
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>


      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">شرط اعمال پیکربندی</h4>
        <CommerceWorkflowConditionEditor
          kind={form.applicabilityKind === 'all' ? 'none' : form.applicabilityKind}
          simple={form.applicabilitySimple}
          complexPresent={form.applicabilityKind === 'complex'}
          facts={COMMERCE_WORKFLOW_DOCUMENT_FACTS}
          allowNone
          onKindChange={(kind) => updateForm('applicabilityKind', kind === 'none' ? 'all' : kind)}
          onSimpleChange={(draft) => {
            updateForm('applicabilitySimple', draft);
            updateForm('applicabilityKind', 'simple');
          }}
          disabled={formPending || fieldDisabled}
          testId="commerce-commercial-applicability"
        />
        <p className="text-xs text-muted-foreground">
          «بدون شرط» یعنی این پیکربندی برای همهٔ ردیف‌های واگذارشده اعمال می‌شود؛ شرط بر پایهٔ
          مشخصات سند درخواست خرید سنجیده می‌شود.
        </p>
      </div>
    </>
  );


  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <CommerceSectionHeading
        title="پیکربندی بازرگانی"
        description="نحوهٔ واگذاری ردیف‌ها به گروه‌ها، رفتار ردیف بدون گروه و تأیید بازرگانی را تعیین می‌کند. هر پیکربندی نسخه‌دار است؛ نسخهٔ منتشرشده تغییرناپذیر است."
        actions={
          canConfigure && mode === 'idle' ? (
            <Button
              type="button"
              onClick={openCreate}
              data-testid="commerce-commercial-config-create-open"
              className="text-xs"
            >
              پیکربندی جدید
            </Button>
          ) : undefined
        }
      />

      <CommerceFeedback message={feedback} testId="commerce-commercial-config-feedback" />

      {mode === 'edit' && selected ? (
        <div className="space-y-4" data-testid="commerce-commercial-config-editor">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <button
                type="button"
                onClick={closeSurface}
                data-testid="commerce-commercial-config-back"
                className="rounded-lg text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
              >
                → بازگشت به فهرست پیکربندی‌ها
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-foreground">
                  پیکربندی «{selected.versionLabel}»
                </h4>
                <CommerceBadge
                  tone={commerceWorkflowVersionStatusTone(selected.status)}
                  testId={`commerce-commercial-config-status-${selected.status}`}
                >
                  {commerceWorkflowVersionStatusLabel(selected.status)}
                </CommerceBadge>
              </div>
              <p className="text-xs text-muted-foreground">
                {commerceWorkflowVersionStatusHint(selected.status)}
              </p>
              <p className="text-xs text-muted-foreground" title={selected.updatedAt}>
                آخرین تغییر: {commerceInstantLabel(selected.updatedAt)}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {selectedIsDraft && canConfigure && (
                <>
                  <Button
                    type="button"
                    onClick={() => submitSave()}
                    disabled={!dirty || formPending}
                    aria-busy={formPending}
                    data-testid="commerce-commercial-config-save"
                    className={
                      dirty
                        ? 'text-xs'
                        : 'border border-border bg-background text-xs text-foreground'
                    }
                  >
                    ذخیرهٔ پیش‌نویس
                  </Button>
                  <Button
                    type="button"
                    onClick={runValidate}
                    disabled={formPending || lifecyclePending !== null || dirty}
                    aria-busy={lifecyclePending === 'validate'}
                    data-testid="commerce-commercial-config-validate"
                    className="text-xs"
                  >
                    اعتبارسنجی
                  </Button>
                </>
              )}
              {selected.status === 'VALIDATED' && canConfigure && (
                <Button
                  type="button"
                  onClick={() => {
                    setLifecycleError(null);
                    setPublishOpen(true);
                  }}
                  disabled={lifecyclePending !== null}
                  data-testid="commerce-commercial-config-publish-open"
                  className="text-xs"
                >
                  بررسی و انتشار
                </Button>
              )}
              {selected.status === 'PUBLISHED' && canConfigure && (
                <Button
                  type="button"
                  onClick={() => {
                    setLifecycleError(null);
                    setArchiveOpen(true);
                  }}
                  disabled={lifecyclePending !== null}
                  data-testid="commerce-commercial-config-archive-open"
                  className="border border-border bg-background text-xs text-foreground hover:bg-secondary"
                >
                  آرشیو کردن
                </Button>
              )}
            </div>
          </div>

          {dirty && selectedIsDraft && (
            <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
              تغییرات ذخیره‌نشده دارید؛ برای اعتبارسنجی یا انتشار، ابتدا «ذخیرهٔ پیش‌نویس» را
              بزنید.
            </p>
          )}

          {lifecycleError && (
            <p
              role="alert"
              data-testid="commerce-commercial-config-error"
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {lifecycleError}
            </p>
          )}

          <form
            id="commerce-commercial-edit-form"
            onSubmit={submitSave}
            className="space-y-6"
          >
            {formError && (
              <p
                role="alert"
                data-testid="commerce-commercial-config-form-error"
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {formError}
              </p>
            )}
            <fieldset disabled={!selectedIsDraft} className="space-y-6 disabled:opacity-100">
              {formFields}
            </fieldset>
          </form>
        </div>
      ) : (

        <div data-testid="commerce-commercial-config-list">
          {showInitialLoading || busy ? (
            <CoreLoading lines={4} />
          ) : error ? (
            <CoreError message={error} onRetry={reload} />
          ) : configurations.length === 0 ? (
            <div data-testid="commerce-commercial-config-empty">
              <p className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center text-sm text-muted-foreground">
                هنوز پیکربندی بازرگانی ثبت نشده است.
              </p>
              {canConfigure && (
                <div className="mt-4 flex justify-center">
                  <Button type="button" onClick={openCreate} className="text-xs">
                    ایجاد پیکربندی
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              <ul
                className="divide-y divide-border"
                data-testid="commerce-commercial-config-rows"
              >
                {configurations.map((configuration) => (
                  <li
                    key={configuration.id}
                    data-testid={`commerce-commercial-config-${configuration.versionLabel}`}
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {configuration.versionLabel}
                        </span>
                        <CommerceBadge
                          tone={commerceWorkflowVersionStatusTone(configuration.status)}
                          testId={`commerce-commercial-config-row-status-${configuration.status}`}
                        >
                          {commerceWorkflowVersionStatusLabel(configuration.status)}
                        </CommerceBadge>
                        {configuration.status === 'PUBLISHED' && (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                            در جریان
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground" title={configuration.updatedAt}>
                        آخرین تغییر: {commerceInstantLabel(configuration.updatedAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      onClick={() => openEditor(configuration)}
                      data-testid={`commerce-commercial-config-open-${configuration.versionLabel}`}
                      className={
                        configuration.status === 'DRAFT'
                          ? 'text-xs'
                          : 'border border-border bg-background text-xs text-foreground hover:bg-secondary'
                      }
                    >
                      {configuration.status === 'DRAFT' ? 'ویرایش و انتشار' : 'مشاهده و مدیریت'}
                    </Button>
                  </li>
                ))}
              </ul>

              <CommercePagination
                page={data?.page ?? page}
                pageSize={data?.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE}
                total={data?.total ?? 0}
                onPageChange={(next) => {
                  // Page changes re-arm in the same handler commit (the removed
                  // in-effect setters used to arm one render later).
                  setLoading(true);
                  setError(null);
                  setPage(next);
                }}
                disabled={isLoading}
              />
            </>
          )}
        </div>
      )}

      <CommerceSettingsDialog
        open={mode === 'create'}
        title="پیکربندی بازرگانی جدید"
        description="نسخهٔ جدید به‌صورت پیش‌نویس ساخته می‌شود؛ همهٔ انتخاب‌ها باید آگاهانه ثبت شوند."
        pending={formPending}
        onCancel={() => {
          if (!formPending) setMode('idle');
        }}
        testId="commerce-commercial-config-create-dialog"
        footer={
          <>
            <Button
              type="button"
              disabled={formPending}
              onClick={() => setMode('idle')}
              className="border border-border bg-background text-foreground hover:bg-secondary"
            >
              انصراف
            </Button>
            <Button
              type="button"
              onClick={() => submitCreate()}
              disabled={formPending}
              aria-busy={formPending}
              data-testid="commerce-commercial-config-create-submit"
            >
              {formPending ? 'در حال ایجاد…' : 'ایجاد پیش‌نویس'}
            </Button>
          </>
        }
      >
        <form id="commerce-commercial-create-form" onSubmit={submitCreate} className="space-y-6">
          {formError && (
            <p
              role="alert"
              data-testid="commerce-commercial-config-create-error"
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {formError}
            </p>
          )}
          {formFields}
        </form>
      </CommerceSettingsDialog>

      <CommerceConfirmDialog
        open={publishOpen}
        title="بررسی پیش از انتشار پیکربندی"
        description={
          selected
            ? `پیکربندی «${selected.versionLabel}» پس از انتشار، مبنای واگذاری و تأیید بازرگانی ردیف‌های جدید می‌شود.`
            : undefined
        }
        consequences="نسخهٔ منتشرشده قابل ویرایش نیست و نسخهٔ منتشرشدهٔ پیشین به‌صورت خودکار آرشیو می‌شود."
        confirmLabel="انتشار پیکربندی"
        pending={lifecyclePending === 'publish'}
        onConfirm={runPublish}
        onCancel={() => {
          if (lifecyclePending !== 'publish') setPublishOpen(false);
        }}
        testId="commerce-commercial-config-publish-dialog"
      />

      <CommerceConfirmDialog
        open={archiveOpen}
        title="آرشیو کردن پیکربندی"
        description={
          selected ? `پیکربندی «${selected.versionLabel}» از جریان خارج می‌شود.` : undefined
        }
        consequences="این اقدام بازگشت‌پذیر نیست؛ پس از آن تا انتشار نسخهٔ جدید، اثر خودکار بازرگانی متوقف می‌ماند."
        confirmLabel="آرشیو کن"
        confirmTone="danger"
        pending={lifecyclePending === 'archive'}
        onConfirm={runArchive}
        onCancel={() => {
          if (lifecyclePending !== 'archive') setArchiveOpen(false);
        }}
        testId="commerce-commercial-config-archive-dialog"
      />
    </section>
  );
}
