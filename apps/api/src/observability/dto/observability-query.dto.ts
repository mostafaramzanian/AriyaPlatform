import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LOG_LEVELS, LOG_SOURCES, SECURITY_EVENT_TYPES, SECURITY_SEVERITIES } from '../observability.contract';
import { LIFECYCLE_DOMAINS, LIFECYCLE_PHASES } from '../observability.contract';

/**
 * Phase 49M-2: the read query contract.
 *
 * Modelled on `SearchQueryDto` (49J) and `TicketQueryDto`, including the reason the shape is
 * restrictive: the global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * any parameter not declared here is REJECTED rather than ignored.
 *
 * `from` IS MANDATORY, and that is the single most important decision in this file. These
 * tables are the largest in the installation by row count, and an unbounded
 * `SELECT ... ORDER BY "occurredAt" DESC LIMIT 50` over tens of millions of rows scans until
 * it finds them. Every §21 index leads with `occurredAt`, so a mandatory lower bound makes
 * every query an index range scan instead of a table scan. A convenience default of "last
 * 24h" was rejected: a caller who does not know the window they are querying does not know
 * the cost of their query either, and an admin dashboard silently pinning a CPU is worse
 * than a 400 that says what to send.
 *
 * THERE IS NO `tenantId` PARAMETER. Cross-tenant reads are what `admin.observability.read`
 * grants, and per-tenant filtering by an untrusted query parameter would let a caller
 * without that permission probe another tenant's activity if a future route ever relaxed the
 * gate. Tenant scoping, when it arrives, belongs to the guard and not to the query string.
 *
 * THERE IS NO FREE-TEXT `search` PARAMETER either. `ILIKE '%...%'` over a multi-million-row
 * table cannot use any of these indexes, so the one parameter an operator would most like
 * is the one that would make the endpoint a denial-of-service vector against itself.
 * Filtering is by indexed, enumerated columns only.
 */

/** Hard ceiling on page size, matching the bounded-list convention elsewhere in Core. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Widest queryable window.
 *
 * 92 DAYS, chosen against the retention windows rather than arbitrarily: it exceeds
 * LOG_RETENTION_DAYS (30) and LIFECYCLE_RETENTION_DAYS (90) so those categories can always
 * be queried in full, while stopping a single request from asking for the entire two-year
 * audit history in one scan. Older audit data is reachable by moving the window, not by
 * widening it.
 */
export const MAX_RANGE_DAYS = 92;

export class ObservabilityQueryDto {
  /** Inclusive lower bound on `occurredAt`. MANDATORY — see the class comment. */
  @IsDateString()
  from!: string;

  /** Exclusive upper bound. Defaults to now in the service, which is the common case. */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /**
   * Zero-based offset.
   *
   * OFFSET RATHER THAN A CURSOR, and unlike `SearchQueryDto` the reason is not a computed
   * score: these rows have a stable `(occurredAt DESC, id)` order, so a cursor is genuinely
   * possible and would be better at depth. It is offset here because the admin UI pages
   * shallowly within a narrow time window — an operator narrows the window rather than
   * walking 400 pages — and `MAX_OFFSET` bounds the damage. Documented so that a future
   * cursor is an upgrade, not a correction.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

/**
 * Application-log filters.
 *
 * EVERY FILTER MAPS TO AN INDEXED COLUMN — level, source, requestId, correlationId, traceId,
 * route, statusCode. That is the whole selection rule for what is filterable: a parameter
 * that cannot use an index is a parameter that turns a bounded query into a scan.
 */
export class ApplicationLogQueryDto extends ObservabilityQueryDto {
  @IsOptional()
  @IsIn(LOG_LEVELS as unknown as string[])
  level?: string;

  /**
   * Lower bound on severity rather than an exact match.
   *
   * `minLevel=WARN` is the query an operator actually wants — "show me everything that went
   * wrong" — and expressing it with `level` alone would need four repeated parameters.
   */
  @IsOptional()
  @IsIn(LOG_LEVELS as unknown as string[])
  minLevel?: string;

  @IsOptional()
  @IsIn(LOG_SOURCES as unknown as string[])
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  messageCode?: string;

  /**
   * The three correlation lookups. These are the reason this table exists: given a traceId
   * from an error response, return every line from that request across every service.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  traceId?: string;

  /** Exact match on the matched route PATTERN, e.g. `/users/:id`. Never a concrete URL. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  statusCode?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  moduleId?: string;
}

/** Audit-event filters. `action`/`resourceType` are the indexed pair. */
export class AuditEventQueryDto extends ObservabilityQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  resourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  resourceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @IsOptional()
  @IsIn(['SUCCESS', 'FAILURE', 'DENIED'])
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}

/** Security-event filters. Gated on `admin.security.read` as well as observability read. */
export class SecurityEventQueryDto extends ObservabilityQueryDto {
  @IsOptional()
  @IsIn(SECURITY_EVENT_TYPES as unknown as string[])
  eventType?: string;

  @IsOptional()
  @IsIn(SECURITY_SEVERITIES as unknown as string[])
  severity?: string;

  /**
   * `succeeded=false` is the incident query: every denied attempt in the window.
   *
   * Declared as a string with `IsIn` rather than `@IsBoolean()`, because a query string
   * carries `"false"` and `Boolean("false")` is `true` — a silent inversion that would make
   * the most security-relevant filter in this file return exactly the wrong rows.
   */
  @IsOptional()
  @IsIn(['true', 'false'])
  succeeded?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;
}

/** Lifecycle-event filters: the interleaved platform timeline. */
export class LifecycleEventQueryDto extends ObservabilityQueryDto {
  @IsOptional()
  @IsIn(LIFECYCLE_DOMAINS as unknown as string[])
  domain?: string;

  @IsOptional()
  @IsIn(LIFECYCLE_PHASES as unknown as string[])
  phase?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  subjectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  moduleId?: string;
}
