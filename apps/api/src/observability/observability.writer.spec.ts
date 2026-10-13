import { ObservabilityWriter } from './observability.writer';
import { ObservabilityConfigService } from './observability.config';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { LogLevelValue } from './observability.contract';

/**
 * Phase 49M-2 §22: the writer's behaviour under pressure and under failure.
 *
 * WHAT THIS FILE PROVES, and why each property is worth a test:
 *
 *  - THE QUEUE IS BOUNDED. Without this, a traffic spike with a slow database is a memory
 *    leak that presents as a healthy process until the heap runs out.
 *  - THE DROP ORDER IS TRACE → DEBUG → INFO → WARN. Dropping the newest arrival, or simply
 *    dropping the head, would discard the lines describing the incident in progress.
 *  - ERROR AND FATAL ARE NEVER EVICTED, even when that means refusing a newcomer. A queue
 *    full of errors is the state in which the errors matter most.
 *  - `dropped` IS ACCURATE. A platform that silently discards rows and reports nothing lies
 *    to whoever reads the table during an incident, which is worse than not logging.
 *  - A FAILED OR HUNG WRITE NEVER THROWS AND NEVER STALLS THE LOOP. One stuck query must not
 *    be able to disable all logging.
 *  - `enqueue` PERFORMS NO I/O. It is called on the request path.
 */

/** Minimal config double. Small numbers so the bounded behaviour is reachable in a test. */
function makeConfig(overrides: Partial<ObservabilityConfigService> = {}): ObservabilityConfigService {
  return {
    enabled: true,
    minLevel: 'TRACE' as LogLevelValue,
    minLevelSeverity: 10,
    queueMax: 5,
    batchSize: 100,
    flushIntervalMs: 1_000,
    writeTimeoutMs: 50,
    retention: {
      applicationLogDays: 30,
      auditEventDays: 730,
      securityEventDays: 365,
      lifecycleEventDays: 90,
    },
    identity: { service: 'test-api', environment: 'test', instanceRef: 'host-1' },
    acceptsLevel: () => true,
    retentionDaysFor: () => 30,
    describe: () => ({}),
    ...overrides,
  } as unknown as ObservabilityConfigService;
}

function makePrisma(createMany: jest.Mock): ObservabilityPrismaService {
  return { applicationLog: { createMany } } as unknown as ObservabilityPrismaService;
}

function row(level: LogLevelValue, messageCode = 'HTTP_REQUEST_COMPLETED') {
  return { level, messageCode, message: level, source: 'http' };
}

describe('ObservabilityWriter', () => {
  let createMany: jest.Mock;

  beforeEach(() => {
    createMany = jest.fn().mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts rows without performing any I/O', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig());

    expect(writer.enqueue(row('INFO'))).toBe(true);

    // The whole cost on the request path is an array push. A `createMany` here would mean a
    // log line had put a database round trip in front of a user's response.
    expect(createMany).not.toHaveBeenCalled();
    expect(writer.stats().queued).toBe(1);
  });

  it('is inert when disabled', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ enabled: false }));

    expect(writer.enqueue(row('ERROR'))).toBe(false);
    expect(writer.stats().queued).toBe(0);
    // Not counted as a drop: nothing was lost, the platform was switched off.
    expect(writer.stats().dropped).toBe(0);
  });

  it('bounds the queue and counts every drop', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig());

    for (let i = 0; i < 12; i += 1) writer.enqueue(row('INFO'));

    expect(writer.stats().queued).toBe(5);
    expect(writer.stats().enqueued).toBe(12);
    // 12 offered, 5 retained: the other 7 are accounted for rather than vanishing.
    expect(writer.stats().dropped).toBe(7);
  });

  it('evicts the lowest droppable level first, not the oldest row', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ queueMax: 4 }));

    writer.enqueue(row('WARN', 'HTTP_REQUEST_FAILED'));
    writer.enqueue(row('TRACE'));
    writer.enqueue(row('DEBUG'));
    writer.enqueue(row('INFO'));

    // Full. The newcomer displaces the TRACE, NOT the WARN that arrived first.
    writer.enqueue(row('ERROR', 'HTTP_REQUEST_FAILED'));

    const levels = (writer as unknown as { queue: Array<{ level: string }> }).queue.map((r) => r.level);
    expect(levels).toEqual(['WARN', 'DEBUG', 'INFO', 'ERROR']);
    expect(writer.stats().dropped).toBe(1);
  });

  it('never evicts ERROR or FATAL, refusing the newcomer instead', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ queueMax: 2 }));

    writer.enqueue(row('ERROR', 'HTTP_REQUEST_FAILED'));
    writer.enqueue(row('FATAL', 'UNHANDLED_EXCEPTION'));

    // A droppable newcomer is refused rather than displacing an error.
    expect(writer.enqueue(row('INFO'))).toBe(false);

    const levels = (writer as unknown as { queue: Array<{ level: string }> }).queue.map((r) => r.level);
    expect(levels).toEqual(['ERROR', 'FATAL']);
    expect(writer.stats().dropped).toBe(1);
  });

  it('flushes one bounded batch and leaves the remainder queued', async () => {
    const writer = new ObservabilityWriter(
      makePrisma(createMany),
      makeConfig({ queueMax: 100, batchSize: 3 }),
    );

    for (let i = 0; i < 7; i += 1) writer.enqueue(row('INFO'));
    // The push-triggered flush already drained one batch of 3; drain another explicitly.
    await writer.flush();

    expect(createMany).toHaveBeenCalled();
    const firstBatch = createMany.mock.calls[0][0].data as unknown[];
    expect(firstBatch).toHaveLength(3);
    expect(writer.stats().written).toBeGreaterThanOrEqual(3);
  });

  it('discards a failed batch instead of requeueing it, and keeps counting', async () => {
    createMany.mockRejectedValue(new Error('database gone'));
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ batchSize: 2 }));

    writer.enqueue(row('INFO'));
    writer.enqueue(row('INFO'));
    // The second `enqueue` reached batchSize and triggered a flush; `drain` awaits it.
    await writer.drain();

    // REQUEUEING WOULD BE WORSE: with the database down, a requeued batch is retried forever
    // while new lines are dropped to make room, so the platform would preserve the oldest
    // data and lose everything current.
    expect(writer.stats().queued).toBe(0);
    expect(writer.stats().failedBatches).toBe(1);
    expect(writer.stats().dropped).toBe(2);
    expect(writer.stats().lastErrorMessage).toContain('database gone');
  });

  it('gives up on a hung write rather than stalling the loop forever', async () => {
    // Never settles: models a connection that is established but unresponsive.
    createMany.mockReturnValue(new Promise(() => {}));
    const writer = new ObservabilityWriter(
      makePrisma(createMany),
      makeConfig({ batchSize: 1, writeTimeoutMs: 20 }),
    );

    writer.enqueue(row('INFO'));
    await writer.drain();

    expect(writer.stats().failedBatches).toBe(1);
    expect(writer.stats().lastErrorMessage).toContain('exceeded 20ms');
    // The critical part: the writer is ready to try again. Without a timeout the flush loop
    // would be wedged and every subsequent line silently dropped.
    expect(writer.stats().flushing).toBe(false);
  });

  it('does not overlap two flushes', async () => {
    let release!: () => void;
    createMany.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ count: 1 });
      }),
    );
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ batchSize: 1 }));

    writer.enqueue(row('INFO'));
    // Let the triggered flush start and park on the unresolved createMany.
    await Promise.resolve();

    // A direct call while the first is in flight must be a no-op: two concurrent flushes
    // could interleave `splice` calls and duplicate or lose rows.
    writer.enqueue(row('INFO'));
    await writer.flush();
    expect(createMany).toHaveBeenCalledTimes(1);

    release();
    await writer.drain();
  });

  it('makes a final flush attempt on shutdown', async () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ batchSize: 50 }));
    writer.onModuleInit();

    writer.enqueue(row('ERROR', 'HTTP_REQUEST_FAILED'));
    await writer.onModuleDestroy();

    // Without this, every line buffered since the last tick is lost on each deploy — and the
    // lines written just before a shutdown disproportionately explain WHY it is going down.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(writer.stats().queued).toBe(0);
    expect(writer.isRunning()).toBe(false);
  });

  it('starts no timer when disabled', () => {
    const writer = new ObservabilityWriter(makePrisma(createMany), makeConfig({ enabled: false }));
    writer.onModuleInit();

    expect(writer.isRunning()).toBe(false);
  });
});
