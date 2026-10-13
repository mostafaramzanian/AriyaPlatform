import { createHash } from 'node:crypto';

/**
 * Phase ARCH-3B (§3/§6/§12/§14): the `platform.audit@v1` PORT and its wire shape.
 *
 * WHY AN AUDIT PORT EXISTS AT ALL
 * -------------------------------
 * HR is an independently deployable module with its OWN database (`hr_db`), and it may run
 * in a process that has no Core database at all. Its mutations must still land in the ONE
 * platform audit trail (`core_db."AuditLog"`), so HR cannot write that table itself: it
 * depends on this INTERFACE and the runtime decides how it is satisfied. That is the same
 * direction of dependency `platform/auth/permission-source.contract.ts` (ARCH-3A) and
 * `platform/user-directory/user-directory.contract.ts` (50-MOD-CORR) already established, so
 * there is one port idiom in this codebase and not three.
 *
 * THE ONE BINDING DECISION WORTH WRITING DOWN
 * -------------------------------------------
 * `AuditService` (common/audit.service.ts) is NOT this port. It is the LEGACY producer: its
 * `auditId` is optional and generated when absent, and it still publishes to RabbitMQ on the
 * way out. The platform contract is the opposite on both counts — `auditId` is REQUIRED and
 * owned by the producer, `tenantId` is REQUIRED, and the row it writes is the TERMINAL record
 * of the event rather than the start of another hop. Folding the two together would either
 * weaken the contract (make the tenant optional) or reinterpret the retry ledger
 * `AuditDispatch` keys on `AuditLog.id` (§5). They therefore coexist: one table, two
 * producers, one of them legacy and explicitly labelled as such.
 */

/** The capability descriptor. A `@v2` is a new credential by construction (ADR-0006 A2). */
export const PLATFORM_AUDIT_CONTRACT = 'platform.audit@v1';

/**
 * DI token for the port. A string token, matching `USER_DIRECTORY` and the platform's
 * `@Inject('IStorageProvider')` convention rather than introducing a Symbol idiom.
 */
export const AUDIT_PORT = 'AuditPort';

/** The topic exchange the platform already publishes audit traffic to (NotificationPublisher). */
export const AUDIT_EXCHANGE = 'domain_events';

/** The consumer-owned queue name (§12). */
export const AUDIT_INGEST_QUEUE = 'platform.audit.ingest';

/**
 * The binding (§12). `audit.#` receives BOTH families of traffic on this exchange:
 *   * platform events, routing key `audit.<resource>.<action>`, carrying
 *     `contract: 'platform.audit@v1'` — these are ingested;
 *   * LEGACY events the unchanged `AuditService` publishes on the same prefix — these carry no
 *     `contract` and are REJECTED (`AUDIT_CONTRACT_MISMATCH`) rather than ingested, which is
 *     what stops the consumer from writing a second row for an event that already has one.
 */
export const AUDIT_BINDING_PATTERN = 'audit.#';

/** Routing-key prefix for a platform event. Kept equal to the legacy prefix on purpose. */
export const AUDIT_TOPIC_PREFIX = 'audit.';

export const MAX_AUDIT_ID_LENGTH = 64;
export const MAX_AUDIT_FIELD_LENGTH = 64;

/**
 * Why a value was not accepted as an audit event.
 *
 * A closed set, and each member is a DIFFERENT operator action: a contract mismatch means
 * "something else is publishing on this binding", a missing tenant means a producer is
 * broken, an invalid id means a producer is inventing identities. Collapsing them into one
 * "invalid" code would make the log line useless at the moment it is needed.
 */
export type AuditRejectionCode =
  | 'AUDIT_ENVELOPE_INVALID'
  | 'AUDIT_CONTRACT_MISMATCH'
  | 'AUDIT_ID_MISSING'
  | 'AUDIT_ID_INVALID'
  | 'AUDIT_TENANT_MISSING'
  | 'AUDIT_ACTION_MISSING'
  | 'AUDIT_RESOURCE_MISSING'
  | 'AUDIT_RESOURCE_ID_MISSING'
  | 'AUDIT_WRITE_FAILED';
/**
 * One audit event, as a PRODUCER supplies it.
 *
 * `tenantId` IS REQUIRED HERE and that is the whole of §3's tenancy rule: the absence of a
 * tenant cannot be expressed, so it cannot be produced by the new write path. The legacy rows
 * whose `tenantId` is NULL are therefore provably historical (Decision A) rather than merely
 * plausible: at the baseline of ARCH-3B, `SELECT count(*), count(*) FILTER (WHERE "tenantId"
 * IS NULL) FROM "AuditLog"` returned 36,489 and 36,489 — every existing row, and not one of
 * them producible by anything in this folder. The number is recorded so that a later reader can
 * re-run the query and see the split move, which is the only way this claim can go stale.
 *
 * `auditId` IS REQUIRED and caller-generated. It is the identity a producer can REPEAT, which
 * is what makes ingest idempotent: a re-delivered event is recognised by its id and its
 * payload compared, rather than duplicated.
 */
export interface AuditEventInput {
  /** Producer-owned, unique per LOGICAL event. Never derived from `requestId` (§3). */
  auditId: string;
  /** The tenant this event belongs to. Mandatory; there is no "tenant-less" platform event. */
  tenantId: string;
  /** Correlation/context only. MANY events may share one request id. */
  requestId?: string;
  correlationId?: string;
  /** The Core identity that acted; null for a machine context. */
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId: string;
  /** Producer clock, informational. Deliberately NOT part of the idempotency digest. */
  occurredAt?: string;
  success?: boolean;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  durationMs?: number | null;
  changedFields?: string[];
  oldValue?: unknown;
  newValue?: unknown;
}

/** What actually travels on the exchange: the input plus the capability descriptor. */
export type AuditEvent = AuditEventInput & { contract: string };

/**
 * The outcome of a write attempt, kept as a DISCRIMINATED result rather than a boolean
 * because the three failures have three different remedies.
 *
 * `duplicate` is a SUCCESS: the trail already holds this logical event.
 * `conflict` is an ALARM: the same `auditId` arrived with a different payload, which either
 * means a producer re-used an identity or someone is trying to overwrite history. Nothing is
 * written in that case — an audit row is never updated.
 */
export type AuditRecordStatus = 'recorded' | 'duplicate' | 'conflict' | 'rejected';

export interface AuditRecordResult {
  status: AuditRecordStatus;
  auditId: string;
  /** `AuditLog.id` of the row that holds the event; null when nothing was written. */
  auditLogId: string | null;
  /** Only on `rejected`. */
  code?: AuditRejectionCode;
}

/**
 * PHASE P-AUDIT-READ (§5/§8/§10/§11/§13/§22): the READ half of the platform audit contract.
 *
 * WHY THE READ IS ON THIS PORT
 * ----------------------------
 * A bounded context that WRITES through `AUDIT_PORT` must not reach `core_db."AuditLog"` to read
 * it back: that cross-database coupling is exactly what ARCH-3B removed for writes and what the
 * isolation suites forbid. The read therefore rides the SAME port, satisfied by the SAME Core
 * binding (`PlatformAuditService`), so "one audit boundary" stays true in both directions. It is
 * ADDITIVE: `record` is unchanged, and every existing writer works without knowing it exists.
 *
 * WHY THE QUERY IS A CLOSED SHAPE AND NOT A QUERY LANGUAGE (§5/§8)
 * ----------------------------------------------------------------
 * One request describes exactly ONE bounded audit query:
 *   * `tenantId` is REQUIRED and is supplied by the caller's TRUSTED context — the same rule the
 *     write side applies to `AuditEventInput.tenantId` — never by a client, header or body;
 *   * `resource` + `resourceId` are REQUIRED: the platform's confirmed use case is "the audit
 *     events of a known bounded resource", and they are the leading columns of
 *     `@@index([resourceType, resourceId])`, so every query is index-backed and its result (and
 *     COUNT) is bounded by ONE resource — never by the trail as a whole;
 *   * `action` and `from`/`to` are optional exact/range narrowers over stored columns;
 *   * `page`/`pageSize` follow the platform's list convention (default 20, ceiling 100).
 * There is no free text, no metadata or JSON predicate, no ORDER BY parameter, no projection
 * parameter and no SQL. `resourceId` without `resource` cannot be expressed, so a read can never
 * span unrelated resource types by accident.
 *
 * WHAT THE RESULT MAY CONTAIN (§13/§14/§15)
 * -----------------------------------------
 * `AuditReadItem` is a least-privilege projection — resource, resourceId, action, actor id,
 * outcome, reason, changed field NAMES and the stored write instant — and NOT the row:
 * `tenantId` is never echoed (the scope does not belong in data), and `ipAddress`, `userAgent`,
 * `sessionId`, `oldValue`, `newValue`, `changes`, `requestId` and `correlationId` are absent by
 * construction. The implementation does not even SELECT them, so "redacted on write" is never
 * trusted to make a payload safe for a reader. Any future need for one of them is a contract
 * decision, not a flag.
 *
 * ORDERING, CONSISTENCY AND ERRORS (§11/§12/§22)
 * ----------------------------------------------
 * `createdAt` is the only chronology the trail persists (`occurredAt` is a producer clock with no
 * column), so the order is `createdAt ASC, id ASC`: chronological for a timeline, TOTAL because
 * `id` breaks ties, and stable under appends — new events land after the pages already read.
 * The read mirrors `record`'s error shape: it returns a discriminated result and never throws, so
 * the port has ONE error idiom. `ok` carries the page; `rejected` carries a closed code — a
 * caller fault, or storage refusing (`AUDIT_READ_FAILED`).
 */

/** Bounds on one read: the platform list convention (default 20, ceiling 100). */
export const AUDIT_READ_DEFAULT_PAGE_SIZE = 20;
export const AUDIT_READ_MAX_PAGE_SIZE = 100;

/** One bounded read request. `tenantId` comes from the caller's trusted context, never a client. */
export interface AuditReadQuery {
  /** The tenant whose trail is read. Required; absence is a REJECTION, never a wider read. */
  tenantId: string;
  /** The resource TYPE the events belong to, e.g. `commerce.purchase_document`. Required. */
  resource: string;
  /** The resource instance. Required — see the section comment for why it is not optional. */
  resourceId: string;
  /** Exact action match. Optional. */
  action?: string;
  /** Inclusive lower bound on `AuditLog.createdAt`, ISO-8601. Optional. */
  from?: string;
  /** Exclusive upper bound on `AuditLog.createdAt`, ISO-8601. Optional. */
  to?: string;
  /** 1-based page. Defaults to 1. */
  page?: number;
  /** Page size, 1..`AUDIT_READ_MAX_PAGE_SIZE`. Defaults to `AUDIT_READ_DEFAULT_PAGE_SIZE`. */
  pageSize?: number;
}

/** The query AFTER validation: defaults resolved, every field a value the repository can use. */
export interface NormalizedAuditReadQuery {
  tenantId: string;
  resource: string;
  resourceId: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/**
 * The safe projection of ONE audit event. See the section comment for the exclusion list.
 *
 * `createdAt` is an ISO-8601 STRING, not a `Date`, so the item is a value object a consumer can
 * hold, compare and — in a future transport — serialise, with no mutable clock behind it. It is
 * the STORED WRITE INSTANT, not a claimed event time; the trail has no column for the producer
 * clock (`occurredAt`).
 */
export interface AuditReadItem {
  /** `AuditLog.id` — the row identity a write's `AuditRecordResult.auditLogId` refers to. */
  id: string;
  /** `AuditLog.resourceType`, under the port's own vocabulary (`AuditEventInput.resource`). */
  resource: string;
  resourceId: string;
  action: string;
  /** `AuditLog.userId`, under the port's vocabulary (`AuditEventInput.actorId`). */
  actorId: string | null;
  success: boolean;
  reason: string | null;
  /** NAMES of the changed fields — never their values. */
  changedFields: string[];
  /** ISO-8601 of `AuditLog.createdAt`: when the ROW was written, not a business event time. */
  createdAt: string;
}

/** One bounded page: the `{ items, page, pageSize, total }` shape the module lists already use. */
export interface AuditReadPage {
  items: AuditReadItem[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Why a read was refused. A CLOSED set, and each member is a different caller fault or outage:
 * a malformed envelope, a lost tenant (the gravest), a resource question that cannot be asked,
 * an out-of-contract page, an unusable window, or storage itself failing.
 */
export type AuditReadRejectionCode =
  | 'AUDIT_READ_QUERY_INVALID'
  | 'AUDIT_READ_TENANT_MISSING'
  | 'AUDIT_READ_RESOURCE_MISSING'
  | 'AUDIT_READ_RESOURCE_ID_MISSING'
  | 'AUDIT_READ_PAGE_INVALID'
  | 'AUDIT_READ_RANGE_INVALID'
  | 'AUDIT_READ_FAILED';

/**
 * The outcome of one read, as a discriminated union rather than a thrown error: the port has ONE
 * error idiom (`record` reports, never throws), and a consumer must decide explicitly what a
 * refusal means for its own surface — which is the consumer's decision, not the platform's.
 */
export type AuditReadResult =
  | { status: 'ok'; page: AuditReadPage }
  | { status: 'rejected'; code: AuditReadRejectionCode };

/** The validator's outcome: a query ready for the repository, or the first fault found. */
export type AuditReadValidation =
  | { ok: true; query: NormalizedAuditReadQuery }
  | { ok: false; code: AuditReadRejectionCode };

/** An ISO-8601 instant the range bounds accept. `Date.parse` is the only parser used. */
function isReadInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** A positive integer. The page-size caller owns the ceiling; `page` has none of its own. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Validates a read request. THE ONE PLACE THE READ CONTRACT IS ENFORCED — the binding and every
 * contract-driven test fake call this function, so "the tenant is required" and "a page cannot
 * exceed the ceiling" are one implementation instead of a rule each caller remembers.
 *
 * The checks run from the gravest fault outwards, matching `validateAuditEvent`, so the returned
 * code names the FIRST thing wrong: an envelope that is not an object, then the tenant, then the
 * resource question, then the optional narrowers, then paging.
 */
export function validateAuditReadQuery(value: unknown): AuditReadValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'AUDIT_READ_QUERY_INVALID' };
  }

  const candidate = value as Record<string, unknown>;
  const tenantId = candidate.tenantId;
  const resource = candidate.resource;
  const resourceId = candidate.resourceId;
  const action = candidate.action ?? undefined;
  const from = candidate.from ?? undefined;
  const to = candidate.to ?? undefined;
  const page = candidate.page ?? 1;
  const pageSize = candidate.pageSize ?? AUDIT_READ_DEFAULT_PAGE_SIZE;

  if (!isField(tenantId)) return { ok: false, code: 'AUDIT_READ_TENANT_MISSING' };
  if (!isField(resource)) return { ok: false, code: 'AUDIT_READ_RESOURCE_MISSING' };
  if (!isField(resourceId)) return { ok: false, code: 'AUDIT_READ_RESOURCE_ID_MISSING' };

  if (action !== undefined && !isField(action)) {
    return { ok: false, code: 'AUDIT_READ_QUERY_INVALID' };
  }

  if (from !== undefined && !isReadInstant(from)) {
    return { ok: false, code: 'AUDIT_READ_RANGE_INVALID' };
  }

  if (to !== undefined && !isReadInstant(to)) {
    return { ok: false, code: 'AUDIT_READ_RANGE_INVALID' };
  }

  if (from !== undefined && to !== undefined && !(Date.parse(from) < Date.parse(to))) {
    return { ok: false, code: 'AUDIT_READ_RANGE_INVALID' };
  }

  if (!isPositiveInteger(page)) return { ok: false, code: 'AUDIT_READ_PAGE_INVALID' };

  if (!isPositiveInteger(pageSize) || pageSize > AUDIT_READ_MAX_PAGE_SIZE) {
    return { ok: false, code: 'AUDIT_READ_PAGE_INVALID' };
  }

  return {
    ok: true,
    query: {
      tenantId,
      resource,
      resourceId,
      ...(action === undefined ? {} : { action }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      page,
      pageSize,
    },
  };
}

/**
 * What a module is allowed to do against the ONE platform audit trail: hand the platform ONE
 * event (`record`), and ask a bounded, tenant-scoped question about events already recorded
 * (`read`, Phase P-AUDIT-READ). Nothing else — no update, no delete, no export, no search.
 *
 * `record` NEVER THROWS, for the reason the legacy service documents: an audit write failing
 * must not turn a completed business mutation into a 500. A rejection is REPORTED
 * (`status: 'rejected'`) so the caller can log it, not raised.
 *
 * `read` follows the same rule for the opposite direction: it VALIDATES, queries through the
 * Core binding and RETURNS its outcome — `ok` with the bounded page, or `rejected` with a closed
 * code. It never returns a database row, never accepts a caller-built predicate, and never widens
 * past the tenant it was given.
 */
export interface AuditPort {
  record(event: AuditEventInput): Promise<AuditRecordResult>;
  read(query: AuditReadQuery): Promise<AuditReadResult>;
}

/** UUID, the identity shape the platform issues and the consumer accepts. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAuditId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUDIT_ID_LENGTH &&
    UUID_PATTERN.test(value)
  );
}

function isField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUDIT_FIELD_LENGTH &&
    // No control characters: these values become a routing key and a log line, so the class is the
    // POINT of the check rather than an accident. The rule is waived here, with the reason, because a
    // reviewer reading only the diff should see why.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export type AuditValidation =
  { ok: true; event: AuditEvent } | { ok: false; code: AuditRejectionCode };

/**
 * Validates an arriving value as a `platform.audit@v1` event.
 *
 * THE ONE PLACE THE CONTRACT IS ENFORCED. Both writers use it — the in-process port binding
 * and the queue consumer — so "the tenant is required" is one implementation with one test
 * rather than a rule each entry point is trusted to remember.
 *
 * The checks are ordered from "this is not even an envelope" outwards, so the code returned
 * names the FIRST thing wrong rather than the last.
 */
export function validateAuditEvent(value: unknown): AuditValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'AUDIT_ENVELOPE_INVALID' };
  }

  const candidate = value as Record<string, unknown>;

  if (candidate.contract !== PLATFORM_AUDIT_CONTRACT) {
    return { ok: false, code: 'AUDIT_CONTRACT_MISMATCH' };
  }

  if (candidate.auditId === undefined || candidate.auditId === null) {
    return { ok: false, code: 'AUDIT_ID_MISSING' };
  }

  if (!isAuditId(candidate.auditId)) {
    return { ok: false, code: 'AUDIT_ID_INVALID' };
  }

  if (candidate.tenantId === undefined || candidate.tenantId === null) {
    return { ok: false, code: 'AUDIT_TENANT_MISSING' };
  }

  if (!isField(candidate.tenantId)) {
    return { ok: false, code: 'AUDIT_TENANT_MISSING' };
  }

  if (!isField(candidate.action)) {
    return { ok: false, code: 'AUDIT_ACTION_MISSING' };
  }

  if (!isField(candidate.resource)) {
    return { ok: false, code: 'AUDIT_RESOURCE_MISSING' };
  }

  if (!isField(candidate.resourceId)) {
    return { ok: false, code: 'AUDIT_RESOURCE_ID_MISSING' };
  }

  return { ok: true, event: candidate as unknown as AuditEvent };
}

/**
 * The fields compared to decide whether two arrivals are the SAME logical event.
 *
 * These — and only these — are what `AuditLog` can prove about an event after the fact.
 * `occurredAt` is excluded because the trail has no column for it: a retry that re-serialises
 * with a fresh clock is still the same event, and treating it as a conflict would turn an
 * at-least-once delivery guarantee into duplicate alarms.
 */
export interface AuditDigestSubject {
  auditId: string;
  tenantId: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId: string;
  success?: boolean;
  reason?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
  changedFields?: string[] | null;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * A JSON rendering in which key ORDER cannot matter.
 *
 * `AuditLog."oldValue"` is `jsonb`, and `jsonb` does not preserve key order — so a byte
 * comparison would report "different payload" for two spellings of the same object, and the
 * idempotency check would produce conflicts at random. Order is therefore removed rather than
 * relied upon.
 *
 * `undefined` AND `null` ARE NOT THE SAME RENDERING, and the difference is deliberate: a
 * top-level `undefined` is `'null'` like a top-level `null`, but inside an object an
 * `undefined`-valued key is DROPPED while an explicit `null` is KEPT. "The caller never said"
 * and "the caller said: no value" are different statements, and only one of them is a value.
 * What makes an omitted optional field compare equal to an explicitly null one is therefore
 * NOT this function but the WRITER's normalisation (the module-level `redactedSubject` in
 * `platform-audit.service.ts` maps every absent optional field to the value that will be
 * stored), so the subject that is
 * digested is always the subject the row will contain. Trimming, coercion or defaulting here
 * would undo that, because the two sides of the comparison are rendered by this one function.
 */
export function canonicalAuditJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalAuditJson).join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    // Anything that is not a plain object — a Prisma sentinel, a Date, a class instance — has
    // no row-level meaning in this comparison, so it is normalised rather than stringified in
    // whatever form its `toString` happens to take.
    if (prototype !== Object.prototype && prototype !== null) return 'null';

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const body = entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalAuditJson(nested)}`)
      .join(',');

    return `{${body}}`;
  }

  return JSON.stringify(value) as string;
}

/**
 * SHA-256 over the canonical rendering of a subject.
 *
 * A DIGEST rather than a stored column: the comparison is always between an arriving event and
 * a row that is already there, so it can be computed on both sides and nothing new needs to be
 * persisted. `id` and `createdAt` are absent from `AuditDigestSubject` by construction, which
 * is how the database-generated fields stay out of the comparison (§14).
 */
export function auditEventDigest(subject: AuditDigestSubject): string {
  return createHash('sha256').update(canonicalAuditJson(subject)).digest('hex');
}

/** The routing key a producer publishes a platform event on. Mirrors the legacy prefix. */
export function auditRoutingKey(event: Pick<AuditEventInput, 'resource' | 'action'>): string {
  return `${AUDIT_TOPIC_PREFIX}${event.resource}.${event.action}`.toLowerCase();
}

/**
 * Stamps the capability descriptor, i.e. turns a producer's input into a wire event.
 *
 * `contract` is written LAST, after the caller's own fields are spread in, so a caller cannot
 * smuggle a different descriptor through an object literal and have the value validated as a
 * platform event. Without that order the validator below would be checking a value nobody had
 * to agree with the transport about.
 */
export function toAuditEnvelope(input: AuditEventInput): AuditEvent {
  return { ...input, contract: PLATFORM_AUDIT_CONTRACT };
}

/**
 * The JSON vocabulary an `AuditOutbox.payload` row accepts — a STRUCTURAL
 * mirror of Prisma's generated `InputJsonValue` (string | number | boolean |
 * InputJsonObject | InputJsonArray …), declared here so a domain's audit
 * GATEWAY can type its outbox payload without importing a generated client.
 *
 * Each domain's isolation suite allows exactly one file (its Prisma service,
 * plus its repositories where the suite says so) to name `generated/*-client`;
 * a gateway importing one is a boundary violation even as a type-only import.
 * Because TypeScript types are structural, a value of this union remains
 * assignable to `Prisma.InputJsonValue` at the repository boundary — the
 * generated client never has to be named here.
 */
export type AuditOutboxJsonValue =
  | string
  | number
  | boolean
  | ReadonlyArray<AuditOutboxJsonValue | null>
  | { readonly [key: string]: AuditOutboxJsonValue | null | undefined };
