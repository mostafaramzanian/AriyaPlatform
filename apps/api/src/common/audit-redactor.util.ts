import crypto from 'crypto';

export type RedactionOptions = {
  alwaysRedact?: string[]; // additional keys to always redact
  emailMask?: boolean;
  phoneMask?: boolean;
  maxPayloadBytes?: number;
};

const DEFAULT_SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwordHash',
    'refreshToken',
    'accessToken',
    'sessionToken',
    'verificationToken',
    'recoveryToken',
    'jwt',
    'token',
    'authorization',
    'cookie',
    'session',
    'secret',
    'apiKey',
    'privateKey',
    'clientSecret',
    'otp',
    'verificationCode',
    'resetToken',
    'creditCard',
    'cvv',
    'iban',
    'nationalId',
    'ssn',
    'passport',
    'phone',
    'email',
    'address',
  ]
    // LOWERCASED AT CONSTRUCTION — Phase 49M-2 fix for a real leak.
    //
    // Every lookup below is `DEFAULT_SENSITIVE_KEYS.has(k.toLowerCase())`, but this set was
    // written in camelCase. So `accessToken` → `accesstoken` MISSED, and the same was true of
    // passwordHash, refreshToken, sessionToken, verificationToken, recoveryToken, apiKey,
    // privateKey, clientSecret, verificationCode, resetToken, creditCard and nationalId:
    // thirteen of the twenty-eight entries never matched anything. Only the entries that
    // happened to be all-lowercase (`password`, `token`, `secret`, `email`, …) were doing any
    // work, which is why the leak was invisible — the obvious cases still redacted.
    //
    // Normalizing here rather than editing each string keeps the list readable and makes the
    // invariant impossible to break by adding a camelCase entry later.
    .map((key) => key.toLowerCase()),
);

const HEADER_BLACKLIST = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);

/**
 * The containers the iterative walk writes into — records and arrays only.
 * `setChild` is the single indexed write path, so the security-relevant
 * traversal below performs no casts at all.
 */
type WalkValue = Record<string | number, unknown> | Array<unknown>;

interface WalkFrame {
  parent: WalkValue;
  key: string | number;
  value: unknown;
}

/** The only indexed write the walk performs (circular/binary/redacted markers). */
function setChild(parent: WalkValue, key: string | number, value: unknown): void {
  if (Array.isArray(parent) && typeof key === 'number') parent[key] = value;
  else (parent as Record<string | number, unknown>)[key] = value;
}

function isBufferLike(val: unknown): boolean {
  if (!val) return false;
  try {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(val)) return true;
  } catch {
    // Buffer.isBuffer cannot throw for the guarded shapes; fall through.
  }
  if (val instanceof Uint8Array) return true;
  // detect objects with type 'Buffer'
  if (typeof val === 'object') {
    const record = val as { type?: unknown; data?: unknown };
    if (record.type === 'Buffer' && Array.isArray(record.data)) return true;
  }
  return false;
}

/** Decoded length for a value `isBufferLike` has already accepted. */
function binaryLength(value: object): number {
  if (value instanceof Uint8Array) return value.length;
  if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(value)) {
    return (value as Uint8Array).length;
  }
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : 0;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***' + email.slice(at);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = Math.max(1, Math.floor(local.length / 3));
  return local.slice(0, keep) + '***' + domain;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 6) return digits.replace(/\d/g, '*');
  const start = digits.slice(0, 4);
  const end = digits.slice(-2);
  return start + '*'.repeat(Math.max(0, digits.length - 6)) + end;
}

function isBase64String(value: string) {
  // heuristic: long base64 strings contain only base64 chars and length%4==0
  if (typeof value !== 'string') return false;
  if (value.length < 64) return false;
  const re = /^[A-Za-z0-9+/=\n\r]+$/;
  return re.test(value) && value.replace(/\s+/g, '').length % 4 === 0;
}

export function redactPayload(input: unknown, opts: RedactionOptions = {}): { redacted: unknown; truncated?: { size: number; checksum: string } | null } {
  const maxBytes = opts.maxPayloadBytes ?? 100 * 1024; // 100 KB
  const alwaysRedact = new Set((opts.alwaysRedact || []).map((s) => s.toLowerCase()));

  const seen = new WeakSet();
  const stack: WalkFrame[] = [];

  // Work on a shallow clone root to avoid mutating original
  let root: unknown;
  if (Array.isArray(input)) root = [...input];
  else if (input && typeof input === 'object') root = { ...input };
  else root = input;

  stack.push({ parent: { v: root }, key: 'v', value: root });

  while (stack.length) {
    const node = stack.pop()!;
    const { parent, key, value } = node;

    if (value && typeof value === 'object') {
      if (seen.has(value)) {
        // circular reference -> replace with placeholder
        setChild(parent, key, '[Circular]');
        continue;
      }
      seen.add(value);

      if (isBufferLike(value)) {
        setChild(parent, key, { __type: 'binary', size: binaryLength(value) });
        continue;
      }

      if (Array.isArray(value)) {
        // iterate elements
        for (let i = 0; i < value.length; i++) {
          const val = value[i];
          if (val && typeof val === 'object') stack.push({ parent: value, key: i, value: val });
          else {
            // primitive in array: mask if key name suggests
            // arrays don't have keys so we just check element
            if (typeof val === 'string') {
              if (isBase64String(val)) {
                value[i] = '[REDACTED_BINARY]';
                continue;
              }
            }
          }
        }
        continue;
      }

      // plain object: iterate keys. The single structural assertion in this
      // function: the walk only ever holds records and arrays, so a non-array
      // object container is a key-addressable record here.
      const record = value as Record<string, unknown>;
      for (const k of Object.keys(record)) {
        const val = record[k];
        const lowerK = k.toLowerCase();

        if (HEADER_BLACKLIST.has(lowerK)) {
          record[k] = '[REDACTED]';
          continue;
        }

        if (alwaysRedact.has(lowerK) || DEFAULT_SENSITIVE_KEYS.has(lowerK)) {
          // apply partial mask for email/phone when configured
          if (lowerK === 'email' && opts.emailMask && typeof val === 'string') {
            record[k] = maskEmail(val);
            continue;
          }
          if (lowerK === 'phone' && opts.phoneMask && typeof val === 'string') {
            record[k] = maskPhone(val);
            continue;
          }
          record[k] = '[REDACTED]';
          continue;
        }

        // primitives
        if (typeof val === 'string') {
          if (isBase64String(val)) {
            record[k] = '[REDACTED_BINARY]';
            continue;
          }
          // detect querystring tokens embedded
          if (/\b(token|password|secret|apiKey|jwt|refresh|access)=/i.test(val)) {
            record[k] = '[REDACTED]';
            continue;
          }
          // check for email-like strings where emailMask requested via options alwaysRedact contains 'email_mask'
          // but we support default email masking when key name is email only above
        }

        if (val && typeof val === 'object') {
          stack.push({ parent: record, key: k, value: val });
        }
      }
      continue;
    }

    // primitive root
    if (typeof value === 'string') {
      if (isBase64String(value)) {
        setChild(parent, key, '[REDACTED_BINARY]');
      }
    }
  }

  // After traversal, stringify and check size
  try {
    const json = JSON.stringify(root);
    const size = Buffer.byteLength(json, 'utf8');
    if (size > maxBytes) {
      const checksum = crypto.createHash('sha256').update(json).digest('hex');
      const preview = json.slice(0, Math.min(1024, json.length));
      // `redacted` is `unknown`, so the marker object needs no cast.
      const truncated = { __truncated: true, size, checksum, preview };
      return { redacted: truncated, truncated: { size, checksum } };
    }
    return { redacted: root, truncated: null };
  } catch {
    // fallback if stringify fails
    try {
      const json = String(root).slice(0, 1024);
      const checksum = crypto.createHash('sha256').update(json).digest('hex');
      return { redacted: { __unserializable: true, preview: json }, truncated: { size: 0, checksum } };
    } catch {
      return { redacted: '[UNSERIALIZABLE]', truncated: null };
    }
  }
}
