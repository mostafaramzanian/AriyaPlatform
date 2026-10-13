import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  startTime: number;
  userId?: string;
  userEmail?: string;
  userRole?: string;
  tenantId?: string | null;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class RequestContextService {
  private static readonly storage = new AsyncLocalStorage<RequestContext>();

  static set(context: RequestContext) {
    RequestContextService.storage.enterWith(context);
  }

  /**
   * Phase 54-C: merges fields into the context THIS REQUEST ALREADY HAS, **in place**.
   *
   * WHY A MERGE AND NOT ANOTHER `set`
   * ---------------------------------
   * `set` REPLACES the store (`AsyncLocalStorage.enterWith`), and a replacement is scoped to
   * the current asynchronous frame and its children. Nest's request lifecycle makes that a
   * real difference, not a stylistic one: guards are a FLAT LOOP in one frame, so a guard
   * that `await`s (every guard that resolves a tenant must) and then replaces the store is
   * writing to a child frame — the store it wrote is invisible to the guards that run after
   * it, to the caller's loop, and to the handler. Interceptors do not have that problem
   * (`next.handle()` descends INSIDE the interceptor's frame), which is why replacing the
   * store was sufficient for four phases and stopped being sufficient the moment
   * `ModuleEntitlementGuard` became the first guard-phase reader (Phase 54-C, §43.5).
   *
   * MUTATING THE STORE OBJECT IS VISIBLE ACROSS FRAMES, and it is the same object: the
   * middleware establishes exactly one store per request, every frame below inherits that
   * REFERENCE, and `Object.assign` on it is therefore observable from the parent loop and
   * from the handler alike. Measured rather than assumed — `test/module-entitlement-runtime.
   * e2e-spec.ts` asserts the entitlement gate sees the tenant, and that suite fails on this
   * exact line if the publish regresses to a replacement.
   *
   * ESTABLISHES ONE WHEN THERE IS NONE. A direct call outside the middleware (a unit test
   * constructing a guard, a runtime without `RequestContextMiddleware`) would otherwise drop
   * the write silently, so the ids the middleware would have generated are generated here.
   * `undefined` values are dropped so that a fallback id is never overwritten with
   * `undefined`, while `null` SURVIVES — `tenantId: null` is the authoritative "no tenant"
   * answer, and a filter that ate it would turn a decision into a missing value.
   */
  static patch(partial: Partial<RequestContext>) {
    const store = RequestContextService.storage.getStore();

    if (store) {
      Object.assign(store, partial);
      return;
    }

    const defined = Object.fromEntries(
      Object.entries(partial).filter(([, value]) => value !== undefined),
    );

    RequestContextService.storage.enterWith({
      requestId: randomUUID(),
      correlationId: randomUUID(),
      startTime: Date.now(),
      ...defined,
    } as RequestContext);
  }

  static get(): RequestContext | undefined {
    return RequestContextService.storage.getStore();
  }

  getContext(): RequestContext | undefined {
    return RequestContextService.storage.getStore();
  }

  getRequestId(): string | undefined {
    return RequestContextService.storage.getStore()?.requestId;
  }

  getCorrelationId(): string | undefined {
    return RequestContextService.storage.getStore()?.correlationId;
  }

  getUserId(): string | undefined {
    return RequestContextService.storage.getStore()?.userId;
  }

  getTenantId(): string | null | undefined {
    return RequestContextService.storage.getStore()?.tenantId;
  }

  getDurationMs(): number {
    const ctx = RequestContextService.storage.getStore();
    if (!ctx) return 0;
    return Date.now() - ctx.startTime;
  }
}
