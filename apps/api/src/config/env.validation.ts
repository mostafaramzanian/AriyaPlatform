import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Phase 49S-1: centralized environment validation.
 *
 * Required security configuration must be present and non-trivial in production.
 * Development and test environments may use explicit test values, but there are
 * no silent fallbacks that would let a production deployment boot with a publicly
 * known secret or with CORS set to '*' while credentials are enabled.
 */

const nonEmptyString = (message: string) =>
  z.string({ required_error: message, invalid_type_error: message }).min(1, message);

const noPlaceholder = (value: string) => {
  const lower = value.toLowerCase();
  if (lower.includes('change') || lower.includes('default') || lower.includes('dev-secret')) {
    return false;
  }
  return true;
};

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** A positive integer from the environment, where an empty value means "not set". */
const optionalPositiveInt = (message: string) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive({ message })).optional();

const requiredPositiveInt = (message: string, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive({ message }).default(fallback));

const secretSchema = nonEmptyString('Required secret is missing or empty');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3001'),
  CORE_PORT: z.string().optional(),

  CORE_DATABASE_URL: nonEmptyString('CORE_DATABASE_URL is required'),
  CMS_DATABASE_URL: z.string().optional(),
  // Phase 50-MOD-CORR: the Correspondence module's own database
  // (prisma/correspondence/schema.prisma). Optional at the platform level and
  // required by the module itself, exactly like CMS_DATABASE_URL — a process that
  // does not enable correspondence (the CMS-only process) must still be able to boot.
  //
  // Correspondence must NOT point at core_db: sharing Core's database would put the
  // module back inside Core's persistence boundary, which is the thing this phase
  // removes. Pointing it at core_db would also make the architectural regression test
  // (no correspondence model reads Core's client) meaningless.
  // Required by the combined runtime (AppModule). CMS-only and Core-only
  // runtimes do not enable Correspondence, so it remains optional at the
  // platform level exactly like CMS_DATABASE_URL.
  CORRESPONDENCE_DATABASE_URL: z.string().optional(),
  // Phase 51-HR-1: the Human Resources module's own database
  // (prisma/hr/schema.prisma). Optional at the platform level and required by the
  // module itself, exactly like CMS_DATABASE_URL and CORRESPONDENCE_DATABASE_URL — a
  // process that does not enable HR (the Core-only and CMS-only runtimes) must still
  // boot.
  //
  // HR_DATABASE_URL MUST NOT POINT AT core_db. HR holds personnel records whose
  // lifecycle is deliberately independent of a Core login: an employee may never have
  // one, and a departed login must not take its employment history with it. Sharing
  // Core's database would also make the module's "no Core Prisma client" boundary
  // check meaningless.
  //
  // Required by the combined runtime (AppModule, since Phase 51-HR-1) and, when the
  // standalone HR runtime is built, by `future-hr`. Core-only and CMS-only mark it
  // `not-used` and never open this connection.
  HR_DATABASE_URL: z.string().optional(),
  // Phase C1: the Commerce / Procurement module's own database
  // (prisma/commerce/schema.prisma). Optional at the platform level and required by
  // the module itself, exactly like CMS_DATABASE_URL, CORRESPONDENCE_DATABASE_URL
  // and HR_DATABASE_URL — a process that does not enable Commerce (Core-only,
  // CMS-only and the future standalone HR runtimes) must still boot.
  //
  // COMMERCE_DATABASE_URL MUST NOT POINT AT core_db or hr_db: Commerce holds
  // purchase documents, workflow history and payment/receiving/return ledgers whose
  // lifecycles are deliberately independent of Core identity and HR employment.
  // Sharing another owner's database would also make the module's "no Core/HR Prisma
  // client" boundary check meaningless.
  //
  // Required by the combined runtime (AppModule, once Phase C1 step F composes
  // `CommerceModule`); Core-only, CMS-only and future-hr mark it `not-used` and
  // never open this connection.
  COMMERCE_DATABASE_URL: z.string().optional(),

  // Production database (Phase PRODUCTION-BOM-HEADER; required by the combined runtime)
  // Migrate with `npm run db:migrate:production`.
  //
  // Production / تولید owns this database, its Prisma project
  // (prisma/production/schema.prisma), its migration history and its generated client.
  // It is optional at the PLATFORM level, exactly like CMS_DATABASE_URL,
  // CORRESPONDENCE_DATABASE_URL, HR_DATABASE_URL and COMMERCE_DATABASE_URL — a process
  // that does not enable Production (Core-only, CMS-only and the future standalone HR
  // runtimes) must still boot.
  //
  // PRODUCTION_DATABASE_URL MUST NOT POINT AT core_db, commerce_db or hr_db: BOM
  // headers have a lifecycle independent of Core identity, of procurement and of HR
  // employment, and sharing another owner's database would make this module's "no other
  // owner's Prisma client" boundary check meaningless.
  //
  // Required by the combined runtime (AppModule composes `ProductionModule`); Core-only,
  // CMS-only and future-hr mark it `not-used` and never open this connection.
  PRODUCTION_DATABASE_URL: z.string().optional(),

  // Finance database (Phase F1 — FINANCIAL FOUNDATION; required by the combined runtime)
  // Migrate with `npm run prisma:migrate:financial`.
  //
  // Financial / مالی owns this database (`finance_db`), its Prisma project
  // (prisma/financial/schema.prisma), its migration history and its generated client.
  // It is optional at the PLATFORM level, exactly like every other module datasource —
  // a process that does not enable Financial (Core-only, CMS-only and the future
  // standalone HR runtimes) must still boot.
  //
  // FINANCE_DATABASE_URL MUST NOT POINT AT core_db, commerce_db, hr_db or
  // production_db: check requests have a lifecycle independent of identity, of
  // procurement and of BOM, and sharing another owner's database would make this
  // module's "no other owner's Prisma client" boundary check meaningless.
  //
  // Required by the combined runtime (AppModule composes `FinancialModule`); Core-only,
  // CMS-only and future-hr mark it `not-used` and never open this connection.
  FINANCE_DATABASE_URL: z.string().optional(),
  CMS_PORT: z.string().optional(),
  OBSERVABILITY_DATABASE_URL: z.string().optional(),

  REDIS_URL: z.string().default('redis://redis:6379'),
  RABBITMQ_URL: z.string().optional(),

  JWT_SECRET: secretSchema,
  JWT_REFRESH_SECRET: secretSchema,
  JWT_EXPIRATION: z.string().default('900'),
  JWT_REFRESH_EXPIRATION: z.string().default('604800'),

  // ---------------------------------------------------------------------------
  // Phase 51-HR-ARCH-3A: the token contract (ADR-0006 §B/C).
  //
  // EVERY ONE OF THESE IS OPTIONAL, and that is the point: a deployment that sets none of
  // them keeps exactly the behaviour it had before this phase (one shared secret, Core's
  // database as the authority for identity, tenant and permissions). The asymmetric model
  // is entered by supplying key material deliberately, and nothing here turns it on by
  // accident. `TokenPolicy` (platform/auth) is the only reader of these names.
  //
  // `JWT_ASYMMETRIC_PUBLIC_KEY` (a PEM) and `JWT_JWKS_URI` are mutually exclusive: two key
  // sources would mean two answers to "which key signed this?".
  // ---------------------------------------------------------------------------
  JWT_ASYMMETRIC_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string()).optional(),
  JWT_ASYMMETRIC_KEY_ID: z.preprocess(emptyToUndefined, z.string()).optional(),
  JWT_JWKS_URI: z
    .preprocess(
      emptyToUndefined,
      z.string().refine((value) => /^https?:\/\/\S+$/.test(value), {
        message: 'JWT_JWKS_URI must be an absolute http(s) URL',
      }),
    )
    .optional(),
  // ISSUANCE ONLY. A verifier-only runtime (the standalone HR runtime this work enables) must
  // NOT set it; `TokenPolicy` refuses a public key that contains private material for the
  // same reason.
  JWT_ASYMMETRIC_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string()).optional(),
  JWT_ASYMMETRIC_ACCESS_TTL_SECONDS: optionalPositiveInt(
    'JWT_ASYMMETRIC_ACCESS_TTL_SECONDS must be a positive whole number of seconds',
  ),
  // Phase 52-ARCH-3C: the signing KEY SET and the key that signs. `JWT_SIGNING_KEYS` is a JSON
  // array of `{ kid, publicKey?, privateKey?, activatedAt?, retireAt? }` entries, parsed,
  // validated and RSA-size-checked by `token-signing-keys.ts` — the ONE reader of its shape, so
  // no second parser here can disagree about what a key set may contain. It is mutually
  // exclusive with the single-key variables above, for the same reason those are mutually
  // exclusive with each other.
  JWT_SIGNING_KEYS: z.preprocess(emptyToUndefined, z.string()).optional(),
  JWT_ACTIVE_KEY_ID: z.preprocess(emptyToUndefined, z.string()).optional(),
  // The migration bridge. Set to `false`, or set a sunset, to stop accepting shared-secret
  // tokens. Acceptance is ALSO disabled automatically the moment asymmetric keys are
  // configured (ADR-0006 §B5): there is no fallback chain.
  JWT_LEGACY_HS256_ENABLED: z.preprocess(
    emptyToUndefined,
    z.enum(['true', 'false'], { message: 'JWT_LEGACY_HS256_ENABLED must be "true" or "false"' }),
  ).optional(),
  JWT_LEGACY_HS256_SUNSET: z
    .preprocess(
      emptyToUndefined,
      z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: 'JWT_LEGACY_HS256_SUNSET must be an ISO-8601 timestamp',
      }),
    )
    .optional(),
  // ADR-0006 §C1(1): tokens HR accepts. A token whose `exp - iat` exceeds this is rejected.
  HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS: requiredPositiveInt(
    'HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS must be a positive whole number of seconds',
    300,
  ),
  // ADR-0006 §B4: the ceiling on the `perm` claim, enforced at issuance and at verification.
  MAX_PERMISSIONS_PER_TOKEN: requiredPositiveInt(
    'MAX_PERMISSIONS_PER_TOKEN must be a positive whole number',
    200,
  ),
  // The legacy access-token lifetime. Previously read by the refresh path as
  // `JWT_EXPIRES_IN || '15m'` while the login path hard-coded `15m`; both now use this.
  JWT_EXPIRES_IN: z.preprocess(emptyToUndefined, z.string().default('15m')),

  CORS_ORIGINS: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),

  MAX_ACTIVE_SESSIONS_PER_USER: z.coerce.number().int().positive().default(10),

  AI_CONFIG_ENCRYPTION_KEY: z.string().optional(),

  LOG_LEVEL: z.string().default('info'),
});

export type ValidatedEnv = z.infer<typeof baseSchema>;

export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const parsed = baseSchema.safeParse(config);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    const message = `Environment validation failed:\n${issues.join('\n')}`;
    throw new Error(message);
  }

  const env = parsed.data;

  // Phase 51-HR-ARCH-3A: cross-field rules for the token contract. Each one describes a
  // configuration that cannot be honoured at runtime, so it fails at BOOT rather than at the
  // first request.
  if (env.JWT_ASYMMETRIC_PUBLIC_KEY && env.JWT_JWKS_URI) {
    throw new Error(
      'JWT_ASYMMETRIC_PUBLIC_KEY and JWT_JWKS_URI are both set. Configure exactly one key source: a static public key or a JWKS endpoint.',
    );
  }

  if (
    env.JWT_ASYMMETRIC_PUBLIC_KEY &&
    /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(env.JWT_ASYMMETRIC_PUBLIC_KEY)
  ) {
    throw new Error(
      'JWT_ASYMMETRIC_PUBLIC_KEY contains PRIVATE key material. A verification key must be public: a verifier that holds the signing key has signing authority.',
    );
  }

  if (
    env.JWT_ASYMMETRIC_PUBLIC_KEY &&
    !/-----BEGIN (?:RSA )?PUBLIC KEY-----|-----BEGIN CERTIFICATE-----/.test(env.JWT_ASYMMETRIC_PUBLIC_KEY)
  ) {
    throw new Error(
      'JWT_ASYMMETRIC_PUBLIC_KEY must be a PEM-encoded public key or certificate.',
    );
  }

  // Phase 52-ARCH-3C: the key set is a THIRD key source, so it obeys the same rule the two
  // above obey — exactly one source, because two sources are two answers to "which key signed
  // this?" — and an active key id without a key set names a key nothing here holds.
  if (
    env.JWT_SIGNING_KEYS &&
    (env.JWT_ASYMMETRIC_PUBLIC_KEY ||
      env.JWT_ASYMMETRIC_KEY_ID ||
      env.JWT_ASYMMETRIC_PRIVATE_KEY ||
      env.JWT_JWKS_URI)
  ) {
    throw new Error(
      'JWT_SIGNING_KEYS cannot be combined with JWT_ASYMMETRIC_PUBLIC_KEY, JWT_ASYMMETRIC_KEY_ID, JWT_ASYMMETRIC_PRIVATE_KEY or JWT_JWKS_URI. Configure exactly one key source: a key set, a static key, or a JWKS endpoint.'
    );
  }

  if (env.JWT_ACTIVE_KEY_ID && !env.JWT_SIGNING_KEYS) {
    throw new Error(
      'JWT_ACTIVE_KEY_ID is set but JWT_SIGNING_KEYS is not: an active key without a key set names a key this process does not hold.'
    );
  }

  if (
    env.JWT_ASYMMETRIC_ACCESS_TTL_SECONDS !== undefined &&
    env.JWT_ASYMMETRIC_ACCESS_TTL_SECONDS > env.HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `JWT_ASYMMETRIC_ACCESS_TTL_SECONDS (${env.JWT_ASYMMETRIC_ACCESS_TTL_SECONDS}) exceeds HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS (${env.HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS}): this platform would reject the very tokens it mints.`,
    );
  }

  if (env.NODE_ENV === 'production') {
    for (const [name, value] of [
      ['JWT_SECRET', env.JWT_SECRET],
      ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
    ] as const) {
      if (!noPlaceholder(value)) {
        throw new Error(
          `${name} appears to be a placeholder. Set a strong, randomly-generated value in production.`,
        );
      }
    }

    const origins = resolveCorsOrigins(env.CORS_ORIGINS || env.CORS_ORIGIN);
    if (origins.length === 0) {
      throw new Error(
        'CORS_ORIGINS (or CORS_ORIGIN) is required in production and must contain at least one explicit origin.',
      );
    }
    if (origins.includes('*')) {
      throw new Error(
        'CORS_ORIGINS wildcard "*" is not allowed when credentials are enabled. List explicit origins instead.',
      );
    }

    if (!env.AI_CONFIG_ENCRYPTION_KEY || env.AI_CONFIG_ENCRYPTION_KEY.length < 32) {
      throw new Error(
        'AI_CONFIG_ENCRYPTION_KEY is required in production and must be at least 32 bytes/characters.',
      );
    }
  }

  return env;
}

export function resolveCorsOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function buildCorsOrigin(
  config: Pick<ValidatedEnv, 'CORS_ORIGINS' | 'CORS_ORIGIN'>,
): (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void {
  const allowlist = new Set(resolveCorsOrigins(config.CORS_ORIGINS || config.CORS_ORIGIN));

  return (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server, mobile apps, curl)
    if (!origin) {
      return callback(null, true);
    }
    if (allowlist.has(origin)) {
      return callback(null, true);
    }
    // A denied origin is a 4xx-class decision, not a server fault. Passing an
    // HttpException through the CORS callback lets the exception filter answer
    // 403 instead of turning a security refusal into HTTP 500.
    callback(new ForbiddenException(`CORS origin ${origin} is not allowed`), false);
  };
}
