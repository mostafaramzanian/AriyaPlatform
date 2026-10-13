import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import { WorkflowLineRoutingConfigurationService } from './workflow-line-routing-configuration.service';
import {
  CreateLineRoutingVersionDto,
  ListLineRoutingVersionsQueryDto,
} from './workflow-line-routing.dto';

/**
 * PHASE C3 (GAP-2): the line-routing CONFIGURATION routes — `commerce/routing-versions`,
 * its detail read and its publication, over the capability step O built and only ever
 * reached from test probes until now.
 *
 * THE NAMESPACE. `commerce/routing-versions` sits beside the configuration collections the
 * module already serves (`workflow-definitions`, `workflow-versions`,
 * `commercial-configurations`) under the application's global `api/v1` prefix, plural and
 * noun-shaped like every other collection route here. `routing-versions` is the name the C1
 * contract's own test seam has spoken since step O (`POST routing-versions` and
 * `POST routing-versions/:id/publish`), so the production surface reuses the established
 * vocabulary instead of introducing a second spelling of the same subject — in a bounded
 * context where "routing" has exactly one meaning, line routing.
 *
 * FOUR ROUTES, AND THE THREE THAT ARE DELIBERATELY ABSENT. Read one page, read one row,
 * open a DRAFT, publish. There is no PATCH: the configuration service exposes no draft-edit
 * operation for routing, and GAP-2 exposes the EXISTING capability rather than inventing one.
 * There is no `/validate` or `/archive`: for routing, publication IS the validation (the
 * gate below applies the whole checklist), and no archive transition exists in the domain.
 * There is no DELETE: the published version is a foreign-key target of
 * `PurchaseDocument.lineRoutingVersionId` (ON DELETE RESTRICT) and published rows are
 * immutable by contract — a delete route would promise a lifecycle neither the schema nor the
 * contract defines.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO. It resolves the actor from the request and
 * delegates. That is all: no rule, no route selection, no target check, no validation, no
 * query, no audit call. Every ordering decision here is a decorator, and every one of them is
 * a boundary statement:
 *
 *   `@RequiresModule` + `@RequiresFeature` DECLARE the requirement; the platform's
 *   `ModuleEntitlementGuard` decides it, which is why the ids come from
 *   `commerce.constants.ts` rather than from literals.
 *
 *   `@Roles(COMMERCE_READ)` covers the two reads — the list convention of every collection
 *   in this module. The two WRITES answer to `COMMERCE_WORKFLOW_MANAGE`, the one permission
 *   §10 and the settings surface already assign to the version lifecycle this row reuses
 *   ("author, validate, publish, archive" — and the routing row's status column IS
 *   `WorkflowDefinitionVersionStatus`). No new permission exists for this surface, so the
 *   permission-SQL gate's count stays exactly as step J shipped it.
 *
 *   `@HttpCode(201)` on create, because a row IS created and its id is the answer; `200` on
 *   publish, the module's answer for every transition route, carrying the SERVER-authoritative
 *   resulting state.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source of
 * `tenantId` and `userId`; no DTO carries either, so a tenant — or an id a caller could type
 * to select one — is structurally absent from every request this surface accepts.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class WorkflowLineRoutingController {
  constructor(private readonly routing: WorkflowLineRoutingConfigurationService) {}

  /** One page of the tenant's routing versions, newest-touched first. */
  @Get('routing-versions')
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListLineRoutingVersionsQueryDto) {
    return this.routing.listVersions(resolveCommerceActor(req), query);
  }

  /** One routing version with its stored `routeRules`, so an author reads back what it wrote. */
  @Get('routing-versions/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.routing.getVersion(resolveCommerceActor(req), id);
  }

  /**
   * Open ONE routing version as a DRAFT. `201`: a row IS created, and its id is the answer.
   * A label this tenant already uses is the service's own 409
   * (`WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN`).
   */
  @Post('routing-versions')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateLineRoutingVersionDto) {
    return this.routing.createVersion(resolveCommerceActor(req), dto);
  }

  /**
   * Publish the version: the existing gate applies the full checklist (vocabulary, frozen
   * line facts, rule-set validity, target existence within the tenant, actor support) and
   * then moves DRAFT → PUBLISHED. A published or archived version answers 409, an unknown or
   * foreign id 404 — the refusals of the service, carried unchanged.
   */
  @Post('routing-versions/:id/publish')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_WORKFLOW_MANAGE)
  async publish(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.routing.publishVersion(resolveCommerceActor(req), id);
  }
}
