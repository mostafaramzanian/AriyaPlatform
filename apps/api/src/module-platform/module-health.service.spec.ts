import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { ModuleHealthService } from './module-health.service';
import { ModuleRegistryService } from './module-registry.service';
import { MODULE_STALE_AFTER_MS } from './module.contract';
import { ALLOW_PRIVATE_ENV_VAR } from '../integrations/integration-url.guard';

/**
 * Phase 49M §13: health, and the three facts it keeps apart.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - A 200 IS NOT HEALTH. A reachable endpoint that declares no state is DEGRADED. That single
 *    assertion is the §13 requirement, and it is the one a future "just return 200" shortcut would
 *    break.
 *  - THE THREE FACTS ARE DISTINGUISHABLE. registryKnown / endpointReachable / applicationHealthy are
 *    asserted separately for each failure mode, because collapsing them is what makes a 3am
 *    diagnosis impossible.
 *  - A DISABLED MODULE IS NOT PROBED. Probing one would produce a HEALTHY reading for something an
 *    administrator switched off.
 *  - NO INTERNAL DETAIL IS ABSORBED. A module that returns a string in `checks` has it dropped,
 *    because a dependency error message carries internal topology (§10).
 *  - THE REGISTRY VIEW COSTS NO NETWORK CALL (§45), and a stale instance reads UNAVAILABLE no matter
 *    what its last report said.
 */

const instanceRow = (overrides: Record<string, unknown> = {}) => ({
  instanceId: 'finance-prod-01',
  deploymentMode: 'REMOTE',
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  version: '1.2.0',
  registration: { enabled: true },
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  ({ status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('ModuleHealthService', () => {
  let service: ModuleHealthService;
  let prisma: { moduleInstance: Record<string, jest.Mock> };
  let registry: { recordProbe: jest.Mock };
  let fetchMock: jest.Mock;

  const originalFetch = global.fetch;
  const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

  beforeEach(async () => {
    prisma = {
      moduleInstance: {
        findUnique: jest.fn().mockResolvedValue(instanceRow()),
      },
    };

    registry = { recordProbe: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleHealthService,
        { provide: PrismaService, useValue: prisma },
        { provide: ModuleRegistryService, useValue: registry },
      ],
    }).compile();

    service = moduleRef.get(ModuleHealthService);

    fetchMock = jest.fn().mockResolvedValue(jsonResponse({ state: 'HEALTHY', version: '1.2.0' }));
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalFlag === undefined) delete process.env[ALLOW_PRIVATE_ENV_VAR];
    else process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
  });

  describe('probeInstance', () => {
    it('reports HEALTHY only when the module DECLARES it', async () => {
      const verdict = await service.probeInstance('finance-prod-01');

      expect(verdict).toEqual({
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: true,
        state: 'HEALTHY',
      });

      expect(registry.recordProbe).toHaveBeenCalledWith('finance-prod-01', 'HEALTHY', undefined);
    });

    it('treats a 200 with NO declared state as DEGRADED (§13)', async () => {
      // THE LOAD-BEARING HEALTH ASSERTION. A proxy answering 200 in front of a dead module must not
      // read as healthy.
      fetchMock.mockResolvedValue(jsonResponse({}));

      const verdict = await service.probeInstance('finance-prod-01');

      expect(verdict).toMatchObject({
        endpointReachable: true,
        applicationHealthy: false,
        state: 'DEGRADED',
        errorCode: 'NO_HEALTH_STATE',
      });
    });

    it('treats an unparseable body the same way', async () => {
      fetchMock.mockResolvedValue({ status: 200, text: async () => 'OK' } as unknown as Response);

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        state: 'DEGRADED',
        errorCode: 'NO_HEALTH_STATE',
      });
    });

    it('believes a module that declares itself DEGRADED', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ state: 'DEGRADED', version: '1.2.0' }));

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        endpointReachable: true,
        applicationHealthy: false,
        state: 'DEGRADED',
        errorCode: 'MODULE_REPORTED_UNHEALTHY',
      });
    });

    it('treats an unrecognised declared state as DEGRADED rather than trusting it', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ state: 'SUPER_FINE', version: '1.2.0' }));

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        state: 'DEGRADED',
      });
    });

    it('reports VERSION_DRIFT as DEGRADED, not UNAVAILABLE', async () => {
      // The module is up; the registry now describes something else. Refusing to route would take
      // down a working module over bookkeeping.
      fetchMock.mockResolvedValue(jsonResponse({ state: 'HEALTHY', version: '2.0.0' }));

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        endpointReachable: true,
        state: 'DEGRADED',
        errorCode: 'VERSION_DRIFT',
      });
    });

    it('distinguishes TIMEOUT from UNREACHABLE from HTTP_<status>', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' }));
      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        endpointReachable: false,
        state: 'UNAVAILABLE',
        errorCode: 'TIMEOUT',
      });

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        errorCode: 'UNREACHABLE',
      });

      fetchMock.mockResolvedValue(jsonResponse({ state: 'HEALTHY' }, 503));
      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        // REACHABLE but unwell: a completely different investigation from a timeout.
        endpointReachable: true,
        applicationHealthy: false,
        errorCode: 'HTTP_503',
      });
    });
  });

  describe('probeInstance — refusals that make no network call', () => {
    it('does not probe an unknown instance', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(null);

      await expect(service.probeInstance('nope')).resolves.toEqual({
        registryKnown: false,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNKNOWN',
        errorCode: 'UNKNOWN_INSTANCE',
      });

      // This route must not become "make Core fetch a URL for anyone who guesses an id".
      expect(fetchMock).not.toHaveBeenCalled();
      expect(registry.recordProbe).not.toHaveBeenCalled();
    });

    it('does not probe a DISABLED module', async () => {
      // A HEALTHY reading for a module an administrator switched off is a contradiction the operator
      // would then have to reconcile.
      prisma.moduleInstance.findUnique.mockResolvedValue(
        instanceRow({ registration: { enabled: false } }),
      );

      await expect(service.probeInstance('finance-prod-01')).resolves.toEqual({
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'DISABLED',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports NO_ENDPOINT for a LOCAL in-process instance rather than inventing one', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(
        instanceRow({ deploymentMode: 'LOCAL', baseUrl: null }),
      );

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        state: 'UNKNOWN',
        errorCode: 'NO_ENDPOINT',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a probe the endpoint policy refuses, and records it', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(
        instanceRow({ baseUrl: 'http://169.254.169.254' }),
      );

      await expect(service.probeInstance('finance-prod-01')).resolves.toMatchObject({
        state: 'UNAVAILABLE',
        errorCode: 'SSRF_BLOCKED',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(registry.recordProbe).toHaveBeenCalledWith(
        'finance-prod-01',
        'UNAVAILABLE',
        'SSRF_BLOCKED',
      );
    });
  });

  describe('health report parsing (§10)', () => {
    it('keeps only BOOLEAN checks, dropping anything that could carry internal topology', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          state: 'HEALTHY',
          version: '1.2.0',
          checks: {
            db: true,
            queue: false,
            // A module trying to be helpful; this must not reach Core's admin UI.
            detail: 'connection refused at 10.0.0.5:5432',
          },
        }),
      );

      const verdict = await service.probeInstance('finance-prod-01');

      expect(verdict.state).toBe('HEALTHY');
      // The verdict itself carries no checks at all — only the three facts and a code.
      expect(JSON.stringify(verdict)).not.toContain('10.0.0.5');
    });
  });

  describe('verdictFromRegistry', () => {
    it('answers from stored state with NO network call (§45)', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        health: 'HEALTHY',
        lastSeenAt: new Date(),
        registration: { enabled: true },
      });

      await expect(service.verdictFromRegistry('finance-prod-01')).resolves.toEqual({
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: true,
        state: 'HEALTHY',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a STALE instance as UNAVAILABLE regardless of its last report', async () => {
      // The last report is old news; presenting it as current is how a dead module keeps looking
      // alive on a dashboard.
      prisma.moduleInstance.findUnique.mockResolvedValue({
        health: 'HEALTHY',
        lastSeenAt: new Date(Date.now() - MODULE_STALE_AFTER_MS - 1),
        registration: { enabled: true },
      });

      await expect(service.verdictFromRegistry('finance-prod-01')).resolves.toMatchObject({
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: 'HEARTBEAT_STALE',
      });
    });

    it('reports a never-seen instance as stale rather than healthy', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        health: 'UNKNOWN',
        lastSeenAt: null,
        registration: { enabled: true },
      });

      await expect(service.verdictFromRegistry('finance-prod-01')).resolves.toMatchObject({
        state: 'UNAVAILABLE',
      });
    });

    it('reports DISABLED for a disabled module', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        health: 'HEALTHY',
        lastSeenAt: new Date(),
        registration: { enabled: false },
      });

      await expect(service.verdictFromRegistry('finance-prod-01')).resolves.toMatchObject({
        state: 'DISABLED',
      });
    });
  });
});


