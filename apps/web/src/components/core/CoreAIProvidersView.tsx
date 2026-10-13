'use client';

import * as React from 'react';
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import {
  MAX_AI_BASE_URL,
  MAX_AI_CREDENTIAL,
  MAX_AI_MODEL_NAME,
  aiCapabilityLabel,
  aiProviderLabel,
  configurableCapabilities,
  createAIProviderConfig,
  credentialStatusLabel,
  deleteAIProviderConfig,
  formatAITime,
  listAIProviderConfigs,
  providersForCapability,
  testAIProviderConnection,
  unsupportedCapabilityReason,
  updateAIProviderConfig,
  type AICapability,
  type AIProviderConfig,
  type AIProviderDescriptor,
  type AIProviderKey,
} from '@/lib/ai-api';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useCorePermissions } from './useCorePermissions';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49J-0: AI provider configuration screen.
 *
 * Backed by `/admin/ai/providers`, which is gated on `admin.ai.read` for the two reads
 * and `admin.ai.manage` for every write AND for the connection test. Both permissions
 * are seeded in core_db, so gating the UI on them is real rather than decorative — but
 * it is still presentation only: the controller enforces the same strings.
 *
 * WHY THE TEST BUTTON SITS BEHIND THE WRITE PERMISSION: a probe spends money against the
 * operator's provider account and accepts an unsaved key. Showing it to a read-only
 * OPERATIONS_ADMIN would invite a 403 on every click.
 *
 * A CREDENTIAL IS NEVER RENDERED. The server has no projection that returns one, so the
 * form's key field starts EMPTY on every edit and an empty field means "leave the stored
 * key untouched" — exactly what the PATCH contract does with an omitted `credential`.
 * Removing a key is the explicit checkbox, which the server refuses to accept alongside
 * a new key.
 *
 * THE CAPABILITY MATRIX COMES FROM THE SERVER. The selectors are built from the
 * `providers` payload, so a provider/capability pair the backend cannot serve is not
 * offerable — and when a capability has no capable provider at all, the form says so
 * instead of accepting a row that would fail at runtime.
 */

const READ_PERMISSION = 'admin.ai.read';
const MANAGE_PERMISSION = 'admin.ai.manage';

interface FormState {
  provider: AIProviderKey | '';
  capability: AICapability | '';
  modelName: string;
  baseUrl: string;
  credential: string;
  clearCredential: boolean;
  enabled: boolean;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = {
  provider: '',
  capability: '',
  modelName: '',
  baseUrl: '',
  credential: '',
  clearCredential: false,
  enabled: false,
  isDefault: false,
};

/**
 * Seeds the edit form from a row. `credential` is ALWAYS empty — there is nothing to
 * seed it from, and a placeholder would imply the key had been read back.
 */
function formFor(config: AIProviderConfig): FormState {
  return {
    provider: config.provider,
    capability: config.capability,
    modelName: config.modelName,
    baseUrl: config.baseUrl ?? '',
    credential: '',
    clearCredential: false,
    enabled: config.enabled,
    isDefault: config.isDefault,
  };
}

export function CoreAIProvidersView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);
  // `admin.ai.manage` does NOT imply `admin.ai.read`: the controller gates the two
  // reads on the read string specifically, so the view is gated on it too rather than
  // on either-of.
  const canRead = permissions.includes(READ_PERMISSION);
  const canManage = permissions.includes(MANAGE_PERMISSION);

  const [configs, setConfigs] = React.useState<AIProviderConfig[]>([]);
  const [providers, setProviders] = React.useState<AIProviderDescriptor[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect needs no in-effect setter resets. First mount
  // is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const [isFormOpen, setIsFormOpen] = React.useState(false);
  /** null while creating; a row id while editing. */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const [notice, setNotice] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<{
    id: string;
    status: 'SUCCESS' | 'FAILURE';
    message: string;
  } | null>(null);

  // No request is issued without the read permission: it would be a guaranteed 403.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let cancelled = false;

    listAIProviderConfigs()
      .then((result) => {
        if (cancelled) return;
        setConfigs(result.configs);
        setProviders(result.providers);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfigs([]);
        setProviders([]);
        setError({
          message:
            err instanceof Error ? err.message : 'دریافت تنظیمات هوش مصنوعی با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isPermissionsLoading, canRead, reloadToken]);

  const capabilities = React.useMemo(() => configurableCapabilities(providers), [providers]);

  /** Providers capable of the capability currently selected in the form. */
  const eligibleProviders = React.useMemo(
    () => (form.capability ? providersForCapability(form.capability, providers) : []),
    [form.capability, providers]
  );

  const openCreate = () => {
    const capability = capabilities[0] ?? '';
    const provider = capability
      ? (providersForCapability(capability, providers)[0]?.key ?? '')
      : '';

    setEditingId(null);
    setForm({ ...EMPTY_FORM, capability, provider });
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEdit = (config: AIProviderConfig) => {
    setEditingId(config.id);
    setForm(formFor(config));
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const patchForm = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  /**
   * Capability change re-selects the provider, because the previous choice may not be
   * capable of the new capability. Leaving it would submit a pair the server refuses.
   */
  const changeCapability = (capability: AICapability) => {
    const first = providersForCapability(capability, providers)[0]?.key ?? '';
    patchForm({ capability, provider: first });
  };

  /**
   * Builds the write payload.
   *
   * Every field is listed EXPLICITLY rather than spread from form state, because the
   * DTOs run under `forbidNonWhitelisted`: a stray key (`clearCredential` on a create,
   * for instance) is a 400, not a dropped property.
   *
   * On edit, `credential` is included ONLY when the operator typed one. An empty field
   * therefore means "leave the stored key alone", matching the PATCH contract — the form
   * never had the key to resubmit.
   */
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSaving) return;

    if (!form.provider || !form.capability) {
      setFormError('ارائه‌دهنده و قابلیت را انتخاب کنید.');
      return;
    }

    const modelName = form.modelName.trim();
    if (modelName.length === 0) {
      setFormError('نام مدل الزامی است.');
      return;
    }

    // Mirrors the DB CHECK and the service guard, so the operator gets the reason here
    // instead of a 400 from the server.
    if (form.isDefault && !form.enabled) {
      setFormError('ارائه‌دهنده پیش‌فرض باید فعال باشد.');
      return;
    }

    if (form.credential.trim().length > 0 && form.clearCredential) {
      setFormError('نمی‌توان همزمان کلید جدید ثبت کرد و کلید ذخیره‌شده را حذف کرد.');
      return;
    }

    const baseUrl = form.baseUrl.trim();
    const credential = form.credential.trim();

    setIsSaving(true);
    setFormError(null);
    setNotice(null);
    setRowError(null);

    try {
      if (editingId) {
        await updateAIProviderConfig(editingId, {
          modelName,
          // `null` clears the override; an empty string would read as "absent" server-side.
          baseUrl: baseUrl.length > 0 ? baseUrl : null,
          ...(credential.length > 0 ? { credential } : {}),
          ...(form.clearCredential ? { clearCredential: true } : {}),
          enabled: form.enabled,
          isDefault: form.isDefault,
        });
        setNotice('تنظیمات ارائه‌دهنده ذخیره شد.');
      } else {
        await createAIProviderConfig({
          provider: form.provider,
          capability: form.capability,
          modelName,
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
          ...(credential.length > 0 ? { credential } : {}),
          enabled: form.enabled,
          isDefault: form.isDefault,
        });
        setNotice('ارائه‌دهنده جدید ثبت شد.');
      }

      closeForm();
      reload();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'ذخیره تنظیمات با خطا مواجه شد.');
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Promotes a row to the capability default.
   *
   * `enabled: true` travels with it because the server refuses a disabled default, and
   * promoting is the operator's way of saying "use this one".
   */
  const handlePromote = async (config: AIProviderConfig) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);

    try {
      await updateAIProviderConfig(config.id, { isDefault: true, enabled: true });
      setNotice('ارائه‌دهنده پیش‌فرض تغییر کرد.');
      reload();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'تغییر پیش‌فرض با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleEnabled = async (config: AIProviderConfig) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);

    try {
      await updateAIProviderConfig(config.id, { enabled: !config.enabled });
      setNotice(config.enabled ? 'ارائه‌دهنده غیرفعال شد.' : 'ارائه‌دهنده فعال شد.');
      reload();
    } catch (err: unknown) {
      // The server refuses to disable the active default (409) — surfaced as-is, because
      // the fix is to promote a replacement first.
      setRowError(err instanceof Error ? err.message : 'تغییر وضعیت با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Runs the live probe with the STORED key.
   *
   * Verifying an unsaved key happens through the form's own test control; here there is
   * no key in hand. A FAILURE arrives as a 200, so `status` is inspected rather than
   * relying on a rejection.
   */
  const handleTest = async (config: AIProviderConfig) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);
    setTestResult(null);

    try {
      const result = await testAIProviderConnection(config.id);
      setTestResult({ id: config.id, status: result.status, message: result.message });
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'آزمایش اتصال با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (config: AIProviderConfig) => {
    if (busyId) return;
    if (
      !window.confirm(
        `تنظیمات «${aiProviderLabel(config.provider, providers)}» حذف شود؟ کلید ذخیره‌شده نیز حذف می‌شود.`
      )
    ) {
      return;
    }

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);

    try {
      await deleteAIProviderConfig(config.id);
      setNotice('تنظیمات ارائه‌دهنده حذف شد.');
      if (editingId === config.id) closeForm();
      reload();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'حذف تنظیمات با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Verifies the key TYPED IN THE FORM before committing it.
   *
   * Only available while editing, because the probe addresses an existing row by id —
   * there is nothing to test before the first save. With an empty field it falls back to
   * the stored key, which is the "does this still work?" check.
   */
  const handleFormTest = async () => {
    if (!editingId || isSaving) return;

    const credential = form.credential.trim();

    setIsSaving(true);
    setFormError(null);
    setTestResult(null);

    try {
      const result = await testAIProviderConnection(editingId, credential || undefined);
      setTestResult({ id: editingId, status: result.status, message: result.message });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'آزمایش اتصال با خطا مواجه شد.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isPermissionsLoading) {
    return <CoreLoading label="در حال بررسی دسترسی..." lines={3} />;
  }

  // Both the local permission read and a server 403 land here. The former avoids a
  // pointless request; the latter remains the authority.
  if (!canRead || error?.status === 403) {
    return <CoreForbidden message="شما به تنظیمات هوش مصنوعی دسترسی ندارید." />;
  }

  const capabilityOptions = capabilities.map((capability) => ({
    value: capability,
    label: aiCapabilityLabel(capability),
  }));

  const providerOptions = eligibleProviders.map((provider) => ({
    value: provider.key,
    label: provider.displayName,
  }));

  const unsupportedNote =
    form.provider && form.capability
      ? unsupportedCapabilityReason(form.provider, form.capability, providers)
      : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">ارائه‌دهندگان هوش مصنوعی</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            پیکربندی سرویس‌های هوش مصنوعی و کلیدهای دسترسی آن‌ها
          </p>
        </div>

        {canManage && !isFormOpen && capabilities.length > 0 && (
          <Button type="button" onClick={openCreate} data-testid="ai-create-toggle">
            <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            ارائه‌دهنده جدید
          </Button>
        )}
      </header>

      {/*
        Stated plainly rather than implied by an empty dropdown: today only OPENAI
        declares a working capability, so a form offering TEXT_GENERATION would be
        offering a guaranteed runtime failure.
      */}
      {!isLoading && !error && capabilities.length === 0 && (
        <Alert
          type="info"
          message="در حال حاضر هیچ قابلیتی توسط ارائه‌دهندگان پیاده‌سازی‌شده پشتیبانی نمی‌شود."
        />
      )}

      {notice && (
        <div data-testid="ai-notice">
          <Alert type="success" message={notice} />
        </div>
      )}

      {rowError && (
        <div data-testid="ai-row-error">
          <Alert type="error" message={rowError} />
        </div>
      )}

      {canManage && isFormOpen && (
        <form
          onSubmit={handleSubmit}
          noValidate
          data-testid="ai-form"
          aria-label={editingId ? 'ویرایش ارائه‌دهنده' : 'ثبت ارائه‌دهنده جدید'}
          className="space-y-4 rounded-2xl border border-border bg-card p-4"
        >
          <h2 className="text-sm font-medium text-foreground">
            {editingId ? 'ویرایش ارائه‌دهنده' : 'ثبت ارائه‌دهنده جدید'}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            {/*
              Capability and provider are the row's identity and are NOT updatable — the
              PATCH contract omits both, because moving a row would move a credential
              encrypted for one vendor onto another. On edit they are shown disabled so
              the row stays identifiable.
            */}
            <Select
              label="قابلیت"
              id="ai-capability"
              name="capability"
              required
              disabled={Boolean(editingId)}
              value={form.capability}
              options={capabilityOptions}
              onChange={(event) => changeCapability(event.target.value as AICapability)}
              data-testid="ai-capability"
            />

            <Select
              label="ارائه‌دهنده"
              id="ai-provider"
              name="provider"
              required
              disabled={Boolean(editingId)}
              value={form.provider}
              options={providerOptions}
              onChange={(event) => patchForm({ provider: event.target.value as AIProviderKey })}
              data-testid="ai-provider"
            />

            <Input
              label="نام مدل"
              id="ai-model"
              name="modelName"
              required
              maxLength={MAX_AI_MODEL_NAME}
              value={form.modelName}
              onChange={(event) => patchForm({ modelName: event.target.value })}
              placeholder="text-embedding-3-small"
              data-testid="ai-model"
            />

            <Input
              label="نشانی سرویس (اختیاری)"
              id="ai-base-url"
              name="baseUrl"
              type="url"
              dir="ltr"
              maxLength={MAX_AI_BASE_URL}
              value={form.baseUrl}
              onChange={(event) => patchForm({ baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              data-testid="ai-base-url"
            />
          </div>

          {unsupportedNote && (
            <div data-testid="ai-unsupported">
              <Alert type="warning" message={unsupportedNote} />
            </div>
          )}

          <div className="space-y-2">
            <Input
              label={editingId ? 'کلید API (برای تغییر، مقدار جدید را وارد کنید)' : 'کلید API'}
              id="ai-credential"
              name="credential"
              // `password` so the value is not shoulder-readable; `autoComplete="off"` so
              // the browser does not offer to store an operator's provider key.
              type="password"
              dir="ltr"
              autoComplete="off"
              maxLength={MAX_AI_CREDENTIAL}
              value={form.credential}
              disabled={form.clearCredential}
              onChange={(event) => patchForm({ credential: event.target.value })}
              data-testid="ai-credential"
            />
            {/*
              The field starts empty on every edit because the server never returns a
              credential. Saying so removes the natural reading of an empty box, which is
              "there is no key".
            */}
            <p className="text-xs text-muted-foreground">
              کلید ذخیره‌شده هرگز بازخوانی نمی‌شود. خالی گذاشتن این فیلد، کلید فعلی را بدون تغییر
              نگه می‌دارد.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => patchForm({ enabled: event.target.checked })}
                data-testid="ai-enabled"
                className="h-4 w-4 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              فعال
            </label>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) =>
                  // A default must be enabled — the DB CHECK says so, so ticking this
                  // ticks `enabled` rather than letting the operator build a refused pair.
                  patchForm({
                    isDefault: event.target.checked,
                    enabled: event.target.checked ? true : form.enabled,
                  })
                }
                data-testid="ai-default"
                className="h-4 w-4 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              پیش‌فرض این قابلیت
            </label>

            {editingId && (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={form.clearCredential}
                  onChange={(event) =>
                    patchForm({
                      clearCredential: event.target.checked,
                      // Clearing and setting cannot travel together, so the typed value is
                      // dropped instead of being sent alongside a 400-inducing flag.
                      credential: event.target.checked ? '' : form.credential,
                    })
                  }
                  data-testid="ai-clear-credential"
                  className="h-4 w-4 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                حذف کلید ذخیره‌شده
              </label>
            )}
          </div>

          {formError && (
            <div data-testid="ai-form-error">
              <Alert type="error" message={formError} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={isSaving} data-testid="ai-save">
              {isSaving ? 'در حال ذخیره...' : editingId ? 'ذخیره تغییرات' : 'ثبت ارائه‌دهنده'}
            </Button>

            {editingId && (
              <button
                type="button"
                onClick={handleFormTest}
                disabled={isSaving}
                data-testid="ai-form-test"
                className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                آزمایش اتصال
              </button>
            )}

            <button
              type="button"
              onClick={closeForm}
              disabled={isSaving}
              data-testid="ai-cancel"
              className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              انصراف
            </button>
          </div>
        </form>
      )}

      {isLoading && <CoreLoading label="در حال بارگذاری تنظیمات هوش مصنوعی..." lines={4} />}

      {!isLoading && error && <CoreError message={error.message} onRetry={reload} />}

      {!isLoading && !error && configs.length === 0 && (
        <CoreEmpty message="هیچ ارائه‌دهنده‌ای پیکربندی نشده است. تا زمانی که پیش‌فرضی ثبت نشود، تنظیمات محیطی سرور استفاده می‌شود." />
      )}

      {!isLoading && !error && configs.length > 0 && (
        <ul className="space-y-3" data-testid="ai-config-list">
          {configs.map((config) => (
            <li
              key={config.id}
              data-testid="ai-config-item"
              data-config-id={config.id}
              data-enabled={String(config.enabled)}
              data-default={String(config.isDefault)}
              className="space-y-3 rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {aiProviderLabel(config.provider, providers)}
                </span>
                <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {aiCapabilityLabel(config.capability)}
                </span>
                {config.isDefault && (
                  <span
                    data-testid="ai-default-badge"
                    className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
                  >
                    پیش‌فرض
                  </span>
                )}
                <span
                  data-testid="ai-enabled-badge"
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px]',
                    config.enabled
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-border bg-muted text-muted-foreground'
                  )}
                >
                  {config.enabled ? 'فعال' : 'غیرفعال'}
                </span>
              </div>

              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <div className="flex gap-1">
                  <dt>مدل:</dt>
                  <dd dir="ltr">{config.modelName}</dd>
                </div>
                {config.baseUrl && (
                  <div className="flex gap-1">
                    <dt>نشانی:</dt>
                    <dd dir="ltr">{config.baseUrl}</dd>
                  </div>
                )}
                {/* Presence and rotation time only — never the key, nor its length. */}
                <div className="flex gap-1">
                  <dt>کلید:</dt>
                  <dd data-testid="ai-credential-status">{credentialStatusLabel(config)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>به‌روزرسانی:</dt>
                  <dd>{formatAITime(config.updatedAt)}</dd>
                </div>
              </dl>

              {testResult?.id === config.id && (
                <div data-testid="ai-test-result" data-status={testResult.status}>
                  <Alert
                    type={testResult.status === 'SUCCESS' ? 'success' : 'error'}
                    message={testResult.message}
                  />
                </div>
              )}

              {/*
                Every control here is behind `admin.ai.manage`, INCLUDING the test: a probe
                spends money on the operator's provider account, so it is a write-class
                action even though it changes no row.
              */}
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(config)}
                    disabled={busyId === config.id}
                    data-testid="ai-edit"
                    className="rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    ویرایش
                  </button>

                  <button
                    type="button"
                    onClick={() => handleTest(config)}
                    disabled={busyId === config.id}
                    data-testid="ai-test"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    آزمایش اتصال
                  </button>

                  {/*
                    Promotion is offered only for a row that is not already the default. A
                    row that IS the default has no "demote" control: the server refuses to
                    leave a capability with no default, so the way out is to promote a
                    replacement.
                  */}
                  {!config.isDefault && (
                    <button
                      type="button"
                      onClick={() => handlePromote(config)}
                      disabled={busyId === config.id}
                      data-testid="ai-promote"
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      انتخاب به عنوان پیش‌فرض
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleToggleEnabled(config)}
                    disabled={busyId === config.id}
                    data-testid="ai-toggle-enabled"
                    className="rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {config.enabled ? 'غیرفعال کردن' : 'فعال کردن'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDelete(config)}
                    disabled={busyId === config.id}
                    data-testid="ai-delete"
                    aria-label={`حذف تنظیمات ${aiProviderLabel(config.provider, providers)}`}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    حذف
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
