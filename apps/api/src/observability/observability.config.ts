import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import { LOG_LEVEL_SEVERITY, LogLevelValue, ObservabilityIdentity } from './observability.contract';

/**
 * Phase 49M-2: every tunable of the observability platform, resolved ONCE.
 *
 * WHY A CLASS AND NOT `process.env` AT THE CALL SITE: the writer's behaviour under
 * pressure is decided by four numbers, and if each is read where it is used then the E2E
 * profile (250 ms flush, batch 50, queue 1000) and the production profile (2 s, 200, 5000)
 * differ by scattered `parseInt` calls that nobody can audit. Resolving here means the
 * effective configuration is one object that the health probe can print.
 *
 * EVERY VALUE IS CLAMPED, not merely defaulted. `OBSERVABILITY_BATCH_SIZE=0` would stall
 * the flush loop forever and `OBSERVABILITY_QUEUE_MAX=100000000` would turn a bounded
 * queue into a memory leak, so a nonsensical value is corrected and reported rather than
 * obeyed. A typo in an env file must not be able to take the API down.
 */

/** Clamp bounds. Chosen so neither extreme can break the writer's invariants. */
const QUEUE_MAX_MIN = 100;
const QUEUE_MAX_MAX = 100_000;
const BATCH_SIZE_MIN = 1;
const BATCH_SIZE_MAX = 2_000;
const FLUSH_INTERVAL_MIN_MS = 100;
const FLUSH_INTERVAL_MAX_MS = 60_000;
const WRITE_TIMEOUT_MIN_MS = 250;
const WRITE_TIMEOUT_MAX_MS = 30_000;
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 3_650;

/**
 * The value that DISABLES retention for a category.
 *
 * `0` MEANS "NEVER DELETE", NOT "DELETE EVERYTHING". This is the one place where clamping to
 * a minimum would be actively dangerous: an operator setting `AUDIT_RETENTION_DAYS=0` to mean
 * "keep the audit trail forever" would, under a naive `Math.max(1, …)` clamp, get a cutoff of
 * one day ago and lose two years of history on the next pass. `.env.example` documents 0 as
 * disabling the pass, so the code honours that reading — the destructive interpretation of an
 * ambiguous value must never be the one that wins.
 */
export const RETENTION_DISABLED = 0;

export interface RetentionPolicy {
  applicationLogDays: number;
  auditEventDays: number;
  securityEventDays: number;
  lifecycleEventDays: number;
}

export type RetentionCategory =
  | 'application_log'
  | 'audit_event'
  | 'security_event'
  | 'lifecycle_event';

@Injectable()
export class ObservabilityConfigService {
  private readonly logger = new Logger(ObservabilityConfigService.name);

  readonly enabled: boolean;
  readonly minLevel: LogLevelValue;
  readonly minLevelSeverity: number;
  readonly queueMax: number;
  readonly batchSize: number;
  readonly flushIntervalMs: number;
  readonly writeTimeoutMs: number;
  readonly retention: RetentionPolicy;
  readonly identity: ObservabilityIdentity;

  constructor() {
    // DEFAULT OFF. An installation that has not created observability_db and has not set
    // OBSERVABILITY_DATABASE_URL gets a platform that accepts calls and does nothing,
    // rather than one that logs a connection error on every request. `.env.local`,
    // `.env.e2e` and docker-compose all set it to `true` explicitly.
    this.enabled = process.env.OBSERVABILITY_ENABLED === 'true';

    // Reuses LOG_LEVEL, the variable pino-config.ts already reads, so the console and the
    // database agree on verbosity by construction instead of by convention.
    this.minLevel = this.resolveLevel(process.env.LOG_LEVEL);
    this.minLevelSeverity = LOG_LEVEL_SEVERITY[this.minLevel];

    this.queueMax = this.readInt('OBSERVABILITY_QUEUE_MAX', 5_000, QUEUE_MAX_MIN, QUEUE_MAX_MAX);
    this.batchSize = this.readInt('OBSERVABILITY_BATCH_SIZE', 200, BATCH_SIZE_MIN, BATCH_SIZE_MAX);
    this.flushIntervalMs = this.readInt(
      'OBSERVABILITY_FLUSH_INTERVAL_MS',
      2_000,
      FLUSH_INTERVAL_MIN_MS,
      FLUSH_INTERVAL_MAX_MS,
    );
    this.writeTimeoutMs = this.readInt(
      'OBSERVABILITY_WRITE_TIMEOUT_MS',
      5_000,
      WRITE_TIMEOUT_MIN_MS,
      WRITE_TIMEOUT_MAX_MS,
    );

    // FOUR SEPARATE RETENTION WINDOWS, because the four tables answer to different
    // masters: application logs are diagnostics (30d), audit events may be a legal
    // obligation (730d), security events feed incident review (365d) and lifecycle events
    // are operational history (90d). One shared window would either delete an audit trail
    // too early or keep terabytes of DEBUG lines for two years.
    //
    // `readRetentionDays` — not `readInt` — so an explicit 0 survives as "never delete".
    this.retention = {
      applicationLogDays: this.readRetentionDays('LOG_RETENTION_DAYS', 30),
      auditEventDays: this.readRetentionDays('AUDIT_RETENTION_DAYS', 730),
      securityEventDays: this.readRetentionDays('SECURITY_EVENT_RETENTION_DAYS', 365),
      lifecycleEventDays: this.readRetentionDays('LIFECYCLE_RETENTION_DAYS', 90),
    };

    // `service` distinguishes the combined process from the Core-only process launched by
    // core-main.ts, and from any remote module writing into the same tables. Without it,
    // rows from three deployment shapes are indistinguishable.
    this.identity = {
      service: (process.env.OBSERVABILITY_SERVICE_NAME || process.env.SERVICE_NAME || 'aria-api').slice(
        0,
        64,
      ),
      environment: (process.env.NODE_ENV || 'development').slice(0, 32),
      instanceRef: (process.env.HOSTNAME || this.safeHostname()).slice(0, 96),
    };
  }

  /** Retention days for one category, by the key used in `RetentionRun.category`. */
  retentionDaysFor(category: RetentionCategory): number {
    switch (category) {
      case 'application_log':
        return this.retention.applicationLogDays;
      case 'audit_event':
        return this.retention.auditEventDays;
      case 'security_event':
        return this.retention.securityEventDays;
      case 'lifecycle_event':
        return this.retention.lifecycleEventDays;
    }
  }

  /** Whether a level clears the configured threshold. */
  acceptsLevel(level: LogLevelValue): boolean {
    return LOG_LEVEL_SEVERITY[level] >= this.minLevelSeverity;
  }

  /**
   * The effective configuration, for the health probe.
   *
   * DELIBERATELY OMITS `OBSERVABILITY_DATABASE_URL`: it contains a password, and a health
   * endpoint that echoes a connection string is a credential-disclosure bug regardless of
   * how well the endpoint is guarded.
   */
  describe(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      minLevel: this.minLevel,
      queueMax: this.queueMax,
      batchSize: this.batchSize,
      flushIntervalMs: this.flushIntervalMs,
      writeTimeoutMs: this.writeTimeoutMs,
      retention: this.retention,
      service: this.identity.service,
      environment: this.identity.environment,
    };
  }

  private resolveLevel(raw: string | undefined): LogLevelValue {
    const candidate = (raw || 'info').trim().toUpperCase();
    if (candidate in LOG_LEVEL_SEVERITY) return candidate as LogLevelValue;
    // pino also accepts `silent`; treat it as FATAL-only rather than refusing to start.
    if (candidate === 'SILENT') return 'FATAL';
    return 'INFO';
  }

  /**
   * Retention days, with `0` preserved verbatim as RETENTION_DISABLED.
   *
   * Any other out-of-range value is clamped as usual — `-5` and `99999` are typos, whereas 0
   * is documented in `.env.example` as "disables the pass for that category". The negative
   * case is clamped UP to the minimum rather than down to 0, so a typo cannot silently switch
   * retention off and let the table grow unbounded.
   */
  private readRetentionDays(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      this.logger.warn(`${name}="${raw}" is not an integer; using ${fallback}`);
      return fallback;
    }
    if (parsed === RETENTION_DISABLED) {
      this.logger.warn(`${name}=0 — retention is DISABLED for this category; rows are never deleted`);
      return RETENTION_DISABLED;
    }
    return this.readInt(name, fallback, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);
  }

  private readInt(name: string, fallback: number, min: number, max: number): number {

    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      this.logger.warn(`${name}="${raw}" is not an integer; using ${fallback}`);
      return fallback;
    }
    if (parsed < min || parsed > max) {
      const clamped = Math.min(max, Math.max(min, parsed));
      this.logger.warn(`${name}=${parsed} is outside [${min}, ${max}]; clamped to ${clamped}`);
      return clamped;
    }
    return parsed;
  }

  private safeHostname(): string {
    try {
      return os.hostname() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
