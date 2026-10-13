import { BadRequestException } from '@nestjs/common';
import { ObservabilityReadService } from './observability-read.service';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { LOG_LEVEL_SEVERITY, LogLevelValue } from './observability.contract';
import {
  ApplicationLogQueryDto,
  AuditEventQueryDto,
  DEFAULT_PAGE_SIZE,
  LifecycleEventQueryDto,
  MAX_PAGE_SIZE,
  MAX_RANGE_DAYS,
  SecurityEventQueryDto,
} from './dto/observability-query.dto';

/**
 * Phase 49M-2 §21: the read side stays BOUNDED.
 *
 * Only `ObservabilityPrismaService` is doubled, so the real `resolveRange`, `resolvePaging`
 * and `page` run. What is proven here, and why each property is worth pinning:
 *
 *  - THE THREE BOUNDS ARE ENFORCED. A missing `from`, an inverted window or a span wider than
 *    `MAX_RANGE_DAYS` must be a 400, because each one turns an index range scan over the
 *    largest tables in the installation into a full scan — during the incident the endpoint
 *    exists to diagnose.
 *  - THE SENTINEL-ROW PATTERN. The query asks for `take + 1` and `hasMore` is derived from the
 *    overflow, so the response never needs `SELECT count(*)` over millions of rows.
 *  - THE ORDER IS TOTAL: `occurredAt desc` PLUS `id`. Without the tiebreaker, rows sharing a
 *    millisecond can move between pages, so an operator paging a burst sees one line twice and
 *    another never.
 *  - `minLevel` EXPANDS TO AN `in` LIST, never a `gte` on the Postgres enum, so correctness
 *    does not depend on the order enum members were declared in.
 *  - `succeeded` IS COMPARED AS A STRING. `Boolean('false') === true` would invert the single
 *    most security-relevant filter in the file and hide every denied attempt in the window.
 *  - NO `tenantId` REACHES THE `where`. Tenant scoping belongs to the guard; accepting it from
 *    the query string would let a caller probe another tenant's activity.
 */

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-02T00:00:00.000Z';

function makePrisma() {
  return {
    applicationLog: { findMany: jest.fn().mockResolvedValue([]) },
    auditEvent: { findMany: jest.fn().mockResolvedValue([]) },
    securityEvent: { findMany: jest.fn().mockResolvedValue([]) },
    lifecycleEvent: { findMany: jest.fn().mockResolvedValue([]) },
    retentionRun: { findMany: jest.fn().mockResolvedValue([]) },
  };
}
type PrismaDouble = ReturnType<typeof makePrisma>;

/** `take + 1` rows are requested, so the fixture size is what drives `hasMore`. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}` }));

interface FindManyArgs {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
  skip: number;
}

describe('ObservabilityReadService', () => {
  let prisma: PrismaDouble;
  let service: ObservabilityReadService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ObservabilityReadService(prisma as unknown as ObservabilityPrismaService);
  });

  const logQuery = (over: Partial<ApplicationLogQueryDto> = {}) =>
    ({ from: FROM, to: TO, ...over }) as ApplicationLogQueryDto;

  const argsOf = (m: jest.Mock): FindManyArgs => m.mock.calls[0][0] as FindManyArgs;

  // ───────────────────────────────────────────────────────────────────────────
  // Bound 1: the mandatory, sane, capped window
  // ───────────────────────────────────────────────────────────────────────────

  describe('range validation', () => {
    it('rejects a missing or unparseable `from` before touching the database', async () => {
      await expect(
        service.findApplicationLogs({} as ApplicationLogQueryDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.findApplicationLogs({ from: 'not-a-date' } as ApplicationLogQueryDto),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The point of validating here rather than in the DTO alone: no query is issued at all.
      expect(prisma.applicationLog.findMany).not.toHaveBeenCalled();
    });

    it('rejects an inverted or empty window', async () => {
      await expect(
        service.findApplicationLogs(logQuery({ from: TO, to: FROM })),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Equal bounds too: `gte from, lt to` would match nothing, so it is a caller mistake.
      await expect(
        service.findApplicationLogs(logQuery({ from: FROM, to: FROM })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.applicationLog.findMany).not.toHaveBeenCalled();
    });

    it(`allows a span of exactly ${MAX_RANGE_DAYS} days and refuses one day more`, async () => {
      // Exactly at the cap: 2026-06-01 → 2026-09-01 is 92 days.
      await service.findApplicationLogs(
        logQuery({ from: '2026-06-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
      );
      expect(prisma.applicationLog.findMany).toHaveBeenCalledTimes(1);

      await expect(
        service.findApplicationLogs(
          logQuery({ from: '2026-05-31T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Still one call: the over-wide request never reached the database.
      expect(prisma.applicationLog.findMany).toHaveBeenCalledTimes(1);
    });

    it('defaults `to` to now and echoes the resolved window as ISO strings', async () => {
      const before = Date.now();
      const result = await service.findApplicationLogs(logQuery({ to: undefined }));
      const after = Date.now();

      expect(result.range.from).toBe(FROM);
      const to = new Date(result.range.to).getTime();
      expect(to).toBeGreaterThanOrEqual(before);
      expect(to).toBeLessThanOrEqual(after);

      // `gte`/`lt`, so `to` is exclusive and two adjacent windows cannot return one row twice.
      expect(argsOf(prisma.applicationLog.findMany).where.occurredAt).toEqual({
        gte: new Date(FROM),
        lt: new Date(result.range.to),
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bound 2: the capped page, and the sentinel row that replaces count(*)
  // ───────────────────────────────────────────────────────────────────────────

  describe('paging', () => {
    it('asks for one row more than the page size', async () => {
      await service.findApplicationLogs(logQuery({ limit: 10, offset: 20 }));

      const args = argsOf(prisma.applicationLog.findMany);
      expect(args.take).toBe(11);
      expect(args.skip).toBe(20);
    });

    it('reports hasMore=false and returns every row when the sentinel does not arrive', async () => {
      prisma.applicationLog.findMany.mockResolvedValue(rows(2));

      const result = await service.findApplicationLogs(logQuery({ limit: 2 }));

      expect(result.hasMore).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
    });

    it('reports hasMore=true and trims the sentinel at the boundary', async () => {
      prisma.applicationLog.findMany.mockResolvedValue(rows(3));

      const result = await service.findApplicationLogs(logQuery({ limit: 2 }));

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(2);
      // The extra row is discarded, never leaked as a short third page entry.
      expect((result.items as Array<{ id: string }>).map((r) => r.id)).toEqual(['row-0', 'row-1']);
    });

    it(`defaults to ${DEFAULT_PAGE_SIZE} and clamps to ${MAX_PAGE_SIZE}`, async () => {
      await service.findApplicationLogs(logQuery());
      expect(argsOf(prisma.applicationLog.findMany).take).toBe(DEFAULT_PAGE_SIZE + 1);

      prisma.applicationLog.findMany.mockClear();

      // The DTO caps this too; the service clamps independently so a caller bypassing the
      // pipe (another service, a future internal call) cannot ask for 100,000 rows.
      const result = await service.findApplicationLogs(logQuery({ limit: 5_000 }));
      expect(argsOf(prisma.applicationLog.findMany).take).toBe(MAX_PAGE_SIZE + 1);
      expect(result.limit).toBe(MAX_PAGE_SIZE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bound 3: the index-aligned, total ordering
  // ───────────────────────────────────────────────────────────────────────────

  describe('ordering', () => {
    it('orders every reader by occurredAt desc with id as the tiebreaker', async () => {
      await service.findApplicationLogs(logQuery());
      await service.findAuditEvents(logQuery() as AuditEventQueryDto);
      await service.findSecurityEvents(logQuery() as SecurityEventQueryDto);
      await service.findLifecycleEvents(logQuery() as LifecycleEventQueryDto);

      const expected = [{ occurredAt: 'desc' }, { id: 'desc' }];
      for (const delegate of [
        prisma.applicationLog.findMany,
        prisma.auditEvent.findMany,
        prisma.securityEvent.findMany,
        prisma.lifecycleEvent.findMany,
      ]) {
        expect(argsOf(delegate).orderBy).toEqual(expected);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Filter semantics that would be silently wrong if implemented naively
  // ───────────────────────────────────────────────────────────────────────────

  describe('minLevel', () => {
    it('expands to an `in` list of every level at or above the floor', async () => {
      await service.findApplicationLogs(logQuery({ minLevel: 'WARN' }));

      // Derived from LOG_LEVEL_SEVERITY rather than hard-coded, so the assertion states the
      // RULE (severity >= floor) instead of duplicating today's vocabulary.
      const expected = (Object.keys(LOG_LEVEL_SEVERITY) as LogLevelValue[]).filter(
        (level) => LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY.WARN,
      );

      expect(argsOf(prisma.applicationLog.findMany).where.level).toEqual({ in: expected });
      expect(expected).toEqual(['WARN', 'ERROR', 'FATAL']);
    });

    it('never emits a `gte` comparison against the enum column', async () => {
      await service.findApplicationLogs(logQuery({ minLevel: 'INFO' }));

      // A `gte` here would work only because the Postgres enum happens to be declared in
      // ascending order — correctness would then depend on the order someone typed the
      // members into the schema.
      // FindManyArgs.where is a loose record; this test only inspects the
      // `in` list the service must build for the enum column.
      const level = argsOf(prisma.applicationLog.findMany).where.level as { in?: string[] };
      expect(level).not.toHaveProperty('gte');
      expect(level.in).toContain('INFO');
      expect(level.in).not.toContain('DEBUG');
    });

    it('lets an explicit `level` win over `minLevel`', async () => {
      await service.findApplicationLogs(logQuery({ level: 'DEBUG', minLevel: 'ERROR' }));

      // Exact-match wins: asking for DEBUG and getting ERROR+ would be the opposite answer.
      expect(argsOf(prisma.applicationLog.findMany).where.level).toBe('DEBUG');
    });

    it('applies no level predicate when neither is supplied', async () => {
      await service.findApplicationLogs(logQuery());

      expect(argsOf(prisma.applicationLog.findMany).where).not.toHaveProperty('level');
    });
  });

  describe('security events', () => {
    it("treats succeeded='false' as boolean false", async () => {
      await service.findSecurityEvents({
        from: FROM,
        to: TO,
        succeeded: 'false',
      } as SecurityEventQueryDto);

      // THE inversion this guards: `Boolean('false')` is `true`, which would return only the
      // successful attempts to an operator asking for the failed ones.
      expect(argsOf(prisma.securityEvent.findMany).where.succeeded).toBe(false);
    });

    it("treats succeeded='true' as boolean true and omits the filter when absent", async () => {
      await service.findSecurityEvents({
        from: FROM,
        to: TO,
        succeeded: 'true',
      } as SecurityEventQueryDto);
      expect(argsOf(prisma.securityEvent.findMany).where.succeeded).toBe(true);

      prisma.securityEvent.findMany.mockClear();

      await service.findSecurityEvents({ from: FROM, to: TO } as SecurityEventQueryDto);
      expect(argsOf(prisma.securityEvent.findMany).where).not.toHaveProperty('succeeded');
    });
  });

  describe('per-tab parameter isolation', () => {
    it('never leaks a tenantId or a free-text term into any where clause', async () => {
      // The DTO rejects unknown parameters, but a future internal caller could pass an object
      // directly; the service must still not build a predicate out of anything it does not own.
      const hostile = {
        from: FROM,
        to: TO,
        tenantId: 'other-tenant',
        search: "'; drop table \"ApplicationLog\"; --",
      } as unknown as ApplicationLogQueryDto;

      await service.findApplicationLogs(hostile);

      const where = argsOf(prisma.applicationLog.findMany).where;
      expect(where).not.toHaveProperty('tenantId');
      expect(where).not.toHaveProperty('search');
      expect(Object.keys(where)).toEqual(['occurredAt']);
    });

    it('maps each reader only to the filters its own tab declares', async () => {
      await service.findAuditEvents({
        from: FROM,
        to: TO,
        action: 'user.updated',
        outcome: 'DENIED',
        // `level` belongs to the logs tab. An audit query must not acquire it by accident.
        level: 'ERROR',
      } as unknown as AuditEventQueryDto);

      const where = argsOf(prisma.auditEvent.findMany).where;
      expect(where.action).toBe('user.updated');
      expect(where.outcome).toBe('DENIED');
      expect(where).not.toHaveProperty('level');
    });
  });

  describe('retention runs', () => {
    it('is the one reader with no mandatory window, ordered by startedAt desc', async () => {
      await service.findRetentionRuns();

      const args = prisma.retentionRun.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ startedAt: 'desc' }]);
      // RetentionRun grows ~4 rows per pass, so recent-rows is bounded by the data itself.
      expect(args.where).toBeUndefined();
      expect(args.take).toBe(40);
    });

    it('clamps the limit into [1, MAX_PAGE_SIZE]', async () => {
      await service.findRetentionRuns(0);
      expect(prisma.retentionRun.findMany.mock.calls[0][0].take).toBe(1);

      await service.findRetentionRuns(-10);
      expect(prisma.retentionRun.findMany.mock.calls[1][0].take).toBe(1);

      await service.findRetentionRuns(10_000);
      expect(prisma.retentionRun.findMany.mock.calls[2][0].take).toBe(MAX_PAGE_SIZE);
    });
  });
});

