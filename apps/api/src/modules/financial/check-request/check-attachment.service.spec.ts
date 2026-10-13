import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CheckAttachmentService, ALLOWED_ATTACHMENT_MIME_TYPES } from './check-attachment.service';
import type { CheckAttachmentRepository } from './check-attachment.repository';
import type { CheckRequestRepository } from './check-request.repository';
import type { FinancialAuditGateway } from '../financial-audit.gateway';
import type { IStorageProvider } from '../../../storage/i-storage.provider';
import { CHECK_REQUEST_ERROR_CODES } from './check-request';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the request-stage attachment slice.
 *
 * WHAT IS PINNED HERE
 * -------------------
 *  1. THE SECTION STATE WINDOWS, read from the process configuration: section 2 (the
 *     source's «پیوست ها») is managed exactly in states 0/1; outside its window a manage
 *     act is a typed 409 (`SECTION_UNAVAILABLE`); a READ (list, download URL) works in
 *     every state — evidence must stay visible to every later stage. Sections 6/7 have
 *     their own routes with their own capabilities (states 6/7), exercised below.
 *  2. THE TENANT FIRST: a foreign request is a 404 indistinguishable from a missing one,
 *     and an attachment id of ANOTHER request of this tenant is a 404, never an edit.
 *  3. THE SOURCE'S UPLOAD GATE, PER SECTION: where the section declares a vocabulary a
 *     document type is required («نوع سند انتخاب گردد.») and must belong to it; sections
 *     with `null` vocabulary (6/7) REFUSE a supplied type; nothing is required to EXIST.
 *  4. THE STORE-THEN-CLEANUP ORDER: object first, row second, object deleted when the row
 *     fails; a storage failure surfaces as a typed 500 with no row behind it.
 *  5. The storageKey NEVER appears in any view.
 */

const TENANT = 'tenant-a';
const REQUESTER = 'user-requester';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const actor = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  userId: REQUESTER,
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
  ...overrides,
});

const file = (overrides: Record<string, unknown> = {}) => ({
  originalname: 'invoice.pdf',
  mimetype: 'application/pdf',
  size: 1024,
  buffer: Buffer.from('pdf'),
  ...overrides,
});

let seq = 0;
function attachmentRow(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date('2026-10-03T08:00:00.000Z');
  return {
    id: `22222222-2222-4222-8222-22222222${String(seq).padStart(4, '0')}`,
    tenantId: TENANT,
    checkRequestId: REQUEST_ID,
    section: 2,
    documentType: 'PISH_FACTOR',
    description: null,
    storageKey: `financial/${TENANT}/${REQUEST_ID}/obj-secret`,
    fileName: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    createdBy: REQUESTER,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildService(overrides: Record<string, unknown> = {}) {
  const requests = { findById: jest.fn() };
  const attachments = {
    create: jest.fn(),
    listByRequest: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    updateMetadata: jest.fn(),
    delete: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined), read: jest.fn() };
  const storage = {
    upload: jest.fn().mockResolvedValue('ok'),
    delete: jest.fn().mockResolvedValue(true),
    getUrl: jest.fn().mockResolvedValue('https://signed'),
    ...overrides,
  };

  const service = new CheckAttachmentService(
    requests as unknown as CheckRequestRepository,
    attachments as unknown as CheckAttachmentRepository,
    audit as unknown as FinancialAuditGateway,
    storage as unknown as IStorageProvider
  );
  return { service, requests, attachments, audit, storage };
}

const withRequest = (
  requests: { findById: jest.Mock },
  status = 0
) =>
  requests.findById.mockResolvedValue({
    id: REQUEST_ID,
    tenantId: TENANT,
    status,
    // The pin `requireManageableSection` resolves the section's state window through —
    // fixtures state it honestly rather than letting `undefined` pick a definition.
    processKey: 'financial.check-issuance',
    processVersion: 1,
  });

describe('Phase F1 — CheckAttachmentService.upload', () => {
  it('writes the OBJECT first, then the row — and audits with the request as resource', async () => {
    const { service, requests, attachments, audit, storage } = buildService();
    withRequest(requests, 0);
    attachments.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      attachmentRow({ ...data, tenantId })
    );

    const view = await service.upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file());

    expect(storage.upload.mock.invocationCallOrder[0]).toBeLessThan(
      attachments.create.mock.invocationCallOrder[0]
    );
    expect(attachments.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        checkRequestId: REQUEST_ID,
        section: 2,
        documentType: 'PISH_FACTOR',
        createdBy: REQUESTER,
      })
    );
    expect(view).not.toHaveProperty('storageKey');
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'attachment_upload',
      resource: 'financial.check-request',
      resourceId: REQUEST_ID,
    });
  });

  it('requires a document type — the source’s own upload gate', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 0);

    const error = await service.upload(actor(), REQUEST_ID, 'request-documents', {}, file()).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_REQUIRED);
    expect(attachments.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown document type and an over-large or disallowed file', async () => {
    const { service, requests, storage } = buildService();
    withRequest(requests, 0);

    const invalid = await service
      .upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'CHECK_IMAGE' }, file())
      .catch((e) => e);
    expect(invalid.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_INVALID);

    const tooBig = await service
      .upload(
        actor(),
        REQUEST_ID, 'request-documents',
        { documentType: 'PISH_FACTOR' },
        file({ size: 11 * 1024 * 1024 })
      )
      .catch((e) => e);
    expect(tooBig.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.FILE_TOO_LARGE);

    const badMime = await service
      .upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file({ mimetype: 'text/html' }))
      .catch((e) => e);
    expect(badMime.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.FILE_TYPE_NOT_ALLOWED);

    // NOTHING reached storage — every refusal happens before the object write.
    expect(storage.upload).not.toHaveBeenCalled();
    expect(ALLOWED_ATTACHMENT_MIME_TYPES.has('text/html')).toBe(false);
  });

  it('freezes section 2 outside its configured state window {0,1} with a typed 409, and 404s a foreign request', async () => {
    const { service, requests, attachments, storage } = buildService();

    withRequest(requests, 2);
    const conflict = await service
      .upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file())
      .catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    // Phase CHECK-ISSUATION: the window itself comes from the process configuration
    // (`section.states`), so the CODE is SECTION_UNAVAILABLE — the states {0,1} are the
    // same two F1 pinned, now derived instead of hard-coded beside the guard.
    expect(conflict.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SECTION_UNAVAILABLE);

    requests.findById.mockResolvedValue(null);
    await expect(
      service.upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file())
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.upload).not.toHaveBeenCalled();
    expect(attachments.create).not.toHaveBeenCalled();
  });

  it('maps a storage failure to a typed 500 with NO row behind it', async () => {
    const { service, requests, attachments } = buildService({
      upload: jest.fn().mockRejectedValue(new Error('minio down')),
    });
    withRequest(requests, 0);

    const error = await service
      .upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file())
      .catch((e) => e);

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.STORAGE_UPLOAD_FAILED);
    expect(attachments.create).not.toHaveBeenCalled();
  });

  it('deletes the OBJECT again when the ROW insert fails — storage never keeps an orphan write', async () => {
    const { service, requests, attachments, storage } = buildService();
    withRequest(requests, 0);
    attachments.create.mockRejectedValue(new Error('db down'));

    await expect(
      service.upload(actor(), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file())
    ).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledWith(
      expect.stringContaining(`financial/${TENANT}/${REQUEST_ID}/`)
    );
  });

  it('refuses a machine context — an attachment always has a human uploader', async () => {
    const { service, requests } = buildService();
    withRequest(requests, 0);

    await expect(
      service.upload(actor({ userId: null }), REQUEST_ID, 'request-documents', { documentType: 'PISH_FACTOR' }, file())
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Phase F1 — CheckAttachmentService.list / download (READS in every state)', () => {
  it('lists a manager-owned request’s documents — evidence stays visible at state 2', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 2);
    attachments.listByRequest.mockResolvedValue([attachmentRow()]);

    const items = await service.list(actor(), REQUEST_ID);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('storageKey');
    expect(attachments.listByRequest).toHaveBeenCalledWith(TENANT, REQUEST_ID);
  });

  it('404s a foreign request before listing anything', async () => {
    const { service, requests, attachments } = buildService();
    requests.findById.mockResolvedValue(null);

    await expect(service.list(actor(), REQUEST_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(attachments.listByRequest).not.toHaveBeenCalled();
  });

  it('resolves a download URL with SERVER-held name/type, never the key', async () => {
    const { service, requests, attachments, storage } = buildService();
    withRequest(requests, 50); // terminal — still downloadable
    attachments.findById.mockResolvedValue(attachmentRow());

    const result = await service.resolveDownloadUrl(actor(), REQUEST_ID, 'att');
    expect(storage.getUrl).toHaveBeenCalledWith(`financial/${TENANT}/${REQUEST_ID}/obj-secret`, {
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
    });
    expect(result).toEqual({
      url: 'https://signed',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
    });
    expect(JSON.stringify(result)).not.toContain('obj-secret');
  });

  it('404s an attachment id that belongs to a DIFFERENT request of this tenant', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 0);
    attachments.findById.mockResolvedValue(attachmentRow({ checkRequestId: 'other-request' }));

    await expect(service.resolveDownloadUrl(actor(), REQUEST_ID, 'att')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

describe('Phase F1 — CheckAttachmentService.updateMetadata / remove', () => {
  it('edits metadata in requester-owned states and audits the before/after pair', async () => {
    const { service, requests, attachments, audit } = buildService();
    withRequest(requests, 1);
    attachments.findById.mockResolvedValue(attachmentRow());
    attachments.updateMetadata.mockResolvedValue(
      attachmentRow({ documentType: 'GARARDAD', description: 'updated' })
    );

    const view = await service.updateMetadata(actor(), REQUEST_ID, 'att', 'request-documents', {
      documentType: 'GARARDAD',
      description: 'updated',
    });

    // The REPOSITORY signature is unchanged (tenantId, id, checkRequestId, patch) — the
    // section key is the SERVICE's concern, resolved from configuration before this call.
    expect(attachments.updateMetadata).toHaveBeenCalledWith(TENANT, 'att', REQUEST_ID, {
      documentType: 'GARARDAD',
      description: 'updated',
    });
    expect(view.description).toBe('updated');
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'attachment_update',
      oldValue: expect.objectContaining({ documentType: 'PISH_FACTOR' }),
      newValue: expect.objectContaining({ documentType: 'GARARDAD' }),
    });
  });

  it('refuses an empty metadata patch and a frozen request', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 0);
    attachments.findById.mockResolvedValue(attachmentRow());

    await expect(service.updateMetadata(actor(), REQUEST_ID, 'att', 'request-documents', {})).rejects.toBeInstanceOf(
      BadRequestException
    );

    withRequest(requests, 3);
    const conflict = await service
      .updateMetadata(actor(), REQUEST_ID, 'att', 'request-documents', { description: 'x' })
      .catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(attachments.updateMetadata).not.toHaveBeenCalled();
  });

  it('deletes the ROW first and the OBJECT second, then audits', async () => {
    const { service, requests, attachments, storage, audit } = buildService();
    withRequest(requests, 1);
    attachments.findById.mockResolvedValue(attachmentRow());
    attachments.delete.mockResolvedValue(true);

    const result = await service.remove(actor(), REQUEST_ID, 'att', 'request-documents');
    expect(result).toEqual({ deleted: true, id: 'att' });
    expect(attachments.delete.mock.invocationCallOrder[0]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0]
    );
    expect(audit.record.mock.calls[0][1]).toMatchObject({ action: 'attachment_delete' });
  });

  it('still deletes the ROW when the OBJECT delete fails — the row must not dangle', async () => {
    const { service, requests, attachments, storage } = buildService({
      delete: jest.fn().mockRejectedValue(new Error('minio down')),
    });
    withRequest(requests, 1);
    attachments.findById.mockResolvedValue(attachmentRow());
    attachments.delete.mockResolvedValue(true);

    await expect(service.remove(actor(), REQUEST_ID, 'att', 'request-documents')).resolves.toEqual({
      deleted: true,
      id: 'att',
    });
    expect(storage.delete).toHaveBeenCalled();
  });

  it('404s an attachment of another request and refuses a frozen request', async () => {
    const { service, requests, attachments } = buildService();

    withRequest(requests, 0);
    attachments.findById.mockResolvedValue(attachmentRow({ checkRequestId: 'other' }));
    await expect(service.remove(actor(), REQUEST_ID, 'att', 'request-documents')).rejects.toBeInstanceOf(
      NotFoundException
    );

    withRequest(requests, 50);
    const conflict = await service.remove(actor(), REQUEST_ID, 'att', 'request-documents').catch((e) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(attachments.delete).not.toHaveBeenCalled();
  });
});

describe('Phase CHECK-ISSUATION — the stage sections (6: cheque image, 7: receipt)', () => {
  it('uploads a cheque image at state 6 with NO document type — the source grid had no picker', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 6);
    attachments.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      attachmentRow({ ...data, tenantId })
    );

    const view = await service.upload(actor(), REQUEST_ID, 'cheque-image', {}, file());
    expect(attachments.create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ section: 6, documentType: null })
    );
    expect(view.section).toBe(6);
    expect(view.documentType).toBeNull();
  });

  it('refuses a document type on a null-vocabulary section — supplying one is a client mistake', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 6);

    const error = await service
      .upload(actor(), REQUEST_ID, 'cheque-image', { documentType: 'PISH_FACTOR' }, file())
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_NOT_ALLOWED);
    expect(attachments.create).not.toHaveBeenCalled();
  });

  it('holds each stage section to its OWN state window — 6 only at 6, 7 only at 7', async () => {
    const { service, requests, attachments } = buildService();

    for (const status of [0, 1, 2, 5, 7, 8, 50]) {
      withRequest(requests, status);
      const error = await service
        .upload(actor(), REQUEST_ID, 'cheque-image', {}, file())
        .catch((e) => e);
      expect({ status, code: error.getResponse().code }).toEqual({
        status,
        code: CHECK_REQUEST_ERROR_CODES.SECTION_UNAVAILABLE,
      });
    }

    for (const status of [0, 6, 8, 50]) {
      withRequest(requests, status);
      const error = await service
        .upload(actor(), REQUEST_ID, 'delivery-receipt', {}, file())
        .catch((e) => e);
      expect({ status, code: error.getResponse().code }).toEqual({
        status,
        code: CHECK_REQUEST_ERROR_CODES.SECTION_UNAVAILABLE,
      });
    }

    withRequest(requests, 7);
    attachments.create.mockImplementation(async (tenantId: string, data: Record<string, unknown>) =>
      attachmentRow({ ...data, tenantId })
    );
    const receipt = await service
      .upload(actor(), REQUEST_ID, 'delivery-receipt', {}, file())
      .then(() => 'accepted')
      .catch((e) => e.getResponse().code);
    expect(receipt).toBe('accepted');
  });

  it('refuses an unknown section key before any state check — 400 SECTION_UNKNOWN', async () => {
    const { service, requests } = buildService();
    withRequest(requests, 0);

    const error = await service
      .upload(actor(), REQUEST_ID, 'not-a-section', {}, file())
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SECTION_UNKNOWN);
  });

  it('refuses a cross-section delete — the cheque-image route cannot remove a request document', async () => {
    const { service, requests, attachments } = buildService();
    withRequest(requests, 6);
    attachments.findById.mockResolvedValue(attachmentRow({ section: 2 }));

    const error = await service
      .remove(actor(), REQUEST_ID, 'att', 'cheque-image')
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(CHECK_REQUEST_ERROR_CODES.SECTION_ROUTE_MISMATCH);
    expect(attachments.delete).not.toHaveBeenCalled();
  });

  it('deletes a cheque image at its own stage, the row before the object', async () => {
    const { service, requests, attachments, storage } = buildService();
    withRequest(requests, 6);
    attachments.findById.mockResolvedValue(
      attachmentRow({ section: 6, documentType: null })
    );
    attachments.delete.mockResolvedValue(true);

    await service.remove(actor(), REQUEST_ID, 'att', 'cheque-image');
    expect(attachments.delete.mock.invocationCallOrder[0]).toBeLessThan(
      storage.delete.mock.invocationCallOrder[0]
    );
  });
});
