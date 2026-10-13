import { CanActivate, ExecutionContext, Injectable, Inject, Optional, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { AuditService } from '../../../common/audit.service';

interface RateLimitOptions {
  key?: string;
  points?: number;
  duration?: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    // Phase 33K: optional so this guard also resolves in a CMS-only module
    // graph (CmsOnlyBlogModule) that has no Core AuditService provider.
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const meta = (this.reflector.get<RateLimitOptions>('rateLimit', context.getHandler()) as RateLimitOptions) || { points: 60, duration: 60 };
    const key = `rl:${meta.key || 'public'}:${req.ip || req.connection.remoteAddress}`;

    // try to use redis client if available
    const store: any = (this.cacheManager as any).store;
    try {
      const client = store?.getClient ? store.getClient() : null;
      if (client) {
        const cur = await client.incr(key);
        if (cur === 1) await client.expire(key, meta.duration || 60);
        if (cur > (meta.points || 60)) {
          // audit rate limit violation
          try {
            void this.auditService?.log({
              requestId: key,
              action: 'rate_limit_exceeded',
              resource: 'rate_limit',
              resourceId: key,
              userId: (req as any).user?.sub,
              ip: req.ip,
              userAgent: req.headers?.['user-agent'],
              success: false,
              reason: 'rate limit exceeded',
            });
          } catch {
            // Best-effort refusal record: a failed write must not stop the refusal.
          }
          throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
        }
        return true;
      }
    } catch {
      // fallback to in-memory if redis not available
    }

    // fallback in-memory
    const memKey = key;
    (global as any).__rl = (global as any).__rl || new Map<string, { count: number; expiresAt: number }>();
    const map = (global as any).__rl as Map<string, { count: number; expiresAt: number }>;
    const entry = map.get(memKey);
    const now = Date.now();
    if (!entry || entry.expiresAt < now) {
      map.set(memKey, { count: 1, expiresAt: now + (meta.duration || 60) * 1000 });
      return true;
    }
    if (entry.count + 1 > (meta.points || 60)) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    entry.count += 1;
    map.set(memKey, entry);
    return true;
  }
}
