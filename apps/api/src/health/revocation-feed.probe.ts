import { Injectable, Optional } from '@nestjs/common';
import { TokenRevocationRegistry } from '../platform/auth/token-revocation';
import type { ProbeResult } from './health.contract';

/**
 * PHASE W3 (P4): the revocation feed's posture as a readiness CHECK — never a
 * gate. `ttl-bound-only` is a documented, legal degraded posture (the token TTL
 * bound still applies), so this probe is always `optional`: it REPORTS whether
 * the deny-set feed is actually wired, it never takes a runtime out of rotation.
 *
 * `TokenRevocationRegistry` is OPTIONAL in this graph because a runtime that
 * binds no token seam (a Core-only or CMS-only process) has no registry at all —
 * that absence is `not-configured`, not a failure.
 *
 * The four states an operator needs, mapped onto the probe vocabulary:
 *   wired + deny-set        → 'ok'             (enforcement ttl-and-deny-set)
 *   registry absent         → 'not-configured' (no token seam bound)
 *   RABBITMQ_URL absent     → 'not-configured' (declared absence, §C2/E9)
 *   configured, feed down   → 'failed'         (broker lost / feed unwired)
 *
 * `detail` carries only the feed's own one-sentence reason — never a broker URL
 * (the feed never states one) and never a token claim.
 */
@Injectable()
export class RevocationFeedProbe {
  constructor(
    @Optional() private readonly registry: TokenRevocationRegistry | null = null
  ) {}

  probe(): ProbeResult[] {
    if (!this.registry) {
      return [
        {
          key: 'tokenRevocationFeed',
          status: 'not-configured',
          requirement: 'optional',
          detail: 'no token revocation registry is bound in this runtime',
        },
      ];
    }

    const snapshot = this.registry.snapshot();
    if (snapshot.enforcement === 'ttl-and-deny-set' && snapshot.feedState === 'wired') {
      return [
        {
          key: 'tokenRevocationFeed',
          status: 'ok',
          requirement: 'optional',
          detail: 'revocation feed wired; enforcement is ttl-and-deny-set',
        },
      ];
    }

    const configured = Boolean(process.env.RABBITMQ_URL?.trim());
    return [
      {
        key: 'tokenRevocationFeed',
        status: configured ? 'failed' : 'not-configured',
        requirement: 'optional',
        detail: configured
          ? `revocation feed is ${snapshot.feedState} (${snapshot.feedDetail ?? 'no detail'}) — enforcement is ttl-bound-only`
          : 'RABBITMQ_URL is not configured — enforcement is ttl-bound-only',
      },
    ];
  }
}
