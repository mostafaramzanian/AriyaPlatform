/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the history range resolver contract.
 * Jalali month walking, bounded, oldest-first. No seam, no formula.
 */
import { KPI_HISTORY_MAX_PERIODS } from './kpi-runtime.plan';
import {
  HISTORY_INVALID_RANGE,
  HISTORY_RANGE_EXCEEDS_LIMIT,
  resolveHistoryMonths,
} from './kpi-runtime.history';

const NOW = new Date('2026-10-06T12:00:00.000Z');

describe('KPI history range — the default bounded run', () => {
  it('returns six months ending at the current month, oldest first', () => {
    const months = resolveHistoryMonths({}, NOW);
    expect(months).toHaveLength(6);
    expect(months[months.length - 1]).toEqual({ jy: 1405, jm: 7 });
    for (let i = 1; i < months.length; i += 1) {
      const prev = months[i - 1];
      const cur = months[i];
      if (!prev || !cur) throw new Error('fixture: history month missing');
      const expectedNext =
        cur.jm === 1 ? { jy: cur.jy - 1, jm: 12 } : { jy: cur.jy, jm: cur.jm - 1 };
      expect(prev).toEqual(expectedNext);
    }
  });

  it('refuses fewer than two periods and more than the ceiling', () => {
    expect(() => resolveHistoryMonths({ periodCount: 1 }, NOW)).toThrow(
      expect.objectContaining({ code: HISTORY_INVALID_RANGE })
    );
    expect(() => resolveHistoryMonths({ periodCount: KPI_HISTORY_MAX_PERIODS + 1 }, NOW)).toThrow(
      expect.objectContaining({ code: HISTORY_RANGE_EXCEEDS_LIMIT })
    );
  });
});

describe('KPI history range — explicit from/to months', () => {
  it('walks Mehr to Aban inclusively', () => {
    expect(resolveHistoryMonths({ fromJy: 1405, fromJm: 7, toJy: 1405, toJm: 8 }, NOW)).toEqual([
      { jy: 1405, jm: 7 },
      { jy: 1405, jm: 8 },
    ]);
  });

  it('refuses an inverted range and an oversized explicit range', () => {
    expect(() =>
      resolveHistoryMonths({ fromJy: 1405, fromJm: 8, toJy: 1405, toJm: 7 }, NOW)
    ).toThrow(expect.objectContaining({ code: HISTORY_INVALID_RANGE }));
    expect(() =>
      resolveHistoryMonths({ fromJy: 1404, fromJm: 1, toJy: 1405, toJm: 8 }, NOW)
    ).toThrow(expect.objectContaining({ code: HISTORY_RANGE_EXCEEDS_LIMIT }));
  });
});
