import { Injectable, Logger } from '@nestjs/common';
import { ObservabilityConfigService } from './observability.config';
import {
  isKnownMessageCode,
  LogInput,
  MAX_MESSAGE_LENGTH,
  MAX_ROUTE_LENGTH,
  WriterStats,
} from './observability.contract';
import {
  clampText,
  normalizeError,
  resolveCorrelation,
  sanitizeContext,
} from './observability.sanitizer';
import { ObservabilityWriter } from './observability.writer';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49M-2: the DROPPABLE emit path — application logging.
 *
 * WHAT A CALLER GETS: a `void` method that never throws, never returns a promise, and never
 * blocks. Whether a given line reaches the database is a function of the configured level
 * and queue pressure, and that is stated plainly rather than implied.
 *
 * WHY THIS IS A DIFFERENT CLASS FROM THE AUDIT PATH: the two have opposite contracts. This
 * one is allowed to lose data; `ObservabilityAuditService` is not. Putting both behind one
 * class with a boolean flag would make the most important property of an emit call
 * invisible at the call site — a reader could not tell whether `log(...)` was durable.
 *
 * IT DOES NOT REPLACE PINO. `nestjs-pino` still writes structured lines to stdout, which is
 * what a container platform collects and what a developer tails. This writes the QUERYABLE
 * copy: stdout cannot answer "every 500 for tenant X in the last hour, by route".
 */
@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);
  /** Counts refusals caused by an unknown messageCode, surfaced in the health probe. */
  private rejectedUnknownCode = 0;

  constructor(
    private readonly writer: ObservabilityWriter,
    private readonly config: ObservabilityConfigService,
  ) {}

  /**
   * Records one application log line.
   *
   * THREE GATES BEFORE ANY WORK, in cheapest-first order: disabled, below threshold,
   * unknown message code. The ordering matters — when observability is off, a TRACE call in
   * a hot loop must cost one boolean test, not a sanitize pass.
   */
  log(input: LogInput): void {
    if (!this.config.enabled) return;
    if (!this.config.acceptsLevel(input.level)) return;

    // An unknown code is REFUSED rather than stored, because the whole value of a bounded
    // vocabulary is that a dashboard grouping by `messageCode` cannot fragment silently.
    // Refusing loudly (pino WARN + counter) turns a typo into a caught bug.
    if (!isKnownMessageCode(input.messageCode)) {
      this.rejectedUnknownCode += 1;
      this.logger.warn(
        { messageCode: input.messageCode, source: input.source },
        'Refused log line with unknown messageCode',
      );
      return;
    }

    const ctx = RequestContextService.get();
    const correlation = resolveCorrelation();
    const normalized = input.error !== undefined ? normalizeError(input.error) : null;

    this.writer.enqueue({
      level: input.level,
      messageCode: input.messageCode,
      message: clampText(input.message, MAX_MESSAGE_LENGTH) ?? input.messageCode,
      source: input.source,

      // Resolved, never caller-supplied: see ObservabilityIdentity in the contract.
      service: this.config.identity.service,
      environment: this.config.identity.environment,
      instanceRef: this.config.identity.instanceRef ?? null,

      requestId: correlation.requestId ?? null,
      correlationId: correlation.correlationId ?? null,
      traceId: correlation.traceId ?? null,
      spanId: correlation.spanId ?? null,

      // The ambient user wins unless the caller names one explicitly — background work
      // acting on someone's behalf has no request store to read from.
      userId: clampText(input.userId ?? ctx?.userId, 64),
      tenantId: clampText(input.tenantId ?? ctx?.tenantId, 64),

      httpMethod: clampText(input.httpMethod, 10),
      // `route` is the matched Nest PATTERN. There is no field here for `originalUrl`,
      // so a query string carrying a token cannot arrive by this path.
      route: clampText(input.route, MAX_ROUTE_LENGTH),
      statusCode: input.statusCode ?? null,
      durationMs: input.durationMs ?? null,

      moduleId: clampText(input.module?.moduleId, 64),
      instanceId: clampText(input.module?.instanceId, 96),
      deploymentMode: clampText(input.module?.deploymentMode, 16),

      context: sanitizeContext(input.context) as never,
      errorName: normalized?.errorName ?? null,
      errorMessage: normalized?.errorMessage ?? null,
      errorStack: normalized?.errorStack ?? null,
    });
  }

  /** Convenience wrappers. Identical semantics, fixed level. */
  debug(input: Omit<LogInput, 'level'>): void {
    this.log({ ...input, level: 'DEBUG' });
  }

  info(input: Omit<LogInput, 'level'>): void {
    this.log({ ...input, level: 'INFO' });
  }

  warn(input: Omit<LogInput, 'level'>): void {
    this.log({ ...input, level: 'WARN' });
  }

  error(input: Omit<LogInput, 'level'>): void {
    this.log({ ...input, level: 'ERROR' });
  }

  /** Writer state plus this service's own refusal counter. */
  stats(): WriterStats & { rejectedUnknownCode: number } {
    return { ...this.writer.stats(), rejectedUnknownCode: this.rejectedUnknownCode };
  }

  /** Forces a flush. Used by tests and by the shutdown path; safe to call at any time. */
  async flush(): Promise<void> {
    await this.writer.flush();
  }
}
