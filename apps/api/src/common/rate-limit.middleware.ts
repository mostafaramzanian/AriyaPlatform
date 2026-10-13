import { Injectable, Inject, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

/**
 * Phase 49S-1: distributed Redis-backed rate limiter for security-sensitive
 * public auth endpoints. Replaces the previous in-memory, login-only limiter so
 * that rate limits survive process restarts and work across multiple API
 * instances behind a load balancer.
 *
 * Covered endpoints:
 * - POST /auth/login      (count failed 401 responses, keyed by email then IP)
 * - POST /auth/register   (count requests, keyed by IP)
 * - POST /auth/refresh    (count requests, keyed by IP)
 * - POST /auth/forgot-password (count requests, keyed by IP)
 * - POST /auth/reset-password  (count requests, keyed by IP)
 * - GET  /auth/verify-email    (count requests, keyed by IP)
 * - POST /auth/resend-verification (count requests, keyed by IP)
 *
 * No global rate limit is applied to ordinary authenticated routes in this phase.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);
  private readonly maxAttempts: number;
  private readonly windowSeconds: number;
  private readonly trustedProxy?: string;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.maxAttempts = Number(process.env.RATE_LIMIT_MAX_ATTEMPTS || '5');
    this.windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || '900'); // 15 min
    this.trustedProxy = process.env.TRUSTED_PROXY_CIDR;
  }

  use(req: Request, res: Response, next: NextFunction) {
    const route = this.classifyRoute(req);
    if (!route) {
      return next();
    }

    const identifier = this.resolveIdentifier(req, route);
    const key = `rl:${route.action}:${identifier}`;

    this.redis
      .get(key)
      .then((value) => {
        const count = value ? Number(value) : 0;
        if (count >= this.maxAttempts) {
          return res.status(429).json({
            statusCode: 429,
            message: 'Too many requests. Please try again later.',
            error: 'TooManyRequests',
          });
        }

        if (route.countOn === 'request') {
          this.incrementKey(key).catch((err) =>
            this.logger.warn({ err, key }, 'Rate limit increment failed'),
          );
          return next();
        }

        // countOn === 'failure': record after response finishes.
        res.on('finish', () => {
          if (res.statusCode === 401) {
            this.incrementKey(key).catch((err) =>
              this.logger.warn({ err, key }, 'Rate limit increment failed'),
            );
          } else if (res.statusCode === 200) {
            this.redis.del(key).catch((err) =>
              this.logger.warn({ err, key }, 'Rate limit reset failed'),
            );
          }
        });
        return next();
      })
      .catch((err) => {
        this.logger.error({ err, key }, 'Rate limit check failed; denying request');
        return res.status(503).json({
          statusCode: 503,
          message: 'Service temporarily unavailable. Please try again later.',
          error: 'ServiceUnavailable',
        });
      });
  }

  private async incrementKey(key: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, this.windowSeconds, 'NX');
    await pipeline.exec();
  }

  private classifyRoute(req: Request): { action: string; countOn: 'request' | 'failure' } | null {
    // `originalUrl` is part of Express's own `Request` — no assertion needed;
    // the `url`/`path` fallbacks keep the pre-express shapes the unit tests pass.
    const original = req.originalUrl || req.url || req.path || '';
    const method = req.method?.toUpperCase() || '';

    if (method === 'POST' && original.includes('/auth/login')) {
      return { action: 'login', countOn: 'failure' };
    }
    if (method === 'POST' && original.includes('/auth/register')) {
      return { action: 'register', countOn: 'request' };
    }
    if (method === 'POST' && original.includes('/auth/refresh')) {
      return { action: 'refresh', countOn: 'request' };
    }
    if (method === 'POST' && original.includes('/auth/forgot-password')) {
      return { action: 'forgot-password', countOn: 'request' };
    }
    if (method === 'POST' && original.includes('/auth/reset-password')) {
      return { action: 'reset-password', countOn: 'request' };
    }
    if (method === 'GET' && original.includes('/auth/verify-email')) {
      return { action: 'verify-email', countOn: 'request' };
    }
    if (method === 'POST' && original.includes('/auth/resend-verification')) {
      return { action: 'resend-verification', countOn: 'request' };
    }

    return null;
  }

  private resolveIdentifier(req: Request, route: { action: string }): string {
    const ip = this.getClientIp(req);
    if (route.action === 'login') {
      const email = (req.body?.email as string) || '';
      return email ? `email:${email}` : `ip:${ip}`;
    }
    return `ip:${ip}`;
  }

  private getClientIp(req: Request): string {
    // Only trust x-forwarded-for when a trusted proxy CIDR is configured.
    if (this.trustedProxy) {
      const forwarded = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return (req.socket?.remoteAddress as string) || 'unknown';
  }
}
