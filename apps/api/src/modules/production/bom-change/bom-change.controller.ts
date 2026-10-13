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
import { PRODUCTION_FEATURE, PRODUCTION_MODULE_ID } from '../production.constants';
import { resolveProductionActor } from '../production-actor';
import { BomTimelineQueryDto } from '../bom/bom.dto';
import { BomChangeRequestService } from './bom-change.service';
import {
  AddBomChangeRequestItemDto,
  CreateBomChangeRequestDto,
  DecideBomChangeRequestDto,
  ListBomChangeRequestsQueryDto,
  UpdateBomChangeRequestDto,
  UpdateBomChangeRequestItemDto,
} from './bom-change.dto';

/**
 * Phase PRODUCTION-BOM-CHANGE: the BOM Change Request routes.
 *
 * THE NAMESPACE. `production/bom-change-requests` under the application's global `api/v1`
 * prefix, matching the capability's own name rather than nesting it under
 * `/production/boms/:id/...`. The two are DIFFERENT AGGREGATE ROOTS: a change request is a
 * document of its own, addressed by its own id, LISTABLE across BOMs and FILTERABLE by
 * `bomId`. `/boms/:bomId/items` means "the items of ONE BOM"; a change request must also be
 * reachable when a caller holds only its id, so it cannot be defined as a path segment
 * under a BOM it may or may not be pointed at.
 *
 * THE ITEM SEARCH IS NOT A ROUTE HERE. Which BOM items are eligible is answered by the
 * EXISTING `GET /production/boms/:bomId/items?search=` — server-side, tenant-scoped, and
 * already gated by `production.bom.read`. A second route for the same read would be a second
 * place for its filters to drift, and the brief's search criteria (project, product tree,
 * title contains) are exactly the scope this request's `bomId` already encodes.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. No rule, no status decision,
 * no query, no audit call. Every ordering decision here is a decorator, and every one is a
 * boundary statement:
 *
 *   `@RequiresModule(...)` + `@RequiresFeature(...)` DECLARE the requirement; the platform's
 *   `ModuleEntitlementGuard` decides it. The FEATURE is `production.bom`, the SAME feature
 *   the BOM itself declares: a change request without its BOM is meaningless, and a tenant
 *   that could hold one while `bom` is withheld would hold a document nobody can govern.
 *
 *   `@Roles(Permissions.PRODUCTION_BOM_*)` DECLARES who may act. NO NEW PERMISSION STRING IS
 *   INVENTED: the Core seed migration provisioned exactly three `production.*` strings, and
 *   a `production.bom.change.*` row nobody has been provisioned would be a guaranteed 403
 *   for every caller, including SUPER_ADMIN — the warning `bom-item.controller.ts` and the
 *   seed migration already record. `.read` covers reads and the timeline, `.manage` covers
 *   create / edit / detail mutations / submit, `.approve` covers the three decisions.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveProductionActor(req)` is the only source of
 * `tenantId` and `userId`; no route accepts either, and no DTO carries them.
 *
 * BOTH PATH PARAMETERS ARE PARSED AS UUID v4 — the repository's UUID convention, so a
 * malformed id is a 400 here rather than a database round-trip. THIS IS THE OPPOSITE OF THE
 * RULE FOR A PLATFORM USER ID, which is opaque and never a UUID — which is why no user-id
 * parameter exists on any route.
 */
@Controller('production/bom-change-requests')
@RequiresModule(PRODUCTION_MODULE_ID)
@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class BomChangeRequestController {
  constructor(private readonly requests: BomChangeRequestService) {}

  /** One page of this tenant's change requests, filtered server-side. */
  @Get()
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async list(@Request() req: ExRequest, @Query() query: ListBomChangeRequestsQueryDto) {
    return this.requests.list(resolveProductionActor(req), query);
  }

  /**
   * One request with ALL of its detail rows, or 404.
   *
   * A change request of another tenant is indistinguishable from one that does not exist —
   * never 409: no conflict exists for a read.
   */
  @Get(':id')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.requests.getOne(resolveProductionActor(req), id);
  }

  /**
   * This request's audit history, read-only.
   *
   * A READ, so `production.bom.read`: the timeline is the document's history, not a new
   * capability, and no permission is invented for it. Exactly the header's route shape.
   */
  @Get(':id/timeline')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: BomTimelineQueryDto
  ) {
    return this.requests.getTimeline(resolveProductionActor(req), id, query);
  }

  /** Author a change request. It is created as a DRAFT, with no detail rows. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateBomChangeRequestDto) {
    return this.requests.create(resolveProductionActor(req), dto);
  }

  /** Change a request while it is still editable (DRAFT). 409 once it is submitted. */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBomChangeRequestDto
  ) {
    return this.requests.update(resolveProductionActor(req), id, dto);
  }

  /** Add one detail row to a DRAFT request. 409 once it is submitted. */
  @Post(':id/items')
  @HttpCode(201)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async addItem(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddBomChangeRequestItemDto
  ) {
    return this.requests.addItem(resolveProductionActor(req), id, dto);
  }

  /** Change one detail row while the request is a DRAFT. */
  @Patch(':id/items/:itemId')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async updateItem(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: UpdateBomChangeRequestItemDto
  ) {
    return this.requests.updateItem(resolveProductionActor(req), id, itemId, dto);
  }

  /**
   * Delete one detail row from a DRAFT request.
   *
   * `200` with the removed id rather than `204`, so a caller has a thing to key a toast or a
   * row splice on without re-reading the grid — and so the response mirrors what every other
   * Production delete already returns. ONLY the detail row is removed: the BOM item itself
   * is untouched.
   */
  @Delete(':id/items/:itemId')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async deleteItem(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string
  ) {
    return this.requests.deleteItem(resolveProductionActor(req), id, itemId);
  }

  /**
   * Submit a request for decision: DRAFT → SUBMITTED, once.
   *
   * `200`, not `201`: nothing is created by this route — the row's state moves, and the
   * answer is the row. NO BODY: the approver is the row's own frozen snapshot, and the
   * empty-request gate runs inside the same conditional write as the transition.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.requests.submit(resolveProductionActor(req), id);
  }

  /** Record the approver's positive decision. Approving WRITES NOTHING on the BOM. */
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async approve(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomChangeRequestDto
  ) {
    return this.requests.decide(resolveProductionActor(req), id, 'APPROVED', dto);
  }

  /** Record the approver's negative decision. */
  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async reject(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomChangeRequestDto
  ) {
    return this.requests.decide(resolveProductionActor(req), id, 'REJECTED', dto);
  }

  /**
   * Return the request for correction: SUBMITTED → DRAFT, with the decision recorded.
   *
   * The path is `request-correction` rather than `correct` because the APPROVER is asking
   * for one: the requester does not "correct" a request by calling this route — they edit it
   * afterwards through the detail routes, which is why the state this lands on is the
   * editable one.
   */
  @Post(':id/request-correction')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async requestCorrection(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomChangeRequestDto
  ) {
    return this.requests.decide(resolveProductionActor(req), id, 'NEEDS_CORRECTION', dto);
  }
}

