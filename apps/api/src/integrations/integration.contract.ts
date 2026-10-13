/**
 * Phase 49L: the provider-neutral integration contract.
 *
 * THIS FILE IS THE BOUNDARY. Everything a business module needs to emit an event
 * is declared here, and nothing here mentions n8n, a webhook URL, an HTTP verb, a
 * header name or a signature. A module that imports from this file cannot become
 * coupled to the engine that happens to be configured — which is the whole point
 * of the phase: n8n is the first CONSUMER of this contract, never its shape.
 *
 * WHY A HAND-WRITTEN ENVELOPE AND NOT THE EXISTING RabbitMQ EVENT SHAPE
 * ---------------------------------------------------------------------
 * `NotificationPublisher.publish(eventType, payload)` already exists and already
 * fans out to a `domain_events` topic exchange. It is deliberately NOT reused as
 * the outbound integration contract, for three reasons that are properties of the
 * code rather than preferences:
 *
 *  1. It has no envelope. `AuditService.publishAuditEvent` spreads the whole
 *     `AuditOptions` — including `oldValue`/`newValue`, i.e. full before/after
 *     records — onto the message. That is the opposite of §11 payload
 *     minimisation, and those payloads are only redacted on their way into
 *     `AuditLog`, not on their way onto the exchange.
 *  2. It has no version field, so a consumer cannot tell `ticket.created` v1 from
 *     v2 (§7).
 *  3. It is fire-and-forget with no execution identity: `publish` swallows every
 *     failure and returns void, so nothing can report ACCEPTED/FAILED per
 *     destination (§19).
 *
 * The RabbitMQ path is left completely untouched. This is an additional, narrower
 * contract, not a replacement.
 */

/** Envelope contract version. Bumped only if the ENVELOPE shape changes, never for a payload change. */
export const ENVELOPE_VERSION = 1;

/**
 * Bound on the serialised envelope, enforced before dispatch and again on inbound
 * callbacks.
 *
 * 64 KiB is generous for a minimised payload (§11 expects a handful of ids) while
 * still refusing an accidental full-record payload — which is the realistic
 * failure mode, since a caller CAN pass an arbitrary object.
 */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

/**
 * Event types Aria may emit, and the reason the list is this short.
 *
 * §6 says "ONLY emit events for real existing domain events". Each entry below
 * corresponds to a state change that already happens in this repository today:
 *
 *   ticket.created   — SupportService.createTicket
 *   ticket.updated   — SupportService.updateTicket (assignee/priority/category)
 *   ticket.resolved  — SupportService.changeStatus reaching RESOLVED
 *
 * Deliberately ABSENT, though the prompt lists them as examples:
 *   notification.created — NotificationService.createForUser is itself already the
 *                          delivery mechanism; emitting an integration event for it
 *                          would invite a loop where an automation creates a
 *                          notification that emits an event that creates a
 *                          notification.
 *   message.sent         — MessagingService fans out over WebSocket at high
 *                          frequency; one outbound HTTP call per chat message is
 *                          exactly the per-row fan-out §44 forbids.
 *   calendar.reminder.due — ReminderDispatcherService claims rows in a bounded
 *                          tick; wiring an outbound call into that claim would put
 *                          a network round-trip inside the idempotency window that
 *                          makes reminder delivery exactly-once.
 *   survey.published / user.created / user.updated — no consumer exists, and §6
 *                          forbids inventing events nothing listens to.
 *
 * A type not in this list is REFUSED by `IntegrationGateway`, so a typo cannot
 * silently dispatch an event no workflow is bound to.
 */
export const INTEGRATION_EVENT_TYPES = [
  'ticket.created',
  'ticket.updated',
  'ticket.resolved',
] as const;

export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

/**
 * The connection-test event type, deliberately NOT a member of
 * `INTEGRATION_EVENT_TYPES`.
 *
 * It is not a domain event: nothing in Aria changed, no execution row is written for
 * it, and `AutomationService.trigger` REFUSES it precisely because it is absent from
 * the dispatchable set. Only `testConnection` constructs it, so a workflow can
 * distinguish "an operator is checking the wiring" from "a ticket was really
 * created" — and a test can never be mistaken for a delivery in the execution
 * history.
 */
export const PROBE_EVENT_TYPE = 'integration.connection.test';


/**
 * Current payload version per event type (§7).
 *
 * Version is EXPLICIT and travels in the envelope. A payload meaning change must
 * add a new version here rather than editing the existing shape in place — that
 * is the difference between "consumers can migrate" and "consumers silently
 * misread".
 */
export const INTEGRATION_EVENT_VERSIONS: Record<IntegrationEventType, number> = {
  'ticket.created': 1,
  'ticket.updated': 1,
  'ticket.resolved': 1,
};

/**
 * The emitting Core capability. A closed set, because `source` is part of the
 * contract a consumer routes on — a free-form string would let two modules claim
 * the same source name.
 */
export const INTEGRATION_SOURCES = ['support'] as const;

export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

/** Tenant context. `id` is nullable because `User.tenantId` is (§9). */
export interface IntegrationTenantContext {
  id: string | null;
}

/**
 * Actor context, present only when a human caused the event (§10).
 *
 * IDS AND A TYPE, NEVER A USER OBJECT. No email, no phone, no display name, no
 * session, no role list: a consumer that needs more calls the authorized Core API
 * with its own credential.
 */
export interface IntegrationActorContext {
  type: 'user' | 'system';
  id: string | null;
}

/**
 * The standard envelope (§8). Structurally identical for every event type; only
 * `payload` differs, and it is versioned.
 */
export interface IntegrationEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  /**
   * A dispatchable domain event type, or the probe type.
   *
   * The union is explicit rather than a plain `string` so a caller cannot invent an
   * event type at the type level; `AutomationService.trigger` narrows further and
   * refuses the probe, so only `testConnection` can produce one.
   */
  eventType: IntegrationEventType | typeof PROBE_EVENT_TYPE;
  version: number;
  occurredAt: string;
  source: IntegrationSource;
  tenant: IntegrationTenantContext;
  actor?: IntegrationActorContext;
  correlationId?: string;
  payload: TPayload;
}

/**
 * What a business module hands to `AutomationService.trigger`.
 *
 * NOTE WHAT IS NOT HERE: no url, no headers, no integration key, no signature, no
 * timeout. A caller cannot choose a destination (§29/§30) — the gateway resolves
 * the configured integrations itself — and cannot weaken transport security.
 *
 * `eventId` is OPTIONAL and defaults to a fresh UUID. A caller that wants a
 * retried business operation to be idempotent at the automation layer supplies a
 * STABLE id derived from its own domain data; the idempotency key is then
 * deterministic (§18) and the second trigger is a no-op rather than a duplicate.
 */
export interface TriggerAutomationInput<TPayload = Record<string, unknown>> {
  eventType: IntegrationEventType;
  source: IntegrationSource;
  payload: TPayload;
  /** Stable id for deduplication. Defaults to a random UUID. */
  eventId?: string;
  /** Overrides the request context's tenant. Used by non-HTTP callers. */
  tenantId?: string | null;
  actor?: IntegrationActorContext;
}

/**
 * NORMALIZED dispatch outcome (§4).
 *
 * No provider-specific field appears here: no HTTP status, no response body, no
 * header. A business module learns whether the automation was recorded and,
 * at most, an opaque external reference — never anything it could branch on in a
 * way that couples it to n8n.
 */
export interface AutomationDispatchResult {
  /** False when no integration is configured/enabled — NOT an error (§22). */
  dispatched: boolean;
  /** Present whenever an execution row exists. */
  executionId?: string;
  status:
    | 'SKIPPED'
    | 'PENDING'
    | 'SENT'
    | 'ACCEPTED'
    | 'RETRYING'
    | 'COMPLETED'
    | 'FAILED';
  /** Set when the dispatch collided with an existing idempotency key. */
  duplicate?: boolean;
  /** Short internal code. Never an upstream message. */
  errorCode?: string;
}

/**
 * The adapter interface every integration provider implements.
 *
 * `send` returns a NORMALIZED result. An adapter may never leak the engine's
 * response shape upward, which is what keeps `AutomationService` — and therefore
 * every business module — free of engine-specific branching.
 */
export interface IntegrationProviderResult {
  /** True only for a 2xx from the engine. */
  accepted: boolean;
  /** The engine's execution id when it returns one. Opaque to Aria. */
  externalExecutionId?: string;
  /** Short internal code on failure: TIMEOUT / UNREACHABLE / HTTP_<status> / SSRF_BLOCKED. */
  errorCode?: string;
  /**
   * Whether another attempt could plausibly succeed. A timeout or a 5xx is
   * retryable; a 4xx is not, because replaying a rejected request cannot change
   * the outcome and would burn the bounded attempt budget.
   */
  retryable?: boolean;
}

export interface IntegrationProvider {
  /** The key this adapter serves. */
  readonly key: 'N8N';

  /**
   * Delivers one envelope. MUST NOT throw for an upstream failure: a rejected
   * promise here would surface as a 500 in the business operation that triggered
   * the automation, which §22 forbids. Failures come back as `accepted: false`.
   */
  send(
    config: IntegrationDispatchTarget,
    envelope: IntegrationEvent,
    secret: string,
  ): Promise<IntegrationProviderResult>;
}

/**
 * Exactly what an adapter is given about the destination — and no more.
 *
 * The secret is passed as a separate argument rather than living on this object,
 * so a log line that dumps the target cannot print the credential.
 */
export interface IntegrationDispatchTarget {
  baseUrl: string;
  webhookPath: string;
  timeoutMs: number;
}

