import { Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationPublisher, resolveRabbitMqUrl } from './notification.publisher';

/**
 * Phase ARCH-2: the publisher may not invent a broker.
 *
 * The implementation this file replaces read
 * `process.env.RABBITMQ_URL || 'amqp://…:…@rabbitmq:5672'`: a hard-coded credential in
 * source, and a silent connection attempt to a host that nobody configured. These tests
 * pin the replacement from the outside — the URL is the configured URL or nothing, an
 * unconfigured broker is reported as a FAILED publish rather than a success, and no
 * credential is ever synthesised.
 *
 * `amqp-connection-manager` is mocked because the question is "what would this process
 * have connected to?", which no real broker can answer.
 */

const mockConnect = jest.fn();
const mockPublish = jest.fn();

jest.mock('amqp-connection-manager', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

interface CapturedChannelOptions {
  json?: boolean;
  setup?: (channel: { assertExchange: jest.Mock }) => Promise<void>;
}

describe('NotificationPublisher', () => {
  const saved = new Map<string, string | undefined>();
  const ENV_KEYS = ['RABBITMQ_URL', 'PUBLISH_TIMEOUT_MS'];

  let channelOptions: CapturedChannelOptions | undefined;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }

    channelOptions = undefined;
    mockConnect.mockReset();
    mockPublish.mockReset();
    mockPublish.mockResolvedValue(true);
    mockConnect.mockImplementation(() => ({
      createChannel: (options: CapturedChannelOptions) => {
        channelOptions = options;
        return { publish: mockPublish };
      },
    }));

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    jest.restoreAllMocks();
  });

  const prismaStub = () => ({
    auditDispatch: { create: jest.fn(async () => undefined) },
  });

  const publisherWith = (prisma?: unknown) =>
    new NotificationPublisher(prisma as PrismaService | undefined);

  /** Everything this process asked to connect to, flattened for inspection. */
  const connectArguments = () => JSON.stringify(mockConnect.mock.calls);

  describe('resolveRabbitMqUrl', () => {
    it('returns the configured value, trimmed', () => {
      expect(resolveRabbitMqUrl({ RABBITMQ_URL: '  amqp://broker.internal:5672  ' })).toBe(
        'amqp://broker.internal:5672'
      );
    });

    it('returns null — not a default — when the variable is absent, empty or blank', () => {
      expect(resolveRabbitMqUrl({})).toBeNull();
      expect(resolveRabbitMqUrl({ RABBITMQ_URL: '' })).toBeNull();
      expect(resolveRabbitMqUrl({ RABBITMQ_URL: '   ' })).toBeNull();
    });
  });

  describe('connection', () => {
    it('connects to exactly the configured URL, once', () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';

      publisherWith();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockConnect.mock.calls[0][0]).toEqual(['amqp://broker.internal:5672']);
    });

    it('does not connect at all when RABBITMQ_URL is unset', () => {
      publisherWith();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(connectArguments()).toBe('[]');
    });

    it('declares the domain_events topic exchange whenever a channel is (re)created', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      const assertExchange = jest.fn(async () => undefined);

      publisherWith();
      await channelOptions?.setup?.({ assertExchange });

      expect(channelOptions?.json).toBe(true);
      expect(assertExchange).toHaveBeenCalledWith('domain_events', 'topic', { durable: true });
    });
  });

  describe('publish', () => {
    it('publishes to the domain_events exchange when a broker is configured', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      const publisher = publisherWith(prismaStub());

      await publisher.publish('audit.created', { auditId: 'a1' });

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish.mock.calls[0].slice(0, 2)).toEqual(['domain_events', 'audit.created']);
    });

    it('reports an unconfigured broker as a failed publish, never as a silent success', async () => {
      const prisma = prismaStub();
      const publisher = publisherWith(prisma);

      await expect(publisher.publish('audit.created', { auditId: 'a1' })).resolves.toBeUndefined();

      expect(mockPublish).not.toHaveBeenCalled();
      expect(connectArguments()).toBe('[]');
      // The retry is recorded exactly as it is for a broker that is configured but down.
      expect(prisma.auditDispatch.create).toHaveBeenCalledWith({ data: { auditId: 'a1' } });
      expect(JSON.stringify(warnSpy.mock.calls)).toContain('RABBITMQ_URL');
    });

    it('records an auditDispatch retry when the broker rejects the publish', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      mockPublish.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const prisma = prismaStub();
      const publisher = publisherWith(prisma);

      await expect(publisher.publish('audit.created', { auditId: 'a2' })).resolves.toBeUndefined();

      expect(prisma.auditDispatch.create).toHaveBeenCalledWith({ data: { auditId: 'a2' } });
    });

    it('records an auditDispatch retry when the publish times out', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      process.env.PUBLISH_TIMEOUT_MS = '20';
      mockPublish.mockImplementation(() => new Promise(() => undefined));
      const prisma = prismaStub();
      const publisher = publisherWith(prisma);

      await expect(publisher.publish('audit.created', { auditId: 'a3' })).resolves.toBeUndefined();

      expect(prisma.auditDispatch.create).toHaveBeenCalledWith({ data: { auditId: 'a3' } });
    });

    it('records nothing when the event carries no auditId', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      mockPublish.mockRejectedValue(new Error('down'));
      const prisma = prismaStub();
      const publisher = publisherWith(prisma);

      await publisher.publish('user.login', { userId: 'u1' });

      expect(prisma.auditDispatch.create).not.toHaveBeenCalled();
    });

    it('resolves, and says so, when this process has no Core database for the retry record', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      mockPublish.mockRejectedValue(new Error('down'));
      const publisher = publisherWith();

      await expect(publisher.publish('audit.created', { auditId: 'a4' })).resolves.toBeUndefined();

      expect(JSON.stringify(warnSpy.mock.calls)).toContain('No Core database available');
    });

    it('resolves even when recording the retry record itself fails', async () => {
      process.env.RABBITMQ_URL = 'amqp://broker.internal:5672';
      mockPublish.mockRejectedValue(new Error('down'));
      const prisma = {
        auditDispatch: {
          create: jest.fn(async () => {
            throw new Error('database gone');
          }),
        },
      };
      const publisher = publisherWith(prisma);

      await expect(publisher.publish('audit.created', { auditId: 'a5' })).resolves.toBeUndefined();
    });

    it('never sends a credential it was not configured with', async () => {
      // The regression this file exists for: an unset RABBITMQ_URL must never become a
      // connection attempt to a built-in host, and no password may appear in a connect
      // argument under any configuration.
      for (const configuration of ['', '   ']) {
        mockConnect.mockClear();
        process.env.RABBITMQ_URL = configuration;

        const publisher = publisherWith();
        await publisher.publish('audit.created', { auditId: 'a6' });

        expect(connectArguments()).toBe('[]');
        expect(connectArguments()).not.toMatch(/aria_password|amqp:\/\//i);
      }

      // `delete` is how an environment variable is actually unset: assigning `undefined`
      // would store the string "undefined", which is a host name no one configured.
      mockConnect.mockClear();
      delete process.env.RABBITMQ_URL;

      publisherWith();

      expect(connectArguments()).toBe('[]');
    });
  });
});
