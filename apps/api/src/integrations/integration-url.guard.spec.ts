import { BadRequestException } from '@nestjs/common';
import {
  ALLOW_PRIVATE_ENV_VAR,
  assertIntegrationUrlAllowed,
  buildIntegrationUrl,
  evaluateIntegrationUrl,
  privateTargetsAllowed,
} from './integration-url.guard';

/**
 * Phase 49L §30: SSRF protection.
 *
 * THE THREAT THIS FILE ENCODES: the API process runs inside a compose network with
 * reachable, unauthenticated neighbours — `redis:6379`, `rabbitmq:5672`,
 * `minio:9000`, `postgres:5432` — and, in a hosted deployment, a metadata endpoint on
 * 169.254.169.254. A configuration field that accepts any URL turns the process into a
 * confused deputy. Every case below is one of those addresses or a way of writing one.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: DNS-based bypass. A hostname resolving to
 * 127.0.0.1 is NOT blocked, because the guard performs no resolution — see the module
 * comment. The test at the end states that limitation explicitly rather than leaving a
 * reader to assume coverage that does not exist.
 */

const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env[ALLOW_PRIVATE_ENV_VAR];
  } else {
    process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
  }
});

const denyPrivate = () => {
  delete process.env[ALLOW_PRIVATE_ENV_VAR];
};

const allowPrivate = () => {
  process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';
};

describe('privateTargetsAllowed', () => {
  it('defaults to FALSE when the variable is unset', () => {
    denyPrivate();
    expect(privateTargetsAllowed()).toBe(false);
  });

  it('accepts only `true` and `1`, so a typo means "denied" rather than "allowed"', () => {
    for (const value of ['true', '1']) {
      process.env[ALLOW_PRIVATE_ENV_VAR] = value;
      expect(privateTargetsAllowed()).toBe(true);
    }

    for (const value of ['TRUE', 'yes', 'on', '', 'false', '0']) {
      process.env[ALLOW_PRIVATE_ENV_VAR] = value;
      expect(privateTargetsAllowed()).toBe(false);
    }
  });

  it('is read PER CALL, so flipping the flag takes effect without a restart', () => {
    denyPrivate();
    expect(evaluateIntegrationUrl('http://127.0.0.1:5678').ok).toBe(false);

    allowPrivate();
    expect(evaluateIntegrationUrl('http://127.0.0.1:5678').ok).toBe(true);
  });
});

describe('evaluateIntegrationUrl — schemes', () => {
  it('accepts http and https', () => {
    expect(evaluateIntegrationUrl('http://n8n.example.com').ok).toBe(true);
    expect(evaluateIntegrationUrl('https://n8n.example.com').ok).toBe(true);
  });

  it('rejects every other scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
      'data:text/plain,hello',
      'ws://example.com',
      'redis://redis:6379',
      'javascript:alert(1)',
    ]) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('SCHEME');
    }
  });

  it('rejects a non-URL string as MALFORMED, not as a pass', () => {
    for (const url of ['', 'not a url', '//example.com', 'example.com']) {
      expect(evaluateIntegrationUrl(url).ok).toBe(false);
    }
  });

  it('rejects credentials embedded in the URL', () => {
    // They would be sent on every dispatch and would appear in any log line that
    // printed the target.
    expect(evaluateIntegrationUrl('http://user:pass@n8n.example.com').errorCode).toBe(
      'CREDENTIALS',
    );
    expect(evaluateIntegrationUrl('http://user@n8n.example.com').errorCode).toBe('CREDENTIALS');
  });
});

describe('evaluateIntegrationUrl — private and loopback targets', () => {
  beforeEach(denyPrivate);

  it('blocks loopback in every spelling', () => {
    for (const url of [
      'http://localhost:5678',
      'http://LOCALHOST:5678',
      'http://localhost.localdomain',
      'http://127.0.0.1:5678',
      'http://127.1.2.3',
      'http://[::1]:5678',
      'http://0.0.0.0',
    ]) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('PRIVATE_BLOCKED');
    }
  });

  it('blocks every RFC 1918 range and CGNAT', () => {
    for (const url of [
      'http://10.0.0.5',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://192.168.1.10',
      'http://100.64.0.1',
    ]) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('PRIVATE_BLOCKED');
    }
  });

  it('does NOT block 172.15 or 172.32 — the /12 boundary is exact', () => {
    // An off-by-one here would either block legitimate public space or admit private
    // space, so both edges are asserted rather than assumed.
    expect(evaluateIntegrationUrl('http://172.15.0.1').ok).toBe(true);
    expect(evaluateIntegrationUrl('http://172.32.0.1').ok).toBe(true);
  });

  it('blocks IPv6 link-local and unique-local', () => {
    for (const url of ['http://[fe80::1]', 'http://[fc00::1]', 'http://[fd12:3456::1]']) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('PRIVATE_BLOCKED');
    }
  });

  it('blocks an IPv4-mapped IPv6 private address', () => {
    // `::ffff:10.0.0.1` is 10.0.0.1. Judging it by its textual prefix alone would let
    // this through.
    expect(evaluateIntegrationUrl('http://[::ffff:10.0.0.1]').errorCode).toBe('PRIVATE_BLOCKED');
  });

  it('blocks cloud metadata endpoints EVEN WHEN private targets are allowed', () => {
    allowPrivate();

    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('METADATA_BLOCKED');
    }
  });

  it('allows a public host without the flag', () => {
    expect(evaluateIntegrationUrl('https://automation.example.com/webhook').ok).toBe(true);
  });

  it('allows private targets once the deployment opts in — the local n8n case', () => {
    allowPrivate();

    for (const url of ['http://localhost:5678', 'http://n8n:5678', 'http://192.168.1.50:5678']) {
      expect(evaluateIntegrationUrl(url).ok).toBe(true);
    }
  });

  it('does NOT resolve DNS, so a hostname pointing at loopback is not caught', () => {
    // STATED, NOT HIDDEN. `evaluateIntegrationUrl` inspects literals only; pinning a
    // resolved address into the socket is not expressible with Node's `fetch`, so DNS
    // rebinding remains a deferred item in the closure report. `localtest.me` resolves
    // to 127.0.0.1 in the real world and passes here.
    expect(evaluateIntegrationUrl('http://localtest.me:5678').ok).toBe(true);
  });
});

describe('evaluateIntegrationUrl — this process\'s own infrastructure', () => {
  const ORIGINALS = {
    REDIS_URL: process.env.REDIS_URL,
    RABBITMQ_URL: process.env.RABBITMQ_URL,
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
    CORE_DATABASE_URL: process.env.CORE_DATABASE_URL,
  };

  beforeEach(() => {
    // The private-address flag is ON, which is the LOCAL DEVELOPMENT configuration and
    // therefore the case that matters: without the infrastructure check these container
    // hostnames would all be accepted, because nothing here resolves DNS.
    allowPrivate();

    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.RABBITMQ_URL = 'amqp://aria:aria_password@rabbitmq:5672';
    process.env.MINIO_ENDPOINT = 'http://minio:9000';
    process.env.CORE_DATABASE_URL = 'postgresql://aria_user:pw@postgres:5432/core_db';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINALS)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses the endpoints this process holds credentials for', () => {
    // THE confused-deputy case: an administrator-configurable URL pointed at a service
    // inside the network that requires no authentication from inside it.
    for (const url of [
      'http://redis:6379',
      'http://rabbitmq:5672/api',
      'http://minio:9000/aria-erp',
      'http://postgres:5432',
    ]) {
      expect(evaluateIntegrationUrl(url).errorCode).toBe('INFRASTRUCTURE_BLOCKED');
    }
  });

  it('matches on HOST AND PORT, so the same host on another port stays configurable', () => {
    // An n8n sharing a host with Postgres is a legitimate deployment; blocking the whole
    // host would be over-broad.
    expect(evaluateIntegrationUrl('http://postgres:5678').ok).toBe(true);
    expect(evaluateIntegrationUrl('http://redis:5678').ok).toBe(true);
  });

  it('fills in the default port, so `redis://redis` and `redis://redis:6379` agree', () => {
    process.env.REDIS_URL = 'redis://redis';
    expect(evaluateIntegrationUrl('http://redis:6379').errorCode).toBe('INFRASTRUCTURE_BLOCKED');
  });

  it('is derived from configuration, not hard-coded service names', () => {
    // Repointing Redis moves the block with it, and the old name becomes allowable.
    process.env.REDIS_URL = 'redis://cache.internal:6380';

    expect(evaluateIntegrationUrl('http://cache.internal:6380').errorCode).toBe(
      'INFRASTRUCTURE_BLOCKED',
    );
    expect(evaluateIntegrationUrl('http://redis:6379').ok).toBe(true);
  });

  it('does not throw when an infrastructure URL is malformed', () => {
    process.env.REDIS_URL = 'not a url';
    expect(() => evaluateIntegrationUrl('https://automation.example.com')).not.toThrow();
    expect(evaluateIntegrationUrl('https://automation.example.com').ok).toBe(true);
  });

  it('does not echo the rejected host in the message', () => {
    const result = evaluateIntegrationUrl('http://redis:6379');
    expect(result.message).not.toContain('redis');
    expect(result.message).not.toContain('6379');
  });
});

describe('assertIntegrationUrlAllowed', () => {
  beforeEach(denyPrivate);

  it('throws BadRequest for a refused URL and returns silently for an allowed one', () => {
    expect(() => assertIntegrationUrlAllowed('http://127.0.0.1')).toThrow(BadRequestException);
    expect(() => assertIntegrationUrlAllowed('file:///etc/passwd')).toThrow(BadRequestException);
    expect(() => assertIntegrationUrlAllowed('https://automation.example.com')).not.toThrow();
  });

  it('does not echo the rejected URL back in the message', () => {
    // An error message that quoted the URL would end up in logs and in the admin UI.
    try {
      assertIntegrationUrlAllowed('http://10.1.2.3:9999/secret-path');
      fail('expected a rejection');
    } catch (err) {
      expect((err as Error).message).not.toContain('10.1.2.3');
      expect((err as Error).message).not.toContain('secret-path');
    }
  });
});

describe('buildIntegrationUrl', () => {
  it('joins an origin and a root-relative path', () => {
    expect(buildIntegrationUrl('http://n8n:5678', '/webhook/aria')).toBe(
      'http://n8n:5678/webhook/aria',
    );
  });

  it('preserves a base path on the origin', () => {
    expect(buildIntegrationUrl('http://n8n:5678/base/', 'hook')).toBe('http://n8n:5678/base/hook');
  });

  it('REFUSES a path that would change the authority', () => {
    // THE reason baseUrl and webhookPath are stored separately. Each of these would
    // otherwise silently retarget the dispatch at a different host — including one
    // inside the compose network that the origin check already approved.
    for (const path of [
      'http://redis:6379/',
      'https://evil.example/steal',
      '//evil.example/steal',
    ]) {
      expect(() => buildIntegrationUrl('http://n8n:5678', path)).toThrow(BadRequestException);
    }
  });

  it('allows traversal within the same origin, because it cannot escape it', () => {
    // `..` is not a security boundary here: the origin is unchanged, and n8n owns its
    // own routing. Refusing it would break legitimate relative paths.
    expect(buildIntegrationUrl('http://n8n:5678/a/b', '../c')).toBe('http://n8n:5678/c');
  });
});

