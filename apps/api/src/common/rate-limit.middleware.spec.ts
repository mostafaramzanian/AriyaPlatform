import { RateLimitMiddleware } from './rate-limit.middleware';
import type { Redis } from 'ioredis';
import type { Request, Response } from 'express';

type MockRedis = {
  get: jest.Mock;
  del: jest.Mock;
  pipeline: jest.Mock;
};

function createMockRedis(initial: Record<string, string> = {}): MockRedis {
  const store = new Map<string, string>(Object.entries(initial));
  const get = jest.fn(async (key: string) => store.get(key) ?? null);
  const del = jest.fn(async (key: string) => {
    store.delete(key);
    return 1;
  });

  const pipeline = jest.fn(() => {
    let lastValue: unknown = null;
    const self = {
      incr: (key: string) => {
        store.set(key, String((Number(store.get(key)) || 0) + 1));
        lastValue = Number(store.get(key));
        return self;
      },
      expire: () => {
        return self;
      },
      exec: jest.fn(async () => [lastValue]),
    };
    return self;
  });

  return { get, del, pipeline };
}

function createMockResponse() {
  const res = {
    statusCode: 200,
    on: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    originalUrl: '/api/v1/auth/login',
    body: {},
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

describe('RateLimitMiddleware', () => {
  let middleware: RateLimitMiddleware;
  let redis: MockRedis;

  beforeEach(() => {
    redis = createMockRedis();
    middleware = new RateLimitMiddleware(redis as unknown as Redis);
  });

  it('allows requests below the limit', async () => {
    const req = createMockRequest({ body: { email: 'test@example.com' } });
    const res = createMockResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      middleware.use(req, res, () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('blocks requests over the limit', async () => {
    const req = createMockRequest({ body: { email: 'attacker@example.com' } });
    redis = createMockRedis({ [`rl:login:email:attacker@example.com`]: '5' });
    middleware = new RateLimitMiddleware(redis as unknown as Redis);
    const res = createMockResponse();
    const next = jest.fn();

    middleware.use(req, res, () => {
      next();
    });

    // Wait for the async Redis check and 429 response.
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('increments on 401 login failures and resets on success', async () => {
    const req = createMockRequest({ body: { email: 'fail@example.com' } });
    const res = createMockResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      middleware.use(req, res, () => {
        next();
        resolve();
      });
    });

    // Simulate 401 response
    const finishHandlers = (res.on as jest.Mock).mock.calls.filter(
      (call) => call[0] === 'finish',
    );
    expect(finishHandlers).toHaveLength(1);
    res.statusCode = 401;
    finishHandlers[0][1]();

    expect(redis.pipeline).toHaveBeenCalled();

    // Simulate success resets
    res.statusCode = 200;
    finishHandlers[0][1]();
    expect(redis.del).toHaveBeenCalled();
  });

  it('ignores non-auth routes', async () => {
    const req = createMockRequest({ originalUrl: '/api/v1/users/profile' });
    const res = createMockResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      middleware.use(req, res, () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });
});
