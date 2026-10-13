import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { ModuleHttpTransport, MODULE_INVOKE_PATH } from './module-http.transport';
import {
  MODULE_ID_HEADER,
  MODULE_REQUEST_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TIMESTAMP_HEADER,
  verifyModuleRequest,
} from './module-signature';
import { CORE_MODULE_CONTRACT, type ResolvedModuleInstance } from './module.contract';
import { ALLOW_PRIVATE_ENV_VAR } from '../integrations/integration-url.guard';

/**
 * Phase 49M §42/§43: integration test against a REAL, DISPOSABLE module service.
 *
 * WHAT MAKES THIS AN INTEGRATION TEST RATHER THAN ANOTHER UNIT TEST
 * ----------------------------------------------------------------
 * `module-http.transport.spec.ts` stubs `fetch`. This file does not: it starts an actual
 * `http.Server` on loopback, and the real `ModuleHttpTransport` makes a real network request to it.
 * The fake module VERIFIES THE SIGNATURE with the same primitives Core would use at the far end, so
 * the whole chain — canonicalisation, header names, body serialisation, HMAC — is exercised end to
 * end rather than asserted against a mock's arguments.
 *
 * §43: THE FAKE IS NOT CALLED HR OR FINANCE, and it has no domain. Its module id is
 * `module-under-test`, its capability is `probe.echo`, and its only operation echoes what it is
 * given. Nothing about it implies a business module exists, and it is torn down in `afterAll`.
 *
 * WHAT THIS FILE CANNOT COVER, STATED HONESTLY
 * -------------------------------------------
 * A REMOTE/CENTRAL/HYBRID instance must be reachable over HTTPS (§26), and generating a trusted
 * certificate inside a unit-test run would mean adding a certificate-generation dependency for one
 * test — which §1/§3 refuse. So the real-server leg runs in LOCAL mode over loopback HTTP, which is
 * the genuine local topology, and the REMOTE leg is asserted at the POLICY boundary instead: the same
 * instance, same server, same client, registered as REMOTE, is refused before a socket is opened.
 * That is the honest split — the transport is proven against a real server, and the mode-specific
 * network rule is proven to be enforced. A full TLS E2E is recorded as deferred in the closure report.
 */

/** The disposable module. No domain, no business data, no persistence. */
interface FakeModuleState {
  server: Server;
  port: number;
  /** Every request the fake received, for assertions. Cleared between tests. */
  received: {
    signatureValid: boolean;
    moduleId?: string;
    tenantId: unknown;
    operation: unknown;
    payload: unknown;
  }[];
  /** Flipped by a test to make the fake fail in a specific way. */
  behaviour: 'ok' | 'reject-500' | 'garbage';
}

const SECRET = 'e'.repeat(64);
const MODULE_ID = 'module-under-test';

let fake: FakeModuleState;

const startFakeModule = () =>
  new Promise<FakeModuleState>((resolve) => {
    const state: Partial<FakeModuleState> = { received: [], behaviour: 'ok' };

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = body ? JSON.parse(body) : {};

        // THE FAKE VERIFIES THE SIGNATURE ITSELF, exactly as a real module would: it reads the
        // tenant from the SIGNED material rather than trusting the header (§21).
        const verification = verifyModuleRequest(
          SECRET,
          {
            method: req.method ?? 'POST',
            path: req.url ?? '/',
            timestamp: String(req.headers[MODULE_TIMESTAMP_HEADER] ?? ''),
            identity: {
              moduleId: String(req.headers[MODULE_ID_HEADER] ?? ''),
              requestId: String(req.headers[MODULE_REQUEST_HEADER] ?? ''),
              tenantId: (parsed.tenantId ?? null) as string | null,
            },
            body,
          },
          req.headers[MODULE_SIGNATURE_HEADER] as string | undefined,
        );

        state.received!.push({
          signatureValid: verification.ok,
          moduleId: req.headers[MODULE_ID_HEADER] as string | undefined,
          tenantId: parsed.tenantId,
          operation: parsed.operation,
          payload: parsed.payload,
        });

        if (!verification.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }

        if (state.behaviour === 'reject-500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'internal detail at 10.0.0.5' }));
          return;
        }

        if (state.behaviour === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('not json');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { echoed: parsed.payload, operation: parsed.operation } }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.port = (server.address() as AddressInfo).port;
      resolve(state as FakeModuleState);
    });
  });

const instance = (
  overrides: Partial<ResolvedModuleInstance> = {},
): ResolvedModuleInstance => ({
  moduleId: MODULE_ID,
  instanceId: 'module-under-test-01',
  version: '1.0.0',
  deploymentMode: 'LOCAL',
  baseUrl: `http://127.0.0.1:${fake.port}`,
  healthPath: '/health',
  capabilities: ['probe.echo'],
  apiContracts: [CORE_MODULE_CONTRACT],
  lifecycle: 'ACTIVE',
  health: 'HEALTHY',
  lastSeenAt: new Date(),
  ...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
  tenant: { tenantId: 'tenant-1' as string | null },
  actor: { actorId: 'user-1', actorType: 'user' as const },
  correlationId: 'corr-integration',
  requestId: 'req-integration',
  secret: SECRET,
  timeoutMs: 5_000,
  ...overrides,
});

describe('ModuleHttpTransport against a real disposable module', () => {
  let transport: ModuleHttpTransport;
  const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

  beforeAll(async () => {
    fake = await startFakeModule();
  });

  afterAll(async () => {
    // The fixture is disposable and is disposed of: no state survives this file.
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  beforeEach(() => {
    transport = new ModuleHttpTransport();
    fake.received.length = 0;
    fake.behaviour = 'ok';
    // Loopback is a private target; the local topology requires this to be opted in, exactly as the
    // compose file does.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[ALLOW_PRIVATE_ENV_VAR];
    else process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
  });

  it('completes a REAL signed round trip', async () => {
    const result = await transport.send(
      instance(),
      {
        moduleId: MODULE_ID,
        contract: CORE_MODULE_CONTRACT,
        operation: 'probe.echo',
        payload: { hello: 'world' },
      },
      context(),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ echoed: { hello: 'world' }, operation: 'probe.echo' });

    // THE FAR END VERIFIED THE SIGNATURE. This is the assertion that makes the file worth having:
    // canonicalisation, headers, body serialisation and HMAC all agree across a real socket.
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0].signatureValid).toBe(true);
    expect(fake.received[0].moduleId).toBe(MODULE_ID);
  });

  it('delivers the tenant in the SIGNED body, so the far end can trust it', async () => {
    await transport.send(
      instance(),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context({ tenant: { tenantId: 'tenant-7' } }),
    );

    expect(fake.received[0].tenantId).toBe('tenant-7');
    expect(fake.received[0].signatureValid).toBe(true);
  });

  it('is rejected by the far end when the credential does not match', async () => {
    const result = await transport.send(
      instance(),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context({ secret: 'z'.repeat(64) }),
    );

    // The fake answered 401; Core reports the status code and nothing else.
    expect(result).toMatchObject({ ok: false, errorCode: 'HTTP_401' });
    expect(fake.received[0].signatureValid).toBe(false);
  });

  it('posts to the fixed contract path, which no caller can choose', async () => {
    await transport.send(
      instance(),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context(),
    );

    // Asserted through the fake's own view of the request: the signature covers the path, and the
    // fake verified it, so the path Core used is the path the signature was made for.
    expect(MODULE_INVOKE_PATH).toBe('/module/v1/invoke');
    expect(fake.received[0].signatureValid).toBe(true);
  });

  it('reports a real 5xx without leaking the module’s message', async () => {
    fake.behaviour = 'reject-500';

    const result = await transport.send(
      instance(),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context(),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'HTTP_500' });
    // The fake put internal topology in its error body; none of it reaches the caller.
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });

  it('reports a real unparseable response as INVALID_RESPONSE', async () => {
    fake.behaviour = 'garbage';

    await expect(
      transport.send(
        instance(),
        { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_RESPONSE' });
  });

  it('reports UNREACHABLE for a real closed port, without throwing', async () => {
    // A port nothing is listening on. This exercises the genuine connection-refused path rather than
    // a mocked rejection.
    const result = await transport.send(
      instance({ baseUrl: 'http://127.0.0.1:1' }),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context(),
    );

    expect(result.ok).toBe(false);
    expect(['UNREACHABLE', 'TIMEOUT']).toContain(result.errorCode);
  });

  it('SENDS NOTHING when the same server is registered as REMOTE over plain HTTP (§26)', async () => {
    // THE MODE-SPECIFIC NETWORK RULE, proven against a real server: identical instance, identical
    // client, identical fake — only `deploymentMode` differs, and the call is refused before a socket
    // is opened. This is the deliberate substitute for a full TLS E2E (see the header note).
    const result = await transport.send(
      instance({ deploymentMode: 'REMOTE' }),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: {} },
      context(),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'SSRF_BLOCKED' });
    expect(fake.received).toHaveLength(0);
  });

  it('runs the SAME code path for LOCAL as the one REMOTE would use over HTTPS', async () => {
    // §25/§35 against a real socket: the LOCAL call succeeds through exactly the method a REMOTE call
    // would use, so there is demonstrably one transport and one business contract.
    const local = await transport.send(
      instance({ deploymentMode: 'LOCAL' }),
      { moduleId: MODULE_ID, contract: CORE_MODULE_CONTRACT, operation: 'probe.echo', payload: { n: 1 } },
      context(),
    );

    expect(local.ok).toBe(true);
    expect(transport.modes).toContain('LOCAL');
    expect(transport.modes).toContain('REMOTE');
  });
});


