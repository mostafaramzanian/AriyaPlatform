import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Phase 49J-0: symmetric encryption for provider credentials at rest.
 *
 * FIRST symmetric-crypto code in this repository — there was no prior helper to
 * extend, which is why this exists rather than reusing something. It is
 * deliberately small and uses only Node's `crypto`: no custom construction, no
 * hand-rolled key derivation, no third-party dependency.
 *
 * AES-256-GCM, not AES-256-CBC. GCM is authenticated: a tampered ciphertext or a
 * swapped IV fails `decrypt` loudly instead of yielding plausible garbage that
 * would then be sent to a provider as an API key. The authentication tag is
 * stored alongside the ciphertext for exactly that reason.
 *
 * A FRESH RANDOM 12-BYTE IV PER ENCRYPTION. Reusing an IV under one key is the
 * catastrophic failure mode of GCM — it leaks the XOR of plaintexts and destroys
 * authentication — so the IV is never derived from the row id, the provider name
 * or a counter. 12 bytes is GCM's native nonce width; longer nonces are re-hashed
 * internally and buy nothing.
 *
 * WHAT THIS CLASS DOES NOT DO:
 *  - It does not log plaintext, ciphertext, the key, or any fragment thereof. The
 *    only thing ever logged is whether a key was configured at boot.
 *  - It does not persist anything. Callers own storage.
 *  - It does not hold a decrypted credential in a field or cache. Each `decrypt`
 *    returns a value the caller is expected to use and drop.
 *  - It has no `isConfigured()`-style public probe that would let a route report
 *    key presence to a client.
 */

/** GCM's native nonce width. */
const IV_BYTES = 12;

/** AES-256 requires exactly 32 bytes of key material. */
const KEY_BYTES = 32;

/** The env var holding the base64 or hex master key. Runtime-only, never in git. */
const KEY_ENV_VAR = 'AI_CONFIG_ENCRYPTION_KEY';

export interface EncryptedEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
}

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);

  constructor() {
    // Warn, never throw. CryptoService is provided in modules that both AppModule
    // and CoreAppModule load, so throwing here would refuse to boot a deployment
    // that simply has not configured AI yet — the same warn-don't-fail-startup
    // rule OpenAIProvider and MinioProvider already follow. The call itself is
    // what refuses.
    if (!process.env[KEY_ENV_VAR]) {
      this.logger.warn(
        `${KEY_ENV_VAR} is not set - storing or reading AI provider credentials will fail until it is`,
      );
    }
  }

  /**
   * Encrypts one credential. Returns the three envelope parts base64-encoded,
   * which is what the `AIProviderConfig` columns hold.
   *
   * Rejects empty input: an empty API key is not a credential, and silently
   * encrypting `''` would produce a row that looks configured and fails at first
   * use.
   */
  encrypt(plaintext: string): EncryptedEnvelope {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new InternalServerErrorException('Cannot encrypt an empty credential');
    }

    const key = this.readKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  /**
   * Reverses `encrypt`. Throws — rather than returning null or a partial value —
   * on a wrong key, a tampered ciphertext, a truncated envelope or a malformed
   * tag, because every one of those means the stored credential cannot be trusted.
   *
   * The thrown message is deliberately generic and identical for all failures: a
   * message that distinguished "wrong key" from "bad tag" would be an oracle.
   */
  decrypt(envelope: EncryptedEnvelope): string {
    const { ciphertext, iv, authTag } = envelope ?? ({} as EncryptedEnvelope);

    if (!ciphertext || !iv || !authTag) {
      throw new InternalServerErrorException('Stored credential envelope is incomplete');
    }

    const key = this.readKey();

    try {
      const ivBuffer = Buffer.from(iv, 'base64');
      if (ivBuffer.length !== IV_BYTES) {
        throw new Error('iv width');
      }

      const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);
      decipher.setAuthTag(Buffer.from(authTag, 'base64'));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        // Throws if the tag does not verify. This line is the authentication.
        decipher.final(),
      ]);

      return plaintext.toString('utf8');
    } catch {
      // The caught error is NOT logged: its message can carry crypto detail, and
      // the operator-actionable fact is simply that decryption failed.
      this.logger.error('Failed to decrypt a stored AI provider credential');
      throw new InternalServerErrorException('Stored credential could not be decrypted');
    }
  }

  /**
   * Constant-time comparison, exposed because the alternative — `a === b` on
   * secrets — short-circuits on the first differing byte.
   */
  matches(a: string, b: string): boolean {
    const left = Buffer.from(a ?? '', 'utf8');
    const right = Buffer.from(b ?? '', 'utf8');

    // timingSafeEqual throws on length mismatch, and length is not secret here.
    if (left.length !== right.length) {
      return false;
    }

    return timingSafeEqual(left, right);
  }

  /**
   * Reads and validates the master key on every call rather than caching it in a
   * field, so a key supplied or rotated after boot takes effect without a
   * restart — the same call-time-read rule OpenAIProvider applies to
   * OPENAI_API_KEY.
   *
   * Accepts base64 or hex, because operators generate keys with both
   * (`openssl rand -base64 32`, `openssl rand -hex 32`). The DECODED LENGTH is
   * what is checked: a 32-character passphrase is not accepted as if it were 32
   * bytes of entropy.
   */
  private readKey(): Buffer {
    const raw = process.env[KEY_ENV_VAR];

    if (!raw) {
      throw new InternalServerErrorException(
        `${KEY_ENV_VAR} is not configured - AI provider credentials cannot be read or written`,
      );
    }

    const trimmed = raw.trim();
    const candidates: Buffer[] = [];

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      candidates.push(Buffer.from(trimmed, 'hex'));
    }

    // Buffer.from(..., 'base64') never throws; it silently ignores invalid
    // characters, so the width check below is what actually validates.
    candidates.push(Buffer.from(trimmed, 'base64'));

    const key = candidates.find((candidate) => candidate.length === KEY_BYTES);

    if (!key) {
      throw new InternalServerErrorException(
        `${KEY_ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (e.g. \`openssl rand -base64 32\`)`,
      );
    }

    return key;
  }
}

