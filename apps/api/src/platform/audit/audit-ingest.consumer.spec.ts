import { Logger } from '@nestjs/common';
import {
  AUDIT_BINDING_PATTERN,
  AUDIT_EXCHANGE,
  AUDIT_INGEST_QUEUE,
  PLATFORM_AUDIT_CONTRACT,
  type AuditEventInput,
  type AuditPort,
} from './audit.contract';
import { AuditIngestConsumer } from './audit-ingest.consumer';

/**
 * Phase ARCH-3B (§12/§13/§14): the `platform.audit@v1` CONSUMER, with no broker and no database.
 *
 * WHY THERE IS NO REAL BROKER HERE, AND WHY THAT IS THE POINT
 * ----------------------------------------------------------
 * The decisions this file pins are ACK POLICY decisions — what the broker is told about one delivery.
 * A real RabbitMQ can only show them indirectly, through redelivery timing, and it cannot show them at
 * all for the case that matters most: a message whose content can never become valid. `consume()` is
 * public precisely so this file can ask "given this delivery, ack, nack-and-requeue, or neither?"
 * without a socket, and `amqp-connection-manager` is mocked so the ONE wiring claim — that an
 * unconfigured broker is never dialled — is observable as an argument list instead of as a log line
 * nobody reads.
 *
 * THE FOUR CLAIMS
 * ---------------
 *  1. AN UNCONFIGURED BROKER IS A SUPPORTED CONFIGURATION. Every runtime policy lists `rabbitmq` as
 *     optional, so `RABBITMQ_URL` unset must mean "no connection attempt, warn once, keep running"
 *     rather than a retry loop against a default host. `start()` is idempotent, because a consumer that
 *     opened a second channel on every call would multiply prefetch depth and double-ingest.
 *  2. POISON IS DROPPED, ENVIRONMENTAL FAILURE IS RETRIED. A legacy event (no `contract`) can never
 *     become valid: requeueing it is an infinite redelivery hot loop, and the legacy row it duplicates
 *     already exists. A write that failed because the database was unreachable is the opposite — the
 *     event is valid and the failure is transient, so it MUST be requeued or the trail loses a row that
 *     nothing else will ever resend. `nack(message, false, true)` versus `ack(message)` is therefore
 *     asserted as an ARGUMENT, not as an outcome.
 *  3. A REPLAY IS SUCCESS. Delivery is at-least-once, so `duplicate` and `conflict` are ACKED: the row
 *     exists exactly once (which is what the trail promised) and an alarm has been logged. Nacking
 *     either would redeliver forever, turning an idempotency guarantee into an outage.
 *  4. NOTHING HERE INTERPRETS A TENANT. The envelope is validated by `validateAuditEvent` and the
 *     tenant travels in the body (§21); this consumer reads no header and parses no connection string,
 *     so there is nothing here that could be mistaken for a second tenancy rule.
 */

const mockConnect = jest.fn();
const mockCreateChannel = jest.fn();

jest.mock('amqp-connection-manager', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

/** The channel the consumer's `setup` receives, as the mock supplies it. */
interface CapturedChannelOptions {
  json?: boolean;
  setup?: (channel: FakeChannel) => Promise<void>;
}

interface FakeChannel {
  assertExchange: jest.Mock;
  assertQueue: jest.Mock;
  bindQueue: jest.Mock;
  prefetch: jest.Mock;
  consume: jest.Mock;
  ack: jest.Mock;
  nack: jest.Mock;
}

/** A valid `platform.audit@v1` event, as a producer supplies it. */
const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  auditId: '3f6b1a1e-5f2c-4d4b-8c3a-9d0e1f2a3b4c',
  tenantId: 'tenant-north',
  requestId: 'req-1',
  actorId: 'user-1',
  action: 'CREATE',
  resource: 'employee',
  resourceId: 'emp-1',
  ...overrides,
});

/** The envelope as it travels, i.e. input + capability descriptor. */
const envelope = (overrides: Partial<AuditEventInput> = {}) => ({
  ...event(overrides),
  contract: PLATFORM_AUDIT_CONTRACT,
});

describe('AuditIngestConsumer', () => {
  const saved = new Map<string, string | undefined>();
  const ENV_KEYS = ['RABBITMQ_URL'];

  let audit: { record: jest.Mock };
  let consumer: AuditIngestConsumer;
  let channelOptions: CapturedChannelOptions | undefined;
  let fakeChannel: FakeChannel;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  /** The callback the consumer registered, i.e. the only place ack versus nack is decided. */
  let onMessage: ((message: { content: Buffer } | null) => void) | undefined;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    channelOptions = undefined;
    onMessage = undefined;
    mockConnect.mockReset();
    mockCreateChannel.mockReset();
    audit = {
      record: jest.fn(async () => ({ status: 'recorded', auditId: '', auditLogId: 'log-1' })),
    };

    fakeChannel = {
      assertExchange: jest.fn(async () => undefined),
      assertQueue: jest.fn(async () => undefined),
      bindQueue: jest.fn(async () => undefined),
      prefetch: jest.fn(async () => undefined),
      consume: jest.fn(async (_queue: string, cb: typeof onMessage) => {
        onMessage = cb ?? undefined;
      }),
      ack: jest.fn(),
      nack: jest.fn(),
    };

    mockCreateChannel.mockImplementation((options: CapturedChannelOptions) => {
      channelOptions = options;
      return { publish: jest.fn() };
    });
    mockConnect.mockImplementation(() => ({
      createChannel: mockCreateChannel,
      close: jest.fn(async () => undefined),
    }));

    consumer = new AuditIngestConsumer(audit as unknown as AuditPort);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    jest.restoreAllMocks();
  });

  /** Runs `start()` and the channel `setup`, so every broker assertion below sees a live channel. */
  const startWithBroker = async (url = 'amqp://broker.internal:5672') => {
    process.env.RABBITMQ_URL = url;
    consumer.start();
    await channelOptions?.setup?.(fakeChannel);
  };

  /** Delivers one message to the registered callback and lets the decision settle. */
  const deliver = async (payload: unknown) => {
    onMessage?.({ content: Buffer.from(JSON.stringify(payload)) });
    // `consume()` is `void`ed inside the callback and then `.then`ed, so one macrotask is enough for
    // the ack/nack decision to have been taken.
    await new Promise((resolve) => setImmediate(resolve));
  };

  /**
   * Delivers bytes that were never JSON to begin with.
   *
   * Separate from `deliver`, which `JSON.stringify`s its argument — so `deliver('{ oops')` would send
   * a valid JSON *string* and never reach the decode failure this exercises.
   */
  const deliverRaw = async (bytes: string) => {
    onMessage?.({ content: Buffer.from(bytes) });
    await new Promise((resolve) => setImmediate(resolve));
  };

  describe('an unconfigured broker is a SUPPORTED configuration', () => {
    it('never dials anything, and says so at warn level', () => {
      consumer.start();

      // The claim is about ARGUMENTS: `connect` was called with nothing at all, so no default host,
      // no synthesised credential and no vhost can have been invented here.
      expect(mockConnect).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'consumer.unconfigured' }),
        expect.any(String)
      );
    });

    it('is idempotent: a second start does not open a second channel', async () => {
      await startWithBroker();

      consumer.start();
      consumer.start();

      // One channel per process, not one per call. A duplicate channel would double the prefetch
      // depth and let two consumers ingest the same queue.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCreateChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('the broker wiring (§12)', () => {
    it('declares exactly the exchange, queue and binding the ADR records', async () => {
      await startWithBroker();

      expect(mockConnect).toHaveBeenCalledWith(['amqp://broker.internal:5672']);
      // `durable` on both: an audit event must survive a broker restart, and the exchange is the one
      // this platform already uses — re-declaring it non-durable would be a breaking change.
      expect(fakeChannel.assertExchange).toHaveBeenCalledWith(AUDIT_EXCHANGE, 'topic', {
        durable: true,
      });
      expect(fakeChannel.assertQueue).toHaveBeenCalledWith(AUDIT_INGEST_QUEUE, { durable: true });
      expect(fakeChannel.bindQueue).toHaveBeenCalledWith(
        AUDIT_INGEST_QUEUE,
        AUDIT_EXCHANGE,
        AUDIT_BINDING_PATTERN
      );
    });

    it('bounds in-flight messages, so a slow database cannot become unbounded memory', async () => {
      await startWithBroker();

      // The assertion is that SOME positive bound is set, because the failure it prevents — the broker
      // pushing every unacked event into this process — is invisible until the process dies.
      expect(fakeChannel.prefetch.mock.calls[0][0]).toBeGreaterThan(0);
      expect(fakeChannel.consume).toHaveBeenCalledWith(AUDIT_INGEST_QUEUE, expect.any(Function));
    });

    it('closes the connection on destroy, and tolerates destroying twice', async () => {
      await startWithBroker();
      const connection = mockConnect.mock.results[0].value as { close: jest.Mock };

      await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
      expect(connection.close).toHaveBeenCalled();

      // Second destroy: the connection is already null, so nothing is called and nothing throws.
      await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  /**
   * CLAIMS 2 AND 3, WHICH ARE THE EXPENSIVE ONES.
   *
   * The ack policy is the only place this consumer can lose an audit event or create an outage, and
   * both failures are silent from inside the process: a wrongly-acked write failure loses a row that
   * nothing will ever resend, and a wrongly-nacked poison envelope redelivers forever as an unlogged
   * hot loop. Neither is visible in a unit test of `record()`, because both are decisions about the
   * BROKER — so every assertion below is on `ack`/`nack` and on their ARGUMENTS.
   */
  describe('the ack policy: what the broker is told (§13/§14)', () => {
    beforeEach(async () => {
      await startWithBroker();
    });

    /** The arguments of the single `nack` this delivery produced, minus the message itself. */
    const nackArgs = () => fakeChannel.nack.mock.calls[0].slice(1) as [boolean, boolean];

    it('acks a valid event, after passing it to the port unchanged', async () => {
      await deliver(envelope());

      expect(audit.record).toHaveBeenCalledWith(envelope());
      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
    });

    it('DROPS a legacy event — it acks, so a poison envelope is not redelivered forever', async () => {
      // THE CASE THAT CANNOT BECOME VALID. `AuditService` publishes on the same `audit.#` binding
      // without a `contract` field, and its row is already in `AuditLog`. Requeueing this would be an
      // infinite hot loop against a message that will never be accepted on any later attempt.
      await deliver(event());

      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();

      // And it was NOT written: the legacy producer's row already exists, so a second write here would
      // be the duplicate this rule exists to prevent.
      expect(audit.record).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'AUDIT_CONTRACT_MISMATCH', stage: 'consume.rejected' }),
        expect.any(String)
      );
    });

    it('drops a tenant-less event rather than signing a tenant in for it (§21)', async () => {
      // The tempting "repair" would be to take the tenant from a header or from the connection. That is
      // the second tenancy rule §21 forbids, and it is what this test refuses.
      await deliver({ ...event(), contract: PLATFORM_AUDIT_CONTRACT, tenantId: '' });

      expect(audit.record).not.toHaveBeenCalled();
      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
    });

    it('RETRIES an environmental write failure, with requeue set', async () => {
      // Losing this one is unrecoverable: the event is valid, the failure is transient, and no other
      // actor will ever resend it. `nack(message, false, TRUE)` — the third argument is the assertion.
      audit.record.mockResolvedValueOnce({
        status: 'rejected',
        auditId: event().auditId,
        auditLogId: null,
        code: 'AUDIT_WRITE_FAILED',
      });

      await deliver(envelope());

      expect(fakeChannel.ack).not.toHaveBeenCalled();
      expect(fakeChannel.nack).toHaveBeenCalledTimes(1);
      expect(nackArgs()).toEqual([false, true]);
    });

    it('never requeues a CONTRACT rejection, even though the port should not produce one', async () => {
      // Defence in depth rather than an expected path: the envelope was validated a few lines above, so
      // this branch is unreachable today. If the port's rule and this consumer's ever disagree, the
      // failure must be "drop one event and log it" rather than "redeliver it forever".
      audit.record.mockResolvedValueOnce({
        status: 'rejected',
        auditId: event().auditId,
        auditLogId: null,
        code: 'AUDIT_TENANT_MISSING',
      });

      await deliver(envelope());

      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
    });

    it('ACKS a replay as success, because the row exists exactly once either way', async () => {
      // At-least-once delivery IS the guarantee; `duplicate` is that guarantee working, not an error to
      // recover from. Nacking it would turn every replay into an outage.
      audit.record.mockResolvedValueOnce({
        status: 'duplicate',
        auditId: event().auditId,
        auditLogId: 'log-1',
      });

      await deliver(envelope());

      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
    });

    it('ACKS a conflict too — the alarm is the log line, not an endless redelivery', async () => {
      // One `auditId`, two different payloads, is deterministic: the same message conflicts on every
      // attempt. `record` already raises it at error level, which is the operator-facing signal.
      audit.record.mockResolvedValueOnce({
        status: 'conflict',
        auditId: event().auditId,
        auditLogId: 'log-1',
      });

      await deliver(envelope());

      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
    });

    it('retries an UNEXPECTED failure, and says so, rather than discarding the event', async () => {
      // `consume` does not throw for anything it understands, so reaching this branch means a bug. The
      // safe direction for a bug on an audit path is to keep the event and log loudly.
      audit.record.mockRejectedValueOnce(new Error('port exploded'));

      await deliver(envelope());

      expect(fakeChannel.ack).not.toHaveBeenCalled();
      expect(nackArgs()).toEqual([false, true]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'consume.unexpected' }),
        expect.any(String)
      );
    });

    it('does nothing at all when the broker cancels the consumer', async () => {
      // amqplib delivers null on consumer cancellation. There is no message, so there is nothing to
      // acknowledge — acking a null delivery is how a consumer crashes on shutdown.
      onMessage?.(null);
      await new Promise((resolve) => setImmediate(resolve));

      expect(fakeChannel.ack).not.toHaveBeenCalled();
      expect(fakeChannel.nack).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('decides the same way with no broker at all, which is why `consume` is public', async () => {
      // The same policy read as a return value: this is the seam a future transport (or a different
      // broker) would reuse, so it must not depend on a channel having been created.
      await expect(consumer.consume(envelope())).resolves.toBe('recorded');
      await expect(consumer.consume(event())).resolves.toBe('dropped');
    });
  });

  /**
   * THE WIRE, WHICH IS WHERE THE FIRST VERSION OF THIS CONSUMER WAS BROKEN.
   *
   * `json: true` on the channel is a PUBLISH-side option — it does not decode deliveries — so a
   * Buffer was being handed to `validateAuditEvent`, failing the envelope check, and being ACKED as
   * dropped. Every event lost, nothing retried, and the only trace was a rejection log that looked
   * like a bad publisher. These four cases keep that from returning: the two `deliver` cases go
   * through the real callback with real bytes, and the direct cases pin the decode step's edges.
   */
  describe('the delivered bytes are decoded here, because the channel does not (§12)', () => {
    beforeEach(async () => {
      await startWithBroker();
    });

    it('ingests an event that arrives as BYTES, which is the only way one really arrives', async () => {
      // `deliver` sends `Buffer.from(JSON.stringify(payload))` and only the callback touches it, so
      // this is the end-to-end path: bytes on the socket → `record` called with the parsed event.
      await deliver(envelope());

      expect(audit.record).toHaveBeenCalledWith(envelope());
      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
    });

    it('accepts an already-parsed envelope too, so a direct caller is not a special case', async () => {
      await expect(consumer.consume(envelope())).resolves.toBe('recorded');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ contract: PLATFORM_AUDIT_CONTRACT })
      );
    });

    it('DROPS unparseable bytes — they can never become valid, so they are never requeued', async () => {
      await deliverRaw('{ not json at all');

      expect(audit.record).not.toHaveBeenCalled();
      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'AUDIT_ENVELOPE_INVALID',
          stage: 'consume.rejected',
          body: 'unparseable',
        }),
        expect.any(String)
      );
    });

    it('drops a body that parses to a non-event (a JSON number), rather than retrying it', async () => {
      // `JSON.parse('42')` succeeds, so this exercises the step AFTER the decode: the number reaches
      // the contract and is refused there as a bad envelope — with the OTHER log shape, which is how
      // "bad bytes" and "bad envelope" stay distinguishable to an operator.
      await deliver(42);

      expect(audit.record).not.toHaveBeenCalled();
      expect(fakeChannel.ack).toHaveBeenCalledTimes(1);
      expect(fakeChannel.nack).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'AUDIT_ENVELOPE_INVALID', stage: 'consume.rejected' }),
        expect.any(String)
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ body: 'unparseable' }),
        expect.any(String)
      );
    });
  });
});
