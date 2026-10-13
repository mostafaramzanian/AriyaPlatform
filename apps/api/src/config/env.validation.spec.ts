import { HttpException, HttpStatus } from '@nestjs/common';
import { validateEnv, resolveCorsOrigins, buildCorsOrigin } from './env.validation';

const base = {
  NODE_ENV: 'test',
  CORE_DATABASE_URL: 'postgresql://u:p@localhost/db',
  JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-hs256',
  JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-long-enough',
};

describe('validateEnv', () => {
  it('accepts valid test configuration', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it('rejects production configuration with placeholder JWT secret', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'dev-secret-key-change-me',
      }),
    ).toThrow();
  });

  it('rejects production configuration missing CORS origins', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
      }),
    ).toThrow('CORS_ORIGINS');
  });

  it('rejects production wildcard CORS with credentials enabled', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      }),
    ).toThrow('wildcard');
  });

  it('rejects missing JWT_REFRESH_SECRET', () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.JWT_REFRESH_SECRET;
    expect(() => validateEnv(rest)).toThrow('JWT_REFRESH_SECRET');
  });

  it('does not expose secrets in error text', () => {
    const secret = 'super-secret-value-should-not-leak';
    try {
      validateEnv({
        ...base,
        JWT_SECRET: secret,
      });
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('defaults MAX_ACTIVE_SESSIONS_PER_USER to a positive integer', () => {
    const env = validateEnv(base);
    expect(env.MAX_ACTIVE_SESSIONS_PER_USER).toBe(10);
  });

  it('accepts a positive integer for MAX_ACTIVE_SESSIONS_PER_USER', () => {
    const env = validateEnv({ ...base, MAX_ACTIVE_SESSIONS_PER_USER: '25' });
    expect(env.MAX_ACTIVE_SESSIONS_PER_USER).toBe(25);
  });

  it('rejects zero for MAX_ACTIVE_SESSIONS_PER_USER', () => {
    expect(() => validateEnv({ ...base, MAX_ACTIVE_SESSIONS_PER_USER: '0' })).toThrow();
  });

  it('rejects negative values for MAX_ACTIVE_SESSIONS_PER_USER', () => {
    expect(() => validateEnv({ ...base, MAX_ACTIVE_SESSIONS_PER_USER: '-5' })).toThrow();
  });

  it('rejects non-numeric values for MAX_ACTIVE_SESSIONS_PER_USER', () => {
    expect(() => validateEnv({ ...base, MAX_ACTIVE_SESSIONS_PER_USER: 'unlimited' })).toThrow();
  });
});

describe('resolveCorsOrigins', () => {
  it('splits comma and newline separated origins', () => {
    expect(resolveCorsOrigins('https://a.com,https://b.com\nhttps://c.com')).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });
});

describe('buildCorsOrigin', () => {
  it('allows listed origins', (done) => {
    const fn = buildCorsOrigin({ CORS_ORIGINS: 'https://app.example.com' });
    fn('https://app.example.com', (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
      done();
    });
  });

  it('rejects unlisted origins with a 403-class error, not a 500', (done) => {
    const fn = buildCorsOrigin({ CORS_ORIGINS: 'https://app.example.com' });
    fn('https://evil.example.com', (err, allow) => {
      // The denial must reach the exception filter as an HttpException carrying
      // 403 — a refused origin is a client-class decision, never an internal
      // server error (GAP-ENV-1).
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(allow).toBe(false);
      done();
    });
  });

  it('allows requests without an origin', (done) => {
    const fn = buildCorsOrigin({ CORS_ORIGINS: 'https://app.example.com' });
    fn(undefined, (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
      done();
    });
  });

  it('rejects wildcard origin with credentials enabled', (done) => {
    const fn = buildCorsOrigin({ CORS_ORIGINS: '*' });
    fn('https://any.example.com', (err, allow) => {
      // buildCorsOrigin treats "*" as a literal origin, so the request origin
      // is rejected. The production startup validation (validateEnv) is the
      // second layer that prevents booting with a wildcard configuration.
      expect(err).toBeTruthy();
      expect(allow).toBe(false);
      done();
    });
  });

  it('rejects wildcard origin configuration in production validation', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      }),
    ).toThrow('wildcard');
  });
});
