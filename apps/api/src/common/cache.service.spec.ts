jest.mock('ioredis', () => {
  // Force Redis constructor to throw so CacheService falls back to in-memory behavior
  return jest.fn().mockImplementation(() => {
    throw new Error('ioredis disabled for tests');
  });
});

import { CacheService } from './cache.service';
import type { Cache } from 'cache-manager';

describe('CacheService (fallback)', () => {
  it('wrap singleflight prevents duplicate work', async () => {
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) };
    const svc = new CacheService(cache as unknown as Cache);

    let runs = 0;
    const fn = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 50));
      return { v: 'ok' };
    };

    const [a, b] = await Promise.all([svc.wrap('k1', 10, ['t1'], fn), svc.wrap('k1', 10, ['t1'], fn)]);
    expect(a).toEqual({ v: 'ok' });
    expect(b).toEqual({ v: 'ok' });
    expect(runs).toBe(1);
  });

  it('invalidateTags falls back to cacheManager deletes', async () => {
    const cache = { get: jest.fn().mockResolvedValue(undefined), set: jest.fn().mockResolvedValue(undefined), del: jest.fn().mockResolvedValue(undefined) };
    const svc = new CacheService(cache as unknown as Cache);
    await svc.invalidateTags(['blog:latest', 'blog:homepage']);
    expect(cache.del).toHaveBeenCalledWith('blog:latest');
    expect(cache.del).toHaveBeenCalledWith('blog:homepage');
  });
});
