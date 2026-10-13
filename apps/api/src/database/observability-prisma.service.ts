import { createRequire } from 'node:module';
import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
// Phase ARCH-1.2: the Observability Prisma client is loaded at module-evaluation time
// when the generated artifact is present, and a no-op fallback is used when it is not.
// This lets runtimes that do not ship the observability-client artifact (e.g. the
// Core-only Docker image) still import ObservabilityModule without failing to boot,
// while keeping the service typed as the real PrismaClient for all consumers
// (the class below extends the ctor variable, which is typed on line 16).

const clientModulePath = '../generated/observability-client';

let ObservabilityPrismaClientCtor: typeof import('../generated/observability-client').PrismaClient;
let clientAvailable = false;

try {
  ObservabilityPrismaClientCtor = createRequire(__filename)(clientModulePath).PrismaClient;
  clientAvailable = true;
} catch {
  // GAP-ENV-1: the fallback must be a DEEP no-op. A shallow proxy that returns a
  // function for every property breaks on `prisma.retentionRun.create(...)` —
  // `retentionRun` is a function, `.create` is undefined on it, and the caller
  // logs `is not a function` on every flush instead of degrading. A callable
  // proxy that returns itself for every property and resolves on invocation
  // makes ANY delegate/method chain silently resolve.
  // `unknown` on purpose: this value IS the infinite self-returning trap —
  // every member access yields it again, so no static type could describe it.
  // Only the proxy traps below return it; callers see the real client type
  // through the `as unknown as` class cast at the end of this block.
  const deepNoOp: unknown = new Proxy(function () {}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive) return () => '';
      if (typeof prop === 'symbol') return undefined;
      return deepNoOp;
    },
    apply: () => Promise.resolve(),
  });
  ObservabilityPrismaClientCtor = class NoOpObservabilityPrismaClient {
    constructor() {
      // Wrap the real instance so members this class actually defines
      // (connected/lastError fields, ping(), isConnected(), lifecycle hooks)
      // still work — only members that exist solely on the generated client
      // (model delegates, $connect, $queryRaw, …) fall through to the no-op.
      return new Proxy(this, {
        get: (target, prop) => {
          if (prop === 'then') return undefined;
          if (typeof prop === 'symbol') return undefined;
          const real = Reflect.get(target, prop);
          if (real !== undefined) return real;
          return deepNoOp;
        },
      });
    }
  } as unknown as typeof import('../generated/observability-client').PrismaClient;
}

/**
 * The observability database connection.
 *
 * IT DOES NOT CONNECT EAGERLY. `onModuleInit` calls `$connect()` but SWALLOWS a failure,
 * because observability is OPTIONAL infrastructure: if the observability database is down,
 * the API must still boot and serve business traffic. The Core client deliberately does the
 * opposite — Core cannot function without core_db, so failing fast there is correct.
 *
 * The outcome is recorded in `connected`/`lastError` and surfaced by the observability
 * health probe, so "logging is not being persisted" is an OBSERVABLE state rather than a
 * silent one. Prisma reconnects lazily on the next query, so a database that comes back
 * later starts working without a restart.
 */
@Injectable()
export class ObservabilityPrismaService
  extends ObservabilityPrismaClientCtor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ObservabilityPrismaService.name);
  private connected = false;
  private lastError: string | null = null;

  async onModuleInit() {
    if (!clientAvailable) {
      this.lastError = 'observability-client artifact is not present in this runtime';
      return;
    }
    try {
      await this.$connect();
      this.connected = true;
      this.lastError = null;
    } catch (err) {
      // Deliberately not rethrown. See the class comment: an unreachable observability
      // database must degrade observability, not prevent the API from starting.
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : 'unknown connection error';
    }
  }

  async onModuleDestroy() {
    if (!clientAvailable || !this.connected) return;
    try {
      await super.$disconnect();
    } catch {
      // A disconnect failure during shutdown has nowhere useful to go.
    }
  }

  /** Whether the initial connect succeeded. Reported by the health probe. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Message from the initial connect failure, if any. Never a stack trace. */
  connectionError(): string | null {
    return this.lastError;
  }

  /**
   * Liveness probe used by the observability health check.
   *
   * `SELECT 1` rather than a count against a real table: a count on `ApplicationLog` would
   * be an increasingly expensive query on the largest table in the system, run on every
   * health poll — the classic way a health check becomes the load problem.
   */
  async ping(): Promise<boolean> {
    if (!clientAvailable || !this.connected) {
      return false;
    }
    try {
      await super.$queryRaw`SELECT 1`;
      this.connected = true;
      this.lastError = null;
      return true;
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : 'unknown query error';
      return false;
    }
  }
}
