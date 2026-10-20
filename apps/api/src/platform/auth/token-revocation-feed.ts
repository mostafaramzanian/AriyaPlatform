import { Injectable, Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import {
  AmqpConnectionManager,
  Channel,
  ChannelWrapper,
  connect,
} from 'amqp-connection-manager';
import {
  REVOCATION_EVENT_CONTRACT,
  RevocationFeed,
  TokenRevocationRegistry,
  type RevocationFeedStatus,
} from './token-revocation';

/**
 * Phase TARGETED-REMEDIATION (P2): the `platform.revocation@v1` TRANSPORT — the piece
 * ADR-0006 §C left deliberately absent in 51-HR-ARCH-3A.
 *
 * WHAT ARRIVED SINCE. The `platform.*` messaging contracts ARE now implemented:
 * `platform.audit@v1` already rides `domain_events` (topic exchange, durable) into
 * `platform.audit.ingest` (`audit-ingest.consumer.ts`). The revocation feed therefore
 * wires to THE SAME exchange and routing-key convention — but with a PER-INSTANCE,
 * non-durable, autoDelete queue (see `REVOCATION_QUEUE_PREFIX`): audit ingest tolerates
 * competing consumers on one queue (one event processed once), while revocation must
 * reach EVERY replica's in-memory deny-set.
 *
 * THE DIRECTION THAT IS NEW, AND WHY IT IS SAFE. Audit ingest is optional: a lost audit
 * event leaves a hole a report can show. A revocation event is DIFFERENT in one way only
 * — the deny-set entry's TTL already bounds its effect, so a dropped event can never
 * extend a token's life beyond `maxAcceptedTtlSeconds`. The registry's apply() has NO
 * transient failure mode (it is an in-memory, non-throwing write — 'rejected' and
 * 'stale' are terminal states, never a reason to requeue), which is why every delivery
 * is acked once consumed: requeueing a malformed or stale event would be a poison-loop
 * with nothing to gain.
 *
 * THE BROKER IS OPTIONAL, THE REPORT IS NOT — the same rule as the audit consumer.
 * `RABBITMQ_URL` unset means "this process has no broker": the feed reports `unwired`
 * through the registry's snapshot (degrading to the documented `ttl-bound-only`
 * posture, §C2/E9), rather than failing boot or pretending the feed exists.
 *
 * ACK POLICY, IN ONE LINE: consume → decode bytes → `registry.apply` → ack.
 * `apply` never throws by contract; an unexpected throw from inside `consume` is the
 * only path that nacks WITHOUT requeue (the message cannot be fixed by redelivery —
 * the same bytes produce the same exception — and the TTL bound is the backstop).
 */
export const REVOCATION_EXCHANGE = 'domain_events';
export const REVOCATION_ROUTING_KEY = 'platform.revocation';

/**
 * PHASE W3 (multi-replica): the queue name is PER-INSTANCE, never a shared
 * constant. A single named queue on a topic exchange is a WORK QUEUE — the
 * broker distributes each message among its consumers, so N replicas behind
 * one name would each see only ~1/N of revocations while every replica holds
 * its own in-memory deny-set. Instead each process binds its OWN queue
 * (`platform.revocation.ingest.<hostname>-<pid>`), so the exchange delivers
 * every revocation to every instance. The queue is `autoDelete` (it vanishes
 * when the last consumer detaches — including on connection drop) plus an
 * `x-expires` backstop, so a dead replica never leaves a queue accumulating
 * events nobody reads.
 */
export const REVOCATION_QUEUE_PREFIX = 'platform.revocation.ingest';
const REVOCATION_QUEUE_EXPIRY_MS = 120_000;

export function revocationQueueName(instanceId: string): string {
  return `${REVOCATION_QUEUE_PREFIX}.${instanceId}`;
}

/** Small for the same reason as audit's: revocation events are rare, in-flight depth buys memory only. */
const REVOCATION_MAX_IN_FLIGHT = 10;

/** Bytes in, object out — or a refusal. Same poison rule as `decodeAuditDelivery`. */
function decodeRevocationDelivery(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (!Buffer.isBuffer(value) && typeof value !== 'string') return { ok: true, value };

  try {
    return { ok: true, value: JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value) };
  } catch {
    return { ok: false };
  }
}

interface RevocationDelivery {
  content: Buffer;
}

@Injectable()
export class RabbitMqRevocationFeed extends RevocationFeed {
  private readonly logger = new Logger(RabbitMqRevocationFeed.name);

  /** Null is a STATE ("this process has no broker"), never an error to be recovered from. */
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;
  private state: RevocationFeedStatus = 'unwired';
  private detail = 'revocation feed created, not yet started';
  /** Stable per process — hostname + pid, with a random tail for collide-proof test runs. */
  private readonly instanceId = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private readonly registry: TokenRevocationRegistry) {
    super();
    // Until start() proves the subscription is live, the registry must report the
    // feed as absent — "created" is not "wired".
    this.registry.markFeedUnwired(this.detail);
  }

  /** Idempotent: a re-connect or a test can call it without doubling the subscription. */
  async start(): Promise<void> {
    if (this.channel) return;

    const url = process.env.RABBITMQ_URL?.trim();
    if (!url) {
      this.state = 'unwired';
      this.detail = 'RABBITMQ_URL is not configured';
      this.registry.markFeedUnwired(this.detail);
      this.logger.warn(
        { stage: 'feed.unconfigured' },
        `${REVOCATION_EVENT_CONTRACT}: RABBITMQ_URL is not configured — revocation stays ttl-bound-only`,
      );
      return;
    }

    this.state = 'unavailable';
    this.detail = 'connecting';
    this.connection = connect([url]);
    this.connection.on('disconnect', () => {
      this.state = 'unavailable';
      this.detail = 'broker connection lost';
      this.registry.markFeedUnwired(this.detail);
      this.logger.warn(
        { stage: 'feed.disconnected' },
        `${REVOCATION_EVENT_CONTRACT}: broker connection lost — enforcement is ttl-bound-only until it returns`,
      );
    });
    this.channel = this.connection.createChannel({
      // Publish-side only in this channel's lifetime; consumption decodes its own bytes.
      json: true,
      setup: async (channel: Channel) => {
        // Per-instance queue (see REVOCATION_QUEUE_PREFIX): topic exchange →
        // broadcast to every replica's own queue, autoDelete + x-expires so
        // dead consumers leave nothing behind. Non-durable is deliberate: a
        // durable queue would OUTLIVE the instance it belongs to.
        const queue = revocationQueueName(this.instanceId);
        await channel.assertExchange(REVOCATION_EXCHANGE, 'topic', { durable: true });
        await channel.assertQueue(queue, {
          durable: false,
          autoDelete: true,
          arguments: { 'x-expires': REVOCATION_QUEUE_EXPIRY_MS },
        });
        await channel.bindQueue(queue, REVOCATION_EXCHANGE, REVOCATION_ROUTING_KEY);
        await channel.prefetch(REVOCATION_MAX_IN_FLIGHT);
        await channel.consume(queue, (message: RevocationDelivery | null) => {
          if (!message) return; // consumer cancellation — nothing to ack.
          void this.consume(message.content).then(
            () => channel.ack(message),
            (err) => {
              // apply() never throws by contract; reaching here is unexpected — nack
              // WITHOUT requeue: the same bytes would throw the same way again.
              this.logger.error(
                { err, stage: 'consume.unexpected' },
                'Revocation consume failed unexpectedly; dropping the delivery',
              );
              channel.nack(message, false, false);
            },
          );
        });
      },
    });

    try {
      await this.channel.waitForConnect();
    } catch (err) {
      this.state = 'unavailable';
      this.detail = `broker unreachable: ${(err as Error)?.message ?? String(err)}`;
      this.registry.markFeedUnwired(this.detail);
      this.logger.warn(
        { err, stage: 'feed.unavailable' },
        `${REVOCATION_EVENT_CONTRACT}: broker unreachable at start — enforcement is ttl-bound-only`,
      );
      return;
    }

    this.state = 'wired';
    this.detail = 'subscribed';
    this.registry.markFeedWired();
    this.logger.log(
      { queue: revocationQueueName(this.instanceId), binding: REVOCATION_ROUTING_KEY },
      `${REVOCATION_EVENT_CONTRACT}: feed wired on ${REVOCATION_EXCHANGE}`,
    );
  }

  /**
   * Handles ONE delivered message. Public and broker-free so the staleness, expiry and
   * malformed-input behaviour can be tested without a broker — the only deterministic way.
   */
  async consume(value: unknown): Promise<void> {
    const decoded = decodeRevocationDelivery(value);

    if (!decoded.ok) {
      // Poison, not a fault: the same bytes cannot become JSON on redelivery.
      this.logger.warn(
        { stage: 'consume.rejected', body: 'unparseable' },
        `${REVOCATION_EVENT_CONTRACT}: dropped a delivery whose body is not JSON`,
      );
      return;
    }

    const outcome = this.registry.apply(decoded.value);

    // Every outcome is terminal: 'applied' mutates the deny-set, 'stale' and 'rejected'
    // are answered by the contract itself — none of them is a reason to redeliver.
    if (outcome !== 'applied') {
      this.logger.debug(
        { stage: `consume.${outcome}` },
        `${REVOCATION_EVENT_CONTRACT}: event not applied (${outcome})`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    this.channel = null;
    if (this.state === 'wired') {
      this.state = 'unwired';
      this.detail = 'feed stopped';
      this.registry.markFeedUnwired(this.detail);
    }
  }

  status(): { readonly state: RevocationFeedStatus; readonly detail: string } {
    return { state: this.state, detail: this.detail };
  }
}
