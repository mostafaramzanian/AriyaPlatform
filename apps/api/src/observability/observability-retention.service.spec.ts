import { Logger } from '@nestjs/common';
import { ObservabilityRetentionService, DELETE_CHUNK_SIZE, MAX_CHUNKS_PER_RUN, RETENTION_TICK_MS, RETENTION_START_DELAY_MS } from './observability-retention.service';
import { ObservabilityConfigService, RETENTION_DISABLED, RetentionCategory } from './observability.config';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';

/**
 * Phase 49M-2 §22: retention deletes what it should, records what it did, and stops.
 *
 * WHAT THIS FILE PROVES, and why each property is worth a test:
 *
 *  - `0` MEANS NEVER DELETE. This is the single most dangerous value in the phase: under a
 *    naive `Math.max(1, days)` clamp an operator writing `AUDIT_RETENTION_DAYS=0` to mean
 *    "keep forever" would get a cutoff of yesterday and lose two years of audit history on the
 *    next pass. The test asserts NO `$executeRaw` AND no `RetentionRun` row — a bookkeeping row
 *    for a disabled category would read as a healthy pass that found nothing to delete, hiding
 *    the fact that pruning is switched off for that table.
 *  - EXACTLY ONE `RetentionRun` ROW PER PASS, INCLUDING A FAILED PASS. A retention table that
 *    records only successes cannot answer the question it exists for — "is retention actually
 *    running?" — because a silent absence of rows looks identical to a healthy system.
 *  - DELETION IS BOUNDED IN BOTH DIRECTIONS: `DELETE_CHUNK_SIZE` rows per statement so no
 *    single transaction holds locks over a million rows, and `MAX_CHUNKS_PER_RUN` chunks per
 *    pass so one tick can never become a delete storm. Hitting that ceiling must be reported as
 *    `truncated`, never as completion.
 *  - ONE CATEGORY'S FAILURE DOES NOT ABORT THE OTHERS, and `tick()` never throws.
 *  - IT NEVER TOUCHES core_db. Every statement names one of the four observability tables;
 *    `AuditLog` (35,757 rows, out of scope by §51) is asserted to be unreachable from here.
 *  - THE TIMERS ARE `unref`'d AND THE LOOP IS OFF WHEN THE PLATFORM IS DISABLED, so a pending
 *    timer can never hold the process — or a Jest run — open.
 */

/** Production defaults, so the doubles agree with `observability.config.ts` by construction. */
const DEFAULT_DAYS: Record<RetentionCategory, number> = {
  application_log: 30,
  audit_event: 730,
  security_event: 365,
  lifecycle_event: 90,
};

/** The four categories in the order `tick()` walks them. */
const CATEGORIES: RetentionCategory[] = [
  'application_log',
  'audit_event',
  'security_event',
  'lifecycle_event',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed clock, so `cutoff` is an exact expected value rather than a tolerance window. */
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

function makeConfig(days: Partial<Record<RetentionCategory, number>> = {}, enabled = true) {
  const resolved = { ...DEFAULT_DAYS, ...days };
  return {
    enabled,
    retention: {
      applicationLogDays: resolved.application_log,
      auditEventDays: resolved.audit_event,
      securityEventDays: resolved.security_event,
      lifecycleEventDays: resolved.lifecycle_event,
    },
    retentionDaysFor: (category: RetentionCategory) => resolved[category],
  } as unknown as ObservabilityConfigService;
}

function makePrisma(executeRaw: jest.Mock, create: jest.Mock) {
  return {
    $executeRaw: executeRaw,
    retentionRun: { create },
  } as unknown as ObservabilityPrismaService;
}

/** The SQL text of one `$executeRaw` tagged-template call, joined back together. */
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

describe('ObservabilityRetentionService', () => {
  let executeRaw: jest.Mock;
  let create: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // One short chunk by default: the loop deletes once and stops, which is the steady state.
    executeRaw = jest.fn().mockResolvedValue(1);
    create = jest.fn().mockResolvedValue({ id: 'run-1' });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const build = (config = makeConfig()) =>
    new ObservabilityRetentionService(makePrisma(executeRaw, create), config);

  /** Puts the service in the state `tick()` requires without starting real timers. */
  const started = (config = makeConfig()) => {
    // `now: NOW` matters: modern fake timers REPLACE the global `Date`, which would otherwise
    // bypass the `Date.now` spy and make every cutoff assertion depend on the wall clock.
    jest.useFakeTimers({ now: NOW });
    const service = build(config);
    service.onModuleInit();
    return service;
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RETENTION_DISABLED — the dangerous value
  // ───────────────────────────────────────────────────────────────────────────

  describe('a disabled category (0 days)', () => {
    it('deletes nothing AND writes no RetentionRun row', async () => {
      const service = build(makeConfig({ audit_event: RETENTION_DISABLED }));

      await service.runCategory('audit_event');

      // No DELETE: 0 means "keep forever", never "everything is older than now".
      expect(executeRaw).not.toHaveBeenCalled();
      // And no bookkeeping row either — one showing `deletedCount: 0, succeeded: true` would be
      // indistinguishable from a healthy pass and would hide that pruning is off.
      expect(create).not.toHaveBeenCalled();
    });

    it('leaves the other three categories running', async () => {
      const service = started(makeConfig({ audit_event: RETENTION_DISABLED }));

      await service.tick();

      expect(create).toHaveBeenCalledTimes(3);
      const written = create.mock.calls.map((call) => call[0].data.category);
      expect(written).toEqual(['application_log', 'security_event', 'lifecycle_event']);
      expect(written).not.toContain('audit_event');
    });

    it('treats 0 as disabled for every category, not just audit', async () => {
      const service = started(
        makeConfig({
          application_log: RETENTION_DISABLED,
          audit_event: RETENTION_DISABLED,
          security_event: RETENTION_DISABLED,
          lifecycle_event: RETENTION_DISABLED,
        }),
      );

      await service.tick();

      expect(executeRaw).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. A normal pass
  // ───────────────────────────────────────────────────────────────────────────

  describe('an enabled category', () => {
    it('writes exactly one RetentionRun row describing the pass', async () => {
      const service = build();

      await service.runCategory('application_log');

      expect(create).toHaveBeenCalledTimes(1);
      const { data } = create.mock.calls[0][0];
      expect(data).toMatchObject({
        category: 'application_log',
        deletedCount: 1,
        truncated: false,
        succeeded: true,
        errorMessage: null,
      });
      expect(data.finishedAt).toBeInstanceOf(Date);
      expect(typeof data.durationMs).toBe('number');
    });

    it('computes the cutoff as now minus the configured days', async () => {
      const service = build();

      await service.runCategory('audit_event');

      // 730 days for audit — the legal-retention window, not the 30-day diagnostics window.
      const expected = new Date(NOW - 730 * DAY_MS);
      expect(create.mock.calls[0][0].data.cutoff).toEqual(expected);
      // The same cutoff is the DELETE's bound parameter, so the row cannot describe a
      // different window from the one actually executed.
      expect(executeRaw.mock.calls[0][1]).toEqual(expected);
    });

    it('uses each category\u2019s own window rather than one shared value', async () => {
      const service = started();

      await service.tick();

      const cutoffs = Object.fromEntries(
        create.mock.calls.map((call) => [call[0].data.category, call[0].data.cutoff]),
      );
      expect(cutoffs.application_log).toEqual(new Date(NOW - 30 * DAY_MS));
      expect(cutoffs.audit_event).toEqual(new Date(NOW - 730 * DAY_MS));
      expect(cutoffs.security_event).toEqual(new Date(NOW - 365 * DAY_MS));
      expect(cutoffs.lifecycle_event).toEqual(new Date(NOW - 90 * DAY_MS));
    });

    it('stops after the first short chunk', async () => {
      // A chunk returning fewer than DELETE_CHUNK_SIZE rows means the table is drained, so
      // continuing would be MAX_CHUNKS_PER_RUN - 1 pointless round trips per pass.
      executeRaw.mockResolvedValue(DELETE_CHUNK_SIZE - 1);
      const service = build();

      await service.runCategory('application_log');

      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].data).toMatchObject({
        deletedCount: DELETE_CHUNK_SIZE - 1,
        truncated: false,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Bounded deletion
  // ───────────────────────────────────────────────────────────────────────────

  describe('chunking', () => {
    it('keeps deleting while every chunk comes back full', async () => {
      // Three full chunks then a short one: the loop must follow the data, not a fixed count.
      executeRaw
        .mockResolvedValueOnce(DELETE_CHUNK_SIZE)
        .mockResolvedValueOnce(DELETE_CHUNK_SIZE)
        .mockResolvedValueOnce(DELETE_CHUNK_SIZE)
        .mockResolvedValueOnce(12);
      const service = build();

      await service.runCategory('application_log');

      expect(executeRaw).toHaveBeenCalledTimes(4);
      expect(create.mock.calls[0][0].data).toMatchObject({
        deletedCount: DELETE_CHUNK_SIZE * 3 + 12,
        truncated: false,
        succeeded: true,
      });
    });

    it('stops at MAX_CHUNKS_PER_RUN and reports truncated instead of looping', async () => {
      // Every chunk full means rows older than the cutoff remain. Reporting `truncated` — rather
      // than continuing — is what keeps one pass from becoming an unbounded delete storm.
      executeRaw.mockResolvedValue(DELETE_CHUNK_SIZE);
      const service = build();

      await service.runCategory('application_log');

      expect(executeRaw).toHaveBeenCalledTimes(MAX_CHUNKS_PER_RUN);
      expect(create.mock.calls[0][0].data).toMatchObject({
        deletedCount: DELETE_CHUNK_SIZE * MAX_CHUNKS_PER_RUN,
        truncated: true,
        // A capped pass still SUCCEEDED; it simply has more to do next time. Reporting it as a
        // failure would make a busy table look like a broken one.
        succeeded: true,
        errorMessage: null,
      });
    });

    it('bounds each statement with DELETE_CHUNK_SIZE as a parameter', async () => {
      const service = build();

      await service.runCategory('application_log');

      const [strings, cutoff, limit] = executeRaw.mock.calls[0];
      expect(limit).toBe(DELETE_CHUNK_SIZE);
      expect(cutoff).toBeInstanceOf(Date);
      // Tagged template, so the values are bound parameters and the SQL itself is constant.
      expect(Array.isArray(strings)).toBe(true);
      expect(sqlOf(executeRaw.mock.calls[0])).toContain('LIMIT');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Failure is recorded, never propagated
  // ───────────────────────────────────────────────────────────────────────────

  describe('failure handling', () => {
    it('still writes exactly one row, with succeeded: false and the message', async () => {
      executeRaw.mockRejectedValue(new Error('deadlock detected'));
      const service = build();

      await expect(service.runCategory('security_event')).resolves.toBeUndefined();

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].data).toMatchObject({
        category: 'security_event',
        succeeded: false,
        errorMessage: 'deadlock detected',
        deletedCount: 0,
      });
    });

    it('keeps the rows deleted before the failure in the count', async () => {
      // Honest partial history: two chunks committed, the third threw. Reporting 0 would make a
      // partially-completed pass look like one that never started.
      executeRaw
        .mockResolvedValueOnce(DELETE_CHUNK_SIZE)
        .mockResolvedValueOnce(DELETE_CHUNK_SIZE)
        .mockRejectedValueOnce(new Error('connection lost'));
      const service = build();

      await service.runCategory('application_log');

      expect(create.mock.calls[0][0].data).toMatchObject({
        deletedCount: DELETE_CHUNK_SIZE * 2,
        succeeded: false,
        errorMessage: 'connection lost',
      });
    });

    it('caps the recorded error message at 500 characters', async () => {
      // An unbounded driver error — a full SQL dump, say — must not become the widest column in
      // the table or push the bookkeeping INSERT itself over a limit.
      executeRaw.mockRejectedValue(new Error('x'.repeat(2_000)));
      const service = build();

      await service.runCategory('application_log');

      expect(create.mock.calls[0][0].data.errorMessage).toHaveLength(500);
    });

    it('survives a non-Error rejection', async () => {
      executeRaw.mockRejectedValue('a string, not an Error');
      const service = build();

      await service.runCategory('application_log');

      expect(create.mock.calls[0][0].data).toMatchObject({
        succeeded: false,
        errorMessage: 'unknown retention error',
      });
    });

    it('does not throw when even the bookkeeping row cannot be written', async () => {
      // The database is unavailable; retrying here would fail again, and throwing would reject
      // the timer callback's promise. pino is the only remaining channel.
      create.mockRejectedValue(new Error('observability_db is down'));
      const service = build();

      await expect(service.runCategory('application_log')).resolves.toBeUndefined();
    });

    it('lets one category fail without aborting the pass', async () => {
      executeRaw.mockImplementation((strings: string[]) =>
        sqlOf([strings]).includes('"AuditEvent"')
          ? Promise.reject(new Error('audit table locked'))
          : Promise.resolve(3),
      );
      const service = started();

      await expect(service.tick()).resolves.toBeUndefined();

      // Four rows: three successes and one honest failure. A pass that stopped at the first
      // error would silently skip security and lifecycle retention forever.
      expect(create).toHaveBeenCalledTimes(4);
      const byCategory = Object.fromEntries(
        create.mock.calls.map((call) => [call[0].data.category, call[0].data.succeeded]),
      );
      expect(byCategory).toEqual({
        application_log: true,
        audit_event: false,
        security_event: true,
        lifecycle_event: true,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. The pass walks all four tables, and only those four
  // ───────────────────────────────────────────────────────────────────────────

  describe('tick()', () => {
    it('walks the four categories sequentially, in order', async () => {
      const service = started();

      await service.tick();

      expect(create.mock.calls.map((call) => call[0].data.category)).toEqual(CATEGORIES);
    });

    it('does nothing before onModuleInit — the running guard', async () => {
      // A tick that ran on a service the framework never started would delete rows during
      // shutdown, or in a test that merely constructed the class.
      const service = build();

      await service.tick();

      expect(executeRaw).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('does nothing after onModuleDestroy', async () => {
      const service = started();
      service.onModuleDestroy();

      await service.tick();

      expect(create).not.toHaveBeenCalled();
    });

    it('refuses to overlap itself — the ticking guard', async () => {
      // A pass slower than RETENTION_TICK_MS must not have a second copy of itself running
      // against the same tables; the two would fight over the same rows.
      let release: (value: number) => void = () => undefined;
      executeRaw.mockImplementationOnce(
        () => new Promise<number>((resolve) => { release = resolve; }),
      );
      const service = started();

      // First pass parks on a pending DELETE.
      const first = service.tick();
      await Promise.resolve();
      expect(executeRaw).toHaveBeenCalledTimes(1);

      // The tick that arrives while it is still running must be a no-op, not a queued pass.
      await service.tick();
      expect(executeRaw).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();

      // Let the first pass finish so the suite does not leak a pending promise. Only the
      // first call is slow; the remaining three categories resolve immediately.
      release(1);
      await first;
      expect(create).toHaveBeenCalledTimes(4);
    });

    it('is re-entrant once the previous pass has finished', async () => {
      const service = started();

      await service.tick();
      await service.tick();

      // Eight rows, not four: the guard is released in a `finally`, so a completed pass does not
      // wedge retention off for the lifetime of the process.
      expect(create).toHaveBeenCalledTimes(8);
    });

    it('never touches core_db — only the four observability tables', async () => {
      const service = started();

      await service.tick();

      const statements = executeRaw.mock.calls.map((call) => sqlOf(call));
      expect(statements).toHaveLength(4);
      expect(statements[0]).toContain('DELETE FROM "ApplicationLog"');
      expect(statements[1]).toContain('DELETE FROM "AuditEvent"');
      expect(statements[2]).toContain('DELETE FROM "SecurityEvent"');
      expect(statements[3]).toContain('DELETE FROM "LifecycleEvent"');

      // `AuditLog` lives in core_db and is out of scope by §51. `AuditEvent` is the
      // observability table and the names differ by three characters, so this is exactly the
      // kind of mistake that would silently prune the business audit trail.
      for (const sql of statements) {
        expect(sql).not.toMatch(/"AuditLog"/);
        expect(sql).not.toMatch(/"User"|"Lead"|"Meeting"|"BlogPost"/);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Lifecycle: the loop only exists when the platform is on
  // ───────────────────────────────────────────────────────────────────────────

  describe('onModuleInit / onModuleDestroy', () => {
    it('schedules a delayed first pass and a recurring one', () => {
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build();

      service.onModuleInit();

      // Not immediate: startup is when pools warm and migrations settle, and a bulk DELETE
      // competing with that is a self-inflicted slow start.
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), RETENTION_START_DELAY_MS);
      // Six-hourly, not daily — four smaller passes converge on the same steady state, and a
      // restart cannot make retention skip a whole day.
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), RETENTION_TICK_MS);

      service.onModuleDestroy();
    });

    it('unrefs both timers so neither can hold the process open', () => {
      // REAL timers here, deliberately: `hasRef()` is the property actually being asserted, and a
      // fake timer handle would answer it from a shim rather than from libuv. A retention interval
      // that kept a ref would hold the process — and every Jest worker — open for six hours.
      const handles: Array<{ hasRef?: () => boolean }> = [];
      const realSetTimeout = global.setTimeout;
      const realSetInterval = global.setInterval;
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
        const handle = realSetTimeout(fn, ms);
        handles.push(handle as unknown as { hasRef?: () => boolean });
        return handle;
      }) as unknown as typeof global.setTimeout);
      jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
        const handle = realSetInterval(fn, ms);
        handles.push(handle as unknown as { hasRef?: () => boolean });
        return handle;
      }) as unknown as typeof global.setInterval);

      const service = build();
      service.onModuleInit();

      expect(handles).toHaveLength(2);
      for (const handle of handles) expect(handle.hasRef?.()).toBe(false);

      // Still cleared, so the suite leaves no live timer behind either way.
      service.onModuleDestroy();
      for (const handle of handles) expect(handle.hasRef?.()).toBe(false);
    });

    it('starts NOTHING when the platform is disabled', async () => {
      jest.useFakeTimers();
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const service = build(makeConfig({}, false));

      service.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);

      // And the guard holds even if something calls `tick()` directly: an installation with no
      // observability_db must never issue a DELETE against it.
      await service.tick();
      expect(executeRaw).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('runs a pass when the delayed timer finally fires', async () => {
      jest.useFakeTimers();
      const service = build();
      service.onModuleInit();

      jest.advanceTimersByTime(RETENTION_START_DELAY_MS);
      // Two microtask drains: the timer callback starts `tick()`, which awaits per category.
      await Promise.resolve();
      await Promise.resolve();

      expect(executeRaw).toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('is idempotent on destroy', () => {
      jest.useFakeTimers();
      const service = build();
      service.onModuleInit();

      expect(() => {
        service.onModuleDestroy();
        service.onModuleDestroy();
      }).not.toThrow();
    });
  });
});
