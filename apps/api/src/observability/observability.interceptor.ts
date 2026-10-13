import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { ObservabilityService } from './observability.service';

/**
 * Phase 49M-2: the HTTP request/response log line.
 *
 * WHY AN INTERCEPTOR RATHER THAN MIDDLEWARE: an interceptor runs INSIDE the Nest execution
 * context, so `context.getHandler()` and the controller class are available — which is how
 * `route` becomes the matched PATTERN (`/users/:id`) instead of the concrete URL
 * (`/users/9f3a...?token=abc`). Middleware sees only `req.url`, and a log table full of
 * concrete URLs is both a privacy problem and useless for grouping, because every request
 * looks unique.
 *
 * WHY IT IS ALSO NOT PINO-HTTP: `pino-http` already logs every request to stdout and keeps
 * doing so. This produces the QUERYABLE copy — "every 500 on this route in the last hour,
 * by tenant" is not a question stdout can answer.
 *
 * WHAT IT DELIBERATELY DOES NOT CAPTURE: no request body, no response body, no headers, no
 * query string, no cookies. Those are where credentials and personal data live, and the
 * cheapest way to guarantee they are never persisted is to never read them. `LogInput` has
 * no field for any of them.
 *
 * `AuditService` IS UNAFFECTED. `StandardExceptionFilter` keeps writing its
 * `validation_failed`/`unauthorized` rows to core_db."AuditLog" (§51 KEEP). This adds the
 * per-request record that the filter never produced — successful requests, durations, and
 * the route pattern — which is what makes the 94%-noise problem addressable at all.
 */
@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  // `@Optional()` for the same reason `StandardExceptionFilter` marks `AuditService`
  // optional: the CMS-only module graph has no ObservabilityModule, and a required
  // dependency there would break a process that has no business logging to Core at all.
  constructor(@Optional() private readonly observability?: ObservabilityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.observability || context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { sub?: string; role?: string } }>();
    const response = http.getResponse<Response>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.emit(context, request, response.statusCode, startedAt, undefined),
        // An error still produces exactly ONE line, with the status derived from the
        // exception rather than from `response.statusCode` — the filter has not run yet, so
        // the response still carries 200 at this point. Getting this wrong would record
        // every failure as a success.
        error: (err: unknown) => this.emit(context, request, this.statusFromError(err), startedAt, err),
      }),
    );
  }

  private emit(
    context: ExecutionContext,
    request: Request & { user?: { sub?: string; role?: string } },
    statusCode: number,
    startedAt: number,
    error: unknown,
  ): void {
    try {
      const durationMs = Date.now() - startedAt;
      const failed = statusCode >= 500 || error !== undefined;

      this.observability?.log({
        // 5xx is ERROR, 4xx is WARN, everything else INFO. A 4xx is the CLIENT's fault and
        // must not page anyone, but it is worth seeing — that distinction is exactly what
        // core_db."AuditLog" lost by recording 21,401 validation failures at one severity.
        level: failed ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO',
        messageCode: failed ? 'HTTP_REQUEST_FAILED' : 'HTTP_REQUEST_COMPLETED',
        message: `${request.method} ${this.resolveRoute(context, request)} ${statusCode}`,
        source: 'http',
        httpMethod: request.method,
        route: this.resolveRoute(context, request),
        statusCode,
        durationMs,
        userId: request.user?.sub ?? null,
        error: error ?? undefined,
        context: {
          handler: context.getHandler()?.name ?? null,
          controller: context.getClass()?.name ?? null,
        },
      });
    } catch {
      // A logging interceptor must never be the reason a response fails. `log` already
      // swallows its own errors; this is the belt-and-braces guarantee for the emit path.
    }
  }

  /**
   * The matched route PATTERN, with the concrete URL used only as a last resort.
   *
   * `request.route?.path` is what Express fills in once a handler matches, so it is
   * `/users/:id` rather than `/users/9f3a...`. When it is absent — a 404 matched no route —
   * the path is used with its query string REMOVED, because a query string is the most
   * common place a token ends up in a URL.
   */
  private resolveRoute(context: ExecutionContext, request: Request): string {
    const pattern = (request as unknown as { route?: { path?: string } }).route?.path;
    if (pattern) return pattern;

    const raw = request.originalUrl ?? request.url ?? '/';
    const queryIndex = raw.indexOf('?');
    return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  }

  /** Reads the HTTP status off a Nest/Http exception without importing the filter. */
  private statusFromError(err: unknown): number {
    const candidate = err as { getStatus?: () => number; status?: number };
    if (typeof candidate?.getStatus === 'function') {
      try {
        return candidate.getStatus();
      } catch {
        return 500;
      }
    }
    if (typeof candidate?.status === 'number') return candidate.status;
    return 500;
  }
}
