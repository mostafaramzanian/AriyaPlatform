import { BadRequestException } from '@nestjs/common';
import {
  buildIntegrationUrl,
  evaluateIntegrationUrl,
  privateTargetsAllowed,
  type UrlPolicyResult,
} from '../integrations/integration-url.guard';
import type { ModuleDeploymentModeValue } from './module.contract';

/**
 * Phase 49M §40: SSRF protection for module endpoints.
 *
 * THIS FILE IS DELIBERATELY THIN, AND THAT IS THE DESIGN DECISION
 * --------------------------------------------------------------
 * 49L already built the endpoint policy: `integration-url.guard.ts` refuses non-HTTP(S)
 * schemes, credentials-in-URL, cloud metadata addresses, this process's OWN
 * infrastructure endpoints (derived from REDIS_URL / RABBITMQ_URL / MINIO_* /
 * *_DATABASE_URL) and — unless a deployment opts in via
 * `INTEGRATION_ALLOW_PRIVATE_TARGETS` — private, loopback and link-local literals. It
 * also resolves a path against an origin and refuses any path that changes the
 * authority.
 *
 * Re-implementing that here would create a SECOND place where "what may Aria connect
 * to?" is decided, and the two would drift — the first time somebody adds a blocked
 * range to one of them. §4 says do not duplicate an existing mechanism; this module
 * therefore REUSES the 49L guard outright and adds exactly one rule 49L had no reason to
 * express: a deployment-mode-dependent transport requirement.
 *
 * THE ONE ADDITIONAL RULE
 * -----------------------
 * A REMOTE, CENTRAL or HYBRID instance must be reachable over HTTPS, and must not be a
 * private/loopback literal even when the env flag allows one. A LOCAL instance may use
 * plain HTTP against a private address, because that IS the local topology (the compose
 * network, or a module on the developer's own machine).
 *
 * Note what this is NOT: it is not `if (module === 'finance') require HTTPS`. The rule
 * reads a DEPLOYMENT property, in the transport layer, and applies uniformly to every
 * module — precisely the separation §35 demands. Nothing in this file can name a
 * business module, because nothing in it takes a `moduleId`.
 *
 * WHAT REMAINS UNSOLVED, STATED HONESTLY: the same DNS-rebinding gap 49L documents. This
 * guard inspects literals and schemes; a hostname is re-resolved by `fetch`, so a
 * rebinding attacker can still win the race. Pinning the resolved address into the
 * socket is what would close it, and Node's `fetch` does not expose that. Recorded as a
 * deferred item rather than papered over.
 */

/** Modes whose transport leaves this host and therefore requires HTTPS. */
const OFF_HOST_MODES: readonly ModuleDeploymentModeValue[] = ['REMOTE', 'CENTRAL', 'HYBRID'];

/** True when this deployment mode implies a network hop off this host. */
export function isOffHost(mode: ModuleDeploymentModeValue): boolean {
  return OFF_HOST_MODES.includes(mode);
}

export interface ModuleUrlPolicyResult extends Omit<UrlPolicyResult, 'errorCode'> {
  /** 49L's codes, plus the three that are specific to module transport. */
  errorCode?:
    | UrlPolicyResult['errorCode']
    | 'INSECURE_REMOTE'
    | 'PRIVATE_REMOTE'
    | 'REQUIRED';
}

/**
 * Evaluates a candidate module endpoint for a given deployment mode.
 *
 * ORDER MATTERS AND IS CHEAPEST-FIRST: presence, then the shared 49L policy (pure
 * string/IP work), then the two mode-specific rules. The 49L policy runs BEFORE the HTTPS
 * check so a `file://` or an infrastructure endpoint is reported as such rather than as
 * "not HTTPS", which would send an operator looking for a certificate problem that does
 * not exist.
 */
export function evaluateModuleEndpoint(
  raw: string | null | undefined,
  mode: ModuleDeploymentModeValue,
): ModuleUrlPolicyResult {
  // A LOCAL instance may legitimately have no endpoint at all (in-process transport).
  if (!raw) {
    if (mode === 'LOCAL') return { ok: true };

    return {
      ok: false,
      errorCode: 'REQUIRED',
      message: 'برای استقرار غیرمحلی، نشانی سرویس ماژول الزامی است.',
    };
  }

  const shared = evaluateIntegrationUrl(raw);
  if (!shared.ok) return shared;

  if (!isOffHost(mode)) return { ok: true };

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    // Unreachable in practice — `evaluateIntegrationUrl` already parsed it — but a second
    // parse must not throw out of a policy function.
    return { ok: false, errorCode: 'MALFORMED', message: 'نشانی وارد‌شده معتبر نیست.' };
  }

  // §26: HTTPS for anything off this host. A signed request still crosses an untrusted
  // network in plaintext over HTTP, and the tenant/actor context travels with it.
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      errorCode: 'INSECURE_REMOTE',
      message: 'ماژول‌های غیرمحلی باید از https استفاده کنند.',
    };
  }

  // A loopback or private literal claiming to be REMOTE is a misconfiguration at best: it
  // is by definition on this host or this network, so the mode is wrong. Refused even when
  // `INTEGRATION_ALLOW_PRIVATE_TARGETS` is set, because that flag exists to make LOCAL
  // development possible, not to let a remote registration point inward.
  if (privateTargetsAllowed() && probePrivateLiteral(url.hostname)) {
    return {
      ok: false,
      errorCode: 'PRIVATE_REMOTE',
      message: 'نشانی داخلی نمی‌تواند به‌عنوان ماژول غیرمحلی ثبت شود.',
    };
  }

  return { ok: true };
}

/**
 * True when the host is a private/loopback literal.
 *
 * Implemented by ASKING THE 49L GUARD rather than by re-listing CIDR ranges: the probe
 * evaluates the host with the allow-private flag temporarily unset, so whatever 49L
 * considers private is what this considers private — permanently, and without a second
 * copy of the ranges. The env var is restored in a `finally`, so a throw cannot leave the
 * process with an altered policy.
 */
function probePrivateLiteral(hostname: string): boolean {
  const VAR = 'INTEGRATION_ALLOW_PRIVATE_TARGETS';
  const saved = process.env[VAR];

  try {
    delete process.env[VAR];
    const probe = evaluateIntegrationUrl(`https://${hostname}`);
    return !probe.ok && probe.errorCode === 'PRIVATE_BLOCKED';
  } finally {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  }
}

/** Throwing wrapper for the write paths (registration and admin update). */
export function assertModuleEndpointAllowed(
  raw: string | null | undefined,
  mode: ModuleDeploymentModeValue,
): void {
  const result = evaluateModuleEndpoint(raw, mode);

  if (!result.ok) {
    throw new BadRequestException(result.message ?? 'نشانی وارد‌شده مجاز نیست.');
  }
}

/**
 * Builds an absolute module URL from a stored origin and a path.
 *
 * Delegates to 49L's `buildIntegrationUrl`, which resolves the path against the origin
 * and REFUSES any result whose origin changed — so a stored `healthPath` of
 * `//evil.example/x` or `http://redis:6379/` cannot replace the authority. That is the
 * only reason origin and path are stored separately.
 */
export function buildModuleUrl(baseUrl: string, path: string): string {
  return buildIntegrationUrl(baseUrl, path);
}

