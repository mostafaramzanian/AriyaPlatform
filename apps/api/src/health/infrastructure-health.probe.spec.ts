import { createServer, type Server } from 'net';
import { InfrastructureHealthProbe } from './infrastructure-health.probe';
import { RuntimeId } from '../runtime-datasources';

/**
 * Phase ARCH-1.3: the infrastructure PROBE.
 *
 * Three things are asserted here, and each of them is a bug that was actually
 * possible before ARCH-1.3:
 *
 *  1. NO INVENTED CONFIGURATION. An unset RABBITMQ_URL must be reported as
 *     not-configured. The old implementation substituted a literal
 *     `amqp://user:password@host:port` fallback, which both leaked a credential into
 *     source and made "never configured" indistinguishable from "configured and
 *     down".
 *  2. NO SECOND CONNECTION. Redis is probed through the injected canonical
 *     REDIS_CLIENT. When it is absent the probe REPORTS that instead of opening a
 *     connection of its own from inside a health check, so a health poll cannot
 *     multiply Redis connections.
 *  3. NEVER THROWS. Anything the outside world does becomes a result.
 */

const ENV_KEYS = ['REDIS_URL', 'RABBITMQ_URL', 'MINIO_ENDPOINT'] as const;

/**
 * A real listening socket, so "reachable" is proven against the operating system
 * rather than against a mocked `net` module. The probe is the only thing under test
 * here; faking the transport would make these assertions about the mock.
 */
const listeningServer = (): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** A port nothing is listening on: bound, then released, so it is free but known. */
const unusedPort = async (): Promise<number> => {
  const server = await listeningServer();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await closeServer(server);
  return port;
};

describe('InfrastructureHealthProbe', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    jest.restoreAllMocks();
  });

  const probeFor = (runtime: RuntimeId, redisClient?: unknown) =>
    new InfrastructureHealthProbe(runtime, redisClient as never);

  describe('redis', () => {
    it('uses the canonical injected client and reports ok on PONG', async () => {
      const redis = { ping: jest.fn().mockResolvedValue('PONG') };
      process.env.REDIS_URL = 'redis://redis:6379';

      const result = await probeFor('core', redis).probeRedis();

      expect(result.status).toBe('ok');
      expect(result.requirement).toBe('optional');
      expect(redis.ping).toHaveBeenCalledTimes(1);
    });

    it('reports failed (not pending) when PING never settles, within the probe timeout', async () => {
      jest.useFakeTimers();
      try {
        // A client whose PING never settles, as an offline-queued command does while
        // Redis is unreachable. Before the fix this promise was awaited forever.
        const redis = { ping: jest.fn(() => new Promise<never>(() => undefined)) };
        process.env.REDIS_URL = 'redis://redis:6379';

        const pending = probeFor('core', redis).probeRedis();
        jest.advanceTimersByTime(3000);
        const result = await pending;

        expect(result.status).toBe('failed');
        expect(result.detail).toMatch(/PING timed out after 3000ms/);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does NOT open its own connection when the canonical client is missing', async () => {
      // No REDIS_CLIENT is injected but the URL IS configured: that is a wiring
      // fault, and it must be reported as such rather than papered over by building
      // a second client inside the health check.
      process.env.REDIS_URL = 'redis://redis:6379';

      const result = await probeFor('core').probeRedis();

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/REDIS_CLIENT is not provided/);
    });

    it('reports not-configured when neither the client nor REDIS_URL exists', async () => {
      const result = await probeFor('core').probeRedis();

      expect(result.status).toBe('not-configured');
      expect(result.detail).toMatch(/REDIS_URL is not configured/);
    });

    it('reports failed, sanitized, when PING rejects', async () => {
      const redis = {
        ping: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED redis://:pw@redis:6379')),
      };

      const result = await probeFor('core', redis).probeRedis();

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/ECONNREFUSED/);
      expect(result.detail).not.toContain('pw@');
      expect(result.detail).not.toContain('redis://');
    });

    it('reports failed on an unexpected PING reply', async () => {
      const redis = { ping: jest.fn().mockResolvedValue('NOPE') };

      const result = await probeFor('core', redis).probeRedis();

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/unexpected PING reply/);
    });
  });

  describe('rabbitmq', () => {
    it('reports not-configured when RABBITMQ_URL is unset, and never invents a broker', async () => {
      const result = await probeFor('core').probeRabbitMQ();

      expect(result.status).toBe('not-configured');
      expect(result.requirement).toBe('optional');
      expect(result.detail).toMatch(/RABBITMQ_URL is not configured/);
      // REGRESSION: the previous implementation fell back to a hard-coded
      // `amqp://user:password@host:port`. No credential may ever appear in a probe
      // result, and no connection may be attempted without configuration.
      expect(result.detail).not.toMatch(/amqp:\/\//);
      expect(result.detail).not.toMatch(/password/);
    });

    it('reports a malformed URL as failed without echoing the value', async () => {
      process.env.RABBITMQ_URL = 'amqp://guest:sup3rsecret@:not-a-port/vhost';

      const result = await probeFor('core').probeRabbitMQ();

      expect(result.status).toBe('failed');
      expect(result.detail).toBe('RABBITMQ_URL is not a valid AMQP URL');
      expect(result.detail).not.toContain('sup3rsecret');
    });

    it('reports failed when nothing is listening on the broker port', async () => {
      const port = await unusedPort();
      process.env.RABBITMQ_URL = `amqp://guest:guest@127.0.0.1:${port}`;

      const result = await probeFor('core').probeRabbitMQ();

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/no TCP connection to the AMQP broker/);
    });

    it('reports ok when the broker port accepts a connection', async () => {
      const server = await listeningServer();
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      process.env.RABBITMQ_URL = `amqp://guest:guest@127.0.0.1:${port}`;

      try {
        const result = await probeFor('core').probeRabbitMQ();

        expect(result.status).toBe('ok');
        expect(result.detail).toBeNull();
      } finally {
        await closeServer(server);
      }
    });
  });

  describe('minio', () => {
    it('reports not-configured when MINIO_ENDPOINT is unset', async () => {
      const result = await probeFor('core').probeMinIO();

      expect(result.status).toBe('not-configured');
      expect(result.requirement).toBe('optional');
      expect(result.detail).toMatch(/MINIO_ENDPOINT is not configured/);
    });

    it('probes the object store health path, prefixing a bare host:port with http', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as never);
      process.env.MINIO_ENDPOINT = 'minio:9000';

      const result = await probeFor('core').probeMinIO();

      expect(result.status).toBe('ok');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://minio:9000/minio/health/live',
        expect.objectContaining({ signal: expect.anything() })
      );
    });

    it('does not double-prefix an endpoint that already carries a scheme', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue({ ok: true, status: 200 } as never);
      process.env.MINIO_ENDPOINT = 'https://storage.example.com';

      await probeFor('core').probeMinIO();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://storage.example.com/minio/health/live',
        expect.anything()
      );
    });

    it('treats 403 and 404 as reachable, since a responding endpoint is the claim', async () => {
      for (const status of [403, 404]) {
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status } as never);
        process.env.MINIO_ENDPOINT = 'minio:9000';

        const result = await probeFor('core').probeMinIO();

        expect(result.status).toBe('ok');
      }
    });

    it('reports failed with the status code for a real error response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 } as never);
      process.env.MINIO_ENDPOINT = 'minio:9000';

      const result = await probeFor('core').probeMinIO();

      expect(result.status).toBe('failed');
      expect(result.detail).toBe('HTTP 503');
    });

    it('reports failed, sanitized, when the request throws', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('request to http://minio:9000 failed: ECONNREFUSED'));
      process.env.MINIO_ENDPOINT = 'minio:9000';

      const result = await probeFor('core').probeMinIO();

      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/ECONNREFUSED/);
      expect(result.detail).not.toContain('http://minio:9000');
    });
  });

  describe('probeAll', () => {
    it('probes all three services and never throws', async () => {
      const results = await probeFor('core').probeAll();

      expect(results.map((r) => r.key)).toEqual(['redis', 'rabbitmq', 'storage']);
      expect(results.every((r) => r.status === 'not-configured')).toBe(true);
    });
  });
});
