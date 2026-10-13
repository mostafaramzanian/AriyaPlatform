import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import type { WorkflowVersionStatus } from './workflow-status';
import type {
  WorkflowActorSource,
  WorkflowConditionFalseBehavior,
  WorkflowParallelJoinPolicy,
  WorkflowStepExecutionMode,
  WorkflowTriggerEvent,
} from './workflow-configuration';
import { Prisma } from '../../../generated/commerce-client';
// A VALUE import, not a type-only one: `Prisma.DbNull` is how a JSON column is CLEARED (`null`
// alone would store the JSON document `null`, which is a different stored fact — see `payload`).
// The row types ride along as inline type specifiers, so nothing else about the client is pulled in.
import type {
  WorkflowDefinition,
  WorkflowDefinitionVersion,
  WorkflowStep,
} from '../../../generated/commerce-client';

/**
 * Phase C1 Step M (§5.5–§5.8): the workflow CONFIGURATION persistence boundary — every statement
 * this slice issues against `commerce_db`, and nothing else.
 *
 * WHY NO BUSINESS RULES APPEAR BELOW
 * ---------------------------------
 * This file owns INSERTs, tenant-scoped SELECTs, conditional UPDATEs and one transactional
 * reorder. It does not decide whether a version may be edited, whether a transition is legal,
 * whether a configuration is complete or whether a condition is well formed — those decisions live
 * in `workflow-status.ts`, `workflow-configuration.ts`, `workflow-condition.ts` and
 * `WorkflowConfigurationService`. A repository that refused a status change would be a second
 * place the lifecycle is written down, and the two would disagree the first time one changed.
 *
 * TENANCY
 * -------
 * `tenantId` IS THE FIRST PARAMETER OF EVERY METHOD and appears in every `where`. `findUnique` is
 * never used: it cannot carry a tenant predicate, so a "find by id" written with it would read
 * another tenant's workflow for an id that happened to collide. `findFirst` and `updateMany`/
 * `deleteMany` are used instead — the last two because a conditional write must express "only if
 * it still matches this predicate", and that predicate is what makes two concurrent publishes
 * impossible rather than unlikely (the reasoning `purchase.repository.ts` records for its own
 * conditional writes).
 *
 * WHAT IT DOES NOT TOUCH
 * ----------------------
 * `WorkflowInstance` and `WorkflowStepInstance` do not appear in this file at all: step M
 * configures workflows, and §20's prohibition on execution is enforced by there being no statement
 * in this slice that writes either table. Nor does any statement touch `PurchaseDocument` — a
 * configuration change may not affect a purchase that is already running, which is §5.9's pin
 * expressed as an absence.
 */

/**
 * A JSON payload column as a write states it.
 *
 * `null` IS NOT A PAYLOAD: the schema's note on every one of these columns says NULL means "not
 * configured" ("NULL = unconditional"), which is SQL NULL and NOT the JSON document `null` —
 * Prisma spells the two apart for exactly this reason, so the conversion happens once, in
 * `payload`, and no service has to know that `DbNull` exists.
 */
type WorkflowPayload = Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;

/**
 * A version with its steps in the STATED order — never insertion order (see the schema) — and the
 * code of the definition it belongs to.
 *
 * WHY THE DEFINITION'S CODE IS PART OF THE READ (§10). Publication walks a version's steps through
 * the engine's own validator as the version's ACTIVATION rule set, and that set's identity is
 * `<prefix>.<definitionCode>` (§5.2) — a fact of the DEFINITION, not of the version. Reading it
 * here is what lets the publish gate build the set the runtime would build rather than a set that
 * merely resembles it.
 */
export type WorkflowVersionRow = WorkflowDefinitionVersion & {
  steps: WorkflowStep[];
  definition: { code: string };
};

/**
 * A new version's stated columns (§5.5, §10): its label, and the columns that make it a ROUTABLE
 * object — the trigger that selects it (§2.1), the join policy its parallel groups obey (§3) and
 * the priority/condition of its own candidate rule (§2.3).
 *
 * `null` MEANS "NOT STATED YET", the schema's own meaning for these columns: a DRAFT may be
 * incomplete, and publication is where completeness is required. Nothing here defaults them,
 * because a default would be this file inventing configuration.
 */
export interface WorkflowVersionWrite {
  versionLabel: string;
  triggerEvent: WorkflowTriggerEvent | null;
  parallelJoinPolicy: WorkflowParallelJoinPolicy | null;
  selectionPriority: number | null;
  selectionCondition: unknown;
}

/**
 * One version EDIT's stated columns — the `undefined`/`null` distinction applied to the version
 * itself, exactly as `WorkflowStepPatch` applies it to a step: an omitted column is left alone and
 * `null` clears it. This is how an author sets the join policy after the steps that need one exist,
 * which is the usual order of authoring.
 */
export interface WorkflowVersionPatch {
  triggerEvent?: WorkflowTriggerEvent | null;
  parallelJoinPolicy?: WorkflowParallelJoinPolicy | null;
  selectionPriority?: number | null;
  selectionCondition?: unknown;
}

/** The filter one definition list applies, always inside the acting tenant. */
export interface WorkflowDefinitionFilter {
  search?: string;
}

/**
 * The filter one version list applies inside an already-resolved definition and tenant.
 *
 * PHASE C8 (GAP-5): `search` is the shared query DTO's text filter
 * (`CommercePageQueryDto.search`), and it matches the column that IDENTIFIES a version —
 * its `versionLabel`, the tenant's own label and the natural key `findVersionByLabel`
 * already addresses a version by. Nothing else on the row is text a caller could quote: a
 * trigger, a join policy and a selection condition are configuration, not identifiers.
 *
 * BEFORE C8 the parameter was ACCEPTED by the route's DTO (the shared base) and IGNORED
 * here — the dishonest parameter this module refuses. It is honoured now, on the same
 * column the line-routing list and the completion-policy list match, so every versioned
 * configuration surface answers a `search` the same way.
 */
export interface WorkflowVersionFilter {
  status?: WorkflowVersionStatus;
  search?: string;
}

/**
 * One step's columns as a write states them — the shape the SERVICE has already validated.
 *
 * Every payload is `unknown` because what a payload may contain is `workflow-configuration.ts`'s
 * decision and not this file's: the repository stores what it is given, after the service has
 * established that the value is well formed.
 */
export interface WorkflowStepWrite {
  stepKey: string;
  displayName: string;
  mandatory: boolean;
  executionMode: WorkflowStepExecutionMode;
  ordering: number;
  parallelGroup: string | null;
  condition: unknown;
  /**
   * §4's behaviour when the condition evaluates false — part of the WRITE because publication
   * requires it of every conditional step (`WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING`): a column
   * the API could not state would make a conditional version unpublishable, which is the same
   * defect as a rule that cannot be satisfied.
   */
  onConditionFalse: WorkflowConditionFalseBehavior | null;
  actorSource: WorkflowActorSource | null;
  actorUserId: string | null;
  actorRoleCode: string | null;
  actorRule: unknown;
  thresholds: unknown;
  lineFilters: unknown;
  configuration: unknown;
}

/**
 * One step EDIT's stated columns — `undefined` means "not in this edit", `null` means "clear it".
 *
 * THE TWO KINDS OF ABSENCE ARE THE WHOLE POINT, exactly as in `UpdatePurchaseDocumentDto`:
 * an omitted `stepKey` leaves the stored key alone, while `condition: null` clears a condition the
 * author removed. A shape that collapsed the two into one would erase a threshold on every
 * unrelated edit. The SERVICE resolves the distinction — it reads the row, applies only what was
 * stated, validates the RESULT — and hands the repository this one object rather than a dozen
 * optional parameters, so there is a single place where "what this edit says" is written down.
 *
 * EVERY JSON COLUMN IS `unknown` for the reason `WorkflowStepWrite` records: what a payload may
 * contain is `workflow-configuration.ts`'s decision, and the service has already made it.
 */
export interface WorkflowStepPatch {
  stepKey?: string;
  displayName?: string;
  mandatory?: boolean;
  executionMode?: WorkflowStepExecutionMode;
  ordering?: number;
  parallelGroup?: string | null;
  condition?: unknown;
  onConditionFalse?: WorkflowConditionFalseBehavior | null;
  actorSource?: WorkflowActorSource | null;
  actorUserId?: string | null;
  actorRoleCode?: string | null;
  actorRule?: unknown;
  thresholds?: unknown;
  lineFilters?: unknown;
  configuration?: unknown;
}

@Injectable()
export class WorkflowConfigurationRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  /**
   * The `null`-or-value conversion every JSON column passes through, in ONE place.
   *
   * `undefined` is treated as "not stated" exactly like `null`: Prisma would leave an `undefined`
   * field out of the statement entirely, which is the same stored outcome, and one branch for both
   * means no caller has to remember the difference.
   */
  private static payload(value: unknown): WorkflowPayload {
    if (value === null || value === undefined) {
      return Prisma.DbNull as WorkflowPayload;
    }
    return value as Prisma.InputJsonValue;
  }

  /** A page of definitions carries how many versions each has — the count a list renders. */
  private static readonly DEFINITION_PAGE_SHAPE = {
    _count: { select: { versions: true } },
  } as const;

  /** Steps are read in the version's STATED order, with the id as a tie-break. */
  private static readonly STEP_ORDER = [{ ordering: 'asc' as const }, { id: 'asc' as const }];

  // ---------------------------------------------------------------------------------------
  // DEFINITIONS (§5.5's container: identity only)
  // ---------------------------------------------------------------------------------------

  /** Create the container. The composite unique on (tenant, code) is the second line of defence. */
  async createDefinition(
    tenantId: string,
    input: { code: string; name: string }
  ): Promise<WorkflowDefinition> {
    return this.prisma.workflowDefinition.create({
      data: { tenantId, code: input.code, name: input.name },
    });
  }

  /** One definition by the tenant's own code — the read that decides whether a code is taken. */
  async findDefinitionByCode(tenantId: string, code: string): Promise<WorkflowDefinition | null> {
    return this.prisma.workflowDefinition.findFirst({ where: { tenantId, code } });
  }

  /**
   * One definition, inside the acting tenant, with how many versions it has.
   *
   * THE COUNT IS PART OF THE READ rather than a second call, so a caller cannot render a
   * definition beside a total gathered from a different moment; the include is the same shape the
   * page below uses, which is why it is a named constant rather than a literal in two places.
   */
  async findDefinition(
    tenantId: string,
    definitionId: string
  ): Promise<(WorkflowDefinition & { _count: { versions: number } }) | null> {
    return this.prisma.workflowDefinition.findFirst({
      where: { tenantId, id: definitionId },
      include: WorkflowConfigurationRepository.DEFINITION_PAGE_SHAPE,
    });
  }

  /**
   * One page of the tenant's definitions as `[rows, total]`, newest first.
   *
   * The array-form transaction makes the count and the page two reads of ONE snapshot, so the
   * total cannot describe a different moment than the rows it is rendered with. `id` is the second
   * sort key: two definitions created in the same millisecond would otherwise be ordered
   * differently on two reads, and a paging client would see one of them twice.
   */
  async listDefinitionPage(
    tenantId: string,
    filter: WorkflowDefinitionFilter,
    window: { skip: number; take: number }
  ) {
    const where: Prisma.WorkflowDefinitionWhereInput = {
      tenantId,
      ...(filter.search
        ? {
            OR: [
              { code: { contains: filter.search, mode: 'insensitive' as const } },
              { name: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.workflowDefinition.findMany({
        where,
        include: WorkflowConfigurationRepository.DEFINITION_PAGE_SHAPE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.workflowDefinition.count({ where }),
    ]);
  }

  /** Rename a definition: the label it is shown under, and nothing a version was pinned to. */
  async renameDefinition(tenantId: string, definitionId: string, name: string): Promise<number> {
    const result = await this.prisma.workflowDefinition.updateMany({
      where: { tenantId, id: definitionId },
      data: { name },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------------------
  // VERSIONS (§5.5's lifecycle: DRAFT → VALIDATED → PUBLISHED → ARCHIVED)
  // ---------------------------------------------------------------------------------------

  /**
   * Open a version. Always a DRAFT: the status is stated here rather than left to the column.
   *
   * THE VERSION'S OWN COLUMNS ARE STATED WITH IT (§10): the trigger event that makes the version a
   * candidate (§2.1), and the join policy that says what its parallel groups MEAN (§3). They belong
   * to the version and to nothing inside it — which is why they are columns of this row rather than
   * of a step — and `updateVersion` below is how an author revisits the one that only makes sense
   * after the steps exist.
   */
  async createVersion(
    tenantId: string,
    definitionId: string,
    version: WorkflowVersionWrite
  ): Promise<WorkflowDefinitionVersion> {
    return this.prisma.workflowDefinitionVersion.create({
      data: {
        tenantId,
        workflowDefinitionId: definitionId,
        versionLabel: version.versionLabel,
        status: 'DRAFT',
        triggerEvent: version.triggerEvent,
        parallelJoinPolicy: version.parallelJoinPolicy,
        selectionPriority: version.selectionPriority,
        selectionCondition: WorkflowConfigurationRepository.payload(version.selectionCondition),
      },
    });
  }

  /**
   * Apply one version edit to a row that is still a DRAFT. `0` = the version is no longer editable.
   *
   * THE SAME TWO GUARDS THE STEP EDIT USES, for the same reasons: the `where` carries the tenant
   * AND the DRAFT status, so the statement itself refuses a version whose lifecycle moved on, and
   * the lock taken above it makes that predicate's answer the one a concurrent publish would give.
   * ONLY THE COLUMNS THE CALLER STATED appear in `data` (see `versionData`), so an edit that states
   * a join policy cannot erase a selection condition somebody else just wrote.
   */
  async updateVersion(
    tenantId: string,
    versionId: string,
    patch: WorkflowVersionPatch
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const editable = await WorkflowConfigurationRepository.lockEditableVersion(
        tx,
        tenantId,
        versionId
      );
      if (!editable) return 0;

      const result = await tx.workflowDefinitionVersion.updateMany({
        where: { tenantId, id: versionId, status: 'DRAFT' },
        data: WorkflowConfigurationRepository.versionData(patch),
      });

      return result.count;
    });
  }

  /** One version by the tenant's own label inside a definition — the label-collision read. */
  async findVersionByLabel(
    tenantId: string,
    definitionId: string,
    versionLabel: string
  ): Promise<WorkflowDefinitionVersion | null> {
    return this.prisma.workflowDefinitionVersion.findFirst({
      where: { tenantId, workflowDefinitionId: definitionId, versionLabel },
    });
  }

  /**
   * One version with its steps, in the stated order, and the code of its definition.
   *
   * THE DEFINITION'S CODE RIDES ALONG (§10): the publish gate builds the version's activation rule
   * set, whose identity names the definition (§5.2), so the code is part of reading the version
   * rather than a second query the caller has to remember.
   */
  async findVersion(tenantId: string, versionId: string): Promise<WorkflowVersionRow | null> {
    return this.prisma.workflowDefinitionVersion.findFirst({
      where: { tenantId, id: versionId },
      include: {
        steps: { orderBy: WorkflowConfigurationRepository.STEP_ORDER },
        definition: { select: { code: true } },
      },
    });
  }

  /** One page of a definition's versions as `[rows, total]`, newest first. */
  async listVersionPage(
    tenantId: string,
    definitionId: string,
    filter: WorkflowVersionFilter,
    window: { skip: number; take: number }
  ) {
    const where: Prisma.WorkflowDefinitionVersionWhereInput = {
      tenantId,
      workflowDefinitionId: definitionId,
      ...(filter.status ? { status: filter.status } : {}),
      // PHASE C8 (GAP-5): `versionLabel` only — the identifying column, matched with the
      // module's one text-filter semantics (`contains`, case-insensitive). This `where` is
      // the SAME object handed to the `count` below, so a filtered list's `total` is the
      // filtered total and not the definition's whole version count.
      ...(filter.search
        ? { versionLabel: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.workflowDefinitionVersion.findMany({
        where,
        include: { _count: { select: { steps: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.workflowDefinitionVersion.count({ where }),
    ]);
  }

  /**
   * The ONE statement that walks the lifecycle.
   *
   * `from` IS PART OF THE PREDICATE, which is what makes the transition CONDITIONAL rather than
   * hopeful: two concurrent publishes both read a VALIDATED version, and only the one whose
   * `where` still matches writes a row — the other returns a count of 0 and the service reports
   * the refusal. A read-then-write implementation would let both succeed, producing two publish
   * audits and one `publishedAt`.
   *
   * `publishedAt` is passed ONLY for the publish transition (see the service), and the column is
   * never cleared: the schema keeps the instant a version entered force forever, including after
   * it is archived, because that instant is a historical fact rather than a current flag.
   */
  async transitionVersion(
    tenantId: string,
    versionId: string,
    from: WorkflowVersionStatus,
    to: WorkflowVersionStatus,
    publishedAt: Date | null
  ): Promise<number> {
    const result = await this.prisma.workflowDefinitionVersion.updateMany({
      where: { tenantId, id: versionId, status: from },
      data: {
        status: to,
        ...(publishedAt ? { publishedAt } : {}),
      },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------------------
  // STEPS (§5.6: order, mode, actor and payloads are configuration — and only a DRAFT may state them)
  // ---------------------------------------------------------------------------------------

  /**
   * Take the version's edit lock, if it is still a DRAFT — and leave its clock where it was.
   *
   * WHY A LOCK IS NEEDED AT ALL, when every statement below also carries the version's status.
   * A relation predicate (`version: { status: 'DRAFT' }`) is a SUBQUERY, and under READ COMMITTED
   * it cannot see a concurrent publish that has not committed yet: the step write and the publish
   * would both succeed, and a step would land inside a version that is already immutable. Taking
   * the version row's lock here makes the two acts serialize instead — the publish's own conditional
   * UPDATE waits, and whichever runs second sees the other's outcome.
   *
   * WHY THE CLOCK IS RE-STATED RATHER THAN LEFT TO `@updatedAt`: this statement is a LOCK, not an
   * edit. Letting Prisma stamp `updatedAt` would put a timestamp on a version row that nothing
   * about the version itself changed — the STEP is the edit, and the step row's own `updatedAt` is
   * where that shows. Re-stating the value it already holds writes the row identically and takes
   * the lock, which is exactly what is wanted.
   *
   * `null` MEANS "no longer editable (or not this tenant's version)" and is answered by the caller
   * as a refusal. Returning rather than throwing keeps the refusal a business answer: nothing has
   * been written, so there is no work to roll back.
   */
  private static async lockEditableVersion(
    tx: Prisma.TransactionClient,
    tenantId: string,
    versionId: string
  ): Promise<boolean> {
    const version = await tx.workflowDefinitionVersion.findFirst({
      where: { tenantId, id: versionId, status: 'DRAFT' },
      select: { id: true, updatedAt: true },
    });

    if (version === null) return false;

    const asserted = await tx.workflowDefinitionVersion.updateMany({
      where: { tenantId, id: versionId, status: 'DRAFT' },
      data: { updatedAt: version.updatedAt },
    });

    return asserted.count === 1;
  }

  /**
   * Add one step to a version that is still a DRAFT. `null` = the version is no longer editable.
   *
   * THE LOCK AND THE INSERT ARE ONE TRANSACTION, in that order, so a publish racing this insert
   * either happens before it (and then this refuses) or after it (and then the step is part of what
   * was published). There is no interleaving in which a step joins a published version.
   *
   * The step's columns are written as the service stated them — including the schema's own defaults,
   * which the SERVICE applied rather than the column: a stored row must be readable without knowing
   * what the DDL would have filled in, and the version's `configuration` payload is only complete if
   * every column in it says what the author meant.
   */
  async createStep(
    tenantId: string,
    versionId: string,
    step: WorkflowStepWrite
  ): Promise<WorkflowStep | null> {
    return this.prisma.$transaction(async (tx) => {
      const editable = await WorkflowConfigurationRepository.lockEditableVersion(
        tx,
        tenantId,
        versionId
      );
      if (!editable) return null;

      return tx.workflowStep.create({
        data: {
          tenantId,
          workflowDefinitionVersionId: versionId,
          stepKey: step.stepKey,
          displayName: step.displayName,
          mandatory: step.mandatory,
          executionMode: step.executionMode,
          ordering: step.ordering,
          parallelGroup: step.parallelGroup,
          condition: WorkflowConfigurationRepository.payload(step.condition),
          onConditionFalse: step.onConditionFalse,
          actorSource: step.actorSource,
          actorUserId: step.actorUserId,
          actorRoleCode: step.actorRoleCode,
          actorRule: WorkflowConfigurationRepository.payload(step.actorRule),
          thresholds: WorkflowConfigurationRepository.payload(step.thresholds),
          lineFilters: WorkflowConfigurationRepository.payload(step.lineFilters),
          configuration: WorkflowConfigurationRepository.payload(step.configuration),
        },
      });
    });
  }

  /** One step of one version, inside the acting tenant — the read every step edit starts from. */
  async findStep(
    tenantId: string,
    versionId: string,
    stepId: string
  ): Promise<WorkflowStep | null> {
    return this.prisma.workflowStep.findFirst({
      where: { tenantId, workflowDefinitionVersionId: versionId, id: stepId },
    });
  }

  /**
   * Apply one step edit to a version that is still a DRAFT. `0` = the version is no longer editable.
   *
   * THE EDIT IS CONDITIONAL TWICE, and both halves are load-bearing: the relation predicate in this
   * UPDATE's own `where` refuses a version that is not a DRAFT — read by the statement itself, so a
   * step edit can never land in a version whose lifecycle moved on — and the lock taken above it
   * makes that predicate's answer the same one a concurrent publish would give, because the two acts
   * cannot be in flight at once.
   *
   * ONLY THE COLUMNS THE CALLER STATED appear in `data` (see `stepData`), so an edit that changes a
   * threshold cannot rewrite a step key somebody else just fixed.
   */
  async updateStep(
    tenantId: string,
    versionId: string,
    stepId: string,
    patch: WorkflowStepPatch
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const editable = await WorkflowConfigurationRepository.lockEditableVersion(
        tx,
        tenantId,
        versionId
      );
      if (!editable) return 0;

      const result = await tx.workflowStep.updateMany({
        where: {
          tenantId,
          workflowDefinitionVersionId: versionId,
          id: stepId,
          version: { status: 'DRAFT' },
        },
        data: WorkflowConfigurationRepository.stepData(patch),
      });

      return result.count;
    });
  }

  /**
   * Remove one step from a version that is still a DRAFT. `0` = the version is no longer editable.
   *
   * TWO GUARDS, as above, and a third in the database: the step row is cited by RESTRICT from
   * `WorkflowStepInstance`, so the DAY a published version's steps have runs, deleting one is
   * refused by the foreign key even for a writer that bypassed this class. At DRAFT there are no
   * instances, so the two writes agree — and the application guard is what keeps the refusal a
   * readable 409 rather than a driver error.
   */
  async deleteStep(tenantId: string, versionId: string, stepId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const editable = await WorkflowConfigurationRepository.lockEditableVersion(
        tx,
        tenantId,
        versionId
      );
      if (!editable) return 0;

      const result = await tx.workflowStep.deleteMany({
        where: {
          tenantId,
          workflowDefinitionVersionId: versionId,
          id: stepId,
          version: { status: 'DRAFT' },
        },
      });

      return result.count;
    });
  }

  /**
   * State the version's step order IN FULL, in one transaction. `0` = the version is no longer
   * editable, or the list is not exactly the version's steps.
   *
   * WHY POSITIONS ARE MOVED OUT OF THE WAY FIRST (the lift). The unique index is
   * `(tenantId, version, ordering)` and PostgreSQL checks it ROW BY ROW *during* a statement, so a
   * straight swap of two positions is refused even though the final state is unique — writing
   * position 2 while the other row still holds 2 collides in the middle of the swap, not at the
   * end. Every position is therefore incremented by more than any of them can hold
   * (`max + count`) BEFORE the final positions are written, which leaves the whole target range
   * free; the two phases are one transaction, so no reader — and no failure — can observe the
   * intermediate numbering.
   *
   * WHY THE LIST IS CHECKED BEFORE ANYTHING IS WRITTEN. The check is a PERMUTATION check: the same
   * ids, no repeats, nothing foreign. Returning `0` for a mismatch is only safe *because* it
   * happens before the lift, so the transaction commits nothing; and if the row set turns out not
   * to be the one that was read, the lift is undone by its own compensating statement rather than
   * left behind, so a refusal never renumbers a version.
   */
  async reorderSteps(
    tenantId: string,
    versionId: string,
    order: readonly string[]
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const editable = await WorkflowConfigurationRepository.lockEditableVersion(
        tx,
        tenantId,
        versionId
      );
      if (!editable) return 0;

      const steps = await tx.workflowStep.findMany({
        where: { tenantId, workflowDefinitionVersionId: versionId },
        select: { id: true, ordering: true },
      });

      const stated = new Set(order);
      if (
        steps.length !== order.length ||
        stated.size !== order.length ||
        steps.some((step) => !stated.has(step.id))
      ) {
        return 0;
      }

      const lift =
        steps.reduce((highest, step) => Math.max(highest, step.ordering), 0) + steps.length;

      // A mutable copy: Prisma's `in` accepts `string[]`, and a `readonly` parameter is the honest
      // spelling of "this method does not reorder the caller's array".
      const where = {
        tenantId,
        workflowDefinitionVersionId: versionId,
        id: { in: [...order] },
      };
      const lifted = await tx.workflowStep.updateMany({
        where,
        data: { ordering: { increment: lift } },
      });

      if (lifted.count !== steps.length) {
        // A writer that does not take this lock changed the set under us; put the positions back
        // and refuse, rather than numbering a version whose membership this request never saw.
        await tx.workflowStep.updateMany({ where, data: { ordering: { decrement: lift } } });
        return 0;
      }

      let written = 0;
      for (const [index, stepId] of order.entries()) {
        const positioned = await tx.workflowStep.updateMany({
          where: {
            tenantId,
            workflowDefinitionVersionId: versionId,
            id: stepId,
            version: { status: 'DRAFT' },
          },
          data: { ordering: index + 1 },
        });
        written += positioned.count;
      }

      return written;
    });
  }

  /**
   * The columns one VERSION edit states, and only those — the same `undefined`/`null` distinction
   * `stepData` applies, on the version's own row.
   *
   * `selectionCondition` goes through `payload` for the reason that helper records: a cleared
   * condition is SQL NULL, never the JSON document `null`.
   */
  private static versionData(
    patch: WorkflowVersionPatch
  ): Prisma.WorkflowDefinitionVersionUpdateManyMutationInput {
    return {
      ...(patch.triggerEvent !== undefined ? { triggerEvent: patch.triggerEvent } : {}),
      ...(patch.parallelJoinPolicy !== undefined
        ? { parallelJoinPolicy: patch.parallelJoinPolicy }
        : {}),
      ...(patch.selectionPriority !== undefined
        ? { selectionPriority: patch.selectionPriority }
        : {}),
      ...(patch.selectionCondition !== undefined
        ? {
            selectionCondition: WorkflowConfigurationRepository.payload(patch.selectionCondition),
          }
        : {}),
    };
  }

  /**
   * The columns one edit states, and ONLY those — the `undefined`/`null` distinction applied.
   *
   * Kept beside the update it serves rather than at the top of the class: it is the translation of
   * `WorkflowStepPatch` into a Prisma mutation, and a reader asking "what does an edit write?"
   * should find both halves together. The JSON columns go through `payload` for the reason that
   * helper records: a cleared payload is SQL NULL, never the JSON document `null`.
   */
  private static stepData(patch: WorkflowStepPatch): Prisma.WorkflowStepUpdateManyMutationInput {
    return {
      ...(patch.stepKey !== undefined ? { stepKey: patch.stepKey } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.mandatory !== undefined ? { mandatory: patch.mandatory } : {}),
      ...(patch.executionMode !== undefined ? { executionMode: patch.executionMode } : {}),
      ...(patch.ordering !== undefined ? { ordering: patch.ordering } : {}),
      ...(patch.parallelGroup !== undefined ? { parallelGroup: patch.parallelGroup } : {}),
      ...(patch.condition !== undefined
        ? { condition: WorkflowConfigurationRepository.payload(patch.condition) }
        : {}),
      ...(patch.onConditionFalse !== undefined ? { onConditionFalse: patch.onConditionFalse } : {}),
      ...(patch.actorSource !== undefined ? { actorSource: patch.actorSource } : {}),
      ...(patch.actorUserId !== undefined ? { actorUserId: patch.actorUserId } : {}),
      ...(patch.actorRoleCode !== undefined ? { actorRoleCode: patch.actorRoleCode } : {}),
      ...(patch.actorRule !== undefined
        ? { actorRule: WorkflowConfigurationRepository.payload(patch.actorRule) }
        : {}),
      ...(patch.thresholds !== undefined
        ? { thresholds: WorkflowConfigurationRepository.payload(patch.thresholds) }
        : {}),
      ...(patch.lineFilters !== undefined
        ? { lineFilters: WorkflowConfigurationRepository.payload(patch.lineFilters) }
        : {}),
      ...(patch.configuration !== undefined
        ? { configuration: WorkflowConfigurationRepository.payload(patch.configuration) }
        : {}),
    };
  }
}
