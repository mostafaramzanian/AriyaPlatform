import { Injectable, Logger, Optional } from '@nestjs/common';
import { AmqpConnectionManager, Channel, ChannelWrapper, connect } from 'amqp-connection-manager';
import { PrismaService } from '../database/prisma.service';

/**
 * Phase ARCH-2: the AMQP URL of this process — the configured value, or nothing.
 *
 * `RABBITMQ_URL` is optional in `env.validation.ts` and `rabbitmq` is `optional` in every
 * runtime's policy, so an unset value is a supported configuration. It is NOT a reason to
 * invent a broker: the previous implementation fell back to a literal
 * `amqp://<user>:<password>@rabbitmq:5672`, which was both a hard-coded credential in
 * source and a silent connection attempt to a host nobody configured. An unset variable
 * now means "this process has no broker", and the publisher says exactly that.
 */
export function resolveRabbitMqUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RABBITMQ_URL?.trim();
  return value ? value : null;
}

/**
 * The `auditId` of an audit event, or null.
 *
 * Narrowed here so `publish` can accept an opaque payload: the only thing this publisher
 * is allowed to understand about an event is which audit record a retry belongs to.
 */
function auditIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { auditId?: unknown }).auditId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

@Injectable()
export class NotificationPublisher {
  private logger = new Logger(NotificationPublisher.name);

  /**
   * The `domain_events` channel of this process, or null when no broker is configured.
   *
   * Null is a STATE, not an error: it is what keeps "this process was never given a
   * broker" distinguishable from "the broker is down", and every publish path below
   * handles it explicitly rather than pretending a message was delivered.
   */
  private channel: ChannelWrapper | null = null;

  // Phase 33K: `prisma` (Core) is only used below as a best-effort fallback to
  // persist an AuditDispatch retry record when a publish fails. It is not
  // required for publishing itself. Marking it @Optional() lets this service
  // be composed in a CMS-only process (no Core PrismaService available)
  // without breaking DI; the fallback simply becomes a no-op (already logged
  // via `logger.error` below) instead of the module graph failing to resolve.
  constructor(@Optional() private readonly prisma?: PrismaService) {
    const url = resolveRabbitMqUrl();
    if (!url) {
      this.logger.warn(
        { stage: 'publisher.unconfigured' },
        'RABBITMQ_URL is not configured: this process will not publish domain events'
      );
      return;
    }

    const connection: AmqpConnectionManager = connect([url]);
    this.channel = connection.createChannel({
      json: true,
      setup: async (channel: Channel) => {
        await channel.assertExchange('domain_events', 'topic', { durable: true });
      },
    });
  }

  async publish(eventType: string, payload: unknown): Promise<void> {
    const ts = Date.now();
    const timeoutMs = Number(process.env.PUBLISH_TIMEOUT_MS) || 2000;
    this.logger.debug({ eventType, ts, stage: 'publish.start', timeoutMs }, 'NotificationPublisher.publish start');

    if (!this.channel) {
      // Reported as a publish FAILURE, never as a success: whether the broker is missing
      // or down, an audit event that could not be published must not vanish silently, and
      // no connection may be attempted to a host that was never configured.
      this.logger.warn(
        { eventType, stage: 'publish.unconfigured' },
        'RABBITMQ_URL is not configured - event not published'
      );
      await this.recordAuditDispatchRetry(eventType, payload);
      return;
    }

    /**
     * The message properties this publisher sets.
     *
     * `amqp-connection-manager` types the fourth argument of `publish()` as its own
     * `PublishOptions`, which resolves to `{ timeout?: number }` in this repository:
     * amqplib ships no type declarations (`src/types/amqplib.d.ts` shims the module), so
     * the interface it extends has no members: the declared type is the publish
     * signature's own options parameter, and the property is asserted rather than
     * dropped — `deliveryMode: 2` is amqplib's persistent delivery
     * (`node_modules/amqplib/lib/api_args.js`), which is how this publisher has always
     * sent its domain events.
     */
    const publishOptions = { deliveryMode: 2 } as Parameters<ChannelWrapper['publish']>[3];

    const publishPromise = this.channel.publish(
      'domain_events',
      eventType,
      Buffer.from(JSON.stringify(payload)),
      publishOptions
    );
    let publishTimeout: NodeJS.Timeout | undefined;

    try {
      // Fail-fast: wait for publish or timeout. On timeout/reject, let caller handle persisting a retry/dispatch.
      await Promise.race([
        publishPromise,
        new Promise((_resolve, reject) => {
          publishTimeout = setTimeout(() => reject(new Error('PublishTimeout')), timeoutMs);
        }),
      ]);

      const doneTs = Date.now();
      this.logger.debug({ eventType, doneTs, stage: 'publish.done', durationMs: doneTs - ts }, 'NotificationPublisher.publish completed');
      this.logger.log(`Published event ${eventType}`);
    } catch (e) {
      const errTs = Date.now();
      const msg = (e as Error)?.message ?? String(e);
      this.logger.warn({ eventType, errAt: errTs, err: msg }, 'Publish failed or timed out - failing fast');

      await this.recordAuditDispatchRetry(eventType, payload);

      // Do not throw to avoid bubbling errors into HTTP request — return control to caller immediately.
      return;
    } finally {
      // A publish that answered must not leave its timer behind: an uncleared timer holds
      // the event loop — and therefore a graceful shutdown — for the rest of the window.
      if (publishTimeout) clearTimeout(publishTimeout);
    }
  }

  /**
   * Best-effort persistence of an AuditDispatch retry record.
   *
   * Phase 33K behaviour, kept intact: a publish that did not happen records a retry when
   * this process has a Core database, logs when it does not, and never throws — a
   * publisher failure must not turn into an HTTP failure.
   */
  private async recordAuditDispatchRetry(eventType: string, payload: unknown): Promise<void> {
    const auditId = auditIdOf(payload);
    if (!auditId) return;

    if (!this.prisma) {
      this.logger.warn(
        { eventType, auditId },
        'No Core database available in this process to record auditDispatch retry'
      );
      return;
    }

    try {
      await this.prisma.auditDispatch.create({ data: { auditId } });
      this.logger.debug({ eventType, auditId }, 'Inserted auditDispatch due to publish failure');
    } catch (e2) {
      this.logger.error({ eventType, e2 }, 'Failed to insert auditDispatch record');
    }
  }
}
