import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { resolveCommerceActor } from '../commerce-actor';
import { WorkflowConfigurationService } from './workflow-configuration.service';
import {
  CreateWorkflowDefinitionDto,
  CreateWorkflowStepDto,
  CreateWorkflowVersionDto,
  ListWorkflowDefinitionsQueryDto,
  ListWorkflowVersionsQueryDto,
  RenameWorkflowDefinitionDto,
  ReorderWorkflowStepsDto,
  UpdateWorkflowStepDto,
  UpdateWorkflowVersionDto,
} from './workflow-configuration.dto';

/**
 * Phase C1 Step M (§5.5–§5.8, §8, §10): the workflow CONFIGURATION routes — definitions, their
 * versions, and the steps a DRAFT version states.
 *
 * THE NAMESPACE. `commerce/workflow-definitions` and `commerce/workflow-versions` under the
 * application's global `api/v1` prefix, which is what §8's `/api/commerce/**` means in this
 * repository (the purchase slice's `commerce/purchase-documents` establishes the shape). TWO
 * COLLECTIONS, DELIBERATELY: a definition is addressed by its own id and a version by its own id,
 * and a version route that repeated its definition id would give one row two addresses that could
 * disagree.
 *
 * WHY THE ROW NAMES AND NOT `workflow`. §5.5 names the rows `WorkflowDefinition` and
 * `WorkflowDefinitionVersion`; the paths name the SAME rows, so a caller reading a route and a
 * caller reading the schema are reading one vocabulary. A `/workflow/config` path would be a third
 * spelling of the same subject, and step N's runtime routes (`/workflow-instances/...`) will sit
 * beside these without either being ambiguous.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. That is all: no rule, no status
 * decision, no validation, no query, no audit call. Every ordering decision here is a decorator,
 * and every one of them is a boundary statement:
 *
 *   `@RequiresModule(COMMERCE_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the requirement — they
 *   never decide it. The decision is the platform's `ModuleEntitlementGuard`, and the module id
 *   comes from `commerce.constants.ts` rather than from a literal because the value must agree with
 *   the Core provisioning migration's SQL, and neither file can import the other.
 *
 *   `@Roles(Permissions.COMMERCE_*)` DECLARES who may act. The split follows §10's own catalogue,
 *   whose six names are the only ones that exist: `commerce.read` for every read; `commerce
 *   .configure` for the CONTAINER's administrative edits (create, rename — acts with no rules in
 *   them); `commerce.workflow.manage` for the version lifecycle §10 enumerates as "author,
 *   validate, publish, archive", which is what the version and step routes do. Approval
 *   (`commerce.approve`) is deliberately ABSENT: no route here decides a purchase, and configuration
 *   is not approval.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check: an
 *   anonymous request is refused before anything asks what it is entitled to.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source of
 * `tenantId` and `userId`; no route accepts either, and no DTO carries one. A request that never
 * resolved to a tenant is refused (403) instead of being served unscoped.
 *
 * THE TWO LIFECYCLE ACTS ARE POSTS ON THE VERSION, not a status field on an update: the transition
 * table is walked by the routes that own each edge (`/validate`, `/publish`, `/archive`), so there
 * is no request shape that states a status and therefore none that can skip an edge (the DTO file
 * records the same rule from its side).
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class WorkflowConfigurationController {
  constructor(private readonly workflows: WorkflowConfigurationService) {}

  /** One page of the tenant's workflow definitions, newest first, each with its version count. */
  @Get('workflow-definitions')
  @Roles(Permissions.COMMERCE_READ)
  async listDefinitions(
    @Request() req: ExRequest,
    @Query() query: ListWorkflowDefinitionsQueryDto
  ) {
    return this.workflows.listDefinitions(resolveCommerceActor(req), query);
  }

  /** One definition with how many versions it has. */
  @Get('workflow-definitions/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getDefinition(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.workflows.getDefinition(resolveCommerceActor(req), id);
  }

  /** Create the container a tenant's workflow is configured under. */
  @Post('workflow-definitions')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async createDefinition(@Request() req: ExRequest, @Body() dto: CreateWorkflowDefinitionDto) {
    return this.workflows.createDefinition(resolveCommerceActor(req), dto);
  }

  /** Rename the container. No version's content moves, so no new version is opened. */
  @Patch('workflow-definitions/:id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async renameDefinition(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RenameWorkflowDefinitionDto
  ) {
    return this.workflows.renameDefinition(resolveCommerceActor(req), id, dto);
  }

  /**
   * One page of a definition's versions, optional `status` narrowing within it.
   *
   * The definition is a path parameter and the tenant is the actor's: neither is a field of the
   * query, so no shape of this request widens the scope (the DTO says the same from its side).
   */
  @Get('workflow-definitions/:id/versions')
  @Roles(Permissions.COMMERCE_READ)
  async listVersions(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: ListWorkflowVersionsQueryDto
  ) {
    return this.workflows.listVersions(resolveCommerceActor(req), id, query);
  }

  /** Open a version. Always a DRAFT — the label is the tenant's own (§5.5). */
  @Post('workflow-definitions/:id/versions')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async createVersion(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateWorkflowVersionDto
  ) {
    return this.workflows.createVersion(resolveCommerceActor(req), id, dto);
  }

  /** One version WITH its steps, in the stated order — what an author edits from. */
  @Get('workflow-versions/:versionId')
  @Roles(Permissions.COMMERCE_READ)
  async getVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.workflows.getVersion(resolveCommerceActor(req), versionId);
  }

  /**
   * Change the version's own ROUTING columns — trigger, join policy, and the candidate rule's
   * priority and condition — while it is still a DRAFT.
   *
   * `PATCH` states a CHANGE, exactly as the step edit does: an omitted column keeps its stored value
   * and an explicit `null` clears one. The lifecycle is NOT on this payload — `status` is decided by
   * the two acts below — and neither is the label, which is the version's identity to the tenant.
   */
  @Patch('workflow-versions/:versionId')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async updateVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() dto: UpdateWorkflowVersionDto
  ) {
    return this.workflows.updateVersion(resolveCommerceActor(req), versionId, dto);
  }

  /**
   * The first lifecycle act: DRAFT → VALIDATED, refused with a report when the body is not
   * complete enough to be published. `200`, not `201`: nothing is created — the state moves, and
   * the answer is the version.
   */
  @Post('workflow-versions/:versionId/validate')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async validateVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.workflows.validateVersion(resolveCommerceActor(req), versionId);
  }

  /**
   * Put the version in force: VALIDATED → PUBLISHED, with `publishedAt` recorded.
   *
   * NO BODY, deliberately: the only thing a publish request could carry is a status, and a status
   * is exactly what this route decides (see the class doc).
   */
  @Post('workflow-versions/:versionId/publish')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async publishVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.workflows.publishVersion(resolveCommerceActor(req), versionId);
  }

  /** Withdraw the version from force: PUBLISHED → ARCHIVED. One way, like every other edge. */
  @Post('workflow-versions/:versionId/archive')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async archiveVersion(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.workflows.archiveVersion(resolveCommerceActor(req), versionId);
  }

  /**
   * Add one step to a DRAFT version.
   *
   * `201`: a row IS created, and its id is the answer. A version that is not a DRAFT is refused
   * (409) before anything is written — content of a validated or published version is immutable.
   */
  @Post('workflow-versions/:versionId/steps')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async addStep(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() dto: CreateWorkflowStepDto
  ) {
    return this.workflows.addStep(resolveCommerceActor(req), versionId, dto);
  }

  /**
   * Change one step of a DRAFT version.
   *
   * `PATCH` states a CHANGE: a field left out keeps its stored value and an explicit `null` clears
   * one — the two kinds of absence the service resolves (the DTO records the same distinction).
   */
  @Patch('workflow-versions/:versionId/steps/:stepId')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async updateStep(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Param('stepId', new ParseUUIDPipe({ version: '4' })) stepId: string,
    @Body() dto: UpdateWorkflowStepDto
  ) {
    return this.workflows.updateStep(resolveCommerceActor(req), versionId, stepId, dto);
  }

  /**
   * Remove one step from a DRAFT version.
   *
   * `200` with the removed id, not `204`: the answer is a fact the caller can log, and the
   * platform's `api/v1` surface answers deletions with a body rather than with an empty one.
   */
  @Delete('workflow-versions/:versionId/steps/:stepId')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async deleteStep(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Param('stepId', new ParseUUIDPipe({ version: '4' })) stepId: string
  ) {
    return this.workflows.deleteStep(resolveCommerceActor(req), versionId, stepId);
  }

  /**
   * State the version's step order IN FULL: every step id, in the order it should execute.
   *
   * `PUT` because the body REPLACES the order rather than amending it — a position-per-step shape
   * could not express a swap in one request (see `ReorderWorkflowStepsDto`), and `PATCH` would
   * promise a merge that cannot exist for a sequence.
   */
  @Put('workflow-versions/:versionId/steps/order')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async reorderSteps(
    @Request() req: ExRequest,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() dto: ReorderWorkflowStepsDto
  ) {
    return this.workflows.reorderSteps(resolveCommerceActor(req), versionId, dto);
  }
}
