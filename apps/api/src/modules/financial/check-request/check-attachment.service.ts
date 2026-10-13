import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IStorageProvider } from '../../../storage/i-storage.provider';
import { FinancialAuditGateway } from '../financial-audit.gateway';
import {
  FINANCIAL_AUDIT_RESOURCE,
  FINANCIAL_MAX_ATTACHMENT_BYTES,
} from '../financial.constants';
import { CheckRequestRepository } from './check-request.repository';
import { CheckAttachmentRepository } from './check-attachment.repository';
import type { CheckAttachmentRecord, CheckRequestRecord } from './check-request.repository';
import { resolveCheckIssuanceDefinition } from '../process/check-issuance.definition';
import type { ProcessDocumentSection } from '../../../platform/process/process-definition.model';
import {
  CHECK_DOCUMENT_TYPES,
  CHECK_REQUEST_AUDIT_ACTION,
  CHECK_REQUEST_ERROR_CODES,
  type CheckDocumentType,
} from './check-request';
import { UpdateCheckAttachmentDto } from './check-request.dto';
/**
 * Phase F1 — FINANCIAL FOUNDATION: request-stage attachments (source «پیوست ها»,
 * `Section = 02`) over the platform's existing `IStorageProvider`.
 *
 * THE SOURCE'S BEHAVIOUR, PRESERVED
 * ---------------------------------
 *  * Upload is gated on a document type where the SECTION declares one («نوع سند انتخاب
 *    گردد.» on section 2's grid) — a metadata requirement of the UPLOAD act, never a
 *    lifecycle one: no transition asks whether documents exist (Preflight §9.3: attachment
 *    requirements are NOT blocking) EXCEPT the two the process configuration names in
 *    `requiredForActions` (cheque image → issue, receipt → deliver).
 *  * WHICH STATES MAY MANAGE A SECTION comes from the pinned process definition
 *    (brief §27): section 2 in states 0/1 (the source's own editability), section 6 in
 *    state 6, section 7 in state 7. Each route names its section key, so the ROUTE's
 *    permission and the SECTION's state window always agree.
 *  * Eleven document types for section 2, verbatim; NONE for 6/7 (their grids never
 *    asked); description optional; nothing else ever required to exist.
 *
 * STORE-THEN-CLEANUP-ON-FAILURE, THE 50 CORRESPONDENCE CONTRACT: the object is written
 * first, the row second, and a failed row write deletes the object — so storage never
 * accumulates files no row references. A storage failure before the row exists surfaces
 * as a typed 500 with `STORAGE_UPLOAD_FAILED`; nothing partial is left behind.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 *  * No cross-context storage record: Financial's row is the only thing that names the
 *    object, and the `storageKey` NEVER leaves the server (downloads resolve to a
 *    short-lived URL with server-held name/type).
 *  * No sections 06/07 — their states (6/7) are out of F1 scope.
 *  * No required documents, no per-type count rules, no virus scanning — none exists in
 *    the source and inventing one would be a rule no source proved.
 */

/**
 * MIME allowlist, not a denylist: anything not named here is refused. SVG is
 * deliberately excluded — it is an executable document that can carry script, and it
 * would be served from our own origin. The list is byte-identical to the 49F/50 list,
 * and it is a LOCAL COPY rather than an import for the reason `production-ui.tsx` records
 * for copying Commerce's classes: reaching across a bounded-context boundary to share a
 * constant would couple two contexts that must not know each other.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** The multipart file shape Multer produces (memoryStorage). */
export interface UploadedCheckAttachmentFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

/** What one attachment looks like on the wire. NO `storageKey`, ever. */
export interface CheckAttachmentView {
  id: string;
  checkRequestId: string;
  section: number;
  /**
   * `null` for sections whose configuration declares no type vocabulary (6/7 — the
   * source's grids never asked for «نوع سند»). Section-2 rows always carry one: their
   * section requires it at upload.
   */
  documentType: CheckDocumentType | null;
  description: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toCheckAttachmentView(row: CheckAttachmentRecord): CheckAttachmentView {
  return {
    id: row.id,
    checkRequestId: row.checkRequestId,
    section: row.section,
    documentType: row.documentType,
    description: row.description,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The actor shape this service needs — structurally `FinancialActor`. */
interface AttachmentActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class CheckAttachmentService {
  private readonly logger = new Logger(CheckAttachmentService.name);

  constructor(
    private readonly requests: CheckRequestRepository,
    private readonly attachments: CheckAttachmentRepository,
    private readonly audit: FinancialAuditGateway,
    @Inject('IStorageProvider') private readonly storage: IStorageProvider
  ) {}

  /**
   * The documents on one request of the acting tenant, oldest first.
   *
   * A READ, so no state guard: the manager and an auditor must be able to see the
   * evidence at state 2 and beyond — only MANAGING attachments is state-gated. The
   * request itself is resolved tenant-scoped (404 for a foreign id), which is what makes
   * a foreign attachment list unreachable.
   */
  async list(actor: AttachmentActor, checkRequestId: string): Promise<CheckAttachmentView[]> {
    await this.requireExistingRequest(actor, checkRequestId);
    const rows = await this.attachments.listByRequest(actor.tenantId, checkRequestId);
    return rows.map(toCheckAttachmentView);
  }

  /**
   * Uploads ONE file into the SECTION a route names, on a request whose current state
   * the pinned configuration says that section may be managed in.
   *
   * ORDER OF OPERATIONS (the 50 correspondence contract): validate everything that can
   * be validated BEFORE touching storage; write the OBJECT; insert the ROW; and if the
   * row insert fails, delete the object again — best-effort, logged, never surfaced as a
   * second failure layered on top of the first. A storage failure at step one surfaces as
   * a typed 500 and no row exists.
   */
  async upload(
    actor: AttachmentActor,
    checkRequestId: string,
    sectionKey: string,
    fields: { documentType?: string; description?: string },
    file: UploadedCheckAttachmentFile | undefined
  ): Promise<CheckAttachmentView> {
    if (!actor.userId) {
      throw new ForbiddenException('An attachment upload requires an authenticated actor.');
    }

    const { section } = await this.requireManageableSection(actor, checkRequestId, sectionKey);

    const documentType = this.parseSectionDocumentType(section, fields.documentType);
    const description = this.normalizeDescription(fields.description);

    if (!file || !file.buffer) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.FILE_REQUIRED,
        message: 'An upload requires a file part named "file".',
      });
    }
    if (typeof file.size === 'number' && file.size > FINANCIAL_MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.FILE_TOO_LARGE,
        message: `An attachment may not exceed ${FINANCIAL_MAX_ATTACHMENT_BYTES} bytes.`,
      });
    }
    const mimeType = file.mimetype ?? 'application/octet-stream';
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
        message: `The MIME type "${mimeType}" is not an allowed attachment type.`,
      });
    }

    const fileName = this.safeFileName(file.originalname, checkRequestId);
    const storageKey = `financial/${actor.tenantId}/${checkRequestId}/${randomUUID()}-${fileName}`;

    // OBJECT FIRST — a row that names a missing object would be a dead download link
    // the moment anything listed it.
    try {
      await this.storage.upload(storageKey, file.buffer, mimeType);
    } catch (error) {
      this.logger.error(
        `Financial attachment object write failed for request ${checkRequestId}`,
        error instanceof Error ? error.stack : String(error)
      );
      throw new InternalServerErrorException({
        code: CHECK_REQUEST_ERROR_CODES.STORAGE_UPLOAD_FAILED,
        message: 'The attachment could not be stored; please retry.',
      });
    }

    let row: CheckAttachmentRecord;
    try {
      row = await this.attachments.create(actor.tenantId, {
        checkRequestId,
        section: section.section,
        documentType,
        description,
        storageKey,
        fileName,
        mimeType,
        size: file.size ?? file.buffer.length,
        createdBy: actor.userId,
      });
    } catch (error) {
      // ROW FAILED → remove the object. Best-effort: a leftover object with no row is
      // inert (no read can reach it) and gets cleaned by retention; surfacing a second
      // failure would hide the FIRST one.
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupError) {
        this.logger.warn(
          `Financial attachment object cleanup failed for request ${checkRequestId}`,
          cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)
        );
      }
      this.logger.error(
        `Financial attachment row insert failed for request ${checkRequestId}`,
        error instanceof Error ? error.stack : String(error)
      );
      throw error;
    }

    await this.audit.record(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.ATTACHMENT_UPLOAD,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: checkRequestId,
      newValue: {
        attachmentId: row.id,
        documentType: row.documentType,
        section: row.section,
        fileName: row.fileName,
      },
      changedFields: ['attachment'],
    });

    return toCheckAttachmentView(row);
  }

  /**
   * Edits ONE document's metadata (the source's `NoeaSanad` / `Tozihat` columns) while
   * the request is requester-owned.
   *
   * AN EMPTY PATCH IS A 400 — same rule as `CheckRequestService.update`: `updatedAt`
   * only moves on a real write, and an audit row for a no-op would poison the trail.
   *
   * THE ROW IS BOUND TO THE REQUEST: `(tenantId, id, checkRequestId)` in one conditional
   * UPDATE, so an attachment id that exists under a DIFFERENT request of this tenant is a
   * 404 rather than a cross-request edit — the id alone is not an isolation key.
   */
  async updateMetadata(
    actor: AttachmentActor,
    checkRequestId: string,
    attachmentId: string,
    sectionKey: string,
    dto: UpdateCheckAttachmentDto
  ): Promise<CheckAttachmentView> {
    const { section } = await this.requireManageableSection(actor, checkRequestId, sectionKey);

    const current = await this.attachments.findById(actor.tenantId, attachmentId);
    if (!current || current.checkRequestId !== checkRequestId) {
      throw new NotFoundException('Attachment not found.');
    }
    if (current.section !== section.section) {
      throw this.sectionRouteMismatch(section, current.section);
    }

    const patch: { documentType?: CheckDocumentType; description?: string | null } = {};
    if (dto.documentType !== undefined) {
      const parsed = this.parseSectionDocumentType(section, dto.documentType);
      if (parsed === null) {
        throw new BadRequestException({
          code: CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_NOT_ALLOWED,
          message: `Section "${section.key}" carries no document type vocabulary.`,
        });
      }
      patch.documentType = parsed;
    }
    if (dto.description !== undefined) {
      // An empty description CLEARS the column (null) — the same act as erasing the
      // source's `Tozihat` box; a stated field must be writable to its empty value.
      patch.description = this.normalizeDescription(dto.description);
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('State at least one field to change.');
    }

    const updated = await this.attachments.updateMetadata(
      actor.tenantId,
      attachmentId,
      checkRequestId,
      patch
    );

    if (!updated) {
      // The row vanished between the read and the conditional write — a real race, told
      // as the same 404 rather than a claim about state this method no longer knows.
      throw new NotFoundException('Attachment not found.');
    }

    await this.audit.record(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.ATTACHMENT_UPDATE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: checkRequestId,
      oldValue: {
        attachmentId,
        documentType: current.documentType,
        description: current.description,
      },
      newValue: { attachmentId, ...patch },
      changedFields: Object.keys(patch),
    });

    return toCheckAttachmentView(updated);
  }

  /**
   * Deletes ONE document's row AND its object, while the request is requester-owned.
   *
   * ROW FIRST, OBJECT SECOND: once the row is gone no read can reach the object, so a
   * storage failure at step two leaves an inert orphan (logged, cleaned by retention)
   * instead of a row pointing at something that can never be removed. This is the
   * correspondence contract, deliberately mirrored rather than improved.
   */
  async remove(
    actor: AttachmentActor,
    checkRequestId: string,
    attachmentId: string,
    sectionKey: string
  ): Promise<{ deleted: true; id: string }> {
    const { section } = await this.requireManageableSection(actor, checkRequestId, sectionKey);

    const row = await this.attachments.findById(actor.tenantId, attachmentId);
    if (!row || row.checkRequestId !== checkRequestId) {
      throw new NotFoundException('Attachment not found.');
    }
    if (row.section !== section.section) {
      throw this.sectionRouteMismatch(section, row.section);
    }

    const removed = await this.attachments.delete(actor.tenantId, attachmentId, checkRequestId);
    if (!removed) {
      throw new NotFoundException('Attachment not found.');
    }

    try {
      await this.storage.delete(row.storageKey);
    } catch (error) {
      this.logger.warn(
        { err: error, attachmentId, checkRequestId },
        'Financial attachment object delete failed after row delete'
      );
    }

    await this.audit.record(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.ATTACHMENT_DELETE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: checkRequestId,
      oldValue: {
        attachmentId,
        documentType: row.documentType,
        section: row.section,
        fileName: row.fileName,
      },
      changedFields: ['attachment'],
    });

    return { deleted: true, id: attachmentId };
  }

  /**
   * Resolves a short-lived download URL for an attachment the caller can SEE.
   *
   * `storageKey` never leaves the server: the URL is built by the storage port from the
   * server-held `fileName`/`mimeType`, so a requester cannot steer the response headers
   * of a signed URL (the 49F/50 rule).
   */
  async resolveDownloadUrl(
    actor: AttachmentActor,
    checkRequestId: string,
    attachmentId: string
  ): Promise<{ url: string; fileName: string; mimeType: string }> {
    // A READ — the request must exist in this tenant (404), but no state guard.
    await this.requireExistingRequest(actor, checkRequestId);

    const row = await this.attachments.findById(actor.tenantId, attachmentId);
    if (!row || row.checkRequestId !== checkRequestId) {
      throw new NotFoundException('Attachment not found.');
    }

    const url = await this.storage.getUrl(row.storageKey, {
      fileName: row.fileName,
      mimeType: row.mimeType,
    });

    return { url, fileName: row.fileName, mimeType: row.mimeType };
  }

  /**
   * The parent request TENANT-SCOPED (404 for a foreign id — indistinguishable from a
   * missing one). Reads never state-guard: seeing the evidence at any state is how a
   * manager, a later-stage actor and an auditor verify the record — only MANAGING a
   * section is state-gated, and that gate lives in `requireManageableSection`.
   */
  private async requireExistingRequest(
    actor: AttachmentActor,
    checkRequestId: string
  ): Promise<CheckRequestRecord> {
    const request = await this.requests.findById(actor.tenantId, checkRequestId);
    if (!request) {
      throw new NotFoundException('Check request not found.');
    }
    return request;
  }

  /**
   * The section a MANAGING route names, validated against the row's PINNED process
   * definition (brief §27): the key must exist (a route naming a section the process
   * does not declare is a 400, not a silent write to an undeclared column), and the
   * row's current state must be one of the section's `states` (otherwise 409 — a client
   * can tell "wrong state" from "not found").
   */
  private async requireManageableSection(
    actor: AttachmentActor,
    checkRequestId: string,
    sectionKey: string
  ): Promise<{ request: CheckRequestRecord; section: ProcessDocumentSection }> {
    const request = await this.requireExistingRequest(actor, checkRequestId);
    const definition = resolveCheckIssuanceDefinition(request.processVersion);
    const section = definition.documentSections.find((candidate) => candidate.key === sectionKey);
    if (!section) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.SECTION_UNKNOWN,
        message: `"${sectionKey}" is not a document section of process ${request.processKey} v${request.processVersion}.`,
      });
    }
    if (!section.states.includes(request.status)) {
      throw new ConflictException({
        code: CHECK_REQUEST_ERROR_CODES.SECTION_UNAVAILABLE,
        message: `Section "${section.key}" is not managed while the request is in state ${request.status}; it opens in state(s) ${section.states.join(', ')}.`,
      });
    }
    return { request, section };
  }

  /** The 409 when a route reaches for an attachment of a section it does not manage. */
  private sectionRouteMismatch(
    section: ProcessDocumentSection,
    actualSection: number
  ): ConflictException {
    return new ConflictException({
      code: CHECK_REQUEST_ERROR_CODES.SECTION_ROUTE_MISMATCH,
      message: `This route manages section ${section.section} ("${section.key}"); the attachment belongs to section ${actualSection}.`,
    });
  }

  /**
   * Validates the multipart `documentType` against THE SECTION's configuration, not a
   * hard-coded list:
   *
   *  * section declares `null` vocabulary (6/7) → a supplied type is a typed refusal
   *    («نوع سند» was never asked there — supplying one is a client contract mistake),
   *    and the stored value is `null`;
   *  * section declares a vocabulary → MISSING is the source's own upload gate
   *    («نوع سند انتخاب گردد.»); a value outside the closed eleven-value enum is a
   *    typed refusal before Postgres could answer with a driver error (a 500 for a
   *    client mistake); a known enum member outside THIS section's vocabulary is its
   *    own typed refusal.
   */
  private parseSectionDocumentType(
    section: ProcessDocumentSection,
    value: string | undefined
  ): CheckDocumentType | null {
    if (section.allowedDocumentTypes === null) {
      if (value !== undefined && value.trim().length > 0) {
        throw new BadRequestException({
          code: CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_NOT_ALLOWED,
          message: `Section "${section.key}" carries no document type vocabulary.`,
        });
      }
      return null;
    }

    if (!value || value.trim().length === 0) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_REQUIRED,
        message: 'A document type is required before uploading.',
      });
    }
    if (!(CHECK_DOCUMENT_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_INVALID,
        message: `"${value}" is not a known document type.`,
      });
    }
    if (!section.allowedDocumentTypes.includes(value)) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.DOCUMENT_TYPE_NOT_IN_SECTION,
        message: `"${value}" is not an allowed document type of section "${section.key}".`,
      });
    }
    return value as CheckDocumentType;
  }

  /** `undefined`/whitespace → `null` (cleared); otherwise the trimmed text. */
  private normalizeDescription(value: string | undefined): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Reduces a client filename to a safe, bounded basename (the 49F/50 contract): path
   * separators stripped, everything outside `[A-Za-z0-9._-]` replaced, length capped —
   * because this name joins the STORAGE KEY and later becomes a Content-Disposition.
   */
  private safeFileName(original: string | undefined, fallbackId: string): string {
    const base = (original ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._]+/, '')
      .slice(-120);

    return cleaned.length > 0 ? cleaned : `attachment-${fallbackId.slice(0, 8)}`;
  }
}
