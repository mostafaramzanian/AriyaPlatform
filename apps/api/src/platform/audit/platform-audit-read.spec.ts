import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import {
  AUDIT_READ_DEFAULT_PAGE_SIZE,
  AUDIT_READ_MAX_PAGE_SIZE,
  type AuditEventInput,
  type AuditReadPage,
  type AuditReadQuery,
} from './audit.contract';

/**
 * PHASE P-AUDIT-READ (§25 B–P): the READ half of the Core audit binding, against a fake table.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `platform-audit.service.spec.ts` pins the WRITER; this file pins the READER, and there are
 * properties only an executed query can establish:
 *
 *  1. THE TENANT IS A PREDICATE, NOT A POST-FILTER. The fake table applies the WHERE the service
 *     builds — if the service ever dropped `tenantId` from it, tenant A's read would return
 *     tenant B's rows here and the isolation test would fail.
 *  2. THE PROJECTION IS A WHITELIST AT THE DATABASE LEVEL. The fake table CAN hold `ipAddress`,
 *     `oldValue` and the rest (a real table does), and it applies the service's `select`. So
 *     "sensitive columns never leave the database" is asserted twice: the select keys, and the
 *     shape of the returned items.
 *  3. ORDERING IS TOTAL. The fake stamps one millisecond per insert, and the tie-break test
 *     SEEDS two rows with the same instant, so `(createdAt ASC, id ASC)` is proven, not assumed.
 *  4. THE FAKE EMULATES THE POSTGRES SEMANTICS THE READ DEPENDS ON: equality/range predicates,
 *     the `skip`/`take` window, the projection, and the array-form `$transaction` that reads the
 *     page and its COUNT in one snapshot.
 *
 * It exercises the REAL `PlatformAuditService` for BOTH directions, so "record then read" is one
 * binding writing and reading one table — the P-A path the phase describes.
 */

const CLOCK_EPOCH = Date.UTC(2026, 0, 1);

/** One stored row: the FULL table, sensitive columns included — the read must not load them. */
interface FakeRow {
  id: string;
  auditId: string;
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
  oldValue: unknown;
  newValue: unknown;
  changes: unknown;
  changedFields: string[];
  success: boolean;
  reason: string | null;
  durationMs: number | null;
  createdAt: Date;
  [column: string]: unknown;
}

interface FakeWhere {
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  createdAt?: { gte?: Date; lt?: Date };
}

type FakeOrder = Array<Record<string, 'asc' | 'desc'>>;

interface FakeTable {
  auditLog: {
    findUnique: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  auditDispatch: { create: jest.Mock };
  $transaction: jest.Mock;
  rows: Map<string, FakeRow>;
  seed: (partial: Partial<FakeRow> & { auditId: string }) => FakeRow;
}

function fakeTable(): FakeTable {
  const rows = new Map<string, FakeRow>();
  let clock = 0;

  const matches = (row: FakeRow, where: FakeWhere): boolean => {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
    if (where.resourceType !== undefined && row.resourceType !== where.resourceType) return false;
    if (where.resourceId !== undefined && row.resourceId !== where.resourceId) return false;
    if (where.action !== undefined && row.action !== where.action) return false;
    if (where.createdAt?.gte !== undefined && row.createdAt < where.createdAt.gte) return false;
    if (where.createdAt?.lt !== undefined && row.createdAt >= where.createdAt.lt) return false;
    return true;
  };

  const compare = (left: FakeRow, right: FakeRow, orderBy?: FakeOrder): number => {
    if (!orderBy) return 0;

    for (const clause of orderBy) {
      for (const [column, direction] of Object.entries(clause)) {
        const rawLeft = left[column];
        const rawRight = right[column];
        const a = rawLeft instanceof Date ? rawLeft.getTime() : rawLeft;
        const b = rawRight instanceof Date ? rawRight.getTime() : rawRight;
        if (a === b) continue;

        const cmp = (a as number | string) < (b as number | string) ? -1 : 1;
        return direction === 'desc' ? -cmp : cmp;
      }
    }

    return 0;
  };

  const project = (row: FakeRow, select?: Record<string, boolean>): Record<string, unknown> => {
    if (!select) return { ...row };
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, wanted]) => wanted)
        .map(([column]) => [column, row[column]])
    );
  };

  const fill = (partial: Partial<FakeRow> & { auditId: string }): FakeRow => ({
    id: `seed-${rows.size + 1}`,
    tenantId: null,
    requestId: '',
    correlationId: null,
    userId: null,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    action: 'CREATE',
    resourceType: 'commerce.purchase_document',
    resourceId: 'doc-1',
    oldValue: null,
    newValue: null,
    changes: null,
    changedFields: [],
    success: true,
    reason: null,
    durationMs: null,
    createdAt: new Date(CLOCK_EPOCH + clock++),
    ...partial,
  });

  return {
    auditLog: {
      findUnique: jest.fn(
        async ({ where }: { where: { auditId: string } }) => rows.get(where.auditId) ?? null
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // A real INSERT gets its timestamp from the database clock; the fake advances one
        // millisecond per row so insertion order and `createdAt` order are the same thing.
        const row = fill({
          auditId: String(data.auditId),
          id: `log-${rows.size + 1}`,
          tenantId: (data.tenantId ?? null) as string | null,
          requestId: (data.requestId ?? '') as string,
          correlationId: (data.correlationId ?? null) as string | null,
          userId: (data.userId ?? null) as string | null,
          ipAddress: (data.ipAddress ?? null) as string | null,
          userAgent: (data.userAgent ?? null) as string | null,
          sessionId: (data.sessionId ?? null) as string | null,
          action: String(data.action),
          resourceType: String(data.resourceType),
          resourceId: String(data.resourceId),
          oldValue: data.oldValue ?? null,
          newValue: data.newValue ?? null,
          changedFields: (data.changedFields ?? []) as string[],
          success: data.success === undefined ? true : Boolean(data.success),
          reason: (data.reason ?? null) as string | null,
          durationMs: (data.durationMs ?? null) as number | null,
        });
        rows.set(row.auditId, row);
        return row;
      }),
      findMany: jest.fn(
        async (args: {
          where: FakeWhere;
          orderBy?: FakeOrder;
          skip?: number;
          take?: number;
          select?: Record<string, boolean>;
        }) => {
          const matched = [...rows.values()]
            .filter((row) => matches(row, args.where))
            .sort((left, right) => compare(left, right, args.orderBy));
          const skip = args.skip ?? 0;
          const window = matched.slice(skip, skip + (args.take ?? matched.length));
          return window.map((row) => project(row, args.select));
        }
      ),
      count: jest.fn(async ({ where }: { where: FakeWhere }) => {
        return [...rows.values()].filter((row) => matches(row, where)).length;
      }),
    },
    auditDispatch: { create: jest.fn(async () => undefined) },
    // The array form: the operations are already-started promises, so awaiting them together is
    // exactly what Prisma's array-form transaction does for the page + COUNT read.
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    rows,
    seed: (partial) => {
      const row = fill(partial);
      rows.set(row.auditId, row);
      return row;
    },
  };
}

describe('PlatformAuditService — the read half (P-AUDIT-READ)', () => {
  let table: FakeTable;
  let service: PlatformAuditService;

  /** A valid event, as a producer supplies it. One field per test is varied deliberately. */
  const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
    auditId: randomUUID(),
    tenantId: 'tenant-a',
    requestId: 'req-1',
    actorId: 'user-1',
    action: 'CREATE',
    resource: 'commerce.purchase_document',
    resourceId: 'doc-1',
    ...overrides,
  });

  /** A valid read, as a trusted consumer builds it. */
  const query = (overrides: Partial<AuditReadQuery> = {}): AuditReadQuery => ({
    tenantId: 'tenant-a',
    resource: 'commerce.purchase_document',
    resourceId: 'doc-1',
    ...overrides,
  });

  /** The page of an `ok` read; a `rejected` answer from this helper is a test bug. */
  async function readOk(input: AuditReadQuery): Promise<AuditReadPage> {
    const result = await service.read(input);
    if (result.status !== 'ok') throw new Error(`expected an ok read, got ${result.code}`);
    return result.page;
  }

  beforeEach(() => {
    table = fakeTable();
    service = new PlatformAuditService(table as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('P-A — record then read through the SAME binding', () => {
    it('returns the safe projection of an event this binding recorded', async () => {
      await service.record(event({ reason: 'requested', changedFields: ['status'] }));

      const page = await readOk(query());

      expect(page).toEqual({
        items: [
          {
            id: 'log-1',
            resource: 'commerce.purchase_document',
            resourceId: 'doc-1',
            action: 'CREATE',
            actorId: 'user-1',
            success: true,
            reason: 'requested',
            changedFields: ['status'],
            createdAt: new Date(CLOCK_EPOCH).toISOString(),
          },
        ],
        page: 1,
        pageSize: AUDIT_READ_DEFAULT_PAGE_SIZE,
        total: 1,
      });
    });

    it('applies the documented paging defaults when the caller sends none', async () => {
      await service.record(event());

      const page = await readOk(query());

      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(AUDIT_READ_DEFAULT_PAGE_SIZE);
    });
  });

  describe('P-E — the projection is a whitelist, and the SELECT is the enforcement', () => {
    it('never loads or returns a sensitive column, even when the row really holds one', async () => {
      await service.record(
        event({
          ip: '10.0.0.9',
          userAgent: 'probe/1.0',
          sessionId: 'sess-1',
          oldValue: { password: 'secret' },
          newValue: { status: 'DRAFT' },
        })
      );

      const stored = [...table.rows.values()][0];
      // The row DOES carry the sensitive values, so the assertions below cannot pass vacuously.
      expect(stored.ipAddress).toBe('10.0.0.9');
      expect(stored.userAgent).toBe('probe/1.0');
      expect(stored.sessionId).toBe('sess-1');
      expect(stored.oldValue).toBeTruthy();
      expect(stored.newValue).toBeTruthy();

      const page = await readOk(query());

      expect(Object.keys(page.items[0]).sort()).toEqual(
        [
          'action',
          'actorId',
          'changedFields',
          'createdAt',
          'id',
          'reason',
          'resource',
          'resourceId',
          'success',
        ].sort()
      );

      const select = table.auditLog.findMany.mock.calls[0][0].select as Record<string, boolean>;
      expect(Object.keys(select).sort()).toEqual(
        [
          'action',
          'changedFields',
          'createdAt',
          'id',
          'reason',
          'resourceId',
          'resourceType',
          'success',
          'userId',
        ].sort()
      );

      // The exclusions that matter, asserted BY NAME so a future select cannot quietly add one.
      for (const forbidden of [
        'tenantId',
        'ipAddress',
        'userAgent',
        'sessionId',
        'oldValue',
        'newValue',
        'changes',
        'requestId',
        'correlationId',
        'durationMs',
      ]) {
        expect(select[forbidden]).toBeUndefined();
      }
    });
  });

  describe('P-C — tenant isolation is a predicate, not a post-filter', () => {
    it('never returns or counts another tenant\u2019s rows', async () => {
      await service.record(event({ tenantId: 'tenant-a' }));
      await service.record(event({ tenantId: 'tenant-b' }));
      await service.record(event({ tenantId: 'tenant-b' }));

      const a = await readOk(query({ tenantId: 'tenant-a' }));
      const b = await readOk(query({ tenantId: 'tenant-b' }));

      expect(a.total).toBe(1);
      expect(a.items.map((item) => item.id)).toEqual(['log-1']);
      expect(b.total).toBe(2);

      // The WHERE itself carries the caller's tenant, on BOTH reads of the transaction.
      expect(table.auditLog.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-a' });
      expect(table.auditLog.count.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-a' });
    });

    it('cannot reach a tenant-less (legacy-historical) row', async () => {
      table.seed({ auditId: 'legacy-1', tenantId: null });

      const page = await readOk(query());

      expect(page.total).toBe(0);
      expect(page.items).toEqual([]);
    });
  });

  describe('P-B — the resource pair is the bound', () => {
    it('excludes a same-id event of ANOTHER resource type and a same-type event of another id', async () => {
      await service.record(event({ resourceId: 'doc-1' }));
      await service.record(event({ resourceId: 'doc-2' }));
      await service.record(event({ resource: 'commerce.return_document', resourceId: 'doc-1' }));

      const page = await readOk(query());

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].resource).toBe('commerce.purchase_document');
      expect(page.items[0].resourceId).toBe('doc-1');
    });

    it('answers an unknown resourceId with an EMPTY page — not 404 semantics', async () => {
      const page = await readOk(query({ resourceId: 'no-such-document' }));

      expect(page).toEqual({
        items: [],
        page: 1,
        pageSize: AUDIT_READ_DEFAULT_PAGE_SIZE,
        total: 0,
      });
    });
  });

  describe('K/L — the optional narrowers reach the query', () => {
    it('an action narrows the page without widening the tenant scope', async () => {
      await service.record(event({ action: 'CREATE' }));
      await service.record(event({ action: 'STATUS_CHANGED' }));

      const page = await readOk(query({ action: 'STATUS_CHANGED' }));

      expect(page.total).toBe(1);
      expect(page.items[0].action).toBe('STATUS_CHANGED');
      expect(table.auditLog.findMany.mock.calls[0][0].where).toMatchObject({
        action: 'STATUS_CHANGED',
        tenantId: 'tenant-a',
      });
    });

    it('from is inclusive and to is exclusive, over the stored write instant', async () => {
      await service.record(event()); // +0ms
      await service.record(event()); // +1ms
      await service.record(event()); // +2ms

      const page = await readOk(
        query({
          from: new Date(CLOCK_EPOCH + 1).toISOString(),
          to: new Date(CLOCK_EPOCH + 2).toISOString(),
        })
      );

      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe('log-2');
      expect(table.auditLog.findMany.mock.calls[0][0].where.createdAt).toEqual({
        gte: new Date(CLOCK_EPOCH + 1),
        lt: new Date(CLOCK_EPOCH + 2),
      });
    });
  });

  describe('P-D — pagination is deterministic and lossless', () => {
    it('walks five events in three pages with no duplicate and no lost row', async () => {
      for (let index = 0; index < 5; index += 1) await service.record(event());

      const first = await readOk(query({ page: 1, pageSize: 2 }));
      const second = await readOk(query({ page: 2, pageSize: 2 }));
      const third = await readOk(query({ page: 3, pageSize: 2 }));
      const beyond = await readOk(query({ page: 4, pageSize: 2 }));

      expect(first.items.map((item) => item.id)).toEqual(['log-1', 'log-2']);
      expect(second.items.map((item) => item.id)).toEqual(['log-3', 'log-4']);
      expect(third.items.map((item) => item.id)).toEqual(['log-5']);
      expect(beyond.items).toEqual([]);

      for (const page of [first, second, third, beyond]) expect(page.total).toBe(5);

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('I — ordering is total', () => {
    it('orders by createdAt ascending, with the id as the tie-break', async () => {
      const sameInstant = new Date(CLOCK_EPOCH + 500);

      table.seed({
        auditId: 'seed-c',
        id: 'row-c',
        tenantId: 'tenant-a',
        createdAt: new Date(CLOCK_EPOCH + 400),
      });
      table.seed({ auditId: 'seed-b', id: 'row-b', tenantId: 'tenant-a', createdAt: sameInstant });
      table.seed({ auditId: 'seed-a', id: 'row-a', tenantId: 'tenant-a', createdAt: sameInstant });

      const page = await readOk(query());

      expect(page.items.map((item) => item.id)).toEqual(['row-c', 'row-a', 'row-b']);
    });
  });

  describe('M — an invalid query is rejected BEFORE any database work', () => {
    it('names the fault and touches neither read', async () => {
      const cases: Array<[unknown, string]> = [
        [null, 'AUDIT_READ_QUERY_INVALID'],
        [
          { tenantId: '', resource: 'commerce.purchase_document', resourceId: 'doc-1' },
          'AUDIT_READ_TENANT_MISSING',
        ],
        [{ tenantId: 'tenant-a' }, 'AUDIT_READ_RESOURCE_MISSING'],
        [{ tenantId: 'tenant-a', resourceId: 'doc-1' }, 'AUDIT_READ_RESOURCE_MISSING'],
        [
          { tenantId: 'tenant-a', resource: 'commerce.purchase_document' },
          'AUDIT_READ_RESOURCE_ID_MISSING',
        ],
        [
          query({ pageSize: AUDIT_READ_MAX_PAGE_SIZE + 1 }),
          'AUDIT_READ_PAGE_INVALID',
        ],
        [query({ from: 'not-a-date' }), 'AUDIT_READ_RANGE_INVALID'],
      ];

      for (const [input, code] of cases) {
        await expect(service.read(input as AuditReadQuery)).resolves.toEqual({
          status: 'rejected',
          code,
        });
      }

      expect(table.auditLog.findMany).not.toHaveBeenCalled();
      expect(table.auditLog.count).not.toHaveBeenCalled();
    });
  });

  describe('storage failure', () => {
    it('reports AUDIT_READ_FAILED instead of throwing', async () => {
      table.auditLog.findMany.mockRejectedValueOnce(new Error('database is down'));

      await expect(service.read(query())).resolves.toEqual({
        status: 'rejected',
        code: 'AUDIT_READ_FAILED',
      });
    });
  });

  describe('§27 — Commerce compatibility', () => {
    it('reads the confirmed purchase-document events without JSON parsing or Commerce tables', async () => {
      const purchaseId = '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c';

      await service.record(
        event({
          resource: 'commerce.purchase_document',
          resourceId: purchaseId,
          action: 'SUBMITTED',
          changedFields: ['status'],
        })
      );

      const page = await readOk(
        query({ resource: 'commerce.purchase_document', resourceId: purchaseId })
      );

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        resource: 'commerce.purchase_document',
        resourceId: purchaseId,
        action: 'SUBMITTED',
        changedFields: ['status'],
      });
    });
  });

  describe('Q — the writer is untouched', () => {
    it('record still returns its discriminated result and writes one row', async () => {
      await expect(service.record(event())).resolves.toEqual({
        status: 'recorded',
        auditId: expect.any(String),
        auditLogId: 'log-1',
      });

      expect(table.rows.size).toBe(1);
    });
  });
});



