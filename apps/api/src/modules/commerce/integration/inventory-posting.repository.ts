import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';

/**
 * Phase W2-B (Commerce → Inventory integration): the `InventoryPosting`
 * persistence boundary — every statement this slice issues against the ONE
 * durable record that joins Commerce's append-only receiving/return history
 * to Inventory's append-only stock ledger.
 *
 * WHY A TABLE AT ALL: no transaction spans `commerce_db` and
 * `inventory_db`, so "receipt committed, posting unknown" is a state the
 * system must be able to SEE and REPAIR — not an exception lost between two
 * commits. A posting row is planned INSIDE the same unit of work as the
 * receipt line / return dispatch it was created from (the `tx` parameter
 * below), attempted after that commit, and re-attempted through the retry
 * surface; `status` + `lastError` + `attempts` make every failure a stored,
 * queryable fact.
 *
 * THIS FILE IS THE SOLE WRITER of `InventoryPosting` — and deliberately the
 * ONE repository in this module that updates rows: a posting is a state
 * machine (PENDING → POSTED / FAILED → POSTED), not an append-only history,
 * because the history it stands for already lives in `ReceiptLine` /
 * `ReturnLine`. `markPosted`/`markFailed` are `updateMany` keyed by
 * (tenantId, id) — the same tenant-first predicate every method here keeps.
 *
 * NOT APPEND-ONLY, BY DESIGN: re-writing `status` is exactly what the row
 * exists for. The history it mirrors is never touched.
 */

/** One planned posting, as a write. */
export interface InventoryPostingPlanWrite {
  kind: string;
  sourceLineId: string;
  purchaseLineId: string;
  itemRef: string;
  warehouseId: string;
  locationId: string;
  quantity: string;
  unit: string;
}

@Injectable()
export class InventoryPostingRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * Plan one posting INSIDE the caller's unit of work — the same transaction
   * that appends the receipt line or the `RECEIVED_BACK` transition, so an
   * event can never commit without its durable posting record. Returns the
   * created row's id for the post-commit attempt.
   */
  async plan(
    tenantId: string,
    tx: CommerceTransactionHandle,
    data: InventoryPostingPlanWrite
  ): Promise<string> {
    const row = await unwrapCommerceTransaction(tx).inventoryPosting.create({
      data: {
        tenantId,
        kind: data.kind,
        sourceLineId: data.sourceLineId,
        purchaseLineId: data.purchaseLineId,
        itemRef: data.itemRef,
        warehouseId: data.warehouseId,
        locationId: data.locationId,
        quantity: data.quantity,
        unit: data.unit,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * The posting a source line already produced, or `null` — the ORIGIN
   * lookup a compensation or dispatched return runs to inherit the cell and
   * item the goods actually arrived in. `status: 'POSTED'` is part of the
   * predicate: only a posting that reached the ledger has stock to send back.
   */
  async findPostedForSourceLine(
    tenantId: string,
    kind: string,
    sourceLineId: string,
    tx: CommerceTransactionHandle
  ) {
    return unwrapCommerceTransaction(tx).inventoryPosting.findFirst({
      where: { tenantId, kind, sourceLineId, status: 'POSTED' },
    });
  }

  /** One posting of THIS tenant, or `null` — the retry route's 404 gate. */
  async findById(tenantId: string, id: string) {
    return this.prisma.inventoryPosting.findFirst({ where: { tenantId, id } });
  }

  /**
   * The postings planned from a set of source lines — what the post-commit
   * attempt re-reads (fresh rows, after the receipt transaction committed).
   */
  async listForSourceLines(tenantId: string, kind: string, sourceLineIds: string[]) {
    if (sourceLineIds.length === 0) return [];
    return this.prisma.inventoryPosting.findMany({
      where: { tenantId, kind, sourceLineId: { in: sourceLineIds } },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    });
  }

  /**
   * The operational queue read: the tenant's postings, optionally narrowed to
   * one status — PENDING/FAILED is the "needs attention" surface, POSTED is
   * the ledger evidence. Bounded by the caller's limit.
   */
  async list(tenantId: string, filter: { status?: string; limit: number }) {
    return this.prisma.inventoryPosting.findMany({
      where: {
        tenantId,
        ...(filter.status ? { status: filter.status as 'PENDING' | 'POSTED' | 'FAILED' } : {}),
      },
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      take: filter.limit,
    });
  }

  /**
   * The SINGLE write path that records ONE attempt's outcome — replaces the
   * old separate `markPosted`/`markFailed`: the posting's current-state
   * fields (status, lastError, attempts, lastAttemptAt, movementId, itemId)
   * AND the append-only `InventoryPostingAttempt` row land in the SAME
   * transaction, so the row's `attempts` counter and the history table can
   * never disagree. The attempt's ordinal is `posting.attempts + 1` read
   * inside the transaction; the unique (tenantId, postingId, attempt) key
   * is the durable guard against two concurrent retries claiming the same
   * ordinal — a collision rolls the WHOLE outcome back, never leaves the
   * state and its history split.
   *
   * `result` is the attempt vocabulary (POSTED | POSTED_DUPLICATE | FAILED);
   * `status` is what the posting row becomes. A POSTED_DUPLICATE result
   * still lands the posting as POSTED with a NULL movementId — the ledger
   * already held the movement and `sourceId` is the join key.
   */
  async recordOutcome(
    tenantId: string,
    id: string,
    outcome: {
      result: 'POSTED' | 'POSTED_DUPLICATE' | 'FAILED';
      status: 'POSTED' | 'FAILED';
      error?: string | null;
      movementId?: string | null;
      itemId?: string | null;
      actorUserId?: string | null;
      startedAt: Date;
      finishedAt: Date;
    }
  ) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.inventoryPosting.findFirst({
        where: { tenantId, id },
        select: { attempts: true },
      });
      const attempt = (current?.attempts ?? 0) + 1;
      await tx.inventoryPostingAttempt.create({
        data: {
          tenantId,
          postingId: id,
          attempt,
          result: outcome.result,
          error: outcome.error?.slice(0, 2000) ?? null,
          movementId: outcome.movementId ?? null,
          actorUserId: outcome.actorUserId ?? null,
          startedAt: outcome.startedAt,
          finishedAt: outcome.finishedAt,
        },
      });
      await tx.inventoryPosting.updateMany({
        where: { tenantId, id },
        data: {
          status: outcome.status,
          movementId: outcome.status === 'POSTED' ? (outcome.movementId ?? null) : undefined,
          lastError: outcome.status === 'FAILED' ? (outcome.error?.slice(0, 2000) ?? null) : null,
          ...(outcome.itemId ? { itemId: outcome.itemId } : {}),
          attempts: { increment: 1 },
          lastAttemptAt: outcome.finishedAt,
        },
      });
    });
  }

  /**
   * The append-only attempt rows of a set of postings — the purchase
   * history read projects them into the merged timeline so every failure
   * and retry is visible at attempt granularity, not just the last one.
   */
  async listAttempts(tenantId: string, postingIds: readonly string[]) {
    if (postingIds.length === 0) return [];
    return this.prisma.inventoryPostingAttempt.findMany({
      where: { tenantId, postingId: { in: [...postingIds] } },
      orderBy: [{ postingId: 'asc' }, { attempt: 'asc' }],
    });
  }

  /**
   * PHASE W2-C (completion gate): the postings still UNRESOLVED for a set of
   * purchase lines — `PENDING` (planned, never attempted) or `FAILED` (the
   * ledger refused). The completion act reads this before closing a document:
   * a purchase must not be presented as complete while its stock evidence is
   * still in flight or failed. Line ids come from the CALLER (the document's
   * own `lines` include), so this file reads no other slice's model.
   */
  async listUnresolvedForLines(
    tenantId: string,
    purchaseLineIds: readonly string[],
    tx?: CommerceTransactionHandle
  ) {
    if (purchaseLineIds.length === 0) return [];
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.inventoryPosting.findMany({
      where: {
        tenantId,
        purchaseLineId: { in: [...purchaseLineIds] },
        status: { in: ['PENDING', 'FAILED'] },
      },
      select: {
        id: true,
        kind: true,
        status: true,
        purchaseLineId: true,
        lastError: true,
      },
    });
  }

  /** Stamp the resolved item id without touching status (pre-attempt write). */
  async recordResolvedItem(tenantId: string, id: string, itemId: string) {
    await this.prisma.inventoryPosting.updateMany({
      where: { tenantId, id },
      data: { itemId },
    });
  }
}
