/**
 * Phase KPI-RUNTIME — the structural evaluator's contract. Four claims, one per group:
 * a mean admits only the rows the catalog's two rules admit; an EXCLUDED row is never
 * zero-filled; an empty denominator yields `null` and never `0` (`zeroDenominator:
 * 'NOT_AVAILABLE'` is a governance rule, not a rounding choice); and anything the evaluator
 * cannot answer THROWS rather than returning a plausible number.
 *
 * Fixtures carry ONLY the fields the definition they exercise names, so a test that passed
 * without the field it claims to read would fail on `undefined` rather than on luck.
 */

import { applyPopulation, evaluateMeanElapsed, evaluateRatioPercent } from './kpi-runtime.engine';

const HOURS = 3600;
const ISO = (offsetSeconds: number, base = '2026-02-01T00:00:00.000Z') =>
  new Date(new Date(base).getTime() + offsetSeconds * 1000).toISOString();

describe('MEAN_ELAPSED — the arithmetic mean of admitted elapsed pairs', () => {
  const formula = { from: 'submittedAt', to: 'decidedAt' };

  it('averages only the rows both instants admit, in exact seconds', () => {
    const outcome = evaluateMeanElapsed(formula, { statuses: ['APPROVED'] }, [
      { submittedAt: ISO(0), decidedAt: ISO(2 * HOURS), status: 'APPROVED' },
      { submittedAt: ISO(0), decidedAt: ISO(4 * HOURS), status: 'APPROVED' },
    ]);

    expect(outcome).toEqual({
      cohortRows: 2,
      validRows: 2,
      excludedRows: 0,
      meanSeconds: 3 * HOURS,
    });
  });

  it('EXCLUDES a row missing either instant — never counts it as zero', () => {
    const outcome = evaluateMeanElapsed(formula, { statuses: ['APPROVED'] }, [
      { submittedAt: ISO(0), decidedAt: ISO(2 * HOURS), status: 'APPROVED' },
      { submittedAt: ISO(0), decidedAt: null, status: 'APPROVED' },
      { submittedAt: null, decidedAt: ISO(6 * HOURS), status: 'APPROVED' },
    ]);

    // One valid row, not three: the excluded two are REPORTED as excluded rather than
    // silently contributing 0s that would drag the mean down and read as "fast".
    expect(outcome.validRows).toBe(1);
    expect(outcome.excludedRows).toBe(2);
    expect(outcome.meanSeconds).toBe(2 * HOURS);
  });

  it('EXCLUDES a stale pair (to before from) instead of flooring it at zero', () => {
    const outcome = evaluateMeanElapsed(formula, { statuses: ['APPROVED'] }, [
      { submittedAt: ISO(0), decidedAt: ISO(1 * HOURS), status: 'APPROVED' },
      // The resubmission case KPI-001/KPI-005 both document: `decidedAt` still belongs to the
      // PREVIOUS round while `submittedAt` was rewritten.
      { submittedAt: ISO(10 * HOURS), decidedAt: ISO(1 * HOURS), status: 'APPROVED' },
    ]);

    expect(outcome).toEqual({
      cohortRows: 2,
      validRows: 1,
      excludedRows: 1,
      meanSeconds: 1 * HOURS,
    });
  });

  it('treats an EQUAL pair as valid — a same-instant decision is zero elapsed, not stale', () => {
    const outcome = evaluateMeanElapsed(formula, {}, [{ submittedAt: ISO(0), decidedAt: ISO(0) }]);

    expect(outcome.validRows).toBe(1);
    expect(outcome.meanSeconds).toBe(0);
  });

  it('returns NULL for an empty population — there is no mean of nothing', () => {
    const outcome = evaluateMeanElapsed(formula, { statuses: ['APPROVED'] }, [
      { submittedAt: ISO(0), decidedAt: ISO(HOURS), status: 'REJECTED' },
    ]);

    expect(outcome).toEqual({ cohortRows: 0, validRows: 0, excludedRows: 0, meanSeconds: null });
  });

  it('REFUSES a field that is present but not an instant — corruption, not absence', () => {
    // `null` means "no instant was ever written"; a non-date string means a projection
    // problem. Demoting the second to the first would halve a cohort silently.
    expect(() =>
      evaluateMeanElapsed(formula, {}, [{ submittedAt: 'not-a-date', decidedAt: ISO(0) }])
    ).toThrow(/not a parseable instant/);
  });
});

describe('population — the membership a MEAN definition states but its formula cannot', () => {
  it('keeps only the lifecycle members the definition counts', () => {
    const rows = [
      { status: 'APPROVED', submittedAt: ISO(0), decidedAt: ISO(HOURS) },
      { status: 'REJECTED', submittedAt: ISO(0), decidedAt: ISO(3 * HOURS) },
      // Returned for correction, then re-submitted: it carries a STALE `decidedAt` inside the
      // window and must not enter a decision-time mean.
      { status: 'DRAFT', submittedAt: ISO(0), decidedAt: ISO(2 * HOURS) },
      { status: 'SUBMITTED', submittedAt: ISO(0), decidedAt: ISO(2 * HOURS) },
    ];

    const outcome = evaluateMeanElapsed(
      { from: 'submittedAt', to: 'decidedAt' },
      { statuses: ['APPROVED', 'REJECTED'] },
      rows
    );

    expect(outcome.cohortRows).toBe(2);
    expect(outcome.meanSeconds).toBe(2 * HOURS);
  });

  it('keeps only rows carrying a required non-null field', () => {
    const rows = [
      { managerDecision: 'APPROVE', submittedAt: ISO(0), decidedAt: ISO(HOURS) },
      { managerDecision: 'REJECT', submittedAt: ISO(0), decidedAt: ISO(3 * HOURS) },
      { managerDecision: null, submittedAt: ISO(0), decidedAt: ISO(9 * HOURS) },
      { submittedAt: ISO(0), decidedAt: ISO(9 * HOURS) },
    ];

    const outcome = evaluateMeanElapsed(
      { from: 'submittedAt', to: 'decidedAt' },
      { nonNullFields: ['managerDecision'] },
      rows
    );

    expect(outcome.cohortRows).toBe(2);
    expect(outcome.meanSeconds).toBe(2 * HOURS);
  });

  it('applies NO filter when the definition states none', () => {
    expect(applyPopulation({}, [{ status: 'DRAFT' }, { status: 'CLOSED' }])).toHaveLength(2);
    expect(applyPopulation({ statuses: ['CLOSED'] }, [{ status: 'DRAFT' }])).toHaveLength(0);
  });
});

describe('RATIO_PERCENT — a rate over the seam’s bounded counts', () => {
  const counts = { total: 8, byStatus: { APPROVED: 3, REJECTED: 5 } };

  it('sums the named members for both halves', () => {
    const outcome = evaluateRatioPercent(
      {
        numerator: { dimension: 'status', oneOf: ['APPROVED'] },
        denominator: { dimension: 'status', oneOf: ['APPROVED', 'REJECTED'] },
      },
      counts
    );

    expect(outcome).toEqual({ numerator: 3, denominator: 8, percent: 37.5 });
  });

  it('uses the summary total for an `{ all: true }` denominator', () => {
    const outcome = evaluateRatioPercent(
      {
        numerator: { dimension: 'status', oneOf: ['CLOSED'] },
        denominator: { dimension: 'status', all: true },
      },
      { total: 4, byStatus: { CLOSED: 1, DRAFT: 3 } }
    );

    expect(outcome).toEqual({ numerator: 1, denominator: 4, percent: 25 });
  });

  it('returns NULL — not 0 — for an empty denominator', () => {
    // The governance rule in executable form: "no decisions existed" and "no approvals
    // existed" are opposite findings, and only the second one is a rate.
    const outcome = evaluateRatioPercent(
      {
        numerator: { dimension: 'status', oneOf: ['APPROVED'] },
        denominator: { dimension: 'status', oneOf: ['APPROVED', 'REJECTED'] },
      },
      { total: 3, byStatus: { DRAFT: 3 } }
    );

    expect(outcome).toEqual({ numerator: 0, denominator: 0, percent: null });
  });

  it('never rounds — the governed value is the exact quotient', () => {
    const outcome = evaluateRatioPercent(
      {
        numerator: { dimension: 'status', oneOf: ['APPROVED'] },
        denominator: { dimension: 'status', oneOf: ['APPROVED', 'REJECTED'] },
      },
      { total: 3, byStatus: { APPROVED: 1, REJECTED: 2 } }
    );

    expect(outcome.percent).toBeCloseTo(33.333333333333336, 12);
  });

  it('REFUSES a dimension these counts cannot answer', () => {
    expect(() =>
      evaluateRatioPercent(
        {
          numerator: { dimension: 'source', oneOf: ['x'] },
          denominator: { dimension: 'status', all: true },
        },
        counts
      )
    ).toThrow(/cannot be answered from status counts/);
  });
});
