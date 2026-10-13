import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { Prisma } from '../../../generated/commerce-client';
import type { PurchaseCompletionPolicyVersion } from '../../../generated/commerce-client';

/**
 * PHASE C4-R (GAP-3): the PURCHASE COMPLETION POLICY persistence boundary — every
 * statement this module issues against `PurchaseCompletionPolicyVersion`, and nothing
 * else.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * Reads and writes on the tenant's versioned completion policy. It does NOT evaluate the
 * policy (that is `purchase-completion-policy.ts`, pure), does NOT decide which transitions
 * are legal (the service asks the status, this file only writes conditionally), and does
 * NOT touch `PurchaseDocument` — the document's own writer stays `purchase.repository.ts`,
 * which is why this slice owns exactly ONE model.
 *
 * WHY EVERY WRITE IS CONDITIONAL
 * ------------------------------
 * `updateMany` with the expected status in its `where`, `count === 0` reported as `null`:
 * this is the module's ONE concurrency mechanism (submit, commercial projection, commercial
 * configuration all behave this way). Two administrators validating the same draft, or a
 * publish racing an archive, therefore produce exactly one winner and one refusal — never
 * a silent second transition nobody can attribute. The schema carries no optimistic-version
 * column because no contract states a conflict response for it; the predicate IS the
 * version.
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every public method and appears in every `where`.
 * `findUnique` is never used: it cannot carry a tenant predicate. The single-published
 * invariant is enforced per tenant — archiving "the previously published row" is scoped by
 * `tenantId`, so tenant A's publication can never retire tenant B's policy.
 */

/** One policy version as this boundary accepts it for creation. Always a DRAFT. */
export interface PurchaseCompletionPolicyWrite {
  readonly status: 'DRAFT';
  readonly versionLabel: string;
  readonly allowedFromStatuses: readonly string[];
}

/** The optional narrowing of the policy list read: the shared `search` filter. */
export interface PurchaseCompletionPolicyFilter {
  readonly search?: string;
}

@Injectable()
export class PurchaseCompletionPolicyRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /** Insert ONE policy version. The caller has already checked the label (409) and the set. */
  async create(
    tenantId: string,
    data: PurchaseCompletionPolicyWrite
  ): Promise<PurchaseCompletionPolicyVersion> {
    return this.prisma.purchaseCompletionPolicyVersion.create({
      data: {
        tenantId,
        status: data.status,
        versionLabel: data.versionLabel,
        allowedFromStatuses: data.allowedFromStatuses as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** One policy version by id, tenant-qualified by construction. */
  async findById(tenantId: string, id: string): Promise<PurchaseCompletionPolicyVersion | null> {
    return this.prisma.purchaseCompletionPolicyVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * One policy version by the tenant's own label — the collision read the create path
   * performs before it writes. The schema's `@@unique([tenantId, versionLabel])` is the
   * GUARANTEE; this read turns the ordinary collision into the module's named 409 instead
   * of a driver error.
   */
  async findByLabel(
    tenantId: string,
    versionLabel: string
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    return this.prisma.purchaseCompletionPolicyVersion.findFirst({
      where: { tenantId, versionLabel },
    });
  }

  /**
   * One page of the tenant's policy versions as `[rows, total]`, newest first.
   *
   * `search` matches the column that IDENTIFIES a policy version — its `versionLabel` — so
   * a search can never match a status set nobody stored in a text column. The rows and the
   * count are read in one transaction, so the page and its total are a single snapshot, and
   * `id` breaks a `createdAt` tie so a paging client cannot see one row twice.
   */
  async listPage(
    tenantId: string,
    filter: PurchaseCompletionPolicyFilter,
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.search
        ? { versionLabel: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.purchaseCompletionPolicyVersion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.purchaseCompletionPolicyVersion.count({ where }),
    ]);
  }

  /**
   * The tenant's PUBLISHED completion policy — THE authoritative read of the completion
   * act, and the only one.
   *
   * AT MOST ONE, BY CONSTRUCTION: publishing archives the previously published row in the
   * same unit of work, which is the commercial configuration's single-published invariant
   * applied to this row. The order is nevertheless deterministic (`createdAt desc, id asc`)
   * so that an invariant broken by some future path still answers the SAME row twice rather
   * than a different one per request — and the caller treats "none" as NOT CONFIGURED
   * (fail-closed), never as "pick a draft".
   */
  async findPublished(
    tenantId: string,
    tx?: CommerceTransactionHandle
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.purchaseCompletionPolicyVersion.findFirst({
      where: { tenantId, status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
    });
  }

  /**
   * Edit a DRAFT's `allowedFromStatuses`. `count === 0` means the row was no longer a
   * DRAFT (a publish won the race), so the caller refuses instead of rewriting a
   * configuration that may already govern purchases.
   */
  async updateDraftIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string,
    allowedFromStatuses: readonly string[]
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.purchaseCompletionPolicyVersion.updateMany({
      where: { tenantId, id, status: 'DRAFT' },
      data: { allowedFromStatuses: allowedFromStatuses as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return null;
    return client.purchaseCompletionPolicyVersion.findFirst({ where: { tenantId, id } });
  }

  /** DRAFT → VALIDATED, conditionally: the accepted configuration's checkpoint. */
  async validateIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.purchaseCompletionPolicyVersion.updateMany({
      where: { tenantId, id, status: 'DRAFT' },
      data: { status: 'VALIDATED' },
    });
    if (count === 0) return null;
    return client.purchaseCompletionPolicyVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * Put ONE policy in force, inside the caller's unit of work: archive every currently
   * published policy of THIS tenant, then publish this row (DRAFT or VALIDATED — the
   * service validates a DRAFT on the handle first, so this statement accepts both).
   * `count === 0` on the final update means the row was not in a publishable status, and
   * the whole unit rolls back, leaving the previous policy in force.
   */
  async publishIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    await client.purchaseCompletionPolicyVersion.updateMany({
      where: { tenantId, status: 'PUBLISHED', NOT: { id } },
      data: { status: 'ARCHIVED' },
    });
    const { count } = await client.purchaseCompletionPolicyVersion.updateMany({
      where: { tenantId, id, status: { in: ['DRAFT', 'VALIDATED'] } },
      data: { status: 'PUBLISHED' },
    });
    if (count === 0) return null;
    return client.purchaseCompletionPolicyVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * ARCHIVE a policy version — conditional on not already archived, and the ONLY way a
   * published policy leaves force (retiring completion entirely: a tenant with no PUBLISHED
   * row has completion NOT CONFIGURED and therefore fails closed).
   */
  async archiveIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<PurchaseCompletionPolicyVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.purchaseCompletionPolicyVersion.updateMany({
      where: { tenantId, id, status: { in: ['DRAFT', 'VALIDATED', 'PUBLISHED'] } },
      data: { status: 'ARCHIVED' },
    });
    if (count === 0) return null;
    return client.purchaseCompletionPolicyVersion.findFirst({ where: { tenantId, id } });
  }
}
