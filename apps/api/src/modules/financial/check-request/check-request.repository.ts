import { Injectable } from '@nestjs/common';
import { FinancialPrismaService } from '../database/financial-prisma.service';
import type {
  CheckAllocation,
  CheckAttachment,
  CheckDelivery,
  CheckDocumentReview,
  CheckExecutiveApproval,
  CheckIssue,
  CheckRequest,
  Prisma,
} from '../../../generated/financial-client';

import { CHECK_REQUEST_STATUS } from './check-request-status';
import type {
  DocumentReviewDecision,
  ExecutiveDecision,
  ManagerDecision,
  RequesterOpinion,
  CheckPurchaseType,
  CheckIssueType,
} from './check-request-status';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckRequest persistence boundary — every
 * statement this slice issues against `finance_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES
 * ---------------------
 * This file owns INSERTs, UPDATEs and tenant-scoped SELECTs. It does not decide whether a
 * request is editable, whether a transition is legal, whether a manager may decide, or
 * whether a self-approval is refused — those live in `check-request-status.ts` and
 * `check-request.service.ts`. A repository that refused a status change would be a second
 * place the lifecycle is written down, and the two would disagree the first time one of
 * them changed. `bom.repository.ts` records the same reasoning for Production.
 *
 * THE ONE THING IT DOES DECIDE, BECAUSE ONLY IT CAN
 * -------------------------------------------------
 * The CONDITIONAL TRANSITION: every state-moving statement carries the expected `from`
 * status inside its WHERE clause, so two concurrent requests for the same row cannot both
 * win, and a retry of a request whose response was lost loses rather than appending a
 * second transition. That is a persistence concern (it must be one statement to be
 * atomic), which is why it lives here rather than in the service.
 *
 * TENANCY
 * -------
 * `tenantId` is the FIRST parameter of every method and appears in EVERY `where`.
 * `prisma.findUnique` is NEVER used: it cannot carry a tenant predicate, so a "find by
 * id" written with it would read another tenant's row — and an `id` alone is not an
 * isolation key. `findFirst({ where: { id, tenantId } })` is the only shape used for a
 * single row, so a foreign id returns `null` and the SERVICE maps that to 404.
 */

/** The row as Financial's own Prisma client returns it. */
export type CheckRequestRecord = CheckRequest;

/** The attachment row as Financial's own Prisma client returns it. */
export type CheckAttachmentRecord = CheckAttachment;

/**
 * A request WITH its five stage records — the read `getOne` and the stage actions use,
 * so a detail response never issues N round trips and never reads a stage of another
 * tenant (the include is anchored on the already tenant-scoped root row).
 */
export type CheckRequestWithStages = CheckRequest & {
  allocation: CheckAllocation | null;
  documentReview: CheckDocumentReview | null;
  executiveApproval: CheckExecutiveApproval | null;
  issue: CheckIssue | null;
  delivery: CheckDelivery | null;
};

/** The subset of writable fields the service passes on create. */
export interface CheckRequestCreateInput {
  title: string;
  checkIssueType: CheckIssueType;
  purchaseType: CheckPurchaseType | null;
  orderReference: string | null;
  projectReference: string | null;
  projectManagerUserId: string | null;
  requesterUserId: string;
  requesterOpinion: RequesterOpinion;
  /**
   * The process PIN written at create (brief §5) — supplied by the service from the
   * definition it is about to start, never from a wire field. The database defaults
   * (`financial.check-issuance` / 1) exist for pre-pin rows; a create that would rely on
   * them silently is a service bug this field makes visible.
   */
  processKey: string;
  processVersion: number;
}

/** The subset of writable fields a requester-owned patch may change. */
export interface CheckRequestPatchInput {
  title?: string;
  checkIssueType?: CheckIssueType;
  purchaseType?: CheckPurchaseType | null;
  orderReference?: string | null;
  projectReference?: string | null;
  projectManagerUserId?: string | null;
  requesterOpinion?: RequesterOpinion;
}

/** What a decision act writes: the status it lands on and the decision record. */
export interface CheckRequestDecisionInput {
  status: number;
  managerDecision: ManagerDecision;
  managerComment?: string | null;
  decidedByUserId: string;
}

/** Stage 3 input — the source's six allocation fields, plus who recorded them. */
export interface CheckAllocationStageInput {
  allocationPlace: string;
  /** Already DTO-validated digits; Prisma accepts the string form of `DECIMAL(18,0)`. */
  balance: string | null;
  checkDate: Date | null;
  checkDescription: string | null;
  checkAmount: string;
  payableTo: string | null;
  recordedByUserId: string | null;
}

/** Stage 4 input — the typed decision the source's `BarasiAsnad` carried. */
export interface CheckDocumentReviewStageInput {
  decision: DocumentReviewDecision;
  comment: string | null;
  recordedByUserId: string | null;
}

/** Stage 5 input — the typed decision the source's `Riyast` carried. */
export interface CheckExecutiveApprovalStageInput {
  decision: ExecutiveDecision;
  comment: string | null;
  recordedByUserId: string | null;
}

/** Stages 6/7 input — the source's confirmation checkbox, recorded as written. */
export interface CheckConfirmationStageInput {
  confirmed: boolean;
  recordedByUserId: string | null;
}

/** The list window and filters, already clamped by the service. */
export interface CheckRequestListQuery {
  skip: number;
  take: number;
  status?: number;
  search?: string;
  /**
   * Phase KPI-RUNTIME: half-open instant window on `decidedAt` — ISO 8601 strings, the SAME
   * filter the report contract declares (`decidedFrom/decidedTo`). KPI-005 cohorts on
   * `decidedAt` ("the decision closes the measurement").
   */
  decidedFrom?: string;
  decidedTo?: string;
}

/**
 * The FILTER half of `CheckRequestListQuery` — one named type so the page read, its total
 * and the reporting summary all build the SAME predicate (the shape Production's
 * `BomHeaderFilter` established).
 */
export type CheckRequestFilter = Pick<
  CheckRequestListQuery,
  'status' | 'search' | 'decidedFrom' | 'decidedTo'
>;

/**
 * The half-open `[from, to)` `decidedAt` predicate, or nothing at all.
 *
 * ONE builder for the three reads that carry the window, so a page, its count and the KPI
 * cohort can never disagree about which instants a month contains. Returns `{}` when no
 * bound is stated, so the `where` object is byte-identical for every existing caller.
 */
export function decidedAtWindow(filter: {
  decidedFrom?: string;
  decidedTo?: string;
}): { decidedAt?: { gte?: Date; lt?: Date } } {
  if (filter.decidedFrom === undefined && filter.decidedTo === undefined) return {};

  return {
    decidedAt: {
      ...(filter.decidedFrom !== undefined ? { gte: new Date(filter.decidedFrom) } : {}),
      ...(filter.decidedTo !== undefined ? { lt: new Date(filter.decidedTo) } : {}),
    },
  };
}

/**
 * Phase B2.1 — AUDIT DURABILITY ADOPTION: the outbox payload that the repository
 * writes atomically inside the same transaction as the business mutation.
 *
 * When provided, the repository writes an `AuditOutbox` row alongside the business
 * state change, guaranteeing that a committed mutation ALWAYS has a durable local
 * audit intent. The relay service (`AuditOutboxRelayService`) then delivers it
 * through `AUDIT_PORT`.
 *
 * The payload is the COMPLETE `AuditEventInput` as built by the audit gateway —
 * the repository is a transport for persistence, NOT an audit decision point.
 */
export interface AuditOutboxPayload {
  tenantId: string;
  auditId: string;
  /**
   * The serialized `AuditEventInput` in Prisma's own `Json` input vocabulary.
   * The builders construct exactly this shape before the repository writes it,
   * so `create({ data: outbox })` needs no assertion at the call site.
   */
  payload: Prisma.InputJsonValue;
}

@Injectable()
export class CheckRequestRepository {
  constructor(private readonly prisma: FinancialPrismaService) {}

  /**
   * Creates a DRAFT for the acting tenant.
   *
   * `status`, `submittedAt`, `decidedAt`, `decidedByUserId` and `managerDecision` are NOT
   * parameters: a new row is a DRAFT with no decision, and the schema's defaults are the
   * one place that fact is stated. `requestDate` likewise comes from the schema default —
   * the column is server-generated by construction, and no caller can supply one.
   */
  async create(tenantId: string, data: CheckRequestCreateInput): Promise<CheckRequestRecord> {
    return this.prisma.checkRequest.create({
      data: { ...data, tenantId },
    });
  }

  /** One row of the acting tenant, or `null`. NEVER a read by id alone. */
  async findById(tenantId: string, id: string): Promise<CheckRequestRecord | null> {
    return this.prisma.checkRequest.findFirst({ where: { id, tenantId } });
  }

  /**
   * One row WITH its five stage records, or `null`. The include is anchored on the
   * tenant-scoped root, so every stage row read through it belongs to the same tenant by
   * construction — the composite FK makes that a database fact, not a hopeful filter.
   */
  async findByIdWithStages(tenantId: string, id: string): Promise<CheckRequestWithStages | null> {
    return this.prisma.checkRequest.findFirst({
      where: { id, tenantId },
      include: {
        allocation: true,
        documentReview: true,
        executiveApproval: true,
        issue: true,
        delivery: true,
      },
    });
  }

  /**
   * Phase REPORTING-CHECK-REQUEST-REPORT: the read seam's narrow alias for
   * `findByIdWithStages`. It STATES the subset the approved Financial-owned
   * reporting reader may use; the rest of Financial keeps calling the
   * canonical method by name.
   */
  async findWithStages(tenantId: string, id: string): Promise<CheckRequestWithStages | null> {
    return this.findByIdWithStages(tenantId, id);
  }

  /** One page of the acting tenant's requests, most recently touched first. */
  async list(
    tenantId: string,
    query: CheckRequestListQuery
  ): Promise<{ items: CheckRequestRecord[]; total: number }> {
    const where: Prisma.CheckRequestWhereInput = {
      tenantId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...decidedAtWindow(query),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.checkRequest.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.checkRequest.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Phase REPORTING-CHECK-REQUEST-REPORT: bounded per-status counts over the
   * SAME filter the list answers — the report summary's database aggregation.
   * One `groupBy`, no row loading, so the summary never materialises the
   * register in application memory.
   */
  async countByStatus(
    tenantId: string,
    filter: CheckRequestFilter
  ): Promise<Map<number, number>> {
    const where: Prisma.CheckRequestWhereInput = {
      tenantId,
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
      ...decidedAtWindow(filter),
    };
    const rows = await this.prisma.checkRequest.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });
    return new Map(rows.map((row) => [row.status, row._count.status]));
  }

  /**
   * Patches a requester-owned row (states 0 and 1), conditionally: the editable-status
   * predicate travels WITH the write, so an edit racing a submission loses.
   *
   * `null` means "not this tenant OR not in an editable status" — the SERVICE re-reads to
   * tell those apart, so its refusal is accurate rather than guessed.
   */
  async updateEditable(
    tenantId: string,
    id: string,
    data: CheckRequestPatchInput
  ): Promise<CheckRequestRecord | null> {
    const result = await this.prisma.checkRequest.updateMany({
      where: {
        id,
        tenantId,
        status: { in: [CHECK_REQUEST_STATUS.DRAFT, CHECK_REQUEST_STATUS.SUBMITTED] },
      },
      data,
    });

    if (result.count === 0) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Moves a requester-owned row into MANAGER_REVIEW — the source's `st=0 submit:
   * c_status := 1 ; StateNext := 2` and its `st=1 forward: StateNext := 2`, as ONE unit
   * of work.
   *
   * WHY TWO HOPS INSIDE ONE TRANSACTION, AND NOT ONE `UPDATE … status = 2`: the source
   * stages the row through SUBMITTED and routes it onward; F1 owns that whole transition
   * ("Ariya must own this transition itself: stage, guard and audit event in one unit of
   * work" — Preflight §7.2) because no workflow engine exists here. Expressing it as
   * DRAFT → SUBMITTED → MANAGER_REVIEW keeps the stage the source names, keeps each hop
   * ORDINAL-guarded (each statement carries its own expected status), and rolls the whole
   * thing back if the second hop loses — so a failed routing can never leave the row
   * stranded in SUBMITTED.
   *
   * `null` = the row is not this tenant's OR not in `from`. The SERVICE re-reads to tell
   * them apart.
   */
  async submit(
    tenantId: string,
    id: string,
    from: number,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    const routed = await this.prisma.$transaction(async (tx) => {
      if (from === CHECK_REQUEST_STATUS.DRAFT) {
        const staged = await tx.checkRequest.updateMany({
          where: { id, tenantId, status: CHECK_REQUEST_STATUS.DRAFT },
          data: { status: CHECK_REQUEST_STATUS.SUBMITTED },
        });
        if (staged.count === 0) return false;
      }

      const advanced = await tx.checkRequest.updateMany({
        where: { id, tenantId, status: CHECK_REQUEST_STATUS.SUBMITTED },
        data: {
          status: CHECK_REQUEST_STATUS.MANAGER_REVIEW,
          submittedAt: new Date(),
        },
      });
      if (advanced.count === 0) return false;

      // Phase B2.1: durable audit outbox — committed atomically with the business mutation.
      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }
      return true;
    });

    if (!routed) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Runs a conditional DECISION: only `from` may move to the next status, and the
   * decision record (decision, comment, decider, instant) is written in the same
   * statement.
   *
   * The expected `from` status is in the WHERE clause, so two concurrent decisions for
   * the same request cannot both win, and a retry of a decision whose response was lost
   * loses rather than appending a second record. Reading the status and then writing it
   * in a second statement would be exactly the `SELECT … then UPDATE` pair this
   * repository's contract refuses.
   */
  async decide(
    tenantId: string,
    id: string,
    from: number,
    data: CheckRequestDecisionInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    // Phase B2.1: wrap in a transaction so the outbox write (when present) is atomic
    // with the business mutation. Without an outbox payload the behavior is unchanged.
    const succeeded = await this.prisma.$transaction(async (tx) => {
      const result = await tx.checkRequest.updateMany({
        where: { id, tenantId, status: from },
        data: {
          status: data.status,
          managerDecision: data.managerDecision,
          managerComment: data.managerComment === undefined ? undefined : data.managerComment,
          decidedAt: new Date(),
          decidedByUserId: data.decidedByUserId,
        },
      });
      if (result.count === 0) return false;

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }
      return true;
    });

    if (!succeeded) return null;
    return this.findById(tenantId, id);
  }

  // ==========================================================================
  // Phase CHECK-ISSUATION — the five stage transitions.
  //
  // EVERY ONE IS THE SAME SHAPE the `submit` method established: ONE transaction whose
  // FIRST statement is the conditional status move (`WHERE tenantId = ? AND id = ?
  // AND status = from`), whose LAST is the stage-row upsert, and which returns `false`
  // (→ service 409) the instant the conditional write loses. So:
  //   * two concurrent stage actions cannot both win (the conditional move decides);
  //   * a retry after a lost response cannot double-write (the status already moved);
  //   * decision + stage data + status land together or not at all (brief §34);
  //   * one row per stage per request is a UNIQUE constraint, and re-entry REWRITES it —
  //     the previous run's evidence lives in the platform audit trail, the one history.
  // The status value itself never comes from here: the SERVICE computed it with
  // `checkRequestStatusAfter`, the domain transition table.
  // ==========================================================================

  /** Stage 3 → 4: the allocation form (source task 140-163), in one unit of work. */
  async allocate(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    data: CheckAllocationStageInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    return this.runStageTransition(tenantId, id, from, to, (tx, base) =>
      tx.checkAllocation.upsert({
        where: { tenantId_checkRequestId: { tenantId, checkRequestId: id } },
        create: { ...base, ...data },
        update: { ...data },
      }),
      outbox,
    );
  }

  /** Stage 4 → 5 | 1: the document-review decision. */
  async recordDocumentReview(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    data: CheckDocumentReviewStageInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    return this.runStageTransition(tenantId, id, from, to, (tx, base) =>
      tx.checkDocumentReview.upsert({
        where: { tenantId_checkRequestId: { tenantId, checkRequestId: id } },
        create: { ...base, ...data },
        update: { ...data },
      }),
      outbox,
    );
  }

  /** Stage 5 → 6 | 50: the presidency's decision. */
  async recordExecutiveApproval(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    data: CheckExecutiveApprovalStageInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    return this.runStageTransition(tenantId, id, from, to, (tx, base) =>
      tx.checkExecutiveApproval.upsert({
        where: { tenantId_checkRequestId: { tenantId, checkRequestId: id } },
        create: { ...base, ...data },
        update: { ...data },
      }),
      outbox,
    );
  }

  /** Stage 6 → 7: the issuance confirmation (the image is an attachment row). */
  async confirmIssue(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    data: CheckConfirmationStageInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    return this.runStageTransition(tenantId, id, from, to, (tx, base) =>
      tx.checkIssue.upsert({
        where: { tenantId_checkRequestId: { tenantId, checkRequestId: id } },
        create: { ...base, issuedCheckConfirmed: data.confirmed, recordedByUserId: data.recordedByUserId },
        update: { issuedCheckConfirmed: data.confirmed, recordedByUserId: data.recordedByUserId },
      }),
      outbox,
    );
  }

  /** Stage 7 → 8: the delivery completion (the receipt is an attachment row). */
  async completeDelivery(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    data: CheckConfirmationStageInput,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    return this.runStageTransition(tenantId, id, from, to, (tx, base) =>
      tx.checkDelivery.upsert({
        where: { tenantId_checkRequestId: { tenantId, checkRequestId: id } },
        create: { ...base, deliveryCompleted: data.confirmed, recordedByUserId: data.recordedByUserId },
        update: { deliveryCompleted: data.confirmed, recordedByUserId: data.recordedByUserId },
      }),
      outbox,
    );
  }

  /**
   * The shared transaction shape. `writeStage` receives the transaction and the
   * `{ tenantId, checkRequestId }` base every stage row carries; the conditional status
   * move runs FIRST so a lost race aborts before any stage row is touched.
   */
  private async runStageTransition(
    tenantId: string,
    id: string,
    from: number,
    to: number,
    writeStage: (
      tx: Prisma.TransactionClient,
      base: { tenantId: string; checkRequestId: string }
    ) => Promise<unknown>,
    outbox?: AuditOutboxPayload,
  ): Promise<CheckRequestRecord | null> {
    const routed = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.checkRequest.updateMany({
        where: { id, tenantId, status: from },
        data: { status: to },
      });
      if (moved.count === 0) return false;

      await writeStage(tx, { tenantId, checkRequestId: id });

      // Phase B2.1: durable audit outbox — committed atomically with the stage transition.
      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }
      return true;
    });

    if (!routed) return null;
    return this.findById(tenantId, id);
  }
}
