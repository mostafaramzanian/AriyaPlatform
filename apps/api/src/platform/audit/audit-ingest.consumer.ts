import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AmqpConnectionManager, Channel, ChannelWrapper, connect } from 'amqp-connection-manager';
import { resolveRabbitMqUrl } from '../../notifications/notification.publisher';
import {
  AUDIT_BINDING_PATTERN,
  AUDIT_EXCHANGE,
  AUDIT_INGEST_QUEUE,
  AUDIT_PORT,
  validateAuditEvent,
  type AuditPort,
} from './audit.contract';

/**
 * What the broker should be told about one delivered message.
 *
 * A closed set, and the ack policy follows from it rather than being decided inline: an event
 * that can never become valid must be DROPPED (a poison envelope requeued forever is an
 * outage), while a write that failed for an environmental reason must be RETRIED.
 */
export type AuditIngestAction = 'recorded' | 'duplicate' | 'conflict' | 'dropped' | 'retry';

/**
 * The only part of an amqplib delivery this consumer names.
 *
 * Declared structurally instead of imported, and that is forced rather than preferred:
 * `src/types/amqplib.d.ts` is a bare `declare module 'amqplib'`, so `Channel` resolves to
 * `any` and a `channel.consume` callback parameter has no contextual type. Naming the
 * delivery keeps the acknowledgement path typed — the one place where a mistake means a lost
 * or an endlessly redelivered audit event, and therefore the last place that should be
 * `any` by accident.
 *
 * `content` IS BYTES. `ChannelWrapper`'s `json` option — set on the channel below — tells it
 * to `JSON.stringify` what this process PUBLISHES; it does not decode what this process
 * CONSUMES, and `JSON.parse` appears nowhere in it. So the body is decoded once, explicitly,
 * by `decodeAuditDelivery`.
 */
interface AuditDelivery {
  content: Buffer;
}

/**
 * The body of one delivery, DECODED — or a refusal, when the bytes are not JSON.
 *
 * WHY THIS FUNCTION IS THE WHOLE POINT, AND WHY THE FIRST VERSION OF THIS FILE WAS USELESS
 * -------------------------------------------------------------------------------------
 * `json: true` reads like "this channel speaks JSON, both ways". It does not: it is a
 * publish-side option, so `message.content` arrives as the raw Buffer amqplib read off the
 * socket. Passing that Buffer to `validateAuditEvent` — which asks an OBJECT for a
 * `contract` field — fails the envelope check every time, and the failure is the quietest
 * one possible: `consume` returns `dropped`, the callback ACKS, and `record` is never
 * called. The queue drains, the trail stays empty, nothing is retried, and the only visible
 * trace is a rejection log that looks like a misbehaving publisher.
 *
 * A parsed object is accepted unchanged, because that is the shape a direct caller supplies
 * (`consumer.consume(envelope)`), and a `string` body is decoded as UTF-8 rather than being
 * rejected only because amqplib happened to throw a Buffer at us.
 *
 * A body that will not parse is POISON, not a retryable fault: the same bytes are on the
 * queue and will not become JSON on a later attempt, so the caller drops and acks it —
 * exactly the policy a legacy envelope gets, for exactly the same reason.
 */
function decodeAuditDelivery(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (!Buffer.isBuffer(value) && typeof value !== 'string') return { ok: true, value };

  try {
    return { ok: true, value: JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value) };
  } catch {
    return { ok: false };
  }
}

/**
 * How many unacknowledged events one Core process holds.
 *
 * Small on purpose: ingest is a database write per event, so in-flight depth buys throughput
 * only while the database keeps up, and beyond that it is memory. The consumer is not on any
 * request path — nothing waits for it.
 */
const AUDIT_MAX_IN_FLIGHT = 10;

/**
 * Phase ARCH-3B (§12/§13/§14): the `platform.audit@v1` CONSUMER.
 *
 * WHAT IT CONSUMES. `domain_events` (the topic exchange this platform already uses), queue
 * `platform.audit.ingest`, binding `audit.#` — the same prefix the legacy `AuditService`
 * publishes on, deliberately, so a module's audit traffic is on one binding rather than two. A
 * message is ingested only if it satisfies `platform.audit@v1`; legacy traffic has no
 * `contract` field and is therefore DROPPED with `AUDIT_CONTRACT_MISMATCH` instead of being
 * written a second time (the legacy row already exists).
 *
 * AT-LEAST-ONCE, AND WHAT THAT COSTS. Delivery is at-least-once, so the same event may arrive
 * more than once; `PlatformAuditService.record` recognises the replay by `auditId` and compares
 * payloads, which is why the consumer acks a duplicate as SUCCESS and must NOT ack silently in
 * any other case. Both outcomes are logged with their own stage, so "the trail is quiet" and
 * "the consumer is broken" are different observations.
 *
 * IT OWNS NO CREDENTIAL AND NO TENANCY RULE. The body is decoded from the delivered bytes
 * (`decodeAuditDelivery`, one place), then the ENVELOPE is judged by the contract's own
 * `validateAuditEvent`, and the tenant comes only from the event body (§21: nothing here
 * reads a tenant from a header, from the connection or from anywhere else, and
 * `AuditEventInput` cannot express "no tenant").
 *
 * THE BROKER IS OPTIONAL, THE HONESTY IS NOT. `RABBITMQ_URL` unset is a supported
 * configuration — every runtime policy lists `rabbitmq` as optional. In that case this consumer
 * does not start, says so at warn level, and attempts no connection to a host nobody
 * configured. Same rule, same helper (`resolveRabbitMqUrl`) as `NotificationPublisher`, so the
 * two cannot disagree about what "configured" means.
 */
@Injectable()
export class AuditIngestConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditIngestConsumer.name);

  /** Null is a STATE ("this process has no broker"), never an error to be recovered from. */
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;

  constructor(@Inject(AUDIT_PORT) private readonly audit: AuditPort) {}

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    // Closing the connection is what makes shutdown observable rather than a silent drop of
    // whatever was prefetched but not yet consumed.
    await this.connection?.close().catch(() => undefined);
    this.connection = null;
    this.channel = null;
  }

  /** Idempotent, so a test or a future re-connect can call it without counting channels. */
  start(): void {
    if (this.channel) return;

    const url = resolveRabbitMqUrl();

    if (!url) {
      this.logger.warn(
        { stage: 'consumer.unconfigured' },
        'RABBITMQ_URL is not configured: this process will not ingest platform audit events'
      );
      return;
    }

    this.connection = connect([url]);
    this.channel = this.connection.createChannel({
      // PUBLISH-SIDE ONLY, and set for that reason: this process publishes nothing today, but if it
      // ever does, the body is JSON. It does NOT decode what is consumed — `consume` below receives
      // raw bytes and decodes them itself (`decodeAuditDelivery`), which is why that function exists.
      json: true,
      setup: async (channel: Channel) => {
        await channel.assertExchange(AUDIT_EXCHANGE, 'topic', { durable: true });
        await channel.assertQueue(AUDIT_INGEST_QUEUE, { durable: true });
        await channel.bindQueue(AUDIT_INGEST_QUEUE, AUDIT_EXCHANGE, AUDIT_BINDING_PATTERN);

        // A BOUND on in-flight messages: without one, a slow Core database lets the broker push
        // an unbounded number of unacked events into this process's memory.
        await channel.prefetch(AUDIT_MAX_IN_FLIGHT);

        await channel.consume(AUDIT_INGEST_QUEUE, (message: AuditDelivery | null) => {
          // amqplib delivers null on consumer cancellation. Nothing to ack.
          if (!message) return;

          void this.consume(message.content).then(
            (action) => {
              if (action === 'retry') channel.nack(message, false, true);
              else channel.ack(message);
            },
            (err) => {
              // `consume` does not throw for anything it understands, so reaching here means an
              // unexpected failure: retry it rather than discarding an audit event.
              this.logger.error({ err, stage: 'consume.unexpected' }, 'Audit ingest failed');
              channel.nack(message, false, true);
            }
          );
        });
      },
    });
  }

  /**
   * Handles ONE delivered message. Public and broker-free so the at-least-once behaviour can be
   * tested without a broker, which is the only way to test it deterministically.
   */
  async consume(value: unknown): Promise<AuditIngestAction> {
    // (1) THE WIRE. Bytes in, value out — before any rule is applied, because every rule
    // below is about an OBJECT and a Buffer satisfies none of them by accident.
    const decoded = decodeAuditDelivery(value);

    if (!decoded.ok) {
      this.logger.error(
        { code: 'AUDIT_ENVELOPE_INVALID', stage: 'consume.rejected', body: 'unparseable' },
        'Dropped a message on the audit binding whose body is not JSON'
      );
      return 'dropped';
    }

    // (2) THE ENVELOPE, through the contract's own validator — the same function the
    // in-process writer uses, so "the tenant is required" is one rule and not two.
    const validation = validateAuditEvent(decoded.value);

    if (!validation.ok) {
      this.logger.error(
        { code: validation.code, stage: 'consume.rejected' },
        'Dropped a message on the audit binding that is not a platform.audit@v1 event'
      );
      return 'dropped';
    }

    const result = await this.audit.record(validation.event);

    if (result.status === 'rejected') {
      // A transient write failure is retried; a contract rejection cannot be fixed by retrying,
      // and that branch is unreachable here — the envelope was validated above.
      return result.code === 'AUDIT_WRITE_FAILED' ? 'retry' : 'dropped';
    }

    return result.status;
  }
}
