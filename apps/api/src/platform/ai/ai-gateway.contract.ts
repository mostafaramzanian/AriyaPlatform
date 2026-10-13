/**
 * Phase AI-ARCH-HARDENING (§10/§11/§30): the AI GATEWAY contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Global Search was the first consumer that had to resolve, configure and invoke an
 * AI provider — and it did so by reaching into `AIConfigService`, which meant a
 * business capability one `@Inject` away from credential persistence, provider
 * instances and `process.env` semantics. This contract is the seam that ends that:
 * a consumer states WHAT it wants (an embedding for a text) and a context for
 * traceability, and learns nothing about which provider runs, where the credential
 * is stored, what the endpoint is, or how resolution works.
 *
 * The dependency direction this file fixes:
 *
 *   Reporting / Search / future consumers
 *        ↓  (this contract only)
 *   AI Gateway (`AIGateway`, platform-owned)
 *        ↓
 *   AI runtime resolution + capability adapters
 *        ↓
 *   provider implementations
 *
 * WHAT IT DELIBERATELY DOES NOT EXPOSE
 * ------------------------------------
 *  - no credential, endpoint, or provider-instance accessor of any kind;
 *  - no text generation / chat / tool-calling methods: those capabilities have no
 *    implementation in this repository, and a contract method that throws is worse
 *    than an absent method (§15/§32). The result/request SHAPES below are where a
 *    future text capability plugs in, not a parser built ahead of a consumer;
 *  - no provider-specific option bag: execution configuration is operator-owned
 *    (admin UI), not caller-owned.
 */

/** The DI token. Consumers inject THIS, never the concrete gateway class. */
export const AI_GATEWAY = 'AIGateway';

/**
 * Traceability metadata for ONE execution (§11/§35). Provider CONFIGURATION scope is
 * platform-global; this is BUSINESS execution scope — who/where the call came from —
 * and it steers logging/attribution only. It is never forwarded to a provider
 * adapter, so no adapter learns actor or tenant semantics (§29), and supplying a
 * tenant here never creates a per-tenant credential.
 */
export interface AIExecutionContext {
  correlationId?: string;
  tenantId?: string | null;
  actorId?: string | null;
  /** Producing capability, e.g. `search`. Logged; never sent upstream. */
  moduleId?: string;
}

/**
 * Which layer produced the effective configuration. `ENVIRONMENT` is the documented
 * environment-bootstrap path (no configured row exists); `DATABASE` means an enabled
 * default `AIProviderConfig` row was applied. This is config PROVENANCE for
 * diagnostics and tests — not credential state, not deployment topology.
 */
export type AIGatewayConfigurationSource = 'DATABASE' | 'ENVIRONMENT';

/** Safe execution metadata. No credential, no prompt, no provider payload. */
export interface AIExecutionMetadata {
  /** Wall-clock duration of the provider call, in milliseconds. */
  latencyMs: number;
  configurationSource: AIGatewayConfigurationSource;
  /** Echoed when the caller supplied one, so a later report can trace the call. */
  correlationId?: string;
}

/** One embedding, with the provider/model that actually produced it. */
export interface AIEmbeddingExecutionResult {
  capability: 'EMBEDDING';
  /** The `AIProviderKey` value, e.g. `OPENAI`. Identity, never configuration. */
  provider: string;
  /** The EFFECTIVE model — the DB row's model when one applied (§13). */
  model: string;
  output: number[];
  metadata: AIExecutionMetadata;
}

/**
 * What a consumer may ask of the AI platform today. ONE method, because embedding is
 * the one capability with a real implementation; the shape of the result is already
 * structured so a future `generateText()` slots in without rewriting consumers.
 *
 * Errors are classified (`AIExecutionError` codes, §33): unsupported capability,
 * refused endpoint, undecryptable stored credential, upstream timeout/unavailability,
 * invalid provider response. A caller that wants to degrade — as Search does — catches;
 * a caller that wants to fail loud passes it through. Neither ever sees the credential.
 */
export interface AIGatewayContract {
  embed(input: string, context?: AIExecutionContext): Promise<AIEmbeddingExecutionResult>;
}
