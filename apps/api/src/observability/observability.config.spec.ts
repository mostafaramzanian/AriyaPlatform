import { Logger } from '@nestjs/common';
import { ObservabilityConfigService, RETENTION_DISABLED } from './observability.config';
import { LOG_LEVEL_SEVERITY } from './observability.contract';

/**
 * Phase 49M-2 §22: every tunable is CLAMPED, not merely defaulted — and `0` survives.
 *
 * WHY THIS FILE EXISTS. `ObservabilityConfigService` is the only place a typo in an env file
 * can take the API down or silently destroy data, because four numbers decide the writer's
 * behaviour under pressure and four more decide what gets deleted. The properties worth
 * pinning are therefore:
 *
 *  - A BLANK OR MISSING VALUE FALLS BACK SILENTLY. An unset variable is the normal case, not
 *    a misconfiguration, so it must not produce a warning that trains operators to ignore logs.
 *  - A NON-INTEGER WARNS AND FALLS BACK. `OBSERVABILITY_BATCH_SIZE=many` must not become NaN
 *    and stall the flush loop forever; it must be visibly corrected.
 *  - AN OUT-OF-RANGE VALUE IS CLAMPED AND REPORTED, in both directions. `BATCH_SIZE=0` would
 *    stall the loop and `QUEUE_MAX=100000000` would turn a bounded queue into a memory leak, so
 *    a nonsensical value is corrected rather than obeyed.
 *  - `0` MEANS "NEVER DELETE" FOR RETENTION AND IS PRESERVED VERBATIM. This is the one case
 *    where clamping to a minimum would be actively destructive: an operator setting
 *    `AUDIT_RETENTION_DAYS=0` to mean "keep the audit trail forever" would, under a naive
 *    `Math.max(1, …)`, get a cutoff of one day ago and lose two years of history on the next
 *    retention pass. `.env.example` documents 0 as disabling the pass, and the code honours
 *    that reading — the destructive interpretation of an ambiguous value must never win.
 *  - A NEGATIVE RETENTION VALUE CLAMPS UP TO THE MINIMUM, NOT DOWN TO 0, so a typo cannot
 *    silently switch retention off and let the table grow unbounded.
 *  - `describe()` NEVER RETURNS A CREDENTIAL. It is served by an HTTP endpoint, and a health
 *    probe echoing a connection string is a credential-disclosure bug however well it is gated.
 */

/** The four retention variables and their documented defaults. */
const RETENTION_VARS: Array<[string, keyof ReturnType<typeof retentionOf>, number]> = [
  ['LOG_RETENTION_DAYS', 'applicationLogDays', 30],
  ['AUDIT_RETENTION_DAYS', 'auditEventDays', 730],
  ['SECURITY_EVENT_RETENTION_DAYS', 'securityEventDays', 365],
  ['LIFECYCLE_RETENTION_DAYS', 'lifecycleEventDays', 90],
];

const retentionOf = (config: ObservabilityConfigService) => config.retention;

/** Clamp bounds, mirroring the module-private constants they are asserted against. */
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 3_650;

/**
 * Every variable the service reads, cleared before each construction.
 *
 * The constructor resolves everything ONCE, so a test that builds the service twice must start
 * from a clean environment each time or the second build inherits the first one's variables —
 * which is exactly how a "SERVICE_NAME wins" assertion silently tests nothing.
 */
const OBSERVABILITY_VARS = [
  'OBSERVABILITY_ENABLED',
  'OBSERVABILITY_QUEUE_MAX',
  'OBSERVABILITY_BATCH_SIZE',
  'OBSERVABILITY_FLUSH_INTERVAL_MS',
  'OBSERVABILITY_WRITE_TIMEOUT_MS',
  'OBSERVABILITY_SERVICE_NAME',
  'SERVICE_NAME',
  'LOG_LEVEL',
  'LOG_RETENTION_DAYS',
  'AUDIT_RETENTION_DAYS',
  'SECURITY_EVENT_RETENTION_DAYS',
  'LIFECYCLE_RETENTION_DAYS',
];

describe('ObservabilityConfigService', () => {
  const ORIGINAL_ENV = process.env;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // A COPY, so one test's variable cannot leak into the next and make an assertion depend on
    // test order.
    process.env = { ...ORIGINAL_ENV };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  /** Builds the service with `env` as the ONLY observability variables that are set. */
  const withEnv = (env: Record<string, string> = {}) => {
    for (const name of OBSERVABILITY_VARS) delete process.env[name];
    Object.assign(process.env, env);
    return new ObservabilityConfigService();
  };

  /** The warning text emitted for one variable, if any. */
  const warningsFor = (name: string) =>
    warn.mock.calls.map((call) => String(call[0])).filter((message) => message.includes(name));

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Retention: 0 is sacred
  // ───────────────────────────────────────────────────────────────────────────

  describe('readRetentionDays', () => {
    it('applies the documented default for each of the four windows', () => {
      const config = withEnv();

      // The four windows answer to different masters: diagnostics (30d), legal obligation
      // (730d), incident review (365d) and operational history (90d). One shared window would
      // either delete an audit trail too early or keep terabytes of DEBUG lines for two years.
      expect(config.retention).toEqual({
        applicationLogDays: 30,
        auditEventDays: 730,
        securityEventDays: 365,
        lifecycleEventDays: 90,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('preserves an explicit 0 as RETENTION_DISABLED for every category', () => {
      const config = withEnv({
        LOG_RETENTION_DAYS: '0',
        AUDIT_RETENTION_DAYS: '0',
        SECURITY_EVENT_RETENTION_DAYS: '0',
        LIFECYCLE_RETENTION_DAYS: '0',
      });

      // NOT clamped to RETENTION_DAYS_MIN. A cutoff of "one day ago" on a 730-day audit table
      // is the single most destructive outcome available in this phase.
      expect(config.retention).toEqual({
        applicationLogDays: RETENTION_DISABLED,
        auditEventDays: RETENTION_DISABLED,
        securityEventDays: RETENTION_DISABLED,
        lifecycleEventDays: RETENTION_DISABLED,
      });
      expect(RETENTION_DISABLED).toBe(0);
    });

    it('warns loudly that a 0 window never deletes', () => {
      withEnv({ AUDIT_RETENTION_DAYS: '0' });

      // Silence here would be wrong in the other direction: "retention is off for this table"
      // must appear in the log, because it is indistinguishable from a healthy pass otherwise.
      const messages = warningsFor('AUDIT_RETENTION_DAYS');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('DISABLED');
    });

    it.each(RETENTION_VARS)('%s falls back on a blank value without warning', (name, key, fallback) => {
      const config = withEnv({ [name]: '   ' });

      expect(retentionOf(config)[key]).toBe(fallback);
      expect(warningsFor(name)).toEqual([]);
    });

    it.each(RETENTION_VARS)('%s warns and falls back on a non-integer', (name, key, fallback) => {
      const config = withEnv({ [name]: 'forever' });

      expect(retentionOf(config)[key]).toBe(fallback);
      expect(warningsFor(name)).toHaveLength(1);
      expect(warningsFor(name)[0]).toContain('not an integer');
    });

    it('clamps a negative value UP to the minimum, never down to 0', () => {
      const config = withEnv({ AUDIT_RETENTION_DAYS: '-5' });

      // Down to 0 would read as "never delete" and let the table grow unbounded from a typo;
      // up to 1 is aggressive but visible, and the warning says so.
      expect(config.retention.auditEventDays).toBe(RETENTION_DAYS_MIN);
      expect(warningsFor('AUDIT_RETENTION_DAYS')[0]).toContain('clamped');
    });

    it('clamps an absurdly large value down to ten years', () => {
      const config = withEnv({ LOG_RETENTION_DAYS: '99999' });

      expect(config.retention.applicationLogDays).toBe(RETENTION_DAYS_MAX);
      expect(warningsFor('LOG_RETENTION_DAYS')[0]).toContain('clamped');
    });

    it('accepts an in-range value verbatim and silently', () => {
      const config = withEnv({ SECURITY_EVENT_RETENTION_DAYS: '180' });

      expect(config.retention.securityEventDays).toBe(180);
      expect(warningsFor('SECURITY_EVENT_RETENTION_DAYS')).toEqual([]);
    });

    it('reads each window independently', () => {
      const config = withEnv({ AUDIT_RETENTION_DAYS: '0', LOG_RETENTION_DAYS: '7' });

      // Disabling one category must not disable, or reset, any other.
      expect(config.retention).toEqual({
        applicationLogDays: 7,
        auditEventDays: RETENTION_DISABLED,
        securityEventDays: 365,
        lifecycleEventDays: 90,
      });
    });

    it('exposes each window through retentionDaysFor by RetentionRun.category key', () => {
      const config = withEnv({ AUDIT_RETENTION_DAYS: '0' });

      // The retention service switches on these exact strings; a mismatch would silently prune
      // the wrong table or nothing at all.
      expect(config.retentionDaysFor('application_log')).toBe(30);
      expect(config.retentionDaysFor('audit_event')).toBe(RETENTION_DISABLED);
      expect(config.retentionDaysFor('security_event')).toBe(365);
      expect(config.retentionDaysFor('lifecycle_event')).toBe(90);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. readInt: the four numbers that decide writer behaviour
  // ───────────────────────────────────────────────────────────────────────────

  describe('readInt', () => {
    /** name, property, default, min, max — mirroring the module-private clamp bounds. */
    const NUMERIC: Array<[string, 'queueMax' | 'batchSize' | 'flushIntervalMs' | 'writeTimeoutMs', number, number, number]> = [
      ['OBSERVABILITY_QUEUE_MAX', 'queueMax', 5_000, 100, 100_000],
      ['OBSERVABILITY_BATCH_SIZE', 'batchSize', 200, 1, 2_000],
      ['OBSERVABILITY_FLUSH_INTERVAL_MS', 'flushIntervalMs', 2_000, 100, 60_000],
      ['OBSERVABILITY_WRITE_TIMEOUT_MS', 'writeTimeoutMs', 5_000, 250, 30_000],
    ];

    it('applies the production profile when nothing is set', () => {
      const config = withEnv();

      expect(config.queueMax).toBe(5_000);
      expect(config.batchSize).toBe(200);
      expect(config.flushIntervalMs).toBe(2_000);
      expect(config.writeTimeoutMs).toBe(5_000);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(NUMERIC)('%s falls back silently when blank', (name, key, fallback) => {
      const config = withEnv({ [name]: '' });

      expect(config[key]).toBe(fallback);
      expect(warningsFor(name)).toEqual([]);
    });

    it.each(NUMERIC)('%s warns and falls back on a non-integer', (name, key, fallback) => {
      // `parseInt('many')` is NaN. Left unchecked, NaN as a batch size stalls the flush loop
      // forever and NaN as a queue cap makes the bound comparison always false.
      const config = withEnv({ [name]: 'many' });

      expect(config[key]).toBe(fallback);
      expect(Number.isInteger(config[key])).toBe(true);
      expect(warningsFor(name)).toHaveLength(1);
      expect(warningsFor(name)[0]).toContain('not an integer');
    });

    it.each(NUMERIC)('%s clamps below the minimum and reports it', (name, key, _fallback, min) => {
      const config = withEnv({ [name]: '0' });

      // Unlike retention, 0 here has no special meaning — `BATCH_SIZE=0` would stall the loop,
      // so it is a typo to be corrected rather than an instruction to be obeyed.
      expect(config[key]).toBe(min);
      expect(warningsFor(name)[0]).toContain('clamped');
    });

    it.each(NUMERIC)('%s clamps above the maximum and reports it', (name, key, _fallback, _min, max) => {
      const config = withEnv({ [name]: '100000000' });

      // A bounded queue whose bound is 100 million is a memory leak with extra steps.
      expect(config[key]).toBe(max);
      expect(warningsFor(name)[0]).toContain('clamped');
    });

    it.each(NUMERIC)('%s accepts a mid-range value verbatim', (name, key, _fallback, min, max) => {
      const value = Math.floor((min + max) / 2);
      const config = withEnv({ [name]: String(value) });

      expect(config[key]).toBe(value);
      expect(warningsFor(name)).toEqual([]);
    });

    it('accepts the E2E profile unchanged', () => {
      // The documented low-latency profile — if any of these were clamped, the E2E suite would
      // silently run against production timings and its flush assertions would flake.
      const config = withEnv({
        OBSERVABILITY_FLUSH_INTERVAL_MS: '250',
        OBSERVABILITY_BATCH_SIZE: '50',
        OBSERVABILITY_QUEUE_MAX: '1000',
      });

      expect(config.flushIntervalMs).toBe(250);
      expect(config.batchSize).toBe(50);
      expect(config.queueMax).toBe(1_000);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps one bad variable from disturbing the others', () => {
      const config = withEnv({ OBSERVABILITY_BATCH_SIZE: 'oops' });

      expect(config.batchSize).toBe(200);
      expect(config.queueMax).toBe(5_000);
      expect(config.flushIntervalMs).toBe(2_000);
      expect(config.writeTimeoutMs).toBe(5_000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. enabled, level, identity and describe()
  // ───────────────────────────────────────────────────────────────────────────

  describe('enabled', () => {
    it('defaults to OFF', () => {
      // An installation that never created observability_db gets a platform that accepts calls
      // and does nothing, rather than one logging a connection error on every request.
      expect(withEnv().enabled).toBe(false);
    });

    it('requires the exact string "true"', () => {
      expect(withEnv({ OBSERVABILITY_ENABLED: 'true' }).enabled).toBe(true);
      // Anything else is off, deliberately: a half-configured value must not half-enable a
      // platform that writes to a database.
      for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'false', '']) {
        expect(withEnv({ OBSERVABILITY_ENABLED: value }).enabled).toBe(false);
      }
    });
  });

  describe('minLevel', () => {
    it('defaults to INFO with the matching severity', () => {
      const config = withEnv();

      expect(config.minLevel).toBe('INFO');
      expect(config.minLevelSeverity).toBe(LOG_LEVEL_SEVERITY.INFO);
    });

    it('reuses LOG_LEVEL, case-insensitively, so console and database agree', () => {
      // Same variable pino-config.ts reads — agreement by construction rather than convention.
      expect(withEnv({ LOG_LEVEL: 'warn' }).minLevel).toBe('WARN');
      expect(withEnv({ LOG_LEVEL: ' Debug ' }).minLevel).toBe('DEBUG');
      expect(withEnv({ LOG_LEVEL: 'FATAL' }).minLevel).toBe('FATAL');
    });

    it('maps pino\u2019s "silent" onto FATAL rather than refusing to start', () => {
      const config = withEnv({ LOG_LEVEL: 'silent' });

      expect(config.minLevel).toBe('FATAL');
      expect(config.minLevelSeverity).toBe(LOG_LEVEL_SEVERITY.FATAL);
    });

    it('falls back to INFO for an unknown level', () => {
      expect(withEnv({ LOG_LEVEL: 'verbose' }).minLevel).toBe('INFO');
    });

    it('accepts a level exactly at the threshold and refuses one below', () => {
      const config = withEnv({ LOG_LEVEL: 'warn' });

      // `>=`, not `>`: a WARN threshold must admit WARN itself.
      expect(config.acceptsLevel('WARN')).toBe(true);
      expect(config.acceptsLevel('ERROR')).toBe(true);
      expect(config.acceptsLevel('FATAL')).toBe(true);
      expect(config.acceptsLevel('INFO')).toBe(false);
      expect(config.acceptsLevel('DEBUG')).toBe(false);
      expect(config.acceptsLevel('TRACE')).toBe(false);
    });
  });

  describe('identity', () => {
    it('prefers OBSERVABILITY_SERVICE_NAME, then SERVICE_NAME, then the default', () => {
      // `service` is what distinguishes the combined process from the Core-only one and from a
      // remote module writing into the same tables.
      expect(withEnv({ OBSERVABILITY_SERVICE_NAME: 'obs', SERVICE_NAME: 'core' }).identity.service)
        .toBe('obs');
      expect(withEnv({ SERVICE_NAME: 'core-only' }).identity.service).toBe('core-only');
      expect(withEnv().identity.service).toBe('aria-api');
    });

    it('truncates every identity field to its column width', () => {
      const config = withEnv({
        OBSERVABILITY_SERVICE_NAME: 's'.repeat(200),
        NODE_ENV: 'e'.repeat(200),
        HOSTNAME: 'h'.repeat(200),
      });

      // Truncating here rather than letting Postgres reject the INSERT: a length error would
      // fail every write for the lifetime of the process.
      expect(config.identity.service).toHaveLength(64);
      expect(config.identity.environment).toHaveLength(32);
      expect(config.identity.instanceRef).toHaveLength(96);
    });

    it('never leaves instanceRef empty even if the hostname is unavailable', () => {
      delete process.env.HOSTNAME;
      const config = withEnv();

      expect(typeof config.identity.instanceRef).toBe('string');
      expect(config.identity.instanceRef).not.toHaveLength(0);
    });
  });

  describe('describe()', () => {
    it('reports the effective configuration for the health probe', () => {
      const config = withEnv({ OBSERVABILITY_ENABLED: 'true', OBSERVABILITY_BATCH_SIZE: '50' });

      expect(config.describe()).toEqual({
        enabled: true,
        minLevel: 'INFO',
        queueMax: 5_000,
        batchSize: 50,
        flushIntervalMs: 2_000,
        writeTimeoutMs: 5_000,
        retention: config.retention,
        service: config.identity.service,
        environment: config.identity.environment,
      });
    });

    it('NEVER includes a connection string or any credential', () => {
      process.env.OBSERVABILITY_DATABASE_URL =
        'postgresql://obs_user:sup3r-s3cret@localhost:5432/observability_db';
      const config = withEnv({ OBSERVABILITY_ENABLED: 'true' });

      // A health endpoint that echoes a connection string is a credential-disclosure bug
      // regardless of how well the endpoint is gated.
      const serialized = JSON.stringify(config.describe());
      expect(serialized).not.toContain('sup3r-s3cret');
      expect(serialized).not.toContain('postgresql://');
      expect(Object.keys(config.describe())).not.toContain('databaseUrl');
    });

    it('omits instanceRef, which is not a health-probe concern', () => {
      const config = withEnv();

      expect(config.describe()).not.toHaveProperty('instanceRef');
    });
  });
});
