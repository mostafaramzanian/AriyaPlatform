import { BadRequestException } from '@nestjs/common';
import { isIP } from 'net';

/**
 * Phase 49L §30: SSRF protection for administrator-configured endpoints.
 *
 * WHY THIS EXISTS AT ALL, GIVEN ONLY AN ADMINISTRATOR CAN SET THE URL
 * -------------------------------------------------------------------
 * Because "an administrator typed it" is not a security property. The API process
 * sits inside the compose network with reachable, UNAUTHENTICATED neighbours:
 * `redis:6379`, `rabbitmq:5672`, `minio:9000`, `postgres:5432` and — in a cloud
 * deployment — the metadata endpoints on 169.254.169.254. A configuration field
 * that accepts any URL turns this process into a confused deputy that will POST a
 * signed envelope wherever it is pointed. This module is the single place that
 * decision is made, and it is applied on WRITE and again immediately before EVERY
 * dispatch — because the policy below is environment configuration and can change
 * without the stored row changing.
 *
 * WHAT IS NOT BUILT HERE, and why
 * -------------------------------
 * There is NO DNS resolution and therefore no TOCTOU-proof pinning. Resolving a
 * hostname here and then handing the URL to `fetch` re-resolves it, so a DNS
 * rebinding attacker can still win the race; implementing real protection means
 * pinning the resolved address into the socket, which Node's `fetch` does not
 * expose. Claiming otherwise would be worse than the honest bound: this guard
 * blocks LITERAL private/loopback/link-local addresses and non-HTTP(S) schemes,
 * which is the class of mistake a configuration field actually produces. The
 * residual DNS-rebinding risk is recorded as a deferred item in the closure
 * report rather than papered over.
 *
 * LOCALHOST IS ALLOWED ONLY BY EXPLICIT OPT-IN. The realistic local topology for
 * this repository is n8n on the host or in the same compose network (§31), so a
 * blanket loopback ban would make the phase untestable.
 * `INTEGRATION_ALLOW_PRIVATE_TARGETS` defaults to FALSE — a deployment must say
 * yes — and the value is read on every call rather than cached, matching how
 * `CryptoService.readKey` and `OpenAIProvider` treat their env.
 */

/** Only these two schemes. No file:, no gopher:, no ftp:, no data:. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** The env flag that permits private/loopback destinations. Read per call. */
export const ALLOW_PRIVATE_ENV_VAR = 'INTEGRATION_ALLOW_PRIVATE_TARGETS';

/** Hostnames that always denote the local machine, whatever DNS says. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

/**
 * Cloud instance-metadata addresses. Blocked even when private targets are
 * allowed: no automation workflow has a legitimate reason to receive Aria's
 * signed envelope at a metadata endpoint, and these are the single highest-value
 * SSRF target in any hosted deployment.
 */
const ALWAYS_BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'fd00:ec2::254',
]);

/**
 * The env vars naming infrastructure THIS PROCESS holds credentials for.
 *
 * WHY THIS EXISTS ON TOP OF THE PRIVATE-ADDRESS CHECK
 * ---------------------------------------------------
 * The private-address check inspects literals. It cannot see that
 * `http://redis:6379` is a private target, because `redis` is a HOSTNAME and this
 * module deliberately performs no DNS resolution (see the note above). With
 * `INTEGRATION_ALLOW_PRIVATE_TARGETS` enabled — the normal local configuration —
 * that hostname would therefore be accepted, and Aria would happily POST a signed
 * envelope at its own Redis.
 *
 * So the second guard is DERIVED rather than resolved: whatever host:port this
 * process is configured to reach for Redis, RabbitMQ, MinIO or Postgres is
 * refused as an integration target, regardless of the private-address flag. It is
 * read from configuration rather than hard-coded, so it cannot drift when a
 * deployment renames or repoints a service, and it is narrow — the HOST AND PORT
 * must both match, so an automation engine sharing a host with Postgres on a
 * different port is still configurable.
 *
 * This is not a claim of complete SSRF protection. It closes the specific
 * confused-deputy case that matters here: pointing the integration at a service
 * whose credentials this process already holds.
 */
const INFRASTRUCTURE_ENV_VARS = [
  'REDIS_URL',
  'RABBITMQ_URL',
  'MINIO_ENDPOINT',
  'MINIO_PUBLIC_URL',
  'CORE_DATABASE_URL',
  'DATABASE_URL',
  'CMS_DATABASE_URL',
] as const;

/**
 * `host:port` pairs the process is configured to reach, read PER CALL so a
 * reconfiguration takes effect without a restart.
 *
 * Default ports are filled in per scheme, because `redis://redis` and
 * `redis://redis:6379` name the same endpoint and only one of them carries the
 * port explicitly.
 */
const DEFAULT_PORTS: Record<string, string> = {
  'redis:': '6379',
  'rediss:': '6379',
  'amqp:': '5672',
  'amqps:': '5671',
  'postgres:': '5432',
  'postgresql:': '5432',
  'http:': '80',
  'https:': '443',
};

function infrastructureEndpoints(): Set<string> {
  const endpoints = new Set<string>();

  for (const name of INFRASTRUCTURE_ENV_VARS) {
    const raw = process.env[name];
    if (!raw) continue;

    try {
      const url = new URL(raw.trim());
      const port = url.port || DEFAULT_PORTS[url.protocol] || '';
      endpoints.add(`${url.hostname.toLowerCase()}:${port}`);
    } catch {
      // A malformed infrastructure URL is somebody else's problem to report; it
      // must not make this guard throw on an unrelated integration write.
    }
  }

  return endpoints;
}


export interface UrlPolicyResult {
  ok: boolean;
  /** Short internal code, safe to log and to store in `errorCode`. */
  errorCode?:
    | 'SCHEME'
    | 'MALFORMED'
    | 'PRIVATE_BLOCKED'
    | 'METADATA_BLOCKED'
    | 'CREDENTIALS'
    | 'INFRASTRUCTURE_BLOCKED';
  /** Persian, operator-facing. Never contains the rejected URL verbatim. */
  message?: string;
}

/** True when the deployment has opted in to private/loopback destinations. */
export function privateTargetsAllowed(): boolean {
  const raw = process.env[ALLOW_PRIVATE_ENV_VAR];
  return raw === 'true' || raw === '1';
}

/** IPv4 literal inside a private, loopback, link-local or reserved range. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved

  return false;
}

/** IPv6 literal that is loopback, link-local, unique-local or IPv4-mapped-private. */
function isPrivateIPv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 unique-local

  // IPv4-MAPPED ADDRESSES MUST BE JUDGED BY THEIR EMBEDDED IPv4 ADDRESS.
  //
  // Two spellings reach here, and only handling the first is the trap: `new URL()`
  // NORMALISES `[::ffff:10.0.0.1]` to `::ffff:a00:1`, so the dotted-quad form is what a
  // human types and the hex form is what the parser actually hands us. Checking only
  // the dotted form would let `http://[::ffff:10.0.0.1]` — literally 10.0.0.1 — through.
  const mappedDotted = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);

  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);

    const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return isPrivateIPv4(dotted);
  }

  return false;
}

/**
 * Evaluates one candidate origin against the policy.
 *
 * Returns a RESULT rather than throwing, because two callers need different
 * behaviour: the admin write path turns a failure into a 400, while the dispatch
 * path turns it into a FAILED execution with `errorCode = 'SSRF_BLOCKED'` and must
 * not raise inside the business operation that triggered it (§22).
 */
export function evaluateIntegrationUrl(raw: string): UrlPolicyResult {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, errorCode: 'MALFORMED', message: 'نشانی وارد‌شده معتبر نیست.' };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      errorCode: 'SCHEME',
      message: 'تنها نشانی‌های http و https پذیرفته می‌شوند.',
    };
  }

  // Credentials in the URL would be sent on every dispatch and would land in any
  // log line that printed the target. Refused rather than stripped, so the
  // operator learns the field is not an authentication mechanism.
  if (url.username || url.password) {
    return {
      ok: false,
      errorCode: 'CREDENTIALS',
      message: 'نشانی نباید شامل نام کاربری یا گذرواژه باشد.',
    };
  }

  const host = url.hostname.toLowerCase();

  if (ALWAYS_BLOCKED_HOSTS.has(host.replace(/^\[|\]$/g, ''))) {
    return { ok: false, errorCode: 'METADATA_BLOCKED', message: 'این نشانی مجاز نیست.' };
  }

  // THIS PROCESS'S OWN INFRASTRUCTURE, refused regardless of the private-address
  // flag. See the note on INFRASTRUCTURE_ENV_VARS: with private targets allowed —
  // the normal local configuration — `http://redis:6379` would otherwise pass the
  // literal check, because `redis` is a hostname and nothing here resolves DNS.
  const port = url.port || DEFAULT_PORTS[url.protocol] || '';

  if (infrastructureEndpoints().has(`${host}:${port}`)) {
    return {
      ok: false,
      errorCode: 'INFRASTRUCTURE_BLOCKED',
      message: 'نشانی سرویس‌های داخلی سامانه (پایگاه داده، صف، حافظه نهان، ذخیره‌سازی) مجاز نیست.',
    };
  }

  const bare = host.replace(/^\[|\]$/g, '');
  const isLiteralIp = isIP(bare) !== 0;
  const isPrivate =
    LOOPBACK_HOSTNAMES.has(host) ||
    (isLiteralIp && (isPrivateIPv4(bare) || isPrivateIPv6(bare)));

  if (isPrivate && !privateTargetsAllowed()) {
    return {
      ok: false,
      errorCode: 'PRIVATE_BLOCKED',
      message:
        'نشانی‌های داخلی و لوکال مجاز نیستند. برای محیط توسعه، متغیر INTEGRATION_ALLOW_PRIVATE_TARGETS را فعال کنید.',
    };
  }

  return { ok: true };
}

/** Throwing wrapper for the admin write path. */
export function assertIntegrationUrlAllowed(raw: string): void {
  const result = evaluateIntegrationUrl(raw);

  if (!result.ok) {
    throw new BadRequestException(result.message ?? 'نشانی وارد‌شده مجاز نیست.');
  }
}

/**
 * Builds the absolute dispatch URL from a stored origin and path.
 *
 * The path is resolved AGAINST the origin and then the result is re-checked, so a
 * stored `webhookPath` of `http://redis:6379/` or `//evil.example/x` cannot
 * replace the authority. That is the only reason the two are stored separately.
 */
export function buildIntegrationUrl(baseUrl: string, webhookPath: string): string {
  const origin = new URL(baseUrl);
  const resolved = new URL(webhookPath, origin);

  if (resolved.origin !== origin.origin) {
    throw new BadRequestException('مسیر وب‌هوک نمی‌تواند دامنه را تغییر دهد.');
  }

  return resolved.toString();
}

