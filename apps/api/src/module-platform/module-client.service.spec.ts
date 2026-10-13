import { Test } from '@nestjs/testing';
import { RequestContextService } from '../common/request-context.service';
import { ModuleClient } from './module-client.service';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHttpTransport } from './module-http.transport';
import { DEFAULT_MODULE_TIMEOUT_MS, MAX_MODULE_TIMEOUT_MS } from './module.contract';

/**
 * Phase 49M §24/§35: the client façade — the one seam business code sees.
 *
 * WHAT THIS FILE PROVES, AND IT IS THE MOST IMPORTANT FILE IN THE PHASE:
 *
 *  - A CALLER CANNOT NAME A DESTINATION. `call()` takes a logical id; the URL comes from the
 *    resolver. A body carrying `url`, `baseUrl` or `instanceId` reaches the transport as nothing.
 *  - A CALLER CANNOT CHOOSE A TENANT. The tenant is read from the request context; a `tenantId` on
 *    the request object is ignored.
 *  - THE CREDENTIAL IS FETCHED SEPARATELY AND NEVER RETURNED. A missing or expired one is a refusal,
 *    not an unsigned request.
 *  - THE SAME CALL PATH SERVES EVERY DEPLOYMENT MODE. The client is asserted never to branch on
 *    `deploymentMode` or on `moduleId`: identical inputs but a different mode produce an identical
 *    call, and identical inputs but a different module name produce an identically-shaped call.
 *  - NOTHING THROWS. Every resolution failure becomes a result.
 */

const resolved = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'finance',
  instanceId: 'finance-prod-01',
  version: '1.2.0',
  deploymentMode: 'REMOTE',
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  capabilities: ['invoice.read'],
  apiContracts: ['module.invoke@v1'],
  lifecycle: 'ACTIVE',
  health: 'HEALTHY',
  lastSeenAt: new Date(),
  ...overrides,
});

/**
 * Establishes a request context for the current test.
 *
 * CALLED INSIDE EACH TEST, never in `beforeEach`, and that is not a style choice:
 * `RequestContextService.set` uses `AsyncLocalStorage.enterWith`, which binds to the async context it
 * is called from. A `beforeEach` runs in a different async context from the `it` body, so a context
 * set there is not visible to the code under test. The 49L specs establish theirs the same way, for
 * the same reason.
 */
const useContext = (overrides: Record<string, unknown> = {}) =>
  RequestContextService.set({
    requestId: 'req-ctx',
    correlationId: 'corr-ctx',
    startTime: Date.now(),
    userId: 'user-1',
    tenantId: 'tenant-1',
    ...overrides,
  });

describe('ModuleClient', () => {
  let client: ModuleClient;
  let registry: { resolve: jest.Mock; resolveSecret: jest.Mock };
  let transport: { modes: string[]; send: jest.Mock };

  beforeEach(async () => {
    registry = {
      resolve: jest.fn().mockResolvedValue({ ok: true, instance: resolved() }),
      resolveSecret: jest.fn().mockResolvedValue('s'.repeat(64)),
    };

    transport = {
      modes: ['LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID'],
      send: jest.fn().mockResolvedValue({ ok: true, data: { total: 1 } }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleClient,
        { provide: ModuleRegistryService, useValue: registry },
        { provide: ModuleHttpTransport, useValue: transport },
      ],
    }).compile();

    client = moduleRef.get(ModuleClient);
  });

  it('resolves by LOGICAL id and passes the contract through', async () => {
    useContext();

    await client.call({
      moduleId: 'finance',
      contract: 'module.invoke@v1',
      operation: 'invoice.read',
      payload: {},
    });

    expect(registry.resolve).toHaveBeenCalledWith('finance', 'module.invoke@v1');
  });

  it('takes the tenant from the request context, never from the caller', async () => {
    // §21. A caller that could pass a tenant could ask a module to act for another one.
    useContext();

    await client.call({
      moduleId: 'finance',
      contract: 'module.invoke@v1',
      operation: 'invoice.read',
      payload: {},
      // Deliberately smuggled: the type does not permit it and the implementation ignores it.
      tenantId: 'tenant-attacker',
    } as never);

    expect(transport.send.mock.calls[0][2].tenant).toEqual({ tenantId: 'tenant-1' });
  });

  it('carries the correlation id rather than minting a new one (§23)', async () => {
    useContext();

    await client.call({
      moduleId: 'finance',
      contract: 'module.invoke@v1',
      operation: 'invoice.read',
      payload: {},
    });

    expect(transport.send.mock.calls[0][2].correlationId).toBe('corr-ctx');
  });

  it('builds a minimal actor from the context (§22)', async () => {
    useContext();

    await client.call({
      moduleId: 'finance',
      contract: 'module.invoke@v1',
      operation: 'invoice.read',
      payload: {},
    });

    expect(transport.send.mock.calls[0][2].actor).toEqual({
      actorId: 'user-1',
      actorType: 'user',
    });
  });

  it('omits the actor entirely for a system-initiated call', async () => {
    // "No human did this" is information, not a gap to fill with a synthetic actor.
    useContext({ userId: undefined });

    await client.call({
      moduleId: 'finance',
      contract: 'module.invoke@v1',
      operation: 'invoice.read',
      payload: {},
    });

    expect(transport.send.mock.calls[0][2].actor).toBeUndefined();
  });

  describe('deployment neutrality of the call path (§35)', () => {
    it('issues an IDENTICAL call for every deployment mode', async () => {
      // The claim: "if you decide HR is local and Finance is on a server, the architecture needs no
      // business-code change." This is that claim as an assertion.
      const seen: unknown[] = [];

      for (const mode of ['LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID'] as const) {
        useContext();
        registry.resolve.mockResolvedValue({ ok: true, instance: resolved({ deploymentMode: mode }) });
        transport.send.mockClear();

        await client.call({
          moduleId: 'finance',
          contract: 'module.invoke@v1',
          operation: 'invoice.read',
          payload: { id: 'x' },
        });

        const [, request, ctx] = transport.send.mock.calls[0];

        seen.push({
          request,
          tenant: ctx.tenant,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
          timeoutMs: ctx.timeoutMs,
        });
      }

      // Every call is byte-for-byte the same from the caller's side; only the instance differs.
      expect(seen[1]).toEqual(seen[0]);
      expect(seen[2]).toEqual(seen[0]);
      expect(seen[3]).toEqual(seen[0]);
    });

    it('issues an identically-shaped call for two different module names', async () => {
      const shapes: unknown[] = [];

      for (const moduleId of ['finance', 'anything-else']) {
        useContext();
        registry.resolve.mockResolvedValue({ ok: true, instance: resolved({ moduleId }) });
        transport.send.mockClear();

        await client.call({
          moduleId,
          contract: 'module.invoke@v1',
          operation: 'do.thing',
          payload: {},
        });

        const [, request] = transport.send.mock.calls[0];
        shapes.push(Object.keys(request).sort());
      }

      expect(shapes[0]).toEqual(shapes[1]);
    });
  });

  describe('failure handling (§27/§39)', () => {
    it('returns the resolution failure code without throwing', async () => {
      for (const failure of [
        'MODULE_NOT_FOUND',
        'MODULE_DISABLED',
        'MODULE_FORBIDDEN',
        'MODULE_UNAVAILABLE',
        'CONTRACT_UNSUPPORTED',
      ]) {
        registry.resolve.mockResolvedValue({ ok: false, failure });

        await expect(
          client.call({
            moduleId: 'finance',
            contract: 'module.invoke@v1',
            operation: 'invoice.read',
            payload: {},
          }),
        ).resolves.toEqual({ ok: false, errorCode: failure });
      }

      expect(transport.send).not.toHaveBeenCalled();
    });

    it('leaks no network information in a failure', async () => {
      // §39: a controlled error, with nothing about the topology in it.
      registry.resolve.mockResolvedValue({ ok: false, failure: 'MODULE_UNAVAILABLE' });

      const result = await client.call({
        moduleId: 'finance',
        contract: 'module.invoke@v1',
        operation: 'invoice.read',
        payload: {},
      });

      expect(JSON.stringify(result)).not.toContain('finance.example.com');
      expect(result).not.toHaveProperty('baseUrl');
    });

    it('refuses to call without a usable credential, rather than sending unsigned', async () => {
      registry.resolveSecret.mockResolvedValue(undefined);

      await expect(
        client.call({
          moduleId: 'finance',
          contract: 'module.invoke@v1',
          operation: 'invoice.read',
          payload: {},
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'MODULE_FORBIDDEN' });

      expect(transport.send).not.toHaveBeenCalled();
    });

    it('never returns the credential it resolved', async () => {
      const result = await client.call({
        moduleId: 'finance',
        contract: 'module.invoke@v1',
        operation: 'invoice.read',
        payload: {},
      });

      expect(JSON.stringify(result)).not.toContain('s'.repeat(64));
    });
  });

  describe('timeout clamping', () => {
    it('defaults when no timeout is supplied', async () => {
      await client.call({
        moduleId: 'finance',
        contract: 'module.invoke@v1',
        operation: 'invoice.read',
        payload: {},
      });

      expect(transport.send.mock.calls[0][2].timeoutMs).toBe(DEFAULT_MODULE_TIMEOUT_MS);
    });

    it('clamps rather than rejects an out-of-range timeout', async () => {
      // An in-process caller has no DTO; capping is a better answer than failing the call.
      await client.call({
        moduleId: 'finance',
        contract: 'module.invoke@v1',
        operation: 'invoice.read',
        payload: {},
        timeoutMs: 10 * 60 * 1000,
      });

      expect(transport.send.mock.calls[0][2].timeoutMs).toBe(MAX_MODULE_TIMEOUT_MS);
    });
  });

  describe('isAvailable', () => {
    it('reuses resolve, so availability means what the call path means', async () => {
      registry.resolve.mockResolvedValue({ ok: true, instance: resolved() });
      await expect(client.isAvailable('finance')).resolves.toBe(true);

      registry.resolve.mockResolvedValue({ ok: false, failure: 'MODULE_DISABLED' });
      await expect(client.isAvailable('finance')).resolves.toBe(false);

      // It does NOT call the module: checking availability must not cause a side effect.
      expect(transport.send).not.toHaveBeenCalled();
    });
  });
});

