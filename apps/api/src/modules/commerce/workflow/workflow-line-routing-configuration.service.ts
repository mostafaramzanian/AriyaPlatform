import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { validateRuleSetVersion } from '../../../rules/core/rule-validator';
import { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { CommerceActor } from '../commerce-actor';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import { WorkflowExecutionRepository } from './workflow-execution.repository';
import { COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE } from './workflow-facts';
import { WORKFLOW_TRIGGER_EVENTS } from './workflow-configuration';
import {
  WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES,
  WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS,
  WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH,
  WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS,
  workflowLineRoutingRuleSet,
  type WorkflowLineRoute,
} from './workflow-line-routing';
import {
  type CreateLineRoutingVersionDto,
  type ListLineRoutingVersionsQueryDto,
} from './workflow-line-routing.dto';
import { WorkflowLineRoutingRepository } from './workflow-line-routing.repository';

export const WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED =
  'WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_TRIGGER =
  'WORKFLOW_LINE_ROUTING_INVALID_TRIGGER' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_NO_ROUTE_BEHAVIOR =
  'WORKFLOW_LINE_ROUTING_INVALID_NO_ROUTE_BEHAVIOR' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_MULTIPLE_MATCH_BEHAVIOR =
  'WORKFLOW_LINE_ROUTING_INVALID_MULTIPLE_MATCH_BEHAVIOR' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_AGGREGATION_POLICY =
  'WORKFLOW_LINE_ROUTING_INVALID_AGGREGATION_POLICY' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_ROUTE_RULES =
  'WORKFLOW_LINE_ROUTING_INVALID_ROUTE_RULES' as const;
export const WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE =
  'WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE' as const;
export const WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED =
  'WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED' as const;
export const WORKFLOW_LINE_ROUTING_TARGET_INVALID = 'WORKFLOW_LINE_ROUTING_TARGET_INVALID' as const;
export const WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED =
  'WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED' as const;
export const WORKFLOW_LINE_ROUTING_RULE_SET_INVALID =
  'WORKFLOW_LINE_ROUTING_RULE_SET_INVALID' as const;
/**
 * PHASE C3 (GAP-2): the create-time label collision. One label per tenant is the schema's
 * own rule (`@@unique([tenantId, versionLabel])`), and this code is how the ordinary case is
 * answered before the index has to refuse the racing one — the module's named-code convention
 * for a 409 rather than a bare message, matching every other code in this file.
 */
export const WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN =
  'WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN' as const;

/** The read row shape this service validates, derived from the repository without importing the generated client. */
type WorkflowLineRoutingVersion = NonNullable<
  Awaited<ReturnType<WorkflowLineRoutingRepository['findById']>>
>;

/**
 * The four closed vocabularies `validateShape` compares a stored row against.
 *
 * PHASE C3 (GAP-2): they are no longer literals restated here — each is an ALIAS of the
 * tuple the wire contract validates with, imported from the pure routing module. Two
 * spellings of one vocabulary is exactly how a member could be added to the schema, accepted
 * at the boundary and then refused at publish (or the reverse), so the gate and the DTO read
 * ONE statement of what "supported" means. The VALUES, and therefore the publication rule,
 * are unchanged.
 */
const ALLOWED_TRIGGERS = WORKFLOW_TRIGGER_EVENTS;
const ALLOWED_NO_ROUTE_BEHAVIORS = WORKFLOW_LINE_ROUTING_NO_ROUTE_BEHAVIORS;
const ALLOWED_MULTIPLE_MATCH_BEHAVIORS = WORKFLOW_LINE_ROUTING_MATCH_BEHAVIORS;
const ALLOWED_AGGREGATION_POLICIES = WORKFLOW_LINE_ROUTING_AGGREGATION_POLICIES;

/**
 * A routing version as the configuration routes answer it — the row's own columns, and
 * NEVER the row.
 *
 * WHY THE WIRE IS DECLARED HERE (the rule `workflow-configuration.service.ts` states for its
 * views): the tenant that scopes the row is the one field the caller never sent, and echoing
 * it back would put the session's own scope into a payload it did not ask for. Stating the
 * shape here also makes the wire a decision of this file, so a column added to the schema
 * does not silently appear on a route — and no Prisma selection object is ever returned
 * directly.
 *
 * `routeRules` IS on the wire on purpose: it is the CONFIGURATION itself. An administrator
 * who authored a condition must be able to read it back verbatim, which is what the sibling
 * versioned-configuration reads do for their own rule columns.
 */
export interface WorkflowLineRoutingVersionView {
  id: string;
  versionLabel: string;
  status: WorkflowLineRoutingVersion['status'];
  trigger: WorkflowLineRoutingVersion['trigger'];
  noRouteBehavior: WorkflowLineRoutingVersion['noRouteBehavior'];
  multipleMatchBehavior: WorkflowLineRoutingVersion['multipleMatchBehavior'];
  aggregationPolicy: WorkflowLineRoutingVersion['aggregationPolicy'];
  routeRules: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Phase C1 Step O gap closure: publishing validation for `WorkflowLineRoutingVersion`.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The service-level gate that refuses to publish an invalid line-routing configuration.
 * Repositories persist; this service validates and orchestrates the publish transition.
 *
 * PHASE C3 (GAP-2): the same file is now the application surface behind the line-routing
 * CONFIGURATION routes, so it also composes the three operations that precede publication —
 * `createVersion` (a DRAFT row), `listVersions` and `getVersion` — plus `publishVersion`, the
 * actor-level face of the gate below. What it must NOT become is obvious from §13 of the C3
 * contract: it evaluates nothing, plans nothing and resolves no route. Route selection stays
 * with `WorkflowLineRoutingService` and the pure planner; this file authorizes, validates and
 * serializes configuration, and the controller delegates to it without a single domain rule.
 *
 * WHY CREATE DOES NOT RE-RUN THE PUBLISH WALK. Structural validity (the frozen fact
 * allowlist, the built rule set, target existence and its tenant) needs the rule engine and
 * the database, and this service applies it at publication — where the sibling versioned
 * slices apply theirs too. What create enforces is the label (trimmed, bounded, unique within
 * the tenant) and, at the boundary, the DTO's closed vocabularies: a DRAFT may legitimately
 * point at a workflow version that is not published yet, because that is precisely what an
 * administrator is about to do next.
 */
@Injectable()
export class WorkflowLineRoutingConfigurationService {
  constructor(
    private readonly routingRepository: WorkflowLineRoutingRepository,
    private readonly executionRepository: WorkflowExecutionRepository
  ) {}

  async publish(tenantId: string, id: string): Promise<WorkflowLineRoutingVersion> {
    const row = await this.routingRepository.findById(tenantId, id);
    if (!row) {
      throw new NotFoundException('Workflow line routing version not found');
    }
    if (row.status === 'PUBLISHED') {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED,
        message: 'A published routing version is immutable; create a new version instead.',
      });
    }
    if (row.status === 'ARCHIVED') {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED,
        message: 'An archived routing version cannot be published.',
      });
    }

    const routes = this.validateShape(row);
    await this.validateTargets(tenantId, routes);

    return this.routingRepository.publish(tenantId, id);
  }

  // ---------------------------------------------------------------------------
  // PHASE C3 (GAP-2): the application surface the HTTP boundary delegates to.
  // Every method takes the ACTOR and scopes with `actor.tenantId`; no tenant and no
  // status is ever taken from a caller.
  // ---------------------------------------------------------------------------

  /**
   * Open ONE routing version as a DRAFT (O7's payload, §5.15's row).
   *
   * THE LABEL IS THE ONE THING THIS METHOD DECIDES. It is trimmed (whitespace is not a
   * label), bounded against the `VARCHAR(64)` it lands in, and pre-checked for uniqueness
   * within the tenant — the read that turns the ordinary collision into a 409 naming the
   * label, with the schema's unique index remaining the guarantee for the race the read
   * cannot see. Everything else it stores verbatim: the DTO is the contract for shape and
   * vocabulary, and the publish walk is the authority for structure.
   */
  async createVersion(
    actor: CommerceActor,
    dto: CreateLineRoutingVersionDto
  ): Promise<WorkflowLineRoutingVersionView> {
    const versionLabel = dto.versionLabel.trim();
    if (versionLabel.length === 0) {
      throw new BadRequestException('The routing versionLabel must not be empty.');
    }
    if (versionLabel.length > WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH) {
      throw new BadRequestException(
        `The routing versionLabel must be at most ${WORKFLOW_LINE_ROUTING_MAX_VERSION_LABEL_LENGTH} characters.`
      );
    }

    const existing = await this.routingRepository.findByLabel(actor.tenantId, versionLabel);
    if (existing) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN,
        message: `A routing version labelled "${versionLabel}" already exists in this tenant.`,
      });
    }

    const row = await this.routingRepository.create(actor.tenantId, {
      status: 'DRAFT',
      versionLabel,
      trigger: dto.trigger,
      noRouteBehavior: dto.noRouteBehavior,
      multipleMatchBehavior: dto.multipleMatchBehavior,
      aggregationPolicy: dto.aggregationPolicy,
      routeRules: dto.routeRules,
    });

    return WorkflowLineRoutingConfigurationService.view(row);
  }

  /**
   * One page of the tenant's routing versions, newest first.
   *
   * The window is resolved by the module's own resolver (so an internal caller cannot exceed
   * the ceiling either), the read is the repository's tenant-first `listPage`, and the page
   * and its total come from one snapshot. Ordering is `createdAt desc, id asc` — the module's
   * deterministic list order, so a paging client cannot see a row twice.
   */
  async listVersions(actor: CommerceActor, query: ListLineRoutingVersionsQueryDto) {
    const window = resolveCommercePageWindow(query);
    const [rows, total] = await this.routingRepository.listPage(
      actor.tenantId,
      { search: query.search },
      window
    );

    return {
      items: rows.map((row) => WorkflowLineRoutingConfigurationService.view(row)),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /** One routing version by id — tenant-qualified by construction, 404 for any other. */
  async getVersion(actor: CommerceActor, id: string): Promise<WorkflowLineRoutingVersionView> {
    const row = await this.routingRepository.findById(actor.tenantId, id);
    if (!row) {
      throw new NotFoundException('Workflow line routing version not found');
    }
    return WorkflowLineRoutingConfigurationService.view(row);
  }

  /**
   * Publish through the ACTOR, answering with the server-authoritative resulting state.
   *
   * A thin composition of `publish(actor.tenantId, id)` — the walk above stays the ONE
   * authority for what may be published and its refusals (404/409 with their codes) travel
   * to the wire unchanged. This method exists only so the boundary receives a serialized
   * view rather than a row, and the raw row is never returned to a controller.
   */
  async publishVersion(actor: CommerceActor, id: string): Promise<WorkflowLineRoutingVersionView> {
    const row = await this.publish(actor.tenantId, id);
    return WorkflowLineRoutingConfigurationService.view(row);
  }

  /** The row's own columns, without the tenant that scopes it — see the view's note. */
  private static view(row: WorkflowLineRoutingVersion): WorkflowLineRoutingVersionView {
    return {
      id: row.id,
      versionLabel: row.versionLabel,
      status: row.status,
      trigger: row.trigger,
      noRouteBehavior: row.noRouteBehavior,
      multipleMatchBehavior: row.multipleMatchBehavior,
      aggregationPolicy: row.aggregationPolicy,
      routeRules: row.routeRules,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  validateShape(row: WorkflowLineRoutingVersion): readonly WorkflowLineRoute[] {
    if (!ALLOWED_TRIGGERS.includes(row.trigger as (typeof ALLOWED_TRIGGERS)[number])) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_INVALID_TRIGGER,
        message: `Unsupported routing trigger: ${row.trigger}`,
      });
    }
    if (
      !ALLOWED_NO_ROUTE_BEHAVIORS.includes(
        row.noRouteBehavior as (typeof ALLOWED_NO_ROUTE_BEHAVIORS)[number]
      )
    ) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_INVALID_NO_ROUTE_BEHAVIOR,
        message: `Unsupported no-route behavior: ${row.noRouteBehavior}`,
      });
    }
    if (
      !ALLOWED_MULTIPLE_MATCH_BEHAVIORS.includes(
        row.multipleMatchBehavior as (typeof ALLOWED_MULTIPLE_MATCH_BEHAVIORS)[number]
      )
    ) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_INVALID_MULTIPLE_MATCH_BEHAVIOR,
        message: `Unsupported multiple-match behavior: ${row.multipleMatchBehavior}`,
      });
    }
    if (
      !ALLOWED_AGGREGATION_POLICIES.includes(
        row.aggregationPolicy as (typeof ALLOWED_AGGREGATION_POLICIES)[number]
      )
    ) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_INVALID_AGGREGATION_POLICY,
        message: `Unsupported aggregation policy: ${row.aggregationPolicy}`,
      });
    }

    const rawRules = row.routeRules;
    if (!Array.isArray(rawRules) || rawRules.length === 0) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_INVALID_ROUTE_RULES,
        message: 'routeRules must be a non-empty array.',
      });
    }

    const routes: WorkflowLineRoute[] = [];
    const allowedFieldNames = new Set(
      COMMERCE_WORKFLOW_LINE_FACT_CATALOGUE.map((entry) => entry.name)
    );

    for (let index = 0; index < rawRules.length; index++) {
      const raw = rawRules[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConflictException({
          code: WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE,
          message: `Route ${index} is not a valid object.`,
        });
      }
      const rule = raw as Record<string, unknown>;

      const priority = Number(rule.priority);
      if (!Number.isSafeInteger(priority)) {
        throw new ConflictException({
          code: WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE,
          message: `Route ${index} priority must be an integer.`,
        });
      }

      const targetId = rule.targetWorkflowDefinitionVersionId;
      if (typeof targetId !== 'string' || targetId.length === 0) {
        throw new ConflictException({
          code: WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE,
          message: `Route ${index} targetWorkflowDefinitionVersionId is required.`,
        });
      }

      const condition =
        rule.condition === undefined || rule.condition === null
          ? null
          : (rule.condition as RuleConditionNode);
      if (condition !== null && typeof condition !== 'object') {
        throw new ConflictException({
          code: WORKFLOW_LINE_ROUTING_INVALID_ROUTE_SHAPE,
          message: `Route ${index} condition must be an object or null.`,
        });
      }

      routes.push({ priority, targetWorkflowDefinitionVersionId: targetId, condition });

      if (condition !== null) {
        const disallowed = this.disallowedConditionFields(condition, allowedFieldNames);
        if (disallowed.length > 0) {
          throw new ConflictException({
            code: WORKFLOW_LINE_ROUTING_FACT_NOT_ALLOWED,
            message: `Route ${index} references disallowed facts: ${disallowed.join(', ')}`,
          });
        }
      }
    }

    const ruleSet = workflowLineRoutingRuleSet(routes);
    const validation = validateRuleSetVersion(ruleSet);
    if (!validation.valid) {
      throw new ConflictException({
        code: WORKFLOW_LINE_ROUTING_RULE_SET_INVALID,
        message: `Built rule set is invalid: ${validation.issues.map((i) => i.message).join('; ')}`,
      });
    }
    return routes;
  }

  private async validateTargets(
    tenantId: string,
    routes: readonly WorkflowLineRoute[]
  ): Promise<void> {
    const seen = new Set<string>();
    for (const route of routes) {
      if (seen.has(route.targetWorkflowDefinitionVersionId)) continue;
      seen.add(route.targetWorkflowDefinitionVersionId);

      const version = await this.executionRepository.findPublishedVersion(
        tenantId,
        route.targetWorkflowDefinitionVersionId
      );
      if (!version) {
        throw new ConflictException({
          code: WORKFLOW_LINE_ROUTING_TARGET_INVALID,
          message: `Target workflow version ${route.targetWorkflowDefinitionVersionId} does not exist, is not published, or belongs to another tenant.`,
        });
      }

      for (const step of version.steps) {
        if (step.actorSource !== null && step.actorSource !== 'CONFIGURED_USER') {
          throw new ConflictException({
            code: WORKFLOW_LINE_ROUTING_ACTOR_UNSUPPORTED,
            message: `Target version ${route.targetWorkflowDefinitionVersionId} contains unsupported actor source ${step.actorSource} on step ${step.stepKey}.`,
          });
        }
      }
    }
  }

  private disallowedConditionFields(
    node: RuleConditionNode,
    allowed: Set<string>
  ): readonly string[] {
    const result = new Set<string>();
    const visit = (current: RuleConditionNode | unknown) => {
      if (current === null || current === undefined || typeof current !== 'object') return;
      if (Array.isArray(current)) {
        current.forEach(visit);
        return;
      }
      const obj = current as Record<string, unknown>;
      if ('field' in obj && typeof obj.field === 'string' && !allowed.has(obj.field)) {
        result.add(obj.field);
      }
      if ('count' in obj && typeof obj.count === 'object' && obj.count !== null) {
        const count = obj.count as Record<string, unknown>;
        if (typeof count.over === 'string' && !allowed.has(count.over)) {
          result.add(count.over);
        }
        if (Array.isArray(count.where)) {
          count.where.forEach(visit);
        }
      }
      if ('all' in obj && Array.isArray(obj.all)) obj.all.forEach(visit);
      if ('any' in obj && Array.isArray(obj.any)) obj.any.forEach(visit);
      if ('not' in obj) visit(obj.not);
    };
    visit(node);
    return Array.from(result);
  }
}
