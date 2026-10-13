import { formatLetterNumber, LetterNumberService } from './letter-number.service';

/**
 * Phase 50: the numbering contract. The FORMAT is pinned here; the ATOMICITY is a
 * database behaviour (INSERT … ON CONFLICT DO UPDATE … RETURNING) covered by the
 * integration suite — the unit suite must never claim to prove what only Postgres
 * can prove.
 */
describe('formatLetterNumber', () => {
  it('formats AR-{JalaliYear}-{5-digit sequence}', () => {
    expect(formatLetterNumber('AR', 1405, 42)).toBe('AR-1405-00042');
  });

  it('pads to exactly five digits', () => {
    expect(formatLetterNumber('AR', 1405, 1)).toBe('AR-1405-00001');
    expect(formatLetterNumber('AR', 1405, 123456)).toBe('AR-1405-123456');
  });

  it('is deterministic: same inputs, same number, always', () => {
    const a = formatLetterNumber('AR', 1404, 999);
    const b = formatLetterNumber('AR', 1404, 999);
    expect(a).toBe(b);
    expect(a).toBe('AR-1404-00999');
  });
});

describe('LetterNumberService allocation', () => {
  it('raises one atomic raw query carrying the tenant and Jalali year', async () => {
    const rows = [{ counter: 7 }];
    const $queryRaw = jest.fn().mockResolvedValue(rows);
    const service = new LetterNumberService({ $queryRaw } as never);

    const now = new Date('2026-03-21T00:00:00Z'); // Farvardin 1, 1405
    const result = await service.allocateNext('tenant-1', now);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(result.counter).toBe(7);
    expect(result.year).toBe(1405);
    expect(result.letterNumber).toBe('AR-1405-00007');
  });

  it('refuses to mint a number when the database returns nothing', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const service = new LetterNumberService({ $queryRaw } as never);

    await expect(service.allocateNext('tenant-1', new Date())).rejects.toThrow(
      'Letter number allocation failed',
    );
  });

  it('derives the Jalali year server-side from the send instant, never from a client value', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ counter: 1 }]);
    const service = new LetterNumberService({ $queryRaw } as never);

    // 2026-03-19T20:30:00Z is 1404/12/28 in Tehran (before Nowruz 1405).
    const result = await service.allocateNext('tenant-1', new Date('2026-03-19T20:30:00Z'));
    expect(result.year).toBe(1404);
  });
});