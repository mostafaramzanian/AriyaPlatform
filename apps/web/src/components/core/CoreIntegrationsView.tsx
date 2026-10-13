'use client';

import * as React from 'react';
import { KeyRound, Plug, RefreshCw, Trash2 } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  AUTOMATION_STATUS_LABELS,
  MAX_ATTEMPTS,
  MAX_TIMEOUT_MS,
  MIN_ATTEMPTS,
  MIN_TIMEOUT_MS,
  MIN_WEBHOOK_SECRET,
  createIntegration,
  deleteIntegration,
  formatIntegrationTime,
  integrationLabel,
  integrationStatusLabel,
  listAutomationExecutions,
  listIntegrations,
  rotateIntegrationSecret,
  secretStatusLabel,
  testIntegration,
  updateIntegration,
  type AutomationExecution,
  type Integration,
  type IntegrationDescriptor,
  type IntegrationKey,
} from '@/lib/integrations-api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCorePermissions } from './useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49L: the automation & integration settings screen.
 *
 * Backed by `/admin/integrations`, gated on `admin.integrations.read` for the three reads
 * and `admin.integrations.manage` for every write, the secret rotation and the connection
 * test. Both permissions are seeded in core_db, so gating the UI on them is real — but it
 * is still presentation only: the controller enforces the same strings.
 *
 * THE SECRET IS NEVER RENDERED FROM A READ. The server has no projection that returns
 * one, so there is no field to render it into: the form's secret input starts EMPTY on
 * every edit and an empty input means "leave the stored secret untouched", exactly what
 * the PATCH contract does with an omitted `secret`. The ONE time a secret appears on
 * screen is immediately after `POST :id/secret` generated it, because the operator has to
 * copy it into the engine and no later request can retrieve it — and it is held in
 * component state only, never written to storage.
 *
 * NO WORKFLOW EDITOR, and that is a boundary rather than an omission (§41): the workflow
 * graph belongs to the engine. This screen configures identity, endpoint, secret and
 * bounds, and it displays delivery status. Nothing here can create, edit or inspect a
 * workflow.
 *
 * FIVE DISTINCT CONNECTION STATES are surfaced (§42) rather than a single on/off badge,
 * because "configured but disabled", "enabled with no secret", "never tested", "test
 * succeeded" and "test failed" are five different operator situations.
 */

const READ_PERMISSION = 'admin.integrations.read';
const MANAGE_PERMISSION = 'admin.integrations.manage';

interface FormState {
  integration: IntegrationKey | '';
  baseUrl: string;
  webhookPath: string;
  secret: string;
  enabled: boolean;
  timeoutMs: string;
  maxAttempts: string;
}

const EMPTY_FORM: FormState = {
  integration: '',
  baseUrl: '',
  webhookPath: '',
  secret: '',
  enabled: false,
  timeoutMs: '10000',
  maxAttempts: '3',
};

/**
 * Seeds the edit form from a row. `secret` is ALWAYS empty — there is nothing to seed it
 * from, and a placeholder would imply the secret had been read back.
 */
function formFor(config: Integration): FormState {
  return {
    integration: config.integration,
    baseUrl: config.baseUrl,
    webhookPath: config.webhookPath,
    secret: '',
    enabled: config.enabled,
    timeoutMs: String(config.timeoutMs),
    maxAttempts: String(config.maxAttempts),
  };
}

export function CoreIntegrationsView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);
  // `manage` does NOT imply `read`: the controller gates the reads on the read string
  // specifically, so the view is gated on it too rather than on either-of.
  const canRead = permissions.includes(READ_PERMISSION);
  const canManage = permissions.includes(MANAGE_PERMISSION);

  const [configs, setConfigs] = React.useState<Integration[]>([]);
  const [catalogue, setCatalogue] = React.useState<IntegrationDescriptor[]>([]);
  const [executions, setExecutions] = React.useState<AutomationExecution[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in every list-refresh handler below (same commit
  // as the token bump), so the fetch effect needs no in-effect setter resets.
  // First mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setIsLoading, setError);

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

  /**
   * The freshly generated secret, shown ONCE.
   *
   * Component state only — never localStorage, never a cookie, never a URL. It is cleared
   * on dismissal and on any reload, so it cannot outlive the moment the operator needs it.
   */
  const [generatedSecret, setGeneratedSecret] = React.useState<string | null>(null);

  // No request is issued without the read permission: it would be a guaranteed 403.
  React.useEffect(() => {
    if (isPermissionsLoading || !canRead) return;

    let cancelled = false;

    Promise.all([listIntegrations(), listAutomationExecutions({ limit: 20 })])
      .then(([list, page]) => {
        if (cancelled) return;
        setConfigs(list.configs);
        setCatalogue(list.integrations);
        setExecutions(page.items);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfigs([]);
        setCatalogue([]);
        setExecutions([]);
        setError({
          message: err instanceof Error ? err.message : 'دریافت تنظیمات یکپارچه‌سازی با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isPermissionsLoading, canRead, reloadToken]);

  const reload = () => {
    setGeneratedSecret(null);
    reloadList();
  };

  const patchForm = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const openCreate = () => {
    const first = catalogue[0];

    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      integration: first?.key ?? '',
      // The server's SUGGESTION, rendered as a starting value the operator can change.
      webhookPath: first?.defaultWebhookPath ?? '',
    });
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEdit = (config: Integration) => {
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

  /**
   * Builds the write payload.
   *
   * Every field is listed EXPLICITLY rather than spread from form state, because the DTOs
   * run under `forbidNonWhitelisted`: a stray key is a 400, not a dropped property.
   *
   * On edit, `secret` is included ONLY when the operator typed one. An empty field
   * therefore means "leave the stored secret alone", matching the PATCH contract — the
   * form never had the secret to resubmit.
   */
  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSaving) return;

    setIsSaving(true);
    setFormError(null);
    setNotice(null);

    const timeoutMs = Number(form.timeoutMs);
    const maxAttempts = Number(form.maxAttempts);

    try {
      if (editingId) {
        await updateIntegration(editingId, {
          baseUrl: form.baseUrl.trim(),
          webhookPath: form.webhookPath.trim(),
          ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
          enabled: form.enabled,
          timeoutMs,
          maxAttempts,
        });
        setNotice('تنظیمات یکپارچه‌سازی به‌روزرسانی شد.');
      } else {
        if (!form.integration) {
          setFormError('یک سرویس اتوماسیون را انتخاب کنید.');
          setIsSaving(false);
          return;
        }

        await createIntegration({
          integration: form.integration,
          baseUrl: form.baseUrl.trim(),
          webhookPath: form.webhookPath.trim(),
          ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
          enabled: form.enabled,
          timeoutMs,
          maxAttempts,
        });
        setNotice('یکپارچه‌سازی ایجاد شد.');
      }

      closeForm();
      reload();
    } catch (err: unknown) {
      // The server's message is shown verbatim: it explains WHY (private address, missing
      // secret, duplicate) and it never contains a secret or an upstream body.
      setFormError(err instanceof Error ? err.message : 'ذخیره تنظیمات با خطا مواجه شد.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (config: Integration) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);

    try {
      await deleteIntegration(config.id);
      setNotice('یکپارچه‌سازی حذف شد.');
      if (editingId === config.id) closeForm();
      reload();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'حذف یکپارچه‌سازی با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Generates a secret and shows it once.
   *
   * The response is the only moment the value exists client-side. It is placed in
   * component state and rendered with an explicit "copy it now" warning, because a
   * re-render triggered by a reload discards it and no route can return it again.
   */
  const handleRotate = async (config: Integration) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setNotice(null);
    setGeneratedSecret(null);

    try {
      const { secret } = await rotateIntegrationSecret(config.id);
      setGeneratedSecret(secret);
      reloadList();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'تولید کلید امضا با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async (config: Integration) => {
    if (busyId) return;

    setBusyId(config.id);
    setRowError(null);
    setTestResult(null);

    try {
      const result = await testIntegration(config.id);
      setTestResult({ id: config.id, status: result.status, message: result.message });
      // The outcome is stored on the row, so the list must be re-read to show it.
      reloadList();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : 'آزمایش اتصال با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  if (isPermissionsLoading) {
    return <CoreLoading label="در حال بررسی دسترسی..." lines={3} />;
  }

  // Both the local permission read and a server 403 land here. The former avoids a
  // pointless request; the latter remains the authority.
  if (!canRead || error?.status === 403) {
    return <CoreForbidden message="شما به تنظیمات یکپارچه‌سازی دسترسی ندارید." />;
  }

  return (
    <div className="space-y-6" data-testid="integrations-view">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">اتوماسیون و یکپارچه‌سازی</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            اتصال آریا به سرویس اتوماسیون و پیگیری وضعیت رویدادها
          </p>
        </div>

        {canManage && !isFormOpen && configs.length < catalogue.length && (
          <Button type="button" onClick={openCreate} data-testid="integration-create-toggle">
            <Plug className="me-2 h-4 w-4" aria-hidden="true" />
            یکپارچه‌سازی جدید
          </Button>
        )}
      </header>

      {notice && (
        <div data-testid="integration-notice">
          <Alert type="success" message={notice} />
        </div>
      )}

      {rowError && (
        <div data-testid="integration-row-error">
          <Alert type="error" message={rowError} />
        </div>
      )}

      {/*
        The ONE place a secret ever appears. Rendered with an explicit warning because it
        cannot be retrieved again — the server stores only the encrypted envelope, and no
        route returns it.
      */}
      {generatedSecret && (
        <div
          className="space-y-3 rounded-2xl border border-warning/40 bg-warning/10 p-4"
          data-testid="integration-secret-once"
        >
          <p className="text-sm font-medium text-foreground">
            کلید امضا تولید شد. آن را همین حالا کپی کنید — این مقدار دیگر نمایش داده نمی‌شود.
          </p>
          <code
            className="block break-all rounded-xl bg-background px-3 py-2 font-mono text-xs text-foreground"
            data-testid="integration-secret-value"
          >
            {generatedSecret}
          </code>
          <Button type="button" onClick={() => setGeneratedSecret(null)} className="text-sm">
            متوجه شدم
          </Button>
        </div>
      )}

      {canManage && isFormOpen && (
        <form
          onSubmit={handleSave}
          className="space-y-4 rounded-2xl border border-border bg-surface p-5"
          data-testid="integration-form"
        >
          <h2 className="text-lg font-medium text-foreground">
            {editingId ? 'ویرایش یکپارچه‌سازی' : 'یکپارچه‌سازی جدید'}
          </h2>

          {formError && <Alert type="error" message={formError} />}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="integration-service"
                className="block text-sm font-medium text-foreground"
              >
                سرویس اتوماسیون
              </label>
              <select
                id="integration-service"
                data-testid="integration-service"
                value={form.integration}
                // Not editable on an existing row: retargeting would move a secret
                // negotiated with one engine onto another. The API refuses it too.
                disabled={Boolean(editingId)}
                onChange={(event) => {
                  const key = event.target.value as IntegrationKey;
                  const descriptor = catalogue.find((entry) => entry.key === key);
                  patchForm({
                    integration: key,
                    webhookPath: descriptor?.defaultWebhookPath ?? form.webhookPath,
                  });
                }}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">انتخاب کنید</option>
                {catalogue.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
            </div>

            <Input
              id="integration-baseUrl"
              data-testid="integration-baseUrl"
              label="نشانی سرویس"
              value={form.baseUrl}
              onChange={(event) => patchForm({ baseUrl: event.target.value })}
              placeholder="http://localhost:5678"
              required
            />

            <Input
              id="integration-webhookPath"
              data-testid="integration-webhookPath"
              label="مسیر وب‌هوک"
              value={form.webhookPath}
              onChange={(event) => patchForm({ webhookPath: event.target.value })}
              placeholder="/webhook/aria"
              required
            />

            {/*
              A PASSWORD input, and always empty on open. There is nothing to prefill it
              with: the server has no projection that returns a secret.
            */}
            <Input
              id="integration-secret"
              data-testid="integration-secret"
              type="password"
              label={editingId ? 'کلید امضا (خالی = بدون تغییر)' : 'کلید امضا'}
              value={form.secret}
              onChange={(event) => patchForm({ secret: event.target.value })}
              autoComplete="new-password"
              minLength={MIN_WEBHOOK_SECRET}
            />

            <Input
              id="integration-timeout"
              data-testid="integration-timeout"
              type="number"
              label={`زمان انتظار (میلی‌ثانیه، ${MIN_TIMEOUT_MS} تا ${MAX_TIMEOUT_MS})`}
              value={form.timeoutMs}
              onChange={(event) => patchForm({ timeoutMs: event.target.value })}
              min={MIN_TIMEOUT_MS}
              max={MAX_TIMEOUT_MS}
            />

            <Input
              id="integration-attempts"
              data-testid="integration-attempts"
              type="number"
              label={`حداکثر تلاش (${MIN_ATTEMPTS} تا ${MAX_ATTEMPTS})`}
              value={form.maxAttempts}
              onChange={(event) => patchForm({ maxAttempts: event.target.value })}
              min={MIN_ATTEMPTS}
              max={MAX_ATTEMPTS}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              data-testid="integration-enabled"
              checked={form.enabled}
              onChange={(event) => patchForm({ enabled: event.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            فعال باشد
          </label>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={isSaving} data-testid="integration-save">
              {isSaving ? 'در حال ذخیره...' : 'ذخیره'}
            </Button>
            <Button type="button" onClick={closeForm} className="bg-muted text-foreground">
              انصراف
            </Button>
          </div>
        </form>
      )}

      {/* ── Configured integrations ─────────────────────────────────────────── */}
      {isLoading ? (
        <CoreLoading label="در حال بارگذاری یکپارچه‌سازی‌ها..." lines={3} />
      ) : error ? (
        <CoreError message={error.message} onRetry={reload} />
      ) : configs.length === 0 ? (
        <CoreEmpty message="هنوز هیچ سرویس اتوماسیونی تنظیم نشده است. آریا بدون آن کامل کار می‌کند." />
      ) : (
        <ul className="space-y-3" data-testid="integration-list">
          {configs.map((config) => (
            <li
              key={config.id}
              className="space-y-3 rounded-2xl border border-border bg-surface p-4"
              data-testid={`integration-row-${config.integration}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {integrationLabel(config.integration, catalogue)}
                  </p>
                  {/* Origin and path only — never a credential, and never a full signed URL. */}
                  <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                    {config.baseUrl}
                    {config.webhookPath}
                  </p>
                </div>

                <span
                  className="rounded-full bg-muted px-3 py-1 text-xs text-foreground"
                  data-testid={`integration-status-${config.integration}`}
                >
                  {integrationStatusLabel(config)}
                </span>
              </div>

              <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <dt className="inline font-medium">کلید امضا: </dt>
                  <dd className="inline" data-testid={`integration-secret-status-${config.integration}`}>
                    {secretStatusLabel(config)}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">آخرین آزمایش: </dt>
                  <dd className="inline">
                    {config.lastTestedAt ? formatIntegrationTime(config.lastTestedAt) : 'انجام نشده'}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">زمان انتظار: </dt>
                  <dd className="inline">{config.timeoutMs} میلی‌ثانیه</dd>
                </div>
                <div>
                  <dt className="inline font-medium">حداکثر تلاش: </dt>
                  <dd className="inline">{config.maxAttempts}</dd>
                </div>
              </dl>

              {testResult?.id === config.id && (
                <div data-testid={`integration-test-result-${config.integration}`}>
                  <Alert
                    type={testResult.status === 'SUCCESS' ? 'success' : 'error'}
                    message={testResult.message}
                  />
                </div>
              )}

              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => openEdit(config)}
                    className="bg-muted text-sm text-foreground"
                    data-testid={`integration-edit-${config.integration}`}
                  >
                    ویرایش
                  </Button>

                  <Button
                    type="button"
                    onClick={() => handleTest(config)}
                    disabled={busyId === config.id}
                    className="text-sm"
                    data-testid={`integration-test-${config.integration}`}
                  >
                    <RefreshCw className="me-2 h-4 w-4" aria-hidden="true" />
                    آزمایش اتصال
                  </Button>

                  <Button
                    type="button"
                    onClick={() => handleRotate(config)}
                    disabled={busyId === config.id}
                    className="bg-muted text-sm text-foreground"
                    data-testid={`integration-rotate-${config.integration}`}
                  >
                    <KeyRound className="me-2 h-4 w-4" aria-hidden="true" />
                    تولید کلید امضا
                  </Button>

                  <Button
                    type="button"
                    onClick={() => handleDelete(config)}
                    disabled={busyId === config.id}
                    className="bg-destructive/10 text-sm text-destructive"
                    data-testid={`integration-delete-${config.integration}`}
                  >
                    <Trash2 className="me-2 h-4 w-4" aria-hidden="true" />
                    حذف
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── Delivery history ────────────────────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="automation-executions-heading">
        <h2 id="automation-executions-heading" className="text-lg font-medium text-foreground">
          آخرین رویدادها
        </h2>

        {isLoading ? (
          <CoreLoading label="در حال بارگذاری رویدادها..." lines={2} />
        ) : executions.length === 0 ? (
          <CoreEmpty message="هنوز رویدادی ارسال نشده است." />
        ) : (
          <ul className="space-y-2" data-testid="automation-execution-list">
            {executions.map((execution) => (
              <li
                key={execution.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm"
              >
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {execution.eventType}
                    <span className="ms-2 text-xs text-muted-foreground">
                      نسخه {execution.eventVersion}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatIntegrationTime(execution.createdAt)}
                    {execution.attemptCount > 1 && ` — ${execution.attemptCount} تلاش`}
                    {/*
                      A SHORT CODE, exactly as stored. Never an upstream message: the server
                      bounds this field to 100 characters and refuses response bodies.
                    */}
                    {execution.errorCode && ` — ${execution.errorCode}`}
                  </p>
                </div>

                <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">
                  {AUTOMATION_STATUS_LABELS[execution.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}






