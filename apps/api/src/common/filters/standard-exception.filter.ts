import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { AuditService } from '../audit.service';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ObservabilityService } from '../../observability/observability.service';
import { ObservabilityAuditService } from '../../observability/observability-audit.service';
import { SecurityEventTypeValue } from '../../observability/observability.contract';
import type { AuthenticatedRequest } from '../../auth/auth.types';

interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

interface StandardErrorResponse {
  success: false;
  error: ErrorPayload;
  timestamp: string;
  traceId: string;
}

interface ErrorWithCode {
  code?: string;
  message?: string;
  details?: unknown;
}

@Injectable()
@Catch()
export class StandardExceptionFilter implements ExceptionFilter {
  // Phase 33K: optional so this filter also resolves in a CMS-only module
  // graph (CmsOnlyBlogModule) that has no Core AuditService provider — same
  // pattern already used by the `auditService?.log(...)` call below.
  //
  // Phase 49M-2: the two observability dependencies are optional for the SAME reason, and
  // they are ADDITIVE rather than a replacement. `AuditService` keeps writing
  // core_db."AuditLog" exactly as before (§51 KEEP) — nothing below is removed — while the
  // same failure is ALSO recorded in observability_db, where it can be queried by route,
  // status and severity instead of being one undifferentiated `action` string.
  //
  // WHY THIS FILTER IS WHERE THE SECURITY ROUTING BELONGS: it is the single place that sees
  // every 4xx/5xx in the process, and the recorded numbers make the case — 21,401
  // `validation_failed` and 12,031 `unauthorized` rows in five weeks, 94% of the audit table,
  // all produced HERE. Splitting that volume by MEANING (a denied permission is a security
  // event; a malformed DTO is a log line) is the whole point of the phase.
  constructor(
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly observabilityAudit?: ObservabilityAuditService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { traceId?: string; ip?: string } & Partial<AuthenticatedRequest>>();
    const status = this.getStatus(exception);
    const traceId = this.getTraceId(request);
    const payload = this.buildPayload(exception, status, traceId);

    const shouldSkip = this.shouldSkipGenericAudit(request, status);

    // record validation/forbidden/unauthorized errors to audit
    if (!shouldSkip) {
      try {
        const userId = request.user?.sub;
        const action = status === 403 ? 'denied' : status === 401 ? 'unauthorized' : 'validation_failed';
        void this.auditService?.log({
          requestId: traceId,
          userId,
          ip: request.ip,
          userAgent: request.headers?.['user-agent'] as string | undefined,
          action: action,
          resource: 'security',
          resourceId: request.url ?? 'unknown',
          oldValue: null,
          newValue: null,
          success: status < 400 ? true : false,
          reason: payload.error?.message ?? undefined,
        });
      } catch {
        // don't block error handling
      }

      // Phase 49M-2: the same failure, routed by MEANING — 401/403 to SecurityEvent,
      // everything else to ApplicationLog. Additive; the AuditService call above is unchanged.
      this.recordObservability(request, status, payload.error?.message);
    }

    response.status(status).json(payload);
  }

  /**
   * Splits a failure between the security table and the log table.
   *
   * 401/403 ARE SECURITY EVENTS, everything else is an application log line. That boundary is
   * the reason `SecurityEvent` is a separate table: an authentication or authorization refusal
   * is read under `admin.security.read` by SUPER_ADMIN/SECURITY_ADMIN, while a 422 from a
   * malformed DTO is ordinary diagnostic noise that OPERATIONS_ADMIN needs and that nobody
   * should have to hold a security permission to see.
   *
   * IT NEVER THROWS AND NEVER AWAITS. A failing observability write must not change the HTTP
   * response the user receives — the request has already failed, and failing differently
   * because the logger is down would be a second bug caused by the first.
   */
  private recordObservability(
    request: Request & Partial<AuthenticatedRequest>,
    status: number,
    reason: string | undefined,
  ): void {
    try {
      const userId = request.user?.sub;
      const route = this.matchedRoute(request);

      if (status === 401 || status === 403) {
        const eventType: SecurityEventTypeValue =
          status === 401 ? 'AUTHENTICATION_MISSING' : 'AUTHORIZATION_DENIED';

        // `void`: the write is durable and internally bounded by a finite timeout, and its
        // failure is reported through its own counters rather than into this response.
        void this.observabilityAudit?.recordSecurity({
          eventType,
          succeeded: false,
          actorType: userId ? 'USER' : 'ANONYMOUS',
          actorId: userId,
          httpMethod: request.method,
          route,
          reasonCode: status === 401 ? 'unauthenticated' : 'insufficient_permissions',
          // NO `attemptedIdentifier`: this filter never sees what the caller typed, and
          // deriving one from the URL would put a user id into a masked-identity field.
        });
        return;
      }

      this.observability?.log({
        // 5xx is OUR fault, 4xx is the client's. `AuditLog` recorded both at one severity,
        // which is why 21,401 validation failures were indistinguishable from real incidents.
        level: status >= 500 ? 'ERROR' : 'WARN',
        messageCode: 'HTTP_REQUEST_FAILED',
        message: `${request.method} ${route} ${status}`,
        source: 'http',
        httpMethod: request.method,
        route,
        statusCode: status,
        userId,
        context: reason ? { reason: reason.slice(0, 500) } : undefined,
      });
    } catch {
      // Observability must never be the reason an error response fails to be sent.
    }
  }

  /**
   * The matched route pattern, falling back to the path with the QUERY STRING REMOVED.
   *
   * NOT `request.url` VERBATIM, which is what the `AuditLog` row above still stores in
   * `resourceId`: a raw URL carries ids and sometimes tokens, and it makes every request look
   * unique so nothing can be grouped. This is the improvement the new table exists to make.
   */
  private matchedRoute(request: Request): string {
    const pattern = (request as unknown as { route?: { path?: string } }).route?.path;
    if (pattern) return pattern;
    const raw = request.originalUrl ?? request.url ?? '/';
    const queryIndex = raw.indexOf('?');
    return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  }

  private shouldSkipGenericAudit(request: Request, status: number): boolean {
    if (status < 400) {
      return false;
    }
    const target = (request.originalUrl ?? request.url ?? '').toLowerCase();
    return target.includes('/auth/login') || target.includes('/auth/refresh') || target.includes('/auth/reset-password');
  }

  private buildPayload(exception: unknown, status: number, traceId: string): StandardErrorResponse {
    const errorPayload = this.buildErrorPayload(exception, status);
    return {
      success: false,
      error: errorPayload,
      timestamp: new Date().toISOString(),
      traceId,
    };
  }

  private getTraceId(request: Request & { traceId?: string }): string {
    if (request.traceId) {
      return request.traceId;
    }

    const traceHeader = this.getHeaderValue(request.headers['x-trace-id']);
    if (traceHeader) {
      return traceHeader;
    }

    const requestIdHeader = this.getHeaderValue(request.headers['x-request-id']);
    if (requestIdHeader) {
      return requestIdHeader;
    }

    return randomUUID();
  }

  private getHeaderValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }
    return undefined;
  }

  private buildErrorPayload(exception: unknown, status: number): ErrorPayload {
    if (this.isPrismaError(exception)) {
      switch (exception.code) {
        case 'P2002':
          return { code: 'CONFLICT', message: 'A resource with the same unique value already exists', details: exception.meta };
        case 'P2025':
          return { code: 'NOT_FOUND', message: 'The requested resource was not found' };
        default:
          return { code: 'DATABASE_ERROR', message: 'A database error occurred' };
      }
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (this.isErrorPayload(response)) {
        return {
          code: response.code || this.mapStatusToCode(status),
          message: response.message || 'Request failed',
          details: response.details,
        };
      }
      if (typeof response === 'string') {
        return { code: this.mapStatusToCode(status), message: response };
      }
    }

    return { code: this.mapStatusToCode(status), message: 'Unhandled error' };
  }

  private getStatus(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_FAILED';
      default:
        return 'INTERNAL_SERVER_ERROR';
    }
  }

  private isPrismaError(error: unknown): error is { code: string; meta?: unknown } {
    return typeof error === 'object' && error !== null && 'code' in error;
  }

  private isErrorPayload(value: unknown): value is ErrorWithCode {
    return typeof value === 'object' && value !== null && 'message' in value;
  }
}
