import {
  ALLOWED_TICKET_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  TICKET_ATTACHMENT_ACCEPT,
  formatAttachmentSize,
  ticketAttachmentTypeLabel,
  uploadTicketAttachment,
  validateTicketAttachment,
} from '../support-api';
import { corePostForm } from '../core-http';

/**
 * Phase 49G-2: attachment additions to the Support client.
 *
 * The guarantees under test are the ones the UI depends on and the ones a reviewer
 * would otherwise have to take on trust: the upload sends nothing but the file, the
 * allowlist is not a superset of the backend's, and the client-side checks match the
 * limits the server enforces.
 */

jest.mock('../core-http', () => ({
  ...jest.requireActual('../core-http'),
  corePostForm: jest.fn(),
}));

const corePostFormMock = corePostForm as jest.MockedFunction<typeof corePostForm>;

function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('support attachment client', () => {
  beforeEach(() => {
    corePostFormMock.mockReset();
    corePostFormMock.mockResolvedValue({
      id: 'a1',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
  });

  it('posts only the file, to the ticket-scoped route', async () => {
    const file = makeFile('report.pdf', 'application/pdf', 2048);

    await uploadTicketAttachment('t1', file);

    expect(corePostFormMock).toHaveBeenCalledTimes(1);
    expect(corePostFormMock.mock.calls[0][0]).toBe('/tickets/t1/attachments');

    const form = corePostFormMock.mock.calls[0][1];
    expect(form).toBeInstanceOf(FormData);
    // Exactly one field, named `file` — no tenant, uploader or storage key.
    expect([...form.keys()]).toEqual(['file']);
  });

  it('encodes the ticket id rather than interpolating it raw', async () => {
    await uploadTicketAttachment('t 1/../x', makeFile('a.pdf', 'application/pdf', 10));

    expect(corePostFormMock.mock.calls[0][0]).toBe('/tickets/t%201%2F..%2Fx/attachments');
  });

  it('mirrors the backend MIME allowlist without widening it', () => {
    // SVG is an executable document and is refused server-side.
    expect(ALLOWED_TICKET_ATTACHMENT_MIME_TYPES).not.toContain('image/svg+xml');
    expect(ALLOWED_TICKET_ATTACHMENT_MIME_TYPES).toContain('application/pdf');
    expect(ALLOWED_TICKET_ATTACHMENT_MIME_TYPES).toContain('image/png');
    // `accept` is derived from the list, so the two cannot drift apart.
    expect(TICKET_ATTACHMENT_ACCEPT).toBe(ALLOWED_TICKET_ATTACHMENT_MIME_TYPES.join(','));
  });

  it('matches the 10MB server ceiling exactly', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a file within both limits', () => {
    expect(validateTicketAttachment(makeFile('a.pdf', 'application/pdf', 1024))).toBeNull();
  });

  it('rejects an empty file, an oversized file and a disallowed type', () => {
    expect(validateTicketAttachment(makeFile('a.pdf', 'application/pdf', 0))).toBe(
      'فایل خالی است.',
    );
    expect(
      validateTicketAttachment(makeFile('a.pdf', 'application/pdf', MAX_ATTACHMENT_BYTES + 1)),
    ).toMatch(/حجم فایل بیشتر/);
    expect(validateTicketAttachment(makeFile('a.svg', 'image/svg+xml', 512))).toBe(
      'نوع این فایل پذیرفته نمی‌شود.',
    );
  });

  it('accepts a file exactly at the ceiling', () => {
    expect(
      validateTicketAttachment(makeFile('a.pdf', 'application/pdf', MAX_ATTACHMENT_BYTES)),
    ).toBeNull();
  });

  it('formats sizes in Persian across unit boundaries', () => {
    expect(formatAttachmentSize(512)).toContain('بایت');
    expect(formatAttachmentSize(2048)).toContain('کیلوبایت');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toContain('مگابایت');
    expect(formatAttachmentSize(-1)).toBe('');
  });

  it('labels known types and falls back neutrally for anything else', () => {
    expect(ticketAttachmentTypeLabel('application/pdf')).toBe('PDF');
    expect(ticketAttachmentTypeLabel('image/png')).toBe('PNG');
    expect(ticketAttachmentTypeLabel('application/x-unknown')).toBe('فایل');
  });
});
