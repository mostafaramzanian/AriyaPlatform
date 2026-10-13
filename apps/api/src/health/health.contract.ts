/**
 * Phase ARCH-1.3: the readiness CONTRACT.
 *
 * Declared once and shared by the probes, the evaluator, the service, the
 * controller and the specs, so the shape of a readiness answer cannot drift
 * between the code that produces it and the code that checks it.
 */
import {
  DATASOURCES,
  Datasource,
  INFRASTRUCTURE_SERVICES,
  InfrastructureService,
  ProbeStatus,
  Requirement,
} from '../runtime-datasources';

export type DatasourceCheckKey =
  | 'coreDatabase'
  | 'cmsDatabase'
  | 'correspondenceDatabase'
  | 'observabilityDatabase'
  | 'hrDatabase'
  // Phase C1: the readiness report of a runtime that serves Commerce must be able
  // to name the Commerce check — the key consumers (probes, evaluator, controller)
  // are all derived from this record, so the union and the record move together.
  | 'commerceDatabase'
  // Phase PRODUCTION-BOM-HEADER: the same rule for the Production BOM bounded context —
  // a runtime that composes `ProductionPrismaModule` must be able to name its check.
  | 'productionDatabase'
  // Phase F1 — FINANCIAL FOUNDATION: the same rule for the Financial bounded context —
  // a runtime that composes `FinancialPrismaModule` must be able to name its check.
  | 'financeDatabase';

export const DATASOURCE_CHECK_KEYS: Record<Datasource, DatasourceCheckKey> = {
  CORE_DATABASE_URL: 'coreDatabase',
  CMS_DATABASE_URL: 'cmsDatabase',
  CORRESPONDENCE_DATABASE_URL: 'correspondenceDatabase',
  OBSERVABILITY_DATABASE_URL: 'observabilityDatabase',
  HR_DATABASE_URL: 'hrDatabase',
  COMMERCE_DATABASE_URL: 'commerceDatabase',
  PRODUCTION_DATABASE_URL: 'productionDatabase',
  FINANCE_DATABASE_URL: 'financeDatabase',
};

export type InfrastructureCheckKey = 'redis' | 'rabbitmq' | 'storage';

export const INFRASTRUCTURE_CHECK_KEYS: Record<InfrastructureService, InfrastructureCheckKey> = {
  redis: 'redis',
  rabbitmq: 'rabbitmq',
  minio: 'storage',
};

export type CheckKey = DatasourceCheckKey | InfrastructureCheckKey;

/** Every check key this system can report, in a stable, declared order. */
export const CHECK_KEYS: readonly CheckKey[] = [
  ...DATASOURCES.map((d) => DATASOURCE_CHECK_KEYS[d]),
  ...INFRASTRUCTURE_SERVICES.map((s) => INFRASTRUCTURE_CHECK_KEYS[s]),
];

/**
 * The boolean view of every check, kept from ARCH-1.2 for compatibility:
 * `true` means "the probe passed" OR "policy says this runtime does not use it",
 * `false` means "a probe actually ran and failed". A dependency that is not used
 * and one that is not configured both report `true` here and are distinguished in
 * `statuses`.
 */
export type HealthChecks = Record<CheckKey, boolean>;

export interface ProbeResult {
  readonly key: CheckKey;
  readonly status: ProbeStatus;
  readonly requirement: Requirement;
  readonly detail: string | null;
}

export interface ReadinessReport {
  readonly healthy: boolean;
  readonly checks: HealthChecks;
  readonly requirements: Record<CheckKey, Requirement>;
  readonly statuses: Record<CheckKey, ProbeStatus>;
  readonly details: Record<CheckKey, string | null>;
  /** Optional dependencies that are configured but failed their probe. */
  readonly optionalDegraded: CheckKey[];
  /** Optional dependencies whose env var is absent. Reported, not fatal. */
  readonly notConfigured: CheckKey[];
  /** Required dependencies that failed. These are why `healthy` is false. */
  readonly blocking: CheckKey[];
  /** Checks that reported `ok`. */
  readonly ok: number;
  /** Checks skipped because this runtime does not use the dependency at all. */
  readonly skipped: number;
}

/**
 * A health response is public (it is served without authentication so an
 * orchestrator can use it), so it must never echo a connection string or any
 * credential an error message might have carried.
 */
export function sanitizeDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<redacted-url>')
    .replace(/(password|secret|token|apikey|api_key)\s*[:=]\s*[^\s,;'"]+/gi, '$1=<redacted>')
    .slice(0, 240);
}

/** The environment variable that configures a dependency, if it has one. */
export function envVarForDatasource(datasource: Datasource): string {
  return datasource;
}

export function isDatasourceConfigured(
  datasource: Datasource,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[envVarForDatasource(datasource)];
  return typeof value === 'string' && value.trim().length > 0;
}
