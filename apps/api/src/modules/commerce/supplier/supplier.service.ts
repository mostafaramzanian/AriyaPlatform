import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { CommerceUnitOfWork } from '../database/commerce-transaction';
import { resolveCommercePageWindow, type CommercePageQueryDto } from '../dto/commerce-query.dto';
import {
  SUPPLIER_AUDIT_ACTION,
  SUPPLIER_FAILURE,
  type SupplierEntityTypeValue,
  type SupplierStatusValue,
} from './supplier.constants';
import {
  SupplierNationalCodeConflictError,
  SupplierRepository,
  type SupplierCreateData,
  type SupplierUpdateData,
} from './supplier.repository';
import type {
  CreateSupplierDto,
  ListSuppliersQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';

/**
 * The supplier directory's application layer — create, update, read, and the
 * two history reads that answer "what did we buy from this seller?".
 *
 * REFUSALS, each a named 400/404/409 unless stated: a machine context may not
 * write (403 — a supplier row must record the PERSON who entered it, the same
 * posture as the quotation slice); a LEGAL row without `companyName` is
 * refused (400 COMPANY_NAME_REQUIRED); an EXACT-identity duplicate is refused
 * (409 DUPLICATE_IDENTITY — exact equality only, never fuzzy matching); a
 * national-code collision is refused (409 NATIONAL_CODE_EXISTS, from the
 * structural unique); an empty update is refused (400 UPDATE_EMPTY); an
 * unknown or foreign row is 404, indistinguishable from absent.
 *
 * WHAT THIS SERVICE MUST NEVER DO: accept a tenant or actor from a payload,
 * delete a row (retirement is `status: INACTIVE`), expose banking fields in
 * the ordinary projections (they exist only on `banking()`), or write any
 * model another slice owns. Reads audit nothing (the module's §I8 rule);
 * writes record ONE durable outbox event inside the unit of work.
 *
 * NORMALISATION IS DELIBERATELY NARROW: names/labels are trimmed, the SHEBA is
 * uppercased and prefix-normalised to `IR…`. Nothing else is rewritten — a
 * national code is NOT checksum-corrected and a phone is NOT reformatted,
 * because the requirements state no canonical format beyond the wire shape and
 * silently "fixing" identity data is how a wrong supplier gets paid.
 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly repository: SupplierRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  /** The acting USER, or the one refusal a machine context cannot pass. */
  private static actingUserId(actor: CommerceActor): string {
    if (!actor.userId) {
      throw new ForbiddenException(
        'A supplier record names the acting user; this request resolved to a machine context.'
      );
    }
    return actor.userId;
  }

  /** Trim a stated string; absent or blank becomes NULL (never empty). */
  private static text(value: string | undefined): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  /** `ir1234…` / `1234…` → `IR1234…`; absent stays NULL. */
  private static sheba(value: string | undefined): string | null {
    const trimmed = value?.trim().toUpperCase() ?? '';
    if (trimmed === '') return null;
    return trimmed.startsWith('IR') ? trimmed : `IR${trimmed}`;
  }

  /**
   * `GET commerce/suppliers` — one page of the directory. The list projection
   * deliberately carries NO banking fields (the schema block's contract).
   */
  async list(actor: CommerceActor, query: ListSuppliersQueryDto) {
    const window = resolveCommercePageWindow(query as CommercePageQueryDto);
    const { items, total } = await this.repository.listSuppliers(
      actor.tenantId,
      {
        search: query.search?.trim() || undefined,
        entityType: query.entityType,
        status: query.status,
      },
      { skip: window.skip, take: window.take }
    );
    return {
      items: items.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        name: row.name,
        companyName: row.companyName,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /** `GET commerce/suppliers/:id` — the ordinary detail. NO banking fields. */
  async get(actor: CommerceActor, id: string) {
    const row = await this.repository.findSupplierById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Supplier not found');
    return SupplierService.detailView(row);
  }

  /**
   * `GET commerce/suppliers/:id/banking` — the SENSITIVE projection
   * (national code, SHEBA, card, bank). Gated at the controller by
   * `commerce.supplier.manage`; this method still scopes by tenant.
   */
  async banking(actor: CommerceActor, id: string) {
    const row = await this.repository.findSupplierById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Supplier not found');
    return {
      id: row.id,
      name: row.name,
      nationalCode: row.nationalCode,
      shebaNumber: row.shebaNumber,
      cardNumber: row.cardNumber,
      bankName: row.bankName,
    };
  }

  /** `POST commerce/suppliers` — 201 with the stored row. */
  async create(actor: CommerceActor, dto: CreateSupplierDto) {
    const userId = SupplierService.actingUserId(actor);
    const name = dto.name.trim();
    const nationalCode = SupplierService.text(dto.nationalCode);
    const companyName = SupplierService.text(dto.companyName);

    if (dto.entityType === 'LEGAL' && companyName === null) {
      throw new BadRequestException({
        code: SUPPLIER_FAILURE.COMPANY_NAME_REQUIRED,
        message: 'A LEGAL supplier must state its registered company name.',
      });
    }

    const twin = await this.repository.findExactIdentity(
      actor.tenantId,
      dto.entityType,
      name,
      nationalCode
    );
    if (twin) {
      throw new ConflictException({
        code: SUPPLIER_FAILURE.DUPLICATE_IDENTITY,
        message: `An identical supplier already exists ("${twin.name}"). Exact duplicates are refused; similar names are allowed.`,
      });
    }

    const data: SupplierCreateData = {
      entityType: dto.entityType,
      name,
      companyName,
      nationalCode,
      shebaNumber: SupplierService.sheba(dto.shebaNumber),
      cardNumber: SupplierService.text(dto.cardNumber),
      bankName: SupplierService.text(dto.bankName),
      address: SupplierService.text(dto.address),
      phone: SupplierService.text(dto.phone),
      email: SupplierService.text(dto.email),
      notes: SupplierService.text(dto.notes),
      status: dto.status ?? 'ACTIVE',
      createdByUserId: userId,
    };

    const created = await this.unitOfWork
      .run((tx) =>
        this.repository.createSupplier(
          actor.tenantId,
          data,
          (supplierId: string) =>
            this.audit.buildOutboxPayload(actor, {
              action: SUPPLIER_AUDIT_ACTION.CREATED,
              resource: COMMERCE_AUDIT_RESOURCE.SUPPLIER,
              resourceId: supplierId,
              newValue: {
                name: data.name,
                entityType: data.entityType,
                status: data.status,
              },
            }),
          tx
        )
      )
      .catch((error: unknown) => {
        if (!(error instanceof SupplierNationalCodeConflictError)) throw error;
        throw new ConflictException({
          code: SUPPLIER_FAILURE.NATIONAL_CODE_EXISTS,
          message: 'Another supplier in this tenant already holds this national code.',
        });
      });

    return SupplierService.detailView(created);
  }

  /**
   * `PATCH commerce/suppliers/:id` — partial update; absent fields are
   * untouched; a body naming no field is the `UPDATE_EMPTY` refusal. The
   * duplicate rule re-runs against the MERGED row excluding the row itself,
   * so a supplier may keep its own identity but not clone another's.
   */
  async update(actor: CommerceActor, id: string, dto: UpdateSupplierDto) {
    const userId = SupplierService.actingUserId(actor);

    const touched = Object.entries(dto).filter(([, value]) => value !== undefined);
    if (touched.length === 0) {
      throw new BadRequestException({
        code: SUPPLIER_FAILURE.UPDATE_EMPTY,
        message: 'The update named no field to change.',
      });
    }

    const existing = await this.repository.findSupplierById(actor.tenantId, id);
    if (!existing) throw new NotFoundException('Supplier not found');

    const entityType = (dto.entityType ?? existing.entityType) as SupplierEntityTypeValue;
    const name = dto.name !== undefined ? dto.name.trim() : existing.name;
    const nationalCode =
      dto.nationalCode !== undefined
        ? SupplierService.text(dto.nationalCode)
        : existing.nationalCode;
    const companyName =
      dto.companyName !== undefined
        ? SupplierService.text(dto.companyName)
        : existing.companyName;

    if (entityType === 'LEGAL' && companyName === null) {
      throw new BadRequestException({
        code: SUPPLIER_FAILURE.COMPANY_NAME_REQUIRED,
        message: 'A LEGAL supplier must state its registered company name.',
      });
    }

    const twin = await this.repository.findExactIdentity(
      actor.tenantId,
      entityType,
      name,
      nationalCode
    );
    if (twin && twin.id !== id) {
      throw new ConflictException({
        code: SUPPLIER_FAILURE.DUPLICATE_IDENTITY,
        message: `An identical supplier already exists ("${twin.name}"). Exact duplicates are refused; similar names are allowed.`,
      });
    }

    const data: SupplierUpdateData = {
      ...(dto.entityType !== undefined ? { entityType: dto.entityType } : {}),
      ...(dto.name !== undefined ? { name } : {}),
      ...(dto.companyName !== undefined ? { companyName } : {}),
      ...(dto.nationalCode !== undefined ? { nationalCode } : {}),
      ...(dto.shebaNumber !== undefined
        ? { shebaNumber: SupplierService.sheba(dto.shebaNumber) }
        : {}),
      ...(dto.cardNumber !== undefined
        ? { cardNumber: SupplierService.text(dto.cardNumber) }
        : {}),
      ...(dto.bankName !== undefined ? { bankName: SupplierService.text(dto.bankName) } : {}),
      ...(dto.address !== undefined ? { address: SupplierService.text(dto.address) } : {}),
      ...(dto.phone !== undefined ? { phone: SupplierService.text(dto.phone) } : {}),
      ...(dto.email !== undefined ? { email: SupplierService.text(dto.email) } : {}),
      ...(dto.notes !== undefined ? { notes: SupplierService.text(dto.notes) } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      updatedByUserId: userId,
    };

    const updated = await this.unitOfWork
      .run((tx) =>
        this.repository.updateSupplierIn(
          actor.tenantId,
          id,
          data,
          this.audit.buildOutboxPayload(actor, {
            action: SUPPLIER_AUDIT_ACTION.UPDATED,
            resource: COMMERCE_AUDIT_RESOURCE.SUPPLIER,
            resourceId: id,
            changedFields: touched.map(([field]) => field),
            newValue: { name, entityType, status: data.status ?? existing.status },
          }),
          tx
        )
      )
      .catch((error: unknown) => {
        if (!(error instanceof SupplierNationalCodeConflictError)) throw error;
        throw new ConflictException({
          code: SUPPLIER_FAILURE.NATIONAL_CODE_EXISTS,
          message: 'Another supplier in this tenant already holds this national code.',
        });
      });

    if (!updated) throw new NotFoundException('Supplier not found');
    return SupplierService.detailView(updated);
  }

  /**
   * `GET commerce/suppliers/:id/purchases` — the purchase documents that name
   * this supplier. A READ of another slice's model through the repository's
   * declared seam; nothing is written and nothing outside the page leaks.
   */
  async purchaseHistory(actor: CommerceActor, id: string, query: CommercePageQueryDto) {
    const supplier = await this.repository.findSupplierById(actor.tenantId, id);
    if (!supplier) throw new NotFoundException('Supplier not found');
    const window = resolveCommercePageWindow(query);
    const { items, total } = await this.repository.listPurchasesForSupplier(
      actor.tenantId,
      id,
      { skip: window.skip, take: window.take }
    );
    return { items, page: window.page, pageSize: window.pageSize, total };
  }

  /** `GET commerce/suppliers/:id/quotations` — the quotations that name it. */
  async quotationHistory(actor: CommerceActor, id: string, query: CommercePageQueryDto) {
    const supplier = await this.repository.findSupplierById(actor.tenantId, id);
    if (!supplier) throw new NotFoundException('Supplier not found');
    const window = resolveCommercePageWindow(query);
    const { items, total } = await this.repository.listQuotationsForSupplier(
      actor.tenantId,
      id,
      { skip: window.skip, take: window.take }
    );
    return { items, page: window.page, pageSize: window.pageSize, total };
  }

  /**
   * The detail projection — identity, contact, status. NEVER banking: those
   * five fields exist only on `banking()` behind `commerce.supplier.manage`.
   */
  private static detailView(row: {
    id: string;
    entityType: SupplierEntityTypeValue;
    name: string;
    companyName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    notes: string | null;
    status: SupplierStatusValue;
    createdByUserId: string;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      entityType: row.entityType,
      name: row.name,
      companyName: row.companyName,
      address: row.address,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      status: row.status,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * PHASE W2-C (supplier reconciliation, «تطبیق شناسه‌های تأمین‌کننده»):
   * `GET commerce/suppliers/reconciliation` — a READ-ONLY diagnostic that walks
   * every DISTINCT `supplierId` the tenant's purchase documents carry and
   * classifies it against the authoritative Supplier directory.
   *
   * THE FOUR VERDICTS, each stated explicitly so nothing is silently merged:
   *   * `RESOLVED`   — the reference IS a supplier row id (a UUID this
   *     directory holds). Already authoritative; nothing to do.
   *   * `SUGGESTED`  — not a directory id, but EXACTLY ONE supplier matches the
   *     reference as an exact `name` or `nationalCode`. A human reviews and
   *     corrects the DOCUMENT (the reference stays historical, never rewritten
   *     here); the suggestion is evidence, not a write.
   *   * `AMBIGUOUS`  — more than one supplier matches; the report names every
   *     candidate and the row MUST be resolved by an explicit human decision —
   *     never by picking the first.
   *   * `UNRESOLVED` — no supplier matches; the reference is stale, mistyped or
   *     predates the directory.
   *
   * WHY THIS WRITES NOTHING: rewriting historical purchase references is a
   * destructive act on financial evidence. This report is the safe
   * enumeration the requirements ask for; an approved correction is a human's
   * explicit document update, audit-trailed by that route — never a silent
   * backfill inside a report.
   */
  async reconcile(actor: CommerceActor) {
    const [refs, suppliers] = await Promise.all([
      this.repository.listPurchaseSupplierRefs(actor.tenantId),
      this.repository.listAllForReconciliation(actor.tenantId),
    ]);

    const byId = new Map(suppliers.map((s) => [s.id, s]));
    const items = refs
      .map((ref) => {
        const reference = ref.supplierId as string;
        const documentCount = ref._count.supplierId;
        const direct = byId.get(reference);
        if (direct) {
          return {
            reference,
            documentCount,
            resolution: 'RESOLVED' as const,
            matches: [{ id: direct.id, name: direct.name, nationalCode: direct.nationalCode }],
          };
        }
        const candidates = suppliers.filter(
          (s) => s.name === reference || s.nationalCode === reference
        );
        const matches = candidates.map((s) => ({
          id: s.id,
          name: s.name,
          nationalCode: s.nationalCode,
        }));
        const resolution =
          candidates.length === 0
            ? ('UNRESOLVED' as const)
            : candidates.length === 1
              ? ('SUGGESTED' as const)
              : ('AMBIGUOUS' as const);
        return { reference, documentCount, resolution, matches };
      })
      .sort((a, b) => b.documentCount - a.documentCount || a.reference.localeCompare(b.reference));

    const summary = {
      distinctReferences: items.length,
      resolved: items.filter((i) => i.resolution === 'RESOLVED').length,
      suggested: items.filter((i) => i.resolution === 'SUGGESTED').length,
      ambiguous: items.filter((i) => i.resolution === 'AMBIGUOUS').length,
      unresolved: items.filter((i) => i.resolution === 'UNRESOLVED').length,
    };
    return { items, summary, generatedAt: new Date().toISOString() };
  }
}
