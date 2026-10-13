import { isIP } from 'node:net';

/**
 * Phase AI-ARCH-HARDENING (§18): the AI endpoint policy.
 *
 * WHAT THIS POLICY IS FOR
 * -----------------------
 * `AIProviderConfig.baseUrl` is ADMIN-CONFIGURED and — since this phase — effective
 * at runtime (§13). Before it can steer a server-side request, the address has to be
 * judged as an AI endpoint address, not passed through on `@IsUrl()` alone: that
 * decorator accepts `http://user:pass@host` and `http://169.254.169.254/…`, both of
 * which are credential placement and metadata-service addresses respectively.
 *
 * THE DECISIONS, IN FULL (so "allowed external", "allowed internal local" and
 * "blocked address" are facts of the code rather than of a comment):
 *
 *   ALLOWED  external endpoints      — public address literals; any hostname.
 *   ALLOWED  internal local endpoints — private-range literals (10/8, 172.16/12,
 *                                      192.168/16, fc00::/7), loopback literals
 *                                      (127/8, ::1) and the `localhost` name. A
 *                                      self-hosted / local LLM is a supported
 *                                      topology; this is the deployment's decision,
 *                                      not this file's.
 *   BLOCKED  — non-http(s) schemes, URLs carrying embedded credentials, and
 *              address literals that can never be a deliberate AI endpoint:
 *              unspecified (0.0.0.0, ::), link-local (169.254/16 — which is where
 *              the cloud metadata service lives — and fe80::/10, including
 *              v4-mapped forms), multicast and reserved ranges.
 *
 * NO BYPASS BRANCHES EXIST. There is no early return for `localhost`, `127.0.0.1`,
 * `10.x`, `192.168.x` or IPv6 loopback: every address goes through the SAME
 * classification below, and the allowed private/loopback ranges are allowed
 * UNIFORMLY, not as an exception carved out for a familiar string. What that buys is
 * the opposite of a bypass — nothing can skip validation by looking special.
 *
 * HOSTNAMES ARE DELIBERATELY NOT RESOLVED. Resolving a name here to check the
 * address it points at would be defeated by DNS rebinding (the name answers with a
 * public address at validation time and a private one at call time) and would make
 * configuration writes depend on the API pod's DNS view. Name-to-address truth
 * belongs to the network layer (egress policy, service mesh); this policy decides
 * what an OPERATOR may configure. The one name-shaped classification performed here
 * — `localhost` — is cosmetic (it labels the result) and confers no privilege.
 *
 * WHERE THIS RUNS
 * ---------------
 *  1. Every CREATE/UPDATE of an `AIProviderConfig` row, so an unacceptable address
 *     is refused with a 400 at configuration time.
 *  2. Every runtime resolution of a stored row, so a row written before this policy
 *     existed — or by any future path — cannot steer a call either.
 */

/** Where an accepted address points, as far as this policy can tell without DNS. */
export type AIEndpointCategory = 'EXTERNAL' | 'INTERNAL' | 'LOOPBACK' | 'HOSTNAME';

export type AIEndpointCheck =
  | { allowed: true; host: string; category: AIEndpointCategory }
  | { allowed: false; reason: string };

/** Thrown by `assertAIEndpointAllowed`; `reason` is safe to show an operator. */
export class AIEndpointPolicyError extends Error {
  constructor(readonly reason: string) {
    super(`AI endpoint rejected: ${reason}`);
    this.name = 'AIEndpointPolicyError';
  }
}

/**
 * Classifies one configured base URL. PURE — no DNS, no network, no state — so it
 * is callable from DTO validation, the resolver and a unit test identically.
 */
export function checkAIEndpoint(baseUrl: string): AIEndpointCheck {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { allowed: false, reason: 'not a valid absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `unsupported scheme "${url.protocol}"` };
  }

  // `@IsUrl()` permits `http://user:pass@host`; a credential in the URL is exactly
  // what §21 forbids — it would be logged, echoed in errors and sent in cleartext.
  if (url.username.length > 0 || url.password.length > 0) {
    return { allowed: false, reason: 'URL carries embedded credentials' };
  }

  // `URL.hostname` brackets IPv6 literals; strip them once, here.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  if (host.length === 0) {
    return { allowed: false, reason: 'missing host' };
  }

  const version = isIP(host);

  if (version === 0) {
    return {
      allowed: true,
      host,
      category: host === 'localhost' || host.endsWith('.localhost') ? 'LOOPBACK' : 'HOSTNAME',
    };
  }

  if (version === 4) {
    const blocked = blockedIpv4Reason(host);
    if (blocked) return { allowed: false, reason: blocked };
    return { allowed: true, host, category: ipv4Category(host) };
  }

  const blocked = blockedIpv6Reason(host);
  if (blocked) return { allowed: false, reason: blocked };
  return { allowed: true, host, category: ipv6Category(host) };
}

/** Throws `AIEndpointPolicyError` unless the address is acceptable. */
export function assertAIEndpointAllowed(baseUrl: string): void {
  const check = checkAIEndpoint(baseUrl);
  if (!check.allowed) {
    throw new AIEndpointPolicyError(check.reason);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPv4
// ─────────────────────────────────────────────────────────────────────────────

const ipv4Parts = (host: string): [number, number, number, number] =>
  host.split('.').map((part) => Number(part)) as [number, number, number, number];

/** A reason when the address can never be a deliberate AI endpoint, else null. */
function blockedIpv4Reason(host: string): string | null {
  const [a, b] = ipv4Parts(host);

  if (a === 0 && b === 0 && host === '0.0.0.0') return 'unspecified address (0.0.0.0)';
  // 169.254/16 is link-local AND the home of every major cloud metadata service.
  if (a === 169 && b === 254) return 'link-local address (169.254.0.0/16)';
  // 224/4 multicast; 240/4 reserved and 255.255.255.255 broadcast live here too.
  if (a >= 224) return 'multicast or reserved range';

  return null;
}

function ipv4Category(host: string): AIEndpointCategory {
  const [a, b] = ipv4Parts(host);

  if (a === 127) return 'LOOPBACK';
  if (a === 10) return 'INTERNAL';
  if (a === 172 && b >= 16 && b <= 31) return 'INTERNAL';
  if (a === 192 && b === 168) return 'INTERNAL';

  return 'EXTERNAL';
}

// ─────────────────────────────────────────────────────────────────────────────
// IPv6 — expanded to bytes with no dependency, so the range checks below are
// ordinary comparisons rather than regular-expression folklore.
// ─────────────────────────────────────────────────────────────────────────────

/** 16 bytes, or null when the literal cannot be parsed. */
function expandIpv6(host: string): number[] | null {
  // A zone id (`fe80::1%eth0`, URL-encoded as `%25`) says which interface, not
  // which address; the address decides the policy.
  const withoutZone = host.split('%')[0];

  const tailWithV4 = withoutZone.includes('.');
  let v4Bytes: number[] = [];

  if (tailWithV4) {
    const lastColon = withoutZone.lastIndexOf(':');
    const v4 = withoutZone.slice(lastColon + 1);
    const parts = v4.split('.').map(Number);

    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }

    v4Bytes = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
  }

  const head = tailWithV4 ? withoutZone.slice(0, withoutZone.lastIndexOf(':') + 1) : withoutZone;
  const doubled = head.split('::');

  if (doubled.length > 2) return null;

  const parseGroups = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const groups: number[] = [];
    for (const group of side.replace(/^:|:$/g, '').split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const left = parseGroups(doubled[0]);
  const right = doubled.length === 2 ? parseGroups(doubled[1].replace(/:$/, '')) : [];
  if (left === null || right === null) return null;

  // `v4Bytes` is two GROUPS, and an embedded IPv4 tail always sits at the very end.
  const afterLeft = [...right, ...v4Bytes];
  const total = afterLeft.length + left.length;

  let groups: number[];
  if (doubled.length === 2) {
    // `::` stands for one or more zero groups — the padding is what makes
    // `::ffff:169.254.169.254` land its ffff marker at bytes 10/11 and what makes
    // `::1` a loopback instead of a two-byte fragment.
    if (total > 8) return null;
    groups = [...left, ...new Array(8 - total).fill(0), ...afterLeft];
  } else {
    if (total !== 8) return null;
    groups = [...left, ...afterLeft];
  }

  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function blockedIpv6Reason(host: string): string | null {
  const bytes = expandIpv6(host);
  if (!bytes) return `unparseable IPv6 literal "${host}"`;

  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return 'unspecified address (::)';

  // v4-mapped (::ffff:a.b.c.d) is an IPv4 address wearing IPv6 spelling. Judge the
  // embedded address with the IPv4 rules, or `::ffff:169.254.169.254` walks past
  // the link-local block above.
  const v4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (v4Mapped) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return blockedIpv4Reason(embedded);
  }

  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local address (fe80::/10)';
  if (bytes[0] === 0xff) return 'multicast address (ff00::/8)';

  return null;
}

function ipv6Category(host: string): AIEndpointCategory {
  const bytes = expandIpv6(host);
  if (!bytes) return 'EXTERNAL';

  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (loopback) return 'LOOPBACK';

  // fc00::/7 — unique local addresses.
  if ((bytes[0] & 0xfe) === 0xfc) return 'INTERNAL';

  return 'EXTERNAL';
}
