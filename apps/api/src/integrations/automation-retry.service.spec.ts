import { Test } from '@nestjs/testing';
import { AutomationRetryService, RETRY_TICK_MS } from './automation-retry.service';
import { IntegrationService } from './integration.service';

/**
 * Phase 49L §21: the bounded retry timer.
 *
 * What matters here is that the loop is bounded, non-overlapping, unref'd and
 * crash-proof. An unhandled rejection inside a `setInterval` callback terminates the
 * Node process, so a misconfigured integration would otherwise become an outage; and a
 * slow pass joined by the next timer fire would have two passes claiming rows
 * concurrently inside one process.
 */
describe('AutomationRetryService', () => {
  let retry: AutomationRetryService;
  let integrations: { processRetries: jest.Mock };

  beforeEach(async () => {
    integrations = { processRetries: jest.fn().mockResolvedValue(3) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AutomationRetryService,
        { provide: IntegrationService, useValue: integrations },
      ],
    }).compile();

    retry = moduleRef.get(AutomationRetryService);
  });

  afterEach(() => retry.onModuleDestroy());

  it('does nothing before onModuleInit, so an unstarted service is inert', async () => {
    await expect(retry.tick()).resolves.toBe(0);
    expect(integrations.processRetries).not.toHaveBeenCalled();
  });

  it('delegates one pass once started', async () => {
    retry.onModuleInit();

    await expect(retry.tick()).resolves.toBe(3);
    expect(integrations.processRetries).toHaveBeenCalledTimes(1);
  });

  it('stops after onModuleDestroy', async () => {
    retry.onModuleInit();
    retry.onModuleDestroy();

    await expect(retry.tick()).resolves.toBe(0);
    expect(integrations.processRetries).not.toHaveBeenCalled();
  });

  it('does not overlap: a second tick while one is in flight is a no-op', async () => {
    retry.onModuleInit();

    let release: () => void = () => {};
    integrations.processRetries.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    );

    const first = retry.tick();
    await expect(retry.tick()).resolves.toBe(0);

    release();
    await expect(first).resolves.toBe(1);
    expect(integrations.processRetries).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing pass rather than terminating the process', async () => {
    retry.onModuleInit();
    integrations.processRetries.mockRejectedValue(new Error('db down'));

    await expect(retry.tick()).resolves.toBe(0);

    // And the overlap guard is released, so the next tick still runs.
    integrations.processRetries.mockResolvedValue(2);
    await expect(retry.tick()).resolves.toBe(2);
  });

  it('uses a bounded interval and unrefs the timer', () => {
    const spy = jest.spyOn(global, 'setInterval');
    retry.onModuleInit();

    expect(spy).toHaveBeenCalledWith(expect.any(Function), RETRY_TICK_MS);

    // `unref` is what stops a pending timer holding a Jest run — or the process — open.
    const handle = spy.mock.results[0].value as NodeJS.Timeout;
    expect(handle.hasRef?.()).toBe(false);

    spy.mockRestore();
  });
});
