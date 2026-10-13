import { trace } from '@opentelemetry/api';
import { redactPayload } from '../common/audit-redactor.util';
import { RequestContextService } from '../common/request-context.service';
import {
  MAX_CONTEXT_BYTES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_NAME_LENGTH,
  MAX_ERROR_STACK_LENGTH,
  ObservabilityCorrelation,
} from './observability.contract';

/**
 * Phase 49M-2: the single place where caller data is made safe to persist.
 *
 * EVERY WRITE PATH GOES THROUGH THESE FUNCTIONS. That is the point of a separate file:
 * `redactPayload` already exists in `common/audit-redactor.util.ts` and already handles
 * password/token/email/phone masking, base64 blobs, circular references and oversized
 * payloads. Reimplementing any of that here would create a second redaction policy that
 * drifts from the first — and the one that drifts is the one that leaks.
 *
 * WHAT THIS FILE ADDS ON TOP OF `redactPayload`:
 *  - a much tighter size ceiling (8 KiB vs 100 KiB), because a log context is ids, not a
 *    payload;
 *  - VarChar-width truncation, so a long string becomes a short string instead of a
 *    Postgres `22001` error that fails the write and loses the row;
 *  - error normalization that keeps name/message/stack apart, so a stack is never
 *    concatenated into an indexed column;
 *  - identifier masking for `attemptedIdentifier`, which is the one field on a security
 *    event that holds something a person typed.
 */

/** Truncates to a VarChar width. Returns null for empty input so the column stays NULL. */
export function clampText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** Key-name stems that mark a value as sensitive wherever they appear. */
const SENSITIVE_KEY_STEMS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'private_key',
  'passphrase',
  'otp',
  'pin',
  'signature',
  'hash',
];

/**
 * Collects every key in the bag whose NAME suggests a secret, at any depth.
 *
 * WHY THIS EXISTS ON TOP OF `redactPayload`: the shared redactor matches key names EXACTLY
 * against its own list, so `apiSecret`, `webhookToken`, `dbPassword` and `hmacSignature` all
 * pass through untouched — the list has `secret`, `token`, `password`, not every compound
 * containing them. Exact matching is a reasonable policy for the audit payloads it was written
 * for, where the shape is known; it is the wrong policy for a free-form log context, where the
 * whole point is that callers put arbitrary keys in it.
 *
 * THE STEMS ARE APPLIED HERE, NOT IN THE SHARED REDACTOR, deliberately. Widening the shared
 * list to substring matching would change redaction for the existing core_db."AuditLog" path
 * too, and §51 keeps that behaviour untouched. Feeding the discovered key names back in
 * through `alwaysRedact` — which `redactPayload` already supports — gets the stronger policy
 * with no change to the shared function.
 *
 * OVER-REDACTION IS THE ACCEPTABLE DIRECTION: `passwordChangedAt` becoming `[REDACTED]` costs
 * a diagnostic detail; `dbPassword` surviving costs a credential.
 */
function collectSensitiveKeys(value: unknown, found: Set<string>, depth = 0): Set<string> {
  if (depth > 8 || value === null || typeof value !== 'object') return found;

  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveKeys(item, found, depth + 1);
    return found;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_STEMS.some((stem) => lower.includes(stem))) found.add(key);
    collectSensitiveKeys(child, found, depth + 1);
  }
  return found;
}

/**
 * Redacts and size-caps a structured bag for a Json column.
 *
 * OVER-SIZE BECOMES A DESCRIPTOR, NOT A TRUNCATED OBJECT. `redactPayload` already returns
 * `{ __truncated: true, size, checksum, preview }` in that case, and preserving that shape
 * matters: a reader can tell "the caller passed something enormous" apart from "the caller
 * passed nothing", and the checksum lets two oversized rows be compared without storing
 * either payload.
 */
export function sanitizeContext(
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!context) return null;
  const keys = Object.keys(context);
  if (keys.length === 0) return null;

  const { redacted } = redactPayload(context, {
    emailMask: true,
    phoneMask: true,
    maxPayloadBytes: MAX_CONTEXT_BYTES,
    alwaysRedact: Array.from(collectSensitiveKeys(context, new Set<string>())),
  });

  if (redacted === null || redacted === undefined) return null;
  if (typeof redacted !== 'object' || Array.isArray(redacted)) {
    // A Json column can hold a scalar, but a consistent object shape keeps the reader
    // simple, so anything non-object is wrapped rather than stored bare.
    return { value: redacted as unknown };
  }
  return redacted as Record<string, unknown>;
}

/** Normalized error triple. `stack` is capped and never indexed. */
export interface NormalizedError {
  errorName: string | null;
  errorMessage: string | null;
  errorStack: string | null;
}

/**
 * Splits an unknown thrown value into name/message/stack.
 *
 * ACCEPTS `unknown` BECAUSE JAVASCRIPT CAN THROW ANYTHING. A `catch` block receives
 * whatever was thrown — a string, an object, `undefined` — and a logger that assumes
 * `Error` will itself throw inside the error path, which is the worst possible place.
 *
 * THE STACK IS TRUNCATED, NOT DROPPED: the first 8 KiB contain the frames that identify
 * the fault. A full stack from a deep async chain can be far larger and its tail is
 * framework noise.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error === null || error === undefined) {
    return { errorName: null, errorMessage: null, errorStack: null };
  }

  if (error instanceof Error) {
    return {
      errorName: clampText(error.name, MAX_ERROR_NAME_LENGTH),
      errorMessage: clampText(error.message, MAX_ERROR_MESSAGE_LENGTH),
      errorStack: clampText(error.stack, MAX_ERROR_STACK_LENGTH),
    };
  }

  if (typeof error === 'string') {
    return {
      errorName: 'Error',
      errorMessage: clampText(error, MAX_ERROR_MESSAGE_LENGTH),
      errorStack: null,
    };
  }

  // An object that is not an Error: keep whatever name/message it offers, and serialise
  // the rest THROUGH the redactor — a rejected HTTP response object routinely carries
  // headers and tokens, and it must not reach the database unredacted.
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : 'UnknownError';
  const message =
    typeof candidate.message === 'string'
      ? candidate.message
      : safeStringify(error).slice(0, MAX_ERROR_MESSAGE_LENGTH);

  return {
    errorName: clampText(name, MAX_ERROR_NAME_LENGTH),
    errorMessage: clampText(message, MAX_ERROR_MESSAGE_LENGTH),
    errorStack: null,
  };
}

function safeStringify(value: unknown): string {
  try {
    const { redacted } = redactPayload(value, {
      emailMask: true,
      phoneMask: true,
      maxPayloadBytes: MAX_CONTEXT_BYTES,
    });
    return JSON.stringify(redacted) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Masks the identifier someone TRIED to authenticate with.
 *
 * WHY THIS FIELD IS STORED AT ALL: "twelve failed logins for one account from four IPs" is
 * the single most useful signal in a security table, and it is unanswerable if the subject
 * is dropped entirely.
 *
 * WHY IT IS MASKED: the identifier of a failed login is frequently a REAL user's address,
 * and on a typo it can be a password typed into the username box. `a***@example.com`
 * preserves grouping — the same input always produces the same mask — while making the
 * table useless to anyone who exfiltrates it.
 *
 * A non-email identifier is masked more aggressively (first char + length) because it
 * could be anything, including a secret.
 */
export function maskIdentifier(value: string | null | undefined): string | null {
  const raw = clampText(value, 320);
  if (!raw) return null;

  const at = raw.indexOf('@');
  if (at > 0 && at < raw.length - 1) {
    const local = raw.slice(0, at);
    const domain = raw.slice(at);
    const keep = Math.max(1, Math.floor(local.length / 3));
    return `${local.slice(0, keep)}***${domain}`.slice(0, 160);
  }

  return `${raw.slice(0, 1)}***(${raw.length})`.slice(0, 160);
}

/**
 * Reads the ambient correlation identifiers.
 *
 * THE WRITER CALLS THIS; CALLERS CANNOT SUPPLY THESE VALUES. `requestId`/`correlationId`
 * come from the AsyncLocalStorage store that `RequestContextMiddleware` populates, and
 * `traceId`/`spanId` from the active OTel span. If a caller could pass them it could
 * attribute its events to another user's request, which would make the audit trail
 * unreliable in exactly the situation where it matters.
 *
 * BOTH SOURCES ARE OPTIONAL. Background work outside a request has no store, and OTel is
 * off unless `OTEL_ENABLED=true`, so `trace.getActiveSpan()` legitimately returns
 * undefined. Every field here is nullable in the schema for that reason.
 */
export function resolveCorrelation(): ObservabilityCorrelation {
  const ctx = RequestContextService.get();

  let traceId: string | null = null;
  let spanId: string | null = null;
  try {
    const span = trace.getActiveSpan();
    const spanContext = span?.spanContext();
    if (spanContext?.traceId) {
      traceId = spanContext.traceId;
      spanId = spanContext.spanId ?? null;
    }
  } catch {
    // The OTel API never throws in practice, but the logger must not be the thing that
    // breaks when instrumentation is misconfigured.
  }

  return {
    requestId: clampText(ctx?.requestId, 64),
    // Falls back to requestId so a row is always joinable to its request even when no
    // upstream correlation header was supplied.
    //
    // THE FALLBACK IS ON THE CLAMPED VALUE, not on `??` over the raw field: an EMPTY STRING
    // is not nullish, so `ctx.correlationId ?? ctx.requestId` would keep `''` and produce a
    // row with no correlation at all. Clamping first turns blank into null, which then falls
    // through as intended.
    correlationId: clampText(ctx?.correlationId, 64) ?? clampText(ctx?.requestId, 64),
    traceId: clampText(traceId, 64),
    spanId: clampText(spanId, 32),
  };
}
