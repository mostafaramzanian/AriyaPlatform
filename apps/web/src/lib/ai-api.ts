import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 49J-0: AI provider configuration client.
 *
 * Mirrors `AIConfigController` exactly (`GET /admin/ai/providers`,
 * `GET /admin/ai/providers/:id`, `POST /admin/ai/providers`,
 * `PATCH /admin/ai/providers/:id`, `DELETE /admin/ai/providers/:id`,
 * `POST /admin/ai/providers/:id/test`).
 *
 * THREE THINGS THIS MODULE DELIBERATELY CANNOT DO:
 *
 * 1. READ A CREDENTIAL BACK. `AIProviderConfig` has no `credential` field, because the
 *    server's single projection has no branch that emits the ciphertext, the IV or the
 *    tag. The only credential facts that exist client-side are `hasCredential` and
 *    `credentialUpdatedAt`, so a component cannot render a key it was never given.
 *
 * 2. RETARGET A ROW. `UpdateAIProviderConfigInput` omits `provider` and `capability`
 *    for the same reason the DTO omits them: moving a row would move a credential
 *    encrypted for one vendor onto another. Pointing at a different provider is a
 *    create plus a delete.
 *
 * 3. CHOOSE THE PROBE TEXT. `testAIProviderConnection` sends at most a credential. The
 *    probe string is fixed server-side, so the endpoint is not a pass-through to a paid
 *    provider API.
 *
 * The capability matrix is READ FROM THE SERVER (`providers` on the list response) and
 * is not duplicated here. A local copy is the classic way for a UI to keep offering a
 * capability the backend has withdrawn.
 *
 * Every DTO runs under `whitelist` + `forbidNonWhitelisted`, so an extra property is a
 * 400 rather than a silently dropped field.
 */

/** Matches the `AIProviderKey` enum. Four members, one per implemented provider. */
export type AIProviderKey = 'OPENAI' | 'AZURE_OPENAI' | 'ANTHROPIC' | 'LOCAL';

/** Matches the `AICapability` enum. */
export type AICapability = 'TEXT_GENERATION' | 'EMBEDDING';

/**
 * One configured row, exactly as the server projects it.
 *
 * `credentialUpdatedAt`, `createdAt` and `updatedAt` are ISO strings: they are `Date`
 * objects in the service and JSON-serialised on the way out.
 */
export interface AIProviderConfig {
  id: string;
  provider: AIProviderKey;
  capability: AICapability;
  modelName: string;
  baseUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  /** Whether a credential is stored. NOT the credential, nor its length. */
  hasCredential: boolean;
  credentialUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A registry entry. `capabilities` lists what genuinely WORKS today, not what the
 * provider class happens to declare a method for — three of the four providers are
 * stubs whose methods exist and throw.
 */
export interface AIProviderDescriptor {
  key: AIProviderKey;
  /** Operator-facing Persian label, supplied by the server. */
  displayName: string;
  capabilities: AICapability[];
  /** Why an unsupported capability is unsupported, so a disabled option can explain itself. */
  unsupportedReason: Partial<Record<AICapability, string>>;
}

export interface AIProviderListResult {
  configs: AIProviderConfig[];
  providers: AIProviderDescriptor[];
}

export interface AIConnectionTestResult {
  status: 'SUCCESS' | 'FAILURE';
  /** Operator-facing Persian message. Never carries an upstream body or a key. */
  message: string;
}

export interface CreateAIProviderConfigInput {
  provider: AIProviderKey;
  capability: AICapability;
  modelName: string;
  baseUrl?: string;
  /** Plaintext, encrypted server-side and never returned afterwards. */
  credential?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

/**
 * Update input.
 *
 * An OMITTED `credential` LEAVES THE STORED KEY UNTOUCHED — it does not clear it. That
 * is what makes the masked read safe to round-trip: the form can be submitted whole
 * without ever having seen the key. Removal is the explicit `clearCredential` flag,
 * which the server refuses in the same request as a `credential`.
 */
export interface UpdateAIProviderConfigInput {
  modelName?: string;
  /**
   * `null` CLEARS the override; omitting the field leaves it unchanged.
   *
   * An empty string cannot be used for either: the DTO trims `''` to `undefined` so a
   * blanked form field reads as "absent", which is what makes a whole-form resubmit
   * safe. Clearing therefore has to be stated explicitly.
   */
  baseUrl?: string | null;
  credential?: string;
  clearCredential?: boolean;
  enabled?: boolean;
  isDefault?: boolean;
}

/** Server-side bounds, mirrored so the inputs can advertise them. */
export const MAX_AI_MODEL_NAME = 200;
export const MAX_AI_BASE_URL = 500;
export const MAX_AI_CREDENTIAL = 5000;

const BASE_PATH = '/admin/ai/providers';

/** Path for one row. Encoded rather than interpolated raw. */
function configPath(id: string): string {
  return `${BASE_PATH}/${encodeURIComponent(id)}`;
}

/**
 * The configured rows plus the capability matrix.
 *
 * Defensive normalisation: a missing array becomes an empty one so the view renders an
 * empty state instead of throwing on `.map`.
 */
export async function listAIProviderConfigs(): Promise<AIProviderListResult> {
  const raw = await coreGet<Partial<AIProviderListResult>>(BASE_PATH);

  return {
    configs: Array.isArray(raw?.configs) ? raw.configs : [],
    providers: Array.isArray(raw?.providers) ? raw.providers : [],
  };
}

export function getAIProviderConfig(id: string): Promise<AIProviderConfig> {
  return coreGet<AIProviderConfig>(configPath(id));
}

export function createAIProviderConfig(
  input: CreateAIProviderConfigInput
): Promise<AIProviderConfig> {
  return corePost<AIProviderConfig>(BASE_PATH, input);
}

export function updateAIProviderConfig(
  id: string,
  input: UpdateAIProviderConfigInput
): Promise<AIProviderConfig> {
  return corePatch<AIProviderConfig>(configPath(id), input);
}

export function deleteAIProviderConfig(id: string): Promise<{ id: string; deleted: true }> {
  return coreDelete<{ id: string; deleted: true }>(configPath(id));
}

/**
 * Live probe against the provider.
 *
 * `credential` is optional: with it, a key is verified BEFORE being saved; without it,
 * the stored key is used, which verifies that an existing row still works. A FAILURE
 * arrives as a 200 with `status: 'FAILURE'`, so callers must inspect `status` rather
 * than relying on the promise rejecting.
 */
export function testAIProviderConnection(
  id: string,
  credential?: string
): Promise<AIConnectionTestResult> {
  return corePost<AIConnectionTestResult>(
    `${configPath(id)}/test`,
    credential ? { credential } : {}
  );
}

/* ------------------------------------------------------------------------- */
/* Presentation helpers. Display-only: nothing below is ever sent to the API. */
/* ------------------------------------------------------------------------- */

const CAPABILITY_LABELS: Record<AICapability, string> = {
  EMBEDDING: 'بردارسازی متن (Embedding)',
  TEXT_GENERATION: 'تولید متن',
};

export function aiCapabilityLabel(capability: AICapability): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

/**
 * Provider label from the SERVER-SUPPLIED matrix, falling back to the raw key.
 *
 * There is deliberately no hard-coded label map: the display names live in the registry
 * beside the capability declarations, and a second copy here would drift.
 */
export function aiProviderLabel(provider: string, providers: AIProviderDescriptor[] = []): string {
  return providers.find((entry) => entry.key === provider)?.displayName ?? provider;
}

/** True when the registry declares this provider genuinely capable of this capability. */
export function supportsCapability(
  provider: AIProviderKey,
  capability: AICapability,
  providers: AIProviderDescriptor[]
): boolean {
  return Boolean(
    providers.find((entry) => entry.key === provider)?.capabilities?.includes(capability)
  );
}

/**
 * The server's explanation for an unsupported cell, for surfacing beside a disabled
 * option instead of silently hiding it. Null when the pair IS supported.
 *
 * A provider ABSENT from the matrix counts as unsupported, not as unknown: that is what
 * `supportsCapability` reports for the same input, and the server's
 * `assertCapabilitySupported` refuses it too. Returning null here would leave the UI
 * silent about a pair the save is guaranteed to reject.
 */
export function unsupportedCapabilityReason(
  provider: AIProviderKey,
  capability: AICapability,
  providers: AIProviderDescriptor[]
): string | null {
  const entry = providers.find((descriptor) => descriptor.key === provider);
  if (entry?.capabilities?.includes(capability)) return null;

  return (
    entry?.unsupportedReason?.[capability] ?? 'این قابلیت برای این ارائه‌دهنده پشتیبانی نمی‌شود.'
  );
}

/**
 * Capabilities that at least one provider supports.
 *
 * Drives the capability selector so it can never offer a capability that no provider
 * implements — today that means EMBEDDING only.
 */
export function configurableCapabilities(providers: AIProviderDescriptor[]): AICapability[] {
  const seen = new Set<AICapability>();

  for (const provider of providers) {
    for (const capability of provider.capabilities ?? []) {
      seen.add(capability);
    }
  }

  return Array.from(seen);
}

/**
 * Providers that can serve a given capability, in registry order.
 *
 * Narrows the provider selector once a capability is chosen, so an impossible pair
 * (Claude + embeddings, which the vendor will never offer) cannot be submitted at all.
 */
export function providersForCapability(
  capability: AICapability,
  providers: AIProviderDescriptor[]
): AIProviderDescriptor[] {
  return providers.filter((provider) => provider.capabilities?.includes(capability));
}

/**
 * Persian absolute date/time, matching `formatSurveyTime` (49H) and `formatTicketTime`
 * (49G). Absolute rather than relative: no new date library, and the value stays stable
 * between renders.
 */
export function formatAITime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/**
 * The credential status line.
 *
 * Reports PRESENCE and the rotation timestamp only. There is no length, no prefix and no
 * masked sample, because the client is never given one.
 */
export function credentialStatusLabel(
  config: Pick<AIProviderConfig, 'hasCredential' | 'credentialUpdatedAt'>
): string {
  if (!config.hasCredential) return 'ذخیره نشده';

  const rotated = formatAITime(config.credentialUpdatedAt);
  return rotated ? `ذخیره شده — آخرین تغییر ${rotated}` : 'ذخیره شده';
}
