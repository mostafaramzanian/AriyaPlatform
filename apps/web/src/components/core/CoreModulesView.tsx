'use client';

import * as React from 'react';
import { Boxes, KeyRound, RefreshCw, Trash2 } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  DEPLOYMENT_MODE_LABELS,
  FEATURE_EFFECTIVE_STATE_PRESENTATION,
  HEALTH_PRESENTATION,
  LIFECYCLE_LABELS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_FEATURE_GRANT_TENANTS,
  MAX_TENANT_ID_LENGTH,
  MODULE_TYPE_LABELS,
  createModule,
  credentialStatusLabel,
  declareModuleFeature,
  deleteModule,
  entitlementFailureLabel,
  fetchModuleFeatureStates,
  formatModuleTime,
  getModulePlatform,
  grantModuleFeature,
  healthErrorLabel,
  isValidFeatureId,
  isValidModuleId,
  listModuleFeatures,
  listModules,
  moduleStatusLabel,
  parseTenantIdList,
  revokeModuleFeature,
  rotateModuleCredential,
  tenantScopeLabel,
  testModuleInstance,
  updateModule,
  updateModuleFeature,
  type EntitlementFailureCode,
  type ModuleFeatureStatePage,
  type ModuleFeatureSummary,
  type ModuleHealthVerdict,
  type ModulePlatformDescriptor,
  type ModuleRegistration,
  type ModuleType,
} from '@/lib/modules-api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCorePermissions } from './useCorePermissions';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49M §28/§29/§30/§44: the module registry screen — "ماژول‌ها و سرویس‌های متصل".
 *
 * Backed by `/admin/modules`, gated on `admin.modules.read` for the reads and
 * `admin.modules.manage` for every write, the credential rotation and the connection test. Both
 * permissions are seeded in core_db, so gating the UI on them is real — but it is still presentation
 * only: the controller enforces the same strings.
 *
 * THE CREDENTIAL IS NEVER RENDERED FROM A READ. The server has no projection that returns one, so
 * there is no field to render it into. The ONE time a credential appears on screen is immediately
 * after `POST :id/credential` generated it, because the operator has to copy it into the module's
 * configuration and no later request can retrieve it — and it is held in component state only, never
 * written to storage.
 *
 * NO ENDPOINT INPUT ANYWHERE ON THIS SCREEN, and that is a boundary rather than an omission (§40):
 * an endpoint belongs to a running instance and is written by the module's own authenticated
 * registration. An administrator admits a module and sets its tenant scope; the module says where it
 * is. That division is what keeps this page from becoming a way to point Core at an internal service.
 *
 * NOTHING HERE IS PER-MODULE. There is no `if (module.moduleId === 'finance')` and no
 * mode-conditional rendering beyond a label: every row renders through the same code, so a module
 * moving from LOCAL to REMOTE changes one badge and nothing else (§35).
 *
 * STATUS IS NEVER COLOUR ALONE (§30). Each health badge carries a SYMBOL and a PERSIAN LABEL as well
 * as a colour class, and the accessible name is the label.
 */

const READ_PERMISSION = 'admin.modules.read';
const MANAGE_PERMISSION = 'admin.modules.manage';

interface FormState {
  moduleId: string;
  displayName: string;
  moduleType: ModuleType;
  tenantScope: 'ALL' | 'RESTRICTED';
  tenantIds: string;
}

const EMPTY_FORM: FormState = {
  moduleId: '',
  displayName: '',
  moduleType: 'BUSINESS',
  tenantScope: 'ALL',
  tenantIds: '',
};

/** Health badge. Symbol + label + colour, never colour alone (§30). */
function HealthBadge({ state }: { state: keyof typeof HEALTH_PRESENTATION }) {
  const presentation = HEALTH_PRESENTATION[state];

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${presentation.className}`}>
      <span aria-hidden="true">{presentation.symbol}</span>
      <span>{presentation.label}</span>
    </span>
  );
}

/**
 * Phase 54-C (§43.8): the FEATURES section of a module — one row per declared feature, with the
 * platform's offer, the granted-tenant count and the per-tenant effective state.
 *
 * WHY IT IS HERE RATHER THAN ON A SCREEN OF ITS OWN. Features hang off a module (the hierarchy is
 * exactly two levels, §43.9) and the routes hang off the module's own path prefix, so an operator
 * reads a module and its features in one place. The section is EXPANDED ON DEMAND: the registry list
 * is the page's job, and a console that fetched every module's features on load would pay for a
 * question nobody asked.
 *
 * WHAT IT REFUSES TO BE. It is not a second source of truth: every fact below comes from the admin
 * routes, and NOTHING about entitlement is derived here. The per-tenant answer is the server's
 * `effective`/`reasonCode` pair, printed as it arrives; the browser-side rule that used to compute it
 * (`featureEffectiveState`) was deleted in the Phase 54-C closure fix because it could not see a
 * `RESTRICTED_MEMBERS` module's membership table and refused entitled tenancies. A read-only caller
 * sees the whole picture and NO write affordance; the controller enforces both permission codes
 * regardless, so this is presentation only.
 *
 * THE ONE PLACE A TENANT ID IS TYPED is the grant body, and that is not a §25-rule-7 violation: rule
 * 7 forbids choosing the TENANCY OF A REQUEST (the request's tenant is read from the actor, §43.5),
 * whereas a grant states a configuration fact about tenants the caller administers — under a manage
 * permission, recorded in the trail. The distinction is stated in the client and in the service so
 * nobody "fixes" one into the other.
 */
function ModuleFeaturesSection({
  module,
  canManage,
}: {
  module: ModuleRegistration;
  canManage: boolean;
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [features, setFeatures] = React.useState<ModuleFeatureSummary[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the open/mutation handlers below (same commit
  // as the token bump), so the feature effects need no in-effect setter resets.
  const { token: reloadToken, reload: reloadRaw } = useReloadToken(setIsLoading, setError);

  // The tenant matrix of the ONE expanded feature — the granted page plus whatever the module's own
  // scope already names. One at a time, because "why is THIS tenant refused?" is a question about one
  // feature.
  const [openFeatureId, setOpenFeatureId] = React.useState<string | null>(null);
  /**
   * The server's effective-state page for the OPEN feature — the console's only entitlement source.
   *
   * Not a client-side derivation: it carries the CONFIGURED flags, the enumeration size and one row
   * per tenant with the §43.8 state the platform decided. `null` means "not read yet or closed", and
   * the tenant list renders empty rather than guessing in that window — the same rule the granted-tenant
   * read followed, now applied to the state that actually matters.
   */
  const [statePage, setStatePage] = React.useState<ModuleFeatureStatePage | null>(null);
  const [isGrantsLoading, setIsGrantsLoading] = React.useState(false);
  const [grantsError, setGrantsError] = React.useState<string | null>(null);
  const [grantInput, setGrantInput] = React.useState('');
  const [grantError, setGrantError] = React.useState<string | null>(null);

  const [renameTarget, setRenameTarget] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [renameError, setRenameError] = React.useState<string | null>(null);

  const [isDeclareOpen, setIsDeclareOpen] = React.useState(false);
  const [declareFeatureId, setDeclareFeatureId] = React.useState('');
  const [declareDisplayName, setDeclareDisplayName] = React.useState('');
  const [declareError, setDeclareError] = React.useState<string | null>(null);

  /**
   * Reload both reads; when the feature panel is open, its state-page read is
   * re-armed in this same commit — exactly what the removed in-effect setters
   * (clear page, arm grants) used to establish one render later.
   */
  const reloadWithOpenPanel = () => {
    if (openFeatureId) {
      setStatePage(null);
      setIsGrantsLoading(true);
      setGrantsError(null);
    }
    reloadRaw();
  };

  React.useEffect(() => {
    if (!isOpen) return;

    let active = true;

    listModuleFeatures(module.moduleId)
      .then((rows) => {
        if (!active) return;
        setFeatures(rows);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'دریافت قابلیت‌ها با خطا مواجه شد.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, module.moduleId, reloadToken]);

  /**
   * The AUTHORITATIVE effective-state page for the feature whose panel is open.
   *
   * Read from the server, never reconstructed here: the browser cannot see the D16 membership child
   * table, so a client-side rule over `tenantScope`/`tenantIds` called HR's entitled tenants
   * "blocked by module". The server enumerates the tenants and answers about each; this effect only
   * carries that answer, and it re-runs on `reloadToken` so a grant or a revoke refreshes it.
   *
   * It replaced a second read of `.../tenants` that listed grants: two reads would have been two
   * sources of truth for one panel, and the granted page is a SUBSET of this one — a granted tenant is
   * always in `rows`, with `granted: true`.
   */
  React.useEffect(() => {
    if (!openFeatureId) return;

    let cancelled = false;

    void fetchModuleFeatureStates(module.moduleId, openFeatureId)
      .then((page) => {
        if (!cancelled) setStatePage(page);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setGrantsError(err instanceof Error ? err.message : 'دریافت وضعیت با خطا مواجه شد.');
      })
      .finally(() => {
        if (!cancelled) setIsGrantsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [openFeatureId, module.moduleId, reloadToken]);

  /** One helper for every feature mutation, so a busy row cannot be double-actioned. */
  const runFeatureAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);

    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'انجام عملیات با خطا مواجه شد.');
    } finally {
      setBusy(null);
    }
  };

  const declare = (event: React.FormEvent) => {
    event.preventDefault();
    setDeclareError(null);

    const featureId = declareFeatureId.trim();
    const displayName = declareDisplayName.trim();

    // Local, so an obvious mistake is a message rather than a round trip — the rule the registration
    // form follows, against the same slug shape the feature DTO and the SQL CHECK enforce.
    if (!isValidFeatureId(featureId)) {
      setDeclareError('شناسه قابلیت باید ۲ تا ۶۴ نویسه، حروف کوچک انگلیسی و خط تیره باشد.');
      return;
    }

    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      setDeclareError('نام نمایشی قابلیت الزامی است.');
      return;
    }

    void runFeatureAction(`declare:${featureId}`, async () => {
      await declareModuleFeature(module.moduleId, { featureId, displayName });
      // NOT enabled here, and the notice says so: declaring is not offering (§43.3).
      setNotice('قابلیت اعلام شد. برای ارائه آن به مستأجرها، ارائه را فعال کنید.');
      setDeclareFeatureId('');
      setDeclareDisplayName('');
      setIsDeclareOpen(false);
      reloadWithOpenPanel();
    });
  };

  const toggleOffer = (feature: ModuleFeatureSummary) =>
    runFeatureAction(`offer:${feature.featureId}`, async () => {
      await updateModuleFeature(module.moduleId, feature.featureId, { enabled: !feature.enabled });
      setNotice(
        feature.enabled
          ? 'ارائه این قابلیت غیرفعال شد؛ داده‌ای حذف نشد و مجوزها بازنشانی نشدند.'
          : 'ارائه این قابلیت فعال شد.'
      );
      reloadWithOpenPanel();
    });

  const rename = (feature: ModuleFeatureSummary) => {
    setRenameError(null);

    const displayName = renameValue.trim();
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      setRenameError('نام نمایشی قابلیت الزامی است.');
      return;
    }

    void runFeatureAction(`rename:${feature.featureId}`, async () => {
      await updateModuleFeature(module.moduleId, feature.featureId, { displayName });
      setNotice('نام قابلیت به‌روزرسانی شد.');
      setRenameTarget(null);
      reloadWithOpenPanel();
    });
  };

  const grant = (event: React.FormEvent, feature: ModuleFeatureSummary) => {
    event.preventDefault();
    setGrantError(null);

    const tenantIds = parseTenantIdList(grantInput);

    if (tenantIds.length === 0) {
      setGrantError('دست‌کم یک شناسه مستأجر لازم است.');
      return;
    }

    if (tenantIds.length > MAX_FEATURE_GRANT_TENANTS) {
      setGrantError(`در هر درخواست حداکثر ${MAX_FEATURE_GRANT_TENANTS} مستأجر مجاز است.`);
      return;
    }

    if (tenantIds.some((tenantId) => tenantId.length > MAX_TENANT_ID_LENGTH)) {
      setGrantError(`شناسه مستأجر باید حداکثر ${MAX_TENANT_ID_LENGTH} نویسه باشد.`);
      return;
    }

    void runFeatureAction(`grant:${feature.featureId}`, async () => {
      const result = await grantModuleFeature(module.moduleId, feature.featureId, tenantIds);
      setNotice(`مجوز ${result.granted} مستأجر ثبت شد.`);
      setGrantInput('');
      reloadWithOpenPanel();
    });
  };

  const revoke = (feature: ModuleFeatureSummary, tenantId: string) =>
    runFeatureAction(`revoke:${feature.featureId}:${tenantId}`, async () => {
      await revokeModuleFeature(module.moduleId, feature.featureId, tenantId);
      setNotice('مجوز این مستأجر لغو شد.');
      reloadWithOpenPanel();
    });

  /**
   * The tenant universe this console can honestly show, taken ENTIRELY from the server's
   * effective-state page (Phase 54-C closure fix).
   *
   * WHAT THIS REPLACED, AND WHY. The rows used to be built here by unioning `module.tenantIds` with
   * the grants and then calling `featureEffectiveState` — a browser-side rule that understood
   * `ALL` and `RESTRICTED` but not `RESTRICTED_MEMBERS`, so for HR (`tenantIds = []` by construction)
   * every tenant was judged out of scope and an ENTITLED tenancy rendered as «مسدود توسط ماژول».
   *
   * That rule is now the server's: the page already carries, per tenant, the tenancy's decision from
   * the same evaluator the request path uses, plus the CONFIGURED flags (`moduleEnabled`,
   * `featureEnabled`) and the enumeration SIZE (`tenantCount`, `null` for `ALL`). Nothing about
   * entitlement is reconstructed from `tenantScope` here, and `tenantIds` is not read at all.
   */
  const tenantRows = (feature: ModuleFeatureSummary) => {
    if (!statePage || statePage.featureId !== feature.featureId) return [];

    return statePage.rows.map((row) => ({
      tenantId: row.tenantId,
      granted: row.granted,
      grantedAt: row.grantedAt,
      effective: row.effective,
      hint: refusalHint(row.reasonCode),
    }));
  };

  /**
   * The sentence behind a refusal, so «مسدود توسط ماژول» is never the whole answer an operator gets.
   *
   * It reads the DECISION'S CODE, not the four-state projection: `BLOCKED_BY_MODULE` covers a disabled
   * module, a tenancy outside the scope and a missing module, and the operator needs to know WHICH.
   * The wording is the platform's own (`ENTITLEMENT_FAILURE_LABELS`, §43.5), so the console and the
   * gate a request is refused by speak one vocabulary.
   */
  const refusalHint = (reasonCode: 'ALLOWED' | EntitlementFailureCode): string =>
    reasonCode === 'ALLOWED' ? '' : entitlementFailureLabel(reasonCode);

  return (
    <section
      aria-label={`قابلیت‌های ${module.moduleId}`}
      className="mt-3 rounded-xl border border-border/70 bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            // Opening re-arms the feature fetch in the same commit (the removed
            // in-effect setters used to arm one render later); closing needs no
            // arm — the effect early-returns.
            if (!isOpen) {
              setIsLoading(true);
              setError(null);
            }
            setIsOpen((open) => !open);
          }}
          className="text-xs text-foreground underline"
        >
          {isOpen ? 'بستن قابلیت‌ها' : 'قابلیت‌ها — دسترسی قابلیت‌به‌قابلیت'}
        </button>

        {isOpen && canManage && (
          <Button
            type="button"
            onClick={() => setIsDeclareOpen((open) => !open)}
            className="text-xs"
          >
            {isDeclareOpen ? 'بستن فرم قابلیت' : 'اعلام قابلیت جدید'}
          </Button>
        )}
      </div>

      {isOpen && (
        <div className="mt-3 space-y-3">
          {notice && <Alert type="success" message={notice} />}
          {error && <Alert type="error" message={error} />}

          {isDeclareOpen && canManage && (
            <form
              onSubmit={declare}
              aria-label="اعلام قابلیت جدید"
              className="space-y-3 rounded-xl border border-border p-3"
            >
              {declareError && <Alert type="error" message={declareError} />}

              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  label="شناسه قابلیت"
                  name="featureId"
                  value={declareFeatureId}
                  onChange={(event) => setDeclareFeatureId(event.target.value)}
                  placeholder="leave"
                  required
                />
                <Input
                  label="نام نمایشی"
                  name="featureDisplayName"
                  value={declareDisplayName}
                  onChange={(event) => setDeclareDisplayName(event.target.value)}
                  required
                />
              </div>

              {/* Stated in the form, because it is the most common misreading of this API: a
                  declared feature is NOT offered until its offer is turned on (§43.3). */}
              <p className="text-xs text-muted-foreground">
                قابلیت تازه اعلام‌شده به‌صورت پیش‌فرض ارائه نمی‌شود؛ فعال‌سازی ارائه گام جداگانه‌ای
                است.
              </p>

              <Button type="submit" disabled={busy !== null} className="text-xs">
                اعلام قابلیت
              </Button>
            </form>
          )}

          {isLoading ? (
            <p className="text-xs text-muted-foreground">در حال بارگذاری قابلیت‌ها...</p>
          ) : features.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              برای این ماژول هنوز هیچ قابلیتی اعلام نشده است.
            </p>
          ) : (
            <ul className="space-y-2">
              {features.map((feature) => {
                const rows = tenantRows(feature);

                return (
                  <li key={feature.featureId} className="rounded-xl bg-muted/40 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <p className="text-foreground">
                          <code>{feature.featureId}</code> · {feature.displayName}
                        </p>
                        <p className="text-muted-foreground">
                          ارائه پلتفرم: {feature.enabled ? 'فعال' : 'غیرفعال'} · مستأجرهای دارای
                          مجوز: {feature.grantedTenantCount}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => {
                            const next =
                              openFeatureId === feature.featureId ? null : feature.featureId;
                            setOpenFeatureId(next);
                            // Re-arm the state-page read (or clear it on close)
                            // in the same commit — the removed in-effect setters
                            // used to do it one render later.
                            if (next) {
                              setStatePage(null);
                              setIsGrantsLoading(true);
                              setGrantsError(null);
                            } else {
                              setStatePage(null);
                            }
                          }}
                          className="text-xs"
                        >
                          {openFeatureId === feature.featureId ? 'بستن مستأجرها' : 'مستأجرها'}
                        </Button>

                        {canManage && (
                          <>
                            <Button
                              type="button"
                              onClick={() => toggleOffer(feature)}
                              disabled={busy !== null}
                              className="text-xs"
                            >
                              {feature.enabled ? 'غیرفعال‌سازی ارائه' : 'فعال‌سازی ارائه'}
                            </Button>
                            <Button
                              type="button"
                              onClick={() => {
                                setRenameTarget(
                                  renameTarget === feature.featureId ? null : feature.featureId
                                );
                                setRenameValue(feature.displayName);
                                setRenameError(null);
                              }}
                              disabled={busy !== null}
                              className="text-xs"
                            >
                              ویرایش نام
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {renameTarget === feature.featureId && canManage && (
                      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                        {renameError && <Alert type="error" message={renameError} />}
                        <Input
                          label="نام نمایشی قابلیت"
                          name={`featureDisplayName-${feature.featureId}`}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                        />
                        <Button
                          type="button"
                          onClick={() => rename(feature)}
                          disabled={busy !== null}
                          className="text-xs"
                        >
                          ذخیره نام
                        </Button>
                      </div>
                    )}

                    {openFeatureId === feature.featureId && (
                      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                        {grantsError && <Alert type="error" message={grantsError} />}

                        {canManage && (
                          <form
                            onSubmit={(event) => grant(event, feature)}
                            aria-label={`ثبت مجوز ${feature.featureId}`}
                            className="space-y-2"
                          >
                            {grantError && <Alert type="error" message={grantError} />}
                            <Textarea
                              label="شناسه مستأجرها (با کاما یا خط جدید جدا کنید)"
                              name={`grantTenantIds-${feature.featureId}`}
                              value={grantInput}
                              onChange={(event) => setGrantInput(event.target.value)}
                              rows={2}
                            />
                            <Button type="submit" disabled={busy !== null} className="text-xs">
                              ثبت مجوز
                            </Button>
                          </form>
                        )}

                        {isGrantsLoading ? (
                          <p className="text-muted-foreground">در حال بارگذاری مستأجرها...</p>
                        ) : rows.length === 0 ? (
                          <p className="text-muted-foreground">
                            هنوز مستأجری در دامنه این ماژول یا در فهرست مجوزها نیست.
                          </p>
                        ) : (
                          <ul className="space-y-1">
                            {rows.map((row) => {
                              const presentation =
                                FEATURE_EFFECTIVE_STATE_PRESENTATION[row.effective];

                              return (
                                <li
                                  key={row.tenantId}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-2 py-1"
                                >
                                  <span className="flex flex-wrap items-center gap-2">
                                    <code className="text-foreground">{row.tenantId}</code>
                                    {/* NEVER COLOUR ALONE (§30): a symbol AND a Persian label. */}
                                    <span
                                      className={`inline-flex items-center gap-1 ${presentation.className}`}
                                    >
                                      <span aria-hidden="true">{presentation.symbol}</span>
                                      <span>{presentation.label}</span>
                                    </span>
                                    {row.hint && (
                                      <span className="text-muted-foreground">{row.hint}</span>
                                    )}
                                    {row.grantedAt && (
                                      <span className="text-muted-foreground">
                                        مجوز از {formatModuleTime(row.grantedAt)}
                                      </span>
                                    )}
                                  </span>

                                  {canManage && row.granted && (
                                    <Button
                                      type="button"
                                      aria-label={`لغو مجوز ${row.tenantId}`}
                                      onClick={() => revoke(feature, row.tenantId)}
                                      disabled={busy !== null}
                                      className="text-xs"
                                    >
                                      لغو مجوز
                                    </Button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}

                        {/* WHAT THIS LIST IS, said out loud: the server's page is bounded and
                            cursor-continued, so a larger population must be visible rather than
                            implied. `tenantCount` is the enumeration the page draws from — `null` for
                            an `ALL` module, whose rows are therefore grants alone and nothing else. */}
                        <p className="text-muted-foreground">
                          {module.tenantScope === 'ALL'
                            ? 'دامنه این ماژول «همه مستأجرها» است؛ این فهرست فقط مستأجرهای دارای مجوز را نشان می‌دهد.'
                            : 'این فهرست ترکیب مستأجرهای دامنه ماژول (شامل اعضای ثبت‌شده) و مجوزهای ثبت‌شده است.'}
                          {statePage?.nextCursor
                            ? ` نمایش ${statePage.rows.length} سطر نخست از ${statePage.tenantCount ?? 'بیش از یک صفحه'}.`
                            : ''}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function CoreModulesView() {
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);
  // `manage` does NOT imply `read`: the controller gates the reads on the read string specifically,
  // so the view is gated on it too rather than on either-of.
  const canRead = permissions.includes(READ_PERMISSION);
  const canManage = permissions.includes(MANAGE_PERMISSION);

  const [modules, setModules] = React.useState<ModuleRegistration[]>([]);
  const [platform, setPlatform] = React.useState<ModulePlatformDescriptor | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in every reload handler below (same commit as the
  // token bump), so the list effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  const [isFormOpen, setIsFormOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const [notice, setNotice] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [verdict, setVerdict] = React.useState<{
    instanceId: string;
    value: ModuleHealthVerdict;
  } | null>(null);

  /**
   * The generated credential, held ONCE and in component state only.
   *
   * Never written to localStorage, sessionStorage, a cookie or the URL: it is unrecoverable after
   * this render, which is the point — the operator copies it into the module and it is gone.
   */
  const [freshCredential, setFreshCredential] = React.useState<{
    id: string;
    secret: string;
  } | null>(null);

  React.useEffect(() => {
    // No request is issued without the read permission: it would be a guaranteed
    // 403. The render gates on `!canRead` BEFORE the loading flag, so the
    // skeleton never strands a forbidden caller (the reason this branch used to
    // flip `isLoading` synchronously — `react-hooks/set-state-in-effect`).
    if (isPermissionsLoading || !canRead) return;

    let active = true;

    // TWO reads, in parallel, ONCE per page load — not per row (§45). The platform descriptor is
    // fetched from the server rather than duplicated in the client bundle.
    Promise.all([listModules(), getModulePlatform()])
      .then(([rows, descriptor]) => {
        if (!active) return;
        setModules(rows);
        setPlatform(descriptor);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError({
          message: err instanceof Error ? err.message : 'دریافت فهرست ماژول‌ها با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canRead, isPermissionsLoading, reloadToken]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setIsFormOpen(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const moduleId = form.moduleId.trim();
    const displayName = form.displayName.trim();

    // Local validation mirrors the DTO and the SQL CHECK, so an obvious mistake is a message rather
    // than a round trip. The server remains the authority.
    if (!isValidModuleId(moduleId)) {
      setFormError('شناسه ماژول باید ۲ تا ۶۴ نویسه، حروف کوچک انگلیسی و خط تیره باشد.');
      return;
    }

    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      setFormError('نام نمایشی الزامی است.');
      return;
    }

    const tenantIds = form.tenantIds
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (form.tenantScope === 'RESTRICTED' && tenantIds.length === 0) {
      setFormError('برای دامنه محدود، حداقل یک شناسه مستأجر لازم است.');
      return;
    }

    setIsSaving(true);

    try {
      await createModule({
        moduleId,
        displayName,
        moduleType: form.moduleType,
        tenantScope: form.tenantScope,
        ...(form.tenantScope === 'RESTRICTED' ? { tenantIds } : {}),
      });

      // NOT enabled here, and the notice says so: a module is admitted disabled, then reviewed.
      setNotice('ماژول ثبت شد. برای فعال‌سازی، ابتدا کلید دسترسی را صادر کنید.');
      resetForm();
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'ثبت ماژول با خطا مواجه شد.');
    } finally {
      setIsSaving(false);
    }
  };

  /** One helper for every row action, so a busy row cannot be double-actioned. */
  const runRowAction = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setRowError(null);
    setNotice(null);

    try {
      await action();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'انجام عملیات با خطا مواجه شد.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (module: ModuleRegistration) =>
    runRowAction(module.id, async () => {
      await updateModule(module.id, { enabled: !module.enabled });
      setNotice(module.enabled ? 'ماژول غیرفعال شد.' : 'ماژول فعال شد.');
      reload();
    });

  const rotate = (module: ModuleRegistration) =>
    runRowAction(module.id, async () => {
      const { secret } = await rotateModuleCredential(module.id);
      // Shown ONCE. No later request can retrieve it.
      setFreshCredential({ id: module.id, secret });
      setNotice('کلید دسترسی جدید صادر شد. آن را همین حالا در تنظیمات ماژول ثبت کنید.');
      reload();
    });

  const remove = (module: ModuleRegistration) =>
    runRowAction(module.id, async () => {
      await deleteModule(module.id);
      setNotice('ماژول و نمونه‌های آن حذف شد.');
      reload();
    });

  const probe = (module: ModuleRegistration, instanceId: string) =>
    runRowAction(module.id, async () => {
      const value = await testModuleInstance(module.id, instanceId);
      setVerdict({ instanceId, value });
      reload();
    });

  if (isPermissionsLoading) {
    return <CoreLoading label="در حال بارگذاری ماژول‌ها..." />;
  }

  // Presentation-only gate. The controller enforces the same permission on every route.
  // Checked BEFORE the loading flag: the fetch effect never starts without the
  // grant, so `isLoading` would stay true forever for a caller without it —
  // this ordering replaces the effect branch that used to flip it synchronously
  // (`react-hooks/set-state-in-effect`).
  if (!canRead) {
    return <CoreForbidden />;
  }

  if (isLoading) {
    return <CoreLoading label="در حال بارگذاری ماژول‌ها..." />;
  }

  if (error?.status === 403) {
    return <CoreForbidden />;
  }

  if (error) {
    return <CoreError message={error.message} onRetry={reload} />;
  }

  return (
    <div className="space-y-6" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Boxes className="h-5 w-5" aria-hidden="true" />
            ماژول‌ها و سرویس‌های متصل
          </h1>
          <p className="text-sm text-muted-foreground">
            ماژول‌ها را در پلتفرم ثبت و فعال کنید. محل استقرار هر ماژول را خودِ ماژول هنگام ثبت
            اعلام می‌کند و در این صفحه فقط نمایش داده می‌شود.
          </p>
        </div>

        {canManage && (
          <Button type="button" onClick={() => setIsFormOpen((open) => !open)} className="text-sm">
            {isFormOpen ? 'بستن فرم' : 'ثبت ماژول جدید'}
          </Button>
        )}
      </header>

      {platform && (
        <section
          aria-label="مشخصات پلتفرم"
          className="grid gap-3 rounded-2xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4"
        >
          <div>
            <span className="block text-foreground">نسخه پروتکل</span>
            {platform.protocolVersion}
          </div>
          <div>
            <span className="block text-foreground">قرارداد پایه</span>
            <code>{platform.baseContract}</code>
          </div>
          <div>
            <span className="block text-foreground">فاصله ضربان</span>
            {Math.round(platform.heartbeatIntervalMs / 1000)} ثانیه
          </div>
          <div>
            <span className="block text-foreground">آستانه بی‌پاسخی</span>
            {Math.round(platform.staleAfterMs / 1000)} ثانیه
          </div>
        </section>
      )}

      {notice && <Alert type="success" message={notice} />}
      {rowError && <Alert type="error" message={rowError} />}

      {freshCredential && (
        <Alert
          type="warning"
          message={`کلید دسترسی: ${freshCredential.secret} — این مقدار دیگر نمایش داده نمی‌شود.`}
        />
      )}

      {verdict && (
        <section
          aria-label="نتیجه آزمایش اتصال"
          className="rounded-2xl border border-border p-4 text-sm"
        >
          <p className="mb-2 font-medium text-foreground">آزمایش اتصال — {verdict.instanceId}</p>
          {/* THE THREE FACTS, SEPARATELY (§13). A single "OK/FAIL" would hide which one failed. */}
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>در فهرست ثبت شده: {verdict.value.registryKnown ? 'بله' : 'خیر'}</li>
            <li>نشانی پاسخ داد: {verdict.value.endpointReachable ? 'بله' : 'خیر'}</li>
            <li>برنامه سالم است: {verdict.value.applicationHealthy ? 'بله' : 'خیر'}</li>
            <li className="pt-1">
              وضعیت: <HealthBadge state={verdict.value.state} />
            </li>
            {verdict.value.errorCode && <li>{healthErrorLabel(verdict.value.errorCode)}</li>}
          </ul>
        </section>
      )}

      {isFormOpen && canManage && (
        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl border border-border p-4"
          aria-label="ثبت ماژول جدید"
        >
          {formError && <Alert type="error" message={formError} />}

          <div className="grid gap-4 md:grid-cols-2">
            <Input
              label="شناسه ماژول"
              name="moduleId"
              value={form.moduleId}
              onChange={(event) => setForm({ ...form, moduleId: event.target.value })}
              placeholder="finance"
              required
            />
            <Input
              label="نام نمایشی"
              name="displayName"
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              required
            />
          </div>

          {/*
            THERE IS NO ENDPOINT FIELD HERE, and no version field either. Both belong to a running
            instance and are written by the module's own authenticated registration (§40).
          */}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-2 block font-medium text-foreground">نوع ماژول</span>
              <select
                name="moduleType"
                value={form.moduleType}
                onChange={(event) =>
                  setForm({ ...form, moduleType: event.target.value as ModuleType })
                }
                className="w-full rounded-md border border-input bg-surface px-4 py-2 text-foreground"
              >
                {(Object.keys(MODULE_TYPE_LABELS) as ModuleType[]).map((type) => (
                  <option key={type} value={type}>
                    {MODULE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-2 block font-medium text-foreground">دامنه مستأجرها</span>
              <select
                name="tenantScope"
                value={form.tenantScope}
                onChange={(event) =>
                  setForm({ ...form, tenantScope: event.target.value as 'ALL' | 'RESTRICTED' })
                }
                className="w-full rounded-md border border-input bg-surface px-4 py-2 text-foreground"
              >
                <option value="ALL">همه مستأجرها</option>
                <option value="RESTRICTED">فقط مستأجرهای مشخص</option>
              </select>
            </label>
          </div>

          {form.tenantScope === 'RESTRICTED' && (
            <Input
              label="شناسه مستأجرها (با کاما جدا کنید)"
              name="tenantIds"
              value={form.tenantIds}
              onChange={(event) => setForm({ ...form, tenantIds: event.target.value })}
            />
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving} className="text-sm">
              {isSaving ? 'در حال ثبت...' : 'ثبت ماژول'}
            </Button>
            <Button type="button" onClick={resetForm} className="text-sm">
              انصراف
            </Button>
          </div>
        </form>
      )}

      {modules.length === 0 ? (
        <CoreEmpty message="هیچ ماژولی ثبت نشده است." />
      ) : (
        <ul className="space-y-4">
          {modules.map((module) => (
            <li key={module.id} className="space-y-3 rounded-2xl border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {module.displayName}{' '}
                    <code className="text-xs text-muted-foreground">{module.moduleId}</code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {MODULE_TYPE_LABELS[module.moduleType]} · {moduleStatusLabel(module)} ·{' '}
                    {tenantScopeLabel(module)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    کلید دسترسی: {credentialStatusLabel(module)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <HealthBadge state={module.aggregateHealth} />
                  <span className="text-xs text-muted-foreground">
                    {LIFECYCLE_LABELS[module.derivedLifecycle]}
                  </span>
                </div>
              </div>

              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => toggleEnabled(module)}
                    disabled={busyId === module.id}
                    className="text-xs"
                  >
                    {module.enabled ? 'غیرفعال کردن' : 'فعال کردن'}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => rotate(module)}
                    disabled={busyId === module.id}
                    className="text-xs"
                  >
                    <KeyRound className="me-1 inline h-3 w-3" aria-hidden="true" />
                    صدور کلید جدید
                  </Button>
                  <Button
                    type="button"
                    onClick={() => remove(module)}
                    disabled={busyId === module.id}
                    className="text-xs"
                  >
                    <Trash2 className="me-1 inline h-3 w-3" aria-hidden="true" />
                    حذف
                  </Button>
                </div>
              )}

              {module.instances.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  هنوز هیچ نمونه‌ای از این ماژول خودش را ثبت نکرده است.
                </p>
              ) : (
                <ul className="space-y-2">
                  {module.instances.map((instance) => (
                    <li
                      key={instance.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs"
                    >
                      <div className="space-y-1">
                        <p className="text-foreground">
                          <code>{instance.instanceId}</code> · نسخه {instance.version} ·{' '}
                          {/* The mode is DISPLAYED, never branched on. */}
                          {DEPLOYMENT_MODE_LABELS[instance.deploymentMode]}
                        </p>
                        <p className="text-muted-foreground">
                          {LIFECYCLE_LABELS[instance.lifecycle]}
                          {instance.lastSeenAt
                            ? ` · آخرین ضربان ${formatModuleTime(instance.lastSeenAt)}`
                            : ' · هنوز ضربانی دریافت نشده'}
                          {instance.stale ? ' · بی‌پاسخ' : ''}
                        </p>
                        {instance.capabilities.length > 0 && (
                          <p className="text-muted-foreground">
                            توانمندی‌ها: {instance.capabilities.join('، ')}
                          </p>
                        )}
                        {instance.healthErrorCode && (
                          <p className="text-muted-foreground">
                            {healthErrorLabel(instance.healthErrorCode)}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <HealthBadge state={instance.stale ? 'UNAVAILABLE' : instance.health} />
                        {canManage && (
                          <Button
                            type="button"
                            onClick={() => probe(module, instance.instanceId)}
                            disabled={busyId === module.id}
                            className="text-xs"
                          >
                            <RefreshCw className="me-1 inline h-3 w-3" aria-hidden="true" />
                            آزمایش اتصال
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <ModuleFeaturesSection module={module} canManage={canManage} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
