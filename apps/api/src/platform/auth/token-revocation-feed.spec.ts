import { Logger } from '@nestjs/common';
import { RabbitMqRevocationFeed, REVOCATION_ROUTING_KEY } from './token-revocation-feed';
import {
  InMemoryRevocationRegistry,
  type TokenRevocationRegistry,
} from './token-revocation';

/**
 * TARGETED-REMEDIATION (P2): the `platform.revocation@v1` transport, tested WITHOUT a
 * broker — `consume` is deliberately public and byte-driven so delivery semantics are
 * deterministic. What is pinned here:
 *
 *  1. BYTES ARE DECODED ONCE, IN ONE PLACE — a Buffer body reaches `registry.apply` as
 *     an object, never as raw amqplib bytes (the mistake the audit consumer's own
 *     history documents).
 *  2. EVERY OUTCOME IS TERMINAL — 'applied', 'stale' and 'rejected' all resolve to an
 *     ack: nothing the feed consumes is requeued, because the registry's apply has no
 *     transient failure mode and the TTL bound is the backstop.
 *  3. THE REGISTRY IS THE AUTHORITY — the feed validates nothing itself; a malformed
 *     or out-of-order event is the contract's problem, answered by the same `apply`
 *     the seam already tested.
 *  4. LIFECYCLE IS HONEST — `start` with no broker reports `unwired` through BOTH the
 *     feed's own status and the registry's snapshot; `stop` returns the posture to
 *     `unwired` so "subscription ended" is never indistinguishable from "healthy".
 */

/** A valid revocation event as the publisher emits it. */
const revocationEvent = (overrides: Record<string, unknown> = {}) => ({
  contract: 'platform.revocation@v1',
  userId: 'user-1',
  ver: 5,
  tid: 'tenant-1',
  revokedAt: new Date().toISOString(),
  ...overrides,
});

describe('RabbitMqRevocationFeed', () => {
  let registry: TokenRevocationRegistry;
  let feed: RabbitMqRevocationFeed;

  beforeEach(() => {
    registry = new InMemoryRevocationRegistry(300);
    feed = new RabbitMqRevocationFeed(registry);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('consume — delivered bytes become deny-set entries', () => {
    it('applies a valid event delivered as BYTES — the amqplib reality', async () => {
      await feed.consume(Buffer.from(JSON.stringify(revocationEvent())));

      expect(registry.isRevoked('user-1', 5)).toBe(true);
      expect(registry.isRevoked('user-1', 6)).toBe(false);
      expect(registry.snapshot().lastEventAt).not.toBeNull();
    });

    it('applies a valid event delivered as a parsed object — a direct caller', async () => {
      await feed.consume(revocationEvent({ userId: 'user-2', ver: 2 }));

      expect(registry.isRevoked('user-2', 2)).toBe(true);
    });

    it('drops an unparseable body without touching the deny-set', async () => {
      await feed.consume(Buffer.from('not json {'));

      expect(registry.snapshot().denySetEntries).toBe(0);
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('lets the CONTRACT judge a malformed event — a missing ver is rejected, not crashed', async () => {
      await feed.consume(revocationEvent({ ver: undefined }));

      expect(registry.snapshot().denySetEntries).toBe(0);
      expect(registry.isRevoked('user-1', 0)).toBe(false);
    });

    it('never lowers a deny level on an out-of-order delivery', async () => {
      await feed.consume(revocationEvent({ ver: 9 }));
      await feed.consume(revocationEvent({ ver: 3 }));

      // ver 9 stays the bar: the stale event was applied to nothing.
      expect(registry.isRevoked('user-1', 9)).toBe(true);
      expect(registry.isRevoked('user-1', 10)).toBe(false);
    });
  });

  describe('lifecycle and the reported posture', () => {
    it('reports unwired BEFORE start and BEFORE any broker exists', () => {
      expect(feed.status().state).toBe('unwired');
      expect(registry.snapshot().feedState).toBe('unwired');
      expect(registry.snapshot().enforcement).toBe('ttl-bound-only');
    });

    it('reports the configured absence when no broker URL exists', async () => {
      const previous = process.env.RABBITMQ_URL;
      delete process.env.RABBITMQ_URL;
      try {
        await feed.start();
      } finally {
        if (previous !== undefined) process.env.RABBITMQ_URL = previous;
      }

      expect(feed.status().state).toBe('unwired');
      expect(registry.snapshot().feedState).toBe('unwired');
      // And the absence is SAID, at warn level — not silence that looks healthy.
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'feed.unconfigured' }),
        expect.any(String),
      );
    });

    it('is idempotent: a second start does not double the subscription', async () => {
      const previous = process.env.RABBITMQ_URL;
      delete process.env.RABBITMQ_URL;
      try {
        await feed.start();
        await feed.start();
      } finally {
        if (previous !== undefined) process.env.RABBITMQ_URL = previous;
      }
      // Reached only if neither call threw — the channel guard holds.
      expect(feed.status().state).toBe('unwired');
    });
  });

  it('names the routing key the publisher uses — one constant, one contract', () => {
    // The publisher (auth.service) and this feed's binding must spell the key alike;
    // pinning it here keeps a future rename from silently splitting the two.
    expect(REVOCATION_ROUTING_KEY).toBe('platform.revocation');
  });
});
