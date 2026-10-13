/**
 * Phase 49M-2: the observability contract.
 *
 * THIS FILE IS THE BOUNDARY. Everything a Core capability needs in order to be observed
 * is declared here, and nothing here mentions Prisma, a table, a Postgres type, pino, a
 * queue or an HTTP concept. A caller that imports from this file cannot become coupled to
 * where the data lands — which is the same rule `integration.contract.ts` (49L) and
 * `module.contract.ts` (49M) follow, for the same reason.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO MAKE STRUCTURAL:
 *
 * 1. `messageCode` IS A CLOSED SET. A log line's machine identity is drawn from
 *    `LOG_MESSAGE_CODES` below and validated before enqueue, so the `messageCode` column
 *    cannot become unbounded and a dashboard grouping by it cannot silently fragment
 *    because someone typo'd a string. The human `message` stays free-form.
 *
 * 2. NO BODY, NO HEADER, NO RAW URL IS EVER ACCEPTED. There is no `body`, `headers`,
 *    `query` or `url` field on any input type here. `route` is documented as the matched
 *    route PATTERN. That is a privacy boundary expressed as an absence: a field that does
 *    not exist cannot be populated by a well-meaning caller.
 *
 * 3. LOGS ARE DROPPABLE; AUDIT AND SECURITY EVENTS ARE NOT. The two are separate input
 *    types with separate emit methods for exactly this reason, and the distinction is
 *    documented on the type rather than living only in the writer.
 *
 * 4. A CAPABILITY CANNOT SET ITS OWN CORRELATION IDS. `requestId`, `correlationId` and
 *    `traceId` are absent from every input type: the writer reads them from
 *    `RequestContextService` and the OTel context. A caller that could pass them could
 *    attribute its own events to someone else's request.
 */

/**
 * Log severities, mirroring the pino level names one-for-one.
 *
 * SAME VOCABULARY AS `LOG_LEVEL` AND `pino-config.ts`, deliberately: a second set of
 * names would mean translating a level twice and getting it wrong once.
 */
export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

export type LogLevelValue = (typeof LOG_LEVELS)[number];

/**
 * Numeric ordering used for threshold comparison, matching pino's numeric levels.
 *
 * A MAP RATHER THAN `LOG_LEVELS.indexOf`, because the array order is a presentation
 * detail and threshold logic must not silently change if someone reorders it.
 */
export const LOG_LEVEL_SEVERITY: Record<LogLevelValue, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
};

/**
 * The levels whose rows may be DISCARDED when the bounded queue is full, in the order
 * they are shed.
 *
 * WHY A DROP POLICY AT ALL: the alternative to dropping is unbounded memory growth or
 * blocking the request path on a database write. Both are worse than losing a DEBUG line.
 * ERROR and FATAL are never in this list — if those cannot be persisted the queue is
 * already lost and the failure is reported through the health probe instead of being
 * hidden by a silent discard.
 */
export const DROPPABLE_LEVELS: readonly LogLevelValue[] = ['TRACE', 'DEBUG', 'INFO', 'WARN'];

export function isDroppableLevel(level: LogLevelValue): boolean {
  return DROPPABLE_LEVELS.includes(level);
}

/**
 * Stable machine codes for log lines.
 *
 * ONE CODE PER THING THAT ACTUALLY HAPPENS IN THIS REPOSITORY TODAY. Nothing here is
 * speculative, and nothing here names a business module: `HTTP_REQUEST_COMPLETED` and
 * `HTTP_REQUEST_FAILED` come from the interceptor, the `OBSERVABILITY_*` codes are the
 * platform reporting on itself (which is how a dropped-batch problem becomes visible),
 * and the rest correspond to seams 49L/49M/49M-1 already own.
 *
 * A code NOT in this list is REFUSED before enqueue, so a typo is a caught bug rather
 * than a new cardinality group in the largest table in the system.
 */
export const LOG_MESSAGE_CODES = [
  // HTTP request lifecycle — emitted by ObservabilityInterceptor.
  'HTTP_REQUEST_COMPLETED',
  'HTTP_REQUEST_FAILED',

  // The platform observing itself.
  'OBSERVABILITY_QUEUE_OVERFLOW',
  'OBSERVABILITY_BATCH_FLUSHED',
  'OBSERVABILITY_BATCH_FAILED',
  'OBSERVABILITY_WRITE_TIMEOUT',
  'OBSERVABILITY_WRITE_REJECTED',
  'OBSERVABILITY_RETENTION_COMPLETED',
  'OBSERVABILITY_RETENTION_FAILED',
  'OBSERVABILITY_SHUTDOWN_FLUSH',

  // Integration platform (49L).
  'INTEGRATION_DISPATCH_ATTEMPTED',
  'INTEGRATION_DISPATCH_FAILED',
  'INTEGRATION_CALLBACK_RECEIVED',

  // Module platform (49M) and provisioning (49M-1).
  'MODULE_INVOCATION_ATTEMPTED',
  'MODULE_INVOCATION_FAILED',
  'MODULE_HEALTH_EVALUATED',
  'MODULE_REGISTRATION_RECEIVED',
  'PROVISIONING_STEP_EXECUTED',

  // Generic escape hatches, still bounded.
  'BACKGROUND_TASK_COMPLETED',
  'BACKGROUND_TASK_FAILED',
  'UNHANDLED_EXCEPTION',
] as const;

export type LogMessageCode = (typeof LOG_MESSAGE_CODES)[number];

const LOG_MESSAGE_CODE_SET: ReadonlySet<string> = new Set(LOG_MESSAGE_CODES);

export function isKnownMessageCode(value: string): value is LogMessageCode {
  return LOG_MESSAGE_CODE_SET.has(value);
}

/**
 * Emitting logical areas.
 *
 * A CLOSED SET so `source` stays groupable. It names SEAMS, not modules: `http`, `auth`,
 * `integrations`, `module-platform`, `observability`, `background`. There is no `hr` and
 * no `finance`, and there will not be — a business module logs through `module-platform`
 * or through its own deployment, never by adding a member here.
 */
export const LOG_SOURCES = [
  'http',
  'auth',
  'rbac',
  'integrations',
  'module-platform',
  'observability',
  'background',
] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

/** Actor kinds. SYSTEM ≠ ANONYMOUS — see the schema comment on `ActorType`. */
export const ACTOR_TYPES = ['USER', 'MODULE', 'SYSTEM', 'ANONYMOUS'] as const;

export type ActorTypeValue = (typeof ACTOR_TYPES)[number];

/** Audit outcomes. DENIED is distinct from FAILURE: refusal vs breakage. */
export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE', 'DENIED'] as const;

export type AuditOutcomeValue = (typeof AUDIT_OUTCOMES)[number];

/** Security event classes. Every member is observable in this repository today. */
export const SECURITY_EVENT_TYPES = [
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGOUT',
  'TOKEN_REFRESHED',
  'TOKEN_REUSE_DETECTED',
  'PASSWORD_CHANGED',
  'AUTHENTICATION_MISSING',
  'AUTHORIZATION_DENIED',
  'RATE_LIMIT_EXCEEDED',
  'SIGNATURE_INVALID',
  'SSRF_BLOCKED',
  'VALIDATION_REJECTED',
  'SUSPICIOUS_PAYLOAD',
] as const;

export type SecurityEventTypeValue = (typeof SECURITY_EVENT_TYPES)[number];

export const SECURITY_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export type SecuritySeverityValue = (typeof SECURITY_SEVERITIES)[number];

/**
 * Default severity per security event type.
 *
 * A TABLE RATHER THAN A CALLER ARGUMENT, so two call sites cannot disagree about how
 * serious a failed login is. A caller may override it — a single failed login is LOW, but
 * the tenth from one IP is a judgement the caller has context for — and the default keeps
 * the common case consistent.
 *
 * SSRF_BLOCKED is HIGH rather than CRITICAL on purpose: the defence WORKED. It is a
 * successful refusal that an operator must see, not an incident in progress.
 */
export const DEFAULT_SECURITY_SEVERITY: Record<SecurityEventTypeValue, SecuritySeverityValue> = {
  LOGIN_SUCCEEDED: 'INFO',
  LOGIN_FAILED: 'LOW',
  LOGOUT: 'INFO',
  TOKEN_REFRESHED: 'INFO',
  TOKEN_REUSE_DETECTED: 'CRITICAL',
  PASSWORD_CHANGED: 'MEDIUM',
  AUTHENTICATION_MISSING: 'LOW',
  AUTHORIZATION_DENIED: 'MEDIUM',
  RATE_LIMIT_EXCEEDED: 'MEDIUM',
  SIGNATURE_INVALID: 'HIGH',
  SSRF_BLOCKED: 'HIGH',
  VALIDATION_REJECTED: 'INFO',
  SUSPICIOUS_PAYLOAD: 'HIGH',
};

/** Platform seams that emit lifecycle events. No BUSINESS member, by design. */
export const LIFECYCLE_DOMAINS = ['INTEGRATION', 'MODULE', 'PROVISIONING'] as const;

export type LifecycleDomainValue = (typeof LIFECYCLE_DOMAINS)[number];

/**
 * Normalized lifecycle outcome, comparable ACROSS domains.
 *
 * Six values, because that is the number of genuinely different answers to "how did this
 * step end" once the domain-specific vocabulary is set aside. The original code is always
 * preserved in `outcomeCode`, so this normalization is lossless.
 */
export const LIFECYCLE_PHASES = [
  'STARTED',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'REFUSED',
  'TIMEOUT',
] as const;

export type LifecyclePhaseValue = (typeof LIFECYCLE_PHASES)[number];

/**
 * Bound on a serialised `context`/`detail` bag, enforced before enqueue.
 *
 * 8 KiB, an order of magnitude smaller than 49L's 64 KiB envelope, and deliberately so: an
 * envelope is the payload, whereas a log context is supposed to be a handful of ids. A
 * caller that hands over something larger has almost certainly passed a whole record, and
 * the writer replaces it with its size + checksum rather than truncating mid-structure —
 * so a reader can distinguish "this was too big" from "this was empty".
 */
export const MAX_CONTEXT_BYTES = 8 * 1024;

/** Field-length ceilings, mirroring the VarChar widths in the schema. */
export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_MESSAGE_CODE_LENGTH = 80;
export const MAX_ROUTE_LENGTH = 200;
export const MAX_ACTION_LENGTH = 120;
export const MAX_RESOURCE_TYPE_LENGTH = 80;
export const MAX_RESOURCE_ID_LENGTH = 200;
export const MAX_REASON_LENGTH = 500;
export const MAX_USER_AGENT_LENGTH = 400;
export const MAX_ERROR_MESSAGE_LENGTH = 1000;
export const MAX_ERROR_NAME_LENGTH = 160;
export const MAX_ERROR_STACK_LENGTH = 8 * 1024;

/**
 * Deployment identity attached to every record.
 *
 * WHY THIS IS A TYPE AND NOT THREE LOOSE STRINGS: the combined process, the Core-only
 * process (`core-main.ts`) and any remote module all write into ONE set of tables, and
 * without this triple their rows are indistinguishable. It is resolved ONCE at startup
 * from the environment, never per call — a caller cannot claim to be a different service.
 */
export interface ObservabilityIdentity {
  service: string;
  environment: string;
  /** Process/instance discriminator, e.g. a hostname or container id. Optional. */
  instanceRef?: string | null;
}

/**
 * Correlation identifiers, resolved by the writer rather than supplied by callers.
 *
 * ABSENT FROM EVERY PUBLIC INPUT TYPE BELOW, and that is the point: they are read from
 * `RequestContextService` (requestId/correlationId) and the OTel context (traceId/spanId).
 * A caller able to set them could attribute its events to another request, which would
 * make the audit trail unreliable in exactly the situation it matters.
 */
export interface ObservabilityCorrelation {
  requestId?: string | null;
  correlationId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
}

/**
 * Distributed attribution (49M), also resolved rather than claimed.
 *
 * A module identifies itself by presenting a credential to the registration routes; it
 * does not get to name itself in a log line. When Core CALLS a module, `ModuleClient`
 * supplies these because it knows which instance it dialled.
 */
export interface ObservabilityModuleContext {
  moduleId?: string | null;
  instanceId?: string | null;
  deploymentMode?: string | null;
}

/**
 * One log line, as a CALLER describes it.
 *
 * THE DROPPABLE INPUT. `ObservabilityService.log` returns void and never throws; whether
 * the row lands is a function of queue pressure and the configured level, not of the
 * caller. That is the honest contract for diagnostics.
 *
 * NOTE WHAT IS MISSING: no `requestId`/`correlationId`/`traceId` (resolved), no
 * `service`/`environment` (resolved), no `body`, no `headers`, no `url`. `route` is the
 * matched route PATTERN and is normally set by the interceptor rather than by hand.
 */
export interface LogInput {
  level: LogLevelValue;
  messageCode: LogMessageCode;
  message: string;
  source: LogSource;
  /** Small structured bag. Redacted and size-capped before it reaches the database. */
  context?: Record<string, unknown>;
  /** Matched route pattern (`/users/:id`), never `req.originalUrl`. */
  route?: string | null;
  httpMethod?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  /** Present for ERROR/FATAL. The stack is truncated and never indexed. */
  error?: unknown;
  /** Overrides the ambient user only for background work acting on someone's behalf. */
  userId?: string | null;
  tenantId?: string | null;
  module?: ObservabilityModuleContext;
}

/**
 * One audited state change, as a CALLER describes it.
 *
 * THE DURABLE INPUT. `ObservabilityAuditService.record` AWAITS the write with a finite
 * timeout and reports failure through the health probe and a pino line. It still never
 * throws into the business path (§22) — the distinction from a log line is that a failure
 * here is VISIBLE rather than silently dropped.
 */
export interface AuditEventInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  actorType: ActorTypeValue;
  actorId?: string | null;
  actorRole?: string | null;
  outcome: AuditOutcomeValue;
  reason?: string | null;
  tenantId?: string | null;
  /** Redacted with email/phone masking, exactly as `AuditService.log` already does. */
  beforeValue?: unknown;
  afterValue?: unknown;
  changedFields?: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
  module?: ObservabilityModuleContext;
}

/**
 * One security-relevant event.
 *
 * `severity` is OPTIONAL and defaults from `DEFAULT_SECURITY_SEVERITY`, so two call sites
 * cannot disagree about how serious a failed login is while a caller with real context can
 * still escalate.
 *
 * `attemptedIdentifier` is MASKED before insert. There is no field for a password, a
 * token, a signature or a header — a security table full of credential material is itself
 * a disclosure risk.
 */
export interface SecurityEventInput {
  eventType: SecurityEventTypeValue;
  succeeded: boolean;
  actorType: ActorTypeValue;
  actorId?: string | null;
  severity?: SecuritySeverityValue;
  attemptedIdentifier?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  httpMethod?: string | null;
  route?: string | null;
  requiredPermission?: string | null;
  tenantId?: string | null;
  reasonCode?: string | null;
  detail?: Record<string, unknown>;
  module?: ObservabilityModuleContext;
}

/**
 * One normalized platform lifecycle transition.
 *
 * `phase` is the cross-domain answer and `outcomeCode` keeps the domain's own code
 * verbatim, so normalizing never destroys the specific reason. `detail` must never carry
 * an event payload, a webhook body, a credential or an endpoint URL: a lifecycle event
 * records that something happened to a subject, not what was sent to it.
 */
export interface LifecycleEventInput {
  domain: LifecycleDomainValue;
  eventType: string;
  phase: LifecyclePhaseValue;
  outcomeCode?: string | null;
  subjectType: string;
  subjectId?: string | null;
  subjectKey?: string | null;
  actorType: ActorTypeValue;
  actorId?: string | null;
  tenantId?: string | null;
  durationMs?: number | null;
  attempt?: number | null;
  detail?: Record<string, unknown>;
  module?: ObservabilityModuleContext;
}

/**
 * Snapshot of the writer's internal state, for the health probe and the metrics surface.
 *
 * `dropped` IS THE FIELD THAT MATTERS. A platform that silently discards log lines under
 * pressure and reports nothing is worse than one that does not log at all, because it
 * lies. This counter is monotonic per process and is exposed through the observability
 * health endpoint.
 */
export interface WriterStats {
  queued: number;
  queueCapacity: number;
  enqueued: number;
  written: number;
  dropped: number;
  failedBatches: number;
  lastFlushAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  flushing: boolean;
}
