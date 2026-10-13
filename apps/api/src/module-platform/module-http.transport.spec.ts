import { ModuleHttpTransport, MODULE_INVOKE_PATH } from './module-http.transport';
import {
  MODULE_ID_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TENANT_HEADER,
  MODULE_TIMESTAMP_HEADER,
  verifyModuleRequest,
} from './module-signature';
import { MAX_MODULE_PAYLOAD_BYTES, type ResolvedModuleInstance } from './module.contract';
import { ALLOW_PRIVATE_ENV_VAR } from '../integrations/integration-url.guard';

/**
 * Phase 49M §24/§25/§26: the HTTP transport.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - ONE TRANSPORT SERVES ALL FOUR MODES (§25/§35). The same instance is sent to in LOCAL and in
 *    REMOTE and the outgoing request is asserted to be structurally identical apart from the URL —
 *    which is the whole "moving a module changes a row, not code" claim, made checkable.
 *  - THE REQUEST IS SIGNED, AND THE SIGNATURE VERIFIES. The spec re-verifies the outgoing signature
 *    with the same secret, so a canonicalisation change on either side fails here.
 *  - NOTHING THROWS (§27). Timeout, network failure, 4xx, 5xx, unparseable body and an over-large
 *    payload all come back as `ok: false` with a distinct short code.
 *  - THE POLICY IS RE-APPLIED PER CALL (§40). A stored endpoint that the policy now refuses is
 *    blocked at call time, not trusted from registration time.
 *  - NO UPSTREAM BODY LEAKS. A module's own error message never reaches the result.
 */

const instance = (overrides: Partial<ResolvedModuleInstance> = {}): ResolvedModuleInstance => ({
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

const request = {
  moduleId: 'finance',
  contract: 'module.invoke@v1',
  operation: 'invoice.read',
  payload: { id: 'inv-1' },
};

const SECRET = 's'.repeat(64);

const context = (overrides: Record<string, unknown> = {}) => ({
  tenant: { tenantId: 'tenant-1' as string | null },
  actor: { actorId: 'user-1', actorType: 'user' as const },
  correlationId: 'corr-1',
  requestId: 'req-1',
  secret: SECRET,
  timeoutMs: 5_000,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  ({
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

describe('ModuleHttpTransport', () => {
  let transport: ModuleHttpTransport;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;
  const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

  beforeEach(() => {
    transport = new ModuleHttpTransport();
    fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { total: 10 } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalFlag === undefined) delete process.env[ALLOW_PRIVATE_ENV_VAR];
    else process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
  });

  it('declares support for every deployment mode', () => {
    // §25: no local/remote split. One transport, one contract.
    expect([...transport.modes].sort()).toEqual(['CENTRAL', 'HYBRID', 'LOCAL', 'REMOTE']);
  });

  it('sends a signed request whose signature verifies', async () => {
    await transport.send(instance(), request, context());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://finance.example.com${MODULE_INVOKE_PATH}`);

    const verification = verifyModuleRequest(
      SECRET,
      {
        method: 'POST',
        path: MODULE_INVOKE_PATH,
        timestamp: init.headers[MODULE_TIMESTAMP_HEADER],
        identity: { moduleId: 'finance', requestId: 'req-1', tenantId: 'tenant-1' },
        body: init.body,
      },
      init.headers[MODULE_SIGNATURE_HEADER],
    );

    expect(verification).toEqual({ ok: true });
  });

  it('puts the tenant in the SIGNED body, not only in a header', async () => {
    // §21 at the far end: a receiver that trusts only signed material must be able to find the
    // tenant there.
    await transport.send(instance(), request, context());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tenantId).toBe('tenant-1');
    expect(fetchMock.mock.calls[0][1].headers[MODULE_TENANT_HEADER]).toBe('tenant-1');
  });

  it('sends a minimal actor and nothing more (§22)', async () => {
    await transport.send(instance(), request, context());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.actor).toEqual({ actorId: 'user-1', actorType: 'user' });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('email');
    expect(serialised).not.toContain('role');
    expect(serialised).not.toContain(SECRET);
  });

  it('builds an IDENTICAL request for a LOCAL and a REMOTE instance, apart from the URL', async () => {
    // THE §35 ASSERTION. Same body, same header names, same signed identity — the only difference
    // is where it is posted.
    await transport.send(instance({ deploymentMode: 'REMOTE' }), request, context());
    const remote = fetchMock.mock.calls[0][1];

    fetchMock.mockClear();

    await transport.send(
      instance({ deploymentMode: 'LOCAL', baseUrl: 'http://localhost:5010' }),
      request,
      context(),
    );
    const local = fetchMock.mock.calls[0][1];

    expect(JSON.parse(local.body)).toEqual(JSON.parse(remote.body));
    expect(Object.keys(local.headers).sort()).toEqual(Object.keys(remote.headers).sort());
    expect(local.headers[MODULE_ID_HEADER]).toBe(remote.headers[MODULE_ID_HEADER]);
  });

  describe('failure handling (§27)', () => {
    it('reports TIMEOUT without throwing', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

      await expect(transport.send(instance(), request, context())).resolves.toMatchObject({
        ok: false,
        errorCode: 'TIMEOUT',
        instanceId: 'finance-prod-01',
      });
    });

    it('reports UNREACHABLE for any other network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(transport.send(instance(), request, context())).resolves.toMatchObject({
        ok: false,
        errorCode: 'UNREACHABLE',
      });
    });

    it('reports HTTP_<status> and never the upstream body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ message: 'internal detail: db at 10.0.0.5 refused' }, 500),
      );

      const result = await transport.send(instance(), request, context());

      expect(result).toMatchObject({ ok: false, errorCode: 'HTTP_500' });
      expect(JSON.stringify(result)).not.toContain('10.0.0.5');
    });

    it('reports INVALID_RESPONSE for an unparseable body', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        text: async () => 'not json',
      } as unknown as Response);

      await expect(transport.send(instance(), request, context())).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_RESPONSE',
      });
    });

    it('accepts an empty 200 as a null payload rather than a failure', async () => {
      // "The module said nothing" is a legal answer; "we could not read it" is not.
      fetchMock.mockResolvedValue({ status: 200, text: async () => '' } as unknown as Response);

      await expect(transport.send(instance(), request, context())).resolves.toMatchObject({
        ok: true,
        data: null,
      });
    });

    it('refuses an over-large payload BEFORE sending it', async () => {
      const oversized = { blob: 'x'.repeat(MAX_MODULE_PAYLOAD_BYTES + 1) };

      const result = await transport.send(
        instance(),
        { ...request, payload: oversized },
        context(),
      );

      expect(result).toMatchObject({ ok: false, errorCode: 'PAYLOAD_TOO_LARGE' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to call an instance with no endpoint', async () => {
      await expect(
        transport.send(instance({ deploymentMode: 'LOCAL', baseUrl: null }), request, context()),
      ).resolves.toMatchObject({ ok: false, errorCode: 'MODULE_UNAVAILABLE' });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('endpoint policy at call time (§40)', () => {
    it('blocks a stored endpoint the policy now refuses', async () => {
      // The row was legal when written; the deployment has since revoked private targets. The call
      // must be blocked rather than dialled.
      process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';

      const result = await transport.send(
        instance({ deploymentMode: 'REMOTE', baseUrl: 'http://finance.example.com' }),
        request,
        context(),
      );

      expect(result).toMatchObject({ ok: false, errorCode: 'SSRF_BLOCKED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('blocks a metadata endpoint even with private targets allowed', async () => {
      process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

      const result = await transport.send(
        instance({ deploymentMode: 'LOCAL', baseUrl: 'http://169.254.169.254' }),
        request,
        context(),
      );

      expect(result).toMatchObject({ ok: false, errorCode: 'SSRF_BLOCKED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('success', () => {
    it('returns the module data unwrapped from its envelope', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { total: 42 } }));

      await expect(transport.send(instance(), request, context())).resolves.toEqual({
        ok: true,
        data: { total: 42 },
        instanceId: 'finance-prod-01',
        correlationId: 'corr-1',
      });
    });

    it('carries the correlation id through unchanged (§23)', async () => {
      const result = await transport.send(instance(), request, context({ correlationId: 'trace-9' }));

      expect(result.correlationId).toBe('trace-9');
    });

    it('signs a tenant-less call distinctly from a tenant-bearing one', async () => {
      await transport.send(instance(), request, context({ tenant: { tenantId: null } }));
      const anonymous = fetchMock.mock.calls[0][1];

      // The tenant header is ABSENT rather than empty, and the body records null explicitly.
      expect(anonymous.headers[MODULE_TENANT_HEADER]).toBeUndefined();
      expect(JSON.parse(anonymous.body).tenantId).toBeNull();
    });
  });
});

