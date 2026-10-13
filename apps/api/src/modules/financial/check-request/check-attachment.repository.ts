import { Injectable } from '@nestjs/common';
import { FinancialPrismaService } from '../database/financial-prisma.service';
import type { CheckAttachment } from '../../../generated/financial-client';
import type { CheckDocumentType } from './check-request';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckAttachment persistence boundary — every
 * statement the attachment slice issues against `finance_db`, and nothing else.
 *
 * Same contract as `check-request.repository.ts`: no business rules (the state guards,
 * the document-type gate and the storage dance all live in
 * `check-attachment.service.ts`), tenant-first scoping on EVERY method, and no
 * `findUnique` — `findFirst({ where: { id, tenantId } })` is the only single-row shape,
 * so an id from another tenant returns `null` and the SERVICE maps that to 404.
 *
 * THE SAME-DATABASE, TENANT-COMPOSITE FOREIGN KEY means the database — not this file —
 * is what finally refuses a row whose `checkRequestId` belongs to another tenant's
 * request: the FK targets `CheckRequest(tenant_id, id)`. This repository still only ever
 * writes within a request the service already loaded tenant-scoped, so the constraint is
 * the last line of defence rather than the only one.
 */

/** The subset of writable fields on create. */
export interface CheckAttachmentCreateInput {
  checkRequestId: string;
  section: number;
  /** `null` where the section's configuration declares no type vocabulary (6/7). */
  documentType: CheckDocumentType | null;
  description: string | null;
  storageKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdBy: string;
}

/** The subset of writable fields a metadata patch may change. */
export interface CheckAttachmentMetadataPatch {
  documentType?: CheckDocumentType;
  /** `null` clears the column — the same act as erasing the source's `Tozihat` box. */
  description?: string | null;
}

@Injectable()
export class CheckAttachmentRepository {
  constructor(private readonly prisma: FinancialPrismaService) {}

  /** Inserts one attachment row for the acting tenant. */
  async create(tenantId: string, data: CheckAttachmentCreateInput): Promise<CheckAttachment> {
    return this.prisma.checkAttachment.create({
      data: { ...data, tenantId },
    });
  }

  /** The documents on one request of the acting tenant, oldest first. */
  async listByRequest(tenantId: string, checkRequestId: string): Promise<CheckAttachment[]> {
    return this.prisma.checkAttachment.findMany({
      where: { tenantId, checkRequestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** One attachment of the acting tenant, or `null`. NEVER a read by id alone. */
  async findById(tenantId: string, id: string): Promise<CheckAttachment | null> {
    return this.prisma.checkAttachment.findFirst({ where: { id, tenantId } });
  }

  /**
   * How many documents of ONE section this request holds — the count the process
   * configuration's `requiredForActions` gates ask about («تصویر چک صادر شده بارگذاری
   * نشده است!» is `count(section 6) === 0`, exactly as the task script counted the grid).
   */
  async countByRequestSection(
    tenantId: string,
    checkRequestId: string,
    section: number
  ): Promise<number> {
    return this.prisma.checkAttachment.count({
      where: { tenantId, checkRequestId, section },
    });
  }

  /**
   * Patches one attachment's metadata. The `checkRequestId` in the WHERE is not a
   * tenancy shortcut — `tenantId` is — it binds the row to THE request the caller named,
   * so an id that exists on a DIFFERENT request is `null` rather than a cross-request
   * edit.
   */
  async updateMetadata(
    tenantId: string,
    id: string,
    checkRequestId: string,
    data: CheckAttachmentMetadataPatch
  ): Promise<CheckAttachment | null> {
    const result = await this.prisma.checkAttachment.updateMany({
      where: { id, tenantId, checkRequestId },
      data,
    });

    if (result.count === 0) return null;
    return this.findById(tenantId, id);
  }

  /** Hard-deletes one attachment of one request; `true` when a row was removed. */
  async delete(tenantId: string, id: string, checkRequestId: string): Promise<boolean> {
    const result = await this.prisma.checkAttachment.deleteMany({
      where: { id, tenantId, checkRequestId },
    });
    return result.count > 0;
  }
}
