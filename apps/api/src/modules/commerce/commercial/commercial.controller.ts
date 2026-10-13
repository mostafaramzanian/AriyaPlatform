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
import { Roles } from '../../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import { resolveCommerceActor } from '../commerce-actor';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { CommercialConfigurationService } from './commercial-configuration.service';
import { CommercialLifecycleService } from './commercial-lifecycle.service';
import {
  CommercialApprovalDecisionDto,
  CommercialDocumentQueryDto,
  CreateCommercialAssignmentDto,
  CreateCommercialConfigurationDto,
  CreateCommercialGroupDto,
  UpdateCommercialConfigurationDto,
  UpdateCommercialGroupDto,
} from './commercial.dto';

/**
 * Phase C1 Step P (§9): the FIFTEEN commercial routes — groups, configuration
 * versions, assignments and approvals. Nothing beyond this table exists, and nothing
 * beyond it may be added without amending the contract first.
 *
 * THE NAMESPACE. `commerce/commercial-groups`, `commerce/commercial-configurations`,
 * `commerce/commercial-assignments` and `commerce/commercial-approvals` under the
 * application's global `api/v1` prefix — the purchase slice's
 * `commerce/purchase-documents` establishes the shape. FOUR collections, each naming
 * the ROW it addresses, so a route cannot be ambiguous about which of the module's
 * subjects it means.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. That is all: no rule,
 * no status decision, no validation, no query, no audit call. Every ordering decision
 * here is a decorator, and every one of them is a boundary statement:
 *
 *   `@RequiresModule(COMMERCE_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the
 *   requirement; the platform's `ModuleEntitlementGuard` decides it.
 *
 *   `@Roles(...)` DECLARES who may act, and §9's own table is the source: `commerce
 *   .read` for the five reads; `commerce.configure` for groups and the configuration
 *   lifecycle; `commerce.manage` for manual assignment (the same remit as the document
 *   operations that produce the lines); `commerce.approve` for a commercial decision.
 *   Those four strings already exist in Core's catalogue — P adds no permission (§3-I),
 *   so `commerce.workflow.manage` and `commerce.commercial.manage` are NOT used here:
 *   neither is named by §9.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost
 *   check: an anonymous request is refused before anything asks what it is entitled to.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveCommerceActor(req)` is the only source
 * of `tenantId` and `userId`; no route accepts either, and no DTO carries the field —
 * the global pipe's `whitelist` makes sending one a 400.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class CommercialController {
  constructor(
    private readonly configuration: CommercialConfigurationService,
    private readonly lifecycle: CommercialLifecycleService
  ) {}

  // ---------------------------------------------------------------------------
  // Commercial Groups (P2)
  // ---------------------------------------------------------------------------

  /** One page of the tenant's commercial groups. */
  @Get('commercial-groups')
  @Roles(Permissions.COMMERCE_READ)
  async listGroups(@Request() req: ExRequest, @Query() query: CommercePageQueryDto) {
    return this.configuration.listGroups(resolveCommerceActor(req), query);
  }

  /** One group, with its configured liaison. */
  @Get('commercial-groups/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getGroup(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.configuration.getGroup(resolveCommerceActor(req), id);
  }

  /** Create a group (code uniqueness + liaison membership checked in the service). */
  @Post('commercial-groups')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async createGroup(@Request() req: ExRequest, @Body() dto: CreateCommercialGroupDto) {
    return this.configuration.createGroup(resolveCommerceActor(req), dto);
  }

  /** Rename a group and/or swap its liaison — audited as `liaison_changed` (§9). */
  @Patch('commercial-groups/:id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async updateGroup(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCommercialGroupDto
  ) {
    return this.configuration.updateGroup(resolveCommerceActor(req), id, dto);
  }

  // ---------------------------------------------------------------------------
  // Commercial configuration versions (§7)
  // ---------------------------------------------------------------------------

  /** One page of configuration versions. */
  @Get('commercial-configurations')
  @Roles(Permissions.COMMERCE_READ)
  async listConfigurations(@Request() req: ExRequest, @Query() query: CommercePageQueryDto) {
    return this.configuration.listConfigurations(resolveCommerceActor(req), query);
  }

  /** One version — rules, applicability condition and projection policy included. */
  @Get('commercial-configurations/:id')
  @Roles(Permissions.COMMERCE_READ)
  async getConfiguration(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.configuration.getConfiguration(resolveCommerceActor(req), id);
  }

  /** Create a DRAFT version. §7's structural checks run at validate/publish. */
  @Post('commercial-configurations')
  @HttpCode(201)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async createConfiguration(
    @Request() req: ExRequest,
    @Body() dto: CreateCommercialConfigurationDto
  ) {
    return this.configuration.createConfiguration(resolveCommerceActor(req), dto);
  }

  /** Edit a DRAFT — a published or archived version answers 409 naming its status. */
  @Patch('commercial-configurations/:id')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async updateConfiguration(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCommercialConfigurationDto
  ) {
    return this.configuration.updateConfiguration(resolveCommerceActor(req), id, dto);
  }

  /** Run §7's checklist and walk DRAFT → VALIDATED. */
  @Post('commercial-configurations/:id/validate')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async validateConfiguration(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.configuration.validateConfiguration(resolveCommerceActor(req), id);
  }

  /** Validate + publish + archive the previously published version, atomically (§7.9). */
  @Post('commercial-configurations/:id/publish')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async publishConfiguration(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.configuration.publishConfiguration(resolveCommerceActor(req), id);
  }

  /** Archive a version — including the published one, which retires the policy (§3-A). */
  @Post('commercial-configurations/:id/archive')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_CONFIGURE)
  async archiveConfiguration(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.configuration.archiveConfiguration(resolveCommerceActor(req), id);
  }

  // ---------------------------------------------------------------------------
  // Assignments (P3, P5, P7) — LINE-scoped, always
  // ---------------------------------------------------------------------------

  /**
   * A document's current assignments AND its append-only history (§9).
   *
   * The document is the address because §3-J makes every commercial record LINE-scoped
   * and a line has no route of its own: a mixed purchase answers here with one row per
   * line — line 1 → group A, line 2 → group B — and a history list that still contains
   * January's assignment after February's reassignment.
   */
  @Get('commercial-assignments')
  @Roles(Permissions.COMMERCE_READ)
  async listAssignments(@Request() req: ExRequest, @Query() query: CommercialDocumentQueryDto) {
    return this.lifecycle.listAssignments(resolveCommerceActor(req), query.documentId);
  }

  /**
   * Manual assignment / reassignment of ONE line (§9).
   *
   * `201` for both outcomes, because both outcomes PRODUCE a current row: the first
   * call creates it (with its first history entry), a repeat call reassigns it (with a
   * new history entry that leaves the previous one intact, P7). Asking for exactly what
   * is already there is a 409 — `COMMERCIAL_INVALID_REASSIGNMENT` — rather than a
   * silent success, and a document that is terminal answers
   * `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE` (§3-H).
   */
  @Post('commercial-assignments')
  @Roles(Permissions.COMMERCE_MANAGE)
  async assign(@Request() req: ExRequest, @Body() dto: CreateCommercialAssignmentDto) {
    return this.lifecycle.assign(resolveCommerceActor(req), dto);
  }

  // ---------------------------------------------------------------------------
  // Commercial approvals (P12) — separate from Workflow Approval
  // ---------------------------------------------------------------------------

  /** A document's commercial approvals — their OWN lifecycle, not the workflow's. */
  @Get('commercial-approvals')
  @Roles(Permissions.COMMERCE_READ)
  async listApprovals(@Request() req: ExRequest, @Query() query: CommercialDocumentQueryDto) {
    return this.lifecycle.listApprovals(resolveCommerceActor(req), query.documentId);
  }

  /**
   * Approve or reject ONE commercial record (§9).
   *
   * `200`, not `201`: nothing is created — the record's own state moves, and the answer
   * is the record. The acting user must equal the approver stored at activation (§3-G),
   * and the projection that follows is written in the same unit of work.
   */
  @Post('commercial-approvals/:id/decision')
  @HttpCode(200)
  @Roles(Permissions.COMMERCE_APPROVE)
  async decide(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CommercialApprovalDecisionDto
  ) {
    return this.lifecycle.decide(resolveCommerceActor(req), id, dto);
  }
}
