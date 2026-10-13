# Phase C.1.7 — Enterprise Cache Tagging & Stampede Protection

## Overview
This phase implements a production-grade caching layer with:
- **Cache Tagging**: Group related cache entries for atomic invalidation
- **Stampede Protection**: Prevent cache thundering via distributed locking and singleflight
- **Multi-Backend Support**: Works with Redis (distributed) and falls back to in-memory cache
- **TTL Configuration**: Per-endpoint tuning for optimal freshness vs performance

## Architecture

### CacheService (apps/api/src/common/cache.service.ts)
Central cache manager with:

#### Core Methods
- `get<T>(key)` — retrieve cached value
- `set(key, value, ttlSeconds, tags)` — store with optional tag associations
- `del(key)` — remove key and clean up tag mappings
- `invalidateTags(tags)` — atomic bulk cache invalidation via tags
- `wrap<T>(key, ttlSeconds, tags, fn, lockTTL)` — compute-on-miss with stampede protection

#### Stampede Protection Strategy

**Redis (Distributed)**
1. Attempt Redis distributed lock via `SET key value NX PX lockTTL`
2. If acquired: compute value, cache, release lock
3. If not acquired: wait for value to appear in cache (up to lockTTL + 1s)
4. Fallback: compute locally if waited too long

**Non-Redis (Fallback)**
- In-process singleflight: all requests to same key share a single Promise
- Only first caller executes fn(); others await same Promise

#### Tag-Based Invalidation
Two Redis sorted sets per tag:
- `cache:tag:{tagName}` → set of cache keys with this tag
- `cache:key:tags:{key}` → set of tags for this key

When invalidating tag T:
1. Fetch all keys in `cache:tag:T`
2. Delete all keys and their tag mappings
3. Clean up the tag set itself

### Blog Integration

#### Endpoints with Tagging

**Slug-based (5 min cache)**
- `GET /blog/:slug` → tags: `['blog:slug']`
- Cache key: `blog:slug:{slug}`
- Invalidates on: publish, update, delete, restore, archive

**Featured (15 min cache)**
- `GET /blog/featured?limit=5` → tags: `['blog:featured', 'blog:list']`
- Cache key: `blog:featured:{limit}`
- Separate key per limit to avoid collisions

**Latest (10 min cache)**
- `GET /blog/latest?limit=10` → tags: `['blog:latest', 'blog:list']`
- Cache key: `blog:latest:{limit}`

**Archive (5 min cache, cursor-aware)**
- `GET /blog/archive?cursor=...&limit=20` → tags: `['blog:archive', 'blog:list']`
- Cache key: `blog:archive:{limit}:{cursor}`
- Supports pagination safely

#### Cache Invalidation Rules

When modifying a blog post:
```
invalidateCaches(slug) {
  delete blog:slug:{slug}          // direct slug cache
  delete blog:latest:*             // invalidate all latest views
  delete blog:homepage            // invalidate homepage
  invalidateTags([               // invalidate all tagged caches
    'blog:latest',
    'blog:homepage',
    'blog:featured',
    'blog:slug'
  ])
}
```

## Performance Characteristics

### Single Request (Cache Hit)
- **Redis**: ~1-3ms lookup (network round-trip)
- **In-Memory**: <1ms direct access

### Cache Miss (Compute)
- **Query DB**: ~50-200ms (depends on complexity)
- **Serialize/Tag**: ~1-5ms
- **Network (Redis)**: ~1-2ms per operation
- **Total**: ~60-210ms

### Stampede Protection
- **Contention (10 concurrent requests)**:
  - Without: 10 × ~100ms DB query = 1000ms wall time
  - With distributed lock: 1 × ~100ms DB + 9 × wait-for-cache = ~110ms wall time
  - **Speedup**: ~9x

### Tag Invalidation
- Single tag with 100 keys: ~5-10ms (Redis pipeline)
- Scales sub-linearly with key count

## Usage Examples

### Public Read (Slug)
```typescript
async findBySlug(slug: string) {
  return this.cacheService.wrap(
    `blog:slug:${slug}`,
    60 * 5,                      // 5 min TTL
    ['blog:slug'],               // tag for bulk invalidation
    () => this.repo.findBySlug(slug)
  );
}
```

### Bulk Invalidation
```typescript
async invalidateCaches(slug?: string) {
  await this.cacheService.del(`blog:slug:${slug}`);
  await this.cacheService.invalidateTags([
    'blog:latest',
    'blog:featured',
    'blog:slug'
  ]);
}
```

## Monitoring & Observability

### Redis Commands to Check Cache State
```bash
# List all tag sets
KEYS cache:tag:*

# Members of a tag
SMEMBERS cache:tag:blog:latest

# Keys with a tag
SMEMBERS cache:key:tags:blog:latest:10

# Check lock status
EXISTS cache:lock:blog:slug:hello-world
```

### Metrics to Track
- Cache hit rate (per tag)
- Average lock acquisition time
- Singleflight contention rate
- Tag invalidation latency

## Fault Tolerance

### Redis Unavailable
- CacheService falls back to in-memory caching only
- Singleflight prevents thundering
- Loss of distributed invalidation (but individual keys still cached)
- Warnings logged; business logic continues

### Cache Manager Failure
- Individual get/set failures are caught and logged
- Graceful degradation: miss data but continue
- Never breaks API responses

### Lock Expiry
- `lockTTL` defaults to 5000ms
- Waiters timeout after lockTTL + 1000ms
- Expired locks auto-released by Redis TTL
- Fallback: compute locally if waited too long

## Testing

### Unit Tests (cache.service.spec.ts)
- ✅ Singleflight prevents duplicate compute
- ✅ invalidateTags clean-up without Redis
- ✅ TTL and tag expiry behavior

### Integration Tests (to be added)
- Distributed locking under load (N concurrent requests)
- Tag invalidation with 100+ keys
- Redis failover and recovery
- Cache coherency with concurrent mutations

## Configuration

Environment variables (.env):
```bash
REDIS_URL=redis://localhost:6379
CACHE_TTL_DEFAULT=300          # seconds
CACHE_LOCK_TTL=5000            # milliseconds
CACHE_MAX_PAYLOAD_BYTES=102400 # 100 KB
```

## Future Enhancements

1. **Cache Analytics Dashboard**
   - Hit/miss rates per tag
   - Hotspot identification
   - Eviction patterns

2. **Adaptive TTL**
   - Automatically adjust TTL based on hit rate
   - Longer TTL for high-hit items
   - Shorter TTL for stale-prone content

3. **Compression**
   - Gzip large cache values
   - Reduce Redis memory usage

4. **Prefetch**
   - Warm cache before expiry
   - Background refresh of popular items

5. **Cache Versioning**
   - Break cache atomically on code changes
   - Avoid stale data after deploys

## References

- Redis Distributed Locks: https://redis.io/topics/distlock
- Cache Stampede Prevention: https://en.wikipedia.org/wiki/Cache_stampede
- NestJS Cache Module: https://docs.nestjs.com/techniques/caching
