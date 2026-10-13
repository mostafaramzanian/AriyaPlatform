import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AIExecutionError, AI_ERROR_CODES } from './ai-errors';
import {
  AICompletionOptions,
  AIEmbeddingExecutionOptions,
  AIGenerationOptions,
  ChatMessage,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_EMBEDDING_MODEL,
  IAIProvider,
} from './i-ai-provider';

/**
 * Phase 49J (Gate B): OpenAI embeddings.
 * Phase AI-ARCH-HARDENING: the adapter now receives the EFFECTIVE configuration of
 * one execution as an explicit parameter (`model`, `baseUrl`, `credential`) instead
 * of every call reading the process environment. That is what makes an
 * `AIProviderConfig` row's `modelName`/`baseUrl` real at runtime and what makes two
 * concurrent executions with different credentials safe — no `process.env` is ever
 * written, so no execution can observe another's key (§6/§13).
 *
 * Only `generateEmbedding` is implemented here. Text and chat completion remain the
 * explicit Phase-A refusal, so nothing silently half-works.
 *
 * Transport is the global `fetch` (Node 20 — the API image is `node:20-alpine`), matching
 * `HealthService`; no HTTP client dependency is added. The one deliberate difference is
 * `AbortSignal.timeout`, whose timer is unref'd, so a pending embedding request cannot hold
 * the event loop open the way a bare `setTimeout` + `AbortController` pair can.
 *
 * Two invariants this class exists to hold:
 *  - the returned vector is ALWAYS the configured width, or the call throws. A wrong-width
 *    vector is unstorable and would poison every later similarity search, so it is never
 *    handed to the caller to deal with;
 *  - neither the API key nor the caller's text ever reaches a log line or an exception
 *    message. Embedding input is arbitrary business content, and log sinks are not a place
 *    to copy it to.
 */

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Bounds on the upstream call. Clamped, so a bad env cannot mean "wait forever". */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;
export const MIN_EMBEDDING_TIMEOUT_MS = 1_000;
export const MAX_EMBEDDING_TIMEOUT_MS = 120_000;

/**
 * Crude upper guard, NOT a tokenizer. `text-embedding-3-small` accepts 8192 tokens; this
 * rejects obviously oversized input locally instead of paying a round-trip for a 400.
 * Persian text costs more tokens per character than English, so the real limit is usually
 * reached first — a 400 from upstream is still mapped, it is just not the common case.
 */
export const MAX_EMBEDDING_INPUT_CHARS = 32_000;

/**
 * The API accepts more inputs per request, but one request's payload and response are held
 * in memory in full. Callers chunk; this keeps a single call bounded.
 */
export const MAX_EMBEDDING_BATCH = 128;

/** How much of an upstream error body is worth logging. */
const MAX_LOGGED_ERROR_CHARS = 300;

/** Only the fields actually read. Everything is optional: this is untrusted input. */
interface OpenAIEmbeddingItem {
  index?: number;
  embedding?: unknown;
}

interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingItem[];
  model?: string;
}

@Injectable()
export class OpenAIProvider implements IAIProvider {
  private logger = new Logger(OpenAIProvider.name);
  private readonly baseUrl: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimension: number;
  private readonly timeoutMs: number;

  constructor() {
    this.baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    this.embeddingModel = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
    this.embeddingDimension = this.resolveDimension();
    this.timeoutMs = this.resolveTimeout();

    if (!process.env.OPENAI_API_KEY) {
      // Warn, never throw. AIModule is imported by both AppModule and CoreAppModule, so
      // failing construction would take the whole API down on any deployment that never
      // asks for an embedding. Same warn-don't-fail-startup rule as MinioProvider; the
      // call itself is what refuses.
      this.logger.warn('OPENAI_API_KEY is not set - generateEmbedding will fail until it is');
    }

    this.logger.log(
      `OpenAIProvider initialized (embeddings: ${this.embeddingModel} @ ` +
        `${this.embeddingDimension}d; text/chat remain Phase B stubs)`
    );
  }

  /**
   * The vector-space contract, readable by whatever owns the store. A `vector(n)` column and
   * this number must agree; exposing it means that can be asserted, not assumed.
   */
  getEmbeddingContract(): { model: string; dimension: number } {
    return { model: this.embeddingModel, dimension: this.embeddingDimension };
  }

  async generateText(_prompt: string, _options?: AIGenerationOptions): Promise<string> {
    // Declared (and read) so the public surface matches TextGenerationProvider
    // exactly; the Phase-A refusal is unconditional.
    void _prompt;
    void _options;
    throw new Error('OpenAIProvider not implemented in Phase A');
  }

  async generateEmbedding(
    text: string,
    options?: AIEmbeddingExecutionOptions
  ): Promise<number[]> {
    const [vector] = await this.embed([this.assertInput(text, 'text')], options);
    return vector;
  }

  /**
   * Batch form. One HTTP round-trip for many inputs, which is the difference between a usable
   * and an unusable bulk index. Deliberately not on the `EmbeddingProvider` port: the port
   * pins the single-text call the platform actually uses, and no production caller batches
   * today (the batch entry point survives only for the calls that predate the port split).
   */
  async generateEmbeddingBatch(
    texts: string[],
    options?: AIEmbeddingExecutionOptions
  ): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new BadRequestException('Embedding input must be a non-empty array of strings');
    }

    if (texts.length > MAX_EMBEDDING_BATCH) {
      throw new BadRequestException(
        `Embedding batch of ${texts.length} exceeds ${MAX_EMBEDDING_BATCH} items - chunk it`
      );
    }

    return this.embed(texts.map((text, i) => this.assertInput(text, `texts[${i}]`)), options);
  }

  async generateCompletion(_messages: ChatMessage[], _options?: AICompletionOptions): Promise<string> {
    // Declared (and read) so the public surface matches ChatCompletionProvider
    // exactly; the Phase-A refusal is unconditional.
    void _messages;
    void _options;
    throw new Error('OpenAIProvider not implemented in Phase A');
  }

  /**
   * Validates one input. The value is returned UNCHANGED — deliberately not trimmed: altering
   * text before embedding it would mean the stored vector describes something the caller never
   * asked about. Whitespace-only is rejected because the API refuses empty input anyway, and
   * an all-whitespace vector is meaningless.
   */
  private assertInput(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(`Embedding ${field} is required`);
    }

    if (value.length > MAX_EMBEDDING_INPUT_CHARS) {
      throw new BadRequestException(
        `Embedding ${field} exceeds ${MAX_EMBEDDING_INPUT_CHARS} characters`
      );
    }

    return value;
  }

  private async embed(
    inputs: string[],
    options?: AIEmbeddingExecutionOptions
  ): Promise<number[][]> {
    const effective = this.effectiveConfiguration(options);

    if (!effective.credential) {
      // Reached only when NEITHER an execution credential NOR the env bootstrap key
      // exists: the resolver hands a stored credential over explicitly, and the env
      // path is what `OPENAI_API_KEY` is for. No key is read from anywhere else.
      throw new AIExecutionError(
        AI_ERROR_CODES.CONFIGURATION_ERROR,
        'OpenAI API key is not configured'
      );
    }

    const body: Record<string, unknown> = {
      model: effective.model,
      input: inputs,
      // Explicit: float is already the default, but `base64` would silently turn the parse
      // below into garbage if the account default ever differed.
      encoding_format: 'float',
    };

    // `dimensions` exists only on the text-embedding-3 family; ada-002 answers 400 for it.
    // When it cannot be negotiated the width is still ENFORCED on the response, so the
    // contract holds either way - it is simply checked rather than requested.
    if (this.supportsDimensions(effective.model)) {
      body.dimensions = this.embeddingDimension;
    }

    let response: Response;
    try {
      response = await fetch(`${effective.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${effective.credential}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Note what is absent: the body (caller content) and the headers (the key).
      const name = err instanceof Error ? err.name : 'Error';
      this.logger.error(
        { name, model: effective.model, inputs: inputs.length },
        'Embedding request failed before a response was received'
      );

      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AIExecutionError(
          AI_ERROR_CODES.UPSTREAM_TIMEOUT,
          `Embedding request timed out after ${this.timeoutMs}ms`
        );
      }

      throw new AIExecutionError(AI_ERROR_CODES.UPSTREAM_UNAVAILABLE, 'Embedding request failed');
    }

    if (!response.ok) {
      this.logger.error(
        {
          status: response.status,
          model: effective.model,
          detail: await this.readErrorDetail(response),
        },
        'Embedding request rejected by the provider'
      );

      // The upstream body is logged, never thrown: it is operator diagnostics, not something
      // to hand back through an HTTP response.
      throw new AIExecutionError(
        AI_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        `Embedding request failed with status ${response.status}`
      );
    }

    let payload: OpenAIEmbeddingResponse;
    try {
      payload = (await response.json()) as OpenAIEmbeddingResponse;
    } catch {
      throw new AIExecutionError(
        AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        'Embedding response was not valid JSON'
      );
    }

    return this.readVectors(payload, inputs.length);
  }

  /**
   * The EFFECTIVE configuration of ONE call (§5/§13).
   *
   * Explicit options win; an absent field falls back to the environment bootstrap
   * resolved at construction. The credential is read from the environment AT CALL TIME
   * only when no option supplies one — preserving the 49J-A behaviour where a key
   * supplied after boot (or rotated) takes effect without a restart, while a
   * DB-resolved credential travels as a parameter and touches nothing global.
   */
  private effectiveConfiguration(options?: AIEmbeddingExecutionOptions): {
    model: string;
    baseUrl: string;
    credential: string | undefined;
  } {
    const model =
      options?.model && options.model.trim().length > 0 ? options.model : this.embeddingModel;

    return {
      model,
      baseUrl: options?.baseUrl ? options.baseUrl.replace(/\/+$/, '') : this.baseUrl,
      credential: options?.credential ?? process.env.OPENAI_API_KEY,
    };
  }

  /**
   * Maps `data[]` back onto the request order and enforces the width.
   *
   * The response carries an explicit `index` per item and is not guaranteed to arrive in
   * request order, so vectors are placed BY INDEX. Trusting arrival order is the classic way
   * to attach the right vector to the wrong row.
   */
  private readVectors(payload: OpenAIEmbeddingResponse, expectedCount: number): number[][] {
    const items = payload?.data;

    if (!Array.isArray(items) || items.length !== expectedCount) {
      throw new AIExecutionError(
        AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        `Embedding response returned ${Array.isArray(items) ? items.length : 0} vectors, ` +
          `expected ${expectedCount}`
      );
    }

    const slots: Array<number[] | undefined> = new Array(expectedCount);

    items.forEach((item, position) => {
      const index =
        typeof item?.index === 'number' && Number.isInteger(item.index) && item.index >= 0
          ? item.index
          : position;

      if (index >= expectedCount) {
        throw new AIExecutionError(
          AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
          `Embedding response referenced input ${index}, only ${expectedCount} were sent`
        );
      }

      slots[index] = this.assertVector(item?.embedding, index);
    });

    // A duplicated index would leave another slot empty; catching that here is what stops one
    // input's vector standing in for another's.
    const vectors: number[][] = [];
    for (let i = 0; i < expectedCount; i += 1) {
      const vector = slots[i];
      if (!vector) {
        throw new AIExecutionError(
          AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
          `Embedding response is missing a vector for input ${i}`
        );
      }
      vectors.push(vector);
    }

    return vectors;
  }

  private assertVector(embedding: unknown, index: number): number[] {
    if (!Array.isArray(embedding)) {
      throw new AIExecutionError(
        AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        `Embedding response item ${index} did not contain a vector`
      );
    }

    if (embedding.length !== this.embeddingDimension) {
      // Hard failure by design. A vector of the wrong width cannot sit beside the others in a
      // fixed-width column, and accepting it would corrupt every later search.
      throw new AIExecutionError(
        AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        `Embedding dimension mismatch: expected ${this.embeddingDimension}, ` +
          `received ${embedding.length}`
      );
    }

    if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      // NaN/Infinity propagate through cosine distance and quietly break ranking.
      throw new AIExecutionError(
        AI_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        `Embedding response item ${index} contained a non-finite value`
      );
    }

    return embedding as number[];
  }

  /**
   * Whether the EFFECTIVE model accepts the `dimensions` request parameter. Takes the
   * model as an argument because an execution may run a DB-configured model while the
   * bootstrap model differs — the negotiation must follow the model actually sent.
   */
  private supportsDimensions(model: string): boolean {
    return /^text-embedding-3(?:[-.]|$)/.test(model);
  }

  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > MAX_LOGGED_ERROR_CHARS
        ? `${text.slice(0, MAX_LOGGED_ERROR_CHARS)}...`
        : text;
    } catch {
      return '<unreadable body>';
    }
  }

  private resolveDimension(): number {
    const raw = process.env.EMBEDDING_DIMENSION;
    if (raw === undefined || raw.trim().length === 0) {
      return DEFAULT_EMBEDDING_DIMENSION;
    }

    // `Number` rather than `parseInt`: parseInt('1536abc') is 1536, which would silently accept
    // a typo'd dimension - the one value that must never be guessed.
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      this.logger.warn(
        `EMBEDDING_DIMENSION="${raw}" is not a positive integer - using ` +
          `${DEFAULT_EMBEDDING_DIMENSION}`
      );
      return DEFAULT_EMBEDDING_DIMENSION;
    }

    return parsed;
  }

  private resolveTimeout(): number {
    const parsed = Number(process.env.EMBEDDING_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_EMBEDDING_TIMEOUT_MS;
    }

    return Math.min(
      Math.max(Math.trunc(parsed), MIN_EMBEDDING_TIMEOUT_MS),
      MAX_EMBEDDING_TIMEOUT_MS
    );
  }
}
