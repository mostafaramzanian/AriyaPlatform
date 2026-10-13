import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { WORKFLOW_VERSION_STATUSES } from './workflow-status';
import {
  WORKFLOW_ACTOR_SOURCES,
  WORKFLOW_CONDITION_FALSE_BEHAVIORS,
  WORKFLOW_MAX_DEFINITION_CODE_LENGTH,
  WORKFLOW_MAX_DEFINITION_NAME_LENGTH,
  WORKFLOW_MAX_DISPLAY_NAME_LENGTH,
  WORKFLOW_MAX_PARALLEL_GROUP_LENGTH,
  WORKFLOW_MAX_STEP_KEY_LENGTH,
  WORKFLOW_MAX_VERSION_LABEL_LENGTH,
  WORKFLOW_PARALLEL_JOIN_POLICIES,
  WORKFLOW_STEP_EXECUTION_MODES,
  WORKFLOW_TRIGGER_EVENTS,
} from './workflow-configuration';
import type { WorkflowVersionStatus } from './workflow-status';
import type {
  WorkflowActorSource,
  WorkflowConditionFalseBehavior,
  WorkflowParallelJoinPolicy,
  WorkflowStepExecutionMode,
  WorkflowTriggerEvent,
} from './workflow-configuration';

/**
 * Phase C1 Step M (§5.5, §5.6, §5.7, §5.8, §6, §8): the wire contract of the workflow
 * configuration routes — definitions, versions and steps.
 *
 * WHY THE COLUMN LENGTHS ARE MIRRORED HERE (the rule `purchase.dto.ts` states for its own
 * columns): every maximum below is the `VARCHAR(n)` the value lands in. Without a bound a long
 * value reaches Postgres and returns as a driver error — a 500 for what is a client mistake, with
 * no field named — while with it the violation is a 400 naming the field, and the database
 * constraint stays the last line of defence rather than the only one.
 *
 * EVERY VOCABULARY FIELD VALIDATES AGAINST THE PURE MODULE'S TUPLE (`@IsIn(...)`), so a client
 * sending `PARALEL` is refused at the boundary with a field error rather than stored and
 * interpreted later. That is the DTO's job and NOT the pure validator's: the pure validator must
 * also refuse what an internal caller passes, so the two enforce the same vocabulary from
 * opposite ends — the DTO as the CONTRACT, the pure module as the GUARANTEE.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE
 * ------------------------------------
 *  * NO `tenantId` — it comes from `resolveCommerceActor(req)`, and the global pipe's `whitelist`
 *    + `forbidNonWhitelisted` makes sending one a 400 rather than an ignored field.
 *  * NO `status` on a version write — the lifecycle is walked by the routes that own each
 *    transition (`/validate`, `/publish`, `/archive`), never by a client writing a status field.
 *    A client-settable status is how "PUBLISHED is immutable" gets a bypass.
 *  * NO `publishedAt` — set by the publish transition.
 *  * NO threshold or line-filter SCHEMA. Both are configuration (§5.6) whose shape the
 *    specification does not state, so the boundary takes a JSON OBJECT and no more; see
 *    `workflow-configuration.ts` for why nothing finer is invented.
 */

/** The most step ids one reorder request may carry — a bound, not a business rule. */
export const MAX_WORKFLOW_STEP_REORDER = 200;

/** Create a workflow definition: the tenant's own code plus the name it is shown under. */
export class CreateWorkflowDefinitionDto {
  /**
   * The tenant's handle on the workflow ("standard-purchase"). A LABEL, not a sequence this
   * system mints — which is why nothing here rejects a shape beyond the column's width.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_DEFINITION_CODE_LENGTH)
  code!: string;

  /** What the workflow is called on screen (§6 lists "workflow name" as configuration). */
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_DEFINITION_NAME_LENGTH)
  name!: string;
}

/**
 * Rename a definition.
 *
 * A RENAME IS NOT A CONFIGURATION CHANGE IN THE SENSE §6 MEANS: it moves the label the container
 * is shown under and touches no version's content, so it does not require a new version. What it
 * DOES carry is an audit row, because an operator asking "who named this?" must be able to find
 * out — and `WorkflowDefinition.updatedAt` exists for exactly this edit.
 */
export class RenameWorkflowDefinitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_DEFINITION_NAME_LENGTH)
  name!: string;
}

/**
 * Open a new version of a definition.
 *
 * THE LABEL IS THE TENANT'S (§5.5: "the tenant's own label (\"1404-01\", \"v3\"), a label and not
 * a sequence this system mints") and is REQUIRED; the version's own ROUTING columns are optional
 * and stated here or later through `UpdateWorkflowVersionDto` — a route that also accepted STEPS
 * would be an authoring dialog, and a version's content is authored step by step so each step's
 * write is validated on its own.
 *
 * `triggerEvent` IS CONFIGURATION, NOT LIFECYCLE. It names §2.1's event, which is what makes the
 * version a candidate for selection; the version's STATUS is not on this payload at all — a new
 * version is ALWAYS a DRAFT, and the repository writes `status: DRAFT` explicitly rather than
 * relying on the column default.
 */
export class CreateWorkflowVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_VERSION_LABEL_LENGTH)
  versionLabel!: string;

  /** §2.1's trigger: which event makes this version a candidate. Required to publish (§10). */
  @IsOptional()
  @IsIn(WORKFLOW_TRIGGER_EVENTS)
  triggerEvent?: WorkflowTriggerEvent | null;

  /** §3's join policy: what a group of `PARALLEL` branches means. Required when one exists. */
  @IsOptional()
  @IsIn(WORKFLOW_PARALLEL_JOIN_POLICIES)
  parallelJoinPolicy?: WorkflowParallelJoinPolicy | null;

  /**
   * §2.2's tie-break rating of this version's candidate rule. An INTEGER and nothing else: the
   * engine owns the bound (`RULE_LIMITS.minPriority…maxPriority`), and its validator is what
   * refuses a value outside it — restating the bound here would be a second answer to a question
   * the engine already answers, and the two would disagree the day it changed.
   */
  @IsOptional()
  @IsInt()
  selectionPriority?: number | null;

  /** §2.3's own condition for this candidate — a tree in the engine's grammar. */
  @IsOptional()
  @IsObject()
  selectionCondition?: Record<string, unknown> | null;
}

/**
 * Change the version's own ROUTING columns while it is still a DRAFT (§10).
 *
 * WHY THIS ROUTE EXISTS AT ALL. `triggerEvent` can be stated when the version is opened, but a
 * JOIN POLICY cannot sensibly be: it says what a group of `PARALLEL` branches means, and the
 * branches are authored after the version exists. Without this route an author would have to
 * recreate a version — losing every step — to answer a question the steps themselves posed.
 *
 * THE `undefined`/`null` DISTINCTION IS THE SAME ONE THE STEP EDIT USES: an omitted column is left
 * alone, `null` clears it. Nothing here can touch the lifecycle (no `status`), a step (no step
 * field) or the label (a version's label is its identity to the tenant and never changes).
 */
export class UpdateWorkflowVersionDto {
  @IsOptional()
  @IsIn(WORKFLOW_TRIGGER_EVENTS)
  triggerEvent?: WorkflowTriggerEvent | null;

  @IsOptional()
  @IsIn(WORKFLOW_PARALLEL_JOIN_POLICIES)
  parallelJoinPolicy?: WorkflowParallelJoinPolicy | null;

  @IsOptional()
  @IsInt()
  selectionPriority?: number | null;

  @IsOptional()
  @IsObject()
  selectionCondition?: Record<string, unknown> | null;
}

/**
 * One step's configuration as the boundary accepts it.
 *
 * THE THREE REQUIRED FIELDS ARE THE ONES WITH NO SENSIBLE DEFAULT: the author's key, the name it
 * is shown under, and its position in the stated order. Everything else is optional because the
 * schema states a default for it (`mandatory` true, `executionMode` SEQUENTIAL) or because a draft
 * may legitimately not have it yet (`actorSource` and its parameter — the schema's own note:
 * "`actorSource` is NULLABLE because a DRAFT version may be incomplete"), with the completeness
 * requirement enforced at publication.
 *
 * `null` AND `undefined` MEAN DIFFERENT THINGS, exactly as in `UpdatePurchaseDocumentDto`:
 * `undefined` leaves the stored value alone, `null` CLEARS it. `@IsOptional()` accepts both, so
 * the distinction survives validation and the service applies it — a DTO that defaulted a missing
 * field to `null` would silently erase a threshold on every unrelated edit.
 */
export class WorkflowStepInputDto {
  /** The author's key for this step inside the version ("check-budget"). */
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_STEP_KEY_LENGTH)
  stepKey!: string;

  /** What the step is called on screen (§6: "step name" is configuration). */
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_DISPLAY_NAME_LENGTH)
  displayName!: string;

  /** The position in the version's stated order. UNIQUE per version, checked before writing. */
  @IsInt()
  @Min(1)
  ordering!: number;

  /** Whether the step must be decided for the flow to complete. Defaults to the schema's true. */
  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;

  /** How the step executes. Defaults to the schema's SEQUENTIAL. */
  @IsOptional()
  @IsIn(WORKFLOW_STEP_EXECUTION_MODES)
  executionMode?: WorkflowStepExecutionMode;

  /** The branch label a PARALLEL step carries; required by PARALLEL and refused otherwise. */
  @IsOptional()
  @IsString()
  @MaxLength(WORKFLOW_MAX_PARALLEL_GROUP_LENGTH)
  parallelGroup?: string | null;

  /**
   * §5.7's activation condition — a tree in the platform rule engine's own grammar, validated on
   * write by `workflow-condition.ts` and never evaluated here.
   *
   * `@IsObject()` IS THE CONTRACT, NOT THE GUARANTEE: the tree's grammar, arity, operator
   * vocabulary and operand shapes are checked by the pure walker, which is also the only check an
   * internal caller meets.
   */
  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown> | null;

  /**
   * §4's behaviour when the condition evaluates false — `SKIPPED`, `BLOCKED` or `TERMINATED`.
   * Modelled for every step, and REQUIRED by publication of every step that states a condition
   * (§10): a false condition has three configured meanings and no default, so a conditional step
   * without one is refused with `WORKFLOW_CONDITION_FALSE_BEHAVIOR_MISSING` rather than guessed
   * at. `BLOCKED` is accepted here and refused at publish, because it is modelled and not
   * executable in C1 N.
   */
  @IsOptional()
  @IsIn(WORKFLOW_CONDITION_FALSE_BEHAVIORS)
  onConditionFalse?: WorkflowConditionFalseBehavior | null;

  /** HOW the approver is resolved (§5.8). Optional while authoring, required to publish. */
  @IsOptional()
  @IsIn(WORKFLOW_ACTOR_SOURCES)
  actorSource?: WorkflowActorSource | null;

  /** CONFIGURED_USER's parameter: an OPAQUE Core identity id, verified as a member on write. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorUserId?: string | null;

  /** CONFIGURED_ROLE's parameter: a role CODE. Who holds the role stays Core's fact. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  actorRoleCode?: string | null;

  /** RULE_RESOLVER's parameter: a condition tree naming the approver (same walker as above). */
  @IsOptional()
  @IsObject()
  actorRule?: Record<string, unknown> | null;

  /** The amounts and limits the step compares against — configuration, and no finer shape. */
  @IsOptional()
  @IsObject()
  thresholds?: Record<string, unknown> | null;

  /** Which lines the step applies to (§5.3) — configuration, and no finer shape. */
  @IsOptional()
  @IsObject()
  lineFilters?: Record<string, unknown> | null;

  /** The remaining stated configuration, including §6's `visibleFields`. */
  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown> | null;
}

/** Create a step inside a DRAFT version. */
export class CreateWorkflowStepDto extends WorkflowStepInputDto {}

/**
 * Change one step of a DRAFT version.
 *
 * EVERY FIELD IS OPTIONAL and the service applies only what was stated, which is why this is a
 * separate class rather than a `PartialType` of the create payload: a create STATES a step and an
 * update STATES A CHANGE TO ONE, and the two directions differ in exactly the way that matters.
 */
export class UpdateWorkflowStepDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_STEP_KEY_LENGTH)
  stepKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(WORKFLOW_MAX_DISPLAY_NAME_LENGTH)
  displayName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  ordering?: number;

  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;

  @IsOptional()
  @IsIn(WORKFLOW_STEP_EXECUTION_MODES)
  executionMode?: WorkflowStepExecutionMode;

  @IsOptional()
  @IsString()
  @MaxLength(WORKFLOW_MAX_PARALLEL_GROUP_LENGTH)
  parallelGroup?: string | null;

  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown> | null;

  /** §4's false-path behaviour — see the create payload's note on the same column (§10). */
  @IsOptional()
  @IsIn(WORKFLOW_CONDITION_FALSE_BEHAVIORS)
  onConditionFalse?: WorkflowConditionFalseBehavior | null;

  @IsOptional()
  @IsIn(WORKFLOW_ACTOR_SOURCES)
  actorSource?: WorkflowActorSource | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  actorRoleCode?: string | null;

  @IsOptional()
  @IsObject()
  actorRule?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  thresholds?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  lineFilters?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, unknown> | null;
}

/**
 * State the version's step order, explicitly and in full.
 *
 * WHY A LIST OF IDS AND NOT A POSITION PER STEP: two steps cannot be moved to one position in two
 * requests without the first leaving the version in a state its unique index refuses, so "the
 * order" is the only shape that can express a swap. The service checks that the list is EXACTLY
 * the version's steps — a permutation — and rewrites every position in ONE transaction, which is
 * what makes a reorder atomic rather than a sequence of edits that can be interrupted.
 *
 * IDS RATHER THAN `stepKey`s: the request addresses ROWS, and a key is an editable label while an
 * id is the row's identity. A list of keys would also have to decide what a repeated key means.
 */
export class ReorderWorkflowStepsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_WORKFLOW_STEP_REORDER)
  @IsUUID('4', { each: true })
  order!: string[];
}

/** The list filter for definitions: the shared page window plus its text search (§8's list). */
export class ListWorkflowDefinitionsQueryDto extends CommercePageQueryDto {}

/**
 * The list filter for the versions of one definition.
 *
 * `status` narrows WITHIN the definition and the acting tenant — neither the tenant nor the
 * definition is a field, so there is no shape of this query that widens the scope.
 */
export class ListWorkflowVersionsQueryDto extends CommercePageQueryDto {
  @IsOptional()
  @IsIn(WORKFLOW_VERSION_STATUSES)
  status?: WorkflowVersionStatus;
}
