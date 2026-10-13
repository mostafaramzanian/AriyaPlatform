import {
  InMemoryRevocationRegistry,
  MAX_DENY_SET_ENTRIES,
  MAX_FEED_ID_LENGTH,
  REVOCATION_EVENT_CONTRACT,
  UNWIRED_FEED_REASON,
  UnwiredRevocationFeed,
  parseRevocationEvent,
} from './token-revocation';

/**
 * Phase 51-HR-ARCH-3A: the deny-set, and the ways it can be made to stop denying.
 *
 * ADR-0006 §C1(2) makes `ver` plus a revocation feed the second of three layers. The
 * interesting half of that design is not "a revoked token is refused" — that is a lookup —
 * but the ASYMMETRY: every path in this file either raises the deny level or does nothing.
 * A feed can be hostile, stale, reordered, malformed or absent, and none of those may be
 * convertible into "not revoked".
 *
 * So the tests below are written as refusals-to-degrade: the empty set answers `false`
 * (which the verifier treats as "not revoked"), the ceiling is reported rather than silent,
 * and an unreachable feed is a DECLARED absence that still leaves the TTL bound in force.
 */
const MAX_TTL_SECONDS = 300;

/**
 * A clock we control, so the entry lifetime is exercised rather than waited out: entry
 * lifetime = the accepted maximum token lifetime, which is a fact of the design and worth
 * asserting exactly.
 */
function clock(startMs = 1_700_000_000_000) {
  let now = startMs;

  return {
    now: () => now,
    advanceSeconds: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 'user-1',
    ver: 7,
    tid: 'tenant-a',
    revokedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The event contract. Every rejection here is "no state changed", which is why the shape of
 * the refusal matters as much as the shape of the acceptance.
 */
describe('parseRevocationEvent', () => {
  it('accepts the four fields the contract names', () => {
    const parsed = parseRevocationEvent(validEvent());

    expect(parsed).toEqual({
      ok: true,
      event: {
        userId: 'user-1',
        ver: 7,
        tid: 'tenant-a',
        revokedAt: '2026-09-01T00:00:00.000Z',
      },
    });
  });

  it('is permissive about EXTRA fields, so a newer publisher cannot break an older verifier', () => {
    const parsed = parseRevocationEvent(validEvent({ reason: 'password-reset', attempt: 2 }));

    expect(parsed.ok).toBe(true);
    // The extra fields are DROPPED, not carried: what reaches the registry is the contract,
    // so a publisher cannot influence anything beyond the four documented fields.
    expect(parsed.ok && Object.keys(parsed.event).sort()).toEqual([
      'revokedAt',
      'tid',
      'userId',
      'ver',
    ]);
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'user-1', 7, []]) {
      expect(parseRevocationEvent(value).ok).toBe(false);
    }
  });

  it('refuses a missing, empty or over-long userId or tid', () => {
    const bad = [
      { userId: undefined },
      { userId: '' },
      { userId: '   ' },
      { userId: 7 },
      { userId: 'u'.repeat(MAX_FEED_ID_LENGTH + 1) },
      { tid: undefined },
      { tid: '' },
      { tid: 't'.repeat(MAX_FEED_ID_LENGTH + 1) },
    ];

    for (const overrides of bad) {
      expect({ overrides, ok: parseRevocationEvent(validEvent(overrides)).ok }).toEqual({
        overrides,
        ok: false,
      });
    }
  });

  it('refuses a ver that is not a non-negative integer', () => {
    for (const ver of [undefined, null, '7', 7.5, -1, NaN]) {
      expect(parseRevocationEvent(validEvent({ ver })).ok).toBe(false);
    }

    // Zero is a legitimate version (a user who has never had a token rotated) and must be
    // accepted: refusing it would make the first revocation of a fresh account impossible.
    expect(parseRevocationEvent(validEvent({ ver: 0 })).ok).toBe(true);
  });

  it('refuses a revokedAt that is not a parseable timestamp', () => {
    for (const revokedAt of [undefined, '', 'not-a-date', 1_700_000_000_000]) {
      expect(parseRevocationEvent(validEvent({ revokedAt })).ok).toBe(false);
    }
  });

  it('names the field in its reason, so an operator can act on a rejected event', () => {
    expect(parseRevocationEvent(validEvent({ ver: 'nope' }))).toEqual({
      ok: false,
      reason: 'ver is not a non-negative integer',
    });
  });
});

describe('InMemoryRevocationRegistry', () => {
  let time: ReturnType<typeof clock>;
  let registry: InMemoryRevocationRegistry;

  beforeEach(() => {
    time = clock();
    registry = new InMemoryRevocationRegistry(MAX_TTL_SECONDS, time.now);
  });

  describe('isRevoked', () => {
    it('answers false for a user the deny-set has never heard of', () => {
      expect(registry.isRevoked('user-1', 0)).toBe(false);
    });

    /**
     * At-or-below, not strictly below. The token a user was holding when they were revoked
     * carries EXACTLY the revoked version; if the comparison were `ver < revokedVer`, that
     * token would survive its own revocation — which is the one token the event is about.
     */
    it('revokes the token whose ver EQUALS the revoked version, and every older one', () => {
      registry.apply(validEvent({ ver: 7 }));

      expect(registry.isRevoked('user-1', 7)).toBe(true);
      expect(registry.isRevoked('user-1', 6)).toBe(true);
      expect(registry.isRevoked('user-1', 0)).toBe(true);
    });

    it('leaves a NEWER token alone, so a re-issued session is not collateral damage', () => {
      registry.apply(validEvent({ ver: 7 }));

      expect(registry.isRevoked('user-1', 8)).toBe(false);
    });

    it('is keyed by user: one subject’s revocation cannot deny another', () => {
      registry.apply(validEvent({ userId: 'user-1', ver: 7 }));

      expect(registry.isRevoked('user-2', 0)).toBe(false);
    });

    /**
     * The entry lifetime IS the accepted token lifetime, so an expired entry can only be
     * forgotten once every token it could affect has itself expired. This is the arithmetic
     * that makes "drop the entry" safe rather than lossy — and it is why the verifier's
     * TTL bound and this registry take the same number.
     */
    it('forgets an entry exactly when every token it could deny has expired', () => {
      registry.apply(validEvent({ ver: 7 }));

      // One second before the bound is reached, the entry is still live: a token minted at the
      // moment of revocation is valid for the full accepted TTL, and dropping the entry any
      // earlier would leave that token accepted after its revocation.
      time.advanceSeconds(MAX_TTL_SECONDS - 1);
      expect(registry.isRevoked('user-1', 7)).toBe(true);

      time.advanceSeconds(1);
      expect(registry.isRevoked('user-1', 7)).toBe(false);
      // Dropped, not merely answered false: a stale entry must not accumulate.
      expect(registry.snapshot().denySetEntries).toBe(0);
    });
  });

  describe('apply', () => {
    it('reports applied, stale or rejected — never a bare boolean', () => {
      expect(registry.apply(validEvent({ ver: 7 }))).toBe('applied');
      expect(registry.apply(validEvent({ ver: 7 }))).toBe('stale');
      expect(registry.apply({ userId: 'user-1' })).toBe('rejected');
    });

    /**
     * MONOTONICITY IS THE WHOLE DEFENCE. A feed can re-deliver, reorder, or replay; if any
     * of those could move the deny level down, the feed would be a way to un-revoke a user
     * rather than a way to revoke one.
     */
    it('never lowers the deny level, whatever order events arrive in', () => {
      registry.apply(validEvent({ ver: 9 }));

      expect(registry.apply(validEvent({ ver: 9 }))).toBe('stale');
      expect(registry.apply(validEvent({ ver: 4 }))).toBe('stale');
      expect(registry.apply(validEvent({ ver: 0 }))).toBe('stale');

      // The high-water mark stands: ver 5 is still denied after the out-of-order event.
      expect(registry.isRevoked('user-1', 5)).toBe(true);
      expect(registry.isRevoked('user-1', 10)).toBe(false);
    });

    it('raises the deny level when a NEWER version arrives', () => {
      registry.apply(validEvent({ ver: 7 }));

      expect(registry.apply(validEvent({ ver: 12 }))).toBe('applied');
      expect(registry.isRevoked('user-1', 7)).toBe(true);
      expect(registry.isRevoked('user-1', 12)).toBe(true);
      expect(registry.isRevoked('user-1', 13)).toBe(false);
    });

    /**
     * A re-delivered event AFTER the entry expired is `applied`, not `stale`: the entry is
     * gone, so there is no live level to compare against and re-establishing the denial is
     * the safe answer. The version is then denied again for another full window.
     */
    it('re-applies an event whose entry had already expired, rather than reading it as stale', () => {
      registry.apply(validEvent({ ver: 7 }));
      time.advanceSeconds(MAX_TTL_SECONDS + 1);

      expect(registry.apply(validEvent({ ver: 7 }))).toBe('applied');
      expect(registry.isRevoked('user-1', 7)).toBe(true);
    });

    it('changes no state when an event is rejected', () => {
      registry.apply(validEvent({ ver: 7, revokedAt: '2026-09-01T00:00:00.000Z' }));

      expect(registry.apply(validEvent({ ver: 99, tid: '', revokedAt: '2026-09-02T00:00:00.000Z' }))).toBe(
        'rejected',
      );

      // Still 7: a malformed event is not a licence to forget, and not a licence to raise.
      expect(registry.isRevoked('user-1', 7)).toBe(true);
      expect(registry.isRevoked('user-1', 8)).toBe(false);
      expect(registry.snapshot().denySetEntries).toBe(1);
      // The posture keeps reporting the last event that was actually APPLIED, not the one
      // that arrived last: a rejected event must not be able to make the deny-set look
      // fresher than it is.
      expect(registry.snapshot().lastEventAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('records the publisher’s revokedAt of the last applied event', () => {
      registry.apply(validEvent({ revokedAt: '2026-09-01T00:00:00.000Z' }));

      expect(registry.snapshot().lastEventAt).toBe('2026-09-01T00:00:00.000Z');
    });

    /**
     * The entry lifetime is measured from when THIS verifier applied the event, not from
     * the publisher's timestamp. Those differ by the feed's delivery lag, and trusting the
     * publisher's clock would let a skewed (or hostile) `revokedAt` in the future keep a
     * deny entry alive indefinitely — or in the past expire it before the tokens it denies.
     */
    it('lifetimes the entry from local receipt, not from the publisher’s timestamp', () => {
      registry.apply(validEvent({ revokedAt: '2099-01-01T00:00:00.000Z' }));

      time.advanceSeconds(MAX_TTL_SECONDS + 1);
      expect(registry.isRevoked('user-1', 7)).toBe(false);
    });

    it('accepts a caller-supplied receipt time, so a feed can apply events in order', () => {
      const receivedAtMs = clock().now();

      expect(registry.apply(validEvent({ ver: 1 }), receivedAtMs)).toBe('applied');
      expect(registry.apply(validEvent({ ver: 2 }), receivedAtMs)).toBe('applied');
      expect(registry.apply(validEvent({ ver: 1 }), receivedAtMs)).toBe('stale');
    });
  });

  /**
   * The SIZE bound, as distinct from the time bound. The TTL says how long an entry lives;
   * this says how many may live at once, so a hostile or broken feed cannot turn revocation
   * into a memory-exhaustion primitive. Reaching it is reported, never silent: eviction
   * SHORTENS how long a revocation is enforced, and a deployment in that state must be
   * visible rather than quietly less revoking.
   */
  describe('the deny-set ceiling', () => {
    it('evicts the oldest entries once the set is full, and counts what it dropped', () => {
      for (let index = 0; index < MAX_DENY_SET_ENTRIES + 1; index += 1) {
        expect(registry.apply(validEvent({ userId: `user-${index}` }), time.now())).toBe('applied');
      }

      const snapshot = registry.snapshot();
      expect(snapshot.denySetEntries).toBe(MAX_DENY_SET_ENTRIES);
      expect(snapshot.denySetEvictions).toBe(1);

      // The evicted entry is the FIRST one in, so its revocation is no longer enforced —
      // the shape of the degradation the counter exists to surface.
      expect(registry.isRevoked('user-0', 7)).toBe(false);
      expect(registry.isRevoked(`user-${MAX_DENY_SET_ENTRIES}`, 7)).toBe(true);
    });

    it('reports the bound and the entry lifetime in its posture line', () => {
      registry.apply(validEvent({ ver: 7 }));
      registry.markFeedWired();

      expect(registry.describe()).toBe(
        `${REVOCATION_EVENT_CONTRACT} ttl-and-deny-set (feed=wired, entries=1, bound=${MAX_TTL_SECONDS}s)`,
      );
    });
  });

  /**
   * THE POSTURE, which is the ADR's §C2 requirement rather than a convenience: an operator
   * must be able to tell "the feed is wired and healthy" from "there is no feed" without
   * reading this file, and "revocation is enforced by the deny-set" from "revocation is
   * enforced by the TTL bound alone" without inferring it from silence.
   */
  describe('the reported posture', () => {
    it('starts UNWIRED with an explicit reason rather than a blank', () => {
      expect(registry.snapshot()).toEqual({
        feedState: 'unwired',
        enforcement: 'ttl-bound-only',
        feedDetail: 'no revocation feed has been registered',
        denySetEntries: 0,
        denySetEvictions: 0,
        lastEventAt: null,
      });
    });

    it('moves to ttl-and-deny-set only when a feed says it is wired', () => {
      registry.markFeedWired();

      const snapshot = registry.snapshot();
      expect(snapshot.feedState).toBe('wired');
      expect(snapshot.enforcement).toBe('ttl-and-deny-set');
      expect(snapshot.feedDetail).toBeNull();
    });

    it('carries the feed’s own explanation when the feed declares itself unwired', () => {
      registry.markFeedUnwired(UNWIRED_FEED_REASON);

      const snapshot = registry.snapshot();
      expect(snapshot.feedState).toBe('unwired');
      expect(snapshot.enforcement).toBe('ttl-bound-only');
      expect(snapshot.feedDetail).toBe(UNWIRED_FEED_REASON);
    });

    /**
     * Degradation is not fail-open. An unwired feed leaves the deny-set usable (an operator
     * can still apply events by hand through a probe) and leaves the TTL bound untouched —
     * it does not clear entries and does not answer "not revoked" for a version it knows
     * about.
     */
    it('does not forget applied revocations when the feed goes away', () => {
      registry.markFeedWired();
      registry.apply(validEvent({ ver: 7 }));

      registry.markFeedUnwired(UNWIRED_FEED_REASON);

      expect(registry.isRevoked('user-1', 7)).toBe(true);
      expect(registry.snapshot().denySetEntries).toBe(1);
    });
  });
});

describe('UnwiredRevocationFeed', () => {
  let time: ReturnType<typeof clock>;
  let registry: InMemoryRevocationRegistry;

  beforeEach(() => {
    time = clock();
    registry = new InMemoryRevocationRegistry(MAX_TTL_SECONDS, time.now);
  });

  it('declares the absence at construction, so no consumer can observe silence as health', () => {
    new UnwiredRevocationFeed(registry);

    const snapshot = registry.snapshot();
    expect(snapshot.feedState).toBe('unwired');
    expect(snapshot.feedDetail).toBe(UNWIRED_FEED_REASON);
    expect(snapshot.enforcement).toBe('ttl-bound-only');
  });

  it('reports its own status in the same words it gave the registry', () => {
    const feed = new UnwiredRevocationFeed(registry);

    expect(feed.status()).toEqual({ state: 'unwired', detail: UNWIRED_FEED_REASON });
  });

  /**
   * `start`/`stop` are no-ops that must NOT throw. A missing feed is an optional dependency
   * (ADR-0006 §E9): failing boot over it would promote a broker to a single point of failure
   * for every runtime — the opposite of what degrading to the TTL bound is for.
   */
  it('can be started and stopped without throwing anything', async () => {
    const feed = new UnwiredRevocationFeed(registry);

    await expect(feed.start()).resolves.toBeUndefined();
    await expect(feed.stop()).resolves.toBeUndefined();
    expect(registry.snapshot().feedState).toBe('unwired');
  });
});
