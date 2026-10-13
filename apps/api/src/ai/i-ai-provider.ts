/**
 * Phase 49J (Gate B): the embedding contract.
 *
 * Embeddings are only comparable inside ONE vector space. A cosine distance between a
 * 1536-wide vector and a 3072-wide one is not a worse answer, it is not an answer at all,
 * and a store that mixes widths cannot be queried at all. The dimension is therefore part
 * of the contract rather than a per-call option: it is fixed here, requested from the
 * provider, and re-asserted on every response.
 *
 * 1536 is chosen because it is the native width of `text-embedding-3-small` AND a width the
 * larger `text-embedding-3-large` can be truncated to via the `dimensions` request
 * parameter (Matryoshka representation learning). Upgrading the model later therefore does
 * not invalidate vectors already written, which a native-width contract would.
 *
 * Anything persisting these vectors — a `vector(n)` pgvector column in particular; the
 * Postgres service already runs `pgvector/pgvector:pg16` — must declare the SAME width.
 * Override with `EMBEDDING_DIMENSION`, and treat changing it as a re-index, not a config
 * tweak: existing rows do not migrate.
 */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSION = 1536;

/**
 * Phase AI-ARCH-HARDENING (§5/§13): the EFFECTIVE configuration of one execution.
 *
 * A provider adapter is a singleton with an environment-resolved bootstrap, but a
 * configured `AIProviderConfig` row must be able to override `modelName` and
 * `baseUrl` FOR ONE CALL. These options are that override, passed explicitly by
 * the runtime resolution layer — never through `process.env` (§6).
 *
 * `credential` is the decrypted key for THIS call. It exists only inside the
 * execution boundary: it must never be logged, audited, returned by a route, or
 * placed in a URL. When a field is absent the adapter falls back to its own
 * environment bootstrap, which is the documented "no configured row" path (§14).
 */
export interface AIEmbeddingExecutionOptions {
  /** Provider-side model id. Absent → the adapter's environment bootstrap model. */
  model?: string;
  /** Endpoint override. Absent → the adapter's environment bootstrap base URL. */
  baseUrl?: string;
  /** Per-call credential. Absent → the adapter's environment bootstrap credential. */
  credential?: string;
}

/**
 * Phase AI-ARCH-HARDENING (§7): the capability contracts.
 *
 * ONE INTERFACE PER CAPABILITY, composed into `IAIProvider` for the adapters that
 * exist today. Capability SUPPORT is still declared by `AIProviderRegistry`'s
 * matrix and never inferred from these methods (§15/§16): every adapter satisfies
 * the whole composite structurally, while three of them remain stubs.
 */
export interface EmbeddingProvider {
  /**
   * Returns exactly `DEFAULT_EMBEDDING_DIMENSION` floats (or the `EMBEDDING_DIMENSION`
   * override). Implementations must FAIL rather than return a differently-sized vector.
   */
  generateEmbedding(text: string, options?: AIEmbeddingExecutionOptions): Promise<number[]>;
  /**
   * The vector-space contract, readable by whatever owns the store. A `vector(n)`
   * column and this number must agree; exposing it means that can be asserted
   * rather than assumed.
   */
  getEmbeddingContract(): { model: string; dimension: number };
}

/** Phase AI-ARCH-HARDENING (§7). No adapter implements this as WORKING today. */
export interface TextGenerationProvider {
  generateText(prompt: string, options?: AIGenerationOptions): Promise<string>;
}

/** Phase AI-ARCH-HARDENING (§7). No adapter implements this as WORKING today. */
export interface ChatCompletionProvider {
  generateCompletion(messages: ChatMessage[], options?: AICompletionOptions): Promise<string>;
}

/** The composite every adapter in `src/ai` satisfies today. */
export interface IAIProvider
  extends EmbeddingProvider,
    TextGenerationProvider,
    ChatCompletionProvider {}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIGenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
}

export interface AICompletionOptions extends AIGenerationOptions {
  model?: string;
  systemPrompt?: string;
}
