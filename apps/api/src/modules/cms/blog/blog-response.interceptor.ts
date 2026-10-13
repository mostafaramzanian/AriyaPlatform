import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { randomUUID } from 'crypto';

interface StandardSuccessResponse<T> {
  success: true;
  data: T;
  meta: Record<string, unknown>;
  timestamp: string;
  traceId: string;
}

@Injectable()
export class BlogResponseInterceptor<T> implements NestInterceptor<T, StandardSuccessResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<StandardSuccessResponse<T>> {
    const request = context.switchToHttp().getRequest<{ traceId?: string; headers: Record<string, string | string[] | undefined> }>();
    const traceId = this.getTraceId(request);
    request.traceId = traceId;

    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        meta: this.buildMeta(data),
        timestamp: new Date().toISOString(),
        traceId,
      })),
    );
  }

  private getTraceId(request: { traceId?: string; headers: Record<string, string | string[] | undefined> }) {
    const existing = request.traceId;
    if (existing) return existing;
    const headerValue = request.headers['x-trace-id'] || request.headers['x-request-id'];
    if (typeof headerValue === 'string' && headerValue.length > 0) {
      return headerValue;
    }
    return randomUUID();
  }

  private buildMeta(data: unknown): Record<string, unknown> {
    if (typeof data === 'object' && data !== null && 'items' in data && 'hasMore' in data) {
      const items = Array.isArray((data as { items?: unknown }).items)
        ? ((data as { items?: unknown[] }).items ?? [])
        : [];
      return { itemCount: items.length, hasMore: Boolean((data as { hasMore?: unknown }).hasMore) };
    }
    return {};
  }
}
