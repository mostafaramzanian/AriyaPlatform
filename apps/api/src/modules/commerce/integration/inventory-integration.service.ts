import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DuplicatePostingError } from '../../inventory/stock/stock.service';
import type { CommerceActor } from '../commerce-actor';
import type { CommerceTransactionHandle } from '../database/commerce-transaction';
import { InventoryPostingRepository } from './inventory-posting.repository';
import { INVENTORY_POSTING_PORT, type InventoryPostingPort } from './inventory-posting.port';
import { CommerceNotificationGateway } from '../commerce-notification.gateway';

/**
 * Phase W2-B (Commerce → Inventory integration): the application layer that
 * turns Commerce's append-only receiving/return history into planned,
 * attempted and retryable Inventory postings.
 *
 * THE CONTRACT, IN ONE PARAGRAPH
 * ------------------------------
 * A stocked receipt line (`itemReference` set — the SKU the tenant's
 * inventory catalogue resolves) must name the destination cell it arrives
 * into (`warehouseId`, optional `locationId` on the receipt line input).
 * Planning runs INSIDE the receipt/dispatch transaction — a durable
 * `InventoryPosting` row (PENDING) commits with the business event it stands
 * for. Attempting runs AFTER that commit through the injected
 * `InventoryPostingPort`, the ONLY way Commerce reaches Inventory: success
 * marks the row POSTED with the movement id, a duplicate answer marks it
 * POSTED without a second movement, and any refusal marks it FAILED with the
 * server's reason verbatim — visible and retryable, never thrown back into
 * the receipt request (the receipt is already committed history; the posting
 * row is the repair handle).
 *
 * WHAT THIS SERVICE MAY NEVER DO: reach Inventory's repositories, Prisma or
 * database directly (the port is the whole boundary); guess an item for a
 * line with no `itemReference` (the line is simply not stocked — no posting
 * is planned); invent a cell for an outbound posting (a compensation or a
 * dispatched return inherits the cell its ORIGIN posting recorded — stock
 * leaves where it arrived); or mutate `ReceiptLine`, `ReturnLine`, or any
 * inventory balance.
 */

/** The posting kinds this slice owns — VARCHAR on the column, closed here. */
export const POSTING_KIND = {
  /** A physical receipt line arriving into a warehouse cell. */
  RECEIPT: 'RECEIPT',
  /** A compensating (negative) receiving line — stock goes back out. */
  RECEIPT_COMPENSATION: 'RECEIPT_COMPENSATION',
  /** A return that reached physical handover — goods leave the cell. */
  RETURN_DISPATCH: 'RETURN_DISPATCH',
} as const;

/** One purchase line's facts a posting plan needs — no generated type. */
export interface PostingPurchaseLine {
  readonly id: string;
  readonly itemReference: string | null;
  readonly unit: string | null;
}

/** One created receipt line as `append` returns it. */
export interface PostingReceiptLine {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly quantity: unknown;
}

/** The destination cell one receipt line input may state. */
export interface PostingCellInput {
  readonly purchaseLineId: string;
  readonly warehouseId?: string;
  readonly locationId?: string;
}

/** One return line as a `RECEIVED_BACK` transition dispatches it. */
export interface PostingReturnLine {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly receiptLineId: string;
  readonly quantity: unknown;
}

/** The posting row, as the attempt step consumes it. */
export interface InventoryPostingRow {
  readonly id: string;
  readonly kind: string;
  readonly sourceLineId: string;
  readonly purchaseLineId: string;
  readonly itemRef: string;
  readonly itemId: string | null;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly quantity: unknown;
  readonly unit: string;
  readonly status: string;
  readonly attempts: number;
}

@Injectable()
export class InventoryIntegrationService {
  constructor(
    private readonly postings: InventoryPostingRepository,
    @Inject(INVENTORY_POSTING_PORT) private readonly inventory: InventoryPostingPort,
    private readonly notification: CommerceNotificationGateway
  ) {}

  /**
   * Plan the inbound postings of a just-appended receipt — INSIDE the receipt
   * transaction, so the event and its posting records commit or roll back
   * together. Returns the planned posting ids for the post-commit attempt.
   *
   * A receipt line plans a posting only when its purchase line carries an
   * `itemReference`; a SERVICE or non-stocked line plans none. A stocked line
   * without `warehouseId` is a 400 — refusing the whole receipt inside the
   * transaction is the module's named-refusal rule, because accepting goods
   * "somewhere unspecified" would plan a posting that can only ever fail.
   *
   * `cells` is matched to created lines BY INDEX — `append` creates the lines
   * in payload order, so `row.lines[i]` is `dto.lines[i]`.
   */
  async planReceiptPostings(
    tx: CommerceTransactionHandle,
    tenantId: string,
    receiptLines: readonly PostingReceiptLine[],
    purchaseLines: readonly PostingPurchaseLine[],
    cells: readonly PostingCellInput[]
  ): Promise<string[]> {
    const purchaseById = new Map(purchaseLines.map((line) => [line.id, line]));
    const planned: string[] = [];
    for (let index = 0; index < receiptLines.length; index += 1) {
      const line = receiptLines[index];
      const purchaseLine = purchaseById.get(line.purchaseLineId);
      const itemRef = purchaseLine?.itemReference?.trim();
      if (!itemRef) continue; // not a stocked line — nothing posts
      const cell = cells[index];
      if (!cell?.warehouseId) {
        throw new BadRequestException(
          `warehouseId is required on receipt lines of stock-tracked purchase line ` +
            `${line.purchaseLineId} (itemReference "${itemRef}")`
        );
      }
      planned.push(
        await this.postings.plan(tenantId, tx, {
          kind: POSTING_KIND.RECEIPT,
          sourceLineId: line.id,
          purchaseLineId: line.purchaseLineId,
          itemRef,
          warehouseId: cell.warehouseId,
          locationId: cell.locationId ?? '',
          quantity: String(line.quantity),
          unit: purchaseLine?.unit ?? '',
        })
      );
    }
    return planned;
  }

  /**
   * Plan the outbound posting of a just-appended COMPENSATING receipt line —
   * inside the compensation transaction. Nothing is planned when the origin
   * line's RECEIPT posting never reached the ledger: there is no stock to
   * send back, and the compensating commerce row stands alone.
   */
  async planCompensationPosting(
    tx: CommerceTransactionHandle,
    tenantId: string,
    compensatingLine: PostingReceiptLine,
    originReceiptLineId: string
  ): Promise<string[]> {
    const origin = await this.postings.findPostedForSourceLine(
      tenantId,
      POSTING_KIND.RECEIPT,
      originReceiptLineId,
      tx
    );
    if (!origin) return [];
    return [
      await this.postings.plan(tenantId, tx, {
        kind: POSTING_KIND.RECEIPT_COMPENSATION,
        sourceLineId: compensatingLine.id,
        purchaseLineId: compensatingLine.purchaseLineId,
        itemRef: origin.itemRef,
        warehouseId: origin.warehouseId,
        locationId: origin.locationId,
        // The compensating commerce quantity is negative by construction;
        // the posting stores the positive magnitude — the SIGN of the stock
        // effect is decided by the outbound ledger kind, not the payload.
        quantity: String(compensatingLine.quantity).replace(/^-/, ''),
        unit: origin.unit,
      }),
    ];
  }

  /**
   * Plan the outbound postings of a `RECEIVED_BACK` transition — inside the
   * transition transaction, one per return line whose origin receipt posting
   * reached the ledger. The cell and item are INHERITED from the origin
   * posting: goods leave from where the receipt put them.
   */
  async planReturnDispatchPostings(
    tx: CommerceTransactionHandle,
    tenantId: string,
    returnLines: readonly PostingReturnLine[]
  ): Promise<string[]> {
    const planned: string[] = [];
    for (const line of returnLines) {
      const origin = await this.postings.findPostedForSourceLine(
        tenantId,
        POSTING_KIND.RECEIPT,
        line.receiptLineId,
        tx
      );
      if (!origin) continue; // stock never reached the ledger — nothing to dispatch
      planned.push(
        await this.postings.plan(tenantId, tx, {
          kind: POSTING_KIND.RETURN_DISPATCH,
          sourceLineId: line.id,
          purchaseLineId: line.purchaseLineId,
          itemRef: origin.itemRef,
          warehouseId: origin.warehouseId,
          locationId: origin.locationId,
          quantity: String(line.quantity),
          unit: origin.unit,
        })
      );
    }
    return planned;
  }

  /**
   * Attempt every non-POSTED posting of a set — the post-commit step the
   * receipt, compensation and dispatch paths call. Each attempt is isolated:
   * one FAILED row never stops the next, and no outcome is thrown — the
   * caller's business act already committed and the row records the result.
   */
  async attemptPostings(actor: CommerceActor, postingIds: readonly string[]): Promise<void> {
    for (const id of postingIds) {
      const posting = await this.postings.findById(actor.tenantId, id);
      if (!posting || posting.status === 'POSTED') continue;
      await this.attempt(actor, posting);
      await this.notifyFirstFailure(actor, id);
    }
  }

  /**
   * PHASE W2-C (GAP-H): the operator signal — ONE in-app notification to the
   * acting user when a posting reaches FAILED for the FIRST time.
   *
   * DEDUP IS THE `attempts === 1` GUARD: a background retry that keeps failing
   * never re-notifies (the posting row is the durable evidence, not the alert
   * log), and a retry that SUCCEEDS notifies nobody. The recipient is the
   * actor who committed the business event — the only recipient this layer can
   * name from authoritative state, since Commerce owns no operator-roster
   * directory. The gateway swallows delivery failures, so a notification
   * outage can never mark a committed posting as failed.
   */
  private async notifyFirstFailure(actor: CommerceActor, postingId: string): Promise<void> {
    const fresh = await this.postings.findById(actor.tenantId, postingId);
    if (!fresh || fresh.status !== 'FAILED' || fresh.attempts !== 1 || !actor.userId) return;
    await this.notification.notifyUsers(actor, [actor.userId], {
      type: 'SYSTEM',
      title: 'ثبت سند انبار ناموفق بود',
      body: `یکپارچه‌سازی انبار برای سند ${fresh.kind} با شناسه ${fresh.sourceLineId} ناموفق بود؛ از صف ثبت انبار اقدام به تلاش مجدد کنید.`,
      sourceType: 'commerce.inventory-posting',
      sourceId: fresh.id,
    });
  }

  /**
   * Retry ONE posting — the operator surface. 404 for absent/foreign ids;
   * a POSTED row is the idempotent no-op answer. Returns the row's new state.
   */
  async retry(actor: CommerceActor, postingId: string) {
    const posting = await this.postings.findById(actor.tenantId, postingId);
    if (!posting) throw new NotFoundException('Inventory posting not found');
    if (posting.status !== 'POSTED') await this.attempt(actor, posting);
    const fresh = await this.postings.findById(actor.tenantId, postingId);
    return postingView(fresh ?? posting);
  }

  /** The tenant's posting queue — the observability read. */
  async list(actor: CommerceActor, status?: string) {
    const rows = await this.postings.list(actor.tenantId, { status, limit: 500 });
    return { postings: rows.map((row) => postingView(row)) };
  }

  /**
   * ONE attempt against Inventory, through the port: resolve the SKU to the
   * tenant's stocked item, then post the ledger movement the kind asks for.
   * Every outcome lands on the row — POSTED with the movement id (or without
   * it, when the ledger's own idempotency answered "already there"), or
   * FAILED with the verbatim refusal. This method NEVER throws.
   */
  private async attempt(actor: CommerceActor, posting: InventoryPostingRow): Promise<void> {
    const startedAt = new Date();
    let outcome: Omit<
      Parameters<InventoryPostingRepository['recordOutcome']>[2],
      'actorUserId' | 'startedAt' | 'finishedAt'
    >;
    try {
      const item =
        posting.itemId !== null
          ? { id: posting.itemId }
          : await this.inventory.resolveItemBySku(actor.tenantId, posting.itemRef);
      if (item && posting.itemId === null) {
        await this.postings.recordResolvedItem(actor.tenantId, posting.id, item.id);
      }
      if (!item) {
        outcome = {
          result: 'FAILED',
          status: 'FAILED',
          error: `No stocked inventory item with SKU "${posting.itemRef}" exists for this tenant`,
        };
      } else {
        const request = {
          tenantId: actor.tenantId,
          userId: actor.userId,
          itemId: item.id,
          warehouseId: posting.warehouseId,
          locationId: posting.locationId === '' ? undefined : posting.locationId,
          quantity: Number(String(posting.quantity)),
          unit: posting.unit,
        };
        const movement =
          posting.kind === POSTING_KIND.RECEIPT
            ? await this.inventory.postReceiptPosting({ ...request, sourceId: posting.sourceLineId })
            : await this.inventory.postOutboundPosting({
                ...request,
                kind: posting.kind === POSTING_KIND.RETURN_DISPATCH ? 'SUPPLIER_RETURN' : 'ISSUE',
                sourceType:
                  posting.kind === POSTING_KIND.RETURN_DISPATCH
                    ? 'commerce.return-line'
                    : 'commerce.receipt-compensation',
                sourceId: posting.sourceLineId,
              });
        outcome = { result: 'POSTED', status: 'POSTED', movementId: movement.id };
      }
    } catch (error) {
      outcome =
        error instanceof DuplicatePostingError
          ? // The ledger already holds this movement — the earlier attempt's mark
            // was lost, not the movement. The row joins the evidence, no repost.
            { result: 'POSTED_DUPLICATE', status: 'POSTED', movementId: null }
          : {
              result: 'FAILED',
              status: 'FAILED',
              error: error instanceof Error ? error.message : String(error),
              itemId: posting.itemId,
            };
    }
    try {
      await this.postings.recordOutcome(actor.tenantId, posting.id, {
        ...outcome,
        actorUserId: actor.userId,
        startedAt,
        finishedAt: new Date(),
      });
    } catch {
      // The durable evidence write itself failed — the attempt's outcome is
      // already determined and a record failure cannot be recorded; this
      // method still NEVER throws over a committed business event.
    }
  }
}

/**
 * The wire projection of one posting — stated field by field so `tenantId`
 * never reaches a body by omission, matching every other slice's view.
 * `quantity` is the exact `Decimal(18,4)` STRING.
 */
function postingView(posting: InventoryPostingRow & { status: string; attempts?: number; lastError?: string | null; lastAttemptAt?: Date | null; movementId?: string | null }) {
  return {
    id: posting.id,
    kind: posting.kind,
    sourceLineId: posting.sourceLineId,
    purchaseLineId: posting.purchaseLineId,
    itemRef: posting.itemRef,
    itemId: posting.itemId ?? null,
    warehouseId: posting.warehouseId,
    locationId: posting.locationId,
    quantity: String(posting.quantity),
    unit: posting.unit,
    status: posting.status,
    movementId: posting.movementId ?? null,
    attempts: posting.attempts ?? 0,
    lastError: posting.lastError ?? null,
    lastAttemptAt: posting.lastAttemptAt ?? null,
  };
}
