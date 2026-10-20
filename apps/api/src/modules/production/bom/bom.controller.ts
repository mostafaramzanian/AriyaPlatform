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
import { PRODUCTION_FEATURE, PRODUCTION_MODULE_ID } from '../production.constants';
import { resolveProductionActor } from '../production-actor';
import { BomHeaderService } from './bom.service';
import {
  BomTimelineQueryDto,
  CreateBomHeaderDto,
  DecideBomHeaderDto,
  ListBomHeadersQueryDto,
  UpdateBomHeaderDto,
} from './bom.dto';

/**
 * Phase PRODUCTION-BOM-HEADER: the BOM Header routes.
 *
 * THE NAMESPACE. `production/boms` under the application's global `api/v1` prefix, which
 * is what `/api/production/**` means in this repository — HR's `hr/missions` and
 * Commerce's `commerce/purchase-documents` establish the shape, and a Production-only
 * prefix convention would be a third one the module does not need.
 *
 * WHY `boms` AND NOT `bom-headers`. The path names the AGGREGATE the calls address, and
 * the aggregate is the BOM — whose root row happens to be its header. The items that will
 * hang off it are `/boms/:id/items`, so the collection that owns `:id` has exactly one
 * meaning and a route added later cannot be ambiguous about which row it meant.
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. That is all: no rule, no
 * status decision, no query, no audit call. Every ordering decision in this file is a
 * decorator, and every one of them is a boundary statement:
 *
 *   `@RequiresModule(PRODUCTION_MODULE_ID)` + `@RequiresFeature(...)` DECLARE the
 *   requirement — they never decide it. The decision is the platform's
 *   `ModuleEntitlementGuard`, provided at the composition root, which is why the module id
 *   comes from `production.constants.ts` rather than from a literal here: the value must
 *   agree with the Core provisioning migration's SQL, and neither file can import the
 *   other.
 *
 *   `@Roles(Permissions.PRODUCTION_BOM_*)` DECLARES who may act. `production.bom.read` for
 *   the reads, `production.bom.manage` for create / edit / submit, and
 *   `production.bom.approve` for the three decision acts — because DECIDING is a different
 *   remit from AUTHORING, exactly as `commerce.approve` is separate from
 *   `commerce.manage`.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check:
 *   an anonymous request is refused before anything asks what it is entitled to.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveProductionActor(req)` is the only source
 * of `tenantId` and `userId`; no route accepts either. A request that never resolved to a
 * tenant is refused (403) instead of being served unscoped, which is the difference
 * between a multi-tenant module and a data leak.
 *
 * `:id` IS PARSED AS A UUID. The BOM's OWN id is a UUID v4 (the repository's convention
 * for an owned row), so a malformed id is a 400 here rather than a database round-trip.
 * THIS IS THE OPPOSITE OF THE RULE FOR A PLATFORM USER ID, which is opaque and NEVER a
 * UUID — mixing the two up is how a legitimate `super-admin-user` gets refused.
 */
@Controller('production/boms')
@RequiresModule(PRODUCTION_MODULE_ID)
@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class BomHeaderController {
  constructor(private readonly boms: BomHeaderService) {}

  /** One page of the tenant's BOM headers, newest first. */
  @Get()
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async list(@Request() req: ExRequest, @Query() query: ListBomHeadersQueryDto) {
    return this.boms.list(resolveProductionActor(req), query);
  }

  /**
   * Phase PRODUCTION-REGISTER-REDESIGN: the register summary — `GET /production/boms/summary`.
   *
   * Declared BEFORE `@Get(':id')` so the literal segment is not consumed by the UUID
   * parser. A READ, so `production.bom.read`; the summary is only an aggregation over
   * rows the caller could already page through, and the tenant predicate is applied
   * inside the repository exactly as on `list`.
   */
  @Get('summary')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getSummary(@Request() req: ExRequest) {
    return this.boms.summary(resolveProductionActor(req));
  }

  /** One BOM header, or 404 when the id is not this tenant's. */
  @Get(':id')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.boms.getOne(resolveProductionActor(req), id);
  }

  /**
   * Phase PRODUCTION-BOM-AUDIT-TIMELINE: this BOM's audit history, read-only.
   *
   * `GET /production/boms/:id/timeline` — a READ, so `production.bom.read`: the timeline
   * is the BOM's history, not a new capability, and no new permission is invented for
   * it. Exactly Commerce's C7 route shape, one level down.
   *
   * THE SCOPE IS NOT A REQUEST INPUT. `:id` is parsed as a UUID v4 and then resolved
   * tenant-scoped by the service; `tenantId`, `resource` and `resourceId` are bound
   * server-side from the actor and that row. The DTO carries only `page`/`pageSize`, so
   * the global pipe refuses any other parameter rather than ignoring it. Ordering,
   * pagination and the safe projection are the platform read contract's, passed through
   * unchanged.
   *
   * STATUS CODES: 404 for a BOM this tenant does not own (indistinguishable from a
   * missing one, exactly like `getOne`), never 409 (no conflict exists for a read), and
   * an audit outage is the service's 503 `AUDIT_READ_FAILED` — never a quiet empty
   * timeline.
   */
  @Get(':id/timeline')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getTimeline(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: BomTimelineQueryDto
  ) {
    return this.boms.getTimeline(resolveProductionActor(req), id, query);
  }

  /** Author a BOM header. It is created as a DRAFT. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateBomHeaderDto) {
    return this.boms.create(resolveProductionActor(req), dto);
  }

  /** Change a BOM while it is still editable (DRAFT). 409 once it is submitted. */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBomHeaderDto
  ) {
    return this.boms.update(resolveProductionActor(req), id, dto);
  }

  /**
   * Submit a BOM for decision: DRAFT → SUBMITTED, once.
   *
   * `200`, not `201`: nothing is created by this route — the row's state moves, and the
   * answer is the row. A caller that retried a `201` and re-submitted would be the
   * double-routing the conditional write exists to refuse.
   *
   * NO BODY. There is nothing for the caller to state: the approver is the row's own
   * frozen snapshot, not a field of the request.
   */
  @Post(':id/submit')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async submit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.boms.submit(resolveProductionActor(req), id);
  }

  /** Record the approver's positive decision. */
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async approve(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomHeaderDto
  ) {
    return this.boms.decide(resolveProductionActor(req), id, 'APPROVED', dto);
  }

  /** Record the approver's negative decision. */
  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async reject(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomHeaderDto
  ) {
    return this.boms.decide(resolveProductionActor(req), id, 'REJECTED', dto);
  }

  /**
   * Return the BOM for correction: SUBMITTED → DRAFT, with the decision recorded.
   *
   * The path is `request-correction` rather than `correct` because the APPROVER is asking
   * for one: the requester does not "correct" a BOM by calling this route — they edit it
   * afterwards through `PATCH`, which is why the state this lands on is the editable one.
   */
  @Post(':id/request-correction')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_APPROVE)
  async requestCorrection(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideBomHeaderDto
  ) {
    return this.boms.decide(resolveProductionActor(req), id, 'NEEDS_CORRECTION', dto);
  }
}