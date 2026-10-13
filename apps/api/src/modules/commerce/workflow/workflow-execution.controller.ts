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
import { WorkflowExecutionService } from './workflow-execution.service';
import {
  ListWorkflowInstancesQueryDto,
  WorkflowStepDecisionDto,
} from './workflow-execution.dto';

/**
 * PHASE C2 (GAP-1): the §11 workflow-execution routes — READ, DECIDE, CANCEL — over the
 * runtime that step N already built and only ever reached from test probes.
 *
 * THE NAMESPACE AND THE ORDERING. `commerce/workflow-instances` sits beside the
 * configuration routes the module already serves (`workflow-definitions`, `workflow-versions`)
 * exactly as N §11 spells it, under the application's global `api/v1` prefix. Four routes,
 * nothing more: N's contract lists no fifth.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO. It resolves the actor from the request
 * and delegates — no rule, no status decision, no plan, no audit call. Every ordering
 * decision here is a decorator:
 *
 *   `@RequiresModule` + `@RequiresFeature` DECLARE the requirement; the platform's
 *   `ModuleEntitlementGuard` decides it, which is why the ids come from
 *   `commerce.constants.ts` rather than literals.
 *
 *   `@Roles(COMMERCE_READ)` covers both reads (§11: "reads"), `@Roles(COMMERCE_APPROVE)`
 *   covers both writes (§11: decisions/cancellations — the same permission the commercial
 *   decision route answers to). No new permission exists for this surface, so the
 *   permission-SQL gate's count stays exactly as step J shipped it.
 *
 *   `@HttpCode(200)` on the two writes: they change state and create nothing, which is the
 *   module's answer for every transition route (submit, commercial decision, compensation).
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source of
 * `tenantId` and `userId`; the DECIDE body carries only `decision` + optional `comment`,
 * so an id a caller could type (an approver, a tenant) is structurally absent.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class WorkflowExecutionController {
  constructor(private readonly execution: WorkflowExecutionService) {}

  /** One page of the tenant's runs, newest-touched first, steps as PERSISTED. */
  @Get('workflow-instances')
  @Roles(Permissions.COMMERCE_READ)
  async list(
    @Request() req: ExRequest,
    @Query() query: ListWorkflowInstancesQueryDto
  ) {
    return this.execution.listInstances(resolveCommerceActor(req), query);
  }

  /** One run with its pinned version and every step's persisted outcome. A read never evaluates. */
  @Get('workflow-instances/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.execution.getInstance(resolveCommerceActor(req), id);
  }

  /**
   * Record ONE step's decision: APPROVED or REJECTED, on a RUNNING run, by the step's own
   * resolved approver. The answer is the run's server-authoritative status; a stale or
   * racing attempt is refused with the planner's named code (409 for state, 400 for actor).
   */
  @Post('workflow-instances/:id/steps/:stepInstanceId/decision')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_APPROVE)
  async decide(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('stepInstanceId', new ParseUUIDPipe({ version: '4' })) stepInstanceId: string,
    @Body() dto: WorkflowStepDecisionDto
  ) {
    return this.execution.decideStep(
      resolveCommerceActor(req),
      id,
      stepInstanceId,
      dto.decision,
      dto.comment ?? null
    );
  }

  /**
   * Cancel a RUNNING run: it settles CANCELLED and its outstanding steps settle SKIPPED,
   * atomically (N §9.3). Nothing else moves — no document status, no commercial dispatch.
   */
  @Post('workflow-instances/:id/cancel')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_APPROVE)
  async cancel(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.execution.cancelInstance(resolveCommerceActor(req), id);
  }
}
