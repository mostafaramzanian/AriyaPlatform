import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { PurchaseCompletionPolicyService } from './purchase-completion-policy.service';
import {
  CreatePurchaseCompletionPolicyDto,
  ListPurchaseCompletionPoliciesQueryDto,
  UpdatePurchaseCompletionPolicyDto,
} from './purchase-completion-policy.dto';

/**
 * PHASE C4-R (GAP-3): the PURCHASE COMPLETION POLICY configuration routes —
 * `commerce/completion-policies`, its detail read, its draft edit and its
 * validate/publish/archive walk.
 *
 * THE NAMESPACE. `commerce/completion-policies` sits beside the configuration collections
 * the module already serves (`workflow-definitions`, `workflow-versions`,
 * `commercial-configurations`, `routing-versions`) under the application's global `api/v1`
 * prefix, plural and noun-shaped like every other collection route here. The path names the
 * ROW it addresses (`PurchaseCompletionPolicyVersion`), so a route cannot be ambiguous about
 * what it acts on.
 *
 * SEVEN ROUTES, AND THE ONES DELIBERATELY ABSENT. Read one page, read one row, open a DRAFT,
 * edit a DRAFT, validate, publish, archive — the versioned-configuration lifecycle the
 * commercial configuration already exposes, applied to the row this module now owns. There
 * is no DELETE (a published policy is a foreign-key target of
 * `PurchaseDocument.completionPolicyVersionId` with ON DELETE RESTRICT, and the domain has
 * no deletion path), no `/activate` (publication IS activation: the single PUBLISHED row is
 * what the completion act reads), and no route edits a published row (immutability is the
 * difference between a version and a mutable setting).
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO. It resolves the actor from the request and
 * delegates. That is all: no rule, no checklist, no status decision, no query, no audit
 * call. Every ordering decision here is a decorator, and every one of them is a boundary
 * statement:
 *
 *   `@RequiresModule(COMMERCE_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the requirement;
 *   the platform's `ModuleEntitlementGuard` decides it, which is why the ids come from
 *   `commerce.constants.ts` rather than from literals.
 *
 *   `@Roles(Permissions.COMMERCE_READ)` covers the two reads — the list convention of every
 *   collection in this module. The five WRITES answer to `COMMERCE_CONFIGURE`, the remit the
 *   module already assigns to authoring, validating, publishing and archiving a
 *   configuration (the commercial configuration's own permission, and the closest
 *   precedent: a versioned business policy row, not a workflow version). NO NEW PERMISSION
 *   is introduced — the Core/RBAC catalogue is untouched, `COMMERCE_WORKFLOW_MANAGE` stays
 *   the workflow/routing lifecycle's, and completion's own AUTHORITY kept its existing home:
 *   `commerce.manage` on the close route in `purchase.controller.ts`.
 *
 *   `@HttpCode(201)` on create, because a row IS created and its id is the answer; `200` on
 *   every transition, the module's answer for a route that moves the row and returns the
 *   SERVER-authoritative resulting state.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source of
 * `tenantId` and `userId`; no DTO carries either, and no path or query names a tenant, so a
 * tenant — or an id a caller could type to select one — is structurally absent from every
 * request this surface accepts.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PurchaseCompletionPolicyController {
  constructor(private readonly completion: PurchaseCompletionPolicyService) {}

  /** One page of the tenant's completion policy versions, newest first. */
  @Get('completion-policies')
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListPurchaseCompletionPoliciesQueryDto) {
    return this.completion.listPolicies(resolveCommerceActor(req), query);
  }

  /** One policy version, including the statuses completion is permitted from. */
  @Get('completion-policies/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.completion.getPolicy(resolveCommerceActor(req), id);
  }

  /**
   * Open ONE policy version as a DRAFT. `201`: a row IS created, and its id is the answer.
   * A label this tenant already uses is the service's own 409
   * (`PURCHASE_COMPLETION_POLICY_LABEL_TAKEN`).
   */
  @Post('completion-policies')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async create(@Request() req: ExRequest, @Body() dto: CreatePurchaseCompletionPolicyDto) {
    return this.completion.createPolicy(resolveCommerceActor(req), dto);
  }

  /** Change a DRAFT's status set. A validated or published row answers 409 — it is immutable. */
  @Patch('completion-policies/:id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePurchaseCompletionPolicyDto
  ) {
    return this.completion.updatePolicy(resolveCommerceActor(req), id, dto);
  }

  /**
   * Run the checklist against the stored row and walk DRAFT → VALIDATED. A refusal writes
   * nothing: the row keeps its status and the reasons travel back in the 409.
   */
  @Post('completion-policies/:id/validate')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async validate(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.completion.validatePolicy(resolveCommerceActor(req), id);
  }

  /**
   * Put the policy in force: validate if needed, publish, and archive the previously
   * published policy in the SAME unit of work — so the tenant has exactly one published
   * completion policy, which is the one the close route will read.
   */
  @Post('completion-policies/:id/publish')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async publish(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.completion.publishPolicy(resolveCommerceActor(req), id);
  }

  /**
   * Archive a policy version — including the published one, which RETIRES completion:
   * with no published policy the close route fails closed until a new policy is published.
   */
  @Post('completion-policies/:id/archive')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async archive(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.completion.archivePolicy(resolveCommerceActor(req), id);
  }
}
