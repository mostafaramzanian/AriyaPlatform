import {
  MAX_SEND_ATTEMPTS,
  SCHEDULED_SEND_BATCH_SIZE,
  ScheduledSendDispatcherService,
} from './scheduled-send.dispatcher';

/**
 * Phase 50-MOD-CORR: the scheduled-send dispatcher's contract, pinned without a
 * database.
 *
 * What is asserted here is exactly what defects D8/D9/D10 demanded and what the
 * replaced `setInterval` inside CorrespondenceService did NOT do: a bounded scan, a
 * retry bound, a claim before the send, an overlap guard, no timer keeping the
 * process alive, and diagnostics recorded instead of swallowing a failure.
 */

const makePrisma = () => ({
  letter: {
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
});

const makeCorrespondence = () => ({
  dispatchScheduledLetter: jest.fn().mockResolvedValue(true),
});

describe('ScheduledSendDispatcherService (unit)', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let correspondence: ReturnType<typeof makeCorrespondence>;
  let dispatcher: ScheduledSendDispatcherService;

  beforeEach(() => {
    prisma = makePrisma();
    correspondence = makeCorrespondence();
    dispatcher = new ScheduledSendDispatcherService(
      prisma as never,
      correspondence as never,
    );
  });

  afterEach(() => {
    dispatcher.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('is INERT until onModuleInit — nothing runs before the module starts', async () => {
    expect(await dispatcher.processDue(new Date())).toBe(0);
    expect(prisma.letter.findMany).not.toHaveBeenCalled();
  });

  it('scans a BOUNDED, retry-bounded batch served by the partial index', async () => {
    dispatcher.onModuleInit();
    const now = new Date('2026-09-15T10:00:00.000Z');

    await dispatcher.processDue(now);

    // The predicate is what makes the scan cheap: `status = SCHEDULED` is the partial
    // index condition, and `sendAttempts < MAX` keeps an exhausted letter out of it.
    // The bound is what stops one tick from fanning out unboundedly.
    expect(prisma.letter.findMany).toHaveBeenCalledWith({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
        sendAttempts: { lt: MAX_SEND_ATTEMPTS },
      },
      orderBy: { scheduledAt: 'asc' },
      take: SCHEDULED_SEND_BATCH_SIZE,
      select: { id: true },
    });
  });

  it('claims each row with a conditional update and sends ONLY what it claimed', async () => {
    dispatcher.onModuleInit();
    prisma.letter.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
    // l1 was already claimed by another replica — count 0 means "not mine".
    prisma.letter.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const now = new Date();
    const sent = await dispatcher.processDue(now);

    expect(sent).toBe(1);
    expect(prisma.letter.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'l1',
        status: 'SCHEDULED',
        scheduledAt: { lte: now },
        sendAttempts: { lt: MAX_SEND_ATTEMPTS },
      },
      data: { sendAttempts: { increment: 1 }, lastSendAttemptAt: now },
    });
    // The losing replica must not even attempt the send.
    expect(correspondence.dispatchScheduledLetter).toHaveBeenCalledTimes(1);
    expect(correspondence.dispatchScheduledLetter).toHaveBeenCalledWith('l2', now);
  });

  it('records lastSendError, keeps the attempt, and never throws out of the tick', async () => {
    dispatcher.onModuleInit();
    prisma.letter.findMany.mockResolvedValue([{ id: 'l1' }]);
    correspondence.dispatchScheduledLetter.mockRejectedValueOnce(new Error('smtp down'));

    await expect(dispatcher.processDue(new Date())).resolves.toBe(0);

    // The claim is NOT refunded, and the reason is persisted on the row (D10).
    const record = prisma.letter.updateMany.mock.calls.at(-1)?.[0];
    expect(record).toEqual({
      where: { id: 'l1', status: 'SCHEDULED' },
      data: { lastSendError: 'smtp down' },
    });
  });

  it('bounds the recorded error text and never lets a failed RECORD fail the tick', async () => {
    dispatcher.onModuleInit();
    prisma.letter.findMany.mockResolvedValue([{ id: 'l1' }]);
    correspondence.dispatchScheduledLetter.mockRejectedValueOnce(new Error('x'.repeat(900)));
    prisma.letter.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db gone'));

    await expect(dispatcher.processDue(new Date())).resolves.toBe(0);

    const record = prisma.letter.updateMany.mock.calls.at(-1)?.[0];
    expect(record.data.lastSendError).toHaveLength(500);
  });

  it('survives a failing scan: the next tick retries from the same index', async () => {
    dispatcher.onModuleInit();
    prisma.letter.findMany.mockRejectedValueOnce(new Error('db down'));

    await expect(dispatcher.processDue(new Date())).resolves.toBe(0);

    // The guard must be released on the error path too, otherwise one failed scan
    // would freeze the dispatcher for the life of the process.
    prisma.letter.findMany.mockResolvedValueOnce([]);
    await expect(dispatcher.processDue(new Date())).resolves.toBe(0);
    expect(prisma.letter.findMany).toHaveBeenCalledTimes(2);
  });

  it('refuses to overlap ticks inside this process', async () => {
    dispatcher.onModuleInit();
    let release: (rows: unknown[]) => void = () => {};
    prisma.letter.findMany.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );

    const first = dispatcher.processDue(new Date());
    expect(await dispatcher.processDue(new Date())).toBe(0);

    release([]);
    await expect(first).resolves.toBe(0);
    expect(prisma.letter.findMany).toHaveBeenCalledTimes(1);
  });

  it('unrefs its timer so a pending tick cannot hold the process open, and stops on destroy', () => {
    const unref = jest.fn();
    const handle = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(handle);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

    dispatcher.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(unref).toHaveBeenCalled();

    dispatcher.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
  });
});
