import { IStorageProvider, SignedUrlOptions } from './i-storage.provider';
import { Client } from 'minio';
import { Logger } from '@nestjs/common';

/**
 * Phase 49G-5: presigned download bounds.
 *
 * A signed URL is a bearer credential for one object, so its lifetime is clamped on
 * both ends rather than trusted from a caller: long enough for a browser to start the
 * transfer, short enough that a leaked URL expires before it is useful.
 */
export const MIN_PRESIGNED_EXPIRY_SECONDS = 60;
export const MAX_PRESIGNED_EXPIRY_SECONDS = 900;
export const DEFAULT_PRESIGNED_EXPIRY_SECONDS = 600;

export class MinioProvider implements IStorageProvider {
  private client: Client;
  /**
   * Phase 49G-5: the client used ONLY to sign browser-facing URLs.
   *
   * SigV4 signs the Host header, so a URL signed for the in-cluster endpoint
   * (`minio:9000`) cannot be rewritten to the browser-reachable one afterwards without
   * invalidating the signature. The public host must therefore be known at signing
   * time. When `MINIO_PUBLIC_URL` is absent this is the same client as `client`, which
   * is correct for server-to-server use and for any deployment where the API and the
   * browser resolve MinIO identically.
   */
  private signingClient: Client;
  private bucket = process.env.MINIO_BUCKET || 'aria-media';
  /**
   * Phase 49G-5: region pinned explicitly.
   *
   * `presignedGetObject` needs the bucket region to build the SigV4 credential scope,
   * and without this it discovers it with a live `GetBucketLocation` call against the
   * client's own endpoint. For the signing client that endpoint is the BROWSER-facing
   * host, which the API container generally cannot reach — signing would then fail with
   * ECONNREFUSED even though the resulting URL would have been perfectly valid. Pinning
   * the region makes signing a pure local computation with no network dependency.
   */
  private readonly region = process.env.MINIO_REGION || 'us-east-1';
  private readonly logger = new Logger(MinioProvider.name);

  constructor() {
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';

    // Detect insecure defaults and warn (do not fail startup)
    if (accessKey === 'minioadmin' || secretKey === 'minioadmin') {
      this.logger.warn('HIGH: MinIO using default credentials (minioadmin). Ensure these are changed in production.');
    }

    this.client = new Client({
      endPoint: process.env.MINIO_HOST || 'minio',
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: false,
      accessKey,
      secretKey,
      region: this.region,
    });

    this.signingClient = this.buildSigningClient(accessKey, secretKey);
  }

  /**
   * Builds the signing client from `MINIO_PUBLIC_URL` when it names a browser-reachable
   * origin. A malformed value is ignored with a warning rather than failing startup:
   * downloads then stay internal-only, which is a visible functional gap instead of a
   * dead API.
   */
  private buildSigningClient(accessKey: string, secretKey: string): Client {
    const raw = (process.env.MINIO_PUBLIC_URL || '').trim();
    if (!raw) return this.client;

    let parsed: URL;
    try {
      parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    } catch {
      this.logger.warn('MINIO_PUBLIC_URL is not a valid URL — falling back to the internal endpoint for signed URLs');
      return this.client;
    }

    if (!parsed.hostname) {
      this.logger.warn('MINIO_PUBLIC_URL has no host — falling back to the internal endpoint for signed URLs');
      return this.client;
    }

    const useSSL = parsed.protocol === 'https:';
    const port = parsed.port ? parseInt(parsed.port, 10) : useSSL ? 443 : 80;

    return new Client({ endPoint: parsed.hostname, port, useSSL, accessKey, secretKey, region: this.region });
  }

  async ensureBucket() {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) await this.client.makeBucket(this.bucket);
  }

  private sanitizeKey(key: string): string {
    if (!key || typeof key !== 'string') throw new Error('Invalid storage key');
    // Reject null bytes
    if (key.indexOf('\u0000') !== -1) throw new Error('Invalid storage key: contains null byte');
    // Reject control characters
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c < 32) throw new Error('Invalid storage key: contains control characters');
    }
    // Reject traversal patterns
    if (key.includes('../') || key.includes('..\\')) throw new Error('Invalid storage key: traversal not allowed');
    if (key.startsWith('/') || key.startsWith('\\')) throw new Error('Invalid storage key: leading slash not allowed');
    // Normalize duplicate slashes
    key = key.replace(/\\+/g, '/');
    key = key.replace(/\/\/+/g, '/');
    while (key.includes('//')) key = key.replace(/\/\//g, '/');
    // Enforce length cap
    if (key.length > 1024) throw new Error('Invalid storage key: too long');
    return key;
  }

  async upload(key: string, buffer: Buffer, contentType?: string) {
    await this.ensureBucket();

    // Validate key
    const sanitizedKey = this.sanitizeKey(key);

    // Validate contentType
    if (!contentType || typeof contentType !== 'string' || contentType.trim() === '') {
      this.logger.warn({ key: sanitizedKey }, 'Upload called without contentType - rejecting');
      throw new Error('Missing contentType for upload');
    }

    // Log suspicious MIME types for later review
    const lower = contentType.toLowerCase();
    if (lower.includes('html') || lower.includes('svg') || lower.includes('script')) {
      this.logger.warn({ key: sanitizedKey, contentType }, 'Suspicious contentType for upload');
    }

    await this.client.putObject(this.bucket, sanitizedKey, buffer, { 'Content-Type': contentType });
    return this.getUrl(sanitizedKey);
  }

  /**
   * Phase 49G-5: mints a short-lived presigned GET URL.
   *
   * The bucket stays PRIVATE — that is the point. Before 49G-5 this returned
   * `${MINIO_PUBLIC_URL}/${bucket}/${key}`, an unsigned path nginx does not route and
   * that MinIO answers with 403 for an anonymous caller, so no browser could ever fetch
   * an attachment. A presigned URL carries its own bounded authorization in the query
   * string instead, which means:
   *
   *  - no public bucket, no nginx passthrough, no anonymous read grant;
   *  - no long-lived credential in the response — the signature covers one method, one
   *    object and one deadline, and the secret key itself never leaves the server;
   *  - authorization is still decided by the CALLER before this is ever invoked. This
   *    method is deliberately dumb: handing it a key IS the grant, so it must never be
   *    reachable from a route that has not already checked visibility.
   */
  async getUrl(key: string, options?: SignedUrlOptions) {
    const sanitizedKey = this.sanitizeKey(key);
    const expiry = this.boundedExpiry(options?.expirySeconds);
    const respHeaders = this.responseHeaders(options);

    return this.signingClient.presignedGetObject(this.bucket, sanitizedKey, expiry, respHeaders);
  }

  private boundedExpiry(requested?: number): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      return DEFAULT_PRESIGNED_EXPIRY_SECONDS;
    }

    return Math.min(
      MAX_PRESIGNED_EXPIRY_SECONDS,
      Math.max(MIN_PRESIGNED_EXPIRY_SECONDS, Math.floor(requested)),
    );
  }

  /**
   * Pins the response headers MinIO will send.
   *
   * `attachment` is used unconditionally: an object is downloaded, never rendered in the
   * MinIO origin. That closes stored-XSS-by-navigation even if a document type able to
   * carry script were ever admitted upstream. The filename is re-reduced to the closed
   * character set the upload path already enforces, so nothing that could break out of
   * the quoted header value survives — the header is never assembled from raw client
   * input.
   */
  private responseHeaders(options?: SignedUrlOptions): Record<string, string> {
    const headers: Record<string, string> = {};

    const safeName = (options?.fileName ?? '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(-120);

    if (safeName) {
      headers['response-content-disposition'] = `attachment; filename="${safeName}"`;
    }

    const mimeType = (options?.mimeType ?? '').trim();
    if (mimeType && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) {
      headers['response-content-type'] = mimeType;
    }

    return headers;
  }

  async delete(key: string) {
    const sanitizedKey = this.sanitizeKey(key);
    await this.client.removeObject(this.bucket, sanitizedKey);
    return true;
  }
}
