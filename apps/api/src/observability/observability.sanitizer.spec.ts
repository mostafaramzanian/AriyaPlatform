import {
  clampText,
  maskIdentifier,
  normalizeError,
  resolveCorrelation,
  sanitizeContext,
} from './observability.sanitizer';
import { RequestContextService } from '../common/request-context.service';
import { MAX_CONTEXT_BYTES } from './observability.contract';

/**
 * Phase 49M-2: the write-time privacy boundary.
 *
 * THESE ARE THE TWELVE SECURITY-RELEVANT PROPERTIES OF THE PHASE, expressed as tests rather
 * than as comments, because every one of them is a claim that could silently stop being true:
 *
 *   1. A password anywhere in a context bag never reaches the database.
 *   2. Nor does a token, secret or authorization header value.
 *   3. An email is masked, not stored raw.
 *   4. An oversized bag becomes a size + checksum descriptor, not a truncated object that
 *      might end mid-credential.
 *   5. A field longer than its column is truncated rather than causing a 22001 that loses the
 *      whole row.
 *   6. `attemptedIdentifier` — whatever a person typed into a login form — is masked.
 *   7. The mask is STABLE, so grouping still works, and it is not reversible.
 *   8. A thrown non-Error cannot crash the logger.
 *   9. An error object carrying headers is redacted before serialisation.
 *  10. Correlation ids come from the ambient context, never from a caller.
 *  11. A circular structure does not throw.
 *  12. Absent context yields NULL rather than an empty object, so a row with no context is
 *      distinguishable from one whose context was dropped.
 */

describe('observability sanitizer', () => {
  it('1. strips a password from a nested context bag', () => {
    const result = sanitizeContext({ user: { name: 'ali', password: 'hunter2' } });

    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('2. strips tokens, secrets and authorization values', () => {
    const result = sanitizeContext({
      accessToken: 'eyJhbGciOi.secret.value',
      apiSecret: 'sk_live_abcdef',
      authorization: 'Bearer eyJhbGciOi',
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain('sk_live_abcdef');
    expect(json).not.toContain('eyJhbGciOi');
  });

  it('3. masks an email rather than storing it raw', () => {
    const result = sanitizeContext({ email: 'ali.rezaei@example.com' });

    expect(JSON.stringify(result)).not.toContain('ali.rezaei@example.com');
  });

  it('4. replaces an oversized bag with a size and checksum descriptor', () => {
    // Deliberately larger than MAX_CONTEXT_BYTES (8 KiB), which is far tighter than the
    // redactor's own 100 KB default: a log context is ids, not a payload.
    //
    // Spaces are required in the filler. Without them the string is pure base64 alphabet with
    // a length divisible by four, so the redactor's binary heuristic replaces it with
    // `[REDACTED_BINARY]` and the result is never oversized — the same caveat the existing
    // `audit-redactor.spec.ts` documents.
    const result = sanitizeContext({ note: 'x y '.repeat(MAX_CONTEXT_BYTES) }) as Record<
      string,
      unknown
    >;

    expect(result.__truncated).toBe(true);
    expect(typeof result.checksum).toBe('string');
    expect(Number(result.size)).toBeGreaterThan(MAX_CONTEXT_BYTES);
  });

  it('4b. redacts a long base64 blob as binary rather than storing it', () => {
    // The other half of the same behaviour: an embedded attachment or key blob is replaced by
    // a marker, so a log context cannot become a covert file store.
    const blob = Buffer.from('z'.repeat(4096)).toString('base64');
    const result = sanitizeContext({ attachment: blob }) as Record<string, unknown>;

    expect(result.attachment).toBe('[REDACTED_BINARY]');
  });

  it('5. truncates to the column width instead of overflowing it', () => {
    // A VarChar(80) overflow is a Postgres 22001, which fails the INSERT — so an
    // over-long messageCode would lose the entire log row, not just the long field.
    expect(clampText('y'.repeat(500), 80)).toHaveLength(80);
    expect(clampText('   ', 80)).toBeNull();
    expect(clampText(undefined, 80)).toBeNull();
  });

  it('6. masks the attempted login identifier', () => {
    const masked = maskIdentifier('ali.rezaei@example.com');

    expect(masked).not.toBe('ali.rezaei@example.com');
    expect(masked).toContain('***');
    // The domain survives: "which tenant is being probed" stays answerable.
    expect(masked).toContain('@example.com');
  });

  it('7. masks stably, so grouping survives, and hides a non-email identifier entirely', () => {
    // Same input, same mask: "twelve failed logins for one account" remains countable.
    expect(maskIdentifier('ali@example.com')).toBe(maskIdentifier('ali@example.com'));

    // A non-email identifier could be anything a person typed — including their password in
    // the username box — so only the first character and the length survive.
    const masked = maskIdentifier('SuperSecret123!');
    expect(masked).toBe('S***(15)');
    expect(masked).not.toContain('uperSecret');
  });

  it('8. survives a thrown non-Error without crashing', () => {
    // JavaScript can throw anything. A logger that assumes `Error` throws inside the error
    // path, which is the worst possible place for a second failure.
    expect(normalizeError('plain string failure')).toEqual({
      errorName: 'Error',
      errorMessage: 'plain string failure',
      errorStack: null,
    });
    expect(normalizeError(undefined)).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: null,
    });
    expect(normalizeError(42).errorName).toBe('UnknownError');
  });

  it('9. redacts an error-like object that carries credentials', () => {
    // A rejected HTTP response object routinely carries headers and tokens. Serialising it
    // verbatim into `errorMessage` would persist them.
    const rejection = {
      status: 401,
      headers: { authorization: 'Bearer eyJhbGciOi.leaked' },
      config: { password: 'hunter2' },
    };

    const normalized = normalizeError(rejection);

    expect(normalized.errorMessage).not.toContain('hunter2');
    expect(normalized.errorMessage).not.toContain('eyJhbGciOi.leaked');
  });

  it('10. takes correlation ids from the ambient context, not from a caller', () => {
    RequestContextService.set({
      requestId: 'req-123',
      correlationId: 'corr-456',
      startTime: Date.now(),
    });

    const correlation = resolveCorrelation();

    expect(correlation.requestId).toBe('req-123');
    expect(correlation.correlationId).toBe('corr-456');
    // OTel is off unless OTEL_ENABLED=true, so there is legitimately no active span here.
    expect(correlation.traceId).toBeNull();
  });

  it('10b. falls back to requestId when no upstream correlation id exists', () => {
    RequestContextService.set({
      requestId: 'req-only',
      correlationId: '',
      startTime: Date.now(),
    });

    // A row must always be joinable to its request, even with no inbound correlation header.
    expect(resolveCorrelation().correlationId).toBe('req-only');
  });

  it('11. does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => sanitizeContext(circular)).not.toThrow();
  });

  it('12. returns null for absent or empty context', () => {
    // NULL, not `{}`: a row with no context must be distinguishable from one whose context
    // was dropped, otherwise "the caller passed nothing" and "we discarded it" look alike.
    expect(sanitizeContext(null)).toBeNull();
    expect(sanitizeContext(undefined)).toBeNull();
    expect(sanitizeContext({})).toBeNull();
  });
});
