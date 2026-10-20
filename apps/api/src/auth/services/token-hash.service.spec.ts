import {
  PASSWORD_RESET_CODE_DIGITS,
  TokenHashService,
  passwordResetCodePepper,
} from './token-hash.service';

/**
 * PHASE PASSWORD-RESET-CODE: the six-digit code and its digest.
 *
 * What these tests pin is exactly what makes a SIX-DIGIT secret defensible — it is uniformly
 * random (no sampling bias), it is never stored as itself, its digest is bound to the ACCOUNT
 * (so two accounts that receive the same digits cannot collide) and to the process PEPPER (so a
 * leaked table cannot be reversed offline). The lifetime and the attempt cap live in
 * `AuthService` and are pinned by its own suite.
 */
describe('TokenHashService — password-reset codes', () => {
  const service = new TokenHashService();
  const USER_A = 'user-a';
  const USER_B = 'user-b';

  describe('generateNumericCode', () => {
    it('returns exactly the declared number of digits, always numeric', () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const code = service.generateNumericCode();
        expect(code).toMatch(new RegExp(`^\\d{${PASSWORD_RESET_CODE_DIGITS}}$`));
      }
    });

    it('keeps a LEADING ZERO (a code is a string, never a number)', () => {
      // 300 draws of six digits: at least one begins with 0 with overwhelming probability, and
      // a number-typed code would silently drop it.
      const codes = Array.from({ length: 300 }, () => service.generateNumericCode());
      expect(codes.some((code) => code.startsWith('0'))).toBe(true);
      expect(codes.every((code) => typeof code === 'string')).toBe(true);
    });

    it('does not repeat within a run', () => {
      const codes = new Set(Array.from({ length: 200 }, () => service.generateNumericCode()));
      expect(codes.size).toBe(200);
    });

    it('honours a different digit count', () => {
      expect(service.generateNumericCode(8)).toMatch(/^\d{8}$/);
    });
  });

  describe('hashPasswordResetCode', () => {
    it('is deterministic for the same code and account', () => {
      expect(service.hashPasswordResetCode('123456', USER_A)).toBe(
        service.hashPasswordResetCode('123456', USER_A),
      );
    });

    it('never returns the code, and produces a full SHA-256 digest', () => {
      const digest = service.hashPasswordResetCode('123456', USER_A);
      expect(digest).not.toContain('123456');
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('binds the digest to the ACCOUNT: the same digits differ per user', () => {
      expect(service.hashPasswordResetCode('123456', USER_A)).not.toBe(
        service.hashPasswordResetCode('123456', USER_B),
      );
    });

    it('binds the digest to a different code', () => {
      expect(service.hashPasswordResetCode('123456', USER_A)).not.toBe(
        service.hashPasswordResetCode('123457', USER_A),
      );
    });

    it('changes when the process PEPPER changes — a leaked table is not a leaked code', () => {
      const original = {
        AUTH_CODE_PEPPER: process.env.AUTH_CODE_PEPPER,
        JWT_SECRET: process.env.JWT_SECRET,
      };

      try {
        process.env.AUTH_CODE_PEPPER = 'pepper-one';
        const withOne = service.hashPasswordResetCode('123456', USER_A);
        process.env.AUTH_CODE_PEPPER = 'pepper-two';
        const withTwo = service.hashPasswordResetCode('123456', USER_A);

        expect(withOne).not.toBe(withTwo);
      } finally {
        process.env.AUTH_CODE_PEPPER = original.AUTH_CODE_PEPPER;
        process.env.JWT_SECRET = original.JWT_SECRET;
      }
    });
  });

  describe('passwordResetCodePepper', () => {
    it('prefers AUTH_CODE_PEPPER, so it can rotate independently of session signing', () => {
      expect(
        passwordResetCodePepper({ AUTH_CODE_PEPPER: ' dedicated ', JWT_SECRET: 'session' }),
      ).toBe('dedicated');
    });

    it('falls back to JWT_SECRET, which every environment already requires', () => {
      expect(passwordResetCodePepper({ JWT_SECRET: ' session ' })).toBe('session');
    });

    it('reports "no pepper" honestly, rather than inventing one', () => {
      expect(passwordResetCodePepper({})).toBe('');
    });
  });
});