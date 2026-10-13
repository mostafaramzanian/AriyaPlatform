/**
 * Phase 49J-0: unit coverage for credential encryption.
 *
 * These tests use a REAL key and REAL Node crypto — nothing is mocked. Mocking
 * `createCipheriv` would leave the one property that matters unverified: that a
 * tampered ciphertext is actually REJECTED rather than quietly decrypted into
 * garbage that later gets sent to a provider as an API key.
 *
 * `AI_CONFIG_ENCRYPTION_KEY` is set and restored per test, because the service
 * reads it at call time by design (rotation without restart) and a leaked value
 * would make later tests pass for the wrong reason.
 */
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { CryptoService } from './crypto.service';

/** A valid 32-byte key, base64 — the format `openssl rand -base64 32` emits. */
const validKeyB64 = randomBytes(32).toString('base64');

/** The same width in hex, the other format operators actually generate. */
const validKeyHex = randomBytes(32).toString('hex');

describe('CryptoService (49J-0 credential encryption)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Silenced deliberately: the constructor warns when no key is configured, and
    // one of the tests below exercises exactly that path.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env.AI_CONFIG_ENCRYPTION_KEY = validKeyB64;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  const service = () => new CryptoService();

  describe('round trip', () => {
    it('decrypts what it encrypted', () => {
      const svc = service();
      const secret = 'sk-proj-abc123DEF456';

      expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
    });

    it('round-trips a Persian, non-ASCII value', () => {
      // The credential column is text and the deployment is Persian; a UTF-8 bug
      // here would corrupt a key silently rather than fail loudly.
      const svc = service();
      const secret = 'کلید-آزمایشی-۱۲۳';

      expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
    });

    it('accepts a hex key as well as base64', () => {
      process.env.AI_CONFIG_ENCRYPTION_KEY = validKeyHex;
      const svc = service();

      expect(svc.decrypt(svc.encrypt('sk-hex'))).toBe('sk-hex');
    });

    it('emits base64 for all three envelope parts', () => {
      const envelope = service().encrypt('sk-test');

      // Stored in text columns, so each part must survive a text round trip.
      for (const part of [envelope.ciphertext, envelope.iv, envelope.authTag]) {
        expect(typeof part).toBe('string');
        expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      }
    });

    it('uses a fresh IV per call, so identical plaintexts differ', () => {
      // THE test for GCM misuse. Equal ciphertexts here would mean a fixed or
      // derived IV, which leaks the XOR of plaintexts and voids authentication.
      const svc = service();
      const a = svc.encrypt('same-secret');
      const b = svc.encrypt('same-secret');

      expect(a.iv).not.toEqual(b.iv);
      expect(a.ciphertext).not.toEqual(b.ciphertext);
      expect(svc.decrypt(a)).toBe(svc.decrypt(b));
    });

    it('produces a 12-byte IV', () => {
      const { iv } = service().encrypt('sk-test');

      expect(Buffer.from(iv, 'base64')).toHaveLength(12);
    });
  });

  describe('tamper detection', () => {
    it('rejects a modified authTag', () => {
      const svc = service();
      const envelope = svc.encrypt('sk-tamper');
      const tag = Buffer.from(envelope.authTag, 'base64');
      tag[0] ^= 0xff;

      expect(() => svc.decrypt({ ...envelope, authTag: tag.toString('base64') })).toThrow(
        InternalServerErrorException,
      );
    });

    it('rejects a modified ciphertext', () => {
      const svc = service();
      const envelope = svc.encrypt('sk-tamper');
      const ct = Buffer.from(envelope.ciphertext, 'base64');
      ct[0] ^= 0xff;

      expect(() => svc.decrypt({ ...envelope, ciphertext: ct.toString('base64') })).toThrow(
        InternalServerErrorException,
      );
    });

    it('rejects a swapped IV', () => {
      const svc = service();
      const envelope = svc.encrypt('sk-tamper');
      const other = svc.encrypt('sk-other');

      expect(() => svc.decrypt({ ...envelope, iv: other.iv })).toThrow(
        InternalServerErrorException,
      );
    });

    it('rejects an IV of the wrong width', () => {
      const svc = service();
      const envelope = svc.encrypt('sk-tamper');

      expect(() =>
        svc.decrypt({ ...envelope, iv: randomBytes(16).toString('base64') }),
      ).toThrow(InternalServerErrorException);
    });

    it('rejects a ciphertext encrypted under a different key', () => {
      // The rotation scenario: the stored envelope is intact, the key is not the
      // one it was written with. It must fail rather than return garbage.
      const envelope = service().encrypt('sk-rotated');
      process.env.AI_CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');

      expect(() => service().decrypt(envelope)).toThrow(InternalServerErrorException);
    });

    it.each([
      ['ciphertext', { ciphertext: '' }],
      ['iv', { iv: '' }],
      ['authTag', { authTag: '' }],
    ])('rejects an envelope missing its %s', (_label, override) => {
      const svc = service();
      const envelope = svc.encrypt('sk-partial');

      // Mirrors the DB CHECK: the three columns are all-present or all-null. A
      // partial envelope is corruption, not a decryptable value.
      expect(() => svc.decrypt({ ...envelope, ...override })).toThrow(
        InternalServerErrorException,
      );
    });

    it('gives the same message for every failure mode', () => {
      // An error that distinguished "wrong key" from "bad tag" would be an oracle.
      const svc = service();
      const envelope = svc.encrypt('sk-oracle');
      const tag = Buffer.from(envelope.authTag, 'base64');
      tag[0] ^= 0xff;

      const messages = [
        () => svc.decrypt({ ...envelope, authTag: tag.toString('base64') }),
        () => svc.decrypt({ ...envelope, iv: svc.encrypt('x').iv }),
      ].map((fn) => {
        try {
          fn();
          return 'no throw';
        } catch (err) {
          return (err as Error).message;
        }
      });

      expect(messages[0]).toBe(messages[1]);
    });
  });

  describe('key validation', () => {
    it('throws on encrypt when no key is configured', () => {
      delete process.env.AI_CONFIG_ENCRYPTION_KEY;

      expect(() => service().encrypt('sk-test')).toThrow(InternalServerErrorException);
    });

    it('throws on decrypt when no key is configured', () => {
      const envelope = service().encrypt('sk-test');
      delete process.env.AI_CONFIG_ENCRYPTION_KEY;

      expect(() => service().decrypt(envelope)).toThrow(InternalServerErrorException);
    });

    it('warns but does not throw at construction when no key is configured', () => {
      // Both AppModule and CoreAppModule load this provider, so a throwing
      // constructor would refuse to boot deployments that have not configured AI.
      delete process.env.AI_CONFIG_ENCRYPTION_KEY;

      expect(() => service()).not.toThrow();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('rejects a 32-CHARACTER passphrase', () => {
      // Decodes to ~24 bytes, not 32, and carries far less entropy than 32 random
      // bytes. Accepting it is the mistake this check exists to prevent.
      process.env.AI_CONFIG_ENCRYPTION_KEY = 'abcdefghijklmnopqrstuvwxyz123456';

      expect(() => service().encrypt('sk-test')).toThrow(InternalServerErrorException);
    });

    it.each([
      ['too short', randomBytes(16).toString('base64')],
      ['too long', randomBytes(64).toString('base64')],
      ['empty after trim', '   '],
      ['not encodable to 32 bytes', 'short'],
    ])('rejects a key that is %s', (_label, value) => {
      process.env.AI_CONFIG_ENCRYPTION_KEY = value;

      expect(() => service().encrypt('sk-test')).toThrow(InternalServerErrorException);
    });

    it('tolerates surrounding whitespace in the configured key', () => {
      // Copy-paste from a terminal routinely carries a trailing newline.
      process.env.AI_CONFIG_ENCRYPTION_KEY = `\n  ${validKeyB64}  \n`;

      expect(() => service().encrypt('sk-test')).not.toThrow();
    });

    it('reads the key on every call, so rotation needs no restart', () => {
      const svc = service();
      const first = svc.encrypt('sk-before');

      const rotated = randomBytes(32).toString('base64');
      process.env.AI_CONFIG_ENCRYPTION_KEY = rotated;

      // Same instance: new writes use the new key, old envelopes are now unreadable.
      expect(svc.decrypt(svc.encrypt('sk-after'))).toBe('sk-after');
      expect(() => svc.decrypt(first)).toThrow(InternalServerErrorException);
    });
  });

  describe('encrypt input guarding', () => {
    it.each([
      ['an empty string', ''],
      ['undefined', undefined as unknown as string],
      ['null', null as unknown as string],
      ['a non-string', 12345 as unknown as string],
    ])('refuses to encrypt %s', (_label, value) => {
      // An empty credential would produce a row that LOOKS configured and fails at
      // first provider call instead of at save time.
      expect(() => service().encrypt(value)).toThrow(InternalServerErrorException);
    });

    it('encrypts a whitespace-only value, leaving trimming to the DTO', () => {
      // Not this class's job: the DTO's trimToUndefined transform is where "blank
      // means absent" is decided, and duplicating it here would hide DTO bugs.
      const svc = service();

      expect(svc.decrypt(svc.encrypt(' '))).toBe(' ');
    });
  });

  describe('matches', () => {
    it('is true for identical strings', () => {
      expect(service().matches('sk-same', 'sk-same')).toBe(true);
    });

    it('is false for different strings of equal length', () => {
      expect(service().matches('sk-aaaa', 'sk-bbbb')).toBe(false);
    });

    it('is false — not a throw — for different lengths', () => {
      // timingSafeEqual throws on a length mismatch; length is not secret here, so
      // the comparison must degrade to false rather than propagate.
      expect(service().matches('short', 'considerably-longer')).toBe(false);
    });

    it.each([
      [undefined, undefined, true],
      ['', undefined, true],
      ['sk-a', undefined, false],
      [undefined, 'sk-a', false],
    ])('handles %s vs %s', (a, b, expected) => {
      expect(service().matches(a as string, b as string)).toBe(expected);
    });
  });

  describe('secret hygiene', () => {
    it('never logs the key, plaintext or ciphertext', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const error = jest.spyOn(Logger.prototype, 'error');
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

      const svc = service();
      const secret = 'sk-must-not-appear-anywhere';
      const envelope = svc.encrypt(secret);

      const tag = Buffer.from(envelope.authTag, 'base64');
      tag[0] ^= 0xff;
      expect(() => svc.decrypt({ ...envelope, authTag: tag.toString('base64') })).toThrow();

      const emitted = [warn, error, log, debug]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' | ');

      expect(emitted).not.toContain(secret);
      expect(emitted).not.toContain(validKeyB64);
      expect(emitted).not.toContain(envelope.ciphertext);
    });

    it('does not leak the plaintext through the thrown error', () => {
      const svc = service();
      const envelope = svc.encrypt('sk-secret-value');

      try {
        svc.decrypt({ ...envelope, iv: svc.encrypt('x').iv });
        throw new Error('expected decrypt to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain('sk-secret-value');
        expect((err as Error).message).not.toContain(validKeyB64);
      }
    });
  });
});
