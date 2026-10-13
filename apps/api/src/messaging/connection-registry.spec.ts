import { Logger } from '@nestjs/common';
import {
  InProcessConnectionRegistry,
  type RegisteredConnection,
} from './connection-registry';

/**
 * Phase 49F unit coverage for the messaging fan-out registry.
 *
 * The registry is the only place that knows which sockets exist, so these
 * assertions cover the parts nothing else can: multi-connection presence
 * ("at least one live socket"), single-delivery-per-socket fan-out, reaping of
 * sockets that died without firing their close handler, and the guarantee that a
 * failed write is never fatal.
 *
 * No Nest testing module is needed — the class has no injected dependencies, and
 * constructing it directly keeps every assertion about real behaviour rather than
 * about wiring.
 */

/** A stand-in socket that records what was written to it. */
interface FakeConnection extends RegisteredConnection {
  frames: string[];
  open: boolean;
  /** Set to make `send` throw, simulating a write against a dead socket. */
  failOnSend: boolean;
}

const makeConnection = (): FakeConnection => {
  const connection: FakeConnection = {
    frames: [],
    open: true,
    failOnSend: false,
    send(frame: string) {
      if (connection.failOnSend) {
        throw new Error('socket is not writable');
      }
      connection.frames.push(frame);
    },
    isOpen: () => connection.open,
  };
  return connection;
};

/** Decodes the frames a connection received back into events. */
const received = (connection: FakeConnection) =>
  connection.frames.map((frame) => JSON.parse(frame));

describe('InProcessConnectionRegistry', () => {
  let registry: InProcessConnectionRegistry;

  const userA = 'user-a';
  const userB = 'user-b';

  beforeEach(() => {
    registry = new InProcessConnectionRegistry();
    // The registry logs at warn/debug on the failure paths; silence it so a
    // deliberately-provoked failure does not pollute the test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('makes a registered user online', () => {
      expect(registry.isOnline(userA)).toBe(false);

      registry.register(userA, 'c1', makeConnection());

      expect(registry.isOnline(userA)).toBe(true);
    });

    it('ignores a registration with no userId or no connectionId', () => {
      registry.register('', 'c1', makeConnection());
      registry.register(userA, '', makeConnection());

      expect(registry.isOnline('')).toBe(false);
      expect(registry.isOnline(userA)).toBe(false);
    });

    it('replaces the connection held under the same connectionId', () => {
      const first = makeConnection();
      const second = makeConnection();

      registry.register(userA, 'c1', first);
      registry.register(userA, 'c1', second);

      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(1);
      expect(first.frames).toHaveLength(0);
      expect(second.frames).toHaveLength(1);
    });

    it('keeps several connections for the same user side by side', () => {
      const tabOne = makeConnection();
      const tabTwo = makeConnection();

      registry.register(userA, 'c1', tabOne);
      registry.register(userA, 'c2', tabTwo);

      // Both tabs are addressed, so a message opened in one window appears in the
      // other without a reload.
      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(2);
      expect(tabOne.frames).toHaveLength(1);
      expect(tabTwo.frames).toHaveLength(1);
    });
  });

  describe('unregister', () => {
    it('removes only the named connection', () => {
      const tabOne = makeConnection();
      const tabTwo = makeConnection();

      registry.register(userA, 'c1', tabOne);
      registry.register(userA, 'c2', tabTwo);

      registry.unregister(userA, 'c1');

      // Closing one tab must not take the user offline — this is the invariant the
      // gateway relies on before it announces `offline`.
      expect(registry.isOnline(userA)).toBe(true);
      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(1);
      expect(tabOne.frames).toHaveLength(0);
      expect(tabTwo.frames).toHaveLength(1);
    });

    it('takes the user offline once the last connection is gone', () => {
      registry.register(userA, 'c1', makeConnection());
      registry.unregister(userA, 'c1');

      expect(registry.isOnline(userA)).toBe(false);
      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(0);
    });

    it('is a no-op for an unknown user or an unknown connection', () => {
      registry.register(userA, 'c1', makeConnection());

      expect(() => registry.unregister('nobody', 'c9')).not.toThrow();
      expect(() => registry.unregister(userA, 'c9')).not.toThrow();

      expect(registry.isOnline(userA)).toBe(true);
    });

    it('is idempotent for the same connection', () => {
      registry.register(userA, 'c1', makeConnection());

      registry.unregister(userA, 'c1');
      registry.unregister(userA, 'c1');

      expect(registry.isOnline(userA)).toBe(false);
    });
  });

  describe('isOnline', () => {
    it('is false for a user that was never registered', () => {
      expect(registry.isOnline('ghost')).toBe(false);
    });

    it('is false when every held connection reports closed', () => {
      const connection = makeConnection();
      registry.register(userA, 'c1', connection);

      connection.open = false;

      // A socket that closed without unregistering must not keep a user "online".
      expect(registry.isOnline(userA)).toBe(false);
    });

    it('is true while at least one held connection is open', () => {
      const dead = makeConnection();
      const live = makeConnection();
      dead.open = false;

      registry.register(userA, 'c1', dead);
      registry.register(userA, 'c2', live);

      expect(registry.isOnline(userA)).toBe(true);
    });
  });

  describe('onlineAmong', () => {
    it('keeps only the connected users, preserving input order', () => {
      registry.register(userB, 'c1', makeConnection());

      expect(registry.onlineAmong([userA, userB, 'user-c'])).toEqual([userB]);
    });

    it('returns an empty list when nobody is connected', () => {
      expect(registry.onlineAmong([userA, userB])).toEqual([]);
    });

    it('returns an empty list for an empty candidate list', () => {
      registry.register(userA, 'c1', makeConnection());

      expect(registry.onlineAmong([])).toEqual([]);
    });
  });

  describe('publishToUsers', () => {
    it('writes one frame carrying the event name and payload', () => {
      const connection = makeConnection();
      registry.register(userA, 'c1', connection);

      const delivered = registry.publishToUsers([userA], 'message.created', {
        id: 'm1',
        body: 'سلام',
      });

      expect(delivered).toBe(1);
      expect(received(connection)).toEqual([
        { event: 'message.created', data: { id: 'm1', body: 'سلام' } },
      ]);
    });

    it('fans out across users and across each user\'s connections', () => {
      const aTabOne = makeConnection();
      const aTabTwo = makeConnection();
      const bTab = makeConnection();

      registry.register(userA, 'c1', aTabOne);
      registry.register(userA, 'c2', aTabTwo);
      registry.register(userB, 'c3', bTab);

      expect(registry.publishToUsers([userA, userB], 'typing.changed', { isTyping: true })).toBe(3);
      expect(aTabOne.frames).toHaveLength(1);
      expect(aTabTwo.frames).toHaveLength(1);
      expect(bTab.frames).toHaveLength(1);
    });

    it('delivers once per socket even when a user is listed twice', () => {
      const connection = makeConnection();
      registry.register(userA, 'c1', connection);

      // A duplicated member row must not produce a duplicated message.
      expect(registry.publishToUsers([userA, userA, userA], 'message.created', { id: 'm1' })).toBe(1);
      expect(connection.frames).toHaveLength(1);
    });

    it('skips users with no connection without failing the whole publish', () => {
      const connection = makeConnection();
      registry.register(userB, 'c1', connection);

      expect(registry.publishToUsers([userA, userB], 'message.created', { id: 'm1' })).toBe(1);
      expect(connection.frames).toHaveLength(1);
    });

    it('returns zero when nobody in the audience is connected', () => {
      expect(registry.publishToUsers([userA, userB], 'message.created', { id: 'm1' })).toBe(0);
    });

    it('reaps a connection that reports closed and stops counting it', () => {
      const dead = makeConnection();
      const live = makeConnection();

      registry.register(userA, 'c1', dead);
      registry.register(userA, 'c2', live);
      dead.open = false;

      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(1);
      expect(dead.frames).toHaveLength(0);

      // The dead entry is gone, not merely skipped: a second publish sees one socket.
      expect(registry.publishToUsers([userA], 'message.created', { id: 'm2' })).toBe(1);
      expect(live.frames).toHaveLength(2);
    });

    it('takes the user offline once reaping removes the last connection', () => {
      const dead = makeConnection();
      registry.register(userA, 'c1', dead);
      dead.open = false;

      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(0);
      // The outer map entry is dropped too, so reconnect churn cannot leak memory.
      expect(registry.isOnline(userA)).toBe(false);
    });

    it('drops a connection whose write throws and keeps delivering to the rest', () => {
      const broken = makeConnection();
      const healthy = makeConnection();
      broken.failOnSend = true;

      registry.register(userA, 'c1', broken);
      registry.register(userA, 'c2', healthy);

      // A failed write is never fatal: the message is already committed in Postgres
      // and the client recovers it over HTTP on reconnect.
      expect(registry.publishToUsers([userA], 'message.created', { id: 'm1' })).toBe(1);
      expect(healthy.frames).toHaveLength(1);

      expect(registry.publishToUsers([userA], 'message.created', { id: 'm2' })).toBe(1);
      expect(healthy.frames).toHaveLength(2);
    });

    it('returns zero and writes nothing when the payload cannot be serialised', () => {
      const connection = makeConnection();
      registry.register(userA, 'c1', connection);

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(registry.publishToUsers([userA], 'message.created', circular)).toBe(0);
      expect(connection.frames).toHaveLength(0);
      // The socket survives an unserialisable payload.
      expect(registry.isOnline(userA)).toBe(true);
    });

    it('serialises the payload once and hands every socket the identical frame', () => {
      const aTab = makeConnection();
      const bTab = makeConnection();

      registry.register(userA, 'c1', aTab);
      registry.register(userB, 'c2', bTab);

      registry.publishToUsers([userA, userB], 'message.created', { id: 'm1' });

      expect(aTab.frames[0]).toBe(bTab.frames[0]);
    });

    it('does nothing for an empty audience', () => {
      const connection = makeConnection();
      registry.register(userA, 'c1', connection);

      expect(registry.publishToUsers([], 'message.created', { id: 'm1' })).toBe(0);
      expect(connection.frames).toHaveLength(0);
    });
  });
});
