import { InternalServerErrorException } from '@nestjs/common';

/**
 * Phase AI-ARCH-HARDENING (§33): the AI execution error taxonomy.
 *
 * EVERY code below is PRODUCED by exactly one layer, which is what keeps the
 * taxonomy honest instead of aspirational:
 *
 *   CONFIGURATION_ERROR         — the resolver: a stored credential that cannot be
 *                                 decrypted, or a required credential that is absent.
 *   UNSUPPORTED_CAPABILITY      — the resolver: a stored row whose provider no
 *                                 longer declares the capability (registry matrix).
 *   SECURITY_POLICY_REJECTED    — the resolver/provider: a configured endpoint the
 *                                 endpoint policy refuses (§18).
 *   UPSTREAM_UNAVAILABLE        — the adapter: transport failure or a non-2xx answer.
 *   UPSTREAM_TIMEOUT            — the adapter: the call exceeded its bounded timeout.
 *   INVALID_PROVIDER_RESPONSE   — the adapter: an answer that is not a usable vector
 *                                 (unparseable body, wrong width, non-finite values).
 *
 * DELIBERATELY ABSENT: AUTHORIZATION_FAILURE / AUTHENTICATION_FAILURE. An upstream
 * 401/403 currently surfaces as UPSTREAM_UNAVAILABLE with the status in the
 * adapter's own structured log — the code alone is not used by any decision, and
 * inventing codes with no consumer is the thing §33 warns against.
 *
 * The class extends InternalServerErrorException so that, if a code-bearing error
 * ever escapes to HTTP without being caught, it maps to a 500 with the SAFE
 * message it was constructed with — never an upstream body, never a credential.
 */
export const AI_ERROR_CODES = {
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  SECURITY_POLICY_REJECTED: 'SECURITY_POLICY_REJECTED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  INVALID_PROVIDER_RESPONSE: 'INVALID_PROVIDER_RESPONSE',
} as const;

export type AIErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

export class AIExecutionError extends InternalServerErrorException {
  readonly code: AIErrorCode;

  constructor(code: AIErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;

    if (options?.cause !== undefined) {
      // Not a constructor option: Nest's exception signature is (message, status),
      // and the cause is diagnostic metadata that must survive `instanceof` checks
      // without becoming part of the HTTP body.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
