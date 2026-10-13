import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

/**
 * Phase 51-HR-ARCH-3A: the verifier side of ADR-0006 §C — revocation without a Core read.
 *
 * THE THREE LAYERS, AND WHICH ONE THIS FILE IS
 * -------------------------------------------
 * The ADR bounds revocation with three layers, of which the first is entirely
 * arithmetic and lives in `TokenVerifier`:
 *
 *   1. a short access TTL — a token longer-lived than
 *      `HR_ACCEPTED_TOKEN_MAX_TTL_SECONDS` is rejected outright, so no revocation
 *      gap can outlive that bound even if nothing else works;
 *   2. `ver` plus the `platform.revocation@v1` feed — this file: a bounded, TTL'd
 *      in-memory deny-set keyed by user id, where a token whose `ver` is at or below
 *      the highest revoked `ver` for that user is rejected;
 *   3. the cold path — refresh still validates `tokenVersion` and `status` against
 *      Core, so a revoked user cannot EXTEND access at all.
 *
 * WHAT IS SHIPPED, AND WHAT IS DELIBERATELY NOT
 * --------------------------------------------
 * The registry, the event contract and the staleness/ordering rules are shipped and
 * tested. The TRANSPORT is not: this phase has no issuer-side publisher to consume
 * (ADR-0006 defers the `platform.*` messaging contracts to 3B), so binding a fake
 * broker would be inventing a contract in order to look complete. Instead
 * `RevocationFeed` has exactly one shipped implementation, `UnwiredRevocationFeed`,
 * which is a DECLARED ABSENCE: it subscribes to nothing, it says so in the boot log,
 * and `snapshot().enforcement` reports `ttl-bound-only`.
 *
 * That is the ADR's own §C2 position applied to a phase that has no feed yet: with
 * the feed unavailable, requests are NOT failed (a broker is an optional dependency,
 * E9, and failing closed on all traffic would promote it to a single point of
 * failure). Enforcement degrades to the TTL bound — the number 300 rather than a
 * promise — and the state is REPORTED rather than hidden.
 *
 * DEGRADATION IS NOT FAIL-OPEN, AND THE DIFFERENCE IS ENFORCED HERE
 * ----------------------------------------------------------------
 * A malformed event never mutates state. A stale (out-of-order) event never lowers a
 * deny level. An expired entry is removed only because the tokens it could have
 * invalidated have themselves expired. Nothing in this file can be made to CLEAR a
 * revocation, and no path returns "not revoked" because a feed was unreachable.
 */

/** The event contract ADR-0006 §C1(2) names. */
export const REVOCATION_EVENT_CONTRACT = 'platform.revocation@v1';

export interface RevocationEvent {
  readonly userId: string;
  readonly ver: number;
  readonly tid: string;
  readonly revokedAt: string;
}

/**
 * What applying an event did.
 *
 * `stale` is not an error: a feed that re-delivers an old event, or delivers two
 * events out of order, must not move the deny level backwards.
 */
export type RevocationEventOutcome = 'applied' | 'stale' | 'rejected';

export type RevocationFeedState = 'wired' | 'unwired';

/** How revocation is being enforced right now. Reported, never inferred by a caller. */
export type RevocationEnforcement = 'ttl-bound-only' | 'ttl-and-deny-set';

export interface RevocationSnapshot {
  readonly feedState: RevocationFeedState;
  readonly enforcement: RevocationEnforcement;
  /** Why the feed is unwired, in the feed's own words. Null when wired. */
  readonly feedDetail: string | null;
  readonly denySetEntries: number;
  /** Entries dropped to keep the deny-set bounded. Zero in any healthy deployment. */
  readonly denySetEvictions: number;
  readonly lastEventAt: string | null;
}

/**
 * Upper bound on the deny-set.
 *
 * The TTL bounds the set in TIME; this bounds it in SIZE, so a hostile or broken
 * feed cannot grow the process's memory. Sized well above the platform's realistic
 * revocation volume for one access-TTL window; evictions are counted and surfaced
 * rather than being silent.
 */
export const MAX_DENY_SET_ENTRIES = 50_000;

/**
 * The deny-set, as an interface.
 *
 * An abstract class rather than a bare interface so it can also serve as a Nest DI
 * token, which is what lets the combined runtime bind this implementation while a
 * future HR runtime binds a different one without a change to any caller.
 */
export abstract class TokenRevocationRegistry {
  /** True when `(userId, ver)` is at or below the highest revoked version. */
  abstract isRevoked(userId: string, ver: number): boolean;

  /** Applies one `platform.revocation@v1` event. Never throws; reports the outcome. */
  abstract apply(event: unknown, receivedAtMs?: number): RevocationEventOutcome;

  abstract markFeedWired(): void;

  abstract markFeedUnwired(reason: string): void;

  abstract snapshot(): RevocationSnapshot;

  abstract describe(): string;
}

@Injectable()
export class InMemoryRevocationRegistry extends TokenRevocationRegistry implements OnModuleInit {
  private readonly logger = new Logger(InMemoryRevocationRegistry.name);

  /** userId → highest revoked version, with the instant this entry may be dropped. */
  private readonly entries = new Map<string, { ver: number; expiresAtMs: number }>();

  private feedState: RevocationFeedState = 'unwired';
  private feedDetail: string | null = 'no revocation feed has been registered';
  private lastEventAt: string | null = null;
  private evictions = 0;

  /**
   * @param maxTtlSeconds the maximum lifetime this deployment accepts for an access
   *   token. A deny entry must outlive every token it could still affect, and no
   *   token can be older than this, so this IS the correct entry lifetime — not a
   *   guess with a safety margin.
   */
  constructor(
    private readonly maxTtlSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  /**
   * States the deployment's revocation posture ONCE, at boot, in the log.
   *
   * An operator must be able to find out that revocation is currently bounded by the
   * access TTL without reading this file, and must not have to guess whether the
   * absence of feed warnings means "healthy" or "never wired".
   */
  onModuleInit(): void {
    if (this.feedState === 'unwired') {
      this.logger.warn(
        `${REVOCATION_EVENT_CONTRACT}: no feed is wired (${this.feedDetail}). Revocation enforcement is ttl-bound-only: a revoked token keeps working for at most ${this.maxTtlSeconds}s, and the cold path (refresh) remains authoritative.`,
      );
      return;
    }

    this.logger.log(
      `${REVOCATION_EVENT_CONTRACT}: feed wired. Revocation enforcement is ttl-and-deny-set (bound ${this.maxTtlSeconds}s, max ${MAX_DENY_SET_ENTRIES} entries).`,
    );
  }

  isRevoked(userId: string, ver: number): boolean {
    const entry = this.entries.get(userId);
    if (!entry) return false;

    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(userId);
      return false;
    }

    // At-or-below, not strictly below: the token that was current when the user was
    // revoked carries exactly the revoked version and must die with it.
    return ver <= entry.ver;
  }

  apply(event: unknown, receivedAtMs: number = this.now()): RevocationEventOutcome {
    const parsed = parseRevocationEvent(event);

    if (!parsed.ok) {
      // NEVER mutates state: an unreadable event is not a reason to forget a
      // revocation, and ignoring it is not a reason to fail a request either.
      this.logger.warn(`${REVOCATION_EVENT_CONTRACT}: rejected event (${parsed.reason})`);
      return 'rejected';
    }

    const { userId, ver, revokedAt } = parsed.event;
    const existing = this.entries.get(userId);
    const existingLive = existing !== undefined && existing.expiresAtMs > receivedAtMs;

    if (existingLive && existing.ver >= ver) {
      // Monotonic by construction: out-of-order or re-delivered events cannot lower
      // the bar, so a feed cannot be used to un-revoke somebody.
      this.logger.debug(
        `${REVOCATION_EVENT_CONTRACT}: stale event for ${userId} (ver ${ver} <= ${existing.ver})`,
      );
      return 'stale';
    }

    this.enforceBound();
    this.entries.set(userId, { ver, expiresAtMs: receivedAtMs + this.maxTtlSeconds * 1000 });
    this.lastEventAt = revokedAt;

    return 'applied';
  }

  markFeedWired(): void {
    this.feedState = 'wired';
    this.feedDetail = null;
  }

  markFeedUnwired(reason: string): void {
    this.feedState = 'unwired';
    this.feedDetail = reason;
  }

  snapshot(): RevocationSnapshot {
    this.dropExpired();

    return {
      feedState: this.feedState,
      enforcement: this.feedState === 'wired' ? 'ttl-and-deny-set' : 'ttl-bound-only',
      feedDetail: this.feedDetail,
      denySetEntries: this.entries.size,
      denySetEvictions: this.evictions,
      lastEventAt: this.lastEventAt,
    };
  }

  describe(): string {
    const state = this.snapshot();
    return `${REVOCATION_EVENT_CONTRACT} ${state.enforcement} (feed=${state.feedState}, entries=${state.denySetEntries}, bound=${this.maxTtlSeconds}s)`;
  }

  /** Removes entries whose tokens must themselves have expired by now. */
  private dropExpired(): void {
    const now = this.now();
    for (const [userId, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(userId);
    }
  }

  /**
   * Keeps the set bounded. The oldest insertion is dropped first — every entry has
   * the same lifetime, so insertion order IS expiry order — and the drop is counted
   * so a deployment that ever reaches this bound is visible rather than silently
   * less revoking.
   */
  private enforceBound(): void {
    if (this.entries.size < MAX_DENY_SET_ENTRIES) return;

    this.dropExpired();

    while (this.entries.size >= MAX_DENY_SET_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }

    this.logger.warn(
      `${REVOCATION_EVENT_CONTRACT}: deny-set reached ${MAX_DENY_SET_ENTRIES} entries; oldest entries were evicted (total evictions: ${this.evictions}). Eviction shortens how long a revocation is enforced, so this warrants investigation.`,
    );
  }
}

export type RevocationFeedStatus = 'wired' | 'unwired' | 'unavailable';

/**
 * The feed's reason for being unwired, in one sentence an operator can act on.
 *
 * Named as a constant because it is quoted in the boot log AND surfaced through
 * `snapshot().feedDetail`: the deployment's revocation posture must not depend on a
 * string that can be changed in one place and read from another.
 */
export const UNWIRED_FEED_REASON =
  'no platform.revocation@v1 transport exists in this phase (ADR-0006 defers the platform messaging contracts to 3B)';

/**
 * The verifier's view of the revocation feed.
 *
 * Declared here so the transport can arrive later WITHOUT touching verification: a
 * consumer of this contract subscribes, applies events to the registry, and reports
 * its own status. Nothing about the deny-set's semantics is up to the transport.
 */
export abstract class RevocationFeed {
  abstract start(): Promise<void>;

  abstract stop(): Promise<void>;

  abstract status(): { readonly state: RevocationFeedStatus; readonly detail: string };
}

/**
 * The feed this phase ships: a declared absence.
 *
 * It subscribes to nothing and never will — its one job is to make the absence
 * explicit, at boot, in the log and in `snapshot()`. An alternative "no feed
 * registered" state (a missing provider, an unbound token) would make the two
 * situations indistinguishable: "the feed is fine and reporting nothing" and "there
 * is no feed" would both look like silence.
 */
@Injectable()
export class UnwiredRevocationFeed extends RevocationFeed {
  constructor(private readonly registry: TokenRevocationRegistry) {
    super();
    this.registry.markFeedUnwired(UNWIRED_FEED_REASON);
  }

  async start(): Promise<void> {
    // Nothing to subscribe to, by design. Deliberately NOT throwing: a missing feed
    // is a reported posture (§C2), not a boot failure.
  }

  async stop(): Promise<void> {
    // Symmetrical no-op.
  }

  status(): { readonly state: RevocationFeedStatus; readonly detail: string } {
    return { state: 'unwired', detail: UNWIRED_FEED_REASON };
  }
}

/** Bound on an id taken from a feed event, so a broken feed cannot enlarge memory per entry. */
export const MAX_FEED_ID_LENGTH = 128;

/**
 * Validates a `platform.revocation@v1` event.
 *
 * Every failure mode is a REFUSAL TO ACT, never an action: a missing `userId`, a
 * negative or fractional `ver`, a missing tenant or an unparseable timestamp is
 * reported to the caller so it can be logged and counted, and no state changes.
 * Deliberately permissive about EXTRA fields (a newer publisher may add one) and
 * strict about the four the contract names.
 */
export function parseRevocationEvent(
  event: unknown,
): { ok: true; event: RevocationEvent } | { ok: false; reason: string } {
  if (!event || typeof event !== 'object') {
    return { ok: false, reason: 'event is not an object' };
  }

  const candidate = event as Record<string, unknown>;

  const userId = candidate.userId;
  if (typeof userId !== 'string' || userId.trim().length === 0 || userId.length > MAX_FEED_ID_LENGTH) {
    return { ok: false, reason: 'userId is missing, empty or implausibly long' };
  }

  const ver = candidate.ver;
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 0) {
    return { ok: false, reason: 'ver is not a non-negative integer' };
  }

  const tid = candidate.tid;
  if (typeof tid !== 'string' || tid.trim().length === 0 || tid.length > MAX_FEED_ID_LENGTH) {
    return { ok: false, reason: 'tid is missing, empty or implausibly long' };
  }

  const revokedAt = candidate.revokedAt;
  if (typeof revokedAt !== 'string' || Number.isNaN(Date.parse(revokedAt))) {
    return { ok: false, reason: 'revokedAt is not a parseable timestamp' };
  }

  return { ok: true, event: { userId, ver, tid, revokedAt } };
}