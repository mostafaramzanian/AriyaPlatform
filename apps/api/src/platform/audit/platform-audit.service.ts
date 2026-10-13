import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { redactPayload } from '../../common/audit-redactor.util';
import {
  auditEventDigest,
  toAuditEnvelope,
  validateAuditEvent,
  validateAuditReadQuery,
  type AuditDigestSubject,
  type AuditEventInput,
  type AuditPort,
  type AuditReadItem,
  type AuditReadQuery,
  type AuditReadResult,
  type AuditRecordResult,
} from './audit.contract';

/**
 * Phase ARCH-3B (§3/§6/§14): the CORE binding of the audit port.
 *
 * THIS CLASS IS THE ONLY WRITER OF A NEW-STYLE AUDIT ROW. `AUDIT_PORT` is bound to it in
 * `PlatformAuditModule`, so a module that injects the port receives exactly this
 * implementation and cannot reach the legacy `AuditService`, its optional `auditId`, or
 * Core's Prisma client.
 *
 * PHASE P-AUDIT-READ adds the other half: `read` is the ONLY read path over the trail a bounded
 * context may use. It is tenant-scoped, index-backed, deterministically ordered, bounded by page
 * size, and it SELECTS a least-privilege projection so a sensitive column never leaves the
 * database even if the mapping changed. The phase contract is
 * docs/PHASE-P-AUDIT-READ-CONTRACT.md.
 *
 * WHY IT DUPLICATES *SOME* OF `AuditService` RATHER THAN DELEGATING TO IT
 * ---------------------------------------------------------------------
 * The three things it re-uses are imported, not copied: the redactor, the table, the
 * PrismaService. What it does NOT re-use is `AuditService`'s control flow, because that control
 * flow cannot express this contract: `AuditService` GENERATES an `auditId` when none is given
 * (the platform contract requires the producer's own), treats a unique violation as
 * "return the existing row" and then DISCARDS the fact (the platform contract must distinguish
 * a replay from a conflict), and PUBLISHES the row it just wrote (a `platform.audit@v1` row is
 * the terminal record — republishing it would have the consumer ingest its own output and
 * double the trail). Delegating would have meant adding three flags to a class six other
 * producers depend on, which is a larger change than this class.
 *
 * THE COMPARISON THAT MAKES INGEST IDEMPOTENT (§14)
 * ------------------------------------------------
 * Before writing, the row for `auditId` is read. If it exists:
 *   * SAME digest  → `duplicate`. Nothing is written; the trail already holds the event, which
 *     is a SUCCESS for an at-least-once delivery.
 *   * OTHER digest → `conflict`. Nothing is written and the mismatch is logged as an error. An
 *     audit row is never UPDATED: history is append-only, so a second arrival of one identity
 *     with different content is an alarm, not an upsert.
 * The digest is computed over the fields `AuditLog` can prove (see `AuditDigestSubject`) on
 * BOTH sides — the arriving event and the stored row — so no new column is needed and no
 * comparison depends on key order or on the database-generated `id`/`createdAt`.
 *
 * IT NEVER THROWS. A completed business mutation must not become a 500 because its audit row
 * could not be written; a rejection is RETURNED so the caller can log it.
 */
@Injectable()
export class PlatformAuditService implements AuditPort {
  private readonly logger = new Logger(PlatformAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes (or recognises) one logical event.
   *
   * The arriving input is re-validated through the SAME `validateAuditEvent` the queue consumer
   * uses, after stamping the capability descriptor — so an in-process caller that omits the
   * tenant is rejected by the identical code path, with the identical code, as a remote one.
   */
  async record(input: AuditEventInput): Promise<AuditRecordResult> {
    const validation = validateAuditEvent(toAuditEnvelope(input));

    if (!validation.ok) {
      this.logger.error(
        { code: validation.code, auditId: input?.auditId, stage: 'record.rejected' },
        'Rejected an audit event that does not satisfy platform.audit@v1'
      );
      return {
        status: 'rejected',
        auditId: typeof input?.auditId === 'string' ? input.auditId : '',
        auditLogId: null,
        code: validation.code,
      };
    }

    const event = validation.event;
    const subject = redactedSubject(event);
    const digest = auditEventDigest(subject);

    try {
      const existing = await this.prisma.auditLog.findUnique({
        where: { auditId: event.auditId },
      });

      if (existing) {
        return this.classify(existing, subject, digest);
      }

      const row = await this.prisma.auditLog.create({
        data: {
          auditId: event.auditId,
          tenantId: event.tenantId,
          requestId: subject.requestId ?? '',
          correlationId: subject.correlationId ?? undefined,
          userId: subject.actorId ?? undefined,
          ipAddress: subject.ip ?? undefined,
          userAgent: subject.userAgent ?? undefined,
          sessionId: subject.sessionId ?? undefined,
          action: subject.action,
          resourceType: subject.resource,
          resourceId: subject.resourceId,
          oldValue: subject.oldValue ?? undefined,
          newValue: subject.newValue ?? undefined,
          changedFields: subject.changedFields ?? [],
          success: subject.success ?? true,
          reason: subject.reason ?? undefined,
          durationMs: subject.durationMs ?? undefined,
        },
      });

      return { status: 'recorded', auditId: event.auditId, auditLogId: row.id };
    } catch (err) {
      // A concurrent writer inserted the same `auditId` between the read and the write. That is
      // not an error: re-read and classify, exactly as the non-racing path does.
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await this.prisma.auditLog
          .findUnique({ where: { auditId: event.auditId } })
          .catch(() => null);

        if (raced) return this.classify(raced, subject, digest);
      }

      this.logger.error(
        { err, auditId: event.auditId, tenantId: event.tenantId },
        'Failed to persist a platform audit event'
      );

      return {
        status: 'rejected',
        auditId: event.auditId,
        auditLogId: null,
        code: 'AUDIT_WRITE_FAILED',
      };
    }
  }

  /**
   * PHASE P-AUDIT-READ: one bounded, tenant-scoped page of ONE resource's audit events.
   *
   * WHAT IT DOES, IN ORDER (and why each step is where it is)
   * --------------------------------------------------------
   *  1. VALIDATES through `validateAuditReadQuery` BEFORE any database work. A query that is not
   *     the closed shape is `rejected` and NOTHING is read — a missing tenant fails closed rather
   *     than becoming a wider query.
   *  2. QUERIES with a WHERE that always carries the tenant FIRST. `resourceType`/`resourceId`
   *     are required by the contract, so the predicate leads with `@@index([resourceType,
   *     resourceId])` and the tenant narrows rows WITHIN one resource instead of scanning the
   *     trail. `tenantId = <string>` also makes the legacy tenant-less rows unreachable, which is
   *     the correct outcome: they are historical, not any tenant's.
   *  3. SELECTS only the safe projection, so `ipAddress`, `userAgent`, `sessionId`, `oldValue`,
   *     `newValue`, `changes`, `requestId`, `correlationId` (and `tenantId` itself) are never
   *     loaded. "Redacted on write" is not trusted to make a payload safe for a reader.
   *  4. ORDERS by `(createdAt ASC, id ASC)` — the only chronology the trail persists, made TOTAL
   *     by the `id` tie-break, so two events sharing a millisecond cannot make a page duplicate
   *     or lose a row. Ascending also keeps earlier pages stable while new events append.
   *  5. READS the page and its COUNT in ONE array-form transaction, so `total` describes the same
   *     instant as `items` — the shape the module lists (`{ items, page, pageSize, total }`)
   *     already established. The COUNT is bounded by the same resource-scoped predicate.
   *
   * IT NEVER THROWS, like `record`: an outage is REPORTED as `AUDIT_READ_FAILED` so the port
   * keeps one error idiom and the consumer decides what a failed read means for its own surface.
   */
  async read(input: AuditReadQuery): Promise<AuditReadResult> {
    const validation = validateAuditReadQuery(input);

    if (!validation.ok) {
      this.logger.error(
        { code: validation.code, stage: 'read.rejected' },
        'Rejected a read that does not satisfy the platform audit read contract'
      );

      return { status: 'rejected', code: validation.code };
    }

    const query = validation.query;
    const createdAt = readRange(query.from, query.to);

    // The tenant is the FIRST predicate and is never optional: it comes from the caller's trusted
    // context, and there is no branch in which this WHERE is tenant-less.
    const where = {
      tenantId: query.tenantId,
      resourceType: query.resource,
      resourceId: query.resourceId,
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };

    try {
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: SAFE_AUDIT_SELECT,
        }),
        this.prisma.auditLog.count({ where }),
      ]);

      return {
        status: 'ok',
        page: {
          items: rows.map(toReadItem),
          page: query.page,
          pageSize: query.pageSize,
          total,
        },
      };
    } catch (err) {
      this.logger.error(
        {
          err,
          tenantId: query.tenantId,
          resource: query.resource,
          resourceId: query.resourceId,
          stage: 'read.failed',
        },
        'Failed to read the platform audit trail'
      );

      return { status: 'rejected', code: 'AUDIT_READ_FAILED' };
    }
  }

  /**
   * Decides what an ALREADY PRESENT row means for this arrival (§14).
   *
   * Split out because three paths reach it — the found-before-write path, the raced path, and
   * (via the same comparison) the spec — and a second copy of the digest comparison is how one
   * of them eventually compares something slightly different.
   */
  private classify(
    existing: StoredAuditRow,
    subject: AuditDigestSubject,
    digest: string
  ): AuditRecordResult {
    const storedDigest = auditEventDigest(storedSubject(existing, subject.auditId));

    if (storedDigest === digest) {
      this.logger.warn(
        { auditId: subject.auditId, auditLogId: existing.id, stage: 'record.duplicate' },
        'Audit event already recorded; this arrival is a replay'
      );

      return { status: 'duplicate', auditId: subject.auditId, auditLogId: existing.id };
    }

    // The alarms an operator must see: one identity, two different events.
    this.logger.error(
      {
        auditId: subject.auditId,
        auditLogId: existing.id,
        incomingTenant: subject.tenantId,
        storedTenant: existing.tenantId,
        incomingAction: `${subject.resource}.${subject.action}`,
        storedAction: `${existing.resourceType}.${existing.action}`,
        stage: 'record.conflict',
      },
      'auditId already exists with a different payload; refusing to overwrite an audit row'
    );

    return { status: 'conflict', auditId: subject.auditId, auditLogId: existing.id };
  }
}

/**
 * The columns this class reads back. Declared structurally rather than imported from the
 * generated client so the comparison cannot silently start depending on a column that is not
 * part of `AuditDigestSubject`.
 */
interface StoredAuditRow {
  id: string;
  tenantId: string | null;
  requestId: string;
  correlationId: string | null;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  sessionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  success: boolean;
  reason: string | null;
  durationMs: number | null;
  changedFields: string[];
  oldValue: unknown;
  newValue: unknown;
}

/**
 * The redacted, normalised view of an arriving event.
 *
 * TWO JOBS, AND BOTH MATTER FOR IDEMPOTENCY:
 *   1. REDACTION — the same `redactPayload` the legacy service uses, so a password or an email
 *      mask is applied once per trail rather than once per producer;
 *   2. NORMALISATION — every optional field gets the value that will actually be STORED, so the
 *      digest of the event equals the digest of the row it produces. Comparing "the event as
 *      sent" with "the row as stored" would otherwise report a conflict for every event that
 *      simply omitted an optional field.
 */
function redactedSubject(event: AuditEventInput): AuditDigestSubject {
  let oldValue: unknown = null;
  let newValue: unknown = null;

  if (event.oldValue !== undefined && event.oldValue !== null) {
    oldValue = redactPayload(event.oldValue, { emailMask: true, phoneMask: true }).redacted;
  }

  if (event.newValue !== undefined && event.newValue !== null) {
    newValue = redactPayload(event.newValue, { emailMask: true, phoneMask: true }).redacted;
  }

  return {
    auditId: event.auditId,
    tenantId: event.tenantId,
    // `AuditLog."requestId"` is NOT NULL for historical reasons (it used to carry the unique
    // constraint). An event with no request context stores the empty string, which no legacy
    // producer ever writes — the legacy service always passes a non-empty id — so "absent" is
    // distinguishable from "this request" without inventing a placeholder that looks real.
    requestId: event.requestId ?? '',
    correlationId: event.correlationId ?? null,
    actorId: event.actorId ?? null,
    action: event.action,
    resource: event.resource,
    resourceId: event.resourceId,
    success: event.success ?? true,
    reason: event.reason ?? null,
    sessionId: event.sessionId ?? null,
    ip: event.ip ?? null,
    userAgent: event.userAgent ?? null,
    durationMs: event.durationMs ?? null,
    changedFields: event.changedFields ?? [],
    oldValue,
    newValue,
  };
}

/**
 * The stored row as a digest subject.
 *
 * `resourceType`/`userId`/`ipAddress` are the table's names for `resource`/`actorId`/`ip`; the
 * mapping is here, in one place, so the two renderings of one event cannot drift apart.
 *
 * `auditId` is taken from the CALLER rather than from the row: the arriving event is the
 * authority on the identity being compared — the row is looked up BY that identity — and
 * hard-coding it here once made every replay compare `'<id>'` against `''`.
 */
function storedSubject(row: StoredAuditRow, auditId: string): AuditDigestSubject {
  return {
    auditId,
    tenantId: row.tenantId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    actorId: row.userId,
    action: row.action,
    resource: row.resourceType,
    resourceId: row.resourceId,
    success: row.success,
    reason: row.reason,
    sessionId: row.sessionId,
    ip: row.ipAddress,
    userAgent: row.userAgent,
    durationMs: row.durationMs,
    changedFields: row.changedFields ?? [],
    oldValue: row.oldValue ?? null,
    newValue: row.newValue ?? null,
  };
}

/**
 * The columns a read is allowed to LOAD — the projection's whitelist at the DATABASE level.
 *
 * Declared structurally like `StoredAuditRow`, and deliberately not derived from "every column
 * minus the sensitive ones": a future column added to `AuditLog` is NOT readable through this
 * port until the read contract names it, so the default for new columns is "not exposed" rather
 * than "exposed until someone remembers to exclude it" (§13/§15).
 */
const SAFE_AUDIT_SELECT = {
  id: true,
  resourceType: true,
  resourceId: true,
  action: true,
  userId: true,
  success: true,
  reason: true,
  changedFields: true,
  createdAt: true,
} as const;

/** The shape `SAFE_AUDIT_SELECT` produces. Structural, like `StoredAuditRow` above. */
interface SafeAuditRow {
  id: string;
  resourceType: string;
  resourceId: string;
  action: string;
  userId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: Date;
}

/**
 * The `createdAt` predicate for one window: `from` is INCLUSIVE and `to` is EXCLUSIVE.
 *
 * The same `gte`/`lt` convention the observability reader applies, kept identical so two
 * platform readers cannot disagree about what "up to this instant" means.
 */
function readRange(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  if (from === undefined && to === undefined) return undefined;

  return {
    ...(from === undefined ? {} : { gte: new Date(from) }),
    ...(to === undefined ? {} : { lt: new Date(to) }),
  };
}

/**
 * The row → view mapping, in ONE place: the table's names become the port's vocabulary here
 * (`resourceType` → `resource`, `userId` → `actorId`, `Date` → ISO-8601 string), so no caller
 * ever sees a database shape (§13).
 */
function toReadItem(row: SafeAuditRow): AuditReadItem {
  return {
    id: row.id,
    resource: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    actorId: row.userId,
    success: row.success,
    reason: row.reason,
    changedFields: row.changedFields ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}
