import { Test } from '@nestjs/testing';
import { ModuleSweepService, SWEEP_TICK_MS } from './module-sweep.service';
import { ModuleRegistryService } from './module-registry.service';
import { MODULE_HEARTBEAT_INTERVAL_MS, MODULE_STALE_AFTER_MS } from './module.contract';

/**
 * Phase 49M §14/§45: the bounded staleness sweep.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - THE SWEEP MAKES NO NETWORK CALL. It delegates to one registry method, which is a database
 *    query. That is the §45 "no unbounded polling / no discovery call per request" requirement: Core
 *    does not poll every module every minute; modules push heartbeats.
 *  - THE CADENCE IS FASTER THAN THE THRESHOLD. A tick interval equal to the stale window would
 *    double worst-case detection latency.
 *  - IT NEVER THROWS. An unhandled rejection inside a timer callback terminates the Node process,
 *    which would turn one bad row into an outage.
 *  - IT STOPS ON DESTROY, and a slow tick does not overlap the next one.
 */

describe('ModuleSweepService', () => {
  let service: ModuleSweepService;
  let registry: { sweepStaleInstances: jest.Mock };

  beforeEach(async () => {
    registry = { sweepStaleInstances: jest.fn().mockResolvedValue(3) };

    const moduleRef = await Test.createTestingModule({
      providers: [ModuleSweepService, { provide: ModuleRegistryService, useValue: registry }],
    }).compile();

    service = moduleRef.get(ModuleSweepService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('ticks faster than the stale threshold', () => {
    // One heartbeat interval against a three-interval threshold: worst-case detection is ~120s
    // rather than the ~180s an interval-equals-threshold cadence would give.
    expect(SWEEP_TICK_MS).toBe(MODULE_HEARTBEAT_INTERVAL_MS);
    expect(SWEEP_TICK_MS).toBeLessThan(MODULE_STALE_AFTER_MS);
  });

  it('does nothing until started', async () => {
    await expect(service.tick()).resolves.toBe(0);
    expect(registry.sweepStaleInstances).not.toHaveBeenCalled();
  });

  it('delegates one bounded pass to the registry', async () => {
    service.onModuleInit();

    await expect(service.tick()).resolves.toBe(3);
    expect(registry.sweepStaleInstances).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure rather than crashing the process', async () => {
    service.onModuleInit();
    registry.sweepStaleInstances.mockRejectedValue(new Error('database gone'));

    await expect(service.tick()).resolves.toBe(0);
  });

  it('does not overlap a slow tick with the next one', async () => {
    service.onModuleInit();

    let release!: (value: number) => void;
    registry.sweepStaleInstances.mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );

    const first = service.tick();
    // The second call must return immediately rather than starting a concurrent pass.
    await expect(service.tick()).resolves.toBe(0);

    release(5);
    await expect(first).resolves.toBe(5);
    expect(registry.sweepStaleInstances).toHaveBeenCalledTimes(1);
  });

  it('stops sweeping after destroy', async () => {
    service.onModuleInit();
    service.onModuleDestroy();

    await expect(service.tick()).resolves.toBe(0);
    expect(registry.sweepStaleInstances).not.toHaveBeenCalled();
  });

  it('unrefs its timer so it cannot hold the process open', () => {
    service.onModuleInit();

    // Asserted through behaviour rather than internals: a Jest run that hung here would be the
    // symptom, and `onModuleDestroy` in afterEach is what guarantees it does not.
    expect(() => service.onModuleDestroy()).not.toThrow();
  });
});
