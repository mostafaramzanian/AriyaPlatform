import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS,
  DEFAULT_LEGACY_ACCESS_TTL,
  DEFAULT_MAX_PERMISSIONS_PER_TOKEN,
  TOKEN_ASYMMETRIC_ALGORITHM,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_LEGACY_ALGORITHM,
  TOKEN_ROTATION_OVERLAP_SECONDS,
  TokenPolicyError,
} from './token-contract';
import {
  assertRotationOverlap,
  isRetired,
  parseSigningKeys,
  type TokenSigningKey,
} from './token-signing-keys';

/**
 * Phase 51-HR-ARCH-3A: the ONE place configuration decides how tokens are trusted.
 *
 * WHY A POLICY OBJECT INSTEAD OF `process.env` READS AT THE CALL SITE
 * ------------------------------------------------------------------
 * The decision "is this deployment asymmetric or still on the shared secret?" has to
 * be made identically by the issuer, the HTTP verifier, the WebSocket verifier and
 * the tenant resolver. If each of them read `process.env` itself, a half-migrated
 * deployment could sign RS256 while one verifier still accepted HMAC — exactly the
 * state ADR-0006 §B5 forbids. So the decision is derived ONCE, from configuration,
 * and everything else asks this object.
 *
 * NO SUBSCRIPTION TO A NEW MANDATORY VARIABLE
 * -------------------------------------------
 * Every asymmetric variable is OPTIONAL. With none of them set, `asymmetricEnabled`
 * is false and the deployment behaves exactly as it did before this phase: one
 * shared secret, Core's database as the authority for identity, tenant and
 * permissions. That is what keeps this phase a prerequisite rather than a policy
 * flip (§19/§20): enabling the new model is a deliberate act of supplying key
 * material, and nothing here turns it on by accident.
 *
 * WHAT `asymmetricEnabled` MEANS FOR HMAC
 * ---------------------------------------
 * When asymmetric verification is configured, HMAC tokens are refused outright —
 * `acceptedAlgorithm` is RS256 and nothing else. That is the ADR's §B5 "removal, not
 * a fallback chain": a deployment that has adopted public-key verification must not
 * keep a second, weaker way in. During the migration window that means configuring
 * asymmetric keys REQUIRES Core to be signing RS256; the two halves of the switch
 * are one switch, and the boot-time description this object produces says so.
 */

/**
 * Re-exported from the contract, where the key-set parser and the policy can both reach it
 * without either importing the other twice. Every call site that has always imported the
 * error from `token-policy` keeps working unchanged.
 */
export { TokenPolicyError };

export interface TokenPolicyEnv {
  readonly [name: string]: string | undefined;
}

/**
 * Every variable this policy reads, in one list.
 *
 * Exported so `env.validation.ts` and the architecture spec can assert that the
 * canonical names are declared exactly once, and so a reviewer can see the whole
 * configuration surface of the token contract in one screen.
 */
export const TOKEN_POLICY_ENV_NAMES = [
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'JWT_ASYMMETRIC_PUBLIC_KEY',
  'JWT_ASYMMETRIC_KEY_ID',
  'JWT_JWKS_URI',
  'JWT_ASYMMETRIC_PRIVATE_KEY',
  'JWT_SIGNING_KEYS',
  'JWT_ACTIVE_KEY_ID',
  'JWT_ASYMMETRIC_ACCESS_TTL_SECONDS',
  'JWT_LEGACY_HS256_ENABLED',
  'JWT_LEGACY_HS256_SUNSET',
  'HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS',
  'MAX_PERMISSIONS_PER_TOKEN',
] as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export class TokenPolicy {
  readonly issuer = TOKEN_ISSUER;
  readonly audience = TOKEN_AUDIENCE;

  /** ADR-0006 §C1(1): tokens longer-lived than this are rejected. */
  readonly maxAcceptedTtlSeconds: number;

  /** ADR-0006 §B4: the `perm` ceiling, enforced at issuance and at verification. */
  readonly maxPermissionsPerToken: number;

  /** The RS256 public key (PEM), when a static key is distributed instead of JWKS. */
  readonly asymmetricPublicKey: string | null;

  /** The `kid` of the static key. Rotation discipline, not a correctness requirement. */
  readonly asymmetricKeyId: string | null;

  /** The JWKS endpoint a verifier may fetch public keys from. */
  readonly jwksUri: string | null;

  /**
   * The RS256 private key. ISSUANCE ONLY — a verifier-only runtime must not set it,
   * which is why it is never consulted by `TokenVerifier`.
   */
  readonly asymmetricPrivateKey: string | null;

  /**
   * Phase 52-ARCH-3C: the configured signing key set (`JWT_SIGNING_KEYS`), in declaration
   * order. Empty when the variable is unset, in which case this deployment is on the
   * single-key path or on the bridge, exactly as before this phase.
   */
  readonly signingKeys: readonly TokenSigningKey[];

  /**
   * The `kid` that signs (`JWT_ACTIVE_KEY_ID`). Null for a verification-only key set, where
   * nothing here can mint a token.
   */
  readonly activeSigningKeyId: string | null;

  /** Lifetime of tokens Core mints in asymmetric mode. Never above `maxAcceptedTtlSeconds`. */
  readonly asymmetricAccessTtlSeconds: number;

  /** Whether the HS256 bridge is permitted at all. */
  readonly legacyHs256Enabled: boolean;

  /** Epoch milliseconds after which no HMAC token is accepted. Null = no sunset configured. */
  readonly legacyHs256SunsetMs: number | null;

  /** The shared secret, read HERE so the verifier itself never touches `JWT_SECRET`. */
  readonly legacyHs256Secret: string | null;

  /** Legacy token lifetime, preserving today's `JWT_EXPIRES_IN || '15m'` behaviour. */
  readonly legacyAccessTtl: string;

  constructor(env: TokenPolicyEnv) {
    this.maxAcceptedTtlSeconds = positiveInt(
      'HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS',
      env.HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS,
      DEFAULT_ACCEPTED_TOKEN_MAX_TTL_SECONDS,
    );
    this.maxPermissionsPerToken = positiveInt(
      'MAX_PERMISSIONS_PER_TOKEN',
      env.MAX_PERMISSIONS_PER_TOKEN,
      DEFAULT_MAX_PERMISSIONS_PER_TOKEN,
    );

    this.asymmetricPublicKey = text(env.JWT_ASYMMETRIC_PUBLIC_KEY) ?? null;
    this.asymmetricKeyId = text(env.JWT_ASYMMETRIC_KEY_ID) ?? null;
    this.jwksUri = text(env.JWT_JWKS_URI) ?? null;
    this.asymmetricPrivateKey = text(env.JWT_ASYMMETRIC_PRIVATE_KEY) ?? null;
    this.signingKeys = parseSigningKeys(env.JWT_SIGNING_KEYS);
    this.activeSigningKeyId = text(env.JWT_ACTIVE_KEY_ID) ?? null;

    if (this.asymmetricPublicKey && this.jwksUri) {
      throw new TokenPolicyError(
        'JWT_ASYMMETRIC_PUBLIC_KEY and JWT_JWKS_URI are both set. Configure exactly one key source: a static public key or a JWKS endpoint. Two sources means two answers to "which key signed this?".',
      );
    }

    if (
      this.asymmetricPublicKey &&
      /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(this.asymmetricPublicKey)
    ) {
      throw new TokenPolicyError(
        'JWT_ASYMMETRIC_PUBLIC_KEY contains PRIVATE key material. A verification key must be public; a verifier that holds the signing key has signing authority.',
      );
    }

    this.assertKeySetCoherent();
    assertRotationOverlap(this.signingKeys, this.activeSigningKeyId);

    const declaredTtl = positiveInt(
      'JWT_ASYMMETRIC_ACCESS_TTL_SECONDS',
      env.JWT_ASYMMETRIC_ACCESS_TTL_SECONDS,
      this.maxAcceptedTtlSeconds,
    );
    if (declaredTtl > this.maxAcceptedTtlSeconds) {
      throw new TokenPolicyError(
        `JWT_ASYMMETRIC_ACCESS_TTL_SECONDS (${declaredTtl}) exceeds HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS (${this.maxAcceptedTtlSeconds}). Minting a token this platform's own verifiers would reject is a configuration error, not a runtime surprise.`,
      );
    }
    this.asymmetricAccessTtlSeconds = declaredTtl;

    this.legacyHs256Enabled = booleanWithDefault(env.JWT_LEGACY_HS256_ENABLED, true);
    this.legacyHs256SunsetMs = sunsetMs(env.JWT_LEGACY_HS256_SUNSET);
    this.legacyHs256Secret = text(env.JWT_SECRET) ?? null;
    this.legacyAccessTtl = text(env.JWT_EXPIRES_IN) ?? DEFAULT_LEGACY_ACCESS_TTL;
  }

  /**
   * The key set's own rules, and its place in the ONE-key-source rule.
   *
   * Every refusal here describes a configuration that would leave the process able to do
   * something it must not (sign with a key it does not name as active), unable to do something
   * it must (publish the key it signs with), or unsure which of two sources answered a question
   * that has exactly one answer.
   */
  private assertKeySetCoherent(): void {
    if (this.signingKeys.length === 0) {
      if (this.activeSigningKeyId) {
        throw new TokenPolicyError(
          'JWT_ACTIVE_KEY_ID is set but JWT_SIGNING_KEYS is not. An active key without a key set names a key this process does not hold; configure the key set, or remove the variable.'
        );
      }

      return;
    }

    const conflicting = [
      ['JWT_ASYMMETRIC_PUBLIC_KEY', this.asymmetricPublicKey],
      ['JWT_ASYMMETRIC_KEY_ID', this.asymmetricKeyId],
      ['JWT_ASYMMETRIC_PRIVATE_KEY', this.asymmetricPrivateKey],
      ['JWT_JWKS_URI', this.jwksUri],
    ].find(([, value]) => Boolean(value));

    if (conflicting) {
      throw new TokenPolicyError(
        `JWT_SIGNING_KEYS and ${conflicting[0]} are both set. Configure exactly one key source: a key set, a static public key (with its key id), or a JWKS endpoint. Two sources means two answers to "which key signed this?".`
      );
    }

    const signingEntries = this.signingKeys.filter((key) => key.privatePem !== null);

    if (signingEntries.length > 0 && !this.activeSigningKeyId) {
      throw new TokenPolicyError(
        'JWT_SIGNING_KEYS holds signing material but JWT_ACTIVE_KEY_ID does not name the key that signs. A set may hold several keys, but exactly one of them is the active signer; without it this process cannot mint a token its own verifiers would publish a key for.'
      );
    }

    if (!this.activeSigningKeyId) return;

    const active = this.signingKeys.find((key) => key.kid === this.activeSigningKeyId);

    if (!active) {
      throw new TokenPolicyError(
        `JWT_ACTIVE_KEY_ID names kid=${JSON.stringify(this.activeSigningKeyId)}, which JWT_SIGNING_KEYS does not hold (it holds ${this.signingKeys
          .map((key) => JSON.stringify(key.kid))
          .join(', ')}).`
      );
    }

    if (signingEntries.length > 0 && active.privatePem === null) {
      throw new TokenPolicyError(
        `JWT_ACTIVE_KEY_ID names kid=${JSON.stringify(active.kid)}, which holds no private key, while other entries of JWT_SIGNING_KEYS do. The active key is the signing key, so it is the entry that must carry the private half.`
      );
    }
  }

  /**
   * Reads the policy from process configuration. A fixed list of names is read
   * (never a dynamic lookup), so the whole configuration surface is auditable above
   * and assertable in a test.
   */
  static fromConfig(config: ConfigService): TokenPolicy {
    const env: Record<string, string | undefined> = {};
    for (const name of TOKEN_POLICY_ENV_NAMES) {
      env[name] = config.get<string>(name);
    }
    return new TokenPolicy(env);
  }

  /**
   * True when this process verifies with public-key material, wherever it comes from: a key
   * set, a static public key, or a JWKS endpoint.
   *
   * The key set counts here for the reason ADR-0006 §B5 gives: the moment asymmetric material
   * is configured, HMAC acceptance is gone. A deployment that had been signing RS256 with a key
   * set but was still accepting shared-secret tokens would be exactly the half-migrated state
   * that section forbids.
   */
  get asymmetricEnabled(): boolean {
    return Boolean(this.asymmetricPublicKey || this.jwksUri || this.signingKeys.length > 0);
  }

  /**
   * True when this process HOLDS signing material for the asymmetric path.
   *
   * This is what the boot log reports as "signs RS256", and for the single-key path it means
   * exactly what it always has: a private key is configured. It is deliberately NOT
   * `signingKey !== null`, because those two questions differ in a case that already has a
   * defined answer — a private key with no key id holds signing material, and the ISSUER refuses
   * at mint time with a message naming the missing variable (`signingKeyProblem`). Narrowing this
   * getter would turn a diagnosable issuance error into a silent "verify-only".
   */
  get asymmetricIssuanceEnabled(): boolean {
    if (this.signingKeys.length > 0) {
      const active = this.signingKeys.find((key) => key.kid === this.activeSigningKeyId);
      return Boolean(active?.privatePem);
    }

    return this.asymmetricEnabled && Boolean(this.asymmetricPrivateKey);
  }

  /**
   * The ONE key this process signs with, or null when it can only verify.
   *
   * Both key sources are resolved here and nowhere else, so "which key signed this?" has one
   * answer for the issuer, and the mutual-exclusion rules above mean at most one of these
   * branches can be live.
   */
  get signingKey(): { readonly kid: string; readonly privatePem: string } | null {
    if (this.signingKeys.length > 0) {
      const active = this.signingKeys.find((key) => key.kid === this.activeSigningKeyId);
      return active?.privatePem ? { kid: active.kid, privatePem: active.privatePem } : null;
    }

    if (this.asymmetricPrivateKey && this.asymmetricKeyId) {
      return { kid: this.asymmetricKeyId, privatePem: this.asymmetricPrivateKey };
    }

    return null;
  }

  /**
   * Why no signing key could be resolved, phrased for the configuration that is IN PLACE.
   *
   * This exists so the issuer can refuse with a message that names the variable the operator
   * actually has to set — "JWT_ASYMMETRIC_PRIVATE_KEY" for a single-key deployment,
   * "JWT_SIGNING_KEYS"/"JWT_ACTIVE_KEY_ID" for a key set — instead of a generic complaint that
   * sends them to the wrong file. Null when a signing key exists.
   */
  get signingKeyProblem(): string | null {
    if (this.signingKey) return null;

    if (this.signingKeys.length > 0) {
      return `JWT_SIGNING_KEYS holds no private key for the active kid${this.activeSigningKeyId ? ` (kid=${JSON.stringify(this.activeSigningKeyId)})` : ''}, so this process can verify but not mint RS256 tokens. Configure the signing entry, or leave asymmetric configuration to verifiers only.`;
    }

    if (this.asymmetricPrivateKey) {
      return 'JWT_ASYMMETRIC_KEY_ID is required to mint RS256 tokens: this platform verifies asymmetric tokens by kid, so a token minted without one would be rejected by every verifier.';
    }

    return 'Asymmetric verification is configured but JWT_ASYMMETRIC_PRIVATE_KEY is not set on this process, so it cannot mint RS256 tokens. Configure the signing key on the issuer, or leave asymmetric configuration to verifiers only.';
  }

  /**
   * The public keys this process is willing to publish right now, ACTIVE KEY FIRST.
   *
   * Retirement is applied here rather than by the caller, for the same reason it is applied in
   * `TokenKeySet`: a key past its `retireAt` must stop being published and stop being accepted
   * at the same moment, or a verifier could hold a token the issuer no longer admits to
   * publishing.
   *
   * The static single-key path publishes only when a key id is configured: a JWKS entry without
   * a `kid` cannot be addressed by a token header, so publishing one would document a key no
   * verifier could ever select.
   */
  publishableKeys(
    now: number = Date.now()
  ): readonly { readonly kid: string; readonly publicPem: string }[] {
    if (this.signingKeys.length > 0) {
      const live = this.signingKeys.filter((key) => !isRetired(key, now));
      const active = live.filter((key) => key.kid === this.activeSigningKeyId);
      const retiring = live.filter((key) => key.kid !== this.activeSigningKeyId);

      return [...active, ...retiring].map((key) => ({
        kid: key.kid,
        publicPem: key.publicPem,
      }));
    }

    if (this.asymmetricPublicKey && this.asymmetricKeyId) {
      return [{ kid: this.asymmetricKeyId, publicPem: this.asymmetricPublicKey }];
    }

    return [];
  }

  /**
   * The single algorithm this deployment accepts.
   *
   * A pinned value rather than a list: a list is what lets a token header choose.
   */
  get acceptedAlgorithm(): string {
    return this.asymmetricEnabled ? TOKEN_ASYMMETRIC_ALGORITHM : TOKEN_LEGACY_ALGORITHM;
  }

  /**
   * Whether an HS256 token may be accepted right now.
   *
   * False unconditionally once asymmetric verification is configured (§B5), and false
   * after the configured sunset even on a deployment still on the shared secret — so
   * "we will remove HMAC later" carries a date rather than an intention.
   */
  legacyAccepted(now: number = Date.now()): boolean {
    if (this.asymmetricEnabled) return false;
    if (!this.legacyHs256Enabled) return false;
    if (this.legacyHs256SunsetMs !== null && now >= this.legacyHs256SunsetMs) return false;
    return this.legacyHs256Secret !== null;
  }

  /**
   * A one-line description of this deployment's trust posture, for the boot log.
   *
   * Operators should be able to answer "what does this process accept?" from the log
   * alone, without reading the environment — and a reviewer should be able to see,
   * after the fact, whether a given boot was asymmetric or on the bridge.
   */
  describe(): string {
    if (this.asymmetricEnabled) {
      const keySource =
        this.signingKeys.length > 0
          ? `key-set(${this.signingKeys.length} key${this.signingKeys.length === 1 ? '' : 's'}, active=${this.activeSigningKeyId ?? 'none'}, overlap>=${TOKEN_ROTATION_OVERLAP_SECONDS}s)`
          : this.jwksUri
            ? `jwks=${this.jwksUri}`
            : `static-key${this.asymmetricKeyId ? `(kid=${this.asymmetricKeyId})` : '(kid unpinned)'}`;
      const issuance = this.asymmetricIssuanceEnabled ? 'signs RS256' : 'verify-only';
      const published = this.publishableKeys().length;

      return `${TOKEN_ASYMMETRIC_ALGORITHM} from ${keySource}, ${issuance}, ${published} public key(s) published, max-ttl=${this.maxAcceptedTtlSeconds}s, HMAC acceptance disabled`;
    }

    const sunset = this.legacyHs256SunsetMs
      ? `, sunset=${new Date(this.legacyHs256SunsetMs).toISOString()}`
      : '';
    return `${TOKEN_LEGACY_ALGORITHM} with the shared secret (asymmetric keys not configured), max-ttl=${this.maxAcceptedTtlSeconds}s${sunset}`;
  }
}

function text(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = text(raw);
  if (value === undefined) return fallback;

  if (!/^\d+$/.test(value)) {
    throw new TokenPolicyError(
      `${name} must be a whole number of seconds/entries; received ${JSON.stringify(raw)}.`,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TokenPolicyError(
      `${name} must be a positive whole number; received ${JSON.stringify(raw)}.`,
    );
  }

  return parsed;
}

function booleanWithDefault(raw: string | undefined, fallback: boolean): boolean {
  const value = text(raw);
  if (value === undefined) return fallback;

  const lower = value.toLowerCase();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;

  throw new TokenPolicyError(
    `JWT_LEGACY_HS256_ENABLED must be a boolean (${JSON.stringify(raw)} is not). Use one of true/false/1/0/yes/no/on/off.`,
  );
}

function sunsetMs(raw: string | undefined): number | null {
  const value = text(raw);
  if (value === undefined) return null;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TokenPolicyError(
      `JWT_LEGACY_HS256_SUNSET must be an ISO-8601 timestamp (e.g. 2026-12-31T00:00:00Z); received ${JSON.stringify(raw)}.`,
    );
  }

  return parsed;
}
