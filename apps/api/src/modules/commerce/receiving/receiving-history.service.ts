import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { InventoryIntegrationService } from '../integration/inventory-integration.service';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { CommerceUnitOfWork } from '../database/commerce-transaction';
import {
  addMoney,
  compareMoney,
  moneyFromNumber,
  negateMoney,
  sumMoney,
} from '../purchase/purchase-money';
import { ReceivingHistoryRepository } from './receiving-history.repository';
import { CompensateReceiptLineDto, CreateReceiptDto } from './receiving.dto';
import { projectReceivingStatus } from './receiving-status';

/**
 * Phase C1 Step R (§5.16, contract R1–R9 and §3): the receiving history's
 * application layer — append-only writes under the row lock, the read-time
 * receiving status projection, and the ONE audit trail's receiving
 * vocabulary.
 *
 * THE SHAPE OF THIS SERVICE, AND WHAT IS DELIBERATELY MISSING
 * -----------------------------------------------------------
 * Three dependencies: the repository (every statement), the audit gateway
 * (§I8) and the unit of work (§3-H's lock and atomicity). There is NO
 * identity gateway — `receiverId` is the acting session's user taken OFF the
 * actor, never resolved and never client-stated (§16) — NO workflow, NO
 * commercial, NO payment and NO Rule Engine dependency, and no second
 * transaction mechanism: both writes run inside ONE `CommerceUnitOfWork.run`
 * whose FIRST act is `lockDocumentForReceipt` (§3-H), so the over-receipt
 * SUM and the compensation cap are read under the lock that makes them
 * authoritative.
 *
 * THE PROJECTION HAS ONE HOME. `projectReceivingStatus(ordered, received)`
 * in `receiving-status.ts` owns all four rules; this service only gathers
 * the two inputs — the line's OWN stored quantity and Σ over the whole
 * history (never a filtered view) — and reports them beside the events. A
 * rule re-typed here is how `NOT_RECEIVED` and `FULLY_RECEIVED` both end up
 * true for the same quantities.
 *
 * REFUSALS ARE NAMED, NEVER SILENT (§3-E): unknown/foreign document → 404
 * BEFORE any write (the lock statement doubles as the tenant-scoped gate);
 * a line the document does not own → 404; an unknown receipt line → 404;
 * over-receipt → 409 naming ordered/received/requested; an impossible
 * compensation → 409; DTO violations are 400 at the boundary. No fallback,
 * no default, no silent cap — and no status transition anywhere: nothing in
 * this file may write `PurchaseDocument.status` (R6), and nothing reads one
 * to decide anything (§3-I: receiving is an independent lifecycle).
 */

/**
 * The receiving slice's two audit actions, declared beside the code that
 * records them (§3-G). Resource is `COMMERCE_AUDIT_RESOURCE.RECEIPT` — step
 * G declared it for exactly this row. One trail, one row per successful
 * write; reads audit nothing, and a refused write never reaches the audit
 * call because the throw happens inside the unit of work.
 */
export const RECEIVING_AUDIT_ACTION = {
  APPEND: 'append',
  COMPENSATE: 'compensate',
} as const;

/**
 * The structural shape every receipt-bearing history row satisfies — the
 * writes' return type, the reads' return type and the test suite's fakes all
 * fit it, so ONE projection and ONE view serve them. `quantity: unknown`
 * because this service never imports the generated client: it stringifies
 * through `String(...)`, exactly as the payment slice does.
 */
interface ReceiptLinesBearing {
  readonly id: string;
  readonly lines: ReadonlyArray<{
    readonly id: string;
    readonly purchaseLineId: string;
    readonly quantity: unknown;
    readonly reversesReceiptLineId: string | null;
    readonly createdAt: Date;
  }>;
}

/**
 * Every field §6's receipt view renders, beyond the nested lines — the
 * header facts BOTH the write's return value and the read's rows carry, so
 * one view serves `GET` and the two `POST`s without a second shape.
 */
interface ReceiptViewBearing extends ReceiptLinesBearing {
  readonly receivedAt: Date;
  readonly receiverId: string | null;
  readonly createdAt: Date;
}

/**
 * The wire projection of ONE receipt (§6) — its own fields, stated one by
 * one so `tenantId` can never reach a body by omission of thought, exactly
 * as `PaymentHistoryService.view` does. The document id is absent for the
 * same reason: the route already names the document.
 *
 * `quantity` is the exact stored `Decimal(18,4)` STRING, never a number: the
 * wire carries the column's own text, and a compensating line therefore
 * reads as the negative it is.
 */
function receiptView(receipt: ReceiptViewBearing) {
  return {
    id: receipt.id,
    receivedAt: receipt.receivedAt,
    receiverId: receipt.receiverId,
    createdAt: receipt.createdAt,
    lines: receipt.lines.map((line) => ({
      id: line.id,
      purchaseLineId: line.purchaseLineId,
      quantity: String(line.quantity),
      reversesReceiptLineId: line.reversesReceiptLineId,
      createdAt: line.createdAt,
    })),
  };
}

/**
 * Σ of every receipt line PER PURCHASE LINE over a whole history — the one
 * calculation both the projection and the over-receipt check consume.
 * Compensating lines are negative and therefore subtract, so this is the
 * NET received quantity; the arithmetic is `sumMoney` (exact scaled
 * decimals), never a float.
 */
function receivedQuantities(
  history: ReadonlyArray<{
    readonly lines: ReadonlyArray<{ readonly purchaseLineId: string; readonly quantity: unknown }>;
  }>
): Map<string, string> {
  const totals = new Map<string, string>();
  for (const receipt of history) {
    for (const line of receipt.lines) {
      const quantity = String(line.quantity);
      const prior = totals.get(line.purchaseLineId);
      totals.set(line.purchaseLineId, prior === undefined ? quantity : sumMoney([prior, quantity]));
    }
  }
  return totals;
}

/** The net received quantity of one line — `0.0000` when no event names it. */
function receivedFor(totals: Map<string, string>, purchaseLineId: string): string {
  return totals.get(purchaseLineId) ?? '0.0000';
}

@Injectable()
export class ReceivingHistoryService {
  constructor(
    private readonly repository: ReceivingHistoryRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork,
    private readonly inventoryIntegration: InventoryIntegrationService
  ) {}

  /**
   * `GET …/receipts` — the document's WHOLE receipt history plus the
   * per-line receiving projection (§3-B, §6).
   *
   * Three reads, one moment: the repository's array-form `$transaction`
   * returns the document, the lines and the events together, so a projection
   * can never describe quantities the history beside it does not contain.
   * `null` document answers 404 — absent and another tenant's are the same
   * answer, by design (§3-E/§3-F).
   *
   * The projection is Σ over the WHOLE history (never a page, never a filter:
   * there is no paging here — Q9's window belongs to Q's route), and BOTH
   * quantities are the exact `Decimal(18,4)` strings the columns hold. Every
   * line of the document appears, including lines with no events at all:
   * `NOT_RECEIVED` is a fact about the document, not a missing row.
   */
  async list(actor: CommerceActor, documentId: string) {
    const [document, lines, receipts] = await this.repository.readReceiptHistory(
      actor.tenantId,
      documentId
    );
    if (!document) throw new NotFoundException('Purchase document not found');

    const totals = receivedQuantities(receipts);

    return {
      receipts: receipts.map((receipt) => receiptView(receipt)),
      lines: lines.map((line) => {
        const orderedQuantity = String(line.quantity);
        const receivedQuantity = receivedFor(totals, line.id);
        return {
          purchaseLineId: line.id,
          orderedQuantity,
          receivedQuantity,
          receivingStatus: projectReceivingStatus(orderedQuantity, receivedQuantity),
        };
      }),
    };
  }

  /**
   * `POST …/receipts` — append one receiving event (201: the stored row).
   *
   * ONE UNIT OF WORK, IN THE CONTRACT'S ORDER (§21, §3-H): the document is
   * LOCKED first (`SELECT … FOR UPDATE`), which is simultaneously the
   * tenant-scoped existence gate (404 — absent and another tenant's are the
   * same answer), then its lines are read to PROVE every stated purchase line
   * belongs to THIS document (a foreign line id is 404 `Purchase line not
   * found`, never a probe), then the whole history is read and the
   * over-receipt invariant is evaluated against it — `received + requested <=
   * ordered` for EVERY touched line, exactly, with no tolerance (R2).
   *
   * WHY THE LOCK IS NOT OPTIONAL: two concurrent `+10` appends against
   * ordered 100 / received 90 would both pass a read-then-check without it,
   * and the history would reach 110. The lock is taken BEFORE the history
   * read, so the SUM this method refuses on is the SUM the INSERT commits
   * against (§3-H, §22).
   *
   * ATOMIC REFUSAL: the 409 is thrown INSIDE the unit of work, so a rejected
   * request leaves no partial receipt — not for another line, not for another
   * entry of the same line. No silent cap, no clamp, no later repair.
   *
   * The SAME purchase line may be stated more than once in one payload (two
   * arrivals in one operation); the entries are summed FIRST and the total is
   * what the invariant sees, so splitting a quantity across two entries can
   * never smuggle an over-receipt past the check.
   */
  async append(actor: CommerceActor, documentId: string, dto: CreateReceiptDto) {
    const { appended: row, plannedPostingIds } = await this.unitOfWork.run(async (tx) => {
      // 1. The document, LOCKED — the write path's tenant-scoped gate (§3-H).
      const document = await this.repository.lockDocumentForReceipt(actor.tenantId, documentId, tx);
      if (!document) throw new NotFoundException('Purchase document not found');

      // 2. The document's own lines: the ordered quantities AND the set a
      //    receipt line may name (§10 — ownership is proven, never assumed).
      const lines = await this.repository.listLines(actor.tenantId, documentId, tx);
      const orderedByLine = new Set(lines.map((line) => line.id));
      for (const entry of dto.lines) {
        if (!orderedByLine.has(entry.purchaseLineId)) {
          throw new NotFoundException('Purchase line not found');
        }
      }

      // 3. The whole history, under the lock — the over-receipt input.
      const history = await this.repository.listByDocument(actor.tenantId, documentId, tx);
      const received = receivedQuantities(history);

      // 4. The invariant, line by line, in the document's own order so the
      //    refusal is deterministic when several lines are over.
      const requested = new Map<string, string>();
      for (const entry of dto.lines) {
        const prior = requested.get(entry.purchaseLineId);
        const quantity = moneyFromNumber(entry.quantity, 'quantity');
        requested.set(
          entry.purchaseLineId,
          prior === undefined ? quantity : sumMoney([prior, quantity])
        );
      }
      for (const line of lines) {
        const wanted = requested.get(line.id);
        if (wanted === undefined) continue;
        const orderedQuantity = String(line.quantity);
        const receivedQuantity = receivedFor(received, line.id);
        if (compareMoney(addMoney(receivedQuantity, wanted), orderedQuantity) > 0) {
          throw new ConflictException(
            `Receiving line ${line.lineNumber} would exceed its ordered quantity: ` +
              `ordered ${orderedQuantity}, already received ${receivedQuantity}, requested ${wanted}`
          );
        }
      }

      // 5. The ONLY write: one receipt, its lines, system-generated ids (R3).
      const appended = await this.repository.append(actor.tenantId, tx, {
        purchaseDocumentId: documentId,
        ...(dto.receivedAt ? { receivedAt: new Date(dto.receivedAt) } : {}),
        // The receiver is the acting session's user, taken OFF the actor — a
        // payload cannot state it (§16).
        receiverId: actor.userId,
        lines: dto.lines.map((entry) => ({
          purchaseLineId: entry.purchaseLineId,
          quantity: moneyFromNumber(entry.quantity, 'quantity'),
        })),
      });

      // 5b. Phase W2-B: the durable `InventoryPosting` rows of every stocked
      //     line — planned INSIDE this unit of work, so a receipt can never
      //     commit without its posting record. A stocked line with no
      //     `warehouseId` is refused here, atomically (400).
      const plannedPostingIds = await this.inventoryIntegration.planReceiptPostings(
        tx,
        actor.tenantId,
        appended.lines,
        lines,
        dto.lines
      );
      return { appended, plannedPostingIds };
    });

    // 6. ONE audit row per SUCCESSFUL write, AFTER the commit (§3-G): the
    //    platform audit port writes to another database and is not part of
    //    this unit of work, so recording inside would leave a "success" trail
    //    row for an act that then rolled back.
    await this.audit.record(actor, {
      action: RECEIVING_AUDIT_ACTION.APPEND,
      resource: COMMERCE_AUDIT_RESOURCE.RECEIPT,
      resourceId: row.id,
      newValue: {
        purchaseDocumentId: documentId,
        receivedAt: row.receivedAt,
        lines: row.lines.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          quantity: String(line.quantity),
          reversesReceiptLineId: line.reversesReceiptLineId,
        })),
      },
    });

    // 6b. Phase W2-B: attempt each planned posting AFTER the commit — through
    //     the Inventory port, never a direct reach. A refusal lands on the
    //     posting row (FAILED + verbatim reason), not on this response: the
    //     receipt is committed history, the posting row is the repair handle.
    await this.inventoryIntegration.attemptPostings(actor, plannedPostingIds);

    return receiptView(row);
  }

  /**
   * `POST …/receipts/:receiptLineId/compensate` — append the compensating
   * event (201: the stored row). The ONLY correction mechanism receiving has
   * (R4): no `PATCH`, no `PUT`, no `DELETE`, ever — the original row is not
   * read for modification and stays byte-for-byte unchanged.
   *
   * FIELD BY FIELD (§3-D), because none of the new row's defining facts are
   * client-stated: `quantity` is `negateMoney` of the STATED MAGNITUDE (the
   * sign is the server's decision — a client cannot send a negative
   * receiving), `reversesReceiptLineId` is the PATH's receipt line id, and
   * `purchaseLineId` is COPIED from the target — so the compensating event can
   * only ever land on the line the original did, in this document, in this
   * tenant.
   *
   * THE LOCK COMES BEFORE THE CAP, deliberately (§3-H): `available` = the
   * target line's own quantity + Σ of the lines already pointing at it (signed
   * — prior compensations are negative). Two concurrent corrections must not
   * both pass the same "remaining" read, and under the document's row lock the
   * second one re-reads the first's committed rows.
   *
   * THREE REFUSALS, NAMED (§3-D/§3-E): an unknown, cross-document or
   * cross-tenant target is 404 `Receipt line not found` (indistinguishable
   * from absent); a target that is ITSELF a compensating line is 409 (chain
   * refused — the minimum safe direct-reference rule, since §6 defines no
   * chain semantics); a magnitude beyond `available` is 409. PARTIAL
   * compensation is admitted, so `+50` followed by `−10` nets 40 and the
   * original line is untouched.
   */
  async compensate(
    actor: CommerceActor,
    documentId: string,
    receiptLineId: string,
    dto: CompensateReceiptLineDto
  ) {
    const { appended: row, plannedPostingIds } = await this.unitOfWork.run(async (tx) => {
      // 1. The document, LOCKED — the same gate as append (§3-H).
      const document = await this.repository.lockDocumentForReceipt(actor.tenantId, documentId, tx);
      if (!document) throw new NotFoundException('Purchase document not found');

      // 2. The target, scoped by document AND tenant (§3-F/§3-D).
      const target = await this.repository.findReceiptLineForCompensation(
        actor.tenantId,
        documentId,
        receiptLineId,
        tx
      );
      if (!target) throw new NotFoundException('Receipt line not found');

      // 3. No chain: only an ORIGINAL line may be compensated (§3-D).
      if (target.reversesReceiptLineId !== null) {
        throw new ConflictException(
          'A compensating receipt line cannot itself be compensated; compensate the original line'
        );
      }

      // 4. The cap, computed from the committed history under the lock.
      const history = await this.repository.listByDocument(actor.tenantId, documentId, tx);
      const priorCompensations = history
        .flatMap((receipt) => receipt.lines)
        .filter((line) => line.reversesReceiptLineId === target.id)
        .map((line) => String(line.quantity));
      const magnitude = moneyFromNumber(dto.quantity, 'quantity');
      const available = sumMoney([String(target.quantity), ...priorCompensations]);
      if (compareMoney(magnitude, available) > 0) {
        throw new ConflictException(
          `Compensation exceeds what remains on the receipt line: ` +
            `received ${String(target.quantity)}, already compensated ${sumMoney(
              priorCompensations.length > 0 ? priorCompensations : ['0.0000']
            )}, available ${available}, requested ${magnitude}`
        );
      }

      // 5. A NEW receipt event carrying the NEGATIVE quantity (R4). The
      //    original row is neither read for update nor touched, and the ids
      //    stay stable for S (§ "returns reference these ids").
      const appended = await this.repository.append(actor.tenantId, tx, {
        purchaseDocumentId: documentId,
        ...(dto.receivedAt ? { receivedAt: new Date(dto.receivedAt) } : {}),
        receiverId: actor.userId,
        lines: [
          {
            purchaseLineId: target.purchaseLineId,
            quantity: negateMoney(magnitude),
            reversesReceiptLineId: target.id,
          },
        ],
      });

      // 5b. Phase W2-B: when the ORIGIN line's receipt posting reached the
      //     inventory ledger, this compensation owes it an outbound movement —
      //     planned inside this unit of work, attempted after the commit.
      //     No POSTED origin means no stock ever arrived: nothing to remove.
      const plannedPostingIds = await this.inventoryIntegration.planCompensationPosting(
        tx,
        actor.tenantId,
        appended.lines[0],
        target.id
      );
      return { appended, plannedPostingIds };
    });

    // 6. ONE audit row per successful correction, AFTER the commit (§3-G).
    //    `reason` is not a column: it rides here, so the rationale has exactly
    //    one home.
    await this.audit.record(actor, {
      action: RECEIVING_AUDIT_ACTION.COMPENSATE,
      resource: COMMERCE_AUDIT_RESOURCE.RECEIPT,
      resourceId: row.id,
      reason: dto.reason ?? null,
      newValue: {
        purchaseDocumentId: documentId,
        receivedAt: row.receivedAt,
        lines: row.lines.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          quantity: String(line.quantity),
          reversesReceiptLineId: line.reversesReceiptLineId,
        })),
      },
    });

    // 6b. Phase W2-B: attempt the planned compensation posting AFTER the
    //     commit — a refusal lands on the posting row (FAILED + verbatim
    //     reason), never on this response.
    await this.inventoryIntegration.attemptPostings(actor, plannedPostingIds);

    return receiptView(row);
  }
}
