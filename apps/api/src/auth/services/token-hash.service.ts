import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

/**
 * TokenHashService manages secure token generation and validation
 * Used for refresh tokens and temporary tokens (password reset, email verification)
 *
 * Security:
 * - Tokens are 24-byte random values (48 hex characters)
 * - Stored as SHA-256 hash in database
 * - Comparison uses hash-based validation (not plaintext)
 * - Prevents token compromise if database is breached
 */
@Injectable()
export class TokenHashService {
  /**
   * Generate a secure random token (24 bytes = 48 hex chars)
   * Used for refresh tokens, password reset, email verification
   */
  generateToken(bytes: number = 24): string {
    return randomBytes(bytes).toString('hex');
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
