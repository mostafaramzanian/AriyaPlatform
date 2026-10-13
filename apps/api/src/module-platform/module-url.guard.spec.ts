import { BadRequestException } from '@nestjs/common';
import {
  assertModuleEndpointAllowed,
  buildModuleUrl,
  evaluateModuleEndpoint,
  isOffHost,
} from './module-url.guard';
import { ALLOW_PRIVATE_ENV_VAR } from '../integrations/integration-url.guard';

/**
 * Phase 49M §40: endpoint policy for module transport.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - THE 49L POLICY STILL APPLIES, UNCHANGED. Schemes, credentials-in-URL, metadata addresses and
 *    this process's own infrastructure endpoints are all still refused — asserted here so a future
 *    change to the shared guard cannot silently loosen module registration.
 *  - OFF-HOST MEANS HTTPS. A REMOTE/CENTRAL/HYBRID endpoint on plain HTTP is refused even though
 *    49L would allow it, because a signed request still crosses an untrusted network in plaintext.
 *  - A PRIVATE ADDRESS CANNOT MASQUERADE AS REMOTE, even with the dev flag on. That flag exists to
 *    make LOCAL development possible, not to let a remote registration point back inward.
 *  - LOCAL IS STILL USABLE. The whole phase would be untestable if loopback were banned outright,
 *    so LOCAL keeps 49L's behaviour exactly.
 *  - THE ENV FLAG IS RESTORED. The private-literal probe temporarily clears the variable; a leak
 *    would change global policy for every later test in the run, so it is asserted directly.
 */

const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[ALLOW_PRIVATE_ENV_VAR];
  else process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
});

describe('isOffHost', () => {
  it('treats every non-LOCAL mode as leaving this host', () => {
    expect(isOffHost('LOCAL')).toBe(false);
    expect(isOffHost('REMOTE')).toBe(true);
    expect(isOffHost('CENTRAL')).toBe(true);
    // HYBRID counts as off-host: part of it is elsewhere, and the transport policy must assume the
    // part it is talking to might be.
    expect(isOffHost('HYBRID')).toBe(true);
  });
});

describe('evaluateModuleEndpoint — presence', () => {
  it('allows a LOCAL instance with no endpoint at all', () => {
    // An in-process module has no URL, and inventing `http://localhost` for it would be a lie.
    expect(evaluateModuleEndpoint(null, 'LOCAL')).toEqual({ ok: true });
    expect(evaluateModuleEndpoint(undefined, 'LOCAL')).toEqual({ ok: true });
  });

  it('requires an endpoint for every off-host mode', () => {
    for (const mode of ['REMOTE', 'CENTRAL', 'HYBRID'] as const) {
      const result = evaluateModuleEndpoint(null, mode);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('REQUIRED');
    }
  });
});

describe('evaluateModuleEndpoint — inherited 49L policy', () => {
  it('refuses a non-HTTP(S) scheme', () => {
    expect(evaluateModuleEndpoint('file:///etc/passwd', 'LOCAL').errorCode).toBe('SCHEME');
    expect(evaluateModuleEndpoint('gopher://x.example', 'REMOTE').errorCode).toBe('SCHEME');
  });

  it('refuses credentials embedded in the URL', () => {
    // They would be sent on every call and would land in any log line that printed the target.
    expect(evaluateModuleEndpoint('https://user:pass@finance.example', 'REMOTE').errorCode).toBe(
      'CREDENTIALS',
    );
  });

  it('refuses cloud metadata addresses regardless of mode or flag', () => {
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

    expect(evaluateModuleEndpoint('http://169.254.169.254/', 'LOCAL').errorCode).toBe(
      'METADATA_BLOCKED',
    );
    expect(evaluateModuleEndpoint('https://metadata.google.internal/', 'REMOTE').errorCode).toBe(
      'METADATA_BLOCKED',
    );
  });

  it('refuses a malformed URL', () => {
    expect(evaluateModuleEndpoint('not a url', 'LOCAL').errorCode).toBe('MALFORMED');
  });
});

describe('evaluateModuleEndpoint — the transport rule 49M adds', () => {
  it('requires HTTPS for an off-host module', () => {
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';

    for (const mode of ['REMOTE', 'CENTRAL', 'HYBRID'] as const) {
      const result = evaluateModuleEndpoint('http://finance.example.com', mode);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('INSECURE_REMOTE');
    }
  });

  it('accepts HTTPS for an off-host module', () => {
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';

    expect(evaluateModuleEndpoint('https://finance.example.com', 'REMOTE')).toEqual({ ok: true });
    expect(evaluateModuleEndpoint('https://central.example.com:8443', 'CENTRAL')).toEqual({
      ok: true,
    });
  });

  it('still allows plain HTTP for a LOCAL module', () => {
    // The local topology IS plain HTTP over loopback or a compose network. Requiring HTTPS here
    // would make the phase untestable without a certificate authority.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

    expect(evaluateModuleEndpoint('http://localhost:5010', 'LOCAL')).toEqual({ ok: true });
    expect(evaluateModuleEndpoint('http://module-under-test:5010', 'LOCAL')).toEqual({ ok: true });
  });

  it('refuses a PRIVATE LITERAL claiming to be off-host, even with the dev flag on', () => {
    // The flag exists to make LOCAL development possible. A loopback address registered as REMOTE
    // is a misconfiguration at best and an inward-pointing registration at worst.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.10', '[::1]']) {
      const result = evaluateModuleEndpoint(`https://${host}:8443`, 'REMOTE');

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('PRIVATE_REMOTE');
    }
  });

  it('refuses a private literal registered as off-host when the flag is OFF too', () => {
    // With the flag off, 49L's own PRIVATE_BLOCKED fires first. Either code is a refusal; what
    // must never happen is acceptance.
    delete process.env[ALLOW_PRIVATE_ENV_VAR];

    const result = evaluateModuleEndpoint('https://127.0.0.1:8443', 'REMOTE');

    expect(result.ok).toBe(false);
    expect(['PRIVATE_BLOCKED', 'PRIVATE_REMOTE']).toContain(result.errorCode);
  });

  it('allows a PUBLIC hostname as off-host with the dev flag on', () => {
    // The probe must not accidentally classify every host as private when the flag is set.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

    expect(evaluateModuleEndpoint('https://finance.example.com', 'REMOTE')).toEqual({ ok: true });
  });

  it('restores the env flag after probing', () => {
    // The probe clears the variable temporarily. A leak would silently change policy for every
    // later call in the process.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

    evaluateModuleEndpoint('https://finance.example.com', 'REMOTE');

    expect(process.env[ALLOW_PRIVATE_ENV_VAR]).toBe('true');
  });
});

describe('assertModuleEndpointAllowed', () => {
  it('throws a BadRequest for a rejected endpoint', () => {
    expect(() => assertModuleEndpointAllowed('http://finance.example.com', 'REMOTE')).toThrow(
      BadRequestException,
    );
  });

  it('is silent for an allowed endpoint', () => {
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';

    expect(() => assertModuleEndpointAllowed('https://finance.example.com', 'REMOTE')).not.toThrow();
  });
});

describe('buildModuleUrl', () => {
  it('resolves a relative path against the origin', () => {
    expect(buildModuleUrl('https://finance.example.com', '/health')).toBe(
      'https://finance.example.com/health',
    );
  });

  it('refuses a path that would change the authority', () => {
    // The reason origin and path are stored separately: a stored `healthPath` must not be able to
    // relocate the request.
    expect(() => buildModuleUrl('https://finance.example.com', '//evil.example/x')).toThrow(
      BadRequestException,
    );
    expect(() => buildModuleUrl('https://finance.example.com', 'http://redis:6379/')).toThrow(
      BadRequestException,
    );
  });
});

