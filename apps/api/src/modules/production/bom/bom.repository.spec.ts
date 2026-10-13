import { readFileSync } from 'fs';
import { join } from 'path';
import { BomHeaderRepository } from './bom.repository';
import type { BomHeaderRecord } from './bom.repository';

/**
 * Phase PRODUCTION-BOM-HEADER: the persistence boundary of the BOM Header slice.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH IS FALSIFIABLE
 * ------------------------------------------------
 *  1. THE TENANT IS IN EVERY `where`. Every method takes `tenantId` first and forwards it
 *     into the predicate, so a foreign id cannot be read or written. This is checked on
 *     the ARGUMENTS the repository actually passes, not on a comment.
 *  2. `findUnique` IS NEVER USED. It cannot carry a tenant predicate, so an "find by id"
 *     written with it would read another tenant's row. Checked twice: on the fake (no
 *     such method is called) and on the SOURCE text, because the compiler would happily
 *     accept `findUnique({ where: { id } })` and the runtime would return a stranger's BOM.
 *  3. TRANSITIONS ARE CONDITIONAL. `submit`, `updateDraft` and `decide` carry the
 *     expected `from` status INSIDE the WHERE clause, so two concurrent requests cannot
 *     both win — the property a read-then-write pair would not have.
 *  4. SUBMIT WRITES NO DECISION COLUMN. `managerOpinion`, `decidedAt` and `decidedByUserId`
 *     stay NULL on submit, so "nobody has decided" is readable as NULL rather than as a
 *     placeholder value, and the decision columns keep exactly one writer.
 *
 * The Prisma double is structural: `ConstructorParameters` derives the service type from
 * the repository's own constructor, so the fake has to satisfy the real dependency
 * without this spec importing the generated production client.
 */

const ROW: BomHeaderRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  title: 'BOM for project 42',
  projectRef: '42',
  productTreeRef: '771',
  requesterUserId: 'user-requester',
  approverUserId: 'user-approver',
  status: 'DRAFT',
  managerOpinion: null,
  comments: null,
  submittedAt: null,
  decidedAt: null,
  decidedByUserId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function build(updateCount = 1) {
  const bomHeader = {
    create: jest.fn().mockResolvedValue(ROW),
    findFirst: jest.fn().mockResolvedValue(ROW),
    findMany: jest.fn().mockResolvedValue([ROW]),
    count: jest.fn().mockResolvedValue(1),
    groupBy: jest.fn().mockResolvedValue([{ status: 'DRAFT', _count: { _all: 1 } }]),
    updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
  };
  const auditOutbox = {
    create: jest.fn().mockResolvedValue({}),
  };
  // Phase B2.4: submit/decide now use `$transaction`. The mock executes the callback
  // with the transaction client that exposes the same delegates as `prisma`.
  const prisma = {
    bomHeader,
    auditOutbox,
    $transaction: jest.fn(
      async (fn: (tx: { bomHeader: typeof bomHeader; auditOutbox: typeof auditOutbox }) => Promise<unknown>) =>
        fn({ bomHeader, auditOutbox })
    ),
  } as unknown as ConstructorParameters<typeof BomHeaderRepository>[0];

  return { repository: new BomHeaderRepository(prisma), bomHeader, auditOutbox };
}

describe('BomHeaderRepository.create', () => {
  it('stamps the acting tenant and lets the schema default the status', async () => {
    const { repository, bomHeader } = build();

    const row = await repository.create('tenant-a', {
      title: 'BOM for project 42',
      projectRef: '42',
      productTreeRef: '771',
      requesterUserId: 'user-requester',
      approverUserId: 'user-approver',
      comments: null,
    });

    expect(row).toBe(ROW);
    const data = bomHeader.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe('tenant-a');
    // No caller-supplied status: a write path that could set APPROVED would bypass every
    // transition the routes own.
    expect(Object.keys(data)).toEqual([
      'title',
      'projectRef',
      'productTreeRef',
      'requesterUserId',
      'approverUserId',
      'comments',
      'tenantId',
    ]);
  });
});

describe('BomHeaderRepository.findById', () => {
  it('scopes the read by tenant as well as id, and returns null for a foreign id', async () => {
    const { repository, bomHeader } = build();

    expect(await repository.findById('tenant-a', ROW.id)).toBe(ROW);
    expect(bomHeader.findFirst).toHaveBeenCalledWith({
      where: { id: ROW.id, tenantId: 'tenant-a' },
    });

    bomHeader.findFirst.mockResolvedValueOnce(null);
    // "does not exist" and "belongs to another tenant" are deliberately the same answer.
    expect(await repository.findById('tenant-b', ROW.id)).toBeNull();
  });

  it('never reaches for an unscoped single-row read', () => {
    // Falsifiable: `findUnique({ where: { id } })` type-checks, boots, and returns another
    // tenant's BOM. Only reading the CODE catches it — and the repository's own jsdoc
    // says the word, so the comment lines are stripped first rather than the whole rule
    // being weakened to a substring search that the prose would satisfy.
    const code = readFileSync(join(__dirname, 'bom.repository.ts'), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('*/')
        );
      })
      .join('\n');

    expect(code).not.toMatch(/\.findUnique\s*\(/);
    // The shape it uses instead, pinned: an id alone is never an isolation key.
    expect(code).toContain('findFirst({ where: { id, tenantId } })');
  });

  describe('BomHeaderRepository.list', () => {
    it('counts with the SAME predicate it pages with, so a page and its total agree', async () => {
      const { repository, bomHeader } = build();

      const result = await repository.list('tenant-a', {
        skip: 20,
        take: 10,
        status: 'SUBMITTED',
        search: 'boiler',
      });

      expect(result).toEqual({ items: [ROW], total: 1 });
      const where = { tenantId: 'tenant-a', status: 'SUBMITTED', title: { contains: 'boiler' } };
      expect(bomHeader.findMany).toHaveBeenCalledWith({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: 20,
        take: 10,
      });
      expect(bomHeader.count).toHaveBeenCalledWith({ where });
    });

    it('is tenant-scoped even when no filter is stated at all', async () => {
      const { repository, bomHeader } = build();

      await repository.list('tenant-a', { skip: 0, take: 20 });

      const where = bomHeader.findMany.mock.calls[0][0].where;
      // The tenant is the ONLY unconditional predicate: an unfiltered list is still
      // "this tenant's rows" and never "all rows".
      expect(where).toEqual({ tenantId: 'tenant-a' });
      expect(where.title).toBeUndefined();
    });
  });

  describe('BomHeaderRepository.updateDraft', () => {
    it('puts DRAFT in the WHERE clause and re-reads the row it just wrote', async () => {
      const { repository, bomHeader } = build();

      const updated = await repository.updateDraft('tenant-a', ROW.id, { title: 'renamed' });

      expect(updated).toBe(ROW);
      expect(bomHeader.updateMany).toHaveBeenCalledWith({
        where: { id: ROW.id, tenantId: 'tenant-a', status: 'DRAFT' },
        data: { title: 'renamed' },
      });
      expect(bomHeader.findFirst).toHaveBeenCalledWith({
        where: { id: ROW.id, tenantId: 'tenant-a' },
      });
    });

    it('returns null WITHOUT re-reading when the conditional write lost', async () => {
      const { repository, bomHeader } = build(0);

      expect(await repository.updateDraft('tenant-a', ROW.id, { title: 'renamed' })).toBeNull();
      // `count === 0` is the caller's signal that the row is gone or no longer editable;
      // re-reading here would only add a second statement to a lost race.
      expect(bomHeader.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('BomHeaderRepository.submit', () => {
    it('moves DRAFT to SUBMITTED and writes NO decision column', async () => {
      const { repository, bomHeader } = build();

      await repository.submit('tenant-a', ROW.id, 'please review');

      const call = bomHeader.updateMany.mock.calls[0][0];
      // `items: { some: {} }` is part of the SAME conditional statement (Phase
      // PRODUCTION-BOM-ITEM): a BOM with no rows matches nothing, so "an empty BOM cannot be
      // submitted" is atomic rather than a count read followed by a write.
      expect(call.where).toEqual({
        id: ROW.id,
        tenantId: 'tenant-a',
        status: 'DRAFT',
        items: { some: {} },
      });
      expect(call.data.status).toBe('SUBMITTED');
      expect(call.data.submittedAt).toBeInstanceOf(Date);
      expect(call.data.comments).toBe('please review');
      // The approver has not stated anything yet: `managerOpinion`, `decidedAt` and
      // `decidedByUserId` must stay NULL rather than receive a placeholder.
      expect(Object.keys(call.data)).toEqual(['status', 'submittedAt', 'comments']);
    });

    it('loses the race instead of submitting twice', async () => {
      const { repository, bomHeader } = build(0);

      expect(await repository.submit('tenant-a', ROW.id)).toBeNull();
      // The second submit finds `status !== 'DRAFT'` and matches nothing.
      expect(bomHeader.updateMany.mock.calls[0][0].where.status).toBe('DRAFT');
    });
  });

  describe('BomHeaderRepository.decide', () => {
    it('records the decision and the expected `from` status in one atomic statement', async () => {
      const { repository, bomHeader } = build();

      await repository.decide('tenant-a', ROW.id, 'SUBMITTED', {
        status: 'APPROVED',
        managerOpinion: 'APPROVED',
        comments: 'ok',
        decidedByUserId: 'user-approver',
      });

      const call = bomHeader.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ROW.id, tenantId: 'tenant-a', status: 'SUBMITTED' });
      expect(call.data.status).toBe('APPROVED');
      expect(call.data.managerOpinion).toBe('APPROVED');
      expect(call.data.decidedByUserId).toBe('user-approver');
      expect(call.data.decidedAt).toBeInstanceOf(Date);
    });

    it('refuses a row that is no longer in the expected state, by matching nothing', async () => {
      const { repository } = build(0);

      expect(
        await repository.decide('tenant-a', ROW.id, 'SUBMITTED', {
          status: 'REJECTED',
          managerOpinion: 'REJECTED',
          decidedByUserId: 'user-approver',
        })
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------
// Phase REPORTING-PRODUCTION-REPORT: the THREE source-owned reads the Production reporting
// seam consumes. They are pinned with the same falsifiable properties the reads above
// carry, because they are the reads a report's honesty rests on: the SAME predicate as
// `list`, the tenant in EVERY statement, and no unscoped single-row read.
// ---------------------------------------------------------------------------------------

describe('BomHeaderRepository.listWithItemCount — the reporting page read', () => {
  it('pages and counts with the SAME predicate as `list`, plus a row-bound item count', async () => {
    const { repository, bomHeader } = build();

    const result = await repository.listWithItemCount('tenant-a', {
      skip: 20,
      take: 10,
      status: 'SUBMITTED',
      search: 'boiler',
    });

    expect(result).toEqual({ items: [ROW], total: 1 });
    const where = { tenantId: 'tenant-a', status: 'SUBMITTED', title: { contains: 'boiler' } };
    // Identical to what `list` issues — one builder produces both (page and summary can
    // never disagree about which rows exist).
    expect(bomHeader.findMany).toHaveBeenCalledWith({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: 20,
      take: 10,
      include: { _count: { select: { items: true } } },
    });
    expect(bomHeader.count).toHaveBeenCalledWith({ where });
  });

  it('is tenant-scoped even when no filter is stated at all', async () => {
    const { repository, bomHeader } = build();

    await repository.listWithItemCount('tenant-a', { skip: 0, take: 20 });

    const where = bomHeader.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ tenantId: 'tenant-a' });
    expect(where.title).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  it('translates the KPI date-window into a half-open `decidedAt` predicate', async () => {
    const { repository, bomHeader } = build();

    await repository.listWithItemCount('tenant-a', {
      skip: 0,
      take: 20,
      decidedFrom: '2026-02-01T00:00:00.000Z',
      decidedTo: '2026-03-01T00:00:00.000Z',
    });

    const where = bomHeader.findMany.mock.calls[0][0].where;
    // HALF-OPEN `[from, to)` — `gte` on the lower bound, `lt` on the upper. A CLOSED upper
    // bound would either double-count a row decided exactly at the month's end or drop the
    // month's final millisecond, and the Jalali arithmetic already yields "next month at
    // midnight" as the exclusive end.
    expect(where.decidedAt.gte.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(where.decidedAt.lt.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    // ADDITIVE: the tenant predicate travels with the window, and no column the window does
    // not name joins the filter just because one was stated.
    expect(Object.keys(where).sort()).toEqual(['decidedAt', 'tenantId']);
  });

  it('sets only the bound that was stated — a one-sided window stays one-sided', async () => {
    const { repository, bomHeader } = build();

    await repository.listWithItemCount('tenant-a', {
      skip: 0,
      take: 20,
      decidedFrom: '2026-02-01T00:00:00.000Z',
    });
    await repository.countByStatus('tenant-a', { decidedTo: '2026-03-01T00:00:00.000Z' });

    expect(Object.keys(bomHeader.findMany.mock.calls[0][0].where.decidedAt)).toEqual(['gte']);
    expect(Object.keys(bomHeader.groupBy.mock.calls[0][0].where.decidedAt)).toEqual(['lt']);
  });
});

describe('BomHeaderRepository.findByIdWithItemCount — the reporting detail read', () => {
  it('scopes by tenant AND id, and returns null for a foreign id', async () => {
    const { repository, bomHeader } = build();

    expect(await repository.findByIdWithItemCount('tenant-a', ROW.id)).toBe(ROW);
    expect(bomHeader.findFirst).toHaveBeenCalledWith({
      where: { id: ROW.id, tenantId: 'tenant-a' },
      include: { _count: { select: { items: true } } },
    });

    bomHeader.findFirst.mockResolvedValueOnce(null);
    // A row of another tenant stays indistinguishable from one that does not exist.
    expect(await repository.findByIdWithItemCount('tenant-b', ROW.id)).toBeNull();
  });

  it('carries the item count in the SAME statement — no second read per row', async () => {
    const { repository, bomHeader } = build();

    await repository.findByIdWithItemCount('tenant-a', ROW.id);

    // ONE statement asks for the row AND its count; a second query per row would be an
    // N+1 the report's detail has no business issuing.
    expect(bomHeader.findFirst).toHaveBeenCalledTimes(1);
    expect(bomHeader.findFirst.mock.calls[0][0].include).toEqual({
      _count: { select: { items: true } },
    });
    expect(bomHeader.findMany).not.toHaveBeenCalled();
    expect(bomHeader.count).not.toHaveBeenCalled();
  });
});

describe('BomHeaderRepository.countByStatus — the reporting summary aggregation', () => {
  it('aggregates over the SAME filter the list pages with, keyed by the stored status', async () => {
    const { repository, bomHeader } = build();
    bomHeader.groupBy.mockResolvedValueOnce([
      { status: 'DRAFT', _count: { _all: 3 } },
      { status: 'APPROVED', _count: { _all: 2 } },
    ]);

    const counts = await repository.countByStatus('tenant-a', {
      status: 'DRAFT',
      search: 'boiler',
    });

    expect(bomHeader.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { tenantId: 'tenant-a', status: 'DRAFT', title: { contains: 'boiler' } },
      _count: { _all: true },
    });
    expect(counts.get('DRAFT')).toBe(3);
    expect(counts.get('APPROVED')).toBe(2);
    // The Map carries ONLY what the database returned — zero-filling the closed lifecycle
    // set is the pure vocabulary's decision, not this method's.
    expect(counts.size).toBe(2);
  });

  it('keeps the tenant predicate even with no filter — an unfiltered summary is still scoped', async () => {
    const { repository, bomHeader } = build();

    await repository.countByStatus('tenant-a', {});

    expect(bomHeader.groupBy.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-a' });
  });
});
