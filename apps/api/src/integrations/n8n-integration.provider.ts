import { Injectable, Logger } from '@nestjs/common';
import {
  IDEMPOTENCY_HEADER,
  EVENT_ID_HEADER,
  INTEGRATION_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  idempotencyKeyFor,
  signRequest,
} from './integration-signature';
import { buildIntegrationUrl, evaluateIntegrationUrl } from './integration-url.guard';
import type {
  IntegrationDispatchTarget,
  IntegrationEvent,
  IntegrationProvider,
  IntegrationProviderResult,
} from './integration.contract';

/**
 * Phase 49L §4: the n8n adapter, and the ONLY file in this codebase that knows
 * anything about n8n.
 *
 * WHAT "KNOWS ABOUT n8n" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------------------
 * It knows that n8n exposes an HTTP webhook that accepts a JSON body, and that its
 * responses sometimes carry an execution identifier. That is the entire coupling.
 * It does NOT:
 *  - connect to n8n's database, or know that n8n has one;
 *  - read n8n's internal tables, node types, or workflow JSON;
 *  - hold a workflow id — the ROUTE is configuration (`webhookPath`), so binding an
 *    event to a workflow is done in n8n, by whoever owns the workflow;
 *  - use the n8n REST API, its editor API, or any versioned n8n endpoint whose
 *    shape could change under us.
 *
 * Consequently Aria remains fully functional with n8n stopped, unavailable,
 * misconfigured or removed: every failure path below returns `accepted: false` with
 * a short code, and `AutomationService` records that without touching the business
 * operation that triggered it.
 *
 * TRANSPORT IS THE GLOBAL `fetch`, MATCHING `OpenAIProvider` AND `HealthService`.
 * No HTTP client dependency is added — `axios` IS in `apps/api/package.json` but
 * nothing under `src/` imports it (verified), so using it here would activate a
 * dormant dependency for no benefit. `AbortSignal.timeout` is used rather than a
 * bare `setTimeout` + `AbortController` pair because its timer is unref'd, so a
 * pending dispatch cannot hold the event loop — or a Jest run — open.
 *
 * NOTHING IS LOGGED THAT COULD CARRY A SECRET (§15/§43). Not the signature, not the
 * headers, not the body, not the response body. What is logged is: the integration
 * key, the event type, the status code and the duration.
 */

/** Only 2xx counts as accepted. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether another attempt could plausibly succeed.
 *
 * 5xx and 429 are retryable — the engine is overloaded or briefly broken. Every
 * other 4xx is NOT: a 404 means the workflow is not registered, a 401/403 means the
 * signature was rejected, and replaying either burns the bounded attempt budget
 * without any chance of a different outcome.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Bytes of the response we are willing to read.
 *
 * The body is read ONLY to look for an execution id. A hostile or misconfigured
 * endpoint could stream indefinitely, so the read is bounded and a failure to
 * parse is not an error — the dispatch already succeeded at that point.
 */
const MAX_RESPONSE_BYTES = 8 * 1024;

@Injectable()
export class N8nIntegrationProvider implements IntegrationProvider {
  readonly key = 'N8N' as const;

  private readonly logger = new Logger(N8nIntegrationProvider.name);

  /**
   * Delivers one envelope to the configured n8n webhook.
   *
   * NEVER THROWS for an upstream condition. A rejected promise here would surface
   * as a 500 in the business operation that triggered the automation, which §22
   * forbids: optional automation must not become a transactional dependency.
   */
  async send(
    target: IntegrationDispatchTarget,
    envelope: IntegrationEvent,
    secret: string,
  ): Promise<IntegrationProviderResult> {
    // RE-VALIDATED HERE, not only on write. The stored row was checked when it was
    // saved, but `INTEGRATION_ALLOW_PRIVATE_TARGETS` is environment configuration
    // and can be turned off after the row exists — at which point the previously
    // acceptable loopback endpoint must stop being dispatched to.
    const policy = evaluateIntegrationUrl(target.baseUrl);

    if (!policy.ok) {
      this.logger.warn(
        { integration: this.key, reason: policy.errorCode },
        'Integration dispatch blocked by URL policy',
      );
      return { accepted: false, errorCode: 'SSRF_BLOCKED', retryable: false };
    }

    let url: string;

    try {
      url = buildIntegrationUrl(target.baseUrl, target.webhookPath);
    } catch {
      return { accepted: false, errorCode: 'MALFORMED_TARGET', retryable: false };
    }

    const body = JSON.stringify(envelope);
    const timestamp = String(Date.now());
    const idempotencyKey = idempotencyKeyFor(this.key, envelope.eventId, envelope.version);

    const signature = signRequest(secret, {
      method: 'POST',
      path: new URL(url).pathname,
      timestamp,
      eventId: envelope.eventId,
      idempotencyKey,
      body,
    });

    const startedAt = Date.now();
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: timestamp,
          [EVENT_ID_HEADER]: envelope.eventId,
          [INTEGRATION_HEADER]: this.key,
          [IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';

      // The caught error is NOT spread into the log: a fetch failure message can
      // include the full URL, and the URL is operator infrastructure detail.
      this.logger.warn(
        {
          integration: this.key,
          eventType: envelope.eventType,
          durationMs: Date.now() - startedAt,
          reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
        },
        'Integration dispatch failed before a response was received',
      );

      // Both are retryable: the engine may simply be restarting.
      return {
        accepted: false,
        errorCode: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
        retryable: true,
      };
    }

    const durationMs = Date.now() - startedAt;

    if (!isSuccess(response.status)) {
      this.logger.warn(
        {
          integration: this.key,
          eventType: envelope.eventType,
          status: response.status,
          durationMs,
        },
        'Integration engine rejected the event',
      );

      return {
        accepted: false,
        errorCode: `HTTP_${response.status}`,
        retryable: isRetryableStatus(response.status),
      };
    }

    this.logger.log(
      {
        integration: this.key,
        eventType: envelope.eventType,
        status: response.status,
        durationMs,
      },
      'Integration event accepted',
    );

    return {
      accepted: true,
      externalExecutionId: await this.readExecutionId(response),
    };
  }

  /**
   * Best-effort extraction of the engine's execution id.
   *
   * n8n's webhook response shape is NOT a contract — it is whatever the workflow's
   * "Respond to Webhook" node returns, and a workflow may return nothing at all.
   * So every failure here is silent and the dispatch still counts as accepted: an
   * unparseable response means "no external reference", never "delivery failed".
   *
   * The candidate field names are tried in order and the value is bounded, because
   * it is stored in a column and displayed in the admin UI.
   */
  private async readExecutionId(response: Response): Promise<string | undefined> {
    try {
      const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
      if (!text) return undefined;

      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return undefined;

      const record = parsed as Record<string, unknown>;

      for (const field of ['executionId', 'execution_id', 'id']) {
        const value = record[field];
        if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
          return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }
}

