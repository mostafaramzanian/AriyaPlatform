import {
  validateAuditReadQuery,
  type AuditEventInput,
  type AuditPort,
  type AuditReadItem,
  type AuditReadQuery,
  type AuditReadResult,
  type AuditRecordResult,
} from '../../src/platform/audit/audit.contract';

/**
 * PHASE P-AUDIT-READ (§24): the READ-CAPABLE in-memory `AuditPort` the e2e harnesses bind.
 *
 * WHY A SHARED FIXTURE AND NOT THREE COPIES
 * -----------------------------------------
 * Three Commerce harnesses (`commerce-lifecycle`, `commerce-integration`, `commerce-tenant`)
 * bind `AUDIT_PORT` in-memory. When the platform port gained `read`, a record-only fake stopped
 * satisfying the contract — and three hand-written read implementations would be three chances
 * for a harness to disagree with production about what a read means. This factory is
 * CONTRACT-DRIVEN: it validates through the SAME `validateAuditReadQuery` the Core binding uses,
 * filters by the SAME tenant/resource rule, applies the SAME insertion order and the SAME page
 * bounds, and projects the SAME whitelist. A harness cannot pass while production would fail.
 *
 * WHAT THE FAKE'S CLOCK IS, AND WHY
 * ---------------------------------
 * The trail's only chronology is `AuditLog.createdAt`, which a real insert sets at write time.
 * The fake has no database, so it stamps one millisecond per recorded event from a fixed epoch
 * (`FAKE_CLOCK_EPOCH`): insertion order therefore EQUALS `createdAt ASC, id ASC`, exactly the
 * order the contract promises. Window filters (`from`/`to`) compare against this fake clock —
 * tests that use them should address it as offsets from `FAKE_CLOCK_EPOCH`.
 *
 * The `record` half is byte-identical to the fakes it replaces: it appends to the caller's array
 * and returns `recorded`, so every existing harness assertion keeps its meaning.
 *
 * `auditLogId` is `null`: the fake has no database row identity, and inventing one would make a
 * harness agree with a value production generates differently.
 */

/** The fake's write clock: one millisecond per recorded event, from a fixed epoch. */
const FAKE_CLOCK_EPOCH = Date.UTC(2026, 0, 1);

export function createFakeAuditPort(events: AuditEventInput[]): AuditPort {
  return {
    async record(event: AuditEventInput): Promise<AuditRecordResult> {
      events.push(event);
      return { status: 'recorded', auditId: event.auditId, auditLogId: null };
    },

    async read(query: AuditReadQuery): Promise<AuditReadResult> {
      const validation = validateAuditReadQuery(query);

      if (!validation.ok) return { status: 'rejected', code: validation.code };

      const { tenantId, resource, resourceId, action, from, to, page, pageSize } = validation.query;

      const matched = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.tenantId === tenantId)
        .filter(({ event }) => event.resource === resource && event.resourceId === resourceId)
        .filter(({ event }) => action === undefined || event.action === action)
        .filter(({ index }) => inWindow(FAKE_CLOCK_EPOCH + index, from, to))
        .map(({ event, index }) => toItem(event, index));

      const start = (page - 1) * pageSize;

      return {
        status: 'ok',
        page: {
          items: matched.slice(start, start + pageSize),
          page,
          pageSize,
          total: matched.length,
        },
      };
    },
  };
}

/** Projects one recorded event exactly as the Core binding projects a row. */
function toItem(event: AuditEventInput, index: number): AuditReadItem {
  return {
    id: `fake-audit-${index + 1}`,
    resource: event.resource,
    resourceId: event.resourceId,
    action: event.action,
    actorId: event.actorId ?? null,
    success: event.success ?? true,
    reason: event.reason ?? null,
    changedFields: event.changedFields ?? [],
    createdAt: new Date(FAKE_CLOCK_EPOCH + index).toISOString(),
  };
}

/** The contract's window rule: `from` inclusive, `to` exclusive. */
function inWindow(millis: number, from?: string, to?: string): boolean {
  if (from !== undefined && millis < Date.parse(from)) return false;
  if (to !== undefined && millis >= Date.parse(to)) return false;
  return true;
}
