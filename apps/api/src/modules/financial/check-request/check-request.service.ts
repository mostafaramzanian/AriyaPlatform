import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  USER_DIRECTORY,
  type UserDirectoryContract,
} from '../../../platform/user-directory/user-directory.contract';
import { FinancialAuditGateway } from '../financial-audit.gateway';
import { FINANCIAL_AUDIT_RESOURCE } from '../financial.constants';
import { CheckRequestRepository } from './check-request.repository';
import type {
  CheckRequestRecord,
  CheckRequestWithStages,
} from './check-request.repository';
import {
  checkRequestStatusAfter,
  checkRequestStatusName,
  isCheckRequestEditable,
  type CheckIssueType,
  type CheckPurchaseType,
  type DocumentReviewDecision,
  type ExecutiveDecision,
  type ManagerDecision,
  type RequesterOpinion,
} from './check-request-status';
import {
  CHECK_REQUEST_AUDIT_ACTION,
  CHECK_REQUEST_ERROR_CODES,
  buildCheckRequestTitle,
} from './check-request';
import {
  resolveFinancialPageWindow,
  resolveFinancialTimelineWindow,
  type AllocateCheckRequestDto,
  type CheckRequestTimelineQueryDto,
  type ConfirmCheckDeliveryDto,
  type ConfirmCheckIssueDto,
  type CreateCheckRequestDto,
  type DecideCheckRequestDto,
  type DecideDocumentReviewDto,
  type DecideExecutiveApprovalDto,
  type ListCheckRequestsQueryDto,
  type UpdateCheckRequestDto,
} from './check-request.dto';
import { CheckAttachmentRepository } from './check-attachment.repository';
import {
  CHECK_ISSUANCE_PROCESS_KEY,
  CHECK_ISSUANCE_PROCESS_VERSION,
  resolveCheckIssuanceDefinition,
} from '../process/check-issuance.definition';
import {
  actionsAvailableInState,
  findActorPolicy,
  findStepForState,
  isTerminalState,
} from '../../../platform/process/process-definition';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the CheckRequest slice's application surface — create,
 * read, list, update-while-requester-owned, submit and the three manager decision acts.
 *
 * WHAT THIS FILE OWNS: orchestration and the rules that need more than one fact — tenant
 * scoping, the source's conditional validations (V1–V7) in the source's own order, the
 * conditional clearing, the server-generated title and requestDate, the forced requester,
 * the project-manager membership check, the self-approval refusal, the state guards and
 * the audit trail. It issues NO raw Prisma query: persistence is
 * `CheckRequestRepository`'s, which keeps the tenant predicate and the conditional status
 * writes in one reviewable file.
 *
 * THE TENANT COMES FROM THE ACTOR, ALWAYS. Every method takes the actor shape and passes
 * `actor.tenantId` as the repository's first argument. No DTO carries a tenant field and
 * no lookup is by id alone — so there is no shape of these routes that reads another
 * tenant's request.
 *
 * IDENTITY IS REACHED THROUGH THE PLATFORM PORT. One need: "is this id a member of my
 * tenant?" before a project-manager id is STORED — `USER_DIRECTORY.findTenantMember`'s
 * question, answered against Core's identity tables by the platform adapter, never by a
 * join, because Financial's database cannot see them.
 *
 * ONE TRAIL, AND ONLY AFTER A WRITE SUCCEEDED. The audit gateway is handed the row the
 * repository RETURNED, never the intent that produced it: a trail recording what a caller
 * meant to write would disagree with `finance_db` the first time a conditional write
 * refused one. The call cannot turn a completed mutation into a failure
 * (`FinancialAuditGateway` logs and swallows).
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 *  * NO cheque-instrument logic (number, bank, amount, due date): Preflight §10 proves
 *    the source has none and the brief forbids inventing any.
 *  * NO allocation / document-review / executive-approval / issuance / delivery logic.
 *    State 3 is written by `approve` and NOTHING ELSE runs on it — the brief's §12 is
 *    explicit that state 3 is a downstream-deferred marker in F1.
 *  * NO Purchase or Project resolution. `orderReference` and `projectReference` are
 *    opaque strings; the `PurchaseOrderReferencePort` interface exists WITHOUT an
 *    adapter, and nothing injects it (see `purchase-order-reference.port.ts`).
 *  * NO workflow engine and no `nextState` routing column: the source's `StateNext` was a
 *    lever for a SharePoint workflow outside both files; F1's transitions are the
 *    route-driven operations this class performs atomically.
 *  * NO hard-coded person, name, title or employee id anywhere: actors come from the
 *    session, the project manager from the row, authorization from `@Roles(...)` and the
 *    entitlement gate.
 */

/** The actor shape this service needs — structurally `FinancialActor`. */
interface CheckRequestActor {
  tenantId: string;
  userId: string | null;
  requestId: string;
  correlationId?: string;
  ip: string | null;
  userAgent: string | null;
}

/** What one request looks like on the wire. No derived field, no label, no status name. */
export interface CheckRequestView {
  id: string;
  title: string;
  checkIssueType: CheckIssueType;
  purchaseType: CheckPurchaseType | null;
  orderReference: string | null;
  projectReference: string | null;
  projectManagerUserId: string | null;
  requesterUserId: string;
  requestDate: string;
  requesterOpinion: RequesterOpinion;
  status: number;
  managerDecision: ManagerDecision | null;
  managerComment: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of requests, the shape every register list returns. */
export interface CheckRequestPage {
  items: CheckRequestView[];
  total: number;
  page: number;
  pageSize: number;
}

/** The process pin + current step a detail response carries (derived, never stored). */
export interface CheckRequestProcessView {
  processKey: string;
  processVersion: number;
  terminal: boolean;
  step: { key: string; title: string; progressLabel: string; order: number } | null;
}

/** The five stage records on the wire — `null` until the stage's action has run. */
export interface CheckRequestStageViews {
  allocation: {
    allocationPlace: string;
    balance: string | null;
    /** `YYYY-MM-DD`, the DTO's own format — round-trips through the allocate payload. */
    checkDate: string | null;
    checkDescription: string | null;
    checkAmount: string;
    payableTo: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  documentReview: {
    decision: DocumentReviewDecision;
    comment: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  executiveApproval: {
    decision: ExecutiveDecision;
    comment: string | null;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  issue: {
    issuedCheckConfirmed: boolean;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  delivery: {
    deliveryCompleted: boolean;
    recordedByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
}

/**
 * The DETAIL wire shape: the F1 view plus the process pin and the stage records.
 * Additive on purpose — a list item stays a `CheckRequestView`, so F1 clients keep
 * parsing what they always parsed.
 */
export interface CheckRequestDetailView extends CheckRequestView {
  process: CheckRequestProcessView;
  stages: CheckRequestStageViews;
}

/** ONE available action, as `GET …/available-actions` reports it. */
export interface CheckRequestAvailableActionView {
  action: string;
  label: string;
  permission: string;
  enabled: boolean;
  /** `null` when enabled; a stable refusal reason code otherwise. */
  reason: string | null;
}

export interface CheckRequestAvailableActionsView {
  processKey: string;
  processVersion: number;
  state: number;
  terminal: boolean;
  step: { key: string; title: string; progressLabel: string; order: number } | null;
  actions: CheckRequestAvailableActionView[];
}

/** The timeline projection — an EXPLICIT WHITELIST of seven fields (see `getTimeline`). */
export interface CheckRequestTimelineItem {
  id: string;
  action: string;
  actorId: string | null;
  success: boolean;
  reason: string | null;
  changedFields: string[];
  createdAt: string;
}

export interface CheckRequestTimelinePage {
  items: CheckRequestTimelineItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** Projects a stored row onto the wire shape. */
export function toCheckRequestView(row: CheckRequestRecord): CheckRequestView {
  return {
    id: row.id,
    title: row.title,
    checkIssueType: row.checkIssueType,
    purchaseType: row.purchaseType,
    orderReference: row.orderReference,
    projectReference: row.projectReference,
    projectManagerUserId: row.projectManagerUserId,
    requesterUserId: row.requesterUserId,
    requestDate: row.requestDate.toISOString(),
    requesterOpinion: row.requesterOpinion,
    status: row.status,
    managerDecision: row.managerDecision,
    managerComment: row.managerComment,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The merged field set the validations and the title run against. */
interface CheckRequestFacts {
  checkIssueType: CheckIssueType;
  purchaseType: CheckPurchaseType | null;
  orderReference: string | null;
  projectReference: string | null;
  projectManagerUserId: string | null;
}

/** `undefined` → null; a trimmed empty string → null; otherwise the trimmed value. */
function normalizeRef(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class CheckRequestService {
  /** One purpose: recording that the platform refused a timeline read, with its CLOSED code. */
  private readonly logger = new Logger(CheckRequestService.name);

  constructor(
    private readonly repository: CheckRequestRepository,
    private readonly attachments: CheckAttachmentRepository,
    private readonly audit: FinancialAuditGateway,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectoryContract
  ) {}

  /**
   * Creates a DRAFT for the acting tenant.
   *
   * THE REQUESTER IS FORCED FROM THE ACTOR (V6), never read from the wire: the DTO has
   * no `requesterUserId` field at all, so a forged one is a typed refusal naming the
   * field, and this method settles any doubt with `actor.userId`. A machine context (no
   * user id) is refused outright: «درخواست کننده انتخاب گردد!» is a rule about WHO
   * raises a request, not a default.
   *
   * THE PROJECT MANAGER IS MEMBERSHIP-CHECKED BEFORE STORAGE (when stated), because
   * nothing inside `finance_db` can check it — no foreign key across databases exists by
   * design. An id that is not a member is a 400 naming the field, never a stored
   * reference to a stranger.
   */
  async create(actor: CheckRequestActor, dto: CreateCheckRequestDto): Promise<CheckRequestView> {
    if (!actor.userId) {
      throw new ForbiddenException({
        code: CHECK_REQUEST_ERROR_CODES.REQUESTER_REQUIRED,
        message: 'A check request requires an authenticated requester.',
      });
    }

    const facts = this.withConditionalClearing({
      checkIssueType: dto.checkIssueType,
      purchaseType: dto.purchaseType ?? null,
      orderReference: normalizeRef(dto.orderReference),
      projectReference: normalizeRef(dto.projectReference),
      projectManagerUserId: normalizeRef(dto.projectManagerUserId),
    });

    this.assertBusinessRules(facts);
    if (facts.projectManagerUserId) {
      await this.assertTenantMember(
        actor.tenantId,
        facts.projectManagerUserId,
        'projectManagerUserId'
      );
    }

    const row = await this.repository.create(actor.tenantId, {
      title: buildCheckRequestTitle(facts.checkIssueType, facts.purchaseType),
      checkIssueType: facts.checkIssueType,
      purchaseType: facts.purchaseType,
      orderReference: facts.orderReference,
      projectReference: facts.projectReference,
      projectManagerUserId: facts.projectManagerUserId,
      requesterUserId: actor.userId,
      requesterOpinion: dto.requesterOpinion ?? 'CONTINUE',
      // The PROCESS PIN (brief §5): the version this request will run under, written
      // once, never rewritten — later published versions cannot change its meaning.
      processKey: CHECK_ISSUANCE_PROCESS_KEY,
      processVersion: CHECK_ISSUANCE_PROCESS_VERSION,
    });

    await this.audit.record(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.CREATE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: row.id,
      newValue: { status: row.status, checkIssueType: row.checkIssueType },
    });

    return toCheckRequestView(row);
  }

  /** One page of the acting tenant's requests, newest first. */
  async list(
    actor: CheckRequestActor,
    query: ListCheckRequestsQueryDto
  ): Promise<CheckRequestPage> {
    const window = resolveFinancialPageWindow(query);

    const { items, total } = await this.repository.list(actor.tenantId, {
      skip: window.skip,
      take: window.take,
      status: query.status,
      search: query.search,
    });

    return {
      items: items.map(toCheckRequestView),
      total,
      page: window.page,
      pageSize: window.pageSize,
    };
  }

  /**
   * One request of the acting tenant, or 404 — as the DETAIL shape: the F1 view plus
   * the process pin (with its resolved step) and the five stage records. The include is
   * one tenant-scoped read, so a detail response can never pair another tenant's stage
   * row with this request.
   */
  async getOne(actor: CheckRequestActor, id: string): Promise<CheckRequestDetailView> {
    const row = await this.repository.findByIdWithStages(actor.tenantId, id);
    if (!row) {
      throw new NotFoundException('Check request not found.');
    }
    return CheckRequestService.toDetailView(row);
  }

  /**
   * Patches a requester-owned row (states 0 and 1). 409 once the manager owns it.
   *
   * AN EMPTY PATCH IS A 400: `updatedAt` only moves on a real write, so an audit row for
   * a mutation that changed nothing would make the trail unable to distinguish a no-op
   * from a real edit — and `changedFields` would be an empty list nothing can act on.
   *
   * THE MERGE IS THE WHOLE RULE: the stated fields are layered over the stored row, the
   * source's conditional clearing (V7) re-applies to the MERGED facts — exactly as the
   * source's save script rewrote the cleared controls regardless of what the form still
   * held — and the title is rebuilt from the result. So a client cannot "keep" a salary
   * request's order reference by simply not sending `checkIssueType`, and it cannot state
   * a title at all.
   *
   * THE STATE GUARD IS A PRECONDITION, NOT AN AUTHORIZATION: `isCheckRequestEditable`
   * says the row is still the requester's to change; the `financial.check.manage`
   * permission and the tenant scope say this caller may act at all.
   */
  async update(
    actor: CheckRequestActor,
    id: string,
    dto: UpdateCheckRequestDto
  ): Promise<CheckRequestView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (!isCheckRequestEditable(current.status)) {
      throw this.stateConflict(current.status, 'edited');
    }

    const statedKeys = Object.keys(dto);
    if (statedKeys.length === 0) {
      throw new BadRequestException('State at least one field to change.');
    }

    const facts = this.withConditionalClearing({
      checkIssueType: dto.checkIssueType ?? current.checkIssueType,
      purchaseType: dto.purchaseType !== undefined ? dto.purchaseType : current.purchaseType,
      orderReference:
        dto.orderReference !== undefined
          ? normalizeRef(dto.orderReference)
          : current.orderReference,
      projectReference:
        dto.projectReference !== undefined
          ? normalizeRef(dto.projectReference)
          : current.projectReference,
      projectManagerUserId:
        dto.projectManagerUserId !== undefined
          ? normalizeRef(dto.projectManagerUserId)
          : current.projectManagerUserId,
    });

    this.assertBusinessRules(facts);
    if (dto.projectManagerUserId !== undefined && facts.projectManagerUserId) {
      await this.assertTenantMember(
        actor.tenantId,
        facts.projectManagerUserId,
        'projectManagerUserId'
      );
    }

    const updated = await this.repository.updateEditable(actor.tenantId, id, {
      title: buildCheckRequestTitle(facts.checkIssueType, facts.purchaseType),
      checkIssueType: facts.checkIssueType,
      purchaseType: facts.purchaseType,
      orderReference: facts.orderReference,
      projectReference: facts.projectReference,
      projectManagerUserId: facts.projectManagerUserId,
      ...(dto.requesterOpinion !== undefined ? { requesterOpinion: dto.requesterOpinion } : {}),
    });

    if (!updated) {
      // The conditional write lost a race with a concurrent transition. Re-read so the
      // refusal names the CURRENT status instead of guessing what changed.
      const now = await this.requireRow(actor.tenantId, id);
      throw this.stateConflict(now.status, 'edited');
    }

    await this.audit.record(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.UPDATE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: updated.id,
      oldValue: {
        checkIssueType: current.checkIssueType,
        purchaseType: current.purchaseType,
        title: current.title,
      },
      newValue: {
        checkIssueType: updated.checkIssueType,
        purchaseType: updated.purchaseType,
        title: updated.title,
      },
      changedFields: statedKeys,
    });

    return toCheckRequestView(updated);
  }

  /**
   * Routes a requester-owned row into manager review: {0, 1} → 2, once.
   *
   * WHY THE VALIDATION RUNS AGAINST THE STORED ROW: the source's save/forward scripts
   * validate at BOTH moments — the state-0 save and the state-1 forward each ran the same
   * V1–V7 chain before writing — so a row whose facts went stale is refused HERE rather
   * than reaching a manager who cannot act on it. Submit is the last moment the requester
   * owns the row, which makes it the last honest place to check.
   *
   * THE ROUTE IS THE SOURCE'S TWO-STEP SUBMIT+FORWARD, atomically — see
   * `CheckRequestRepository.submit`. The audit event is ONE `submit` carrying the full
   * transition (`from` → 2): there is exactly one caller-visible act.
   */
  async submit(actor: CheckRequestActor, id: string): Promise<CheckRequestView> {
    const current = await this.requireRow(actor.tenantId, id);

    const next = checkRequestStatusAfter(current.status, 'SUBMIT');
    if (next === null) {
      throw this.stateConflict(current.status, 'submitted');
    }

    this.assertBusinessRules({
      checkIssueType: current.checkIssueType,
      purchaseType: current.purchaseType,
      orderReference: current.orderReference,
      projectReference: current.projectReference,
      projectManagerUserId: current.projectManagerUserId,
    });

    // Phase B2.1: the outbox payload is built BEFORE the repository call so the audit
    // event commits atomically with the business mutation. The resourceId is the row's
    // id — which does not change across the transition — so we can stamp it here.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.SUBMIT,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: next },
      changedFields: ['status'],
    });

    const updated = await this.repository.submit(
      actor.tenantId, id, current.status, outbox,
    );

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);
      throw this.stateConflict(now.status, 'submitted');
    }

    return toCheckRequestView(updated);
  }

  /**
   * Records the manager's decision — ONE method, three routes, the outcome fixed by the
   * route (the brief's §14): the DTO carries only an optional comment, so there is no
   * body field that could rewrite the meaning of the call.
   *
   * A HUMAN ACTOR IS REQUIRED (fail-closed): a machine context cannot decide — 403 before
   * any state check. Self-approval is refused next: the brief's §15 rule, applied to the
   * ROW's requester against the ACTOR (the source neither blocks nor mentions it — §8.3
   * `NOT ESTABLISHED` — so the standard Ariya fail-closed default governs). Anybody else
   * holding `financial.check.approve` may decide, including for a NON-project request
   * with no `projectManagerUserId`: F1 does not snapshot an approver, because the brief's
   * §15 lists membership + authority + not-the-requester as the requirements, and U3's
   * "who exactly may act" is NOT ESTABLISHED as anything stricter.
   *
   * STATE 3 IS THE END OF THIS PHASE'S LOGIC: approve writes status 3, the decision and
   * the audit event, and stops — no allocation, no issuance, no downstream queue (§12).
   */
  async decide(
    actor: CheckRequestActor,
    id: string,
    expected: ManagerDecision,
    dto: DecideCheckRequestDto
  ): Promise<CheckRequestView> {
    const current = await this.requireRow(actor.tenantId, id);

    if (!actor.userId) {
      throw new ForbiddenException({
        code: CHECK_REQUEST_ERROR_CODES.DECIDER_REQUIRED,
        message: 'A decision requires an authenticated actor.',
      });
    }

    const next = checkRequestStatusAfter(current.status, expected);
    if (next === null) {
      throw this.stateConflict(current.status, `decided (${expected})`);
    }

    if (actor.userId === current.requesterUserId) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL,
        message:
          'The requester of a check request cannot decide their own request; self-approval is not permitted.',
      });
    }

    const action =
      expected === 'APPROVE'
        ? CHECK_REQUEST_AUDIT_ACTION.APPROVE
        : expected === 'REJECT'
          ? CHECK_REQUEST_AUDIT_ACTION.REJECT
          : CHECK_REQUEST_AUDIT_ACTION.REQUEST_CORRECTION;

    // Phase B2.1: build the outbox payload BEFORE the repository call so the audit
    // event commits atomically with the manager decision.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status, managerDecision: current.managerDecision },
      newValue: { status: next, managerDecision: expected },
      changedFields: [
        'status',
        'managerDecision',
        'managerComment',
        'decidedAt',
        'decidedByUserId',
      ],
    });

    const updated = await this.repository.decide(actor.tenantId, id, current.status, {
      status: next,
      managerDecision: expected,
      managerComment: dto.comment ?? null,
      decidedByUserId: actor.userId,
    }, outbox);

    if (!updated) {
      const now = await this.requireRow(actor.tenantId, id);
      throw this.stateConflict(now.status, `decided (${expected})`);
    }

    return toCheckRequestView(updated);
  }

  // ==========================================================================
  // Phase CHECK-ISSUATION — the downstream stage actions (states 3 → 8).
  //
  // EVERY ONE follows the `decide` shape: load tenant-scoped → compute `next` with
  // `checkRequestStatusAfter` (the domain transition table, the ONLY transition
  // definition in this repository) → refuse a null `next` with a typed 409 → run the
  // repository's conditional one-unit-of-work write → audit the RETURNED row → return
  // the DETAIL view. Configuration supplies labels/permissions/section gates (the
  // pinned process definition); the rules below are DOMAIN CODE a configuration
  // cannot switch off (brief §6).
  // ==========================================================================

  /**
   * Stage 3 — «صدور فرم تخصیص». V9 / V10 / V11 exactly as the task script evaluates
   * them (task 140-163), in the source's own order and with its own messages:
   *   V9  «محل تخصیص نمی تواند خالی باشد.»
   *   V10 «مبلغ چک نمی تواند خالی باشد.»
   *   V11 «مبلغ چک از مانده موجودی نمی تواند بیشتر باشد.»
   *
   * V11 is compared as BigInt, not as a JS number: ریال amounts reach 18 digits and
   * `Decimal(18,0)` must not be reduced to IEEE-754 rounding. An ABSENT balance skips
   * the comparison — faithful to the source, whose `parseInt('')` produced `NaN` and
   * whose `x > NaN` is false: the script never blocked an empty مانده موجودی.
   *
   * No other money rule exists here: no currency, no bank, no account, no formula
   * (Preflight §6.2 and the brief §18).
   */
  async allocate(
    actor: CheckRequestActor,
    id: string,
    dto: AllocateCheckRequestDto
  ): Promise<CheckRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    const next = checkRequestStatusAfter(current.status, 'ALLOCATE');
    if (next === null) {
      throw this.stateConflict(current.status, 'allocated');
    }

    const allocationPlace = dto.allocationPlace.trim();
    if (allocationPlace.length === 0) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ALLOCATION_PLACE_REQUIRED,
        message: 'The allocation place cannot be empty.',
      });
    }
    if (dto.checkAmount.trim().length === 0) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ALLOCATION_AMOUNT_REQUIRED,
        message: 'The cheque amount cannot be empty.',
      });
    }
    if (
      dto.balance !== undefined &&
      dto.balance !== '' &&
      BigInt(dto.checkAmount) > BigInt(dto.balance)
    ) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ALLOCATION_AMOUNT_EXCEEDS_BALANCE,
        message: 'The cheque amount cannot exceed the remaining balance.',
      });
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.ALLOCATE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: next, allocation: dto },
      changedFields: ['status', 'allocation'],
    });

    const updated = await this.repository.allocate(actor.tenantId, id, current.status, next, {
      allocationPlace,
      balance: dto.balance && dto.balance.length > 0 ? dto.balance : null,
      checkDate: dto.checkDate ? new Date(`${dto.checkDate}T00:00:00.000Z`) : null,
      checkDescription: dto.checkDescription?.trim() || null,
      checkAmount: dto.checkAmount,
      payableTo: dto.payableTo?.trim() || null,
      recordedByUserId: actor.userId,
    }, outbox);
    if (updated === null) {
      throw this.stateConflict((await this.requireRow(actor.tenantId, id)).status, 'allocated');
    }

    return CheckRequestService.toDetailView(await this.requireDetail(actor.tenantId, id));
  }

  /**
   * Stage 4 — «بررسی اسناد». `تایید` advances, `اصلاح` returns the row to the requester
   * (`StateNext := 1`) — and nothing else exists: the source's review stage offers no
   * reject. A DECISION ACT, so it requires a human actor and refuses self-review
   * fail-closed (the configured `reviewer` policy's `forbidSelfApproval`).
   */
  async reviewDocuments(
    actor: CheckRequestActor,
    id: string,
    dto: DecideDocumentReviewDto
  ): Promise<CheckRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    this.ensureHumanDecision(actor);
    this.ensureNotSelfActor(current.requesterUserId, actor.userId);

    const actionKey =
      dto.decision === 'APPROVE' ? 'DOCUMENT_REVIEW_APPROVE' : 'DOCUMENT_REVIEW_CORRECTION';
    const next = checkRequestStatusAfter(current.status, actionKey);
    if (next === null) {
      throw this.stateConflict(current.status, 'reviewed');
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action:
        dto.decision === 'APPROVE'
          ? CHECK_REQUEST_AUDIT_ACTION.DOCUMENT_REVIEW
          : CHECK_REQUEST_AUDIT_ACTION.DOCUMENT_REVIEW_CORRECTION,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status, decision: null },
      newValue: { status: next, decision: dto.decision, comment: dto.comment ?? null },
      changedFields: ['status', 'documentReview'],
    });

    const updated = await this.repository.recordDocumentReview(
      actor.tenantId,
      id,
      current.status,
      next,
      {
        decision: dto.decision,
        comment: dto.comment?.trim() || null,
        recordedByUserId: actor.userId,
      },
      outbox,
    );
    if (updated === null) {
      throw this.stateConflict((await this.requireRow(actor.tenantId, id)).status, 'reviewed');
    }

    return CheckRequestService.toDetailView(await this.requireDetail(actor.tenantId, id));
  }

  /**
   * Stage 5 — «تایید ریاست». `تایید` → 6, `رد` → 50. The source's third value has NO
   * branch here (DEFERRED / SOURCE-CONFLICT — brief §20): the DTO's enum simply does not
   * contain it, so no body can express a guessed target. A DECISION ACT: human actor
   * required, self-approval refused fail-closed (the `executive` policy).
   */
  async executiveDecision(
    actor: CheckRequestActor,
    id: string,
    dto: DecideExecutiveApprovalDto
  ): Promise<CheckRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    this.ensureHumanDecision(actor);
    this.ensureNotSelfActor(current.requesterUserId, actor.userId);

    const actionKey = dto.decision === 'APPROVE' ? 'EXECUTIVE_APPROVE' : 'EXECUTIVE_REJECT';
    const next = checkRequestStatusAfter(current.status, actionKey);
    if (next === null) {
      throw this.stateConflict(current.status, 'decided (executive)');
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action:
        dto.decision === 'APPROVE'
          ? CHECK_REQUEST_AUDIT_ACTION.EXECUTIVE_APPROVE
          : CHECK_REQUEST_AUDIT_ACTION.EXECUTIVE_REJECT,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status, decision: null },
      newValue: { status: next, decision: dto.decision, comment: dto.comment ?? null },
      changedFields: ['status', 'executiveApproval'],
    });

    const updated = await this.repository.recordExecutiveApproval(
      actor.tenantId,
      id,
      current.status,
      next,
      {
        decision: dto.decision,
        comment: dto.comment?.trim() || null,
        recordedByUserId: actor.userId,
      },
      outbox,
    );
    if (updated === null) {
      throw this.stateConflict(
        (await this.requireRow(actor.tenantId, id)).status,
        'decided (executive)'
      );
    }

    return CheckRequestService.toDetailView(await this.requireDetail(actor.tenantId, id));
  }

  /**
   * Stage 6 — «صدور چک کارشناس مالی». The source's two gates, in the script's OWN
   * order (task 205-218): the cheque image first («تصویر چک صادر شده بارگذاری نشده
   * است!»), then the confirmation («گزینه تایید چک صادر شده انتخاب نشده است!»).
   *
   * The IMAGE GATE is read from the pinned definition's document policy
   * (`requiredForActions`) — configuration-driven as the brief §27 requires — and
   * `check-issuance.definition.spec.ts` pins that v1 declares it, so the gate cannot
   * silently disappear from the configuration either.
   */
  async issue(
    actor: CheckRequestActor,
    id: string,
    dto: ConfirmCheckIssueDto
  ): Promise<CheckRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    const next = checkRequestStatusAfter(current.status, 'ISSUE');
    if (next === null) {
      throw this.stateConflict(current.status, 'issued');
    }

    await this.requireSectionEvidence(
      current,
      'issue',
      CHECK_REQUEST_ERROR_CODES.ISSUE_IMAGE_REQUIRED
    );
    if (dto.confirmed !== true) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ISSUE_CONFIRMATION_REQUIRED,
        message: 'The issued cheque must be confirmed before it can be issued.',
      });
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.ISSUE,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: next, issuedCheckConfirmed: true },
      changedFields: ['status', 'issue'],
    });

    const updated = await this.repository.confirmIssue(actor.tenantId, id, current.status, next, {
      confirmed: true,
      recordedByUserId: actor.userId,
    }, outbox);
    if (updated === null) {
      throw this.stateConflict((await this.requireRow(actor.tenantId, id)).status, 'issued');
    }

    return CheckRequestService.toDetailView(await this.requireDetail(actor.tenantId, id));
  }

  /**
   * Stage 7 — «دریافت رسید تحویل». The source's two gates, in the script's OWN order
   * (task 220-236): the receipt image first («تصویر رسید تحویل بارگذاری نشده است!»),
   * then the completion («گزینه خاتمه صدور چک انتخاب نشده است!»). Landing state 8 is
   * TERMINAL — the task button is disabled at `cr_status >= 8` (Preflight E11), so this
   * is the last action the process ever offers.
   */
  async deliver(
    actor: CheckRequestActor,
    id: string,
    dto: ConfirmCheckDeliveryDto
  ): Promise<CheckRequestDetailView> {
    const current = await this.requireRow(actor.tenantId, id);
    const next = checkRequestStatusAfter(current.status, 'DELIVER');
    if (next === null) {
      throw this.stateConflict(current.status, 'delivered');
    }

    await this.requireSectionEvidence(
      current,
      'deliver',
      CHECK_REQUEST_ERROR_CODES.DELIVERY_RECEIPT_REQUIRED
    );
    if (dto.completed !== true) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.DELIVERY_CONFIRMATION_REQUIRED,
        message: 'The delivery must be confirmed before the flow can complete.',
      });
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: CHECK_REQUEST_AUDIT_ACTION.DELIVER,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: id,
      oldValue: { status: current.status },
      newValue: { status: next, deliveryCompleted: true },
      changedFields: ['status', 'delivery'],
    });

    const updated = await this.repository.completeDelivery(
      actor.tenantId,
      id,
      current.status,
      next,
      {
        confirmed: true,
        recordedByUserId: actor.userId,
      },
      outbox,
    );
    if (updated === null) {
      throw this.stateConflict((await this.requireRow(actor.tenantId, id)).status, 'delivered');
    }

    return CheckRequestService.toDetailView(await this.requireDetail(actor.tenantId, id));
  }

  /**
   * `GET …/available-actions` (brief §15): the actions the PINNED definition offers from
   * the row's current state, each with its capability, an `enabled` flag and a stable
   * refusal reason when the ACTOR POLICY (not the state) blocks it — today the
   * fail-closed self-approval refusal.
   *
   * PERMISSION IS STATED, NOT ENFORCED here: this service never injects a permission
   * source (that would reach Core's RBAC — brief §1.1). The route's `@Roles` is the
   * enforcement; the client filters with its own permission list
   * (`useCorePermissions`), and the EXECUTING route re-checks everything anyway. What
   * the UI cannot do is render an action the state machine did not list.
   */
  async availableActions(
    actor: CheckRequestActor,
    id: string
  ): Promise<CheckRequestAvailableActionsView> {
    const current = await this.requireRow(actor.tenantId, id);
    const definition = resolveCheckIssuanceDefinition(current.processVersion);
    const step = findStepForState(definition, current.status);
    const terminal = isTerminalState(definition, current.status);

    const candidates = terminal ? [] : actionsAvailableInState(definition, current.status);
    const actions: CheckRequestAvailableActionView[] = candidates.map((action) => {
      const policy = findActorPolicy(definition, action.actorPolicy);
      const selfBlocked =
        (policy?.forbidSelfApproval ?? false) && actor.userId === current.requesterUserId;
      return {
        action: action.key,
        label: action.label,
        permission: action.permission,
        enabled: !selfBlocked,
        reason: selfBlocked ? 'SELF_APPROVAL' : null,
      };
    });

    return {
      processKey: current.processKey,
      processVersion: current.processVersion,
      state: current.status,
      terminal,
      step: step
        ? { key: step.key, title: step.title, progressLabel: step.progressLabel, order: step.order }
        : null,
      actions,
    };
  }

  /**
   * ONE page of this request's audit history, in the platform's authoritative order
   * (`createdAt ASC, id ASC`), read ONLY through the Audit Port.
   *
   * THE SCOPE IS EXACTLY ONE RESOURCE, BOUND SERVER-SIDE — and this is the entire safety
   * of the route. Every input this method touches is:
   *
   *     tenantId   = actor.tenantId        (from `resolveFinancialActor`)
   *     resource   = 'financial.check-request'  (the closed vocabulary constant)
   *     resourceId = row.id                (resolved tenant-scoped by `requireRow`)
   *
   * plus `page`/`pageSize` from the DTO. None of the three scope values is a request
   * input, so no shape of this endpoint reads another tenant's trail or pivots the query
   * to a foreign resource.
   *
   * EMPTY IS NOT FAILED. Zero events answers `items: []` with the platform's `total`. A
   * REJECTED read is a 503 for a platform outage (422 for a caller fault), never a quiet
   * empty page: the two states mean opposite things and a client must tell them apart.
   *
   * ARCHITECTURE (the only path allowed): Controller → resolveFinancialActor → this
   * service → CheckRequestRepository (existence) → FinancialAuditGateway.read →
   * AUDIT_PORT.read → Platform Audit → core_db. Never Core Prisma, never `AuditLog`
   * directly, never a Financial audit mirror, never a reconstruction from `CheckRequest`
   * rows — the brief's §21/§22 are explicit that the Audit Port is the source of truth.
   */
  async getTimeline(
    actor: CheckRequestActor,
    id: string,
    query: CheckRequestTimelineQueryDto
  ): Promise<CheckRequestTimelinePage> {
    // EXISTENCE FIRST, TENANT-SCOPED, AND IT IS A 404 — not a 403 and not an empty page.
    // A request another tenant owns (or no tenant at all) must be indistinguishable from
    // one that does not exist, so the audit boundary is only ever reached for a row this
    // tenant owns.
    const row = await this.requireRow(actor.tenantId, id);
    const window = resolveFinancialTimelineWindow(query);

    const result = await this.audit.read({
      tenantId: actor.tenantId,
      resource: FINANCIAL_AUDIT_RESOURCE.CHECK_REQUEST,
      resourceId: row.id,
      page: window.page,
      pageSize: window.pageSize,
    });

    if (result.status === 'rejected') {
      // The diagnostic classification is preserved: the CLOSED platform code is logged
      // and carried to the client, never an internal message and never a fabricated
      // `items: []`.
      this.logger.error(`Audit read rejected for check request ${row.id}: ${result.code}`);

      if (result.code === 'AUDIT_READ_FAILED') {
        throw new ServiceUnavailableException({
          code: 'AUDIT_READ_FAILED',
          message: 'Audit history is temporarily unavailable.',
        });
      }

      // The caller-fault codes are unreachable through this route — the DTO validates
      // `page`/`pageSize` and the service binds the scope — but they are mapped rather
      // than swallowed: a rejected read is never an empty timeline.
      throw new UnprocessableEntityException({
        code: result.code,
        message: 'The audit read query was rejected by the platform.',
      });
    }

    return {
      items: result.page.items.map(CheckRequestService.projectTimelineItem),
      page: result.page.page,
      pageSize: result.page.pageSize,
      total: result.page.total,
    };
  }

  // ==========================================================================
  // Phase CHECK-ISSUATION — the shared stage helpers.
  // ==========================================================================

  /** One row WITH its stage records, or 404 — the read every stage action ends on. */
  private async requireDetail(tenantId: string, id: string): Promise<CheckRequestWithStages> {
    const row = await this.repository.findByIdWithStages(tenantId, id);
    if (!row) {
      throw new NotFoundException('Check request not found.');
    }
    return row;
  }

  /**
   * The DETAIL projection: F1's view + the process pin (step resolved from the PINNED
   * definition, never from a hand-written status→step map) + the five stage records.
   * A stage row that does not exist yet is `null`, never a fabricated empty object —
   * "this stage has not run" is information the wizard renders.
   */
  private static toDetailView(row: CheckRequestWithStages): CheckRequestDetailView {
    const definition = resolveCheckIssuanceDefinition(row.processVersion);
    const step = findStepForState(definition, row.status);

    return {
      ...toCheckRequestView(row),
      process: {
        processKey: row.processKey,
        processVersion: row.processVersion,
        terminal: isTerminalState(definition, row.status),
        step: step
          ? { key: step.key, title: step.title, progressLabel: step.progressLabel, order: step.order }
          : null,
      },
      stages: {
        allocation: row.allocation
          ? {
              allocationPlace: row.allocation.allocationPlace,
              balance: row.allocation.balance === null ? null : row.allocation.balance.toString(),
              checkDate: row.allocation.checkDate
                ? row.allocation.checkDate.toISOString().slice(0, 10)
                : null,
              checkDescription: row.allocation.checkDescription,
              checkAmount: row.allocation.checkAmount.toString(),
              payableTo: row.allocation.payableTo,
              recordedByUserId: row.allocation.recordedByUserId,
              createdAt: row.allocation.createdAt.toISOString(),
              updatedAt: row.allocation.updatedAt.toISOString(),
            }
          : null,
        documentReview: row.documentReview
          ? {
              decision: row.documentReview.decision,
              comment: row.documentReview.comment,
              recordedByUserId: row.documentReview.recordedByUserId,
              createdAt: row.documentReview.createdAt.toISOString(),
              updatedAt: row.documentReview.updatedAt.toISOString(),
            }
          : null,
        executiveApproval: row.executiveApproval
          ? {
              decision: row.executiveApproval.decision,
              comment: row.executiveApproval.comment,
              recordedByUserId: row.executiveApproval.recordedByUserId,
              createdAt: row.executiveApproval.createdAt.toISOString(),
              updatedAt: row.executiveApproval.updatedAt.toISOString(),
            }
          : null,
        issue: row.issue
          ? {
              issuedCheckConfirmed: row.issue.issuedCheckConfirmed,
              recordedByUserId: row.issue.recordedByUserId,
              createdAt: row.issue.createdAt.toISOString(),
              updatedAt: row.issue.updatedAt.toISOString(),
            }
          : null,
        delivery: row.delivery
          ? {
              deliveryCompleted: row.delivery.deliveryCompleted,
              recordedByUserId: row.delivery.recordedByUserId,
              createdAt: row.delivery.createdAt.toISOString(),
              updatedAt: row.delivery.updatedAt.toISOString(),
            }
          : null,
      },
    };
  }

  /** A DECISION ACT requires an authenticated human actor (F1's DECIDER_REQUIRED). */
  private ensureHumanDecision(actor: CheckRequestActor): void {
    if (!actor.userId) {
      throw new ForbiddenException({
        code: CHECK_REQUEST_ERROR_CODES.DECIDER_REQUIRED,
        message: 'A decision requires an authenticated actor.',
      });
    }
  }

  /**
   * The fail-closed self-approval refusal (Preflight U5 — NOT ESTABLISHED in source,
   * so the restriction applies to every configured decision act): the row's own
   * requester may not decide it, no matter which permission they hold.
   */
  private ensureNotSelfActor(
    requesterUserId: string,
    actorUserId: string | null
  ): void {
    if (actorUserId !== null && requesterUserId === actorUserId) {
      throw new ForbiddenException({
        code: CHECK_REQUEST_ERROR_CODES.SELF_APPROVAL,
        message: 'The requester of a check request cannot decide it.',
      });
    }
  }

  /**
   * The configuration-driven document gate (brief §27): for `actionKey`, the pinned
   * definition's document sections that list it in `requiredForActions` must hold at
   * least one document, or a 409 carries the source's own sentence. The source's TASK
   * SCRIPT messages become the stable error codes («تصویر چک صادر شده بارگذاری نشده
   * است!» / «تصویر رسید تحویل بارگذاری نشده است!») — the web maps code → Persian.
   */
  private async requireSectionEvidence(
    row: CheckRequestRecord,
    actionKey: string,
    errorCode: string
  ): Promise<void> {
    const definition = resolveCheckIssuanceDefinition(row.processVersion);
    for (const section of definition.documentSections) {
      if (!section.requiredForActions.includes(actionKey)) continue;
      const count = await this.attachments.countByRequestSection(
        row.tenantId,
        row.id,
        section.section
      );
      if (count === 0) {
        throw new ConflictException({
          code: errorCode,
          message: `Section "${section.key}" must hold at least one document before "${actionKey}" can run.`,
        });
      }
    }
  }

  /**
   * One row of the acting tenant, or 404. Never a read by id alone.
   *
   * A row of another tenant is INDISTINGUISHABLE from one that does not exist — by
   * design, so the answer cannot confirm that an id exists elsewhere (the brief's §26).
   */
  private async requireRow(tenantId: string, id: string): Promise<CheckRequestRecord> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) {
      throw new NotFoundException('Check request not found.');
    }
    return row;
  }

  /**
   * Asserts the id is a member of the acting tenant, or refuses with a 400 naming the
   * field.
   *
   * WHY 400 AND NOT 403: this is a statement about the PAYLOAD, not about the caller's
   * rights — the caller may hold every permission and still name somebody who is not in
   * their tenant, which is a malformed request in the same class as a missing field.
   *
   * WHY THE ANSWER IS A BOOLEAN AND NOT A DISCLOSURE: `findTenantMember` returns a
   * profile for a member and `null` otherwise, so a probing caller learns "not mine"
   * rather than "belongs to somebody else".
   */
  private async assertTenantMember(tenantId: string, userId: string, field: string): Promise<void> {
    const member = await this.directory.findTenantMember(tenantId, userId);
    if (!member) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.PROJECT_MANAGER_NOT_MEMBER,
        message: `${field} is not a member of this tenant, or does not exist.`,
      });
    }
  }

  /** A typed 409 naming the CURRENT status and the refused operation. */
  private stateConflict(status: number, verb: string): ConflictException {
    return new ConflictException({
      code: CHECK_REQUEST_ERROR_CODES.STATE_CONFLICT,
      message: `This check request is in state ${status} (${checkRequestStatusName(
        status
      )}) and cannot be ${verb} from there.`,
    });
  }

  /**
   * The source's conditional clearing (V7), applied to the facts BEFORE validation and
   * the title — exactly as the source's save script rewrote the controls before saving:
   *
   *   حقوق   → orderReference := null, purchaseType := null, projectReference := null
   *   تنخواه → orderReference := null
   *
   * THE SOURCE DOES NOT CLEAR `projectManagerUserId` FOR حقوق — neither the save script
   * nor the brief's V7 list does — so neither does F1: the field is merely hidden by the
   * source's visibility formula for حقوق, and inventing a fourth cleared field would
   * diverge from both. V5 still cannot demand a manager for حقوق, because V5 is keyed on
   * `purchaseType = PROJECT`, which this clearing just removed.
   */
  private withConditionalClearing(facts: CheckRequestFacts): CheckRequestFacts {
    const next: CheckRequestFacts = { ...facts };

    if (next.checkIssueType === 'SALARY') {
      next.orderReference = null;
      next.purchaseType = null;
      next.projectReference = null;
    } else if (next.checkIssueType === 'PETTY_CASH') {
      next.orderReference = null;
    }

    return next;
  }

  /**
   * The source's save-time validation chain (V1–V5), in the source's own evaluation
   * order, each refusal carrying a typed code whose web mirror renders the source's
   * Persian sentence:
   *
   *   V1  issue type required                  → «نوع صدور چک انتخاب کنید!»
   *   V2  خرید requires a purchase type        → «نوع خرید را انتخاب کنید!»
   *   V3  PROJECT requires a project reference → «عنوان پروژه را انتخاب کنید!»
   *   V4  خرید requires an order reference     → «شناسه شماره سفارش ثبت گردد!»
   *   V5  PROJECT requires a project manager   → «مدیر پروژه انتخاب گردد!»
   *
   * THE ELSE-IF SHAPE IS THE SOURCE'S OWN: V2–V5 chain exactly as the script did, so one
   * save reports the FIRST blocking condition rather than a queue of them. V2–V5 are
   * nested inside `issueType !== SALARY`, the source's own guard — a salary request
   * cannot fail them because its facts were cleared before this runs.
   *
   * NO FINANCIAL RULE BEYOND THESE EXISTS IN THE SOURCE (Preflight §6.2): no uniqueness,
   * no amount rule, no date rule, no budget rule — and none is invented here.
   */
  private assertBusinessRules(facts: CheckRequestFacts): void {
    if (!facts.checkIssueType) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ISSUE_TYPE_REQUIRED,
        message: 'A check issue type is required.',
      });
    }

    if (facts.checkIssueType === 'SALARY') return;

    if (facts.checkIssueType === 'PURCHASE' && !facts.purchaseType) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.PURCHASE_TYPE_REQUIRED,
        message: 'A purchase check request requires a purchase type.',
      });
    }
    if (facts.purchaseType === 'PROJECT' && !facts.projectReference) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.PROJECT_REQUIRED,
        message: 'A project purchase requires a project reference.',
      });
    }
    if (facts.checkIssueType === 'PURCHASE' && !facts.orderReference) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.ORDER_REFERENCE_REQUIRED,
        message: 'A purchase check request requires an order reference.',
      });
    }
    if (facts.purchaseType === 'PROJECT' && !facts.projectManagerUserId) {
      throw new BadRequestException({
        code: CHECK_REQUEST_ERROR_CODES.PROJECT_MANAGER_REQUIRED,
        message: 'A project purchase requires a project manager.',
      });
    }
  }

  /**
   * The timeline projection — an EXPLICIT WHITELIST, so the response exposes exactly
   * the seven fields documented on `CheckRequestTimelineItem` and nothing else the
   * platform item happens to carry.
   *
   * A whitelist rather than a deny-list because the platform projection is a CONTRACT,
   * not a ceiling: the day it adds a field, a spread-through would publish it without
   * this module ever deciding it is safe for this surface. `resource`/`resourceId` are
   * omitted (every entry shares the one server-bound pair the request already
   * established), and every field the contract calls out as absent-by-construction —
   * `tenantId`, `ip`, `userAgent`, `sessionId`, `requestId`, `correlationId`,
   * `oldValue`, `newValue`, `changes` — is not named here at all.
   */
  private static projectTimelineItem(item: {
    id: string;
    action: string;
    actorId: string | null;
    success: boolean;
    reason: string | null;
    changedFields: string[];
    createdAt: string;
  }): CheckRequestTimelineItem {
    return {
      id: item.id,
      action: item.action,
      actorId: item.actorId,
      success: item.success,
      reason: item.reason,
      changedFields: item.changedFields,
      createdAt: item.createdAt,
    };
  }
}
