/**
 * Phase 49G-5: options for a signed, short-lived download URL.
 *
 * All three are hints the CALLER already holds server-side. None of them is ever
 * taken from a request payload: `fileName`/`mimeType` come from the database row that
 * was written at upload time, so a client cannot influence the response headers a
 * signed URL will produce.
 */
export interface SignedUrlOptions {
  /** Already-sanitized basename, used for a safe Content-Disposition. */
  fileName?: string;
  /** Stored MIME type, used for a pinned Content-Type. */
  mimeType?: string;
  /** Requested lifetime. Implementations MUST clamp this to a bounded range. */
  expirySeconds?: number;
}

export interface IStorageProvider {
  upload(key: string, buffer: Buffer, contentType?: string): Promise<string>;
  /**
   * Returns a URL a browser can actually fetch.
   *
   * Implementations must not require the bucket to be public: the contract is a
   * short-lived credential-free URL, not a permanent public path.
   */
  getUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  delete(key: string): Promise<boolean>;
}
