/**
 * Phase 49G-5: unit coverage for the presigned download contract.
 *
 * The `minio` Client is mocked so these tests assert what the provider ASKS for —
 * bucket, key, expiry and response headers — without needing a live MinIO. The
 * end-to-end proof that the resulting URL is actually fetchable lives in
 * `test/support.e2e-spec.ts`, which downloads the bytes with no Authorization header.
 */
const presignedGetObject = jest.fn().mockResolvedValue('https://signed.example/object?X-Amz-Signature=abc');
const putObject = jest.fn().mockResolvedValue(undefined);
const bucketExists = jest.fn().mockResolvedValue(true);
const makeBucket = jest.fn().mockResolvedValue(undefined);
const removeObject = jest.fn().mockResolvedValue(undefined);
const constructed: Array<Record<string, unknown>> = [];

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation((options: Record<string, unknown>) => {
    constructed.push(options);
    return { presignedGetObject, putObject, bucketExists, makeBucket, removeObject };
  }),
}));

import {
  DEFAULT_PRESIGNED_EXPIRY_SECONDS,
  MAX_PRESIGNED_EXPIRY_SECONDS,
  MIN_PRESIGNED_EXPIRY_SECONDS,
  MinioProvider,
} from './minio.provider';

describe('MinioProvider (49G-5 presigned download)', () => {
  const original = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    constructed.length = 0;
    process.env.MINIO_BUCKET = 'aria-erp';
    process.env.MINIO_ACCESS_KEY = 'test-access';
    process.env.MINIO_SECRET_KEY = 'test-secret';
    delete process.env.MINIO_PUBLIC_URL;
  });

  afterAll(() => {
    process.env = { ...original };
  });

  describe('signing client', () => {
    it('signs against the internal endpoint when MINIO_PUBLIC_URL is unset', () => {
      new MinioProvider();

      // Only one client is built — there is no separate public host to sign for.
      expect(constructed).toHaveLength(1);
      expect(constructed[0]).toMatchObject({ endPoint: 'minio', port: 9000, useSSL: false });
    });

    it('signs against the browser-reachable host when MINIO_PUBLIC_URL is set', () => {
      process.env.MINIO_PUBLIC_URL = 'http://localhost:9000';
      new MinioProvider();

      // SigV4 covers the Host header, so the public host has to be used at signing time.
      expect(constructed).toHaveLength(2);
      expect(constructed[1]).toMatchObject({ endPoint: 'localhost', port: 9000, useSSL: false });
    });

    it('pins the region on both clients so signing needs no network round-trip', () => {
      process.env.MINIO_PUBLIC_URL = 'http://localhost:9000';
      new MinioProvider();

      // Without an explicit region the SDK resolves the credential scope with a live
      // GetBucketLocation against the SIGNING endpoint, which is the browser host and is
      // usually unreachable from the API container.
      expect(constructed).toHaveLength(2);
      expect(constructed[0]).toMatchObject({ region: 'us-east-1' });
      expect(constructed[1]).toMatchObject({ region: 'us-east-1' });
    });

    it('defaults the port from the scheme', () => {
      process.env.MINIO_PUBLIC_URL = 'https://files.example.com';
      new MinioProvider();

      expect(constructed[1]).toMatchObject({ endPoint: 'files.example.com', port: 443, useSSL: true });
    });

    it('falls back to the internal endpoint on a malformed MINIO_PUBLIC_URL', () => {
      process.env.MINIO_PUBLIC_URL = 'http://';
      new MinioProvider();

      // Degrades to internal-only downloads rather than failing startup.
      expect(constructed).toHaveLength(1);
    });
  });

  describe('getUrl', () => {
    it('presigns against the configured bucket and never exposes the secret', async () => {
      const url = await new MinioProvider().getUrl('support/t/a/report.png');

      expect(presignedGetObject).toHaveBeenCalledWith(
        'aria-erp',
        'support/t/a/report.png',
        DEFAULT_PRESIGNED_EXPIRY_SECONDS,
        {},
      );
      expect(url).not.toContain('test-secret');
    });

    it('clamps the expiry on both ends', async () => {
      const provider = new MinioProvider();

      await provider.getUrl('k', { expirySeconds: 1 });
      expect(presignedGetObject).toHaveBeenLastCalledWith('aria-erp', 'k', MIN_PRESIGNED_EXPIRY_SECONDS, {});

      await provider.getUrl('k', { expirySeconds: 86_400 });
      expect(presignedGetObject).toHaveBeenLastCalledWith('aria-erp', 'k', MAX_PRESIGNED_EXPIRY_SECONDS, {});

      await provider.getUrl('k', { expirySeconds: Number.NaN });
      expect(presignedGetObject).toHaveBeenLastCalledWith('aria-erp', 'k', DEFAULT_PRESIGNED_EXPIRY_SECONDS, {});
    });

    it('pins a safe attachment disposition and content type', async () => {
      await new MinioProvider().getUrl('k', { fileName: 'report.png', mimeType: 'image/png' });

      expect(presignedGetObject).toHaveBeenCalledWith('aria-erp', 'k', DEFAULT_PRESIGNED_EXPIRY_SECONDS, {
        'response-content-disposition': 'attachment; filename="report.png"',
        'response-content-type': 'image/png',
      });
    });

    it('reduces a hostile filename before it reaches the header', async () => {
      await new MinioProvider().getUrl('k', {
        fileName: '../../etc/pa"sswd\r\nX-Injected: 1.png',
        mimeType: 'text/html\r\nX-Injected: 1',
      });

      const headers = presignedGetObject.mock.calls[0][3];
      // Directory components dropped, quote and CRLF neutralised — the header value
      // cannot be broken out of.
      expect(headers['response-content-disposition']).toBe('attachment; filename="pa_sswd__X-Injected__1.png"');
      // A MIME type that is not a clean type/subtype is dropped rather than echoed.
      expect(headers['response-content-type']).toBeUndefined();
    });

    it('rejects a traversing key before signing', async () => {
      await expect(new MinioProvider().getUrl('support/../../secret')).rejects.toThrow('traversal');
      expect(presignedGetObject).not.toHaveBeenCalled();
    });
  });

  it('returns a presigned URL from upload as well', async () => {
    const url = await new MinioProvider().upload('support/t/a/f.png', Buffer.from('x'), 'image/png');

    expect(putObject).toHaveBeenCalled();
    expect(url).toContain('X-Amz-Signature');
  });
});
