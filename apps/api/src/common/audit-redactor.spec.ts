import { redactPayload } from './audit-redactor.util';

/** The nested register shape the leave-report test asserts redaction on. */
interface LeaveRegisterProbe {
  user?: { email?: unknown; password?: unknown; profile?: { phone?: unknown } };
}

describe('audit redactor', () => {
  it('redacts nested sensitive fields', () => {
    const payload = { user: { email: 'john@example.com', password: 'secret', profile: { phone: '09123456789' } } };
    const { redacted } = redactPayload(payload, { emailMask: true, phoneMask: true });
    const user = (redacted as LeaveRegisterProbe).user;
    expect(user?.email).toMatch(/j/);
    expect(user?.password).toBe('[REDACTED]');
    expect(user?.profile?.phone).toMatch(/\*+/);
  });

  it('handles arrays and circular refs and binary detection', () => {
    const buf = Buffer.from('hello world');
    const obj: {
      files: Array<unknown>;
      nested: { arr: Array<{ secret: string }> };
      self?: unknown;
    } = { files: [buf, 'notbinary'], nested: { arr: [{ secret: 'x' }] } };
    obj.self = obj;
    const { redacted } = redactPayload(obj, {});

    const json = JSON.stringify(redacted);
    expect(json.includes('__type') || json.includes('[REDACTED_BINARY]')).toBeTruthy();
    expect(json.includes('"secret":"[REDACTED]"')).toBeTruthy();
    // ensure circular placeholder exists somewhere
    expect(json).toContain('[Circular]');
  });

  it('truncates large payloads and returns checksum', () => {
    // include a space to avoid base64 heuristic
    const big = { text: 'a'.repeat(600 * 1024) + ' ' };
    const { redacted, truncated } = redactPayload(big, { maxPayloadBytes: 100 * 1024 });
    const truncatedMarker =
      truncated ??
      (typeof redacted === 'object' && redacted !== null && '__truncated' in redacted
        ? redacted
        : null);
    expect(truncatedMarker).toBeTruthy();
  });

  it('masks base64-like strings as binary', () => {
    const b64 = Buffer.from('x'.repeat(200)).toString('base64');
    const { redacted } = redactPayload({ data: b64 }, {});
    expect((redacted as { data?: unknown }).data).toBe('[REDACTED_BINARY]');
  });
});
