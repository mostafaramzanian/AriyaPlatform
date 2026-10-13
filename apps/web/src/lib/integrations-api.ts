import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 49L: automation & integration client.
 *
 * Mirrors `IntegrationController` exactly (`GET /admin/integrations`,
 * `GET /admin/integrations/executions`, `GET /admin/integrations/:id`,
 * `POST /admin/integrations`, `PATCH /admin/integrations/:id`,
 * `DELETE /admin/integrations/:id`, `POST /admin/integrations/:id/secret`,
 * `POST /admin/integrations/:id/test`).
 *
 * FOUR THINGS THIS MODULE DELIBERATELY CANNOT DO:
 *
 * 1. READ A SECRET BACK. `Integration` has no `secret` field, because the server's single
 *    projection has no branch that emits the ciphertext, the IV or the tag. The only
 *    secret facts that exist client-side are `hasSecret` and `secretUpdatedAt`, so a
 *    component cannot render a value it was never given. `rotateIntegrationSecret` is the
 *    one exception and it returns a NEWLY GENERATED secret, once — the operator has to
 *    paste it into the engine, and no later request can retrieve it.
 *
 * 2. RETARGET A ROW. `UpdateIntegrationInput` omits `integration` for the same reason the
 *    DTO omits it: moving a row would move a secret negotiated with one engine onto
 *    another. Pointing at a different engine is a create plus a delete.
 *
 * 3. CHOOSE A DISPATCH DESTINATION. There is no `url` parameter on any function here.
 *    The endpoint is resolved server-side from `IntegrationConfig`, so this client cannot
 *    be used to make Aria issue an arbitrary outbound request.
 *
 * 4. CALL THE CALLBACK. `POST /integrations/:integration/callback` is an INBOUND route for
 *    the external engine, authenticated by HMAC. It is deliberately absent from this
 *    file: the browser has no shared secret and no reason to acknowledge a delivery.
 *
 * The integration catalogue is READ FROM THE SERVER (`integrations` on the list response)
 * and is not duplicated here — the same rule `ai-api.ts` follows for the AI capability
 * matrix. Every DTO runs under `whitelist` + `forbidNonWhitelisted`, so an extra property
 * is a 400 rather than a silently dropped field.
 */

/** Matches the `IntegrationKey` enum. One member, one adapter. */
export type IntegrationKey = 'N8N';

/** Matches the `AutomationStatus` enum. */
export type AutomationStatus =
  | 'PENDING'
  | 'SENT'
  | 'ACCEPTED'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED';

/** Outcome of the last connection test, as stored on the config row. */
export type IntegrationTestStatus = 'SUCCESS' | 'FAILURE';

/**
 * Backend bounds, mirroring the DTO and the SQL CHECKs. Restated here so the form can
 * refuse an out-of-range value locally instead of discovering it through a 422.
 */
export const MIN_WEBHOOK_SECRET = 32;
export const MAX_WEBHOOK_SECRET = 512;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60000;
export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 5;

/**
 * One configured integration, exactly as the server projects it.
 *
 * Timestamps are ISO strings: they are `Date` objects in the service and JSON-serialised
 * on the way out.
 */
export interface Integration {
  id: string;
  integration: IntegrationKey;
  baseUrl: string;
  webhookPath: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  /** Whether a secret is stored. NOT the secret, nor its length. */
  hasSecret: boolean;
  secretUpdatedAt: string | null;
  lastTestStatus: IntegrationTestStatus | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A registry entry. The label and the suggested path are the server's, never a local copy. */
export interface IntegrationDescriptor {
  key: IntegrationKey;
  displayName: string;
  defaultWebhookPath: string;
}

export interface IntegrationListResult {
  configs: Integration[];
  integrations: IntegrationDescriptor[];
}

/**
 * One delivery. Note the absent fields: no `tenantId` (it is already the filter), no
 * `actorId` (that belongs in the audit trail, behind `admin.audit.read`) and no payload.
 */
export interface AutomationExecution {
  id: string;
  integration: IntegrationKey;
  eventId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  status: AutomationStatus;
  /** Opaque engine reference, display-only. */
  externalExecutionId: string | null;
  attemptCount: number;
  /** Short internal code, never an upstream message. */
  errorCode: string | null;
  correlationId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AutomationExecutionPage {
  items: AutomationExecution[];
  nextCursor: string | null;
}

export interface IntegrationTestResult {
  status: IntegrationTestStatus;
  /** Operator-facing Persian message. Never an upstream body or a secret. */
  message: string;
}

export interface CreateIntegrationInput {
  integration: IntegrationKey;
  baseUrl: string;
  webhookPath: string;
  /** Optional at creation; the row can be created disabled and given a secret after. */
  secret?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * Update input. `integration` is absent on purpose — see the module note.
 *
 * An OMITTED `secret` leaves the stored one untouched, which is what makes the masked
 * read safe to round-trip: the form can be submitted whole without ever having held one.
 */
export interface UpdateIntegrationInput {
  baseUrl?: string;
  webhookPath?: string;
  secret?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
}

export async function listIntegrations(): Promise<IntegrationListResult> {
  return coreGet<IntegrationListResult>('/admin/integrations');
}

export async function fetchIntegration(id: string): Promise<Integration> {
  return coreGet<Integration>(`/admin/integrations/${id}`);
}

/**
 * Delivery history, newest first. Server-side the rows are already filtered to the
 * caller's tenant; no tenant parameter exists here because none exists in the contract.
 */
export async function listAutomationExecutions(
  params: { limit?: number; cursor?: string } = {},
): Promise<AutomationExecutionPage> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);

  const suffix = query.toString();
  return coreGet<AutomationExecutionPage>(
    `/admin/integrations/executions${suffix ? `?${suffix}` : ''}`,
  );
}

export async function createIntegration(input: CreateIntegrationInput): Promise<Integration> {
  // Fields are listed EXPLICITLY rather than spread, because the DTO runs under
  // `forbidNonWhitelisted`: a stray key is a 400, not a dropped property.
  return corePost<Integration>('/admin/integrations', {
    integration: input.integration,
    baseUrl: input.baseUrl,
    webhookPath: input.webhookPath,
    ...(input.secret ? { secret: input.secret } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
  });
}

export async function updateIntegration(
  id: string,
  input: UpdateIntegrationInput,
): Promise<Integration> {
  return corePatch<Integration>(`/admin/integrations/${id}`, {
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.webhookPath !== undefined ? { webhookPath: input.webhookPath } : {}),
    // Only when the operator typed one. An empty field means "leave it alone".
    ...(input.secret ? { secret: input.secret } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
  });
}

export async function deleteIntegration(id: string): Promise<{ id: string; deleted: true }> {
  return coreDelete<{ id: string; deleted: true }>(`/admin/integrations/${id}`);
}

/**
 * Generates a new shared secret server-side and returns it ONCE.
 *
 * The only function in this module that ever holds a secret. The caller must display it
 * for the operator to copy into the engine and must not persist it anywhere — no later
 * request can retrieve it.
 */
export async function rotateIntegrationSecret(id: string): Promise<{ secret: string }> {
  return corePost<{ secret: string }>(`/admin/integrations/${id}/secret`);
}

/**
 * Live probe. Resolves with SUCCESS or FAILURE for both outcomes — a failed probe is not
 * an HTTP error — so the caller renders a message either way rather than a thrown error.
 */
export async function testIntegration(id: string): Promise<IntegrationTestResult> {
  return corePost<IntegrationTestResult>(`/admin/integrations/${id}/test`);
}

/** The registry label for a key, falling back to the raw key. */
export function integrationLabel(
  key: string,
  integrations: IntegrationDescriptor[] = [],
): string {
  return integrations.find((entry) => entry.key === key)?.displayName ?? key;
}

/**
 * Persian status labels for a delivery.
 *
 * Declared as a COMPLETE record rather than a switch with a default, so adding a member to
 * `AutomationStatus` is a type error here instead of silently rendering the raw enum name
 * to an operator.
 */
export const AUTOMATION_STATUS_LABELS: Record<AutomationStatus, string> = {
  PENDING: 'در انتظار ارسال',
  SENT: 'ارسال شد',
  ACCEPTED: 'پذیرفته شد',
  RETRYING: 'در حال تلاش مجدد',
  COMPLETED: 'تکمیل شد',
  FAILED: 'ناموفق',
};

/**
 * Connection-state label for the admin list (§42).
 *
 * FIVE DISTINCT STATES, because collapsing them would lie to the operator: "configured
 * but off" is not "off because it broke", "no secret yet" is not "misconfigured", and
 * "never tested" is not "test failed".
 */
export function integrationStatusLabel(config: Integration): string {
  if (!config.enabled) return 'غیرفعال';
  if (!config.hasSecret) return 'کلید امضا تنظیم نشده';
  if (config.lastTestStatus === 'SUCCESS') return 'متصل است';
  if (config.lastTestStatus === 'FAILURE') return 'اتصال برقرار نشد';
  return 'فعال — آزمایش نشده';
}

/** Secret status line. Presence and rotation time only; there is no value to show. */
export function secretStatusLabel(
  config: Pick<Integration, 'hasSecret' | 'secretUpdatedAt'>,
): string {
  if (!config.hasSecret) return 'ذخیره نشده';

  const rotated = formatIntegrationTime(config.secretUpdatedAt);
  return rotated ? `ذخیره شده — آخرین تغییر ${rotated}` : 'ذخیره شده';
}

/**
 * Persian absolute date/time, matching `formatAITime` (49J-0) and `formatTicketTime`
 * (49G). Absolute rather than relative: no new date library, and the value stays stable
 * between renders.
 */
export function formatIntegrationTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}


