import { coreGet } from './core-http';

/**
 * Phase 49M-2: observability read client.
 *
 * Mirrors `ObservabilityController` exactly (`GET /admin/observability/vocabulary`, `/health`,
 * `/metrics`, `/logs`, `/audit-events`, `/security-events`, `/lifecycle-events`,
 * `/retention-runs`).
 *
 * FOUR THINGS THIS MODULE DELIBERATELY CANNOT DO:
 *
 * 1. WRITE A LOG LINE. There is no `postLog`, because the server has no such route. An HTTP
 *    endpoint that accepts log lines is a way for a browser to fill the database, and every
 *    legitimate producer runs inside the API and injects `ObservabilityService` directly.
 *
 * 2. DELETE ANYTHING. Deletion happens only by retention policy. An administrator who could
 *    delete individual audit or security rows could erase the evidence of their own actions,
 *    which would make the tables worthless as an audit trail.
 *
 * 3. QUERY WITHOUT A TIME WINDOW. `from` is REQUIRED by the types below, not optional with a
 *    default, because these are the largest tables in the installation: an unbounded
 *    `ORDER BY occurredAt DESC LIMIT 50` scans until it finds 50 rows, and every §21 index
 *    leads with `occurredAt`. The requirement is enforced server-side too; expressing it in
 *    the type means a caller cannot construct the expensive query at all.
 *
 * 4. FREE-TEXT SEARCH. There is no `q` parameter, because `ILIKE '%...%'` over a
 *    multi-million-row table cannot use any of those indexes. Filtering is by indexed,
 *    enumerated columns only.
 *
 * THE VOCABULARIES ARE READ FROM THE SERVER (`getObservabilityVocabulary`) rather than
 * duplicated here — the same rule `modules-api.ts` (49M) follows for the platform descriptor
 * and `integrations-api.ts` (49L) for the catalogue. A client-side copy of the level list or
 * the message-code set is how a UI ends up offering a filter the backend stopped emitting.
 */

/** Matches the `LogLevel` enum. */
export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** Matches the `ActorType` enum. */
export type ActorType = 'USER' | 'MODULE' | 'SYSTEM' | 'ANONYMOUS';

/** Matches the `AuditOutcome` enum. */
export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';

/** Matches the `SecuritySeverity` enum. */
export type SecuritySeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Matches the `LifecycleDomain` enum. No BUSINESS member, by design. */
export type LifecycleDomain = 'INTEGRATION' | 'MODULE' | 'PROVISIONING';

/** Matches the `LifecyclePhase` enum. */
export type LifecyclePhase =
  | 'STARTED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'REFUSED'
  | 'TIMEOUT';

/**
 * The mandatory window plus paging, shared by every list query.
 *
 * `from` IS NOT OPTIONAL. See point 3 in the file header.
 */
export interface ObservabilityQuery {
  from: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * A page of results.
 *
 * NO `total`. The server does not compute one: `SELECT count(*)` over a multi-million-row
 * range costs as much as the page itself and is stale before it reaches the browser. `hasMore`
 * comes from fetching one extra row, so pagination controls have what they need without it.
 */
export interface ObservabilityPage<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
  range: { from: string; to: string };
}

/** One application log row. Note what is ABSENT: no body, no headers, no query string. */
export interface ApplicationLogRow {
  id: string;
  occurredAt: string;
  level: LogLevel;
  messageCode: string;
  message: string;
  source: string;
  service: string;
  environment: string;
  instanceRef: string | null;
  requestId: string | null;
  correlationId: string | null;
  traceId: string | null;
  spanId: string | null;
  userId: string | null;
  tenantId: string | null;
  httpMethod: string | null;
  /** The matched Nest route PATTERN (`/users/:id`), never a concrete URL. */
  route: string | null;
  statusCode: number | null;
  durationMs: number | null;
  moduleId: string | null;
  instanceId: string | null;
  deploymentMode: string | null;
  context: Record<string, unknown> | null;
  errorName: string | null;
  errorMessage: string | null;
  errorStack: string | null;
}

/** One audit event row from observability_db. NOT core_db."AuditLog", which is unchanged. */
export interface AuditEventRow {
  id: string;
  occurredAt: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorType: ActorType;
  actorId: string | null;
  actorRole: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  tenantId: string | null;
  requestId: string | null;
  correlationId: string | null;
  traceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Already redacted server-side by the same `redactPayload` the audit trail uses. */
  beforeValue: unknown;
  afterValue: unknown;
  changedFields: string[];
  moduleId: string | null;
  instanceId: string | null;
  durationMs: number | null;
}

/** One security event row. Requires `admin.security.read`, not `admin.observability.read`. */
export interface SecurityEventRow {
  id: string;
  occurredAt: string;
  eventType: string;
  severity: SecuritySeverity;
  succeeded: boolean;
  actorType: ActorType;
  actorId: string | null;
  /**
   * ALREADY MASKED. Masking happens before insert, so there is no unmasked copy anywhere —
   * the client is not trusted to hide it and does not have to remember to.
   */
  attemptedIdentifier: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  httpMethod: string | null;
  route: string | null;
  requiredPermission: string | null;
  tenantId: string | null;
  requestId: string | null;
  correlationId: string | null;
  traceId: string | null;
  moduleId: string | null;
  instanceId: string | null;
  reasonCode: string | null;
  detail: Record<string, unknown> | null;
}

/** One lifecycle event row: the interleaved platform timeline. */
export interface LifecycleEventRow {
  id: string;
  occurredAt: string;
  domain: LifecycleDomain;
  eventType: string;
  phase: LifecyclePhase;
  outcomeCode: string | null;
  subjectType: string;
  subjectId: string | null;
  subjectKey: string | null;
  moduleId: string | null;
  instanceId: string | null;
  requestId: string | null;
  correlationId: string | null;
  traceId: string | null;
  actorType: ActorType;
  actorId: string | null;
  tenantId: string | null;
  durationMs: number | null;
  attempt: number | null;
  detail: Record<string, unknown> | null;
}

/** One retention pass. `truncated` means the per-run chunk ceiling was reached. */
export interface RetentionRunRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  category: string;
  cutoff: string;
  deletedCount: number;
  truncated: boolean;
  succeeded: boolean;
  errorMessage: string | null;
  durationMs: number | null;
}

/** Server-owned filter vocabularies. Never duplicated client-side — see the file header. */
export interface ObservabilityVocabulary {
  levels: LogLevel[];
  sources: string[];
  messageCodes: string[];
  securityEventTypes: string[];
  securitySeverities: SecuritySeverity[];
  lifecycleDomains: LifecycleDomain[];
  lifecyclePhases: LifecyclePhase[];
}

/**
 * Platform health.
 *
 * `disabled` IS NOT A FAILURE, and the UI must not render it as one: an installation that
 * never set `OBSERVABILITY_ENABLED` is correctly configured for its choice. `degraded` means
 * rows were dropped under pressure — the droppable tier working as designed — while
 * `unhealthy` means the database is unreachable or a DURABLE audit write failed, which is the
 * one case where the trail has holes.
 */
export interface ObservabilityHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
  reason?: string;
  database?: { reachable: boolean; error: string | null };
  writer?: {
    queued: number;
    queueCapacity: number;
    queueUtilization: number;
    enqueued: number;
    written: number;
    dropped: number;
    failedBatches: number;
    rejectedUnknownCode: number;
    lastFlushAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    flushing: boolean;
  };
  durable?: Record<string, unknown>;
  config?: Record<string, unknown>;
  checkedAt?: string;
}

/** One provider-neutral metric sample. No Prometheus text format, no exporter dependency. */
export interface MetricSample {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

/**
 * Serialises a query object into a bounded query string. Drops empty values.
 *
 * Takes `object` rather than `Record<string, unknown>` so the typed query interfaces below can
 * be passed directly: an interface without an index signature is not assignable to a `Record`,
 * and widening each call site with a cast would defeat the point of having the types.
 */
function toQueryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `?${serialised}` : '';
}

export function getObservabilityVocabulary(): Promise<ObservabilityVocabulary> {
  return coreGet<ObservabilityVocabulary>('/admin/observability/vocabulary');
}

export function getObservabilityHealth(): Promise<ObservabilityHealth> {
  return coreGet<ObservabilityHealth>('/admin/observability/health');
}

export function getObservabilityMetrics(): Promise<{ samples: MetricSample[] }> {
  return coreGet<{ samples: MetricSample[] }>('/admin/observability/metrics');
}

export interface ApplicationLogQuery extends ObservabilityQuery {
  level?: LogLevel;
  minLevel?: LogLevel;
  source?: string;
  messageCode?: string;
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  route?: string;
  statusCode?: number;
  userId?: string;
  moduleId?: string;
}

export function listApplicationLogs(
  query: ApplicationLogQuery,
): Promise<ObservabilityPage<ApplicationLogRow>> {
  return coreGet<ObservabilityPage<ApplicationLogRow>>(
    `/admin/observability/logs${toQueryString(query)}`,
  );
}

export interface AuditEventQuery extends ObservabilityQuery {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  correlationId?: string;
}

export function listAuditEvents(query: AuditEventQuery): Promise<ObservabilityPage<AuditEventRow>> {
  return coreGet<ObservabilityPage<AuditEventRow>>(
    `/admin/observability/audit-events${toQueryString(query)}`,
  );
}

export interface SecurityEventQuery extends ObservabilityQuery {
  eventType?: string;
  severity?: SecuritySeverity;
  /**
   * STRING, not boolean, mirroring the DTO. A query string carries `"false"` and
   * `Boolean("false")` is `true` — an inversion that would hide every failed attempt in the
   * window, which is precisely the query this filter exists for.
   */
  succeeded?: 'true' | 'false';
  ipAddress?: string;
  actorId?: string;
}

export function listSecurityEvents(
  query: SecurityEventQuery,
): Promise<ObservabilityPage<SecurityEventRow>> {
  return coreGet<ObservabilityPage<SecurityEventRow>>(
    `/admin/observability/security-events${toQueryString(query)}`,
  );
}

export interface LifecycleEventQuery extends ObservabilityQuery {
  domain?: LifecycleDomain;
  phase?: LifecyclePhase;
  eventType?: string;
  subjectId?: string;
  correlationId?: string;
  moduleId?: string;
}

export function listLifecycleEvents(
  query: LifecycleEventQuery,
): Promise<ObservabilityPage<LifecycleEventRow>> {
  return coreGet<ObservabilityPage<LifecycleEventRow>>(
    `/admin/observability/lifecycle-events${toQueryString(query)}`,
  );
}

export function listRetentionRuns(): Promise<{ items: RetentionRunRow[] }> {
  return coreGet<{ items: RetentionRunRow[] }>('/admin/observability/retention-runs');
}
