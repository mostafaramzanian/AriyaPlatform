import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { Prisma } from '../../../generated/commerce-client';
// A VALUE import, not a type-only one: `Prisma.DbNull` is how a JSON column records "not
// configured" (`null` alone would store the JSON document `null`, a different stored fact — see
// `payload`). The model and enum types ride along as inline type specifiers, so nothing else about
// the client is pulled in — the same bargain `workflow-configuration.repository.ts` records.
import type {
  PurchaseDocument,
  WorkflowDefinitionVersionStatus,
  WorkflowInstance,
  WorkflowScopeType,
  WorkflowSubjectType,
  WorkflowTriggerEvent,
} from '../../../generated/commerce-client';
import {
  WORKFLOW_STEP_INSTANCE_PENDING,
  type WorkflowInstanceStatus,
  type WorkflowStepDecision,
  type WorkflowStepInstanceStatus,
} from './workflow-run-status';

/**
 * Phase C1 Step N (§8.1, §8.2, §5.9, §5.10, §9.2, §9.3, §11): the workflow EXECUTION
 * persistence boundary — every statement step N issues against `commerce_db`, and nothing
 * else.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * INSERTs and conditional UPDATEs on the two RUNTIME tables this database has —
 * `WorkflowInstance` and `WorkflowStepInstance` — plus the tenant-scoped SELECTs the
 * runtime needs to (a) find the published configurations that may govern a purchase and
 * (b) load the pinned version and its steps. It does NOT decide which configuration
 * applies, whether a step activates, what a join policy means, or whether a run is
 * finished: those are the planner's (`workflow-execution.ts`) and the runtime service's
 * (`workflow-execution.service.ts`) questions, and this file holds none of their answers.
 *
 * WHY EVERY WRITE TAKES A UNIT OF WORK
 * ------------------------------------
 * A submission must never persist `PurchaseDocument = SUBMITTED` with no run, and a
 * decision must never leave the run one step behind the step it just recorded
 * (`commerce-transaction.ts` states the whole argument). That makes every write in this
 * file a candidate for a transaction that spans MORE THAN ONE repository — so the write
 * methods take a `CommerceTransactionHandle` rather than opening their own
 * `$transaction`. The handle is unwrapped here, inside the repository, which is the only
 * place `Prisma.TransactionClient` may be named (`workflow-execution.guards.spec.ts`
 * asserts no service, controller, DTO or pure-runtime file mentions it).
 *
 * HANDLES ON READS, WHEN THE TRANSACTION MATTERS
 * ----------------------------------------------
 * The reads §8.2 and §8.3 perform MID-TRANSACTION — the candidates, the pinned version,
 * the subject document, the run being decided — take an OPTIONAL
 * `CommerceTransactionHandle`, so one method serves both the read outside a transaction
 * and the load inside one: two spellings of "the version being pinned" would be two
 * places the pin's meaning could drift. §11's page deliberately takes NONE — a page must
 * never render uncommitted work — and opens M's own array-form snapshot instead.
 *
 * TENANCY
 * -------
 * `tenantId` IS THE FIRST PARAMETER OF EVERY METHOD and appears in every `where`.
 * `findUnique` is never used: it cannot carry a tenant predicate, so a "find by id"
 * written with it would read another tenant's run for an id that happened to collide.
 * `findFirst` carries the predicate, and `updateMany`/`createMany` express the conditional
 * writes this slice needs — the same discipline `purchase.repository.ts` and
 * `workflow-configuration.repository.ts` record for their own statements.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * -----------------------------------
 * `WorkflowDefinition`, `WorkflowDefinitionVersion` and `WorkflowStep` are READ here and
 * never written: step N executes configuration, it does not author it (§20 — the only
 * writer of those tables is `workflow-configuration.repository.ts`). `PurchaseDocument`
 * appears in exactly ONE statement — the runtime wants to know the document's kind and
 * requester so the plan can join a decision to the right subject — and never as a write:
 * advancing a document's status from a workflow decision is a step the N contract keeps
 * out of this slice (§5.9, §17).
 */

/**
 * One step as the runtime reads it: the columns the planner's `WorkflowStepConfigurationRecord`
 * needs, plus the `id` a step instance must cite (§5.10's "step reference").
 *
 * WHY THIS IS A STRUCTURAL SUBSET RATHER THAN A RE-STATEMENT: `workflow-execution.ts`
 * declares the record it consumes, and the shape below is assignable to it by
 * construction. The repository never imports the planner's TYPE to build a row — the
 * planner owns what it needs, the repository owns what it selects — and the runtime
 * service is the one place the two meet. A change to one that the other cannot satisfy
 * therefore fails to compile at the wiring, not at a database call.
 */
export interface WorkflowStepRuntimeRow {
  readonly id: string;
  readonly stepKey: string;
  readonly displayName: string;
  readonly mandatory: boolean;
  readonly executionMode: 'SEQUENTIAL' | 'PARALLEL' | 'CONDITIONAL';
  readonly ordering: number;
  readonly parallelGroup: string | null;
  readonly condition: unknown;
  readonly onConditionFalse: 'SKIPPED' | 'BLOCKED' | 'TERMINATED' | null;
  readonly actorSource: string | null;
  readonly actorUserId: string | null;
  readonly actorRoleCode: string | null;
  readonly actorRule: unknown;
}

/**
 * One candidate the selection pass reads (§2.2): the version identity, its pinned status,
 * the definition it belongs to and that definition's code — plus the version's join
 * policy, which the runtime needs once the version wins.
 *
 * The steps are NOT loaded here. Selection reads every PUBLISHED version of the tenant to
 * decide between them, and most of those will lose; loading every winner's steps would
 * make a selection pass cost the size of the tenant's whole configuration. The steps of
 * the ONE version that wins are loaded by `loadPinnedVersion`.
 */
export interface WorkflowCandidateRow {
  readonly workflowDefinitionVersionId: string;
  readonly versionLabel: string;
  readonly parallelJoinPolicy: 'ALL' | 'ANY' | null;
  readonly selectionPriority: number | null;
  readonly selectionCondition: unknown;
  readonly workflowDefinitionId: string;
  readonly definitionCode: string;
  readonly definitionName: string;
  readonly triggerKind: string | null;
}

/** A pinned version with its steps, as the runtime runs it. */
export interface WorkflowPinnedVersionRow {
  readonly workflowDefinitionVersionId: string;
  readonly versionLabel: string;
  readonly parallelJoinPolicy: 'ALL' | 'ANY' | null;
  readonly definitionCode: string;
  readonly definitionName: string;
  readonly steps: readonly WorkflowStepRuntimeRow[];
}

/**
 * A JSON payload column as a write states it — the type `workflow-configuration.repository.ts`
 * declares for its own writes, kept identical here because what `NULL` means on these columns is
 * not this repository's to redefine.
 */
type WorkflowPayload = Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;

/**
 * The delegates a workflow READ reaches for, as BOTH clients spell them: the service's own client,
 * and the client a unit of work hands out. Naming the shared subset is what lets ONE read method
 * serve §11's page and §8.2/§8.3's in-transaction loads instead of existing twice.
 */
type WorkflowReadClient = Pick<
  Prisma.TransactionClient,
  'purchaseDocument' | 'workflowDefinitionVersion' | 'workflowInstance' | 'workflowStepInstance'
>;

/**
 * `WorkflowDefinitionVersionStatus.PUBLISHED`, typed rather than spelled inline: §2.2 selects among
 * PUBLISHED versions only, and typing the literal against the schema's own enum is what turns a
 * renamed member into a compile error here instead of an empty candidate list at runtime.
 */
const WORKFLOW_CANDIDATE_VERSION_STATUS: WorkflowDefinitionVersionStatus = 'PUBLISHED';

/** §9.1: N writes PURCHASE_DOCUMENT; O extends to PURCHASE_LINE. */
const WORKFLOW_PURCHASE_DOCUMENT_SUBJECT_TYPE: WorkflowSubjectType = 'PURCHASE_DOCUMENT';

/** §9.1/§14.2: N writes DOCUMENT scope; O writes LINE scope. */
const WORKFLOW_DOCUMENT_SCOPE_TYPE: WorkflowScopeType = 'DOCUMENT';

/** The status a new run is created in — and the only one a decision or a cancellation may leave. */
const WORKFLOW_INSTANCE_RUNNING: WorkflowInstanceStatus = 'RUNNING';

/** `WorkflowStepInstanceStatus.SKIPPED`, typed for the same reason `PENDING` is (see above). */
const WORKFLOW_STEP_INSTANCE_SKIPPED: WorkflowStepInstanceStatus = 'SKIPPED';

/** The step columns the planner's `WorkflowStepConfigurationRecord` consumes — one shape, reused. */
const WORKFLOW_STEP_RUNTIME_SHAPE = {
  id: true,
  stepKey: true,
  displayName: true,
  mandatory: true,
  executionMode: true,
  ordering: true,
  parallelGroup: true,
  condition: true,
  onConditionFalse: true,
  actorSource: true,
  actorUserId: true,
  actorRoleCode: true,
  actorRule: true,
} as const;

/** Steps are read in the version's STATED order, with `id` as a tie-break (§5.6) — never by insert. */
const WORKFLOW_STEP_ORDER: Prisma.WorkflowStepOrderByWithRelationInput[] = [
  { ordering: 'asc' },
  { id: 'asc' },
];

/**
 * Step INSTANCES are read in the order the run CREATED them — that is what makes §11's view read
 * like the story of the run — with `id` breaking ties so two steps born in the same millisecond
 * keep one order across reads and pages. Declared as its own typed mutable array, like
 * `WORKFLOW_STEP_ORDER` above: an `orderBy` written inline inside an `as const` include would be
 * `readonly`, and Prisma's include type takes a mutable array.
 */
const WORKFLOW_STEP_INSTANCE_ORDER: Prisma.WorkflowStepInstanceOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

/**
 * What §11's detail read returns: the run, the version it pinned (with the definition that version
 * belongs to) and every step instance with the configured step it ran — decisions and condition
 * outcomes exactly as PERSISTED, never recomputed on read (§5.7: an explanation rendered next year
 * must be the one that actually ran, which is why the input snapshot travels with the outcome).
 *
 * The configuration's rule-bearing columns (`thresholds`, `lineFilters`, `configuration`) are
 * deliberately NOT selected: a step instance's history is this run's, and re-reading today's
 * thresholds beside yesterday's decision would invite a reader to recompute one from the other.
 */
const WORKFLOW_INSTANCE_DETAIL_INCLUDE = {
  version: {
    select: {
      versionLabel: true,
      parallelJoinPolicy: true,
      definition: { select: { code: true, name: true } },
    },
  },
  steps: {
    orderBy: WORKFLOW_STEP_INSTANCE_ORDER,
    select: {
      id: true,
      workflowStepId: true,
      scopeType: true,
      scopeId: true,
      status: true,
      resolvedApproverId: true,
      decision: true,
      decisionComment: true,
      decidedAt: true,
      conditionResult: true,
      conditionInputSnapshot: true,
      conditionRuleSetId: true,
      conditionRuleVersion: true,
      createdAt: true,
      updatedAt: true,
      stepDefinition: {
        select: {
          stepKey: true,
          displayName: true,
          executionMode: true,
          ordering: true,
          mandatory: true,
          onConditionFalse: true,
        },
      },
    },
  },
} as const;

/** One row of §11's detail read, as the statement above returns it. */
export type WorkflowInstanceDetailRow = Prisma.WorkflowInstanceGetPayload<{
  include: typeof WORKFLOW_INSTANCE_DETAIL_INCLUDE;
}>;

/** One step instance the planner has decided a run must hold (§9.1) — an activation or a skip. */
export interface WorkflowStepActivationInput {
  readonly workflowInstanceId: string;
  /** The configured step this instance runs — §5.10's "step reference", FK-checked with the tenant. */
  readonly workflowStepId: string;
  /** What the step decides about: the document, always, in N (§9.1; LINE scope is refused, §14.2). */
  readonly scopeId: string;
  /** `PENDING` when the step is active now; `SKIPPED` when its own condition said so (§9.2). */
  readonly status: WorkflowStepInstanceStatus;
  /** WHO it resolved to (§5.10) — the planner's resolution, not re-derived here. */
  readonly resolvedApproverId: string | null;
  /** The outcome the engine produced; `null` means the step had NO condition (§5.7), not `false`. */
  readonly conditionResult: boolean | null;
  /** The inputs the engine evaluated against — persisted so an explanation is never recomputed. */
  readonly conditionInputSnapshot?: unknown;
  readonly conditionRuleSetId?: string | null;
  readonly conditionRuleVersion?: string | null;
}

/**
 * One decision being recorded (§8.3): the decision, the words it was given in, and the moment.
 *
 * THE DECIDER IS NOT A FIELD. A step instance has no "decided by" column — its
 * `resolvedApproverId` IS the person the step resolved to, and §8.3 makes "the actor is that
 * person" the planner's verification, performed BEFORE this write is reached. Asking for the
 * actor here as well would put a second definition of "who may decide" in the repository.
 */
export interface WorkflowStepDecisionInput {
  readonly instanceId: string;
  readonly stepInstanceId: string;
  readonly decision: WorkflowStepDecision;
  readonly comment: string | null;
  readonly decidedAt: Date;
}

/** The filter §11's page applies, always inside the acting tenant. */
export interface WorkflowInstanceFilter {
  readonly status?: WorkflowInstanceStatus;
  readonly subjectId?: string;
  /** "my open work": runs holding a PENDING step resolved to this actor — §11's operational read. */
  readonly approverId?: string;
}

/**
 * The statuses a run may be SETTLED into: the terminal ones, and only those. A settle that asked
 * for `RUNNING` would be a write that pretends to end a run while leaving it open, so the domain
 * vocabulary itself — not a runtime check — is what refuses it.
 */
export type WorkflowSettlementStatus = Exclude<WorkflowInstanceStatus, 'RUNNING'>;

/**
 * What §11's page returns per run: the run, the version it pinned (and the definition behind it),
 * and its step instances as PERSISTED. The list deliberately reads the steps too — an operator's
 * "what is waiting on me" cannot be answered by a run row alone — but only the columns a list
 * renders, never the condition snapshot the DETAIL read carries for explanations.
 */
const WORKFLOW_INSTANCE_LIST_INCLUDE = {
  version: {
    select: {
      versionLabel: true,
      parallelJoinPolicy: true,
      definition: { select: { code: true, name: true } },
    },
  },
  steps: {
    orderBy: WORKFLOW_STEP_INSTANCE_ORDER,
    select: {
      id: true,
      workflowStepId: true,
      status: true,
      resolvedApproverId: true,
      decision: true,
      decidedAt: true,
      stepDefinition: { select: { stepKey: true, displayName: true, ordering: true } },
    },
  },
} as const;

/** One row of §11's page, as the statement above returns it. */
export type WorkflowInstanceListRow = Prisma.WorkflowInstanceGetPayload<{
  include: typeof WORKFLOW_INSTANCE_LIST_INCLUDE;
}>;

/** One page as `[rows, total]` — the shape `workflow-configuration.repository.ts` pages in. */
export type WorkflowInstancePage = [rows: WorkflowInstanceListRow[], total: number];

/**
 * PHASE C2 (GAP-1b): what the inbox's workflow half returns per row — the step itself
 * (selected columns only), the run it belongs to and the configured step it ran.
 */
const WORKFLOW_PENDING_STEP_INCLUDE = {
  instance: {
    select: { id: true, subjectType: true, subjectId: true, status: true },
  },
  stepDefinition: { select: { stepKey: true, displayName: true, ordering: true } },
} as const;

/** One inbox row, as the statement below returns it. */
export type PendingWorkflowStepRow = Prisma.WorkflowStepInstanceGetPayload<{
  include: typeof WORKFLOW_PENDING_STEP_INCLUDE;
}>;

/** One inbox page as `[rows, total]` — the array form this repository pages in. */
export type PendingWorkflowStepPage = [rows: PendingWorkflowStepRow[], total: number];

@Injectable()
export class WorkflowExecutionRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * The `null`-or-value conversion every JSON column passes through, in ONE place — M's rule, kept
   * identical on purpose: `NULL` on these columns means "not configured / not recorded", never the
   * JSON document `null`, and a second spelling of that rule is how two repositories begin to
   * disagree about what a stored `null` says.
   */
  private static payload(value: unknown): WorkflowPayload {
    if (value === null || value === undefined) {
      return Prisma.DbNull as WorkflowPayload;
    }
    return value as Prisma.InputJsonValue;
  }

  /**
   * WHICH CLIENT A READ RUNS ON.
   *
   * A page or a detail view reads through the service's own client — one snapshot, no transaction
   * to open. The SAME reads are needed INSIDE §8.2's submit and §8.3's decision work, where they
   * must see the transaction's own uncommitted writes: the candidate list must not be gathered
   * from a moment before the document was marked submitted, and the instance load must not race
   * the decision being recorded. So the reads take an OPTIONAL handle rather than existing twice —
   * and the handle is unwrapped here, which keeps `Prisma.TransactionClient` inside the repository
   * boundary (the source-scan guard asserts no service, controller, DTO or pure-runtime file
   * mentions it, this unwrapper, or `CommerceUnitOfWork`).
   */
  private static reader(
    source: CommercePrismaService | CommerceTransactionHandle
  ): WorkflowReadClient {
    return source instanceof CommercePrismaService ? source : unwrapCommerceTransaction(source);
  }

  // ---------------------------------------------------------------------------------------
  // SELECTION (§2.2–§2.6) and the PIN (§5.9): what a submission may choose, and what it chose
  // ---------------------------------------------------------------------------------------

  /**
   * The candidate list of §2.2, read INSIDE §8.2's transaction when a handle is handed over.
   *
   * WHAT THE PREDICATE IS: PUBLISHED status and the trigger event, scoped to the tenant — §2.2's
   * two conditions, and nothing else. It does NOT order-and-pick, does not read
   * `selection_priority` as a decision and never evaluates `selection_condition`: which candidates
   * MATCH, which one WINS and whether a tie is ambiguous is Rule Engine work (§2.3–§2.5), and a
   * repository that pre-filtered would be a second — silently diverging — answer to "may this
   * version be selected".
   *
   * WHY THE ORDER IS STILL STATED: readers and specs must see ONE deterministic order, so
   * priority descending with `NULL` LAST is asked for — the stored spelling of §2.6's "absent
   * reads as 0, the LOWEST". `id` breaks ties, so two versions of equal priority never swap
   * between two reads of the same moment.
   */
  async findSelectionCandidates(
    tenantId: string,
    triggerEvent: WorkflowTriggerEvent,
    tx?: CommerceTransactionHandle
  ): Promise<readonly WorkflowCandidateRow[]> {
    const rows = await WorkflowExecutionRepository.reader(
      tx ?? this.prisma
    ).workflowDefinitionVersion.findMany({
      where: { tenantId, status: WORKFLOW_CANDIDATE_VERSION_STATUS, triggerEvent },
      orderBy: [{ selectionPriority: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      select: {
        id: true,
        versionLabel: true,
        parallelJoinPolicy: true,
        selectionPriority: true,
        selectionCondition: true,
        workflowDefinitionId: true,
        triggerEvent: true,
        definition: { select: { code: true, name: true } },
      },
    });

    return rows.map((row) => ({
      workflowDefinitionVersionId: row.id,
      versionLabel: row.versionLabel,
      parallelJoinPolicy: row.parallelJoinPolicy,
      selectionPriority: row.selectionPriority,
      selectionCondition: row.selectionCondition,
      workflowDefinitionId: row.workflowDefinitionId,
      definitionCode: row.definition.code,
      definitionName: row.definition.name,
      triggerKind: row.triggerEvent,
    }));
  }

  /**
   * §5.9's PIN, read back: one version with its definition and its steps in the STATED order.
   *
   * `findFirst` carrying `id` AND `tenantId`, never `findUnique`: the unique constraint is the
   * COMPOSITE (tenant, id), so a tenant-less lookup cannot express the predicate this slice needs
   * — the reasoning `workflow-configuration.repository.ts` records for its own reads.
   *
   * THE STEPS COME WITH THE VERSION rather than in a second call: a run is planned from one
   * configuration, and a version whose steps were read a moment apart from its own join policy
   * could plan a group that never existed. A version that is not there answers `null` — whether
   * that is "an unknown pin" or "another tenant's" is the caller's question, not this statement's.
   */
  async findPinnedVersion(
    tenantId: string,
    versionId: string,
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowPinnedVersionRow | null> {
    const row = await WorkflowExecutionRepository.reader(
      tx ?? this.prisma
    ).workflowDefinitionVersion.findFirst({
      where: { tenantId, id: versionId },
      select: {
        id: true,
        versionLabel: true,
        parallelJoinPolicy: true,
        definition: { select: { code: true, name: true } },
        steps: { orderBy: WORKFLOW_STEP_ORDER, select: WORKFLOW_STEP_RUNTIME_SHAPE },
      },
    });

    if (!row) {
      return null;
    }

    return {
      workflowDefinitionVersionId: row.id,
      versionLabel: row.versionLabel,
      parallelJoinPolicy: row.parallelJoinPolicy,
      definitionCode: row.definition.code,
      definitionName: row.definition.name,
      steps: row.steps,
    };
  }

  /**
   * The document a run is about: the facts a condition evaluates, and the subject a decision is
   * joined back to (§8.2, §8.3).
   *
   * THE WHOLE ROW IS RETURNED, ON PURPOSE. Which columns a RULE may name is `workflow-facts.ts`'s
   * decision — it owns the catalogue and declares each fact with a type — so a `select` here would
   * be this repository deciding the fact set, and the two would drift the first time a fact was
   * added. Nothing is interpreted on the way out either: the row goes back as stored, and the
   * service is the only place that knows which columns a condition asked for.
   */
  async findSubjectDocument(
    tenantId: string,
    documentId: string,
    tx?: CommerceTransactionHandle
  ): Promise<PurchaseDocument | null> {
    return WorkflowExecutionRepository.reader(tx ?? this.prisma).purchaseDocument.findFirst({
      where: { tenantId, id: documentId },
    });
  }

  // ---------------------------------------------------------------------------------------
  // RUNS (§11): the page an operator reads, and the load §8.3 decides from
  // ---------------------------------------------------------------------------------------

  /**
   * ONE load serves §8.3's decision and §11's detail view: the run, the version it pinned, and
   * every step instance with the step it ran — as PERSISTED, never recomputed (§5.7).
   *
   * It takes the unit of work's handle when §8.3 calls it: the decision is planned from the state
   * the transaction is about to write against, and a run loaded from OUTSIDE the transaction could
   * be a moment the transaction is not — the step being decided might already hold a decision by
   * the time the write lands, which is exactly what the conditional statement then reports.
   */
  /**
   * §9.1's pinned version for an O line route: the version MUST be published, because a
   * routing configuration may only point at versions the tenant has already put in force.
   */
  async findPublishedVersion(
    tenantId: string,
    versionId: string,
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowPinnedVersionRow | null> {
    const row = await WorkflowExecutionRepository.reader(
      tx ?? this.prisma
    ).workflowDefinitionVersion.findFirst({
      where: { tenantId, id: versionId, status: 'PUBLISHED' },
      select: {
        id: true,
        versionLabel: true,
        parallelJoinPolicy: true,
        definition: { select: { code: true, name: true } },
        steps: { orderBy: WORKFLOW_STEP_ORDER, select: WORKFLOW_STEP_RUNTIME_SHAPE },
      },
    });

    if (!row) {
      return null;
    }

    return {
      workflowDefinitionVersionId: row.id,
      versionLabel: row.versionLabel,
      parallelJoinPolicy: row.parallelJoinPolicy,
      definitionCode: row.definition.code,
      definitionName: row.definition.name,
      steps: row.steps,
    };
  }

  async findInstanceDetail(
    tenantId: string,
    instanceId: string,
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowInstanceDetailRow | null> {
    return WorkflowExecutionRepository.reader(tx ?? this.prisma).workflowInstance.findFirst({
      where: { tenantId, id: instanceId },
      include: WORKFLOW_INSTANCE_DETAIL_INCLUDE,
    });
  }

  /**
   * One page of the tenant's runs as `[rows, total]`, most recently touched first — §11's list.
   *
   * NO HANDLE IS TAKEN, deliberately: §8.2 and §8.3 never page, and a page composed from inside a
   * running transaction would show uncommitted work as if it were history. The array-form
   * transaction is M's own pattern, and it is here for M's own reason: the count and the page are
   * two reads of ONE snapshot, so the total cannot describe a different moment than the rows it is
   * rendered with. `id` is the second sort key so two runs touched in the same millisecond do not
   * swap places between pages and make a paging client see one of them twice.
   *
   * A SUBJECT FILTER NAMES ITS TYPE TOO. `subjectId` alone would be ambiguous the day a second
   * subject type exists; stating PURCHASE_DOCUMENT beside it is what keeps this read's meaning the
   * same after that day.
   */
  async listInstancePage(
    tenantId: string,
    filter: WorkflowInstanceFilter,
    window: { skip: number; take: number }
  ): Promise<WorkflowInstancePage> {
    const where: Prisma.WorkflowInstanceWhereInput = {
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.subjectId
        ? { subjectType: WORKFLOW_PURCHASE_DOCUMENT_SUBJECT_TYPE, subjectId: filter.subjectId }
        : {}),
      ...(filter.approverId
        ? {
            steps: {
              some: {
                resolvedApproverId: filter.approverId,
                status: WORKFLOW_STEP_INSTANCE_PENDING,
              },
            },
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.workflowInstance.findMany({
        where,
        include: WORKFLOW_INSTANCE_LIST_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.workflowInstance.count({ where }),
    ]);
  }

  // ---------------------------------------------------------------------------------------
  // PHASE C2 (GAP-1b): the STEP-level "waiting on me" read the inbox answers with.
  //
  // WHY A SECOND QUERY WHEN `listInstancePage` ALREADY FILTERS BY APPROVER. That one pages
  // RUNS ("which documents involve me"); the inbox asks a different question — WHICH STEPS
  // owe ME a decision — and a run page cannot answer it (one run holds several steps, and a
  // run-level `skip` does not page a step-level list). This statement is step-level, newest
  // first, bounded by `take`, and answers from the composite index the schema already has:
  // `[tenantId, resolvedApproverId, status]` — no index is added for it.
  //
  // ELIGIBILITY IS THE DOMAIN'S, NOT THIS FILE'S. `PENDING` + `resolvedApproverId` + a
  // `RUNNING` run is exactly the state `planWorkflowStepDecision` accepts before it decides
  // anything (the step-instance rows are only ever created for an ACTIVATED group, so a
  // pending row implies its group is active). The same predicates the DECIDE route enforces
  // are the predicates this read selects — one definition, two surfaces.
  // ---------------------------------------------------------------------------------------

  /**
   * The inbox's workflow half: the steps of THIS tenant that resolve to THIS user and owe
   * a decision, on a run that is still running.
   *
   * `tenantId` first (every public method, every `where`), `findMany` + `count` in ONE
   * array-form transaction so `total` cannot describe a different moment than the rows it
   * is rendered with — the snapshot discipline §11's page already established for this
   * repository. No handle is taken: a page composed inside a running transaction would
   * show uncommitted work as if it were history.
   */
  async listPendingStepPage(
    tenantId: string,
    approverId: string,
    window: { take: number }
  ): Promise<PendingWorkflowStepPage> {
    const where = {
      tenantId,
      resolvedApproverId: approverId,
      status: WORKFLOW_STEP_INSTANCE_PENDING,
      // The relation's field name on `WorkflowStepInstance` is `instance` (the schema's
      // own naming) — a to-one relation filter, so the run's RUNNING state is part of the
      // same statement, not a post-filter.
      instance: { status: WORKFLOW_INSTANCE_RUNNING },
    } satisfies Prisma.WorkflowStepInstanceWhereInput;

    return this.prisma.$transaction([
      this.prisma.workflowStepInstance.findMany({
        where,
        include: WORKFLOW_PENDING_STEP_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: window.take,
      }),
      this.prisma.workflowStepInstance.count({ where }),
    ]);
  }

  // ---------------------------------------------------------------------------------------
  // WRITES (§8.2, §8.3, §9.1–§9.3): every one of them runs on the unit of work's handle
  //
  // The handle is the SECOND parameter, after the tenant: §15 fixes `tenantId` as the first
  // parameter of every public repository method, and a write that took the transaction before
  // the tenant would be the one place that rule bent for a reason nobody could name.
  // ---------------------------------------------------------------------------------------

  /**
   * §9.1's first write: the run itself — RUNNING from birth, pinned to the version selection chose,
   * about the document the submission was for.
   *
   * The status is STATED rather than left to the column default, like every other write in this
   * slice: a default is a fact about the schema, and a reader of this statement must not have to
   * open the schema to learn what a fresh run is.
   */
  async findInstanceBySubject(
    tenantId: string,
    subjectType: WorkflowSubjectType,
    subjectId: string,
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowInstance | null> {
    return WorkflowExecutionRepository.reader(tx ?? this.prisma).workflowInstance.findFirst({
      where: { tenantId, subjectType, subjectId },
    });
  }

  /**
   * EVERY line workflow instance of the given lines — step P's `ALL_LINES` projection
   * read (§3-F).
   *
   * A document with two hundred lines would otherwise ask two hundred times from ONE
   * recompute, and each ask is a statement about a row the same transaction may just
   * have settled. The subject ids are the line ids the caller already read from its own
   * document, so this never searches by a predicate the caller did not state, and the
   * empty list short-circuits before it builds a statement that would match every line
   * in the tenant.
   *
   * A line with NO instance contributes no row — deliberately. §3-F requires that "a
   * document with no routed lines never satisfies" `ALL_LINES`, and the projection
   * decides that from the COUNT it was given, not from this method omitting anything.
   */
  async listInstancesBySubjects(
    tenantId: string,
    subjectType: WorkflowSubjectType,
    subjectIds: readonly string[],
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowInstance[]> {
    if (subjectIds.length === 0) return [];
    return WorkflowExecutionRepository.reader(tx ?? this.prisma).workflowInstance.findMany({
      where: { tenantId, subjectType, subjectId: { in: [...subjectIds] } },
      orderBy: { subjectId: 'asc' },
    });
  }

  async createInstance(
    tenantId: string,
    tx: CommerceTransactionHandle,
    input: {
      workflowDefinitionVersionId: string;
      subjectId: string;
      subjectType?: WorkflowSubjectType;
    }
  ): Promise<WorkflowInstance> {
    return unwrapCommerceTransaction(tx).workflowInstance.create({
      data: {
        tenantId,
        workflowDefinitionVersionId: input.workflowDefinitionVersionId,
        subjectType: input.subjectType ?? WORKFLOW_PURCHASE_DOCUMENT_SUBJECT_TYPE,
        subjectId: input.subjectId,
        status: WORKFLOW_INSTANCE_RUNNING,
      },
    });
  }

  /**
   * §9.1's second write: the step instances the plan ACTIVATED, plus the ones it SKIPPED at birth —
   * a false condition whose behaviour is SKIPPED is a persisted outcome, not an absent row, because
   * §5.7 keeps `false` and "no condition" apart and only a row can carry that difference.
   *
   * ONE `createMany`: a parallel group is created as one act, and a partially created group is a
   * state no reader should ever observe. The count, not the rows, is returned — nothing downstream
   * needs the ids, and the number is what lets a spec assert that an empty activation list wrote
   * nothing at all.
   */
  async createStepInstances(
    tenantId: string,
    tx: CommerceTransactionHandle,
    inputs: readonly WorkflowStepActivationInput[],
    scopeType: WorkflowScopeType = WORKFLOW_DOCUMENT_SCOPE_TYPE
  ): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }

    const result = await unwrapCommerceTransaction(tx).workflowStepInstance.createMany({
      data: inputs.map((input) => ({
        tenantId,
        workflowInstanceId: input.workflowInstanceId,
        workflowStepId: input.workflowStepId,
        scopeType,
        scopeId: input.scopeId,
        status: input.status,
        resolvedApproverId: input.resolvedApproverId,
        conditionResult: input.conditionResult,
        conditionInputSnapshot: WorkflowExecutionRepository.payload(input.conditionInputSnapshot),
        conditionRuleSetId: input.conditionRuleSetId ?? null,
        conditionRuleVersion: input.conditionRuleVersion ?? null,
      })),
    });

    return result.count;
  }

  /**
   * §8.3's decision write, CONDITIONAL on the step still being `PENDING`.
   *
   * THE COUNT IS THE ANSWER: `1` recorded, `0` someone else got there first — and `0` must be
   * treated as a conflict by the caller, never as success, because the difference between "I
   * decided" and "I was the second person to decide" is the whole point of the predicate (the same
   * contract `purchase.repository.ts` records for its own conditional writes).
   *
   * WHAT IS NOT IN THE PREDICATE, AND WHY. The actor is not: §8.3 verifies "the actor is the
   * resolved approver" BEFORE this call, and a second copy of that rule here would be a rule two
   * places could change. The comment is not trimmed either — its column is the schema's statement
   * about how much may be said, and a repository that truncated a refusal reason would be editing
   * the record of why.
   *
   * `status` moves WITH the decision, in the same statement: a step whose decision is recorded but
   * whose status still reads `PENDING` would be offered to the next reader as open work (§5.10
   * makes the status the step's lifecycle position, and a decision IS a position).
   */
  async recordStepDecision(
    tenantId: string,
    tx: CommerceTransactionHandle,
    input: WorkflowStepDecisionInput
  ): Promise<number> {
    const result = await unwrapCommerceTransaction(tx).workflowStepInstance.updateMany({
      where: {
        tenantId,
        id: input.stepInstanceId,
        workflowInstanceId: input.instanceId,
        status: WORKFLOW_STEP_INSTANCE_PENDING,
      },
      data: {
        status: input.decision,
        decision: input.decision,
        decisionComment: input.comment,
        decidedAt: input.decidedAt,
      },
    });

    return result.count;
  }

  /**
   * The steps a plan says will NOT be decided: the siblings a settled group or a refusal leaves
   * behind, and every `PENDING` step of a cancelled run (§9.3, §11).
   *
   * CONDITIONAL on `PENDING` for the reason the decision write is: a step that already holds a
   * decision is HISTORY, and a terminal status is never overwritten by a later one. An empty list
   * writes nothing rather than issuing a statement that can only match zero rows.
   */
  async skipPendingStepInstances(
    tenantId: string,
    tx: CommerceTransactionHandle,
    input: { instanceId: string; stepInstanceIds: readonly string[] }
  ): Promise<number> {
    if (input.stepInstanceIds.length === 0) {
      return 0;
    }

    const result = await unwrapCommerceTransaction(tx).workflowStepInstance.updateMany({
      where: {
        tenantId,
        workflowInstanceId: input.instanceId,
        id: { in: [...input.stepInstanceIds] },
        status: WORKFLOW_STEP_INSTANCE_PENDING,
      },
      data: { status: WORKFLOW_STEP_INSTANCE_SKIPPED },
    });

    return result.count;
  }

  /**
   * THE ONE WRITE THAT ENDS A RUN: its status, conditional on the run still being `RUNNING`.
   *
   * §9.3 and §11 both arrive here — a completed workflow settles APPROVED, a refusal settles
   * REJECTED, and a cancellation settles CANCELLED — because there is exactly one question ("what
   * is this run now?") and one place it is answered. The predicate is what makes termination
   * once-only: two racing settlements cannot both report success, and the loser is told the
   * conflict instead of being allowed to rewrite a finished run's outcome.
   *
   * `WORKFLOW_INSTANCE_RUNNING` is not an acceptable argument — `WorkflowSettlementStatus` excludes
   * it, so "settle this run back to RUNNING" is a compile error rather than a silent no-op.
   */
  async settleInstance(
    tenantId: string,
    tx: CommerceTransactionHandle,
    input: { instanceId: string; status: WorkflowSettlementStatus }
  ): Promise<number> {
    const result = await unwrapCommerceTransaction(tx).workflowInstance.updateMany({
      where: { tenantId, id: input.instanceId, status: WORKFLOW_INSTANCE_RUNNING },
      data: { status: input.status },
    });

    return result.count;
  }
}
