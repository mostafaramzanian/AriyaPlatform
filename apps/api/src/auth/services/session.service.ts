import { randomBytes } from 'node:crypto';
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';

/**
 * Phase 49S-1: SessionService manages user sessions in Redis.
 *
 * Used for:
 * - "Remember Me" session tracking
 * - Real invalidation of all sessions for a user (logout-all)
 * - Per-session revocation
 *
 * Key design:
 * - session:{userId}:{sessionId}  -> session payload (TTL 30 days)
 * - sessions:user:{userId}        -> Redis SET of active sessionIds (TTL 30 days)
 *
 * The set is maintained so invalidateAll can be bounded and never needs Redis KEYS.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  // Matches `AuthService.refreshTokenExpiration`: the session record must not
  // outlive the refresh token it backs (9 hours, in seconds).
  private readonly SESSION_TTL = 9 * 60 * 60;

  // Atomic Lua script that enforces a configurable per-user session cap.
  // It removes stale index entries, evicts the oldest sessions deterministically
  // by their stored createdAt timestamp, and then inserts the new session.
  private readonly CREATE_SESSION_SCRIPT = `
    local indexKey = KEYS[1]
    local newSessionKey = KEYS[2]
    local cap = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local payload = ARGV[3]
    local sessionId = ARGV[4]
    local userId = ARGV[5]
    local sessionPrefix = 'session:' .. userId .. ':'

    local members = redis.call('smembers', indexKey)
    local valid = {}

    for _, sid in ipairs(members) do
      local key = sessionPrefix .. sid
      local raw = redis.call('get', key)
      if raw then
        local ok, data = pcall(cjson.decode, raw)
        if ok and data and data.createdAt then
          table.insert(valid, {sid = sid, createdAt = data.createdAt})
        else
          table.insert(valid, {sid = sid, createdAt = ''})
        end
      else
        redis.call('srem', indexKey, sid)
      end
    end

    table.sort(valid, function(a, b) return a.createdAt < b.createdAt end)

    if #valid >= cap then
      local toRemove = #valid - cap + 1
      for i = 1, toRemove do
        local sid = valid[i].sid
        redis.call('del', sessionPrefix .. sid)
        redis.call('srem', indexKey, sid)
      end
    end

    redis.call('setex', newSessionKey, ttl, payload)
    redis.call('sadd', indexKey, sessionId)
    redis.call('expire', indexKey, ttl)
    return sessionId
  `;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Create a new session for user.
   * Enforces MAX_ACTIVE_SESSIONS_PER_USER atomically via a Redis Lua script.
   */
  async createSession(
    userId: string,
    sessionData: Record<string, unknown>,
  ): Promise<string> {
    const sessionId = this.generateSessionId();
    const sessionKey = this.getSessionKey(userId, sessionId);
    const indexKey = this.getUserSessionsKey(userId);

    const payload = {
      userId,
      sessionId,
      createdAt: new Date().toISOString(),
      ...sessionData,
    };

    const maxSessions = this.getMaxSessions();

    await this.redis.eval(
      this.CREATE_SESSION_SCRIPT,
      2,
      indexKey,
      sessionKey,
      maxSessions,
      this.SESSION_TTL,
      JSON.stringify(payload),
      sessionId,
      userId,
    );

    return sessionId;
  }

  private getMaxSessions(): number {
    const value = this.configService.get<number>('MAX_ACTIVE_SESSIONS_PER_USER', 10);
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      this.logger.error(
        'MAX_ACTIVE_SESSIONS_PER_USER must be a positive integer; falling back to 10',
      );
      return 10;
    }
    return parsed;
  }

  /**
   * Retrieve session data.
   */
  async getSession(
    userId: string,
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const raw = await this.redis.get(sessionKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Invalidate a specific session.
   */
  async invalidateSession(userId: string, sessionId: string): Promise<void> {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const indexKey = this.getUserSessionsKey(userId);

    const pipeline = this.redis.pipeline();
    pipeline.del(sessionKey);
    pipeline.srem(indexKey, sessionId);
    await pipeline.exec();
  }

  /**
   * Invalidate all sessions for a user (force logout from all devices).
   * Bounded: reads the user's session index, deletes each session key, and
   * removes the index. No global Redis scan is used.
   */
  async invalidateAllSessions(userId: string): Promise<void> {
    const indexKey = this.getUserSessionsKey(userId);
    const sessionIds = await this.redis.smembers(indexKey);

    if (sessionIds.length === 0) {
      // Clean up stale index key if present.
      await this.redis.del(indexKey);
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.del(this.getSessionKey(userId, sessionId));
    }
    pipeline.del(indexKey);
    await pipeline.exec();

    this.logger.debug(
      `Invalidated ${sessionIds.length} session(s) for user ${userId}`,
    );
  }

  /**
   * Extend session expiration on activity.
   */
  async extendSession(userId: string, sessionId: string): Promise<void> {
    const sessionKey = this.getSessionKey(userId, sessionId);
    const indexKey = this.getUserSessionsKey(userId);
    const raw = await this.redis.get(sessionKey);

    if (!raw) return;

    const pipeline = this.redis.pipeline();
    pipeline.setex(sessionKey, this.SESSION_TTL, raw);
    pipeline.expire(indexKey, this.SESSION_TTL);
    await pipeline.exec();
  }

  /**
   * List active session IDs for a user.
   */
  async listSessionIds(userId: string): Promise<string[]> {
    return this.redis.smembers(this.getUserSessionsKey(userId));
  }

  private getSessionKey(userId: string, sessionId: string): string {
    return `session:${userId}:${sessionId}`;
  }

  private getUserSessionsKey(userId: string): string {
    return `sessions:user:${userId}`;
  }

  private generateSessionId(): string {
    return randomBytes(16).toString('hex');
  }
}
