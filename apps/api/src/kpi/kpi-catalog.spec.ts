/**
 * KPI definition tests (§29): definition integrity, formula integrity, status integrity.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 *  1. Integrity of the catalog: nine entries, unique KPI IDs, unique technical keys, and a
 *     passing `validateKpiRegistry` run — i.e. every APPROVED entry satisfies every §22
 *     quality gate and every BLOCKED/DRAFT entry documents its reason.
 *  2. Status integrity: an incomplete definition CANNOT be marked APPROVED — the suite builds
 *     a definition with one required part removed and asserts the validator refuses it.
 *  3. Formula integrity: deterministic fixture examples for the approved formula shapes.
 *     The fixture math below lives ONLY in this spec file (pure local helpers) — it is a
 *     test artifact, not a runtime calculation engine (§29, §26).
 *
 * The expected deterministic values were computed by hand before implementation:
 *  - approval-style ratio 8/(8+2) = 0.8 → 80%
 *  - completion-style ratio 3/10 = 0.3 → 30%
 *  - mean elapsed over [(00:00→12:00), (00:00→06:00)] = (43200+21600)/2 = 32400 s
 *  - zero-denominator ratios and all-invalid duration sets yield NOT_AVAILABLE (null),
 *    never 0.
 */

import { KPI_CATALOG, getKpiById, getKpiByTechnicalKey } from './kpi-catalog';
import { kpiApprovalIssues, validateKpiRegistry } from './kpi-definition.model';
import type { AnyKpiDefinition } from './kpi-catalog';

/** Fixture-only ratio helper: percent, or null when there is nothing to divide. */
function ratioPercentFixture(numerator: number, denominator: number): number | null {
  if (!Number.isInteger(numerator) || numerator < 0) throw new Error('fixture: bad numerator');
  if (!Number.isInteger(denominator) || denominator < 0) {
    throw new Error('fixture: bad denominator');
  }
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

interface ElapsedPairFixture {
  fromMs: number;
  toMs: number | null;
}

/** Fixture-only mean helper: invalid pairs are excluded, never zeroed. */
function meanElapsedSecondsFixture(pairs: readonly ElapsedPairFixture[]): number | null {
  const valid = pairs
    .filter(
      (pair): pair is { fromMs: number; toMs: number } =>
        typeof pair.toMs === 'number' && pair.toMs >= pair.fromMs
    )
    .map((pair) => (pair.toMs - pair.fromMs) / 1000);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

describe('KPI catalog — definition integrity (§29)', () => {
  it('holds exactly the nine governed definitions, with unique ids and technical keys', () => {
    expect(KPI_CATALOG).toHaveLength(9);
    expect(validateKpiRegistry(KPI_CATALOG)).toEqual([]);
    expect(new Set(KPI_CATALOG.map((entry) => entry.id)).size).toBe(9);
    expect(new Set(KPI_CATALOG.map((entry) => entry.technicalKey)).size).toBe(9);
  });

  it('exposes lookups that return undefined for unknown ids/keys instead of guessing', () => {
    expect(getKpiById('KPI-001')?.technicalKey).toBe('production-bom-decision-cycle-time');
    expect(getKpiById('KPI-999')).toBeUndefined();
    expect(getKpiByTechnicalKey('commerce-purchase-completion-rate')?.id).toBe('KPI-004');
    expect(getKpiByTechnicalKey('no-such-kpi')).toBeUndefined();
  });

  it('passes every §22 gate on every APPROVED entry', () => {
    const approved = KPI_CATALOG.filter((entry) => entry.status === 'APPROVED');
    expect(approved.map((entry) => entry.id).sort()).toEqual([
      'KPI-001',
      'KPI-002',
      'KPI-003',
      'KPI-004',
      'KPI-005',
    ]);
    for (const entry of approved) {
      expect(kpiApprovalIssues(entry as AnyKpiDefinition)).toEqual([]);
    }
  });

  it('keeps every candidate and blocked entry honest (reason + open questions)', () => {
    const byId = (id: string): AnyKpiDefinition => {
      const entry = getKpiById(id);
      if (!entry) throw new Error(`fixture: catalog lost ${id}`);
      return entry;
    };
    expect(byId('KPI-006').status).toBe('DRAFT');
    expect(byId('KPI-006').openQuestions.length).toBeGreaterThan(0);
    expect(byId('KPI-007').status).toBe('DRAFT');
    expect(byId('KPI-007').openQuestions.length).toBeGreaterThan(0);
    expect(byId('KPI-008').status).toBe('EVIDENCE_REVIEW');
    expect(byId('KPI-008').openQuestions.length).toBeGreaterThan(0);
    expect(byId('KPI-009').status).toBe('BLOCKED');
    expect(typeof byId('KPI-009').blockedReason === 'string').toBe(true);
  });

  it('never invents a target or threshold: every entry is explicitly NOT_DEFINED', () => {
    for (const entry of KPI_CATALOG) {
      expect(entry.target.state).toBe('NOT_DEFINED');
      expect(entry.thresholds.state).toBe('NOT_DEFINED');
      expect(entry.thresholds.items).toEqual([]);
    }
  });

  it('scopes every entry to the current authenticated tenant and adds no permission', () => {
    for (const entry of KPI_CATALOG) {
      expect(entry.scope).toBe('CURRENT_AUTHENTICATED_TENANT');
      expect(entry.authorization.newPermissionRequired).toBe(false);
    }
  });

  it('refuses to approve an incomplete definition (status integrity)', () => {
    const complete = getKpiById('KPI-002');
    if (!complete) throw new Error('fixture: catalog lost KPI-002');
    expect(kpiApprovalIssues(complete as AnyKpiDefinition)).toEqual([]);

    const missingOwner = { ...complete, businessOwner: '   ' };
    expect(kpiApprovalIssues(missingOwner as AnyKpiDefinition)).toContain(
      'businessOwner is required (§16)'
    );

    const strippedFormula = { ...complete, formula: null };
    expect(kpiApprovalIssues(strippedFormula as AnyKpiDefinition)).toContain(
      'a structural formula is required for approval (§23)'
    );

    const strippedTime = { ...complete, timeSemantics: null };
    expect(kpiApprovalIssues(strippedTime as AnyKpiDefinition)).toContain(
      'time semantics are required for approval (§18)'
    );

    const stillOpen = { ...complete, openQuestions: ['who approves this?'] };
    expect(kpiApprovalIssues(stillOpen as AnyKpiDefinition)).toContain(
      'an APPROVED KPI must not carry open questions (§22)'
    );
  });

  it('rejects duplicate ids and keys at the registry gate', () => {
    const first = KPI_CATALOG[0];
    if (!first) throw new Error('fixture: catalog is empty');
    const duplicated = [...KPI_CATALOG, { ...first }];
    const issues = validateKpiRegistry(duplicated as AnyKpiDefinition[]);
    expect(issues.some((issue) => issue.includes('duplicate KPI id'))).toBe(true);
    expect(issues.some((issue) => issue.includes('duplicate technical key'))).toBe(true);
  });
});

describe('KPI catalog — formula fixtures (§29, test numbers, not production data)', () => {
  it('computes approval-style ratios: approved=8, rejected=2 → 80%', () => {
    expect(ratioPercentFixture(8, 8 + 2)).toBe(80);
  });

  it('computes completion-style ratios: closed=3, created=10 → 30%', () => {
    expect(ratioPercentFixture(3, 10)).toBe(30);
  });

  it('computes mean decision time: 12h + 6h pairs → 32400 s', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      meanElapsedSecondsFixture([
        { fromMs: base, toMs: base + 12 * 3600 * 1000 },
        { fromMs: base, toMs: base + 6 * 3600 * 1000 },
      ])
    ).toBe(32400);
  });

  it('computes mean purchase cycle: 48h + 12h pairs → 108000 s', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      meanElapsedSecondsFixture([
        { fromMs: base, toMs: base + 48 * 3600 * 1000 },
        { fromMs: base, toMs: base + 12 * 3600 * 1000 },
      ])
    ).toBe(108000);
  });

  it('excludes null and negative pairs instead of zero-filling them', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(
      meanElapsedSecondsFixture([
        { fromMs: base, toMs: base + 2 * 3600 * 1000 },
        { fromMs: base, toMs: null },
        { fromMs: base + 3600 * 1000, toMs: base },
      ])
    ).toBe(7200);
  });

  it('returns NOT_AVAILABLE (null) for empty denominators and all-invalid pairs', () => {
    expect(ratioPercentFixture(0, 0)).toBeNull();
    expect(ratioPercentFixture(8, 0)).toBeNull();
    expect(meanElapsedSecondsFixture([])).toBeNull();
    expect(meanElapsedSecondsFixture([{ fromMs: 1000, toMs: 500 }])).toBeNull();
  });

  it('pins the registry formula shapes to closed, non-executable kinds', () => {
    const kinds = new Set(KPI_CATALOG.map((entry) => entry.formula?.kind ?? 'NONE'));
    for (const kind of kinds) {
      expect(['MEAN_ELAPSED', 'RATIO_PERCENT', 'NONE']).toContain(kind);
    }
    const kpi002 = getKpiById('KPI-002');
    if (!kpi002?.formula || kpi002.formula.kind !== 'RATIO_PERCENT') {
      throw new Error('fixture: KPI-002 lost its RATIO_PERCENT formula');
    }
    expect(kpi002.formula.zeroDenominator).toBe('NOT_AVAILABLE');
    const kpi001 = getKpiById('KPI-001');
    if (!kpi001?.formula || kpi001.formula.kind !== 'MEAN_ELAPSED') {
      throw new Error('fixture: KPI-001 lost its MEAN_ELAPSED formula');
    }
    expect(kpi001.formula.statistic).toBe('MEAN');
  });
});
