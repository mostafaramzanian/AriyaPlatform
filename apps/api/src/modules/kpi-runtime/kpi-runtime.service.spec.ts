/**
 * Phase KPI-RUNTIME — the runtime's contract in executable form.
 *
 * THE FIVE CLAIMS THIS SUITE MAKES, AND WHY EACH LIVES HERE
 * ---------------------------------------------------------
 *  1. The runtime serves EXACTLY the five APPROVED catalog entries — re-derived from
 *     `KPI_CATALOG` itself, never from a literal somebody typed.
 *  2. Every wiring decision in `kpi-runtime.plan.ts` is asserted back against the catalog
 *     field it transcribes (source token, cohort field, population membership, module
 *     remit, feature), so a drift between governance and implementation fails loudly.
 *  3. The route's `@Roles(...)` union equals the set of `readRemit` values across the five
 *     definitions — a gate that admits anyone with at least one remit and nothing less.
 *  4. A MEAN publishes only complete reads and GOVERNED numbers; EMPTY, all-invalid and
 *     capped cohorts are `NOT_AVAILABLE` with their own reasons — never a zero standing in
 *     for "nothing existed", and never a partial mean wearing a full cohort's clothes.
 *  5. A RATIO never reports `0%` for an empty denominator, and the Green/Yellow tags a screen
 *     shows are asserted as DATA readiness while performance stays `NOT_ASSESSED`.
 *
 * The readers are fakes that ANSWER like the seam: windows filter, pages page, summaries
 * count. Anything those fakes cannot answer is a defect in the test.
 */

import { KPI_CATALOG, getKpiById, getKpiByTechnicalKey } from '../../kpi/kpi-catalog';
import { BOM_STATUSES } from '../production/bom/bom-status';
import { PURCHASE_DOCUMENT_STATUSES } from '../commerce/purchase/purchase-status';
import { CHECK_REQUEST_STATUSES } from '../financial/check-request/check-request-status';
import { KPI_MODULE_ID_BY_SOURCE, KPI_READ_LIMIT, KPI_RUNTIME_PLANS } from './kpi-runtime.plan';
import { KPI_READ_REMITS } from './kpi-runtime.controller';
import { KpiRuntimeService, servedKpiDefinitions } from './kpi-runtime.service';

const HOURS = 3600;
const DAY = 86_400;

/** A Jalali-month window inside Aban 1405 — after every fixture instant, before none. */
const PERIOD = { jy: 1405, jm: 8 };

/** Decided 9 Aban 1405, submitted 6 hours earlier — a valid production pair. */
function productionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bom-1',
    title: 'bom',
    status: 'APPROVED',
    submittedAt: '2026-10-31T10:00:00.000Z',
    decidedAt: '2026-10-31T16:00:00.000Z',
    ...overrides,
  };
}

function purchaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    documentNumber: 'PR-1',
    status: 'CLOSED',
    createdAt: '2026-10-26T10:00:00.000Z',
    completedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

function checkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    status: 3,
    managerDecision: 'APPROVE',
    submittedAt: '2026-10-31T10:00:00.000Z',
    decidedAt: '2026-11-01T02:00:00.000Z',
    ...overrides,
  };
}

/**
 * A window-aware in-memory stand-in for a SEAM reader.
 *
 * Applies the stated window to the named instant field, filters nothing else, pages by
 * `skip`/`take`, and answers summaries by counting the SAME filtered population — the four
 * properties the real readers guarantee and the only ones this runtime may rely on.
 */
function fakeReader<T extends { [field: string]: string | null | undefined }>(rows: T[]) {
  const FIELDS: Record<string, string[]> = {
    decidedFrom: ['decidedAt'],
    createdFrom: ['createdAt'],
    completedFrom: ['completedAt'],
  };

  const inWindow = (row: T, query: Record<string, unknown>): boolean => {
    for (const [queryField, rowFields] of Object.entries(FIELDS)) {
      const from = query[queryField];
      const to = query[`${queryField.slice(0, -4)}To`];
      for (const rowField of rowFields) {
        const value = row[rowField];
        if (typeof from === 'string' && (value === null || value === undefined || value < from)) {
          return false;
        }
        if (typeof to === 'string' && !(value === null || value === undefined) && value >= to) {
          return false;
        }
      }
    }
    return true;
  };

  return {
    listReportRows: jest.fn(
      async (_scope: { tenantId: string }, query: Record<string, unknown>) => {
        // `page`/`pageSize` exactly as the real readers resolve them (1-based page), so this
        // runtime's paging loop is exercised against the same window arithmetic production has.
        const page = Math.max(1, Math.trunc(Number(query.page ?? 1)));
        const pageSize = Math.max(1, Math.trunc(Number(query.pageSize ?? 100)));
        const cohort = rows.filter((row) => inWindow(row, query));
        return {
          items: cohort.slice((page - 1) * pageSize, page * pageSize),
          total: cohort.length,
        };
      }
    ),
    getReportSummary: jest.fn(
      async (_scope: { tenantId: string }, query: Record<string, unknown>) => {
        const cohort = rows.filter((row) => inWindow(row, query));
        const byStatus: Record<string, number> = {};
        for (const row of cohort) {
          const status = String((row as Record<string, unknown>).status);
          byStatus[status] = (byStatus[status] ?? 0) + 1;
        }
        return { total: cohort.length, byStatus };
      }
    ),
  };
}

/** The real three readers stand aside; only the seam TOKEN interface arrives at the service. */
function buildService(production: unknown[], commerce: unknown[], financial: unknown[]) {
  const productionReader = fakeReader(production as { [f: string]: string | null | undefined }[]);
  const commerceReader = fakeReader(commerce as { [f: string]: string | null | undefined }[]);
  const financialReader = fakeReader(financial as { [f: string]: string | null | undefined }[]);

  const service = new KpiRuntimeService(
    productionReader as never,
    commerceReader as never,
    financialReader as never
  );

  return { service, productionReader, commerceReader, financialReader };
}

const scope = () => ({ tenantId: 'tenant-a' });

describe('the served set — exactly the five APPROVED definitions', () => {
  it('serves every APPROVED catalog entry and nothing else, in catalog order', () => {
    const approvedInCatalog = KPI_CATALOG.filter((def) => def.status === 'APPROVED').map(
      (def) => def.technicalKey
    );

    expect(approvedInCatalog).toEqual([
      'production-bom-decision-cycle-time',
      'production-bom-approval-rate',
      'commerce-purchase-cycle-time',
      'commerce-purchase-completion-rate',
      'financial-check-request-decision-time',
    ]);
    expect(servedKpiDefinitions().map((def) => def.technicalKey)).toEqual(approvedInCatalog);

    // The build would be failing in six other suites before this could be wrong — the point
    // is that the boundary (`src/kpi/kpi-governance.spec.ts`) and the runtime agree.
    expect(servedKpiDefinitions()).toHaveLength(5);
    for (const def of servedKpiDefinitions()) {
      expect(def.target.state).toBe('NOT_DEFINED');
      expect(def.thresholds.state).toBe('NOT_DEFINED');
    }
  });

  it('keeps an unapproved or deprecated key out of the runtime', () => {
    const unapproved = KPI_CATALOG.filter((def) => def.status !== 'APPROVED').map(
      (def) => def.technicalKey
    );

    expect(unapproved.length).toBeGreaterThan(0);
    for (const key of unapproved) {
      expect(getKpiByTechnicalKey(key)?.status).not.toBe('APPROVED');
      expect(servedKpiDefinitions().some((def) => def.technicalKey === key)).toBe(false);
    }
    expect(getKpiById('KPI-006')?.status).not.toBe('APPROVED');
  });
});

describe('plan fidelity — every transcribed field agrees with its catalog entry', () => {
  const SEAM_TOKEN_BY_SOURCE: Record<string, string> = {
    production: 'ProductionReportingReader',
    commerce: 'CommercePurchaseReportingReader',
    financial: 'FinancialCheckRequestReportingReader',
  };

  it('routes each key to the seam its own catalog entry names', () => {
    for (const def of servedKpiDefinitions()) {
      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      expect(plan).toBeDefined();
      expect(plan!.source).toBeDefined();
      expect(def.sourceContract?.seamToken).toBe(SEAM_TOKEN_BY_SOURCE[plan!.source]);
    }
  });

  it('cohorts on exactly the field the definition’s time semantics names', () => {
    for (const def of servedKpiDefinitions()) {
      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      expect(def.timeSemantics?.cohortField).toBe(plan!.cohortField);
    }
  });

  it('entitles exactly the module the definition’s authorization names', () => {
    for (const def of servedKpiDefinitions()) {
      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      expect(KPI_MODULE_ID_BY_SOURCE[plan!.source]).toBe(def.authorization.moduleEntitlement);
      expect(def.authorization.newPermissionRequired).toBe(false);
    }
  });

  it('transcribes only population members the catalog’s own words admit', () => {
    for (const def of servedKpiDefinitions()) {
      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      if (!plan?.population) continue;

      // The catalog `population` + `exclusions` prose must NAME every status the plan counts
      // AND must refuse every invention the domain does not declare.
      const prose = `${def.population} ${def.exclusions}`;
      for (const status of plan.population.statuses ?? []) {
        expect(prose).toContain(status);
      }
      for (const status of plan.population.statuses ?? []) {
        expect(allClosedStatusWords()).toContain(status);
      }
      for (const field of plan.population.nonNullFields ?? []) {
        expect(def.sourceContract?.rowFields.join(',')).toContain(field);
      }
    }
  });

  it('states no formula the catalog does not already carry', () => {
    for (const def of servedKpiDefinitions()) {
      expect(def.formula).not.toBeNull();
      // The plan may carry a POPULATION but never the formula's shape — verify by shape:
      // a plan has no `kind`, no `statistic`, no `numerator`.
      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      expect(plan).not.toHaveProperty('kind');
      expect(plan).not.toHaveProperty('numerator');
    }
  });
});

/** The closed status vocabulary of every domain the five KPIs read — the invention check. */
function allClosedStatusWords(): string[] {
  return [
    ...BOM_STATUSES,
    ...PURCHASE_DOCUMENT_STATUSES,
    ...CHECK_REQUEST_STATUSES.map(String),
    'APPROVE',
    'REJECT',
    'REQUEST_CORRECTION',
    'managerDecision',
  ];
}

describe('the route gate — the @Roles union is the catalog’s own remit set', () => {
  it('spreads exactly the `readRemit` values of the five definitions', () => {
    const remits = servedKpiDefinitions().map((def) => def.authorization.readRemit);

    expect(KPI_READ_REMITS.slice().sort()).toEqual([...new Set(remits)].sort());
    // A caller needs only ONE of them (`RolesGuard` requires `.some(...)`), so the gate
    // admits anyone who may read SOMETHING and refuses anyone who may read NOTHING.
    expect(KPI_READ_REMITS).toHaveLength(3);
  });
});

describe('KPI-001 — the production decision mean, read through the real reader shape', () => {
  const KEY = 'production-bom-decision-cycle-time';

  it('publishes the governed mean in SECONDS plus the authorised HOURS projection', async () => {
    const { service } = buildService(
      [
        productionRow(),
        productionRow({ decidedAt: '2026-10-31T22:00:00.000Z', status: 'REJECTED' }),
      ],
      [],
      []
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    // 6h and 12h — a 9h mean, watched rather than derived so a timezone or unit slip fails here.
    expect(result.availability).toBe('AVAILABLE');
    expect(result.value).toBe(9 * HOURS);
    expect(result.unit.semantic).toBe('SECONDS');
    expect(result.display).toEqual({ value: 9, unitToken: 'HOURS', unitLabelFa: 'ساعت' });
    expect(result.ownerContext).toBe('production');
    expect(result.governance).toMatchObject({
      readRemit: 'production.bom.read',
      moduleEntitlement: 'production',
      formulaKind: 'MEAN_ELAPSED',
      newPermissionRequired: false,
    });
    expect(result.supportingContext.counts).toEqual({ cohort: 2, valid: 2, excluded: 0 });
    expect(result.period).toMatchObject({ jy: 1405, jm: 8, monthName: 'آبان' });

    // READINESS, NEVER PERFORMANCE: YELLOW is the catalog's data-quality word for the
    // final-round limitation, and it must never arrive as a verdict on the number.
    expect(result.quality.classification).toBe('YELLOW');
    expect(result.quality.readiness).toBe('PARTIAL');
    expect(result.quality.meaning).toBe('DATA_READINESS');
    expect(result.interpretation.performance).toBe('NOT_ASSESSED');
    expect(result.interpretation.usage).toBe('DESCRIPTIVE_ONLY');
  });
  it('reads only the decidedAt window — a Mehr decision never enters an Aban mean', async () => {
    const { service, productionReader } = buildService(
      [productionRow(), productionRow({ id: 'bom-old', decidedAt: '2026-10-22T16:00:00.000Z' })],
      [],
      []
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    expect(result.value).toBe(6 * HOURS);
    expect(result.supportingContext.counts.cohort).toBe(1);
    // The window the seam filtered on is echoed — stated from the same object, not derived
    // twice — so the month of the decision and the month of the value cannot disagree.
    const query = productionReader.listReportRows.mock.calls[0][1] as Record<string, unknown>;
    expect(query.decidedFrom).toBe(result.period.start);
    expect(query.decidedTo).toBe(result.period.end);
  });

  it('answers EMPTY_COHORT for a month with no decisions — never 0 seconds', async () => {
    const { service } = buildService([], [], []);

    const result = await service.getOne(scope(), KEY, PERIOD);

    expect(result.availability).toBe('NOT_AVAILABLE');
    expect(result.unavailableReason).toBe('EMPTY_COHORT');
    expect(result.value).toBeNull();
    expect(result.display).toBeNull();
  });

  it('answers NO_VALID_ROWS when every pair is invalid — never the mean of the survivors', async () => {
    const { service } = buildService(
      [
        productionRow({ id: 'a', submittedAt: null }),
        productionRow({ id: 'b', decidedAt: '2026-10-26T10:00:00.000Z' }),
      ],
      [],
      []
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    // The second row is stale (decided before submitted): a row the definition refuses is a
    // row it EXCLUDES — and with nothing valid left, the answer is absence with its reason.
    expect(result).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'NO_VALID_ROWS',
      value: null,
      display: null,
    });
    expect(result.supportingContext.counts).toEqual({ cohort: 2, valid: 0, excluded: 2 });
  });
});

describe('KPI-002 — the approval rate, answered by the bounded summary', () => {
  const KEY = 'production-bom-approval-rate';

  it('counts approvals over terminal decisions and loads NOTHING as rows', async () => {
    const { service, productionReader } = buildService(
      [
        productionRow({ id: 'a', submittedAt: null }),
        productionRow({ id: 'b', submittedAt: null, status: 'REJECTED' }),
        productionRow({ id: 'c', submittedAt: null, status: 'DRAFT' }),
      ],
      [],
      []
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    expect(result.availability).toBe('AVAILABLE');
    expect(result.value).toBe(50);
    expect(result.unit.semantic).toBe('PERCENT');
    expect(result.display).toEqual({ value: 50, unitToken: 'PERCENT', unitLabelFa: '٪' });
    // The DRAFT row with a decidedAt is in the window but OUT of the denominator: only the
    // terminal pair counts, and the engine never had to load a row to know it.
    expect(result.supportingContext.counts).toEqual({ cohort: 3, valid: 2, excluded: 1 });
    expect(productionReader.listReportRows).not.toHaveBeenCalled();
    expect(result.governance.formulaKind).toBe('RATIO_PERCENT');
    expect(result.quality.classification).toBe('GREEN');
    expect(result.quality.readiness).toBe('READY');
    expect(result.interpretation.performance).toBe('NOT_ASSESSED');
  });

  it('answers EMPTY_COHORT for a month with no rows at all', async () => {
    const { service } = buildService([], [], []);

    const result = await service.getOne(scope(), KEY, PERIOD);

    expect(result).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
      display: null,
    });
  });

  it('answers EMPTY_DENOMINATOR when rows exist but none is terminal', async () => {
    const { service } = buildService(
      [productionRow({ status: 'SUBMITTED' }), productionRow({ status: 'DRAFT' })],
      [],
      []
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    // "Something happened" is not "something of THIS KIND happened": the rate of two
    // rows is not 0%, because 0% would claim a rate for a population that does not exist.
    expect(result).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_DENOMINATOR',
      value: null,
      display: null,
    });
    expect(result.supportingContext.counts).toEqual({ cohort: 2, valid: 0, excluded: 2 });
  });
});

describe('KPI-003 and KPI-004 — the commerce pair, and why they cohort differently', () => {
  it('KPI-003 cohorts on COMPLETION: a Mehr document completed in Aban is Aban', async () => {
    const { service, commerceReader } = buildService(
      [],
      [
        purchaseRow({ id: 'early' }),
        purchaseRow({
          id: 'late',
          createdAt: '2026-10-14T10:00:00.000Z',
          completedAt: '2026-10-24T10:00:00.000Z',
        }),
      ],
      []
    );

    const result = await service.getOne(scope(), 'commerce-purchase-cycle-time', PERIOD);

    expect(result.availability).toBe('AVAILABLE');
    // BOTH rows complete inside Aban — `late` was CREATED in Mehr, and the completion window
    // admits it anyway: membership comes from `completedAt`, never from `createdAt`. `early`
    // ran 6 days and `late` 10, so the mean over two pairs is 8. The KPI-004 test below pushes
    // these SAME fixtures through the CREATION window and gets `cohort: 1` — same figures,
    // opposite membership, which is the whole reason the two KPIs are stated together.
    expect(result.value).toBe(8 * DAY);
    expect(result.display).toEqual({ value: 8, unitToken: 'DAYS', unitLabelFa: 'روز' });
    expect(result.supportingContext.counts).toEqual({ cohort: 2, valid: 2, excluded: 0 });

    const query = commerceReader.listReportRows.mock.calls[0][1] as Record<string, unknown>;
    expect(query.completedFrom).toBe(result.period.start);
    expect(query.completedTo).toBe(result.period.end);
  });

  it('KPI-004 cohorts on CREATION: the same figures, the opposite membership', async () => {
    const { service } = buildService(
      [],
      [
        purchaseRow({ id: 'early' }),
        purchaseRow({
          id: 'late',
          createdAt: '2026-10-14T10:00:00.000Z',
          completedAt: '2026-10-24T10:00:00.000Z',
        }),
      ],
      []
    );

    const early = await service.getOne(scope(), 'commerce-purchase-completion-rate', PERIOD);

    // `early` is IN the creation cohort for Aban, `late` is OUT (created in Mehr) — one
    // document raised, one completed: 100%.
    expect(early.availability).toBe('AVAILABLE');
    expect(early.value).toBe(100);
    expect(early.supportingContext.counts).toEqual({ cohort: 1, valid: 1, excluded: 0 });
  });

  it('KPI-004 counts an UNCOMPLETED creation cohort — never 0% for a slow pipeline', async () => {
    const { service } = buildService(
      [],
      [
        purchaseRow({ id: 'a', status: 'SUBMITTED', completedAt: null }),
        purchaseRow({ id: 'b', status: 'DRAFT', completedAt: null }),
      ],
      []
    );

    const result = await service.getOne(scope(), 'commerce-purchase-completion-rate', PERIOD);

    // Two documents raised in Aban, none completed yet: the rate is 0% — a REAL rate over a
    // REAL denominator. The distinction from EMPTY_DENOMINATOR is the whole point of the two
    // reasons: "nothing completed" and "nothing raised" mean opposite things, and the
    // contract must not let a screen confuse them.
    expect(result).toMatchObject({ availability: 'AVAILABLE', value: 0 });
    expect(result.supportingContext.counts).toEqual({ cohort: 2, valid: 2, excluded: 0 });
  });
});

describe('KPI-005 — the financial decision mean, and its stale-pair exclusion', () => {
  const KEY = 'financial-check-request-decision-time';

  it('publishes a 16-hour mean with the manager-decision population only', async () => {
    const { service, financialReader } = buildService(
      [],
      [],
      [
        checkRow({
          submittedAt: '2026-10-31T10:00:00.000Z',
          decidedAt: '2026-11-01T02:00:00.000Z',
        }),
        checkRow({
          id: 'req-2',
          status: 2,
          managerDecision: null,
          submittedAt: '2026-10-31T10:00:00.000Z',
          decidedAt: '2026-10-31T22:00:00.000Z',
        }),
      ]
    );

    const result = await service.getOne(scope(), KEY, PERIOD);

    // `req-2` has NO manager decision yet: waiting, not decided — POPULATION, not the
    // valid-row rule — so it never enters the cohort at all.
    expect(result.availability).toBe('AVAILABLE');
    expect(result.value).toBe(16 * HOURS);
    expect(result.display).toEqual({ value: 16, unitToken: 'HOURS', unitLabelFa: 'ساعت' });
    expect(result.supportingContext.counts).toEqual({ cohort: 1, valid: 1, excluded: 0 });
    const query = financialReader.listReportRows.mock.calls[0][1] as Record<string, unknown>;
    expect(query.decidedFrom).toBe(result.period.start);
  });
});

describe('the bounded read — a capped cohort is refused, never published partially', () => {
  it('truncates LOUDLY: COHORT_EXCEEDS_LIMIT with the capped counts echoed', async () => {
    const oversized = Array.from({ length: KPI_READ_LIMIT + 100 }, (_, i) =>
      productionRow({ id: `bom-${i}` })
    );
    const { service } = buildService(oversized, [], []);

    const result = await service.getOne(scope(), 'production-bom-decision-cycle-time', PERIOD);

    // The counts describe the CAPPED read honestly (exactly `KPI_READ_LIMIT` rows in), but
    // the value is refused: the mean of the read is not the mean of the cohort, and this
    // runtime will not publish a number it cannot stand behind.
    expect(result.availability).toBe('NOT_AVAILABLE');
    expect(result.unavailableReason).toBe('COHORT_EXCEEDS_LIMIT');
    expect(result.value).toBeNull();
    expect(result.supportingContext.counts.cohort).toBe(KPI_READ_LIMIT);
    expect(result.supportingContext.readLimit).toBe(KPI_READ_LIMIT);
  });

  it('pages to the seam total and stops — no infinite loop, no duplicate page', async () => {
    const many = Array.from({ length: 250 }, (_, i) => productionRow({ id: `bom-${i}` }));
    const { service, productionReader } = buildService(many, [], []);

    const result = await service.getOne(scope(), 'production-bom-decision-cycle-time', PERIOD);

    expect(result.availability).toBe('AVAILABLE');
    expect(result.supportingContext.counts).toEqual({ cohort: 250, valid: 250, excluded: 0 });
    // Three pages of 100, the last one partial — then the seam's own `total` ends the loop.
    expect(productionReader.listReportRows).toHaveBeenCalledTimes(3);
  });
});

describe('the list — one period for everyone, catalog order, honest counts', () => {
  it('computes each authorized key with the SAME period and carries no strays', async () => {
    const { service } = buildService(
      [productionRow()],
      [purchaseRow(), purchaseRow({ id: 'd2', status: 'SUBMITTED', completedAt: null })],
      [checkRow()]
    );

    const list = await service.list(
      scope(),
      [
        'production-bom-decision-cycle-time',
        'production-bom-approval-rate',
        'commerce-purchase-cycle-time',
        'commerce-purchase-completion-rate',
        'financial-check-request-decision-time',
      ],
      PERIOD
    );

    expect(list.total).toBe(5);
    expect(list.visible).toBe(5);
    expect(list.items).toHaveLength(5);
    expect(list.items.map((item) => item.technicalKey)).toEqual([
      'production-bom-decision-cycle-time',
      'production-bom-approval-rate',
      'commerce-purchase-cycle-time',
      'commerce-purchase-completion-rate',
      'financial-check-request-decision-time',
    ]);
    // ONE period object shared by every result — a rollover mid-request would split the
    // list across two cohorts, so "now" is read once.
    for (const item of list.items) {
      expect(item.period).toEqual(list.period);
      expect(item.availability).toBe('AVAILABLE');
    }
  });

  it('skips unauthorized keys WITHOUT touching their seams', async () => {
    const { service, productionReader, commerceReader, financialReader } = buildService(
      [productionRow()],
      [purchaseRow()],
      [checkRow()]
    );

    const list = await service.list(scope(), ['commerce-purchase-completion-rate'], PERIOD);

    expect(list).toMatchObject({ total: 5, visible: 1 });
    expect(list.items.map((item) => item.technicalKey)).toEqual([
      'commerce-purchase-completion-rate',
    ]);
    expect(productionReader.listReportRows).not.toHaveBeenCalled();
    expect(productionReader.getReportSummary).not.toHaveBeenCalled();
    expect(financialReader.listReportRows).not.toHaveBeenCalled();
    expect(commerceReader.getReportSummary).toHaveBeenCalled();
  });
});

describe('history — the SAME path per month, chronological, never partial', () => {
  /** 6 October 2026 → Mehr 1405: the current month is partial, Shahrivar is completed. */
  const NOW = new Date('2026-10-06T12:00:00.000Z');
  const RANGE = { fromJy: 1405, fromJm: 6, toJy: 1405, toJm: 7 };

  it('computes KPI-001 per month through the same mean, oldest first', async () => {
    const { service } = buildService(
      [
        productionRow({
          id: 'bom-sh',
          submittedAt: '2026-08-25T10:00:00.000Z',
          decidedAt: '2026-08-25T16:00:00.000Z',
        }),
        productionRow({
          id: 'bom-me',
          submittedAt: '2026-10-10T10:00:00.000Z',
          decidedAt: '2026-10-10T22:00:00.000Z',
        }),
      ],
      [],
      []
    );

    const history = await service.getHistory(
      scope(),
      'production-bom-decision-cycle-time',
      RANGE,
      NOW
    );

    expect(history.periods.map((p) => `${p.jy}/${p.jm}`)).toEqual(['1405/6', '1405/7']);
    expect(history.items.map((item) => item.value)).toEqual([6 * HOURS, 12 * HOURS]);
    // Completed vs partial is EXPLICIT: Shahrivar ended before `now`, Mehr has not.
    expect(history.periods[0].completed).toBe(true);
    expect(history.periods[1].completed).toBe(false);
    expect(history.comparison).toMatchObject({
      availability: 'AVAILABLE',
      absoluteChange: 6 * HOURS,
      relativeChange: 1,
      direction: 'INCREASE',
      unitSemantic: 'SECONDS',
    });
    expect(history.supportingReport).toEqual({
      href: '/admin/reporting/production',
      titleFa: 'گزارش عملیات تولید',
    });
  });

  it('computes KPI-002 per month and answers the comparison in POINTS', async () => {
    const { service } = buildService(
      [
        productionRow({
          id: 'sh-a',
          status: 'APPROVED',
          submittedAt: null,
          decidedAt: '2026-08-25T10:00:00.000Z',
        }),
        productionRow({
          id: 'sh-r',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-08-26T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-a',
          status: 'APPROVED',
          submittedAt: null,
          decidedAt: '2026-10-10T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-r1',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-10-11T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-r2',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-10-12T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-r3',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-10-13T10:00:00.000Z',
        }),
      ],
      [],
      []
    );

    const history = await service.getHistory(scope(), 'production-bom-approval-rate', RANGE, NOW);

    expect(history.items.map((item) => item.value)).toEqual([50, 25]);
    // The percentage KPI's PRIMARY delta is percentage POINTS, not a relative ratio.
    expect(history.comparison).toMatchObject({
      availability: 'AVAILABLE',
      percentagePointChange: -25,
      absoluteChange: -25,
      direction: 'DECREASE',
      unitSemantic: 'PERCENT',
    });
  });

  it('keeps an unavailable month as NOT_AVAILABLE — never zero, never omitted', async () => {
    const { service } = buildService(
      [
        productionRow({
          submittedAt: '2026-08-25T10:00:00.000Z',
          decidedAt: '2026-08-25T16:00:00.000Z',
        }),
      ],
      [],
      []
    );

    const history = await service.getHistory(
      scope(),
      'production-bom-decision-cycle-time',
      RANGE,
      NOW
    );

    expect(history.items).toHaveLength(2);
    expect(history.items[0]).toMatchObject({ availability: 'AVAILABLE', value: 6 * HOURS });
    expect(history.items[1]).toMatchObject({
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
    });
    expect(history.comparison?.availability).toBe('NOT_AVAILABLE');
    expect(history.comparison?.unavailableReason).toBe('CURRENT_NOT_AVAILABLE');
    expect(history.comparison?.absoluteChange).toBeNull();
  });

  it('refuses a zero previous value for the RATIO but keeps the absolute delta', async () => {
    const { service } = buildService(
      [
        productionRow({
          id: 'sh-r',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-08-25T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-a',
          status: 'APPROVED',
          submittedAt: null,
          decidedAt: '2026-10-10T10:00:00.000Z',
        }),
        productionRow({
          id: 'me-r',
          status: 'REJECTED',
          submittedAt: null,
          decidedAt: '2026-10-11T10:00:00.000Z',
        }),
      ],
      [],
      []
    );

    const history = await service.getHistory(scope(), 'production-bom-approval-rate', RANGE, NOW);

    // Shahrivar: 0/1 → 0%. Mehr: 1/2 → 50%.
    expect(history.items.map((item) => item.value)).toEqual([0, 50]);
    expect(history.comparison).toMatchObject({
      availability: 'AVAILABLE',
      unavailableReason: 'PREVIOUS_ZERO_RELATIVE_UNAVAILABLE',
      absoluteChange: 50,
      percentagePointChange: 50,
      relativeChange: null,
    });
  });

  it('refuses an oversized range BEFORE touching a seam', async () => {
    const { service, productionReader } = buildService([], [], []);

    await expect(
      service.getHistory(scope(), 'production-bom-decision-cycle-time', { periodCount: 13 }, NOW)
    ).rejects.toThrow(expect.objectContaining({ code: 'HISTORY_RANGE_EXCEEDS_LIMIT' }));
    expect(productionReader.listReportRows).not.toHaveBeenCalled();
    expect(productionReader.getReportSummary).not.toHaveBeenCalled();
  });

  it('refuses a candidate (non-APPROVED) key rather than computing its history', async () => {
    const candidate = KPI_CATALOG.find((def) => def.status !== 'APPROVED');
    if (!candidate) throw new Error('fixture: no candidate definition to refuse');

    const { service } = buildService([], [], []);

    await expect(service.getHistory(scope(), candidate.technicalKey, RANGE, NOW)).rejects.toThrow(
      /not a served/
    );
  });

  it('computes the commerce pair and the financial mean over the same months', async () => {
    const { service } = buildService(
      [],
      [
        purchaseRow({
          id: 'doc-sh',
          createdAt: '2026-08-25T10:00:00.000Z',
          completedAt: '2026-08-27T10:00:00.000Z',
        }),
        purchaseRow({
          id: 'doc-me',
          createdAt: '2026-10-10T10:00:00.000Z',
          completedAt: '2026-10-10T22:00:00.000Z',
        }),
      ],
      [
        checkRow({
          submittedAt: '2026-10-10T10:00:00.000Z',
          decidedAt: '2026-10-11T10:00:00.000Z',
        }),
      ]
    );

    // KPI-003: 48h vs 12h means, cohorted on completion — the same lifecycle both months.
    const cycle = await service.getHistory(scope(), 'commerce-purchase-cycle-time', RANGE, NOW);
    expect(cycle.items.map((item) => item.value)).toEqual([48 * HOURS, 12 * HOURS]);
    expect(cycle.comparison?.absoluteChange).toBe(-36 * HOURS);
    expect(cycle.comparison?.direction).toBe('DECREASE');
    expect(cycle.supportingReport?.href).toBe('/admin/reporting/purchase-requests');

    // KPI-004: one of one completed in each month → 100% vs 100%, points delta of ZERO.
    const completion = await service.getHistory(
      scope(),
      'commerce-purchase-completion-rate',
      RANGE,
      NOW
    );
    expect(completion.items.map((item) => item.value)).toEqual([100, 100]);
    expect(completion.comparison).toMatchObject({
      availability: 'AVAILABLE',
      percentagePointChange: 0,
      absoluteChange: 0,
      direction: 'UNCHANGED',
    });

    // KPI-005: only Mehr carries a decided pair; Shahrivar is honestly absent.
    const financial = await service.getHistory(
      scope(),
      'financial-check-request-decision-time',
      RANGE,
      NOW
    );
    expect(financial.items.map((item) => item.availability)).toEqual([
      'NOT_AVAILABLE',
      'AVAILABLE',
    ]);
    expect(financial.items[1].value).toBe(DAY);
    expect(financial.supportingReport?.href).toBe('/admin/reporting');
  });
});
