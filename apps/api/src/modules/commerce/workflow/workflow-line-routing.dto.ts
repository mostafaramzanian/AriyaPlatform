import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RULE_LIMITS } from '../../../rules/core/rule-limits';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { WORKFLOW_TRIGGER_EVENTS } from './workflow-configuration';
import {
  WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES,
  WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS,
  WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH,
  WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS,
} from './workflow-line-routing';

/**
 * PHASE C3 (GAP-2): the wire contract of the line-routing CONFIGURATION routes —
 * `commerce/routing-versions` and its `/:id` and `/:id/publish` handlers.
 *
 * WHAT IS ON THE WIRE, AND WHY EACH FIELD IS GROUNDED IN THE O CONTRACT
 * -------------------------------------------------------------------
 * A routing version is the row `WorkflowLineRoutingVersion` (§5.15), and every writable
 * member below is one the contract already names: `versionLabel` (the tenant's own label,
 * here a `VARCHAR(64)`), `trigger` (O1's closed trigger vocabulary — the same
 * `WORKFLOW_TRIGGER_EVENTS` tuple the workflow version's trigger is drawn from),
 * `noRouteBehavior` (O2), `multipleMatchBehavior` (O3), `aggregationPolicy` (O4), and
 * `routeRules` (O7's route array, one `LineRoutingRouteInputDto` per candidate).
 *
 * WHY THE STRUCTURAL CHECKS ARE NOT HERE. Group membership, target existence, the frozen
 * LINE fact allowlist and the built rule set's own validity all need the database and the
 * rule engine, and `WorkflowLineRoutingConfigurationService.publish` already applies them
 * to the STORED ROW — exactly where the sibling versioned-configuration slices apply
 * theirs ("create a DRAFT version; the structural checks run at validate/publish"). What
 * this file enforces is SHAPE: a value the schema's enum cannot store, a route list the
 * engine's own bounds refuse, or a condition that is not an object is a 422 at the edge
 * instead of a row that can never be published.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE
 * ------------------------------------
 *  * NO `tenantId` — it comes from `resolveCommerceActor(req)`, and the global pipe's
 *    `whitelist` + `forbidNonWhitelisted` makes sending one a 400 rather than an ignored
 *    field. No `id`, no `status`, no `createdAt`: the lifecycle is walked by the routes
 *    that own each transition (`/publish`), never by a client writing a status — a
 *    client-settable status is how "PUBLISHED is immutable" gets a bypass.
 *  * NO `archive`/`validate` transition: the routing configuration service exposes no
 *    such operation, and GAP-2 exposes the EXISTING capability rather than inventing one.
 *
 * `condition` IS ACCEPTED AS AN OBJECT AND NO FINER, for the reason the commercial rule
 * DTO states: its shape belongs to the Rule Engine's condition vocabulary, which the
 * publish walk validates against the frozen line catalogue — a second, thinner
 * interpretation at the boundary would be a second answer to "is this tree well formed?".
 */

/** One route candidate's own bounds — the engine's, not numbers chosen here. */
export const MAX_LINE_ROUTING_ROUTES = RULE_LIMITS.maxRulesPerSet;

/**
 * The longest route DESCRIPTION the boundary accepts.
 *
 * Derived from the engine's `maxRuleNameLength`, because the description IS the rule's
 * human-readable `name` when the set is built (`route.description ?? targetId`) — the same
 * derivation the commercial rule label uses for its own bound.
 */
export const MAX_LINE_ROUTING_ROUTE_DESCRIPTION_LENGTH = RULE_LIMITS.maxRuleNameLength;

/**
 * ONE route candidate (O7): `{ priority, condition?, targetWorkflowDefinitionVersionId,
 * description? }` — exactly the JSON object stored inside `routeRules`.
 *
 * `priority` is bounded by the ENGINE's own range so the DTO cannot accept a value the
 * publication walk would then refuse, and `targetWorkflowDefinitionVersionId` is a UUID
 * because it names a `WorkflowDefinitionVersion` ROW — the version a matching line's own
 * `WorkflowInstance` will pin. Its EXISTENCE, its published status and its tenant are
 * checked by the publish walk, which is the only place that can check them.
 */
export class LineRoutingRouteInputDto {
  @IsInt()
  @Min(RULE_LIMITS.minPriority)
  @Max(RULE_LIMITS.maxPriority)
  priority!: number;

  @IsUUID('4')
  targetWorkflowDefinitionVersionId!: string;

  /** `null`/absent = unconditional; the planner fills the tautology. */
  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown> | null;

  /** An optional human label; it becomes the rule's `name` when the set is built. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LINE_ROUTING_ROUTE_DESCRIPTION_LENGTH)
  description?: string;
}

/**
 * Create ONE routing version as a DRAFT.
 *
 * WHY A DRAFT AND NOT A PUBLISHED ROW: publication is a validated transition the service
 * already owns (`POST …/:id/publish`), and a create that published would either duplicate
 * that walk or bypass it. DRAFT is also the status the C1 test contract has always
 * written (`parseRoutingBody`), so the production route writes exactly what the probes
 * wrote — no more and no less.
 */
export class CreateLineRoutingVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH)
  versionLabel!: string;

  @IsIn(WORKFLOW_TRIGGER_EVENTS)
  trigger!: (typeof WORKFLOW_TRIGGER_EVENTS)[number];

  @IsIn(WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS)
  noRouteBehavior!: (typeof WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS)[number];

  @IsIn(WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS)
  multipleMatchBehavior!: (typeof WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS)[number];

  @IsIn(WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES)
  aggregationPolicy!: (typeof WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES)[number];

  /**
   * The route candidates. At least one — a version with no route could never route a
   * line, which is what `noRouteBehavior` is about rather than what it substitutes for.
   * At most `maxRulesPerSet`, the engine's own ceiling.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ROUTING_ROUTES)
  @ValidateNested({ each: true })
  @Type(() => LineRoutingRouteInputDto)
  routeRules!: LineRoutingRouteInputDto[];
}

/**
 * The list query: the shared page window, and nothing else.
 *
 * The inherited `search` keeps the meaning `CommercePageQueryDto` states for it — a
 * free-text match against the record's own identifying column, which for a routing
 * version is its `versionLabel` — and there is deliberately NO `status` or `trigger`
 * filter: the O contract states no such narrowing for this collection, and a filter
 * invented here would be a query shape nothing has ever defined.
 */
export class ListLineRoutingVersionsQueryDto extends CommercePageQueryDto {}
