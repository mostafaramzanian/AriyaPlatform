import {
  MIN_SECRET_LENGTH,
  SIGNATURE_WINDOW_MS,
  canonicalRequest,
  signRequest,
  verifySignature,
  type SignatureMaterial,
  type VerificationResult,
} from '../integrations/integration-signature';

/**
 * Phase 49M §19: module-to-module authentication.
 *
 * NO NEW SECURITY SCHEME IS INVENTED HERE. §19 says so explicitly, and the audit found
 * exactly one machine-to-machine mechanism in this repository: the HMAC-SHA256 over a
 * LENGTH-PREFIXED canonical string that 49L built in `integration-signature.ts`, itself
 * modelled on the AWS SigV4 scheme the MinIO client already uses. This file re-exports and
 * re-uses those primitives rather than copying them, so there is one canonicalisation and
 * one constant-time comparison in the codebase.
 *
 * WHY NOT mTLS, WHICH §19 LISTS FIRST
 * -----------------------------------
 * Because it does not exist here, and introducing it means introducing infrastructure.
 * Re-audited for this phase and unchanged since 49L: there is no client certificate
 * anywhere in the repo, no CA, no `https.Agent` configured with `cert`/`key`, and nothing
 * in the nginx config that requests a client certificate. Adopting mTLS would require
 * certificate issuance, distribution, renewal and revocation for every module instance —
 * a CA — which §20 explicitly says not to build unless existing infrastructure requires
 * it. HMAC with a per-module shared secret, encrypted at rest under the SAME
 * `AI_CONFIG_ENCRYPTION_KEY` and rotatable through the admin API, is the approved existing
 * mechanism. mTLS is recorded as a deferred option, not as a gap.
 *
 * WHAT IS DIFFERENT FROM 49L, AND WHY
 * -----------------------------------
 * Only the header namespace and the canonical field set. 49L signs an EVENT: method, path,
 * timestamp, eventId, idempotencyKey, body digest. A module call additionally carries an
 * ADDRESSED IDENTITY and a TENANT, and both must be covered by the signature or they could
 * be swapped in flight:
 *
 *   - `moduleId` — otherwise a request signed for module A could be replayed at module B
 *     if the two ever shared a secret, and "they never will" is not a property the
 *     signature should depend on;
 *   - `tenantId` — otherwise an attacker who captures a request for tenant T1 can replay
 *     it as T2 and the receiving module has no way to tell. §21 forbids letting a payload
 *     decide the tenant; covering it by the signature is how that becomes enforceable at
 *     the far end rather than merely intended at this one.
 *
 * Both are folded in through the EXISTING `eventId`/`idempotencyKey` slots of
 * `SignatureMaterial` — see `moduleSignatureMaterial` — so the canonicalisation itself is
 * untouched: same length-prefixing, same body digest, same ordering, same window, same
 * constant-time compare. Nothing about 49L's behaviour changes.
 */

/** Header names. Lower-case, matching Node's incoming-header normalisation. */
export const MODULE_SIGNATURE_HEADER = 'x-aria-module-signature';
export const MODULE_TIMESTAMP_HEADER = 'x-aria-module-timestamp';
export const MODULE_ID_HEADER = 'x-aria-module-id';
export const MODULE_INSTANCE_HEADER = 'x-aria-module-instance';
export const MODULE_REQUEST_HEADER = 'x-aria-module-request';
export const MODULE_TENANT_HEADER = 'x-aria-module-tenant';
export const MODULE_ACTOR_HEADER = 'x-aria-module-actor';
export const MODULE_CORRELATION_HEADER = 'x-aria-module-correlation';
export const MODULE_PROTOCOL_HEADER = 'x-aria-module-protocol';

/** Re-exported so callers never reach into the 49L module for the shared bounds. */
export { MIN_SECRET_LENGTH, SIGNATURE_WINDOW_MS };
export type { SignatureMaterial, VerificationResult };

/** Bytes of entropy in a generated module secret. 32 bytes → 64 hex characters. */
export const MODULE_SECRET_BYTES = 32;

/**
 * The identity a signature commits to.
 *
 * `tenantId` is `string | null`, and null is a DISTINCT signed value rather than an
 * omission — see `tenantSlot` below. A scheme in which "no tenant" and "tenant absent from
 * the canonical string" look the same is a scheme where dropping the header changes
 * nothing about the signature.
 */
export interface ModuleSignatureIdentity {
  moduleId: string;
  requestId: string;
  tenantId: string | null;
}

/**
 * Encodes the tenant for the canonical string.
 *
 * `-` for a genuinely tenant-less call, `t:<id>` otherwise. The prefix means a tenant
 * literally named `-` cannot collide with the null marker, and the marker is a real signed
 * value, so a stripped tenant header produces a signature mismatch rather than a silently
 * tenant-less call.
 */
function tenantSlot(tenantId: string | null): string {
  return tenantId === null ? '-' : `t:${tenantId}`;
}

export interface ModuleSignatureInput {
  method: string;
  /** Path only — no scheme, no host, no query. */
  path: string;
  /** Milliseconds since epoch, as a decimal string. */
  timestamp: string;
  identity: ModuleSignatureIdentity;
  /** The exact serialised body. */
  body: string;
}

/**
 * Builds the 49L `SignatureMaterial` for a module call.
 *
 * THE MAPPING IS THE WHOLE TRICK, and it is deliberate rather than clever:
 *   - `eventId`        ← `<moduleId>:<requestId>` — binds the destination identity
 *   - `idempotencyKey` ← `<tenant slot>`          — binds the tenant
 * Both slots are length-prefixed by `canonicalRequest`, so concatenating a colon-bearing
 * moduleId cannot splice into the requestId field; that is exactly the property 49L's
 * `<byteLength>:<value>` encoding was built for, and it is why reusing it is safe rather
 * than merely convenient.
 */
export function moduleSignatureMaterial(input: ModuleSignatureInput): SignatureMaterial {
  return {
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    eventId: `${input.identity.moduleId}:${input.identity.requestId}`,
    idempotencyKey: tenantSlot(input.identity.tenantId),
    body: input.body,
  };
}

/** Signs a module call. Hex HMAC-SHA256 over the canonical string. */
export function signModuleRequest(secret: string, input: ModuleSignatureInput): string {
  return signRequest(secret, moduleSignatureMaterial(input));
}

/**
 * Verifies a presented module signature.
 *
 * Delegates entirely to 49L's `verifySignature`, which checks the ±5-minute window BEFORE
 * spending an HMAC (so a flood of stale requests costs nothing) and compares in constant
 * time (so a hex prefix cannot be guessed byte by byte).
 */
export function verifyModuleRequest(
  secret: string,
  input: ModuleSignatureInput,
  presented: string | undefined,
  now: number = Date.now(),
): VerificationResult {
  return verifySignature(secret, moduleSignatureMaterial(input), presented, now);
}

/** Exposed for the spec, which asserts the canonical form directly. */
export function moduleCanonicalRequest(input: ModuleSignatureInput): string {
  return canonicalRequest(moduleSignatureMaterial(input));
}

/**
 * True when a credential has passed its configured expiry (§20).
 *
 * `null` means no expiry was configured, which is a real deployment choice and is NEVER
 * read as expired — the opposite default would silently break every module the moment this
 * column shipped.
 */
export function isSecretExpired(expiresAt: Date | null, now: number = Date.now()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now;
}

