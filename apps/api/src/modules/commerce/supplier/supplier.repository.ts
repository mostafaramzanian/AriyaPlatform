import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/commerce-client';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import type {
  SupplierEntityTypeValue,
  SupplierStatusValue,
} from './supplier.constants';

/**
 * The supplier directory's persistence boundary — every statement this slice
 * issues against `commerce_db`, and nothing else.
 *
 * WHY ITS OWN REPOSITORY: `Supplier` is a master register with its OWN writes
 * (create, conditional update) and its own duplicate race (the national-code
 * unique); the purchase repository owns document transitions and must not grow
 * a second family of them. The two cross-slice READS below (purchase documents
 * and quotations naming this supplier) are the same read seam payment and
 * receiving use — observation only, never a write.
 *
 * TENANCY: `tenantId` is the first parameter of every method and appears in
 * every `where`. `findUnique` is never used (it cannot carry a tenant
 * predicate — the module-wide D5 rule); `update` is never used either, because
 * its `where` must be a unique compound Prisma cannot express with the tenant
 * predicate — `updateMany` carries it and reports the count the service turns
 * into a 404.
 *
 * THE DUPLICATE RACE IS ANSWERED HERE: two creates with the same national code
 * cannot both land — the `(tenantId, nationalCode)` unique index refuses the
 * second and the driver's P2002 is translated into
 * `SupplierNationalCodeConflictError` so the service answers 409 without
 * importing a driver type (the `QuotationVersionConflictError` precedent).
 */

/** Prisma's unique-violation code, answered structurally rather than by message text. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export class SupplierNationalCodeConflictError extends Error {
  constructor() {
    super('Another supplier in this tenant already holds this national code');
    this.name = 'SupplierNationalCodeConflictError';
  }
}

/** The row facts `createSupplier` stores. */
export interface SupplierCreateData {
  readonly entityType: SupplierEntityTypeValue;
  readonly name: string;
  readonly companyName: string | null;
  readonly nationalCode: string | null;
  readonly shebaNumber: string | null;
  readonly cardNumber: string | null;
  readonly bankName: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly status: SupplierStatusValue;
  readonly createdByUserId: string;
}

/** The fields `updateSupplierIn` may change — a partial of the create data. */
export interface SupplierUpdateData {
  readonly entityType?: SupplierEntityTypeValue;
  readonly name?: string;
  readonly companyName?: string | null;
  readonly nationalCode?: string | null;
  readonly shebaNumber?: string | null;
  readonly cardNumber?: string | null;
  readonly bankName?: string | null;
  readonly address?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
  readonly status?: SupplierStatusValue;
  readonly updatedByUserId: string;
}

/** The page window every list read takes (already clamped by the service). */
export interface SupplierPageWindow {
  readonly skip: number;
  readonly take: number;
}

/** The list filters the directory read answers — exact matches plus `search`. */
export interface SupplierListFilters {
  readonly search?: string;
  readonly entityType?: SupplierEntityTypeValue;
  readonly status?: SupplierStatusValue;
}

@Injectable()
export class SupplierRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /** One supplier of this tenant, or `null` — the read every act gates on. */
  async findSupplierById(tenantId: string, id: string) {
    return this.prisma.supplier.findFirst({ where: { tenantId, id } });
  }

  /**
   * An EXACT-identity twin of a candidate row, or `null`. Exact equality on
   * (entityType, name, nationalCode) — the defined matching rule the business
   * requirements demand; an unstated national code matches only another
   * unstated one (SQL `= NULL` matches nothing, so the branch splits).
   */
  async findExactIdentity(
    tenantId: string,
    entityType: SupplierEntityTypeValue,
    name: string,
    nationalCode: string | null
  ) {
    return this.prisma.supplier.findFirst({
      where:
        nationalCode === null
          ? { tenantId, entityType, name, nationalCode: null }
          : { tenantId, entityType, name, nationalCode },
      select: { id: true, name: true },
    });
  }

  /** One page of the directory, ordered by name, plus the unfiltered total. */
  async listSuppliers(
    tenantId: string,
    filters: SupplierListFilters,
    window: SupplierPageWindow
  ) {
    const where: Prisma.SupplierWhereInput = {
      tenantId,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { companyName: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          entityType: true,
          name: true,
          companyName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Insert ONE supplier and its audit outbox row, in the CALLER's transaction
   * — the module's `unwrapCommerceTransaction` convention. A national-code
   * collision surfaces as `SupplierNationalCodeConflictError`; anything else is
   * rethrown untouched.
   */
  async createSupplier(
    tenantId: string,
    data: SupplierCreateData,
    buildOutbox: (supplierId: string) => CommerceAuditOutboxPayload,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);
    try {
      const row = await client.supplier.create({ data: { tenantId, ...data } });
      await client.auditOutbox.create({ data: buildOutbox(row.id) });
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new SupplierNationalCodeConflictError();
      throw error;
    }
  }

  /**
   * The ONE update write: change the named fields of THIS tenant's row, record
   * the server-resolved actor, and append the audit outbox row — all inside the
   * caller's transaction. Returns the updated row, or `null` when the
   * conditional write matched nothing (unknown id or foreign tenant).
   */
  async updateSupplierIn(
    tenantId: string,
    id: string,
    data: SupplierUpdateData,
    outbox: CommerceAuditOutboxPayload,
    tx: CommerceTransactionHandle
  ) {
    const client = unwrapCommerceTransaction(tx);
    try {
      const result = await client.supplier.updateMany({
        where: { tenantId, id },
        data: { ...data },
      });
      if (result.count === 0) return null;
      const row = await client.supplier.findFirst({ where: { tenantId, id } });
      if (row) await client.auditOutbox.create({ data: outbox });
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new SupplierNationalCodeConflictError();
      throw error;
    }
  }

  /**
   * Cross-slice READ seam: the purchase documents that NAME this supplier
   * (`PurchaseDocument.supplierId` carries the directory id when the requester
   * selected one). Newest first; a bounded page plus the unfiltered total.
   * Writes never happen here — `purchase.repository.ts` stays the document's
   * only writer.
   */
  async listPurchasesForSupplier(
    tenantId: string,
    supplierId: string,
    window: SupplierPageWindow
  ) {
    const where = { tenantId, supplierId };
    const [items, total] = await Promise.all([
      this.prisma.purchaseDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          documentNumber: true,
          kind: true,
          status: true,
          currency: true,
          totalAmount: true,
          createdAt: true,
        },
      }),
      this.prisma.purchaseDocument.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Cross-slice READ seam: the quotations that name this supplier
   * (`PriceQuotation.supplierId`). Same posture as the purchase history read.
   */
  async listQuotationsForSupplier(
    tenantId: string,
    supplierId: string,
    window: SupplierPageWindow
  ) {
    const where = { tenantId, supplierId };
    const [items, total] = await Promise.all([
      this.prisma.priceQuotation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          purchaseDocumentId: true,
          version: true,
          supplierLabel: true,
          quoteReference: true,
          quoteDate: true,
          currency: true,
          totalAmount: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.priceQuotation.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * PHASE W2-C (supplier reconciliation): the DISTINCT `supplierId` values the
   * tenant's purchase documents actually carry, each with its document count —
   * the references a reconciliation walks, as a `groupBy` projection (no rows
   * materialised). Documents with no supplier state nothing and reconcile to
   * nothing, so NULL is excluded.
   */
  async listPurchaseSupplierRefs(tenantId: string) {
    return this.prisma.purchaseDocument.groupBy({
      by: ['supplierId'],
      where: { tenantId, supplierId: { not: null } },
      _count: { supplierId: true },
    });
  }

  /**
   * The WHOLE tenant supplier directory as the reconciliation's match set —
   * id, the two matchable identity fields and status. A directory read, not a
   * page: matching must see every candidate, so a match on page two is never
   * reported as unresolved.
   */
  async listAllForReconciliation(tenantId: string) {
    return this.prisma.supplier.findMany({
      where: { tenantId },
      select: { id: true, name: true, nationalCode: true, status: true },
      orderBy: { name: 'asc' },
    });
  }
}
