import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { PaymentHistoryService } from '../payment/payment-history.service';
import { InventoryIntegrationService } from '../integration/inventory-integration.service';
import { addMoney, compareMoney, moneyFromNumber, sumMoney } from '../purchase/purchase-money';
import {
  RefundCompensationClaimedError,
  ReturnHistoryRepository,
} from './return-history.repository';
import { CreateReturnDto, RefundReturnDto, ReturnDecisionDto } from './return.dto';
import {
  canTransition,
  legalTransitionSources,
  projectReturnState,
  type ReturnState,
} from './return-lifecycle';

/**
 * Phase C1 Step S (§5.17, contract S-D1..S-D5, §4, §7–§12): the return
 * child lifecycle's application layer — the locked quantity invariant, the
 * four lifecycle commands, the read-time projection and the ONE audit trail's
 * return vocabulary.
 *
 * THE SHAPE OF THIS SERVICE, AND WHAT IS DELIBERATELY MISSING
 * -----------------------------------------------------------
 * Four dependencies: the repository (every statement), the audit gateway
 * (§11), the unit of work (§9's lock and atomicity), and Q's
 * `PaymentHistoryService` — the slice's ONE cross-slice call, and only for
 * the refund (§4-E). There is NO identity gateway — the requester and every
 * `actorUserId` come OFF the actor, never a payload (§4-G/§16) — NO workflow
 * (S-D3: participation consciously declined; no `PureRuleEngineModule`
 * reaches this file), NO commercial, NO notification, NO warehouse/finance
 * port, NO second transaction mechanism, and NO `PaymentRecord` access: Q
 * remains payment-history owner and the ONLY payment effect here is the
 * delegated compensation call.
 *
 * EVERY WRITE PATH IS ONE `CommerceUnitOfWork.run` WHOSE FIRST ACT IS THE
 * LOCK (§9, R §3-H's pattern applied to S): `lockDocumentForReturn` before
 * ANY receipt-history or return-history read, so the invariant is judged
 * against a SERIALIZED view — two concurrent creates (or a create racing a
 * receiving compensation) cannot both pass the same "remaining" read. A
 * refusal thrown inside the unit of work rolls the WHOLE act back: one bad
 * line rejects the entire ReturnDocument — no document, no lines, no
 * transition, no audit (§9's all-or-nothing).
 *
 * REFUSALS ARE NAMED, NEVER SILENT (§10): unknown/foreign document → 404
 * before any write; a line the document does not own → 404; a receipt line
 * outside the document → 404; two references that exist in scope but
 * contradict → 409 `line_reference_mismatch`; over-return → 409 `over_return`
 * naming all three quantities, exact to four decimals, no tolerance, no
 * clamp; an illegal transition → 409 `invalid_transition` with no mutation; a
 * failed Q compensation → 409 `refund_compensation_failed` with NO
 * `REFUNDED` row. Nothing in this file reads or writes `PurchaseDocument.status`,
 * workflow, commercial or receiving state (§12): return state is its own
 * lifecycle, projected from its own history — and reading returns never
 * requires a parent status, because no parent status is ever consulted.
 *
 * ONE AUDIT ROW PER SUCCESSFUL COMMAND, AFTER THE COMMIT (§11): the platform
 * audit port writes to another database and is not part of this unit of work,
 * so recording inside would leave a "success" row for an act that then rolled
 * back. Reads audit nothing. Refused operations audit nothing — the throw
 * happens before the gateway is reached.
 */

/**
 * The return slice's five audit actions, declared beside the code that
 * records them (§11, the PAYMENT_AUDIT_ACTION / RECEIVING_AUDIT_ACTION
 * convention). Resource is `COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT` — step G
 * declared it for exactly this row, and NOTHING else may be audited by S: the
 * refund's payment side is audited BY Q as `PAYMENT_RECORD`, and duplicating
 * it here would make "who refunded" answerable twice, differently.
 */
export const RETURN_AUDIT_ACTION = {
  CREATE: 'create',
  APPROVE: 'approve',
  REJECT: 'reject',
  RECEIVE_BACK: 'receive_back',
  REFUND: 'refund',
} as const;

/**
 * §10's CLOSED 409 vocabulary — the five code tokens, declared beside the
 * code that answers them (the `COMMERCIAL_FAILURE` convention; §10: "Any
 * ADDITIONAL error may be added only if explicitly necessary and defined
 * HERE before implementation"). The wire answer is the object payload
 * `{ code, message }`: the standard exception filter forwards `code`
 * verbatim and the contract's exact message as `message`.
 *
 * `INVALID_ORIGIN` is declared but unreachable HERE, by the contract's own
 * parenthetical ("when not already 404 by scoping"): the origin check is
 * scoped by document AND tenant, so a line outside `:id` is already the 404
 * `Purchase line not found`. The other four are thrown below.
 */
export const RETURN_FAILURE = {
  OVER_RETURN: 'over_return',
  INVALID_TRANSITION: 'invalid_transition',
  LINE_REFERENCE_MISMATCH: 'line_reference_mismatch',
  INVALID_ORIGIN: 'invalid_origin',
  REFUND_COMPENSATION_FAILED: 'refund_compensation_failed',
} as const;

/**
 * The structural shapes the writes return and the reads return — ONE view
 * serves both, and the test suite's fakes fit them without importing the
 * generated client (the service never does: `quantity: unknown` because it
 * stringifies through `String(...)`, exactly as the receiving slice does).
 */
interface TransitionBearing {
  readonly id: string;
  readonly state: ReturnState;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

interface ReturnLineBearing {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly receiptLineId: string;
  readonly quantity: unknown;
  readonly createdAt: Date;
}

interface ReturnDocumentBearing {
  readonly id: string;
  readonly reason: string;
  readonly replacementRequired: boolean;
  readonly requestedByUserId: string | null;
  readonly createdAt: Date;
  readonly lines: readonly ReturnLineBearing[];
  readonly transitions: readonly TransitionBearing[];
}

interface ReceiptLineBearing {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly quantity: unknown;
  readonly reversesReceiptLineId: string | null;
}

/**
 * The deterministic `(createdAt, id)` total order §4-A defines, applied to
 * every list this service renders. The repository's `orderBy` already asks
 * for it, and the projection sorts its own input — this helper is what makes
 * the RESPONSE's arrays obey the same order even when a just-appended row is
 * concatenated in memory (the command responses below do exactly that), so
 * one order answers everywhere instead of two conventions disagreeing.
 */
function oldestFirst<T extends { readonly id: string; readonly createdAt: Date }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((left, right) => {
    const byInstant = left.createdAt.getTime() - right.createdAt.getTime();
    if (byInstant !== 0) return byInstant;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * The wire projection of ONE return (§7) — its own fields, stated one by one
 * so `tenantId` and `purchaseDocumentId` can never reach a body by omission
 * of thought (the route already names the document). `state` is the
 * PROJECTION of the transition rows, never a column (S-D2); `quantity` is the
 * exact stored `Decimal(18,4)` STRING, never a number.
 */
function returnView(ret: ReturnDocumentBearing) {
  return {
    id: ret.id,
    reason: ret.reason,
    replacementRequired: ret.replacementRequired,
    requestedByUserId: ret.requestedByUserId,
    createdAt: ret.createdAt,
    state: projectReturnState(ret.transitions),
    lines: oldestFirst(ret.lines).map((line) => ({
      id: line.id,
      purchaseLineId: line.purchaseLineId,
      receiptLineId: line.receiptLineId,
      quantity: String(line.quantity),
      createdAt: line.createdAt,
    })),
    transitions: oldestFirst(ret.transitions).map((transition) => ({
      id: transition.id,
      state: transition.state,
      actorUserId: transition.actorUserId,
      reason: transition.reason,
      createdAt: transition.createdAt,
    })),
  };
}

/**
 * `alreadyReturned(R)` of §4-C — Σ of the return lines pointing at `R` whose
 * return is NOT `REJECTED`. A rejected return never moved goods or money, so
 * its quantity stops counting the moment the projection reads `REJECTED`;
 * every other state counts, including `REQUESTED`, which is what RESERVES
 * quantity while a request is pending (otherwise two racing creates would
 * both pass against the same free quantity — the §9 serialization's whole
 * purpose). The arithmetic is `sumMoney` — exact scaled decimals, never a
 * float.
 */
function alreadyReturnedQuantities(returns: readonly ReturnDocumentBearing[]): Map<string, string> {
  const totals = new Map<string, string>();
  for (const document of returns) {
    if (projectReturnState(document.transitions) === 'REJECTED') continue;
    for (const line of document.lines) {
      const quantity = String(line.quantity);
      const prior = totals.get(line.receiptLineId);
      totals.set(line.receiptLineId, prior === undefined ? quantity : sumMoney([prior, quantity]));
    }
  }
  return totals;
}

/**
 * `netReceived(R)` of §4-C — R's OWN `available` rule, re-read from the same
 * append-only history rather than re-invented: `R.quantity` plus the SIGNED
 * sum of every receipt line whose `reversesReceiptLineId` names `R`
 * (compensating lines are negative, so they subtract). One pass installs
 * every line's own quantity; a second pass folds each compensation into its
 * target — including a target outside this document's set, which R's
 * document-scoped writes make impossible but which the `?? '0.0000'` refuses
 * to guess about silently. S READS these rows only (§5: read/reference-only).
 */
function netReceivedQuantities(receiptLines: readonly ReceiptLineBearing[]): Map<string, string> {
  const nets = new Map<string, string>();
  for (const line of receiptLines) nets.set(line.id, String(line.quantity));
  for (const line of receiptLines) {
    if (line.reversesReceiptLineId === null) continue;
    const target = nets.get(line.reversesReceiptLineId) ?? '0.0000';
    nets.set(line.reversesReceiptLineId, sumMoney([target, String(line.quantity)]));
  }
  return nets;
}

@Injectable()
export class ReturnHistoryService {
  constructor(
    private readonly repository: ReturnHistoryRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork,
    private readonly payments: PaymentHistoryService,
    private readonly inventoryIntegration: InventoryIntegrationService
  ) {}

  /**
   * `GET …/returns` — the document's WHOLE return history with lines and
   * transition histories, oldest first, UNPAGED (§4-F: one document's return
   * history, not a tenant-wide list — inventing a page envelope would add an
   * unagreed contract surface). Reads audit nothing (§11), and no parent
   * status is consulted (§12.6): every state comes from projecting its own
   * return's rows. Unknown/foreign document → 404 before anything else, so an
   * id cannot be probed — absent and another tenant's are the same answer
   * (§10).
   */
  async list(actor: CommerceActor, documentId: string) {
    const [document, returns] = await this.repository.readReturnHistory(actor.tenantId, documentId);
    if (!document) throw new NotFoundException('Purchase document not found');
    // The response OWNS its oldest-first order (§4-F) — the repository's
    // `orderBy` asks for it too, but a projection that renders whatever order
    // storage happened to return is one lost `ORDER BY` away from lying about
    // which return came first, and the sort here costs one comparison.
    return { returns: oldestFirst(returns).map((ret) => returnView(ret)) };
  }

  /**
   * `POST …/returns` — append one return document with its lines and its
   * initial `REQUESTED` transition (201: the stored document view).
   *
   * ONE UNIT OF WORK, IN §9's ORDER: the document is LOCKED first
   * (`SELECT … FOR UPDATE` — simultaneously the tenant-scoped 404 gate), then
   * the origin references are PROVEN against scoped reads (a purchase line
   * the document does not own → 404; a receipt line outside the document →
   * 404; two references that exist but contradict → 409
   * `line_reference_mismatch`), then BOTH histories are read under that same
   * lock — receipt lines for `netReceived(R)`, prior returns for
   * `alreadyReturned(R)` — and the invariant
   *
   *     alreadyReturned(R) + requested(R) <= netReceived(R)
   *
   * is judged with exact `Decimal(18,4)` arithmetic (`compareMoney` over
   * `sumMoney`'s scaled bigints — no float, no tolerance) for every receipt
   * line the payload touches, in payload order so a refusal is deterministic
   * when several lines are over. Entries naming the SAME receipt line are
   * summed FIRST, so splitting a quantity across two entries can never
   * smuggle an over-return past the check. Equality is ACCEPTED; one
   * `0.0001` more is 409 `over_return` naming all three quantities — never a
   * silent cap, never a clamp.
   *
   * WHY THE LOCK IS NOT OPTIONAL: two concurrent creates against the same
   * receipt line would both pass a read-then-check without it and the sum
   * would exceed `netReceived`. Under the lock the loser re-reads the
   * winner's committed rows and refuses (§9 — R §3-H's precedent applied to
   * S; because R locks the SAME document row, a create racing a receiving
   * compensation serialises too).
   *
   * ATOMIC, ALL-OR-NOTHING: every refusal is thrown INSIDE the unit of work,
   * so one bad line leaves no partial document — no header, no other lines,
   * no transition, and no audit row (the throw reaches past the gateway call
   * entirely). The requester is `actor.userId` and the reason is the
   * payload's own text trimmed — identities a field of this DTO does not
   * declare can never arrive (§4-B/§16).
   */
  async create(actor: CommerceActor, documentId: string, dto: CreateReturnDto) {
    const created = await this.unitOfWork.run(async (tx) => {
      // 1. The document, LOCKED — the write path's tenant-scoped gate (§9).
      const document = await this.repository.lockDocumentForReturn(actor.tenantId, documentId, tx);
      if (!document) throw new NotFoundException('Purchase document not found');

      // 2. Origin references, PROVEN against this document's own rows (S-D5):
      //    a UUID that exists somewhere in the tenant proves nothing.
      const purchaseLines = await this.repository.listPurchaseLines(actor.tenantId, documentId, tx);
      const owned = new Set(purchaseLines.map((line) => line.id));
      const receiptLines = await this.repository.listReceiptLines(actor.tenantId, documentId, tx);
      const receiptById = new Map(receiptLines.map((line) => [line.id, line]));
      for (const entry of dto.lines) {
        if (!owned.has(entry.purchaseLineId)) {
          throw new NotFoundException('Purchase line not found');
        }
        const receiptLine = receiptById.get(entry.receiptLineId);
        if (!receiptLine) throw new NotFoundException('Receipt line not found');
        if (receiptLine.purchaseLineId !== entry.purchaseLineId) {
          throw new ConflictException({
            code: RETURN_FAILURE.LINE_REFERENCE_MISMATCH,
            message: "Return line's receipt line does not belong to its purchase line",
          });
        }
      }

      // 3. BOTH histories, under the lock — one serialized view (§9). Two
      //    reads at two moments would be one moment pretending to be two.
      const returns = await this.repository.listReturnDocuments(actor.tenantId, documentId, tx);
      const alreadyReturned = alreadyReturnedQuantities(returns);
      const netReceived = netReceivedQuantities(receiptLines);

      // 4. What the payload asks for, per receipt line — duplicate entries
      //    summed FIRST so they cannot outrun the check separately.
      const requested = new Map<string, string>();
      for (const entry of dto.lines) {
        const quantity = moneyFromNumber(entry.quantity, 'quantity');
        const prior = requested.get(entry.receiptLineId);
        requested.set(
          entry.receiptLineId,
          prior === undefined ? quantity : sumMoney([prior, quantity])
        );
      }

      // 5. The invariant — exact, equality included, no tolerance (S-D1).
      for (const [receiptLineId, wanted] of requested) {
        const net = netReceived.get(receiptLineId) ?? '0.0000';
        const prior = alreadyReturned.get(receiptLineId) ?? '0.0000';
        if (compareMoney(addMoney(prior, wanted), net) > 0) {
          throw new ConflictException({
            code: RETURN_FAILURE.OVER_RETURN,
            message:
              `Return quantity exceeds the net received quantity of its receipt line: ` +
              `net received ${net}, already returned ${prior}, requested ${wanted}`,
          });
        }
      }

      // 6. The ONLY write: document + lines + REQUESTED, one nested create —
      //    a return without its first transition is not expressible (§8).
      return this.repository.appendReturn(actor.tenantId, tx, {
        purchaseDocumentId: documentId,
        requestedByUserId: actor.userId,
        reason: dto.reason.trim(),
        replacementRequired: dto.replacementRequired,
        lines: dto.lines.map((entry) => ({
          purchaseLineId: entry.purchaseLineId,
          receiptLineId: entry.receiptLineId,
          quantity: moneyFromNumber(entry.quantity, 'quantity'),
        })),
        requestedTransition: { actorUserId: actor.userId },
      });
    });

    // 7. ONE audit row for the successful create, AFTER the commit (§11):
    //    the resulting state and the appended REQUESTED row's id are the
    //    facts. The stated reason rides the ONE trail beside its column —
    //    never a second column for the same why.
    await this.audit.record(actor, {
      action: RETURN_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
      resourceId: created.id,
      newValue: {
        state: projectReturnState(created.transitions),
        transitionId: created.transitions[0].id,
      },
      reason: dto.reason.trim(),
    });

    return returnView(created);
  }

  /**
   * The FOUR lifecycle commands' shared spine (§8): lock, load the return
   * scoped to (tenant, document, returnId), project its CURRENT state from
   * the immutable history, run the matrix FIRST, optionally perform the
   * command's own act, append exactly ONE transition, commit, audit exactly
   * once.
   *
   * ORDER IS THE CONTRACT. The matrix refusal happens BEFORE any write —
   * no transition row, no document write, no audit row — and the message
   * names the current state and the legal sources of the requested command
   * (§8). `beforeAppend` exists for ONE caller: REFUND, which must invoke
   * Q's compensation and see it SUCCEED before a `REFUNDED` row may exist
   * (§4-E) — so the Q call lands between the matrix check and the append,
   * inside the same locked unit of work, and a Q refusal throws here: the
   * transaction rolls back with nothing written on S's side, the audit call
   * below is never reached, and the return stays exactly where it was.
   *
   * NOTHING IN THIS SPINE READS OR WRITES `PurchaseDocument.status`,
   * workflow, commercial, receiving or payment state (§12): no parent status
   * gates a command (inventing one would be a silent default the contract
   * never stated), and the delegated Q call is the slice's only external
   * effect.
   */
  private async runTransition(
    actor: CommerceActor,
    documentId: string,
    returnId: string,
    target: ReturnState,
    command: string,
    reason: string | null,
    action: string,
    beforeAppend?: (tx: CommerceTransactionHandle) => Promise<void>,
    // PHASE W3.1/W4-B: the `REFUNDED` row's settlement links — a MUTABLE
    // holder, because `compensationPaymentId` is only known after `beforeAppend`
    // runs Q's compensate inside the unit of work: the transition append reads
    // the holder at write time. `paymentId` is the original payment funded;
    // `compensationPaymentId` the actual refund row appended.
    refundLink?: { paymentId: string; compensationPaymentId?: string | null },
    afterCommit?: (outcome: {
      ret: ReturnDocumentBearing;
      transition: TransitionBearing;
      previous: ReturnState;
    }) => Promise<void>
  ) {
    const outcome = await this.unitOfWork.run(async (tx) => {
      // 1. The document, LOCKED — the same gate as create (§9): this is what
      //    serialises return-vs-return races on one document.
      const document = await this.repository.lockDocumentForReturn(actor.tenantId, documentId, tx);
      if (!document) throw new NotFoundException('Purchase document not found');

      // 2. The return, scoped by document AND tenant (§7): another tenant's,
      //    another document's and an unknown id are the SAME 404.
      const ret = await this.repository.findReturnDocument(
        actor.tenantId,
        documentId,
        returnId,
        tx
      );
      if (!ret) throw new NotFoundException('Return document not found');

      // 3. The matrix FIRST (§8) — the refusal that must change nothing.
      const current = projectReturnState(ret.transitions);
      if (!canTransition(current, target)) {
        throw new ConflictException({
          code: RETURN_FAILURE.INVALID_TRANSITION,
          message:
            `Only a return in ${legalTransitionSources(target).join(', ')} ` +
            `may be ${command}; this return is ${current}`,
        });
      }

      // 4. The command's own act — refund's Q-first ordering (§4-E), and
      //    only that command passes one. It receives THIS transaction's
      //    handle: Q's INSERT has to run on this connection, inside this
      //    transaction, or its foreign key's key-share lock waits on the
      //    document row this path already holds `FOR UPDATE` (Step U).
      if (beforeAppend) await beforeAppend(tx);

      // Phase B2.3: build the durable outbox payload INSIDE the unit of work
      // because `ret.id` (the return document id) is needed for the event.
      const outbox = this.audit.buildOutboxPayload(actor, {
        action,
        resource: COMMERCE_AUDIT_RESOURCE.RETURN_DOCUMENT,
        resourceId: ret.id,
        oldValue: { state: current },
        newValue: { state: target },
        reason,
      });

      // 5. ONE immutable row: the transition itself (S-D2). No document
      //    column changes; nothing else in the database learns about it.
      // The outbox row commits atomically with the transition. PHASE W3.1:
      // `refundedPaymentId` rides ONLY the REFUNDED row — the persisted link
      // between this resolved return and the payment its refund settled.
      const transition = await this.repository
        .appendTransition(
          actor.tenantId,
          tx,
          {
            returnDocumentId: ret.id,
            state: target,
            actorUserId: actor.userId,
            reason,
            refundedPaymentId: target === 'REFUNDED' ? (refundLink?.paymentId ?? null) : null,
            refundCompensationPaymentId:
              target === 'REFUNDED' ? (refundLink?.compensationPaymentId ?? null) : null,
          },
          outbox
        )
        .catch((error: unknown) => {
          // W4-D: the refund-link partial unique — one compensation settles
          // one return; a raced double-claim is a domain 409 whose rollback
          // removes the compensation row with it.
          if (error instanceof RefundCompensationClaimedError) {
            throw new ConflictException({
              code: RETURN_FAILURE.REFUND_COMPENSATION_FAILED,
              message: 'the refund compensation is already claimed by another transition',
            });
          }
          throw error;
        });

      return { ret, transition, previous: current };
    });

    // 6. The command's post-commit effect — only RECEIVED_BACK passes one
    //    (the durable inventory dispatch postings of its lines), and its
    //    refusals land on the posting rows, never on this transition.
    if (afterCommit) await afterCommit(outcome);

    // 7. The document view AFTER the appended row — the same
    //    201-with-the-stored-row precedent as Q's compensate: `state` is the
    //    projection of history INCLUDING what this command just wrote.
    return returnView({
      ...outcome.ret,
      transitions: [...outcome.ret.transitions, outcome.transition],
    });
  }

  /**
   * `POST …/returns/:returnId/approve` — `REQUESTED -> APPROVED` (route 3).
   * Refused from any other state with 409 `invalid_transition`, unchanged
   * (§8); the optional reason rides the transition row and the one audit row.
   */
  async approve(
    actor: CommerceActor,
    documentId: string,
    returnId: string,
    dto: ReturnDecisionDto
  ) {
    return this.runTransition(
      actor,
      documentId,
      returnId,
      'APPROVED',
      'approved',
      dto.reason ?? null,
      RETURN_AUDIT_ACTION.APPROVE
    );
  }

  /**
   * `POST …/returns/:returnId/reject` — `REQUESTED -> REJECTED` (route 4).
   * The ONLY negative outcome in C1-S: it does not touch the parent purchase
   * (§12.2 — the return's own REJECTED state IS the rejection), and its
   * quantities stop counting toward the cumulative cap the moment the
   * projection reads `REJECTED` (§4-C) — no row is rewritten to release them,
   * because none ever held them.
   */
  async reject(actor: CommerceActor, documentId: string, returnId: string, dto: ReturnDecisionDto) {
    return this.runTransition(
      actor,
      documentId,
      returnId,
      'REJECTED',
      'rejected',
      dto.reason ?? null,
      RETURN_AUDIT_ACTION.REJECT
    );
  }

  /**
   * `POST …/returns/:returnId/receive-back` — `APPROVED -> RECEIVED_BACK`
   * (route 5). The empty body is complete by design (§7), so no reason is
   * stated and none is invented: the row records who and when, while the
   * receiving history stays R's — this command appends nothing to
   * `Receipt`/`ReceiptLine` and marks the purchase received by nothing
   * (§12.4).
   *
   * NO PAYLOAD PARAMETER, DELIBERATELY: `ReceiveBackReturnDto` is the EMPTY
   * boundary class the controller binds so that a stray body field is a 400
   * under the global pipe's `whitelist` + `forbidNonWhitelisted` (§7's `{}`),
   * and this layer has no field to read — forwarding the instance would carry
   * nothing and accept nothing.
   */
  async receiveBack(actor: CommerceActor, documentId: string, returnId: string) {
    // Phase W2-B: physical handover is the point stock LEAVES the inventory
    // ledger — not request, not approval, not refund. The dispatch postings
    // are planned INSIDE the transition's unit of work (each return line
    // inherits the cell and item its origin receipt posting recorded) and
    // attempted after the commit; a refusal is a FAILED posting row, not a
    // rolled-back transition.
    let plannedPostingIds: string[] = [];
    return this.runTransition(
      actor,
      documentId,
      returnId,
      'RECEIVED_BACK',
      'received back',
      null,
      RETURN_AUDIT_ACTION.RECEIVE_BACK,
      async (tx) => {
        const ret = await this.repository.findReturnDocument(
          actor.tenantId,
          documentId,
          returnId,
          tx
        );
        plannedPostingIds = ret
          ? await this.inventoryIntegration.planReturnDispatchPostings(tx, actor.tenantId, ret.lines)
          : [];
      },
      undefined,
      async () => {
        await this.inventoryIntegration.attemptPostings(actor, plannedPostingIds);
        plannedPostingIds = [];
      }
    );
  }

  /**
   * `POST …/returns/:returnId/refund` — `RECEIVED_BACK -> REFUNDED` (route
   * 6), settled THROUGH Q (§4-E).
   *
   * THE ORDERING IS THE WHOLE RULE: S validates existence, tenant, document
   * scope and the projected state FIRST (the matrix above refuses anything
   * but `RECEIVED_BACK`), then invokes Q's established application-layer
   * contract — `PaymentHistoryService.compensate` with the acting actor, the
   * return's origin document, the stated `paymentId` and the reason — and
   * ONLY if Q succeeds does the `REFUNDED` row get appended. S never touches
   * `PaymentRecord`, never opens Q's repository or Prisma, and never writes
   * `COMMERCE_AUDIT_RESOURCE.PAYMENT_RECORD`: Q audits its own compensation
   * as PAYMENT_RECORD; S audits only this return's transition act (§11).
   *
   * ANY Q REFUSAL (unknown/foreign payment, already compensated, anything Q
   * refuses) becomes 409 `refund_compensation_failed` carrying Q's own
   * message, thrown INSIDE the unit of work: no transition, no `REFUNDED`
   * projection, no S audit row — the return stays `RECEIVED_BACK` (§4-E.3).
   * THE Q CALL JOINS THIS UNIT OF WORK (the handle forwarded below), and Step
   * U's end-to-end suite is why it MUST: `PaymentRecord`'s foreign key to
   * `PurchaseDocument` makes Q's INSERT take `FOR KEY SHARE` on the very row
   * this path holds `FOR UPDATE`, and the two CONFLICT — issued on a second
   * connection, Q's append waited out the caller's 5 s transaction timeout,
   * the refund answered 500 and the compensation landed ALONE. Forwarding the
   * handle makes both writes ONE transaction on ONE connection, which is also
   * what removes §4-E's RECORDED RESIDUAL from this path: Q's row can no
   * longer outlive the `REFUNDED` transition that asked for it, because a
   * failure now rolls both back together (§4-E.3, enforced rather than
   * assumed).
   */
  async refund(actor: CommerceActor, documentId: string, returnId: string, dto: RefundReturnDto) {
    // W4-B: the compensation's OWN row id — captured inside the unit of work
    // so the REFUNDED transition can name the actual refund ledger row, not
    // just the original payment it reversed.
    const refundLink: { paymentId: string; compensationPaymentId?: string | null } = {
      paymentId: dto.paymentId,
      compensationPaymentId: null,
    };
    return this.runTransition(
      actor,
      documentId,
      returnId,
      'REFUNDED',
      'refunded',
      dto.reason ?? null,
      RETURN_AUDIT_ACTION.REFUND,
      async (tx) => {
        try {
          const compensation = await this.payments.compensate(
            actor,
            documentId,
            dto.paymentId,
            {
              ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
              ...(dto.reason ? { reason: dto.reason } : {}),
            },
            tx
          );
          refundLink.compensationPaymentId = compensation.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ConflictException({
            code: RETURN_FAILURE.REFUND_COMPENSATION_FAILED,
            message: `Refund compensation failed: ${message}`,
          });
        }
      },
      // PHASE W3.1/W4-B: the payment funded AND the compensation row appended —
      // the precise refund links the closure evaluator reads.
      refundLink
    );
  }
}
