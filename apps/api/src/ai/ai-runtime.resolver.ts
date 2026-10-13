import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AIExecutionError, AI_ERROR_CODES } from './ai-errors';
import { AIEndpointPolicyError, assertAIEndpointAllowed } from './ai-endpoint.policy';
import { AIProviderRegistry, type AICapabilityValue, type AIProviderKeyValue } from './ai-provider.registry';
import type { AIEmbeddingExecutionOptions, EmbeddingProvider } from './i-ai-provider';

/**
 * Phase AI-ARCH-HARDENING (§9/§13/§14): AI RUNTIME RESOLUTION.
 *
 * This is the seam between CONFIGURATION (rows an administrator saved) and
 * EXECUTION (a provider call carrying the effective model, baseUrl and credential).
 * It exists so `AIConfigService` stops being the everything-service and so no
 * consumer — search today, Reporting tomorrow — ever builds a provider call from a
 * row it read itself.
 *
 * WHAT IT GUARANTEES
 * ------------------
 * 1. THE EFFECTIVE CONFIGURATION IS EXPLICIT. A resolved execution carries the
 *    row's `modelName`, `baseUrl` and decrypted credential as per-call options.
 *    `process.env` is NEVER written (§6) — the credential is a parameter, which is
 *    what makes two concurrent executions with different credentials safe.
 *
 * 2. ENVIRONMENT IS A BOOTSTRAP, NOT A FALLBACK FOR BROKEN CONFIGURATION (§14).
 *    No configured row → the environment path (identical to 49J-A). A row that
 *    exists but is unusable — withdrawn capability, undecryptable credential,
 *    policy-rejected endpoint — is a HARD ERROR. It must never silently swap in the
 *    process-wide key or a different model than the operator chose; that is the
 *    failure mode this class exists to make impossible.
 *
 * 3. RESOLUTION IS NOT MEMOISED (§40). One indexed row read per execution; an
 *    administrator switching the default takes effect on the next call without a
 *    restart. Nothing here holds a credential in instance state.
 */

/** One execution's effective configuration. Lives INSIDE the execution boundary. */
export interface ResolvedAIExecution {
  providerKey: AIProviderKeyValue;
  /** The DI adapter singleton. Guaranteed embedding-capable before it is returned. */
  adapter: EmbeddingProvider;
  /** Effective model: the row's `modelName`, or the adapter's env-bootstrap model. */
  model: string;
  /** Effective endpoint: the row's `baseUrl`, or null when the adapter decides. */
  baseUrl: string | null;
  /** Which layer the configuration came from — metadata, never a credential. */
  configurationSource: 'DATABASE' | 'ENVIRONMENT';
  /**
   * Per-call options for the adapter. PRESENT for stored rows; ABSENT for the
   * environment bootstrap, where the adapter reads its own env configuration.
   */
  executionOptions?: AIEmbeddingExecutionOptions;
}

/**
 * The stored-row columns resolution reads — structural rather than the Prisma
 * model, so the connection-test path and a unit-test fixture both satisfy it
 * without casts. Strings, not enum literals: the Prisma row's enum values are
 * assignable to `string`, and `supports()` validates membership anyway.
 */
type ConfigRow = {
  provider: string;
  capability: string;
  modelName: string;
  baseUrl: string | null;
  credentialCiphertext: string | null;
  credentialIv: string | null;
  credentialAuthTag: string | null;
};

@Injectable()
export class AIRuntimeResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AIProviderRegistry,
    private readonly crypto: CryptoService
  ) {}

  /**
   * Resolves the configuration for ONE embedding execution.
   *
   * The default-row query is the only hot read (`capability, enabled` index, plus
   * the partial unique index that makes `isDefault` unambiguous).
   */
  async resolveEmbedding(): Promise<ResolvedAIExecution> {
    const row = await this.prisma.aIProviderConfig.findFirst({
      where: { capability: 'EMBEDDING', enabled: true, isDefault: true },
    });

    if (!row) {
      return this.environmentBootstrap();
    }

    return this.resolveStoredRow(row);
  }

  /**
   * Resolves ONE stored row — the connection test's entry point, and the body of
   * `resolveEmbedding`. PUBLIC so the test path reuses this exact logic instead of
   * a second implementation free to disagree about credential precedence.
   *
   * `submittedCredential` (verify-before-save) takes precedence and SKIPS decryption
   * entirely: a broken stored envelope must not block testing a fresh key.
   */
  resolveStoredRow(row: ConfigRow, submittedCredential?: string): ResolvedAIExecution {
    // Defence in depth (§16): the matrix is code, the row is data. Re-checked here,
    // not only at write time, because a row saved under an older matrix must not
    // keep resolving after support was withdrawn.
    if (!this.registry.supports(row.provider, row.capability as AICapabilityValue)) {
      throw new AIExecutionError(
        AI_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Provider ${row.provider} does not support ${row.capability}`
      );
    }

    const credential = submittedCredential ?? this.readCredential(row);

    // The endpoint policy runs at RESOLUTION time too (§18): a row that predates
    // the policy — or was written by any path that forgot it — cannot steer a call.
    if (row.baseUrl) {
      try {
        assertAIEndpointAllowed(row.baseUrl);
      } catch (err) {
        if (err instanceof AIEndpointPolicyError) {
          throw new AIExecutionError(
            AI_ERROR_CODES.SECURITY_POLICY_REJECTED,
            `Configured AI endpoint is not permitted: ${err.reason}`,
            { cause: err }
          );
        }
        throw err;
      }
    }

    return {
      // Safe after the `supports()` guard above: that check answers only for the
      // four matrix keys, so a string that passed it IS an `AIProviderKeyValue`.
      providerKey: row.provider as AIProviderKeyValue,
      adapter: this.registry.resolve(row.provider),
      model: row.modelName,
      baseUrl: row.baseUrl,
      configurationSource: 'DATABASE',
      executionOptions: {
        model: row.modelName,
        baseUrl: row.baseUrl ?? undefined,
        credential,
      },
    };
  }

  /**
   * Decrypts the stored credential, or returns undefined when the row stores none.
   *
   * A decryption FAILURE is a hard `CONFIGURATION_ERROR`, never a silent fallthrough
   * to the env key (§14): a wrong or rotated master key means this row is unusable,
   * and quietly spending the process-wide credential instead would mask a real
   * misconfiguration behind apparently-working behaviour.
   */
  private readCredential(row: ConfigRow): string | undefined {
    if (!row.credentialCiphertext || !row.credentialIv || !row.credentialAuthTag) {
      return undefined;
    }

    try {
      return this.crypto.decrypt({
        ciphertext: row.credentialCiphertext,
        iv: row.credentialIv,
        authTag: row.credentialAuthTag,
      });
    } catch (err) {
      throw new AIExecutionError(
        AI_ERROR_CODES.CONFIGURATION_ERROR,
        'Stored AI credential could not be decrypted',
        { cause: err }
      );
    }
  }

  /**
   * The environment-configured 49J-A path, unchanged: no row means the OpenAI
   * adapter runs on `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `EMBEDDING_MODEL` /
   * `EMBEDDING_DIMENSION`, resolved by the adapter itself. No explicit options are
   * handed over, so there is exactly one definition of the env defaults.
   */
  private environmentBootstrap(): ResolvedAIExecution {
    const adapter = this.registry.resolve('OPENAI');

    return {
      providerKey: 'OPENAI',
      adapter,
      model: adapter.getEmbeddingContract().model,
      baseUrl: null,
      configurationSource: 'ENVIRONMENT',
    };
  }
}
