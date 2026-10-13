import { Module, Global, Provider } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Phase 49S-1: shared Redis client for distributed rate limiting and
 * server-side session management. The client is created once and exported so
 * that any provider or middleware can depend on a single connection.
 *
 * In production the Redis URL must be set explicitly. In development/test it
 * falls back to the docker-compose service name, but it will still fail fast on
 * connection errors rather than silently degrading to in-memory semantics.
 */

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export type RedisClient = Redis;

const redisClientFactory: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => {
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    // Stage 2.22: enableReadyCheck is TRUE with a proven cause (host-process +
    // Docker-published-port trial, ioredis 5.11.1, trace in the execution log).
    // With `false`, connectHandler runs readyHandler from the deferred
    // Promise.all(...).finally(...) WITHOUT the connectionEpoch guard that the
    // readyCheck path has (event_handler.js). During an outage the published-port
    // proxy still accepts TCP, so proxied `connect` handlers queue `client SETINFO`;
    // plain commands survive close (abortIncompletePipelines skips them) and are
    // rejected only by the maxRetriesPerRequest flush on close #4 - whose late
    // readyHandler overwrites status `reconnecting` with `ready`. The armed retry
    // then calls connect(), which rejects against status `ready` ("already
    // connecting/connected", swallowed by .catch(noop)) and the client never
    // reconnects: status=ready, socket destroyed, PING queued forever. With the
    // readyCheck path the stale chain bails on the epoch mismatch, so the retry
    // loop survives the outage. maxRetriesPerRequest, lazyConnect and the retry
    // strategy are unchanged.
    const client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    return client;
  },
};

@Global()
@Module({
  providers: [redisClientFactory],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
