import { HttpException, Injectable, Logger } from '@nestjs/common';
import { AIExecutionError, AI_ERROR_CODES } from '../../ai/ai-errors';
import { AIRuntimeResolver, type ResolvedAIExecution } from '../../ai/ai-runtime.resolver';
import type {
  AIExecutionContext,
  AIEmbeddingExecutionResult,
  AIGatewayContract,
} from './ai-gateway.contract';

/**
 * Phase AI-ARCH-HARDENING (§10/§11/§12): the AI gateway — the ONLY execution path
 * consumers use.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *  1. Resolve the effective configuration for the requested capability through
 *     `AIRuntimeResolver` (one indexed read; see that class for the fallback rules).
 *  2. Invoke the capability adapter with the effective options — model, baseUrl and
 *     credential — passed EXPLICITLY. Nothing global is written, so two concurrent
 *     executions cannot see each other's credential (§6).
 *  3. Return a STRUCTURED result: capability, provider, model, output and execution
 *     metadata (latency, configuration source, correlationId). The credential is not
 *     part of the result, at any depth.
 *
 * ERROR CONTRACT — it classifies, it does not swallow (§33). An `AIExecutionError`
 * (with its code) and any framework `HttpException` pass through unchanged; anything
 * else is wrapped as `UPSTREAM_UNAVAILABLE`. A caller that degrades — Search — catches;
 * a caller that fails loud lets it propagate. Either way the message is safe.
 *
 * LOGGING (§34): FAILURES are logged, once, with structured fields —
 * provider/capability/model/code/latency/moduleId/correlationId. Successes are NOT
 * logged here: a bulk search index would produce one line per row, and the metadata
 * travels back to the caller instead. No field ever contains the credential, the
 * input text or a provider payload.
 *
 * It holds NO state — no cached resolution (§40), no connection, no credential.
 */
@Injectable()
export class AIGateway implements AIGatewayContract {
  private readonly logger = new Logger(AIGateway.name);

  constructor(private readonly resolver: AIRuntimeResolver) {}

  async embed(input: string, context?: AIExecutionContext): Promise<AIEmbeddingExecutionResult> {
    const startedAt = Date.now();

    let execution: ResolvedAIExecution;
    try {
      execution = await this.resolver.resolveEmbedding();
    } catch (err) {
      const error = this.normalise(err);
      this.logFailure(null, error, context, Date.now() - startedAt);
      throw error;
    }

    try {
      const output = await execution.adapter.generateEmbedding(input, execution.executionOptions);

      return {
        capability: 'EMBEDDING',
        provider: execution.providerKey,
        model: execution.model,
        output,
        metadata: {
          latencyMs: Date.now() - startedAt,
          configurationSource: execution.configurationSource,
          ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
        },
      };
    } catch (err) {
      const error = this.normalise(err);
      this.logFailure(execution, error, context, Date.now() - startedAt);
      throw error;
    }
  }

  /**
   * Keeps the taxonomy closed without mangling callers' errors: a classified
   * execution error and a framework HTTP error are already meaningful; anything
   * else (an adapter throwing a bare `Error`) is an upstream failure by definition.
   */
  private normalise(err: unknown): Error {
    if (err instanceof AIExecutionError) return err;
    if (err instanceof HttpException) return err;

    return new AIExecutionError(AI_ERROR_CODES.UPSTREAM_UNAVAILABLE, 'AI provider call failed', {
      cause: err,
    });
  }

  /** The single safe log line. Fields are closed; no free-form upstream text. */
  private logFailure(
    execution: ResolvedAIExecution | null,
    error: Error,
    context: AIExecutionContext | undefined,
    latencyMs: number
  ): void {
    this.logger.warn(
      {
        provider: execution?.providerKey ?? null,
        capability: 'EMBEDDING',
        model: execution?.model ?? null,
        code: error instanceof AIExecutionError ? error.code : 'UNCLASSIFIED',
        status: 'FAILURE',
        latencyMs,
        moduleId: context?.moduleId,
        correlationId: context?.correlationId,
      },
      'AI embedding execution failed'
    );
  }
}
