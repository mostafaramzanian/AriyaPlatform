import { Injectable, Inject, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis | null = null;
  // In-flight singleflight promises keyed by cache key. The map is intentionally
  // `Promise<unknown>`: `wrap<T>` stores one `T` per key, and the reader
  // re-asserts it to that same `T` after the `has` check below — the type
  // boundary is that one call site, not a silent `any` across the map.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Optional() @Inject(REDIS_CLIENT) redisClient?: Redis | null,
  ) {
    this.redis = redisClient ?? null;
    if (!this.redis) {
      this.logger.warn('No shared Redis client available; CacheService will rely on cache-manager only');
    }
  }

  onModuleDestroy() {
    if (this.redis) this.redis.quit().catch(() => undefined);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    try {
      this.logger.debug({ key }, 'Cache GET requested');
      // Try Redis first if available
      if (this.redis) {
        const v = await this.redis.get(key);
        if (v) {
          this.logger.debug({ key }, 'Cache GET Redis hit');
          return JSON.parse(v);
        } else {
          this.logger.debug({ key }, 'Cache GET Redis miss');
        }
      }
      // Fall back to cache-manager
      const v = await this.cacheManager.get<T>(key);
      if (v !== undefined && v !== null) {
        this.logger.debug({ key }, 'Cache GET fallback hit (cache-manager)');
        return v ?? undefined;
      }
      this.logger.debug({ key }, 'Cache GET fallback miss');
      return undefined;
    } catch (e) {
      this.logger.warn({ err: e, key }, 'Cache get failed');
      return undefined;
    }
  }

  /**
   * set value and optionally associate tags. ttl is in seconds (matches existing usage)
   */
  async set(key: string, value: unknown, ttlSeconds = 60, tags: string[] = []) {
    try {
      if (this.redis) {
        // Write to Redis with TTL
        const res = await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
        this.logger.debug({ key, ttlSeconds, wrote: !!res }, 'Cache SET wrote to Redis');
      } else {
        // Fall back to cache-manager
        await this.cacheManager.set(key, value, ttlSeconds);
        this.logger.debug({ key, ttlSeconds }, 'Cache SET wrote to cache-manager');
      }
    } catch (e) {
      this.logger.warn({ err: e, key }, 'Cache set failed');
    }

    if (!this.redis || tags.length === 0) return;
    try {
      const pipeline = this.redis.multi();
      for (const tag of tags) {
        pipeline.sadd(this.tagSetKey(tag), key);
      }
      // store reverse mapping for key -> tags
      if (tags.length) pipeline.del(this.keyTagsKey(key));
      for (const tag of tags) pipeline.sadd(this.keyTagsKey(key), tag);
      // set TTL for tag sets to be at least ttlSeconds
      for (const tag of tags) pipeline.expire(this.tagSetKey(tag), Math.max(60, ttlSeconds));
      const execRes = await pipeline.exec();
      this.logger.debug({ key, tagsCount: tags.length, pipelineSteps: Array.isArray(execRes) ? execRes.length : 0 }, 'Cache SET tag operations completed');
    } catch (e) {
      this.logger.debug({ err: e, key }, 'Tagging cache failed');
    }
  }

  async del(key: string) {
    try {
      this.logger.debug({ key }, 'Cache DEL requested');
      if (this.redis) {
        const delRes = await this.redis.del(key);
        this.logger.debug({ key, deleted: delRes }, 'Cache DEL removed from Redis');
      } else {
        await this.cacheManager.del(key);
        this.logger.debug({ key }, 'Cache DEL removed from cache-manager');
      }
    } catch (e) {
      this.logger.warn({ err: e, key }, 'Cache del failed');
    }

    if (!this.redis) return;
    try {
      const tags = await this.redis.smembers(this.keyTagsKey(key));
      if (tags && tags.length) {
        const pipeline = this.redis.multi();
        for (const tag of tags) pipeline.srem(this.tagSetKey(tag), key);
        pipeline.del(this.keyTagsKey(key));
        const res = await pipeline.exec();
        this.logger.debug({ key, tagsRemoved: tags.length, pipelineSteps: Array.isArray(res) ? res.length : 0 }, 'Cache key tag cleanup completed');
      }
    } catch (e) {
      this.logger.debug({ err: e, key }, 'Cache key tag cleanup failed');
    }
  }

  async invalidateTags(tags: string[]) {
    this.logger.debug({ tagsCount: tags.length, tags }, 'invalidateTags requested');
    if (!this.redis) {
      // best-effort: cannot enumerate keys via cacheManager
      for (const tag of tags) {
        try {
          // try removing well-known keys used by CMS
          if (tag === 'blog:homepage') await this.cacheManager.del('blog:homepage');
          if (tag === 'blog:latest') await this.cacheManager.del('blog:latest');
          this.logger.debug({ tag }, 'Best-effort cache-manager tag cleared');
        } catch (e) {
          this.logger.debug({ err: e, tag }, 'Best-effort tag invalidation failed');
        }
      }
      return;
    }

    try {
      const pipeline = this.redis.multi();
      for (const tag of tags) {
        pipeline.smembers(this.tagSetKey(tag));
      }
      const res = await pipeline.exec();
      const keysPerTag = (res || []).map((r) => (Array.isArray(r) ? r[1] : [])) as string[][];
      this.logger.debug({ tagsCount: tags.length, keysFound: keysPerTag.map(k=>k.length) }, 'invalidateTags found keys per tag');
      const delPipeline = this.redis.multi();
      let totalKeys = 0;
      for (const keys of keysPerTag) {
        for (const k of keys) {
          totalKeys++;
          delPipeline.del(k);
          delPipeline.del(this.keyTagsKey(k));
        }
      }
      for (const tag of tags) delPipeline.del(this.tagSetKey(tag));
      const delRes = await delPipeline.exec();
      this.logger.debug({ tagsCount: tags.length, totalKeys, delPipelineSteps: Array.isArray(delRes) ? delRes.length : 0 }, 'invalidateTags deletion pipeline executed');
      // also remove from cache-manager for safety
      for (const keys of keysPerTag) {
        for (const k of keys) await this.cacheManager.del(k).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn({ err: e, tags }, 'invalidateTags failed');
    }
  }

  /**
   * Wrap computes value using fn with stampede protection.
   * ttlSeconds - cache TTL in seconds
   */
  async wrap<T>(key: string, ttlSeconds: number, tags: string[], fn: () => Promise<T>, lockTTL = 5000): Promise<T> {
    this.logger.debug({ key, ttlSeconds, tagsCount: tags.length }, 'Cache WRAP requested');
    // check if already cached
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      this.logger.debug({ key }, 'Cache WRAP returning cached value');
      return cached;
    }

    // singleflight in-process
    if (this.inFlight.has(key)) {
      this.logger.debug({ key }, 'Cache WRAP using in-process singleflight');
      return this.inFlight.get(key) as Promise<T>;
    }

    // try Redis lock if available
    if (this.redis) {
      const lockKey = this.lockKey(key);
      const token = randomUUID();
      this.logger.debug({ key, lockKey }, 'Cache WRAP attempting Redis lock');
      try {
        const acquired = await this.redis.set(lockKey, token, 'PX', lockTTL.toString(), 'NX');
        // log raw acquired value to help diagnose driver return types (OK | true | null)
        this.logger.debug({ key, lockKey, acquired }, 'Cache WRAP lock result');
        if (acquired === 'OK' || acquired === true) {
          this.logger.debug({ key, lockKey, acquired }, 'Cache WRAP acquired Redis lock');
          try {
            const result = await fn();
            await this.set(key, result, ttlSeconds, tags);
            return result;
          } finally {
            // release lock only if token matches
            try {
              const val = await this.redis.get(lockKey);
              if (val === token) await this.redis.del(lockKey);
              this.logger.debug({ key, lockKey }, 'Cache WRAP released Redis lock');
            } catch (e) {
              this.logger.debug({ err: e, key, lockKey }, 'Failed releasing cache lock');
            }
          }
        } else {
          this.logger.debug({ key, lockKey, acquired }, 'Cache WRAP lock not acquired, waiting for holder');
          // wait for cache to be populated by lock holder
          const deadline = Date.now() + lockTTL + 1000;
          while (Date.now() < deadline) {
            const val = await this.get<T>(key);
            if (val !== undefined) {
              this.logger.debug({ key }, 'Cache WRAP observed value populated by lock holder');
              return val;
            }
            await this.sleep(50);
          }
          this.logger.debug({ key }, 'Cache WRAP wait timed out, computing fallback');
          // fallback to computing if waited too long
          const result = await fn();
          await this.set(key, result, ttlSeconds, tags);
          return result;
        }
      } catch (e) {
        // If Redis returned a protocol/parse error (or any other error), fall back to in-process singleflight
        this.logger.warn({ err: e, key, lockKey }, 'Cache WRAP: Redis lock failed or returned invalid response, falling back to in-process singleflight');
      }
    }

    // Redis unavailable - use in-process singleflight
    this.logger.debug({ key }, 'Cache WRAP using in-process singleflight (no Redis)');
    const promise = (async () => {
      try {
        const res = await fn();
        await this.set(key, res, ttlSeconds, tags);
        return res;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  private tagSetKey(tag: string) {
    return `cache:tag:${tag}`;
  }
  private keyTagsKey(key: string) {
    return `cache:key:tags:${key}`;
  }
  private lockKey(key: string) {
    return `cache:lock:${key}`;
  }
  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
}
