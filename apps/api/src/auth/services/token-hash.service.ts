import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';

/**
 * The number of digits in a password-reset code.
 *
 * SIX is the product decision (the shape every bank/OTP mail uses) and it is the reason the
 * rest of this flow exists: a six-digit secret is only safe when it is SHORT-LIVED,
 * SINGLE-USE, SALTED WITH THE ACCOUNT and capped by an attempt counter. Those four rules are
 * stated where each one lives — `AuthService` for the lifetime and the cap, this service for
 * the digest, and the `PasswordReset` model for the storage.
 */
export const PASSWORD_RESET_CODE_DIGITS = 6;

/**
 * The process-level pepper mixed into a password-reset code digest.
 *
 * WHY A PEPPER AT ALL. A six-digit code has only a million values, so a digest of the code
 * ALONE could be reversed offline in seconds by anyone holding a database dump. Mixing in a
 * secret that lives in the process environment (never in the database) means a leaked table
 * is not a leaked code. `AUTH_CODE_PEPPER` exists so a deployment can rotate this
 * independently of session signing; `JWT_SECRET` is the fallback because it is already a
 * required, non-trivial process secret in every environment (`env.validation.ts`).
 */
export function passwordResetCodePepper(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTH_CODE_PEPPER?.trim() || env.JWT_SECRET?.trim() || '';
}

/**
 * TokenHashService manages secure token generation and validation
 * Used for refresh tokens and temporary tokens (password reset, email verification)
 *
 * Security:
 * - Tokens are 24-byte random values (48 hex characters)
 * - Stored as SHA-256 hash in database
 * - Comparison uses hash-based validation (not plaintext)
 * - Prevents token compromise if database is breached
 *
 * PHASE PASSWORD-RESET-CODE adds the second kind of secret this platform hands out: a
 * six-digit CODE the user transcribes from an email. It is generated with `randomInt`
 * (uniform over 00–99 per digit — `randomBytes() % 10` would bias the first digits) and
 * digested with the account id AND the process pepper, which is what keeps a leaked
 * `PasswordReset` table from being brute-forced offline.
 */
@Injectable()
export class TokenHashService {
  private readonly logger = new Logger(TokenHashService.name);

  constructor() {
    if (!passwordResetCodePepper()) {
      // Not fatal, and not silent: without a pepper the digest is still deterministic, but a
      // leaked table could be reversed. Every real environment sets JWT_SECRET.
      this.logger.warn(
        'Neither AUTH_CODE_PEPPER nor JWT_SECRET is set: password-reset code digests carry no pepper'
      );
    }
  }

  /**
   * Generate a secure random token (24 bytes = 48 hex chars)
   * Used for refresh tokens, password reset, email verification
   */
  generateToken(bytes: number = 24): string {
    return randomBytes(bytes).toString('hex');
  }

  /**
   * Generate a uniformly random NUMERIC code — the password-reset credential.
   *
   * `crypto.randomInt` is the only correct primitive here: it rejects sampling bias, so
   * every six-digit value (including leading zeros) is equally likely. A code is returned as
   * a STRING so a leading zero survives JSON, an email body and the user's typing.
   */
  generateNumericCode(digits: number = PASSWORD_RESET_CODE_DIGITS): string {
    let code = '';
    for (let index = 0; index < digits; index += 1) {
      code += randomInt(0, 10).toString();
    }
    return code;
  }

  /**
   * Hash a token for storage in database
   * Uses SHA-256 for fast, non-reversible hashing
   * NOT using bcryptjs here because we need deterministic hashing for comparison
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * The stored digest of a password-reset CODE.
   *
   * Deterministic on purpose: the reset path looks the pending row up by account and then
   * compares digests, which is why the account id can be part of the input (it also keeps
   * two accounts that happen to receive the same six digits from colliding on the unique
   * column). The pepper is the part that must never reach the database.
   */
  hashPasswordResetCode(code: string, userId: string): string {
    return createHash('sha256')
      .update(`aria.password-reset-code:${code}:${userId}:${passwordResetCodePepper()}`)
      .digest('hex');
  }

  /**
   * Validate token by comparing with stored hash
   * @param plainToken Raw token from user request
   * @param hashedToken Stored hash from database
   */
  validateToken(plainToken: string, hashedToken: string): boolean {
    const hash = this.hashToken(plainToken);
    return hash === hashedToken;
  }

  /**
   * Generate expiration timestamp (milliseconds from now)
   * @param expirationMinutes Minutes from now
   */
  getExpirationTime(expirationMinutes: number): Date {
    return new Date(Date.now() + expirationMinutes * 60 * 1000);
  }
}
