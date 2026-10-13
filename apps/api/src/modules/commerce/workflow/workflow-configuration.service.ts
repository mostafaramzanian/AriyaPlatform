import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { CommerceIdentityGateway } from '../commerce-identity.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import {
  WORKFLOW_ACTOR_SOURCE_PARAMETERS,
  WORKFLOW_MAX_DEFINITION_CODE_LENGTH,
  WORKFLOW_MAX_DEFINITION_NAME_LENGTH,
  WORKFLOW_MAX_VERSION_LABEL_LENGTH,
  validateWorkflowVersionConfiguration,
} from './workflow-configuration';
import type {
  WorkflowActorSource,
  WorkflowConditionFalseBehavior,
  WorkflowConfigurationFacts,
  WorkflowConfigurationLevel,
  WorkflowConfigurationRefusal,
  WorkflowConfigurationReport,
  WorkflowParallelJoinPolicy,
  WorkflowStepConfigurationShape,
  WorkflowStepExecutionMode,
  WorkflowTriggerEvent,
  WorkflowVersionConfigurationShape,
} from './workflow-configuration';
import { describeWorkflowConditionIssues, findUnsafeWorkflowPayload } from './workflow-condition';
import { describeWorkflowRuleSetFindings } from './workflow-execution';
import { WorkflowConfigurationRepository } from './workflow-configuration.repository';
import type {
  WorkflowStepPatch,
  WorkflowStepWrite,
  WorkflowVersionPatch,
  WorkflowVersionRow,
  WorkflowVersionWrite,
} from './workflow-configuration.repository';
import {
  isWorkflowVersionEditable,
  isWorkflowVersionTransitionAllowed,
  workflowVersionSourcesFor,
} from './workflow-status';
import type { WorkflowVersionStatus } from './workflow-status';
import type {
  CreateWorkflowDefinitionDto,
  CreateWorkflowStepDto,
  CreateWorkflowVersionDto,
  ListWorkflowDefinitionsQueryDto,
  ListWorkflowVersionsQueryDto,
  ReorderWorkflowStepsDto,
  RenameWorkflowDefinitionDto,
  UpdateWorkflowStepDto,
  UpdateWorkflowVersionDto,
} from './workflow-configuration.dto';

/**
 * Phase C1 Step M (§5.5–§5.9, §6, §8, §11): the workflow CONFIGURATION application surface —
 * definitions, their versions, and the steps inside a DRAFT version.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT MUST NEVER OWE
 * -----------------------------------------------
 * It owns ORCHESTRATION: it translates DTOs into the shapes the pure modules judge, asks those
 * modules whether an act is allowed, walks the version lifecycle through ONE conditional write
 * per transition, verifies the one Core identity a step may name, and records the ONE platform
 * trail. It issues NO raw Prisma queries and holds no client — persistence is
 * `WorkflowConfigurationRepository`'s, which is what keeps the tenant predicate, the edit lock
 * and the conditional status writes in a single reviewable file.
 *
 * IT DECIDES NO RULE. "Is this step well formed?", "may a version be edited?", "may a DRAFT be
 * published?" and "is this condition tree well formed?" are answered by `workflow-status.ts`,
 * `workflow-configuration.ts` and `workflow-condition.ts` — the same modules a spec can call
 * without a database. A service that re-stated one of those rules would be the second place it
 * is written down, and the first time the two disagreed a stored version would be governed by
 * whichever one a caller happened to reach.
 *
 * NO EXECUTION, DELIBERATELY (§20). Nothing below creates a `WorkflowInstance`, resolves an
 * approver at decision time or evaluates a condition: M configures, N runs. A configuration
 * change also touches no `PurchaseDocument` (§5.9) — a purchase started under a version keeps
 * that version, which is what makes a configuration edit safe to make while purchases are
 * running.
 *
 * THE VALIDATION LEVEL IS CHOSEN BY THE ACT, NOT BY THE CALLER
 * ----------------------------------------------------------
 * Authoring writes are checked at `DRAFT` (a version may legitimately be incomplete while it is
 * being built), and the two lifecycle acts that make a claim about completeness are checked at
 * `PUBLISH`: `/validate` records "this body passed the check" and `/publish` adds "and it is
 * routable". Both reads are of the SAME walk — `validateWorkflowVersionConfiguration` — so a
 * version cannot pass one and fail the other for a reason that belongs to the shared rules.
 *
 * ONE TRAIL, AND ONLY AFTER A WRITE SUCCEEDED. Every mutation records through
 * `CommerceAuditGateway` with the row the repository RETURNED, never the intent that produced
 * it; no notification is emitted, because nothing outside this bounded context acts on a
 * configuration change yet (§I9's stream begins with execution, step N) and an event nobody
 * consumes is a payload with no reader.
 */

/**
 * The audit `action` values this slice records.
 *
 * Lowercase verbs, like `HR_AUDIT_ACTION` and `PURCHASE_AUDIT_ACTION`: the platform trail is
 * queried by `(resource, action)`, and the two resources below already say WHICH row the act
 * addressed — so a `create` on `commerce.workflow_definition` and a `create` on
 * `commerce.workflow_definition_version` are two distinguishable rows rather than two spellings
 * of one verb. Every step act is audited against the VERSION's resource, because a step has no
 * life of its own outside the version that states it (the schema's own cascade).
 */
export const WORKFLOW_AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE_VERSION: 'update_version',
  RENAME: 'rename',
  VALIDATE: 'validate',
  PUBLISH: 'publish',
  ARCHIVE: 'archive',
  ADD_STEP: 'add_step',
  UPDATE_STEP: 'update_step',
  DELETE_STEP: 'delete_step',
  REORDER_STEPS: 'reorder_steps',
} as const;

/** One definition as the repository returns it; the version COUNT is a separate column group. */
type DefinitionRecord = NonNullable<
  Awaited<ReturnType<WorkflowConfigurationRepository['findDefinition']>>
>;

/** One version WITH its steps, in the stated order — what every step edit starts from. */
type VersionRecord = WorkflowVersionRow;

/** One step row. */
type StepRecord = VersionRecord['steps'][number];

/**
 * The three wire projections, stated as types and produced by exactly three serializers.
 *
 * THEY ARE TYPES AND NOT NARROWER PRETENCES: `tenantId` is on every one of these rows (the
 * repository's first predicate), and the purchase slice's rule is that it never reaches a response
 * body — a row is scoped BY a tenant, and echoing the scope back would put the one field the caller
 * never sent into the payload it receives. Stating the shape here also makes the wire a decision of
 * this file, so a column added to the schema does not silently appear on a route.
 *
 * EXPORTED so the controller's inferred signatures can name them: the alternative — the controller
 * re-declaring a projection — is the second statement of one wire shape, and the two would drift
 * silently because nothing compares them.
 */
export interface WorkflowDefinitionView {
  id: string;
  code: string;
  name: string;
  versionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A version's own columns, as a list row states them. */
export interface WorkflowVersionSummary {
  id: string;
  workflowDefinitionId: string;
  versionLabel: string;
  status: WorkflowVersionStatus;
  /**
   * The version's own ROUTING columns: §2.1's trigger, §3's join policy and §2.3's
   * priority/condition. They are on the wire because §10's publication rules are ABOUT them — an
   * administrator refused with `WORKFLOW_TRIGGER_MISSING` must be able to see that the column is
   * empty, and a client that authored a value must be able to read it back.
   */
  triggerEvent: WorkflowTriggerEvent | null;
  parallelJoinPolicy: WorkflowParallelJoinPolicy | null;
  selectionPriority: number | null;
  selectionCondition: unknown;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A version WITH its steps, in the stated order — what a detail read answers with. */
export interface WorkflowVersionView extends WorkflowVersionSummary {
  steps: WorkflowStepView[];
}

/** One step's configuration, without the tenant that scopes it or the version that owns it. */
export interface WorkflowStepView {
  id: string;
  stepKey: string;
  displayName: string;
  mandatory: boolean;
  executionMode: WorkflowStepExecutionMode;
  ordering: number;
  parallelGroup: string | null;
  condition: unknown;
  /**
   * §4's false-path behaviour: on the wire because it is a SETTING an administrator states and,
   * from step N, one publication REQUIRES of a conditional step (§10). `null` reads as "not
   * stated", which is exactly what the publish rule refuses — so a client must see it.
   */
  onConditionFalse: WorkflowConditionFalseBehavior | null;
  actorSource: WorkflowActorSource | null;
  actorUserId: string | null;
  actorRoleCode: string | null;
  actorRule: unknown;
  thresholds: unknown;
  lineFilters: unknown;
  configuration: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Phase C1 Step M's application surface: definitions, their versions, and the steps a DRAFT
 * states. Every method takes the actor FIRST and scopes its work with `actor.tenantId` — the
 * tenant is read from `resolveCommerceActor(req)` at the boundary and appears on no route.
 */
@Injectable()
export class WorkflowConfigurationService {
  /**
   * The three borrowed walks, supplied to the validator exactly as `workflow-configuration.ts`
   * requires them — INJECTED there rather than imported, and produced from ONE place here.
   * A second implementation of any of them would be a second answer to "is this tree well formed?",
   * "is this payload safe?" or "would the engine accept these sets?" (§9/§31: one rule engine, and
   * no second notion of unsafe).
   *
   * `ruleSetIssues` IS THE ENGINE'S OWN VERDICT (§10's last two rows), reached through the planner
   * because that is where the two rule sets — the version's candidate rule and its per-step
   * activation rules — are already built the way the runtime builds them. Publication therefore
   * asks the same validator the runtime acts on, which is what makes "publishable" and "evaluable"
   * one claim instead of two.
   */
  private static readonly FACTS: WorkflowConfigurationFacts = {
    conditionIssues: describeWorkflowConditionIssues,
    unsafePayload: findUnsafeWorkflowPayload,
    ruleSetIssues: describeWorkflowRuleSetFindings,
  };

  /**
   * The two refusals that describe a COLLISION with what the version already states rather than a
   * malformed value, and are answered `409`: the request is well formed, and the rows it addresses
   * are already numbered or named by it. Everything else the walk reports is a bad BODY and is
   * answered `400` (see `refuse`). Typed as the pure vocabulary's own union, so a code that left
   * that vocabulary fails to compile HERE rather than silently becoming a 400.
   */
  private static readonly CONFLICT_REFUSALS: ReadonlySet<WorkflowConfigurationRefusal> = new Set([
    'STEP_KEY_DUPLICATED',
    'STEP_ORDERING_DUPLICATED',
  ]);

  /** The level an AUTHORING write is checked at: a DRAFT may legitimately be incomplete. */
  private static readonly AUTHORING_LEVEL: WorkflowConfigurationLevel = 'DRAFT';

  /** The level the two lifecycle acts are checked at: completeness, which is routability. */
  private static readonly PUBLICATION_LEVEL: WorkflowConfigurationLevel = 'PUBLISH';

  constructor(
    private readonly repository: WorkflowConfigurationRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly identity: CommerceIdentityGateway
  ) {}

  // ---------------------------------------------------------------------------------------
  // DEFINITIONS (§5.5's container: an identity and a name, and no rules inside it)
  // ---------------------------------------------------------------------------------------

  /**
   * Create the container. The tenant's code is a LABEL (§5.5), so it is trimmed and bounded
   * against the column's own width — never against a shape this slice would be inventing.
   *
   * The duplicate check is a READ and the unique index is the GUARANTEE, exactly as in the
   * purchase slice: the read turns the ordinary case into a 409 that names the code, and the
   * index still refuses the one-in-a-thousand race the read cannot see.
   */
  async createDefinition(actor: CommerceActor, dto: CreateWorkflowDefinitionDto) {
    const code = dto.code.trim();
    const name = dto.name.trim();
    WorkflowConfigurationService.assertBoundedText(
      'code',
      code,
      WORKFLOW_MAX_DEFINITION_CODE_LENGTH
    );
    WorkflowConfigurationService.assertBoundedText(
      'name',
      name,
      WORKFLOW_MAX_DEFINITION_NAME_LENGTH
    );

    const existing = await this.repository.findDefinitionByCode(actor.tenantId, code);
    if (existing) {
      throw new ConflictException(`A workflow definition already uses the code "${code}".`);
    }

    const row = await this.repository.createDefinition(actor.tenantId, { code, name });

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION,
      resourceId: row.id,
      newValue: row,
    });

    return WorkflowConfigurationService.serializeDefinition(row);
  }

  /**
   * One page of the tenant's definitions (§8's list), newest first, each carrying its version
   * COUNT — the number the list renders beside a definition. The count is read in the same
   * snapshot as the row, so a definition cannot be shown beside a total from another moment.
   *
   * The window is resolved HERE as well as bounded in the DTO: an internal caller that builds a
   * query object without validation cannot exceed `COMMERCE_MAX_PAGE_SIZE` either.
   */
  async listDefinitions(actor: CommerceActor, query: ListWorkflowDefinitionsQueryDto) {
    const window = resolveCommercePageWindow(query);

    const [rows, total] = await this.repository.listDefinitionPage(
      actor.tenantId,
      { search: query.search },
      window
    );

    return {
      items: rows.map((row) => WorkflowConfigurationService.serializeDefinition(row)),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /** One definition with its version count; 404 rather than an empty answer when it is absent. */
  async getDefinition(actor: CommerceActor, definitionId: string): Promise<WorkflowDefinitionView> {
    const row = await this.repository.findDefinition(actor.tenantId, definitionId);
    if (!row) throw new NotFoundException('Workflow definition not found.');
    return WorkflowConfigurationService.serializeDefinition(row);
  }

  /**
   * Rename the container (§6: "workflow name" is configuration an administrator states).
   *
   * A RENAME MOVES NO CONTENT, so it opens no version and is checked by no validator: the name is
   * not part of what governs a purchase. It is audited against the DEFINITION row, because an
   * operator asking "who named this?" is asking about the container — `create` and `rename` on
   * `commerce.workflow_definition` answer that, kept apart from every version act.
   */
  async renameDefinition(
    actor: CommerceActor,
    definitionId: string,
    dto: RenameWorkflowDefinitionDto
  ): Promise<WorkflowDefinitionView> {
    const before = await this.getDefinition(actor, definitionId);
    const name = dto.name.trim();
    WorkflowConfigurationService.assertBoundedText(
      'name',
      name,
      WORKFLOW_MAX_DEFINITION_NAME_LENGTH
    );

    const changed = await this.repository.renameDefinition(actor.tenantId, definitionId, name);
    if (changed === 0) {
      // The row was read a moment ago and this update matched nothing: it is gone, not renamed.
      throw new NotFoundException('Workflow definition not found.');
    }

    const after = await this.getDefinition(actor, definitionId);

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.RENAME,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION,
      resourceId: after.id,
      oldValue: { name: before.name },
      newValue: { name: after.name },
      changedFields: ['name'],
    });

    return after;
  }

  // ---------------------------------------------------------------------------------------
  // VERSIONS (§5.5's lifecycle: DRAFT → VALIDATED → PUBLISHED → ARCHIVED)
  // ---------------------------------------------------------------------------------------

  /**
   * Open a version of a definition. ALWAYS A DRAFT: no field here could say otherwise, because
   * the two acts that make a claim about completeness are the routes that own them.
   *
   * The definition must exist IN THE ACTING TENANT before a version may open under it — a version
   * whose container the caller cannot see is not a version either, and reading the container
   * first is what keeps a foreign definition id from becoming a row.
   *
   * THE ROUTING COLUMNS ARE THE CALLER'S TO STATE HERE OR LATER (§10): a trigger can be named as
   * the version opens, while a JOIN POLICY usually cannot be — it says what a group of `PARALLEL`
   * branches means, and the branches are authored after the version exists. Whatever is stated is
   * stored as stated; whatever is absent is `null`, the schema's own "not configured yet", and
   * completeness is publication's question rather than this route's.
   */
  async createVersion(actor: CommerceActor, definitionId: string, dto: CreateWorkflowVersionDto) {
    await this.getDefinition(actor, definitionId);

    const versionLabel = dto.versionLabel.trim();
    WorkflowConfigurationService.assertBoundedText(
      'versionLabel',
      versionLabel,
      WORKFLOW_MAX_VERSION_LABEL_LENGTH
    );

    const existing = await this.repository.findVersionByLabel(
      actor.tenantId,
      definitionId,
      versionLabel
    );
    if (existing) {
      throw new ConflictException(
        `This definition already has a version labelled "${versionLabel}".`
      );
    }

    const write = WorkflowConfigurationService.toVersionWrite(dto, versionLabel);
    const row = await this.repository.createVersion(actor.tenantId, definitionId, write);

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.CREATE,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: row.id,
      newValue: row,
    });

    return WorkflowConfigurationService.serializeVersion(row);
  }

  /**
   * Change the version's own ROUTING columns while it is still a DRAFT (§10).
   *
   * WHY THIS ROUTE EXISTS. `triggerEvent` can be stated when the version is opened, but the JOIN
   * POLICY cannot sensibly be: it says what a group of `PARALLEL` branches means, and the branches
   * are authored after the version exists. Without this act an author would have to recreate a
   * version — losing every step — to answer a question their own steps posed.
   *
   * NO WALK RUNS HERE, and that is deliberate. The version's routing columns are read by the walk
   * at `PUBLISH`, where incompleteness is the point of the check; at `DRAFT` level a missing
   * trigger or join policy is legal by definition (§10's two rules are publication rules), and a
   * walk here could only ever refuse a `selectionCondition` the engine would reject — which is
   * exactly what `validateVersion` is for. What this method DOES enforce is the lifecycle: the
   * read-time guard refuses a version that is not a DRAFT, and the repository's conditional write
   * refuses one whose status left DRAFT under it.
   *
   * `undefined` MEANS "NOT STATED" AND `null` MEANS "CLEAR IT", resolved in `toVersionPatch` with
   * the same `!== undefined` test the step edit uses, so an edit that states a join policy cannot
   * erase a selection condition somebody else just wrote.
   */
  async updateVersion(
    actor: CommerceActor,
    versionId: string,
    dto: UpdateWorkflowVersionDto
  ): Promise<WorkflowVersionView> {
    const before = await this.loadEditableVersion(actor.tenantId, versionId);

    const patch = WorkflowConfigurationService.toVersionPatch(dto);
    const changed = await this.repository.updateVersion(actor.tenantId, versionId, patch);
    if (changed === 0) throw WorkflowConfigurationService.lostEdit();

    const after = await this.loadVersion(actor.tenantId, versionId);

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.UPDATE_VERSION,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: versionId,
      oldValue: WorkflowConfigurationService.routingOf(before),
      newValue: WorkflowConfigurationService.routingOf(after),
      changedFields: Object.keys(patch),
    });

    return WorkflowConfigurationService.serializeVersionDetail(after);
  }

  /**
   * One page of a definition's versions, newest first, optionally narrowed to one status.
   *
   * `status` filters WITHIN the definition and the acting tenant — neither is a field of the
   * query, so no shape of this request widens the scope. Each row carries its step COUNT, read in
   * the same snapshot as the row itself.
   */
  async listVersions(
    actor: CommerceActor,
    definitionId: string,
    query: ListWorkflowVersionsQueryDto
  ) {
    await this.getDefinition(actor, definitionId);

    const window = resolveCommercePageWindow(query);
    const [rows, total] = await this.repository.listVersionPage(
      actor.tenantId,
      definitionId,
      // PHASE C8 (GAP-5): the shared `search` filter is forwarded unchanged. It narrows
      // the version list by `versionLabel` inside this already tenant- and
      // definition-scoped read, so it cannot widen either scope — and the repository cuts
      // the rows and the `total` with the same predicate.
      { status: query.status, search: query.search },
      window
    );

    return {
      items: rows.map((row) => ({
        ...WorkflowConfigurationService.serializeVersion(row),
        stepCount: row._count.steps,
      })),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /**
   * One version WITH its steps, in the stated order.
   *
   * The steps are a part of the read rather than a second call, because the order they arrive in
   * IS configuration (§5.6's `ordering` is stated and uniqueness-checked, never implied), and two
   * calls could answer with a membership and an order taken from different moments.
   */
  async getVersion(actor: CommerceActor, versionId: string): Promise<WorkflowVersionView> {
    const version = await this.loadVersion(actor.tenantId, versionId);
    return WorkflowConfigurationService.serializeVersionDetail(version);
  }

  /**
   * The check that ACCEPTS a complete configuration: DRAFT → VALIDATED.
   *
   * THE BODY IS CHECKED AT `PUBLISH` LEVEL, not at `DRAFT`, and that is the whole point of the
   * act: this route is where the version CLAIMS to be complete, so it is checked against the same
   * rules publication will apply. A version that passed here cannot then fail `/publish` for a
   * reason that belongs to the shared walk — only for its lifecycle state, which is a different
   * answer about a different fact.
   *
   * A REFUSAL WRITES NOTHING: the version stays a DRAFT, no audit row is recorded, and the report
   * names each defect with its step key, so an administrator (who configures this without a
   * deployment, §6) can fix the body and call again.
   */
  async validateVersion(actor: CommerceActor, versionId: string): Promise<WorkflowVersionView> {
    const version = await this.loadVersion(actor.tenantId, versionId);
    WorkflowConfigurationService.assertTransitionAllowed(version, 'VALIDATED', 'validated');

    const report = WorkflowConfigurationService.inspect(
      version,
      WorkflowConfigurationService.PUBLICATION_LEVEL
    );
    if (!report.valid) throw WorkflowConfigurationService.refuse(report);

    const changed = await this.repository.transitionVersion(
      actor.tenantId,
      versionId,
      version.status,
      'VALIDATED',
      null
    );
    if (changed === 0) throw WorkflowConfigurationService.lostRace();

    return this.afterTransition(actor, versionId, WORKFLOW_AUDIT_ACTION.VALIDATE, version);
  }

  /**
   * Put a version in force: VALIDATED → PUBLISHED, and the instant is recorded.
   *
   * `publishedAt` IS STATED HERE, ONCE, from the clock this act reads — never at validation, and
   * never re-stated later: the schema keeps that instant forever, including after the version is
   * archived, because "when did this govern purchases?" is a historical question.
   *
   * THE WALK RUNS AGAIN before the transition, from the same facts: a VALIDATED version is
   * immutable, so the second walk should reach the same verdict — and if it does not, the row was
   * changed by something that bypassed this service, which is exactly the data defect the refusal
   * (with its report) makes visible instead of publishing it.
   */
  async publishVersion(actor: CommerceActor, versionId: string): Promise<WorkflowVersionView> {
    const version = await this.loadVersion(actor.tenantId, versionId);
    WorkflowConfigurationService.assertTransitionAllowed(version, 'PUBLISHED', 'published');

    const report = WorkflowConfigurationService.inspect(
      version,
      WorkflowConfigurationService.PUBLICATION_LEVEL
    );
    if (!report.valid) throw WorkflowConfigurationService.refuse(report);

    const publishedAt = new Date();
    const changed = await this.repository.transitionVersion(
      actor.tenantId,
      versionId,
      version.status,
      'PUBLISHED',
      publishedAt
    );
    if (changed === 0) throw WorkflowConfigurationService.lostRace();

    return this.afterTransition(actor, versionId, WORKFLOW_AUDIT_ACTION.PUBLISH, version);
  }

  /**
   * Withdraw a version that was in force: PUBLISHED → ARCHIVED.
   *
   * THE ONLY WAY OUT OF `PUBLISHED`, and there is no way back in (the transition table's
   * `ARCHIVED: []`): an archived version is the evidence of what governed a purchase under it, so
   * reviving it would rewrite that history. A change to the configuration is a NEW version (§6).
   *
   * `publishedAt` IS NOT CLEARED — the repository's conditional write adds it only when one is
   * passed, and none is passed here, because the instant a version entered force stays true after
   * it leaves force.
   */
  async archiveVersion(actor: CommerceActor, versionId: string): Promise<WorkflowVersionView> {
    const version = await this.loadVersion(actor.tenantId, versionId);
    WorkflowConfigurationService.assertTransitionAllowed(version, 'ARCHIVED', 'archived');

    const changed = await this.repository.transitionVersion(
      actor.tenantId,
      versionId,
      version.status,
      'ARCHIVED',
      null
    );
    if (changed === 0) throw WorkflowConfigurationService.lostRace();

    return this.afterTransition(actor, versionId, WORKFLOW_AUDIT_ACTION.ARCHIVE, version);
  }

  /**
   * Record ONE lifecycle act and answer with the row the act produced.
   *
   * THE TRAIL IS WRITTEN FROM THE RE-READ ROW, never from the status this method expected to
   * write: the conditional UPDATE decided the outcome, and an audit row that repeated the caller's
   * intent would be a record of what was asked for rather than of what happened. A transition
   * changes no step, so the second read is the SAME row in its new state — and it is read BEFORE
   * the audit is written, so a refused transition (which throws above) leaves no trail behind.
   */
  private async afterTransition(
    actor: CommerceActor,
    versionId: string,
    action: string,
    before: VersionRecord
  ): Promise<WorkflowVersionView> {
    const after = await this.loadVersion(actor.tenantId, versionId);

    await this.audit.record(actor, {
      action,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: after.id,
      oldValue: { status: before.status, publishedAt: before.publishedAt },
      newValue: { status: after.status, publishedAt: after.publishedAt },
      changedFields: ['status'],
    });

    return WorkflowConfigurationService.serializeVersionDetail(after);
  }

  // ---------------------------------------------------------------------------------------
  // STEPS (§5.6–§5.8: order, mode, actor and payloads — and only a DRAFT may state them)
  // ---------------------------------------------------------------------------------------

  /**
   * Add one step to a DRAFT version.
   *
   * THE CANDIDATE LIST IS VALIDATED, NOT THE NEW ROW. `workflow-configuration.ts` judges a
   * VERSION: duplicate keys, duplicate orderings and the count itself are facts about the SET, so
   * the walk receives the version's steps with this one added, in the order the version states.
   * Validating the write alone would accept a step whose key an earlier step already uses, and the
   * unique index would then answer a client mistake with a driver error instead of a report.
   *
   * THE WRITE IS CONDITIONAL, AND SO IS THE LOCK BENEATH IT: the repository refuses a version
   * whose status left DRAFT between this read and the insert, so a publish that wins the race
   * cannot leave a step inside an immutable version.
   */
  async addStep(
    actor: CommerceActor,
    versionId: string,
    dto: CreateWorkflowStepDto
  ): Promise<WorkflowStepView> {
    const version = await this.loadEditableVersion(actor.tenantId, versionId);

    const write = WorkflowConfigurationService.toWrite(dto);
    const report = WorkflowConfigurationService.inspectCandidates(
      version,
      [
        ...version.steps.map((step) => WorkflowConfigurationService.shapeOfStored(step)),
        WorkflowConfigurationService.shapeOfWrite(write),
      ],
      WorkflowConfigurationService.AUTHORING_LEVEL
    );
    if (!report.valid) throw WorkflowConfigurationService.refuse(report);

    await this.assertConfiguredActorMember(actor, write.actorSource, write.actorUserId);

    const row = await this.repository.createStep(actor.tenantId, versionId, write);
    if (!row) throw WorkflowConfigurationService.lostEdit();

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.ADD_STEP,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: versionId,
      newValue: row,
    });

    return WorkflowConfigurationService.serializeStep(row);
  }

  /**
   * The ONE Core identity a step may name, checked against the ACTING TENANT when the step's
   * source is `CONFIGURED_USER`.
   *
   * WHICH PARAMETER CARRIES THAT ID IS READ FROM `WORKFLOW_ACTOR_SOURCE_PARAMETERS`, never
   * re-typed: the map is the pure module's statement of the pairing, and a second copy here would
   * be the place the two drift. Any other source returns early — a role code is Core's fact (§7)
   * and a rule resolver's approver is decided at decision time, by the engine, in step N.
   */
  private async assertConfiguredActorMember(
    actor: CommerceActor,
    source: WorkflowActorSource | null,
    userId: string | null
  ): Promise<void> {
    if (!source) return;
    if (WORKFLOW_ACTOR_SOURCE_PARAMETERS[source] !== 'actorUserId') return;
    await this.identity.assertMember(actor, userId);
  }

  /**
   * Change one step of a DRAFT version.
   *
   * `undefined` MEANS "NOT STATED IN THIS EDIT" AND `null` MEANS "CLEAR IT", and the resolution
   * happens HERE, not in the DTO: the stored row is read, the stated columns are applied over it,
   * and the RESULT is what the walk judges. Judging the patch alone would judge a step that does
   * not exist — `{ executionMode: 'CONDITIONAL' }` beside a stored step with no condition is
   * malformed, while `{ condition: {...} }` on its own is not, and only the merged row tells the
   * two apart.
   *
   * THE CANDIDATE SET IS THE VERSION WITH THIS STEP REPLACED, so a key or an ordering the edit
   * would collide with is refused by the walk — with the coordinate of the row it collided with —
   * rather than by the unique index afterwards.
   */
  async updateStep(
    actor: CommerceActor,
    versionId: string,
    stepId: string,
    dto: UpdateWorkflowStepDto
  ): Promise<WorkflowStepView> {
    const version = await this.loadEditableVersion(actor.tenantId, versionId);
    const stored = await this.loadStep(actor.tenantId, versionId, stepId);

    const patch = WorkflowConfigurationService.toPatch(dto);
    const projected = WorkflowConfigurationService.project(stored, patch);

    const report = WorkflowConfigurationService.inspectCandidates(
      version,
      version.steps.map((step) =>
        step.id === stepId
          ? WorkflowConfigurationService.shapeOfWrite(projected)
          : WorkflowConfigurationService.shapeOfStored(step)
      ),
      WorkflowConfigurationService.AUTHORING_LEVEL
    );
    if (!report.valid) throw WorkflowConfigurationService.refuse(report);

    await this.assertConfiguredActorMember(actor, projected.actorSource, projected.actorUserId);

    const changed = await this.repository.updateStep(actor.tenantId, versionId, stepId, patch);
    if (changed === 0) throw WorkflowConfigurationService.lostEdit();

    // The row the repository RETURNED is the audited one — re-read, because the conditional update
    // answers with a count. `null` here means the step was removed in the same instant, which is a
    // different act racing this one and never a silent success.
    const updated = await this.repository.findStep(actor.tenantId, versionId, stepId);
    if (!updated) {
      throw new ConflictException(
        'The step disappeared while this edit was being applied; read the version again.'
      );
    }

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.UPDATE_STEP,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: versionId,
      oldValue: stored,
      newValue: updated,
      changedFields: Object.keys(patch),
    });

    return WorkflowConfigurationService.serializeStep(updated);
  }

  /**
   * Remove one step from a DRAFT version.
   *
   * NO WALK RUNS: deleting a step cannot make the REMAINING ones malformed — no key, ordering,
   * mode, actor or payload of theirs changes — and a version left with no steps is a legal DRAFT,
   * because the count is judged at validation, where it means something. A walk here would refuse
   * a deletion for a defect that already exists and that the author may be mid-way through
   * repairing.
   *
   * The audit keeps the DELETED row as `oldValue` and names the VERSION: a step has no life of its
   * own outside the version that states it, and once this returns the trail is the only place the
   * deleted configuration can still be read.
   */
  async deleteStep(
    actor: CommerceActor,
    versionId: string,
    stepId: string
  ): Promise<{ deleted: true; stepId: string }> {
    await this.loadEditableVersion(actor.tenantId, versionId);
    const stored = await this.loadStep(actor.tenantId, versionId, stepId);

    const removed = await this.repository.deleteStep(actor.tenantId, versionId, stepId);
    if (removed === 0) throw WorkflowConfigurationService.lostEdit();

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.DELETE_STEP,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: versionId,
      oldValue: stored,
      changedFields: ['stepKey', 'ordering'],
    });

    return { deleted: true, stepId };
  }

  /**
   * State the version's step order IN FULL (§5.6): every step the version currently holds, in the
   * order it should now execute. A swap is expressible in ONE request — which is the reason the
   * wire shape is a list and not a position per step (see `ReorderWorkflowStepsDto`).
   *
   * THE PERMUTATION IS CHECKED HERE *AND* IN THE REPOSITORY'S TRANSACTION, and both checks are
   * load-bearing: only this one can tell the caller WHAT was wrong (an omitted, repeated or
   * foreign id is a 400, not a silent no-op), and only the transaction can tell whether the set is
   * STILL the one this read saw. A mismatch there is a refusal with nothing written — the lift is
   * undone by its own compensating statement — so a lost race never renumbers a version.
   *
   * NO WALK RUNS: a position is configuration (§5.6's `ordering`), but moving rows changes no key,
   * mode, actor or payload, and per-version uniqueness is restated, as a whole, by the write.
   */
  async reorderSteps(
    actor: CommerceActor,
    versionId: string,
    dto: ReorderWorkflowStepsDto
  ): Promise<WorkflowVersionView> {
    const version = await this.loadEditableVersion(actor.tenantId, versionId);

    const stated = new Set(dto.order);
    const current = new Set(version.steps.map((step) => step.id));
    if (
      dto.order.length !== version.steps.length ||
      stated.size !== dto.order.length ||
      dto.order.some((stepId) => !current.has(stepId))
    ) {
      throw new BadRequestException(
        'The stated order must name every step of this version exactly once; read the version again.'
      );
    }

    const written = await this.repository.reorderSteps(actor.tenantId, versionId, dto.order);
    if (written !== dto.order.length) throw WorkflowConfigurationService.lostEdit();

    const after = await this.loadVersion(actor.tenantId, versionId);

    await this.audit.record(actor, {
      action: WORKFLOW_AUDIT_ACTION.REORDER_STEPS,
      resource: COMMERCE_AUDIT_RESOURCE.WORKFLOW_DEFINITION_VERSION,
      resourceId: versionId,
      oldValue: { order: version.steps.map((step) => step.id) },
      newValue: { order: after.steps.map((step) => step.id) },
      changedFields: ['ordering'],
    });

    return WorkflowConfigurationService.serializeVersionDetail(after);
  }

  // ---------------------------------------------------------------------------------------
  // PRIVATE HELPERS (the translations and the refusals, each in exactly one place)
  // ---------------------------------------------------------------------------------------

  /**
   * One version of the acting tenant, or 404.
   *
   * TENANCY IS A PREDICATE, NOT A CHECK: the read is `(tenantId, id)`, so a version that exists in
   * another tenant is absent rather than forbidden — the caller learns nothing about rows it may
   * not see. Every act below starts here, which is what makes "no route reaches a row it did not
   * scope" a property of one method.
   */
  private async loadVersion(tenantId: string, versionId: string): Promise<VersionRecord> {
    const version = await this.repository.findVersion(tenantId, versionId);
    if (!version) throw new NotFoundException('Workflow version not found.');
    return version;
  }

  /**
   * One version that may still be EDITED, or a refusal naming what it is instead.
   *
   * THIS IS THE READ-TIME HALF of the edit guard, and it is deliberately the pure module's
   * `isWorkflowVersionEditable` rather than a comparison against a literal: the same function the
   * spec can call without a database decides whether content may change, and the halves cannot
   * drift. The WRITE-time half is the repository's conditional statement, which is what survives a
   * race the read cannot see (§6's "a published version is immutable", enforced twice).
   */
  private async loadEditableVersion(tenantId: string, versionId: string): Promise<VersionRecord> {
    const version = await this.loadVersion(tenantId, versionId);
    if (!isWorkflowVersionEditable(version.status)) {
      throw new ConflictException(
        `A version's content may change only while it is a DRAFT; this version is ${version.status}.`
      );
    }
    return version;
  }

  /** One step of that version, or 404 — a step outside its version is not addressable at all. */
  private async loadStep(tenantId: string, versionId: string, stepId: string): Promise<StepRecord> {
    const step = await this.repository.findStep(tenantId, versionId, stepId);
    if (!step) throw new NotFoundException('Workflow step not found.');
    return step;
  }

  /**
   * Whether the lifecycle permits this act, from THIS row's status.
   *
   * THE TABLE IS ASKED, NOT RE-STATED: `isWorkflowVersionTransitionAllowed` answers `false` for a
   * move the lifecycle forbids and `null` for a status that is not part of the vocabulary at all —
   * and the two are answered differently here, because a row carrying an unknown status is a DATA
   * DEFECT to report, not an act to refuse. The acceptable sources come from
   * `workflowVersionSourcesFor`, so the message cannot outlive the rule it describes.
   */
  private static assertTransitionAllowed(
    row: { status: WorkflowVersionStatus },
    to: WorkflowVersionStatus,
    verb: string
  ): void {
    const allowed = isWorkflowVersionTransitionAllowed(row.status, to);
    if (allowed === null) {
      throw new ConflictException(
        `This workflow version carries a status ("${row.status}") that is not part of the lifecycle; inspect the version before acting on it.`
      );
    }
    if (!allowed) {
      const sources = workflowVersionSourcesFor(to);
      throw new ConflictException(
        `Only a version in ${sources.join(' or ')} may be ${verb}; this version is ${row.status}.`
      );
    }
  }

  /**
   * The refusal for a conditional write that matched nothing: the row moved between this service's
   * read and its write. 409, never a silent success — the caller re-reads and decides again.
   */
  private static lostRace(): ConflictException {
    return new ConflictException(
      'This workflow version changed while the act was being applied; read it again before repeating the act.'
    );
  }

  /** The same refusal for a step edit, where what moved is the version's editability. */
  private static lostEdit(): ConflictException {
    return new ConflictException(
      'This workflow version is no longer a DRAFT, so its steps may not change; a change to a published configuration is a new version.'
    );
  }

  /**
   * Turn a report into the HTTP refusal it deserves — the ONE place a report becomes an answer.
   *
   * TWO KINDS OF REFUSAL, DELIBERATELY. A COLLISION (`CONFLICT_REFUSALS`: a key or an ordering the
   * version already states) is `409`, because the request is well formed and the ROWS it addresses
   * are already named or numbered by it. Everything else the walk reports is a malformed BODY and
   * is `400`. Both carry the report itself — `level`, `issues`, `truncated` — because §6 requires
   * an administrator to fix a configuration without a deployment, and an administrator who is told
   * only "invalid" cannot.
   */
  private static refuse(report: WorkflowConfigurationReport): never {
    const collision = report.issues.some((issue) =>
      WorkflowConfigurationService.CONFLICT_REFUSALS.has(issue.refusal)
    );
    const body = {
      message: collision
        ? 'This version already states a step with that key or that ordering.'
        : 'The workflow version does not pass the configuration checks.',
      level: report.level,
      issues: report.issues,
      truncated: report.truncated,
    };

    if (collision) throw new ConflictException(body);
    throw new BadRequestException(body);
  }

  /**
   * Run the ONE walk over a STORED version — the two lifecycle acts' view of it.
   *
   * `validateWorkflowVersionConfiguration` is the only walk in this slice: it is called from
   * exactly two places below (`inspect`, for the stored rows, and `inspectCandidates`, for a set
   * that is not stored yet), so "a version cannot pass one act and fail another for a reason that
   * belongs to the shared rules" is a property of there being one call, not of two agreeing.
   *
   * THE VERSION IS THE UNIT, not its steps (§10): the version's own trigger, join policy and
   * selection columns are configuration the steps cannot express, and the two rule-set rules are
   * about the SET. A walk that received only the steps could not refuse a version that governs
   * nothing or one whose sets the engine would reject.
   */
  private static inspect(
    version: VersionRecord,
    level: WorkflowConfigurationLevel
  ): WorkflowConfigurationReport {
    return WorkflowConfigurationService.inspectCandidates(
      version,
      version.steps.map((step) => WorkflowConfigurationService.shapeOfStored(step)),
      level
    );
  }

  /**
   * The same walk over a CANDIDATE step set: the version's own columns with one step added,
   * changed or replaced. The VERSION is the same row in both cases — only the steps are candidates,
   * because that is the only thing an authoring write can change about a version.
   */
  private static inspectCandidates(
    version: VersionRecord,
    steps: readonly WorkflowStepConfigurationShape[],
    level: WorkflowConfigurationLevel
  ): WorkflowConfigurationReport {
    return validateWorkflowVersionConfiguration(
      WorkflowConfigurationService.shapeOfVersion(version, steps),
      level,
      WorkflowConfigurationService.FACTS
    );
  }

  /**
   * A stored version and a set of step shapes, as `workflow-configuration.ts` reads them.
   *
   * THE VERSION'S OWN COLUMNS PASS THROUGH UNTOUCHED — including the two Prisma enums, whose
   * values the pure module compares against its own vocabularies: a value outside them is refused
   * by the walk (`TRIGGER_EVENT_UNSUPPORTED`, `JOIN_POLICY_UNSUPPORTED`) rather than filtered here,
   * so a row written outside this slice produces a REPORT an administrator can act on instead of a
   * version that quietly cannot be selected.
   */
  private static shapeOfVersion(
    version: VersionRecord,
    steps: readonly WorkflowStepConfigurationShape[]
  ): WorkflowVersionConfigurationShape {
    return {
      workflowDefinitionId: version.workflowDefinitionId,
      workflowDefinitionVersionId: version.id,
      workflowDefinitionCode: version.definition.code,
      versionLabel: version.versionLabel,
      triggerEvent: version.triggerEvent,
      parallelJoinPolicy: version.parallelJoinPolicy,
      selectionPriority: version.selectionPriority,
      selectionCondition: version.selectionCondition,
      steps,
    };
  }

  /**
   * One step's STATED configuration, as the walk reads it. A stored row and a write are the same
   * shape by the time they arrive here — which is the point: an authoring write and a stored row
   * are judged by one set of rules, so a step cannot be acceptable on the way in and unacceptable
   * on the way out.
   */
  private static shapeOfWrite(write: WorkflowStepWrite): WorkflowStepConfigurationShape {
    return {
      stepKey: write.stepKey,
      displayName: write.displayName,
      mandatory: write.mandatory,
      executionMode: write.executionMode,
      ordering: write.ordering,
      parallelGroup: write.parallelGroup,
      condition: write.condition,
      onConditionFalse: write.onConditionFalse,
      actorSource: write.actorSource,
      actorUserId: write.actorUserId,
      actorRoleCode: write.actorRoleCode,
      actorRule: write.actorRule,
      thresholds: write.thresholds,
      lineFilters: write.lineFilters,
      configuration: write.configuration,
    };
  }

  /**
   * A stored row, in the same shape — DERIVED through `shapeOfWrite` rather than mapped a second
   * time, so the two can only ever agree on which column feeds which field.
   */
  private static shapeOfStored(step: StepRecord): WorkflowStepConfigurationShape {
    return WorkflowConfigurationService.shapeOfWrite({
      stepKey: step.stepKey,
      displayName: step.displayName,
      mandatory: step.mandatory,
      executionMode: step.executionMode,
      ordering: step.ordering,
      parallelGroup: step.parallelGroup,
      condition: step.condition,
      onConditionFalse: step.onConditionFalse,
      actorSource: step.actorSource,
      actorUserId: step.actorUserId,
      actorRoleCode: step.actorRoleCode,
      actorRule: step.actorRule,
      thresholds: step.thresholds,
      lineFilters: step.lineFilters,
      configuration: step.configuration,
    });
  }

  /**
   * A create's stated columns, with the schema's own defaults applied — `mandatory` true and
   * `executionMode` SEQUENTIAL — rather than left to the DDL: a stored row must read as the author
   * meant it, without a reader knowing what the table would otherwise have filled in. The label
   * columns are TRIMMED here, once, so the value the walk judges and the value that is stored are
   * the same value.
   *
   * `null` ON A CREATE MEANS "NOT CONFIGURED YET", which is the schema's own meaning for every one
   * of these payload columns: a DRAFT may be incomplete, and completeness is judged at publication.
   * A create states nothing about the past, so there is no third kind of absence here.
   */
  private static toWrite(dto: CreateWorkflowStepDto): WorkflowStepWrite {
    return {
      stepKey: dto.stepKey.trim(),
      displayName: dto.displayName.trim(),
      mandatory: dto.mandatory ?? true,
      executionMode: dto.executionMode ?? 'SEQUENTIAL',
      ordering: dto.ordering,
      parallelGroup: WorkflowConfigurationService.text(dto.parallelGroup),
      condition: dto.condition ?? null,
      onConditionFalse: dto.onConditionFalse ?? null,
      actorSource: dto.actorSource ?? null,
      actorUserId: dto.actorUserId ?? null,
      actorRoleCode: dto.actorRoleCode ?? null,
      actorRule: dto.actorRule ?? null,
      thresholds: dto.thresholds ?? null,
      lineFilters: dto.lineFilters ?? null,
      configuration: dto.configuration ?? null,
    };
  }

  /**
   * An edit's stated columns — and ONLY those. `undefined` (absent) leaves the stored value alone
   * while `null` clears it, which is why every branch below asks `!== undefined` and never `??`:
   * the nullish operator would collapse the two into one, and a field an edit did not mention would
   * be rewritten with whatever this request happened to leave undefined.
   */
  private static toPatch(dto: UpdateWorkflowStepDto): WorkflowStepPatch {
    return {
      ...(dto.stepKey !== undefined ? { stepKey: dto.stepKey.trim() } : {}),
      ...(dto.displayName !== undefined ? { displayName: dto.displayName.trim() } : {}),
      ...(dto.ordering !== undefined ? { ordering: dto.ordering } : {}),
      ...(dto.mandatory !== undefined ? { mandatory: dto.mandatory } : {}),
      ...(dto.executionMode !== undefined ? { executionMode: dto.executionMode } : {}),
      ...(dto.parallelGroup !== undefined
        ? { parallelGroup: WorkflowConfigurationService.text(dto.parallelGroup) }
        : {}),
      ...(dto.condition !== undefined ? { condition: dto.condition } : {}),
      ...(dto.onConditionFalse !== undefined ? { onConditionFalse: dto.onConditionFalse } : {}),
      ...(dto.actorSource !== undefined ? { actorSource: dto.actorSource } : {}),
      ...(dto.actorUserId !== undefined ? { actorUserId: dto.actorUserId } : {}),
      ...(dto.actorRoleCode !== undefined ? { actorRoleCode: dto.actorRoleCode } : {}),
      ...(dto.actorRule !== undefined ? { actorRule: dto.actorRule } : {}),
      ...(dto.thresholds !== undefined ? { thresholds: dto.thresholds } : {}),
      ...(dto.lineFilters !== undefined ? { lineFilters: dto.lineFilters } : {}),
      ...(dto.configuration !== undefined ? { configuration: dto.configuration } : {}),
    };
  }
  /**
   * A version create's stated columns, with the label the caller's own text became.
   *
   * `null` MEANS "NOT STATED YET" on all four routing columns — the schema's own meaning, and the
   * reason the DTO's optionals are `?? null` here rather than defaulted to a value: a default
   * would be this service inventing configuration, and publication is where the absence is
   * refused (`WORKFLOW_TRIGGER_MISSING`, `WORKFLOW_JOIN_POLICY_MISSING`).
   */
  private static toVersionWrite(
    dto: CreateWorkflowVersionDto,
    versionLabel: string
  ): WorkflowVersionWrite {
    return {
      versionLabel,
      triggerEvent: dto.triggerEvent ?? null,
      parallelJoinPolicy: dto.parallelJoinPolicy ?? null,
      selectionPriority: dto.selectionPriority ?? null,
      selectionCondition: dto.selectionCondition ?? null,
    };
  }

  /**
   * A version edit's stated columns — and ONLY those, with the same `undefined`/`null` distinction
   * `toPatch` applies to a step: the nullish operator would collapse "not in this edit" into "clear
   * it", and an edit that stated one column would erase the three it never mentioned.
   */
  private static toVersionPatch(dto: UpdateWorkflowVersionDto): WorkflowVersionPatch {
    return {
      ...(dto.triggerEvent !== undefined ? { triggerEvent: dto.triggerEvent } : {}),
      ...(dto.parallelJoinPolicy !== undefined
        ? { parallelJoinPolicy: dto.parallelJoinPolicy }
        : {}),
      ...(dto.selectionPriority !== undefined ? { selectionPriority: dto.selectionPriority } : {}),
      ...(dto.selectionCondition !== undefined
        ? { selectionCondition: dto.selectionCondition }
        : {}),
    };
  }

  /**
   * The step an edit WOULD leave behind: the stored row with the stated columns applied over it.
   *
   * This is what the walk judges, and the reason it exists is in `updateStep`'s own note: the rules
   * are about the WHOLE step (`CONDITIONAL` needs a condition; `CONFIGURED_USER` needs its id), so
   * a patch can only be judged against the row it edits. The non-nullable columns cannot be cleared
   * by any edit — a step without a key or a position is not a step — so `??` is honest for them,
   * while every column an edit may clear is resolved with `!== undefined`.
   */
  private static project(stored: StepRecord, patch: WorkflowStepPatch): WorkflowStepWrite {
    return {
      stepKey: patch.stepKey ?? stored.stepKey,
      displayName: patch.displayName ?? stored.displayName,
      mandatory: patch.mandatory ?? stored.mandatory,
      executionMode: patch.executionMode ?? stored.executionMode,
      ordering: patch.ordering ?? stored.ordering,
      parallelGroup: patch.parallelGroup !== undefined ? patch.parallelGroup : stored.parallelGroup,
      condition: patch.condition !== undefined ? patch.condition : stored.condition,
      onConditionFalse:
        patch.onConditionFalse !== undefined ? patch.onConditionFalse : stored.onConditionFalse,
      actorSource: patch.actorSource !== undefined ? patch.actorSource : stored.actorSource,
      actorUserId: patch.actorUserId !== undefined ? patch.actorUserId : stored.actorUserId,
      actorRoleCode: patch.actorRoleCode !== undefined ? patch.actorRoleCode : stored.actorRoleCode,
      actorRule: patch.actorRule !== undefined ? patch.actorRule : stored.actorRule,
      thresholds: patch.thresholds !== undefined ? patch.thresholds : stored.thresholds,
      lineFilters: patch.lineFilters !== undefined ? patch.lineFilters : stored.lineFilters,
      configuration: patch.configuration !== undefined ? patch.configuration : stored.configuration,
    };
  }

  /** A nullable label, trimmed when it is stated and `null` when it is not — one rule, one place. */
  private static text(value: string | null | undefined): string | null {
    return value === null || value === undefined ? null : value.trim();
  }

  /**
   * A label that must be STATED and must fit its column.
   *
   * THE DTO ENFORCES THE SAME BOUND, and that is not duplication: the DTO is the CONTRACT (a long
   * value is a 400 with a field error before the request reaches here), and this is the GUARANTEE
   * (an internal caller that never went through the DTO cannot reach Postgres with a value the
   * driver would refuse as a 500). Empty-after-trim is checked for the reason the pure validator
   * checks it for a step key: whitespace is not a label.
   */
  private static assertBoundedText(field: string, value: string, max: number): void {
    if (value.length === 0) {
      throw new BadRequestException(`The workflow ${field} must not be empty.`);
    }
    if (value.length > max) {
      throw new BadRequestException(
        `The workflow ${field} must be at most ${max} characters; this one is ${value.length}.`
      );
    }
  }

  /**
   * The four columns a version edit may touch, and nothing else — what the audit row records as the
   * before and after of such an edit.
   *
   * IT IS THE EDIT'S OWN SUBJECT, stated once: `updateVersion` records these and never the whole
   * row, because a version's `steps` are not this act's business and a trail that carried them
   * would answer "what did this edit change?" with a copy of everything that stayed the same.
   */
  private static routingOf(row: {
    triggerEvent: WorkflowTriggerEvent | null;
    parallelJoinPolicy: WorkflowParallelJoinPolicy | null;
    selectionPriority: number | null;
    selectionCondition: unknown;
  }) {
    return {
      triggerEvent: row.triggerEvent,
      parallelJoinPolicy: row.parallelJoinPolicy,
      selectionPriority: row.selectionPriority,
      selectionCondition: row.selectionCondition,
    };
  }

  /**
   * One version's identity and state, as a list row states it — the readable projection, with the
   * step count added by the caller that read it in the same snapshot.
   *
   * The audit trail is NOT projected here: it is not this slice's to render (§12's trail is queried
   * where it lives), and a list that carried it would answer a different question than the one the
   * list is for. `steps` is absent for the same reason in the other direction — a page of versions
   * each carrying its steps would be a definition's whole configuration in one bounded response.
   */
  private static serializeVersion(row: {
    id: string;
    workflowDefinitionId: string;
    versionLabel: string;
    status: WorkflowVersionStatus;
    triggerEvent: WorkflowTriggerEvent | null;
    parallelJoinPolicy: WorkflowParallelJoinPolicy | null;
    selectionPriority: number | null;
    selectionCondition: unknown;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): WorkflowVersionSummary {
    return {
      id: row.id,
      workflowDefinitionId: row.workflowDefinitionId,
      versionLabel: row.versionLabel,
      status: row.status,
      triggerEvent: row.triggerEvent,
      parallelJoinPolicy: row.parallelJoinPolicy,
      selectionPriority: row.selectionPriority,
      selectionCondition: row.selectionCondition,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * A version WITH its steps, in the stated order — what `/workflow-versions/:id` answers, and what
   * every step edit answers with afterwards.
   *
   * DERIVED FROM `serializeVersion`, so the two can never disagree about the version's own fields;
   * only the `steps` array is added, and every step inside it passes through `serializeStep`, whose
   * projection is the same decision applied one level down.
   */
  private static serializeVersionDetail(row: VersionRecord): WorkflowVersionView {
    return {
      ...WorkflowConfigurationService.serializeVersion(row),
      steps: row.steps.map((step) => WorkflowConfigurationService.serializeStep(step)),
    };
  }

  /**
   * One step as the wire states it: every configuration column a reader acts on — and neither the
   * tenant that scopes the row nor the version that owns it, because the version is the route's own
   * path and the tenant is the caller's own context.
   *
   * `condition`, `actorRule`, `thresholds`, `lineFilters` and `configuration` are passed through as
   * stored JSON: this slice owns their VALIDATION (`workflow-configuration.ts` walked them), not a
   * re-encoding of them, and a projection that reshaped a payload would be a second reading of a
   * value the engine reads directly.
   */
  private static serializeStep(row: StepRecord): WorkflowStepView {
    return {
      id: row.id,
      stepKey: row.stepKey,
      displayName: row.displayName,
      mandatory: row.mandatory,
      executionMode: row.executionMode,
      ordering: row.ordering,
      parallelGroup: row.parallelGroup,
      condition: row.condition,
      onConditionFalse: row.onConditionFalse,
      actorSource: row.actorSource,
      actorUserId: row.actorUserId,
      actorRoleCode: row.actorRoleCode,
      actorRule: row.actorRule,
      thresholds: row.thresholds,
      lineFilters: row.lineFilters,
      configuration: row.configuration,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * One definition: the container's identity and name, plus the version count its list renders.
   *
   * The count is OPTIONAL because the row a create returns carries no `_count` — a definition
   * created a moment ago has no versions, and saying so is more honest than omitting the field from
   * some answers and not others.
   */
  private static serializeDefinition(
    row: Omit<DefinitionRecord, '_count'> & { _count?: DefinitionRecord['_count'] }
  ): WorkflowDefinitionView {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      versionCount: row._count?.versions ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
