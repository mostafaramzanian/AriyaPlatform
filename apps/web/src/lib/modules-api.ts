import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 49M: distributed module platform client.
 *
 * Mirrors `ModuleRegistryController` exactly (`GET /admin/modules/platform`,
 * `GET /admin/modules`, `GET /admin/modules/:id`, `POST /admin/modules`,
 * `PATCH /admin/modules/:id`, `DELETE /admin/modules/:id`,
 * `POST /admin/modules/:id/credential`, `POST /admin/modules/:id/instances/:instanceId/test`,
 * `GET /admin/modules/by-module/:moduleId/capabilities`, `POST /admin/modules/invoke`).
 *
 * FIVE THINGS THIS MODULE DELIBERATELY CANNOT DO:
 *
 * 1. READ A CREDENTIAL BACK. `ModuleRegistration` has no `secret` field, because the server's
 *    single projection has no branch that emits the ciphertext, the IV or the tag. The only
 *    credential facts client-side are `hasCredential` and `credentialUpdatedAt`, so a component
 *    cannot render a value it was never given. `rotateModuleCredential` is the one exception and
 *    it returns a NEWLY GENERATED credential, once.
 *
 * 2. RENAME A MODULE. `UpdateModuleInput` omits `moduleId` for the same reason the DTO omits it:
 *    the id is what every resolution, signature and audit row is keyed by, so renaming one would
 *    reassign a credential and a tenant scope to a different identity.
 *
 * 3. TYPE AN ENDPOINT. There is no `baseUrl` on any input here. An endpoint belongs to a running
 *    instance and is written by the module's own authenticated registration — which is half of the
 *    §40 SSRF answer, and the reason an administrator cannot point Core at an internal service.
 *
 * 4. CHOOSE A CALL DESTINATION. `invokeModule` takes a LOGICAL module id, a contract and an
 *    operation. There is no `url` parameter, so this client cannot be used to make Core issue an
 *    arbitrary outbound request.
 *
 * 5. REGISTER, HEARTBEAT OR DEREGISTER. `POST /modules/register|heartbeat|deregister` are INBOUND
 *    routes for a module, authenticated by HMAC. They are deliberately absent from this file: the
 *    browser has no module credential and no reason to announce an instance.
 *
 * THE PLATFORM DESCRIPTOR IS READ FROM THE SERVER (`getModulePlatform`) and is not duplicated
 * here — the same rule `integrations-api.ts` (49L) follows for the integration catalogue and
 * `ai-api.ts` (49J-0) for the capability matrix. Every DTO runs under `whitelist` +
 * `forbidNonWhitelisted`, so an extra property is a 400 rather than a silently dropped field.
 */

/** Matches the `ModuleType` enum. */
export type ModuleType = 'CORE' | 'BUSINESS' | 'INTEGRATION';

/**
 * Matches the `ModuleDeploymentMode` enum.
 *
 * DISPLAY ONLY IN THIS FILE. Nothing here branches on it beyond rendering a label: local/remote is
 * a deployment fact, and a UI that behaved differently per mode would be re-introducing exactly the
 * coupling the phase removes.
 */
export type ModuleDeploymentMode = 'LOCAL' | 'REMOTE' | 'CENTRAL' | 'HYBRID';

/** Matches `ModuleLifecycleState`, plus the server-DERIVED `DISCOVERED`. */
export type ModuleLifecycle =
  | 'DISCOVERED'
  | 'REGISTERED'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'DISABLED'
  | 'DEREGISTERED'
  | 'INCOMPATIBLE';

/** Matches the `ModuleHealthState` enum. */
export type ModuleHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'DISABLED' | 'UNKNOWN';

/** Matches the `ModuleTenantScope` enum. */
/**
 * Which tenants a module admits (Phase 54-A D15/D16, §43.7).
 *
 * THREE members, and the third one is the D16 correction: `RESTRICTED` enumerates tenants in the
 * module row's own `tenantIds` array (bounded at 64 by a database CHECK), while `RESTRICTED_MEMBERS`
 * enumerates them in Core's `ModuleRegistrationTenant` child table — presence is membership, there is
 * no bound, and HR was moved to it precisely because 162 tenants existed against a 64-entry cap.
 * `ALL` names no tenants at all, which is why its tenant enumeration is empty by definition.
 */
export type ModuleTenantScope = 'ALL' | 'RESTRICTED' | 'RESTRICTED_MEMBERS';

/** Backend bounds, restated so a form can refuse locally instead of discovering a 422. */
export const MAX_MODULE_ID_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_TENANT_IDS = 64;

/**
 * The feature-level bounds, mirroring `platform/entitlement/dto/module-feature.dto.ts`.
 *
 * Declared separately from `MAX_TENANT_IDS` even though the two numbers agree today, because they are
 * two different constraints in the API: one bounds a module's enumerated scope array, the other bounds
 * how many tenants ONE grant call may name. The single tenant-id LENGTH rule is the third, and it is
 * the one that catches a pasted paragraph arriving as an id.
 */
export const MAX_TENANT_ID_LENGTH = 64;
export const MAX_FEATURE_GRANT_TENANTS = 64;

/** Slug rule, mirroring the DTO and the SQL CHECK. */
export const MODULE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Feature-id bounds, mirroring `ModuleFeature_featureId_format` in the Core migration and the
 * feature DTO that sits in front of it: the same slug shape as a module id, with the same 2-64
 * length window. Declared SEPARATELY from `MODULE_ID_PATTERN` even though it is the same regular
 * expression, so a form validating a feature id cannot start accepting module-id rules by drift —
 * the SQL CHECKs are two constraints, and the client mirrors the constraints rather than the regex.
 */
export const MAX_FEATURE_ID_LENGTH = 64;
export const FEATURE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One deployed instance, exactly as the server projects it. */
export interface ModuleInstance {
  id: string;
  instanceId: string;
  moduleId: string;
  deploymentMode: ModuleDeploymentMode;
  version: string;
  /** Null for a LOCAL in-process instance. Admin-only, never rendered to a non-admin. */
  baseUrl: string | null;
  healthPath: string;
  capabilities: string[];
  apiContracts: string[];
  eventContracts: string[];
  lifecycle: Exclude<ModuleLifecycle, 'DISCOVERED'>;
  health: ModuleHealth;
  healthErrorCode: string | null;
  lastSeenAt: string | null;
  lastProbedAt: string | null;
  /** Server-computed: `lastSeenAt` older than the platform's stale threshold. */
  stale: boolean;
  createdAt: string;
}

/** One logical module, exactly as the server projects it. */
export interface ModuleRegistration {
  id: string;
  moduleId: string;
  displayName: string;
  moduleType: ModuleType;
  enabled: boolean;
  tenantScope: ModuleTenantScope;
  tenantIds: string[];
  protocolVersion: number;
  /** Whether a credential is stored. NOT the credential, nor its length. */
  hasCredential: boolean;
  credentialUpdatedAt: string | null;
  credentialExpiresAt: string | null;
  derivedLifecycle: ModuleLifecycle;
  aggregateHealth: ModuleHealth;
  instances: ModuleInstance[];
  createdAt: string;
  updatedAt: string;
}

/** The platform's own descriptor. Read from the server; never duplicated client-side. */
export interface ModulePlatformDescriptor {
  protocolVersion: number;
  baseContract: string;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  foundations: {
    conflictPolicies: string[];
    defaultConflictPolicy: string;
    provisioningSteps: string[];
    /** Both FALSE in this phase, and the UI says so rather than implying capability. */
    syncImplemented: boolean;
    provisioningImplemented: boolean;
  };
}

/** The three-part health verdict (§13), kept distinguishable in the client too. */
export interface ModuleHealthVerdict {
  registryKnown: boolean;
  endpointReachable: boolean;
  applicationHealthy: boolean;
  state: ModuleHealth;
  errorCode?: string;
}

/** Capability discovery for one logical module. Narrower than the admin projection. */
export interface ModuleCapabilityReport {
  moduleId: string;
  displayName: string;
  enabled: boolean;
  derivedLifecycle: ModuleLifecycle;
  aggregateHealth: ModuleHealth;
  instances: {
    instanceId: string;
    version: string;
    deploymentMode: ModuleDeploymentMode;
    lifecycle: Exclude<ModuleLifecycle, 'DISCOVERED'>;
    health: ModuleHealth;
    capabilities: string[];
    apiContracts: string[];
    eventContracts: string[];
  }[];
}

/** Normalized call outcome. No status code, no headers, no endpoint. */
export interface ModuleCallOutcome {
  ok: boolean;
  data?: unknown;
  errorCode?: string;
  instanceId?: string;
  correlationId?: string;
}

export interface CreateModuleInput {
  moduleId: string;
  displayName: string;
  moduleType?: ModuleType;
  enabled?: boolean;
  tenantScope?: ModuleTenantScope;
  tenantIds?: string[];
}

/** No `moduleId`, and no `baseUrl`. See the header note. */
export interface UpdateModuleInput {
  displayName?: string;
  moduleType?: ModuleType;
  enabled?: boolean;
  tenantScope?: ModuleTenantScope;
  tenantIds?: string[];
}

export async function getModulePlatform(): Promise<ModulePlatformDescriptor> {
  return coreGet<ModulePlatformDescriptor>('/admin/modules/platform');
}

export async function listModules(): Promise<ModuleRegistration[]> {
  return coreGet<ModuleRegistration[]>('/admin/modules');
}

export async function getModule(id: string): Promise<ModuleRegistration> {
  return coreGet<ModuleRegistration>(`/admin/modules/${id}`);
}

export async function createModule(input: CreateModuleInput): Promise<ModuleRegistration> {
  return corePost<ModuleRegistration>('/admin/modules', input);
}

/**
 * Partial update.
 *
 * Only the keys the caller actually set are sent, so an untouched field is genuinely omitted rather
 * than sent as `undefined` — the same explicit-spread pattern `integrations-api.ts` uses, and the
 * reason `forbidNonWhitelisted` never trips on a field the user did not edit.
 */
export async function updateModule(
  id: string,
  input: UpdateModuleInput
): Promise<ModuleRegistration> {
  return corePatch<ModuleRegistration>(`/admin/modules/${id}`, {
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.moduleType !== undefined ? { moduleType: input.moduleType } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.tenantScope !== undefined ? { tenantScope: input.tenantScope } : {}),
    ...(input.tenantIds !== undefined ? { tenantIds: input.tenantIds } : {}),
  });
}

export async function deleteModule(id: string): Promise<{ id: string; deleted: true }> {
  return coreDelete<{ id: string; deleted: true }>(`/admin/modules/${id}`);
}

/**
 * Generates a new module credential server-side and returns it ONCE.
 *
 * The only function here that ever holds a credential. The caller must display it for the operator
 * to copy into the module's configuration and must not persist it anywhere — no later request can
 * retrieve it.
 */
export async function rotateModuleCredential(id: string): Promise<{ secret: string }> {
  return corePost<{ secret: string }>(`/admin/modules/${id}/credential`);
}

/**
 * Live probe of ONE instance. Resolves with a verdict for both outcomes — an unreachable module is
 * not an HTTP error — so the caller renders a message either way rather than a thrown error.
 */
export async function testModuleInstance(
  id: string,
  instanceId: string
): Promise<ModuleHealthVerdict> {
  return corePost<ModuleHealthVerdict>(
    `/admin/modules/${id}/instances/${encodeURIComponent(instanceId)}/test`
  );
}

export async function getModuleCapabilities(moduleId: string): Promise<ModuleCapabilityReport> {
  return coreGet<ModuleCapabilityReport>(
    `/admin/modules/by-module/${encodeURIComponent(moduleId)}/capabilities`
  );
}

/**
 * Diagnostic invoke. Takes a LOGICAL module id — never a URL.
 *
 * Resolves for both outcomes, like the probe: `ok: false` with a short code is a state of the
 * distributed system, not a failure of this request.
 */
export async function invokeModule(input: {
  moduleId: string;
  contract: string;
  operation: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ModuleCallOutcome> {
  return corePost<ModuleCallOutcome>('/admin/modules/invoke', {
    moduleId: input.moduleId,
    contract: input.contract,
    operation: input.operation,
    payload: input.payload,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
}

/**
 * Phase 54-C (§43.8): the FEATURE-entitlement client — the six admin routes an operator uses to
 * declare a feature and grant it to tenants.
 *
 * WHY THIS LIVES BESIDE THE REGISTRY CLIENT. The routes hang off the registry's own path prefix
 * (`admin/modules/:moduleId/features/**`) because an operator looks for modules and their features
 * in ONE place — and both permission codes are the registry's EXISTING read and manage codes, so no
 * permission matrix had to be re-seeded for entitlement administration.
 *
 * THE TENANT IDS IN A GRANT BODY ARE NOT A §25-rule-7 VIOLATION, and the distinction is stated here
 * where a reader might try to "fix" one into the other: rule 7 forbids a client from choosing the
 * tenancy of a REQUEST (the request's tenant is read from the actor and nothing else, §43.5),
 * whereas a grant states a CONFIGURATION fact about tenants the caller administers — under a manage
 * permission, and recorded in the audit trail. Collapsing the two would either break administration
 * or let a caller claim a tenant.
 */

/** The frozen §43.2 refusal vocabulary, plus the guard's wiring code (§43.5). */
export type EntitlementFailureCode =
  | 'MODULE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MODULE_FORBIDDEN'
  | 'FEATURE_NOT_FOUND'
  | 'FEATURE_DISABLED'
  | 'FEATURE_NOT_GRANTED'
  | 'ENTITLEMENT_NOT_DECLARED';

/** One declared feature, as the admin surface projects it. */
export interface ModuleFeatureSummary {
  id: string;
  moduleId: string;
  featureId: string;
  displayName: string;
  /**
   * The platform's OFFER. A declared feature starts `enabled = false` (§43.3), so declaring is not
   * the same act as offering, and turning it off refuses ACCESS without deleting anything.
   */
  enabled: boolean;
  /** A COUNT rather than the list: the granted tenants have their own bounded route. */
  grantedTenantCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One tenant's grant, as the admin surface projects it. Presence is the grant. */
export interface ModuleFeatureGrantRow {
  tenantId: string;
  grantedAt: string;
}

export interface DeclareFeatureInput {
  featureId: string;
  displayName: string;
}

/** Only what an operator may change: the name, and whether the platform offers the feature. */
export interface UpdateFeatureInput {
  displayName?: string;
  enabled?: boolean;
}

export async function listModuleFeatures(moduleId: string): Promise<ModuleFeatureSummary[]> {
  return coreGet<ModuleFeatureSummary[]>(`/admin/modules/${encodeURIComponent(moduleId)}/features`);
}

export async function declareModuleFeature(
  moduleId: string,
  input: DeclareFeatureInput
): Promise<ModuleFeatureSummary> {
  return corePost<ModuleFeatureSummary>(`/admin/modules/${encodeURIComponent(moduleId)}/features`, {
    featureId: input.featureId,
    displayName: input.displayName,
  });
}

export async function updateModuleFeature(
  moduleId: string,
  featureId: string,
  input: UpdateFeatureInput
): Promise<ModuleFeatureSummary> {
  // Only the keys the caller actually set are sent — the same explicit-spread rule `updateModule`
  // follows, so an untouched field is genuinely omitted rather than sent as `undefined`.
  return corePatch<ModuleFeatureSummary>(
    `/admin/modules/${encodeURIComponent(moduleId)}/features/${encodeURIComponent(featureId)}`,
    {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }
  );
}

export async function listModuleFeatureTenants(
  moduleId: string,
  featureId: string
): Promise<ModuleFeatureGrantRow[]> {
  return coreGet<ModuleFeatureGrantRow[]>(
    `/admin/modules/${encodeURIComponent(moduleId)}/features/${encodeURIComponent(featureId)}/tenants`
  );
}

/**
 * Grant the feature to tenants. 1-64 ids per call, which is the server's bound and therefore the
 * form's: a longer list is refused locally instead of through a `422`.
 */
export async function grantModuleFeature(
  moduleId: string,
  featureId: string,
  tenantIds: string[]
): Promise<{ granted: number }> {
  return corePost<{ granted: number }>(
    `/admin/modules/${encodeURIComponent(moduleId)}/features/${encodeURIComponent(featureId)}/tenants`,
    { tenantIds }
  );
}

export async function revokeModuleFeature(
  moduleId: string,
  featureId: string,
  tenantId: string
): Promise<{ revoked: true }> {
  return coreDelete<{ revoked: true }>(
    `/admin/modules/${encodeURIComponent(moduleId)}/features/${encodeURIComponent(featureId)}/tenants/${encodeURIComponent(tenantId)}`
  );
}

/**
 * Persian labels for the DEPLOYMENT mode.
 *
 * A COMPLETE RECORD rather than a switch with a default, so adding a mode is a type error here
 * instead of silently rendering the raw enum name to an operator. Same rule
 * `AUTOMATION_STATUS_LABELS` (49L) follows.
 */
export const DEPLOYMENT_MODE_LABELS: Record<ModuleDeploymentMode, string> = {
  LOCAL: 'محلی',
  REMOTE: 'راه دور',
  CENTRAL: 'مرکزی',
  HYBRID: 'ترکیبی',
};

/** Persian labels for the module TYPE. */
export const MODULE_TYPE_LABELS: Record<ModuleType, string> = {
  CORE: 'هسته',
  BUSINESS: 'کاری',
  INTEGRATION: 'یکپارچه‌سازی',
};

/** Persian labels for the lifecycle, including the derived `DISCOVERED`. */
export const LIFECYCLE_LABELS: Record<ModuleLifecycle, string> = {
  DISCOVERED: 'ثبت‌شده — بدون نمونه',
  REGISTERED: 'ثبت‌شده',
  ACTIVE: 'فعال',
  DEGRADED: 'با کارکرد محدود',
  UNAVAILABLE: 'در دسترس نیست',
  DISABLED: 'غیرفعال',
  DEREGISTERED: 'خارج‌شده',
  INCOMPATIBLE: 'ناسازگار',
};

/**
 * Health presentation: a symbol, a Persian label and a Tailwind text class.
 *
 * §30 asks for useful statuses AND explicitly says not to rely on colour alone — so every entry
 * carries a SYMBOL and a TEXT LABEL as well as a class. A colour-blind operator and a screen-reader
 * user both get the state from the label; the symbol and the colour are redundant reinforcement.
 */
export const HEALTH_PRESENTATION: Record<
  ModuleHealth,
  { symbol: string; label: string; className: string }
> = {
  HEALTHY: { symbol: '🟢', label: 'سالم', className: 'text-emerald-600 dark:text-emerald-400' },
  DEGRADED: { symbol: '🟡', label: 'با اختلال', className: 'text-amber-600 dark:text-amber-400' },
  UNAVAILABLE: { symbol: '🔴', label: 'در دسترس نیست', className: 'text-destructive' },
  DISABLED: { symbol: '⚪', label: 'غیرفعال', className: 'text-muted-foreground' },
  UNKNOWN: { symbol: '⚪', label: 'نامشخص', className: 'text-muted-foreground' },
};

/**
 * Short, operator-facing explanation of a health error code.
 *
 * Falls back to the RAW CODE rather than to a generic message: an unrecognised code is still more
 * useful to an operator than "an error occurred", and the codes are deliberately short and internal
 * (never an upstream body).
 */
export const HEALTH_ERROR_LABELS: Record<string, string> = {
  TIMEOUT: 'پاسخی در زمان مجاز دریافت نشد.',
  UNREACHABLE: 'اتصال به سرویس برقرار نشد.',
  SSRF_BLOCKED: 'نشانی سرویس بر اساس سیاست امنیتی مجاز نیست.',
  NO_HEALTH_STATE: 'سرویس پاسخ داد اما وضعیت سلامت را اعلام نکرد.',
  MODULE_REPORTED_UNHEALTHY: 'سرویس خودش را ناسالم اعلام کرد.',
  VERSION_DRIFT: 'نسخه اعلام‌شده با نسخه ثبت‌شده یکسان نیست.',
  HEARTBEAT_STALE: 'ضربان سرویس قطع شده است.',
  NO_ENDPOINT: 'برای این نمونه نشانی ثبت نشده است.',
  UNKNOWN_INSTANCE: 'این نمونه در فهرست ثبت نشده است.',
  PROTOCOL_MISMATCH: 'نسخه پروتکل پلتفرم سازگار نیست.',
  CONTRACT_MISSING: 'قرارداد پایه پلتفرم را ارائه نمی‌کند.',
  CONTRACT_MALFORMED: 'یکی از قراردادهای اعلام‌شده معتبر نیست.',
  CAPABILITY_MALFORMED: 'یکی از توانمندی‌های اعلام‌شده معتبر نیست.',
};

export function healthErrorLabel(code: string | null | undefined): string {
  if (!code) return '';
  return HEALTH_ERROR_LABELS[code] ?? code;
}

/**
 * Persian labels for the §43.2 refusal vocabulary, plus the guard's `ENTITLEMENT_NOT_DECLARED`
 * (§43.5) — the code that describes a DECORATED surface whose declaration is missing.
 *
 * A COMPLETE RECORD over the union, like every other label record in this file subject to the
 * stronger version of the rule: adding a failure code to the server's frozen set is a TYPE ERROR
 * here, so no raw machine code can reach an operator. The console keeps its own copy because it
 * cannot import across the app boundary — the values are the same sentences the server's
 * `ENTITLEMENT_FAILURE_LABELS` carries, so an operator and a support engineer read one vocabulary.
 *
 * WHY A MISSING DECLARATION IS RENDERED AT ALL. It is not a decision: it means the platform's own
 * wiring is incomplete on that route. A `403` an operator cannot tell apart from a real refusal
 * would send somebody to the registry to look for an entitlement that was never the question.
 */
export const ENTITLEMENT_FAILURE_LABELS: Record<EntitlementFailureCode, string> = {
  MODULE_NOT_FOUND: 'ماژول درخواستی در این سامانه ثبت نشده است.',
  MODULE_DISABLED: 'ماژول درخواستی غیرفعال است.',
  MODULE_FORBIDDEN: 'ماژول درخواستی برای این سازمان فعال نشده است.',
  FEATURE_NOT_FOUND: 'قابلیت درخواستی در این ماژول تعریف نشده است.',
  FEATURE_DISABLED: 'این قابلیت در سطح سامانه غیرفعال است.',
  FEATURE_NOT_GRANTED: 'این قابلیت برای سازمان شما فعال نشده است.',
  ENTITLEMENT_NOT_DECLARED: 'این مسیر دسترسی تعریف نشده است و درخواست بسته رد شد.',
};

/**
 * The sentence for a refusal code, falling back to the RAW code.
 *
 * The fallback is deliberate and matches `healthErrorLabel`: an unrecognised short code is more
 * useful to an operator than a generic apology, and it is the signal that the server's vocabulary
 * moved ahead of the console's — which is a deploy, not a bug to hide.
 */
export function entitlementFailureLabel(code: string | null | undefined): string {
  if (!code) return '';
  return ENTITLEMENT_FAILURE_LABELS[code as EntitlementFailureCode] ?? code;
}

/**
 * Registry-state line for one module row.
 *
 * SEVEN DISTINCT STATES rather than a single on/off badge, because collapsing them would lie to the
 * operator: "admitted but nothing has registered", "off because an administrator disabled it", "no
 * credential issued yet", "registered but never confirmed healthy", "incompatible", "gone quiet" and
 * "serving" are seven different situations with seven different next actions.
 */
export function moduleStatusLabel(module: ModuleRegistration): string {
  if (!module.enabled) return 'غیرفعال';
  if (!module.hasCredential) return 'کلید دسترسی صادر نشده';
  if (module.instances.length === 0) return 'در انتظار ثبت نمونه';
  if (module.derivedLifecycle === 'INCOMPATIBLE') return 'ناسازگار با پلتفرم';
  if (module.aggregateHealth === 'UNAVAILABLE') return 'در دسترس نیست';
  if (module.aggregateHealth === 'DEGRADED') return 'فعال — با اختلال';
  if (module.aggregateHealth === 'UNKNOWN') return 'فعال — بررسی نشده';

  return 'فعال و سالم';
}

/** Credential status line. Presence and rotation time only; there is no value to show. */
export function credentialStatusLabel(
  module: Pick<ModuleRegistration, 'hasCredential' | 'credentialUpdatedAt' | 'credentialExpiresAt'>
): string {
  if (!module.hasCredential) return 'صادر نشده';

  const rotated = formatModuleTime(module.credentialUpdatedAt);
  const expires = formatModuleTime(module.credentialExpiresAt);

  if (expires) return `صادر شده — انقضا ${expires}`;
  return rotated ? `صادر شده — آخرین تغییر ${rotated}` : 'صادر شده';
}

/**
 * Tenant-scope line, naming the count rather than listing ids in a table cell.
 *
 * `RESTRICTED_MEMBERS` deliberately reports NO count: its members live in Core's
 * `ModuleRegistrationTenant` table, which this read (`ModuleRegistration`) does not carry, and
 * printing `tenantIds.length` for it would say "0 مستأجر مشخص" about HR's 162 members. The count an
 * operator needs is on the feature panel, which reads the authoritative effective-state page; this
 * line only says WHICH scope the module uses.
 */
export function tenantScopeLabel(
  module: Pick<ModuleRegistration, 'tenantScope' | 'tenantIds'>
): string {
  if (module.tenantScope === 'ALL') return 'همه مستأجرها';
  if (module.tenantScope === 'RESTRICTED_MEMBERS') return 'مستأجرهای عضو (فهرست جدا)';

  return `${module.tenantIds.length} مستأجر مشخص`;
}

/**
 * Persian absolute date/time, matching `formatIntegrationTime` (49L) and `formatAITime` (49J-0).
 *
 * Absolute rather than relative: no new date library, and the value stays stable between renders.
 */
export function formatModuleTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/** True when the string is a usable logical module id. Mirrors the DTO and the SQL CHECK. */
export function isValidModuleId(value: string): boolean {
  return value.length >= 2 && value.length <= MAX_MODULE_ID_LENGTH && MODULE_ID_PATTERN.test(value);
}

/** True when the string is a usable feature id. Mirrors the feature DTO and the SQL CHECK. */
export function isValidFeatureId(value: string): boolean {
  return (
    value.length >= 2 && value.length <= MAX_FEATURE_ID_LENGTH && FEATURE_ID_PATTERN.test(value)
  );
}

/**
 * Phase 54-C (§43.8): the FEATURE-ENTITLEMENT presentation helpers.
 *
 * WHAT CHANGED IN THE CLOSURE FIX, AND WHY IT HAD TO
 * -------------------------------------------------
 * This block used to DERIVE the per-tenant effective state in the browser (`featureEffectiveState`,
 * over `moduleEnabled` + `tenantScope` + `tenantIds` + `featureEnabled` + `granted`). That was a
 * second implementation of a decision the platform already makes, and it was WRONG for the third
 * membership scope: `RESTRICTED_MEMBERS` keeps its membership in Core's `ModuleRegistrationTenant`
 * child table, which the browser cannot see, so an entitled tenancy — the 162 members D16 seeded —
 * rendered as `BLOCKED_BY_MODULE`.
 *
 * The fix is not a third scope in the derivation; it is the removal of the derivation. The server
 * answers per tenant (`GET admin/modules/:moduleId/features/:featureId/effective-state`, projected by
 * `effectiveStateOf` from its OWN `EntitlementPort` decision), and this client RENDERS that answer.
 * The vocabulary below is the console's half of §43.8's four states, with a symbol and a Persian label
 * as well as a colour class, so §30's "never colour alone" holds for it too.
 */

/** The four states §43.8 asks the console to show for a tenant. */
export type ModuleFeatureEffectiveState =
  'ENTITLED' | 'BLOCKED_BY_MODULE' | 'BLOCKED_BY_FEATURE' | 'NOT_GRANTED';

export const FEATURE_EFFECTIVE_STATE_PRESENTATION: Record<
  ModuleFeatureEffectiveState,
  { symbol: string; label: string; className: string }
> = {
  ENTITLED: { symbol: '✅', label: 'مجاز', className: 'text-emerald-600 dark:text-emerald-400' },
  BLOCKED_BY_MODULE: {
    symbol: '⛔',
    label: 'مسدود توسط ماژول',
    className: 'text-destructive',
  },
  BLOCKED_BY_FEATURE: {
    symbol: '🚫',
    label: 'مسدود توسط قابلیت',
    className: 'text-amber-600 dark:text-amber-400',
  },
  NOT_GRANTED: { symbol: '∅', label: 'دسترسی داده نشده', className: 'text-muted-foreground' },
};

/**
 * One tenant of a feature's configured surface, exactly as the server answers it.
 *
 * `effective` is the platform's own §43.8 state and `reasonCode` the §43.2 code behind it. NOTHING on
 * the client is allowed to recompute either: the fields exist so the console can PRINT them.
 */
export interface ModuleFeatureTenantState {
  tenantId: string;
  /** Presence of a grant row. Distinct from `effective === 'ENTITLED'`, and shown as such. */
  granted: boolean;
  grantedAt: string | null;
  effective: ModuleFeatureEffectiveState;
  reasonCode: 'ALLOWED' | EntitlementFailureCode;
}

/**
 * The effective-state page for one feature (Phase 54-C closure fix).
 *
 * CONFIGURED vs EFFECTIVE is the distinction the console must not blur: `moduleEnabled` and
 * `featureEnabled` are what an operator SET, while `rows[].effective` is what the platform will
 * DECIDE. Turning HR off does not erase Leave's own offer, and re-enabling HR restores the previous
 * answer instead of appearing to have lost it. `tenantCount` is the module's enumeration size — the
 * D16 membership count for `RESTRICTED_MEMBERS`, the legacy array length for `RESTRICTED` — and
 * `null` for `ALL`, which enumerates nobody and therefore cannot be counted.
 */
export interface ModuleFeatureStatePage {
  moduleId: string;
  featureId: string;
  moduleEnabled: boolean;
  featureEnabled: boolean;
  tenantScope: ModuleTenantScope;
  tenantCount: number | null;
  rows: ModuleFeatureTenantState[];
  nextCursor: string | null;
}

/**
 * `GET admin/modules/:moduleId/features/:featureId/effective-state` — the authorized read.
 *
 * Same bounded, cursor-continued shape as `listModuleFeatureTenants`; the cursor arrives in the same
 * `X-Next-Cursor` header, so a multi-page tenant list is never silently truncated. This is the ONLY
 * source of effective state in the console.
 */
export async function fetchModuleFeatureStates(
  moduleId: string,
  featureId: string,
  query: { limit?: number; cursor?: string } = {}
): Promise<ModuleFeatureStatePage> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.cursor) search.set('cursor', query.cursor);

  const suffix = search.toString() ? `?${search.toString()}` : '';

  return coreGet<ModuleFeatureStatePage>(
    `/admin/modules/${encodeURIComponent(moduleId)}/features/${encodeURIComponent(
      featureId
    )}/effective-state${suffix}`
  );
}

/**
 * The tenant ids of a grant form, read as a list a human typed.
 *
 * Commas, Persian commas, semicolons and whitespace all separate — an operator pasting a column out
 * of a spreadsheet should not have to guess the one separator this form accepts — and duplicates
 * collapse, because the route's body is a SET of grants and a repeated id in one call would ask for
 * the same row twice. Empty entries are dropped rather than sent as `""`.
 */
export function parseTenantIdList(value: string): string[] {
  const parts = value
    .split(/[\s,،;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return [...new Set(parts)];
}
