import { Injectable, Logger } from '@nestjs/common';

/**
 * Phase 49F: fan-out abstraction.
 *
 * The domain service never touches sockets. It calls `publishToUsers(...)` with
 * an already-persisted payload, and this registry decides who is currently
 * connected. That boundary is the whole point: replacing the in-process
 * implementation with a multi-node adapter later changes ONLY this file's
 * implementation class — no service, controller or gateway rewrite.
 *
 * Deliberately NOT used here: Redis Pub/Sub, Kafka, Bull, or any external broker.
 * A single Core process owns its own connections, and a message is authoritative
 * in Postgres before it is ever published, so a dropped fan-out degrades to a
 * client that re-reads over HTTP — never to lost data.
 */

/** One live socket, reduced to what fan-out actually needs. */
export interface RegisteredConnection {
  /** Sends one already-serialised frame. Implemented by the gateway. */
  send(frame: string): void;
  /** True while the socket can still accept frames. */
  isOpen(): boolean;
}

export interface ConnectionRegistryPort {
  register(userId: string, connectionId: string, connection: RegisteredConnection): void;
  unregister(userId: string, connectionId: string): void;
  /** True when the user has at least one live connection. */
  isOnline(userId: string): boolean;
  /** Filters a candidate list down to those currently connected. */
  onlineAmong(userIds: string[]): string[];
  /**
   * Publishes one event to every live connection of every listed user.
   * Returns the number of frames actually written.
   */
  publishToUsers(userIds: string[], event: string, payload: unknown): number;
}

export const CONNECTION_REGISTRY = 'CONNECTION_REGISTRY';

@Injectable()
export class InProcessConnectionRegistry implements ConnectionRegistryPort {
  private readonly logger = new Logger(InProcessConnectionRegistry.name);

  /**
   * userId -> connectionId -> connection.
   *
   * A user may hold several connections (multiple tabs/devices), so presence is
   * "at least one live socket" rather than a boolean flag that a second tab
   * closing would wrongly clear.
   */
  private readonly connections = new Map<string, Map<string, RegisteredConnection>>();

  register(userId: string, connectionId: string, connection: RegisteredConnection): void {
    if (!userId || !connectionId) return;

    let perUser = this.connections.get(userId);
    if (!perUser) {
      perUser = new Map<string, RegisteredConnection>();
      this.connections.set(userId, perUser);
    }
    perUser.set(connectionId, connection);
  }

  unregister(userId: string, connectionId: string): void {
    const perUser = this.connections.get(userId);
    if (!perUser) return;

    perUser.delete(connectionId);
    // Drop the outer entry too, so `isOnline` never reports true for an empty
    // map and the structure cannot grow unbounded across reconnect churn.
    if (perUser.size === 0) {
      this.connections.delete(userId);
    }
  }

  isOnline(userId: string): boolean {
    const perUser = this.connections.get(userId);
    if (!perUser) return false;

    for (const connection of perUser.values()) {
      if (connection.isOpen()) return true;
    }
    return false;
  }

  onlineAmong(userIds: string[]): string[] {
    return userIds.filter((userId) => this.isOnline(userId));
  }

  publishToUsers(userIds: string[], event: string, payload: unknown): number {
    // Serialise once, not per socket.
    let frame: string;
    try {
      frame = JSON.stringify({ event, data: payload });
    } catch (err) {
      this.logger.warn({ err, event }, 'Failed serialising messaging frame');
      return 0;
    }

    let delivered = 0;
    // A user may appear twice in the input (e.g. duplicated member row); the Set
    // keeps every socket from receiving the same event twice.
    for (const userId of new Set(userIds)) {
      const perUser = this.connections.get(userId);
      if (!perUser) continue;

      for (const [connectionId, connection] of perUser) {
        if (!connection.isOpen()) {
          // Reap sockets that closed without firing their handler.
          perUser.delete(connectionId);
          continue;
        }

        try {
          connection.send(frame);
          delivered += 1;
        } catch (err) {
          // A failed write is never fatal: the message is already committed and
          // the client will recover it on reconnect.
          this.logger.debug({ err, event }, 'Dropped messaging frame for a closed socket');
          perUser.delete(connectionId);
        }
      }

      if (perUser.size === 0) this.connections.delete(userId);
    }

    return delivered;
  }
}
