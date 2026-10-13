import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { REDIS_CLIENT } from '../../common/redis.module';

function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const get = jest.fn(async (key: string) => store.get(key) ?? null);
  const setex = jest.fn(async (key: string, seconds: number, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const del = jest.fn(async (key: string) => {
    store.delete(key);
    return 1;
  });
  const sadd = jest.fn(async (key: string, ...members: string[]) => {
    if (!sets.has(key)) sets.set(key, new Set());
    const set = sets.get(key)!;
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  });
  const srem = jest.fn(async (key: string, ...members: string[]) => {
    const set = sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  });
  const smembers = jest.fn(async (key: string) => {
    const set = sets.get(key);
    return set ? Array.from(set) : [];
  });
  const expire = jest.fn(async (key: string, seconds: number) => {
    // The double ignores both arguments (no TTL simulation in this harness);
    // they are declared so the production call sites type-check.
    void key;
    void seconds;
    return 1;
  });

  // Simplified Lua-eval simulation for the createSession cap-enforcement script.
  const evalScript = jest.fn(async (_script: string, _numKeys: number, ...args: unknown[]) => {
    const indexKey = args[0] as string;
    const newSessionKey = args[1] as string;
    const cap = Number(args[2]);
    const ttl = Number(args[3]);
    const payload = args[4] as string;
    const sessionId = args[5] as string;
    const userId = args[6] as string;
    const sessionPrefix = `session:${userId}:`;

    const members = await smembers(indexKey);
    const valid: Array<{ sid: string; createdAt: string }> = [];
    for (const sid of members) {
      const raw = await get(sessionPrefix + sid);
      if (raw) {
        const data = JSON.parse(raw) as { createdAt?: string };
        valid.push({ sid, createdAt: data.createdAt || '' });
      } else {
        await srem(indexKey, sid);
      }
    }

    valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (valid.length >= cap) {
      const toRemove = valid.length - cap + 1;
      for (let i = 0; i < toRemove; i++) {
        await del(sessionPrefix + valid[i].sid);
        await srem(indexKey, valid[i].sid);
      }
    }

    await setex(newSessionKey, ttl, payload);
    await sadd(indexKey, sessionId);
    await expire(indexKey, ttl);
    return sessionId;
  });

  const pipeline = jest.fn(() => {
    const cmds: Array<() => Promise<unknown>> = [];
    const self = {
      setex: (...args: unknown[]) => {
        cmds.push(() => setex(args[0] as string, args[1] as number, args[2] as string));
        return self;
      },
      get: (key: string) => {
        cmds.push(() => get(key));
        return self;
      },
      del: (key: string) => {
        cmds.push(() => del(key));
        return self;
      },
      sadd: (key: string, ...members: string[]) => {
        cmds.push(() => sadd(key, ...members));
        return self;
      },
      srem: (key: string, ...members: string[]) => {
        cmds.push(() => srem(key, ...members));
        return self;
      },
      expire: (key: string, seconds: number) => {
        cmds.push(() => expire(key, seconds));
        return self;
      },
      exec: jest.fn(async () => {
        return Promise.all(cmds.map((c) => c()));
      }),
    };
    return self;
  });

  return {
    get,
    setex,
    del,
    sadd,
    srem,
    smembers,
    expire,
    pipeline,
    eval: evalScript,
    store,
    sets,
  };
}

describe('SessionService', () => {
  let service: SessionService;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    redis = createMockRedis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: REDIS_CLIENT,
          useValue: redis,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, def: unknown) => (key === 'MAX_ACTIVE_SESSIONS_PER_USER' ? 3 : def)) },
        },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  it('should create a session and index it under the user', async () => {
    const sessionId = await service.createSession('user-1', {
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(sessionId).toBeDefined();
    expect(redis.eval).toHaveBeenCalled();
    expect(redis.sets.get('sessions:user:user-1')?.has(sessionId)).toBe(true);
    expect(redis.store.has(`session:user-1:${sessionId}`)).toBe(true);
  });

  it('should retrieve a stored session', async () => {
    const sessionId = await service.createSession('user-1', { ipAddress: '127.0.0.1' });

    const payload = await service.getSession('user-1', sessionId);

    expect(payload).toMatchObject({ userId: 'user-1', sessionId });
  });

  it('should invalidate a specific session and remove it from the index', async () => {
    const sessionId = await service.createSession('user-1', {});

    await service.invalidateSession('user-1', sessionId);

    expect(redis.del).toHaveBeenCalledWith(`session:user-1:${sessionId}`);
    expect(redis.srem).toHaveBeenCalledWith(`sessions:user:user-1`, sessionId);
  });

  it('should invalidate all sessions for a user', async () => {
    const id1 = await service.createSession('user-1', {});
    const id2 = await service.createSession('user-1', {});

    await service.invalidateAllSessions('user-1');

    expect(redis.del).toHaveBeenCalledWith(`session:user-1:${id1}`);
    expect(redis.del).toHaveBeenCalledWith(`session:user-1:${id2}`);
    expect(redis.del).toHaveBeenCalledWith(`sessions:user:user-1`);
  });

  it('should be idempotent when no sessions exist', async () => {
    await expect(service.invalidateAllSessions('user-empty')).resolves.toBeUndefined();
  });

  it('should enforce a per-user session cap and evict the oldest sessions deterministically', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await service.createSession('user-cap', { n: i }));
      // Ensure distinct createdAt ordering by waiting a tiny bit
      await new Promise((r) => setTimeout(r, 2));
    }

    // At cap (3), set has all 3
    expect(redis.sets.get('sessions:user:user-cap')?.size).toBe(3);
    expect(ids.every((id) => redis.store.has(`session:user-cap:${id}`))).toBe(true);

    const fourth = await service.createSession('user-cap', { n: 3 });

    const index = redis.sets.get('sessions:user:user-cap');
    expect(index?.size).toBe(3);
    expect(index?.has(ids[0])).toBe(false); // oldest evicted
    expect(redis.store.has(`session:user-cap:${ids[0]}`)).toBe(false);
    expect(index?.has(ids[1])).toBe(true);
    expect(index?.has(ids[2])).toBe(true);
    expect(index?.has(fourth)).toBe(true);
  });

  it('should remove stale index entries when creating a new session', async () => {
    const id1 = await service.createSession('user-stale', { n: 1 });
    const id2 = await service.createSession('user-stale', { n: 2 });

    // Simulate underlying session key expiry without updating the index
    redis.store.delete(`session:user-stale:${id1}`);

    const id3 = await service.createSession('user-stale', { n: 3 });

    const index = redis.sets.get('sessions:user:user-stale');
    expect(index?.has(id1)).toBe(false);
    expect(index?.has(id2)).toBe(true);
    expect(index?.has(id3)).toBe(true);
  });
});
