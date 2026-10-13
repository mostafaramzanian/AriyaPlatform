import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  CommerceTransactionHandle,
  unwrapCommerceTransaction,
} from '../database/commerce-transaction';
import type { CommerceAuditOutboxPayload } from '../commerce-audit.gateway';
import type {
  CommercialApproval,
  CommercialApprovalApprover,
  CommercialAssignment,
  CommercialAssignmentHistory,
  CommercialAssignmentSource,
  CommercialAssignmentState,
} from '../../../generated/commerce-client';

/**
 * Phase C1 Step P: the LIFECYCLE persistence boundary — `CommercialAssignment`
 * (the CURRENT row), `CommercialAssignmentHistory` (append-only) and
 * `CommercialApproval` (§6's minimum set, §3-C / §3-G).
 *
 * WHAT THIS FILE OWNS: statements against the three lifecycle tables, and
 * nothing else — no rule evaluation, no identity resolution, no audit, no
 * transaction management. The service above it orchestrates inside
 * `CommerceUnitOfWork.run`, which is why every WRITE here takes the opaque
 * handle rather than opening a transaction: §3-O states one transaction
 * mechanism, and a repository that minted its own would be a second one.
 *
 * THE CURRENT ROW IS ONE PER LINE (P5): `CommercialAssignment` carries a
 * unique `(tenantId, purchaseLineId)`, so `updateAssignmentIn` is a
 * REASSIGNMENT — never an insert of a second row (P7). "Never an overwrite in
 * place" is honoured by the SERVICE, which appends the history entry in the
 * same unit of work; this file appends nothing on its own, so no caller can
 * arrive at a current row whose change has no history entry.
 *
 * HISTORY HAS NO UPDATE PATH AND NO DELETE PATH. The absence is the guarantee
 * (§3-C): a January assignment stays discoverable after February's, because
 * the only statement that can touch the table is an INSERT.
 *
 * TENANCY: `tenantId` is the first parameter of every public method and
 * appears in every `where`. No `findUnique` addresses a tenant-scoped row —
 * composite uniques are reached through tenant-scoped `findFirst`/`updateMany`
 * predicates, and a cross-tenant id answers `null` rather than leaking
 * existence (the existing NotFound posture, §8).
 */

export interface CommercialAssignmentWrite {
  readonly purchaseLineId: string;
  readonly purchaseDocumentId: string;
  readonly commercialGroupId: string | null;
  readonly status: CommercialAssignmentState;
  readonly source: CommercialAssignmentSource;
  readonly resolvedUserId: string | null;
  readonly matchedRuleLabel: string | null;
  readonly configurationVersionId: string | null;
}

export interface CommercialAssignmentHistoryWrite {
  readonly purchaseLineId: string;
  readonly commercialGroupId: string | null;
  readonly status: CommercialAssignmentState;
  readonly source: CommercialAssignmentSource;
  readonly resolvedUserId: string | null;
  readonly matchedRuleLabel: string | null;
  readonly configurationVersionId: string | null;
  readonly actorUserId: string | null;
  readonly reason: string | null;
}

export interface CommercialApprovalWrite {
  readonly purchaseLineId: string;
  readonly purchaseDocumentId: string;
  readonly approver: CommercialApprovalApprover;
  readonly approverUserId: string;
  readonly applicabilityResult: boolean | null;
  readonly configurationVersionId: string;
}

export interface CommercialAssignmentChange {
  readonly commercialGroupId: string | null;
  readonly status: CommercialAssignmentState;
  readonly source: CommercialAssignmentSource;
  readonly resolvedUserId: string | null;
  readonly matchedRuleLabel: string | null;
  readonly configurationVersionId: string | null;
}

export interface CommercialApprovalDecisionWrite {
  readonly status: 'APPROVED' | 'REJECTED';
  readonly decidedByUserId: string;
  readonly decidedAt: Date;
  readonly comment: string | null;
}

@Injectable()
export class CommercialLifecycleRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * WHICH CLIENT A READ RUNS ON — the same split `workflow-execution.repository.ts`
   * records: an API read opens no transaction, while every read performed INSIDE a
   * unit of work must see that unit's own uncommitted writes.
   *
   * Without this, activation would create an approval on one connection and the
   * projection recompute — reading the same table on another — would not see it, and
   * would decide the document from a state the transaction had already changed. The
   * handle is unwrapped HERE, which is what keeps `Prisma.TransactionClient` inside the
   * repository boundary (gate D).
   */
  private static reader(
    source: CommercePrismaService | CommerceTransactionHandle
  ): CommercePrismaService | ReturnType<typeof unwrapCommerceTransaction> {
    return source instanceof CommercePrismaService ? source : unwrapCommerceTransaction(source);
  }

  // ---------------------------------------------------------------------------
  // CommercialAssignment — THE CURRENT ROW (one per line, P5)
  // ---------------------------------------------------------------------------

  /**
   * The creation of the current row: one INSERT, inside the caller's unit of
   * work. The unique `(tenantId, purchaseLineId)` is what forbids a second
   * current row, so a caller that already holds one must REASSIGN through
   * `changeAssignmentIn` instead (§3-H) — the database refuses the alternative
   * rather than the service remembering to check.
   */
  async createAssignmentIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    data: CommercialAssignmentWrite
  ): Promise<CommercialAssignment> {
    const client = unwrapCommerceTransaction(tx);
    return client.commercialAssignment.create({
      data: {
        tenantId,
        purchaseLineId: data.purchaseLineId,
        purchaseDocumentId: data.purchaseDocumentId,
        commercialGroupId: data.commercialGroupId,
        status: data.status,
        source: data.source,
        resolvedUserId: data.resolvedUserId,
        matchedRuleLabel: data.matchedRuleLabel,
        configurationVersionId: data.configurationVersionId,
      },
    });
  }

  /**
   * The REASSIGNMENT write (P7): the current row takes the new state, and the
   * service appends the history entry in the SAME unit of work — the two are
   * one act, which is why this method does not append anything itself and why
   * it is not called outside `CommerceUnitOfWork.run`.
   *
   * A tenant-scoped `updateMany` rather than `update`: the predicate carries
   * `tenantId` (the guard's rule), and `count === 0` is answered as `null` —
   * the caller asked about a line this tenant does not hold, which is the same
   * answer as the row being absent, never a cross-tenant write.
   */
  async changeAssignmentIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    purchaseLineId: string,
    change: CommercialAssignmentChange
  ): Promise<CommercialAssignment | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.commercialAssignment.updateMany({
      where: { tenantId, purchaseLineId },
      data: {
        commercialGroupId: change.commercialGroupId,
        status: change.status,
        source: change.source,
        resolvedUserId: change.resolvedUserId,
        matchedRuleLabel: change.matchedRuleLabel,
        configurationVersionId: change.configurationVersionId,
      },
    });
    if (count === 0) return null;
    return client.commercialAssignment.findFirst({ where: { tenantId, purchaseLineId } });
  }

  /** The line's CURRENT row, or `null` — the trigger's "already assigned?" read (§3-H). */
  async findAssignmentByLine(
    tenantId: string,
    purchaseLineId: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialAssignment | null> {
    return CommercialLifecycleRepository.reader(tx ?? this.prisma).commercialAssignment.findFirst({
      where: { tenantId, purchaseLineId },
    });
  }

  /**
   * A document's current rows — the §9 `?documentId=` read AND the trigger's
   * "which lines already have a current row?" set, which is why it takes an optional
   * handle: the automatic trigger reads it inside its unit of work.
   */
  async listAssignmentsByDocument(
    tenantId: string,
    purchaseDocumentId: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialAssignment[]> {
    return CommercialLifecycleRepository.reader(tx ?? this.prisma).commercialAssignment.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: { purchaseLineId: 'asc' },
    });
  }

  // ---------------------------------------------------------------------------
  // CommercialAssignmentHistory — APPEND-ONLY (no update, no delete)
  // ---------------------------------------------------------------------------

  /**
   * The ONE statement this table accepts. There is deliberately no sibling for
   * "correct" or "remove": §3-C promises the January entry stays readable after
   * February's, and an update path would be the only way to break that promise.
   */
  async appendAssignmentHistoryIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    data: CommercialAssignmentHistoryWrite
  ): Promise<CommercialAssignmentHistory> {
    const client = unwrapCommerceTransaction(tx);
    return client.commercialAssignmentHistory.create({
      data: {
        tenantId,
        purchaseLineId: data.purchaseLineId,
        commercialGroupId: data.commercialGroupId,
        status: data.status,
        source: data.source,
        resolvedUserId: data.resolvedUserId,
        matchedRuleLabel: data.matchedRuleLabel,
        configurationVersionId: data.configurationVersionId,
        actorUserId: data.actorUserId,
        reason: data.reason,
      },
    });
  }

  /** ONE line's entries, oldest first. `id` breaks a same-instant tie deterministically. */
  async listHistoryByLine(
    tenantId: string,
    purchaseLineId: string
  ): Promise<CommercialAssignmentHistory[]> {
    return this.prisma.commercialAssignmentHistory.findMany({
      where: { tenantId, purchaseLineId },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The document read's history half (§9): the entries of MANY lines in one
   * statement. History carries no `purchaseDocumentId` on purpose (its shape is
   * "what happened to this LINE"), so the caller supplies the line ids it just
   * read from the document — one round trip instead of one per line.
   */
  async listHistoryByLines(
    tenantId: string,
    purchaseLineIds: readonly string[]
  ): Promise<CommercialAssignmentHistory[]> {
    if (purchaseLineIds.length === 0) return [];
    return this.prisma.commercialAssignmentHistory.findMany({
      where: { tenantId, purchaseLineId: { in: [...purchaseLineIds] } },
      orderBy: [{ purchaseLineId: 'asc' }, { changedAt: 'asc' }, { id: 'asc' }],
    });
  }

  // ---------------------------------------------------------------------------
  // CommercialApproval — its OWN lifecycle (§3-G), line-scoped
  // ---------------------------------------------------------------------------

  /**
   * Activation: one PENDING record for the line, inside the caller's unit of
   * work. The unique `(tenantId, purchaseLineId)` is the §3-G cardinality — a
   * correction flow that needs a second record arrives additively later (§11),
   * never by relaxing this insert.
   */
  async createApprovalIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    data: CommercialApprovalWrite
  ): Promise<CommercialApproval> {
    const client = unwrapCommerceTransaction(tx);
    return client.commercialApproval.create({
      data: {
        tenantId,
        purchaseLineId: data.purchaseLineId,
        purchaseDocumentId: data.purchaseDocumentId,
        approver: data.approver,
        approverUserId: data.approverUserId,
        applicabilityResult: data.applicabilityResult,
        configurationVersionId: data.configurationVersionId,
      },
    });
  }

  /**
   * The DECISION write: PENDING → APPROVED/REJECTED, conditional on the state
   * the service read. `count === 0` means the record was no longer PENDING —
   * the caller answers `COMMERCIAL_APPROVAL_NOT_PENDING` rather than reporting a
   * decision it did not record. The actor check itself is the SERVICE's (it
   * compares the stored approver to the acting user); this method writes what it
   * is handed, so no rule is decided by a predicate nobody can read.
   */
  async decideApprovalIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string,
    decision: CommercialApprovalDecisionWrite,
    outbox?: CommerceAuditOutboxPayload
  ): Promise<CommercialApproval | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.commercialApproval.updateMany({
      where: { tenantId, id, status: 'PENDING' },
      data: {
        status: decision.status,
        decidedByUserId: decision.decidedByUserId,
        decidedAt: decision.decidedAt,
        comment: decision.comment,
      },
    });
    if (count === 0) return null;
    if (outbox) {
      await client.auditOutbox.create({ data: outbox });
    }
    return client.commercialApproval.findFirst({ where: { tenantId, id } });
  }

  /** ONE record by id, tenant-scoped (§9's decision route resolves it first). */
  async findApprovalById(
    tenantId: string,
    id: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialApproval | null> {
    return CommercialLifecycleRepository.reader(tx ?? this.prisma).commercialApproval.findFirst({
      where: { tenantId, id },
    });
  }

  /**
   * A document's approvals — the §9 `?documentId=` read and the projection's input.
   * The handle matters here more than anywhere else: activation CREATES records in the
   * same unit of work that recomputes the projection from them.
   */
  async listApprovalsByDocument(
    tenantId: string,
    purchaseDocumentId: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialApproval[]> {
    return CommercialLifecycleRepository.reader(tx ?? this.prisma).commercialApproval.findMany({
      where: { tenantId, purchaseDocumentId },
      orderBy: { purchaseLineId: 'asc' },
    });
  }

  /** A line's record, or `null` — activation asks before creating (§3-G). */
  async findApprovalByLine(
    tenantId: string,
    purchaseLineId: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialApproval | null> {
    return CommercialLifecycleRepository.reader(tx ?? this.prisma).commercialApproval.findFirst({
      where: { tenantId, purchaseLineId },
    });
  }

  /**
   * PHASE C2 (GAP-1b): the inbox's COMMERCIAL half — THIS tenant's PENDING records that
   * resolved to THIS user, newest first, bounded by `take`.
   *
   * ELIGIBILITY IS §3-G's, NOT THIS FILE'S: `status = PENDING ∧ approverUserId = me` is
   * exactly what `CommercialLifecycleService.decide` verifies before it writes (its check 2
   * and 3), so a row listed here is a row that route will execute. Already-decided rows can
   * never appear — the predicate is the column, not a client-side filter.
   *
   * The array-form transaction is `listInstancePage`'s snapshot discipline: `total` and the
   * rows must describe one moment. A handle is deliberately NOT taken (this read is not part
   * of any unit of work). The supporting composite index `[tenantId, approverUserId, status]`
   * is added by the C2 migration — the same shape step N already gives
   * `WorkflowStepInstance` for its own pending-step read.
   */
  async listPendingApprovalPage(
    tenantId: string,
    approverUserId: string,
    window: { take: number }
  ): Promise<[rows: CommercialApproval[], total: number]> {
    const where = {
      tenantId,
      approverUserId,
      status: 'PENDING' as const,
    };

    return this.prisma.$transaction([
      this.prisma.commercialApproval.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: window.take,
      }),
      this.prisma.commercialApproval.count({ where }),
    ]);
  }
}
