import express from 'express';
import request from 'supertest';
import pinoHttp from 'pino-http';
import { Writable } from 'stream';
import { AUTHORIZATION_REDACT_PATHS } from './pino-config';

/**
 * The canary is generated at runtime and is not a valid credential. It is never
 * printed: assertions use boolean checks so a failure does not echo its value.
 */
const CANARY = `Bearer canary-${Date.now()}-not-a-credential`;

function captureStream(lines: string[]) {
  return new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
}

function buildApp(lines: string[]) {
  const app = express();
  app.use(pinoHttp({ level: 'info', redact: AUTHORIZATION_REDACT_PATHS }, captureStream(lines)));
  app.get('/probe', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('pino request redaction', () => {
  it('redacts a lowercase authorization header and keeps other request fields', async () => {
    const lines: string[] = [];
    await request(buildApp(lines)).get('/probe').set('authorization', CANARY).expect(200);
    const output = lines.join('\n');
    expect(output.includes(CANARY)).toBe(false);
    expect(output.includes('[REDACTED]')).toBe(true);
    expect(output.includes('/probe')).toBe(true);
  });

  it('redacts a capitalised Authorization header present on the request object', async () => {
    const lines: string[] = [];
    const app = express();
    app.use((req, _res, next) => {
      (req.headers as Record<string, string>).Authorization = CANARY;
      next();
    });
    app.use(pinoHttp({ level: 'info', redact: AUTHORIZATION_REDACT_PATHS }, captureStream(lines)));
    app.get('/probe', (_req, res) => res.status(200).json({ ok: true }));
    await request(app).get('/probe').expect(200);
    expect(lines.join('\n').includes(CANARY)).toBe(false);
  });

  it('logs requests without an authorization header', async () => {
    const lines: string[] = [];
    await request(buildApp(lines)).get('/probe').expect(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n').includes('/probe')).toBe(true);
  });

  it('does not leak a malformed authorization header value', async () => {
    const lines: string[] = [];
    await request(buildApp(lines)).get('/probe').set('authorization', `Basic ${CANARY}`).expect(200);
    expect(lines.join('\n').includes(CANARY)).toBe(false);
  });
});
