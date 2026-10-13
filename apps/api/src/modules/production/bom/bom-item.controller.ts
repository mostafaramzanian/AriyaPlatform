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
import { BomItemService } from './bom-item.service';
import {
  CreateBomItemDto,
  ListBomItemsQueryDto,
  UpdateBomItemDto,
} from './bom-item.dto';

/**
 * Phase PRODUCTION-BOM-ITEM: the BOM Item routes.
 *
 * THE NAMESPACE IS NESTED UNDER THE HEADER ON PURPOSE. `production/boms/:bomId/items`
 * states that every one of these calls addresses a child of ONE header; `bom.controller.ts`
 * owns `/production/boms`, so the two controllers cannot collide, and a reader can tell from
 * the path alone whether they are addressing the aggregate root or its children. This is
 * the exact shape the BOM Header controller's own docblock predicted: "the items that will
 * hang off it are `/boms/:id/items`".
 *
 * WHAT THIS FILE DOES, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It resolves the actor from the request context and delegates. No rule, no status decision,
 * no query, no audit call. Every ordering decision here is a decorator, and every one is a
 * boundary statement:
 *
 *   `@RequiresModule(...)` + `@RequiresFeature(...)` DECLARE the requirement; the platform's
 *   `ModuleEntitlementGuard` decides it. An item belongs to the SAME feature as its header —
 *   `PRODUCTION_FEATURE.BOM` — because a BOM that can hold items while the `bom` feature is
 *   withheld would be a BOM nobody can govern.
 *
 *   `@Roles(Permissions.PRODUCTION_BOM_READ)` for the two reads, and
 *   `@Roles(Permissions.PRODUCTION_BOM_MANAGE)` for create / update / delete. NO third
 *   permission is invented: the seed migration granted exactly these three to Production,
 *   and an `production.bom.item.*` string would be a permission nobody has been provisioned
 *   — a guaranteed 403 for every caller, including SUPER_ADMIN.
 *
 *   `@UseGuards(JwtAuthGuard)` is declared LAST so authentication is the innermost check:
 *   an anonymous request is refused before anything asks what it is entitled to.
 *
 * BOTH PATH PARAMETERS ARE PARSED AS UUID v4. The BOM's own id and the item's own id are
 * both the repository's UUID convention, so a malformed id is a 400 here rather than a
 * database round-trip. THIS IS THE OPPOSITE OF THE RULE FOR A PLATFORM USER ID, which is
 * opaque and never a UUID — mixing the two up is how a legitimate `super-admin-user` gets
 * refused.
 *
 * THE ACTOR IS RESOLVED, NEVER TRUSTED. `resolveProductionActor(req)` is the only source of
 * `tenantId` and `userId`; no route accepts either, and no DTO carries them, so a request
 * that never resolved to a tenant is refused (403) instead of being served unscoped.
 */
@Controller('production/boms/:bomId/items')
@RequiresModule(PRODUCTION_MODULE_ID)
@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class BomItemController {
  constructor(private readonly items: BomItemService) {}

  /** One page of this BOM's items, in the order they were added. */
  @Get()
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async list(
    @Request() req: ExRequest,
    @Param('bomId', new ParseUUIDPipe({ version: '4' })) bomId: string,
    @Query() query: ListBomItemsQueryDto
  ) {
    return this.items.list(resolveProductionActor(req), bomId, query);
  }

  /** One item of this BOM, or 404 when the id is not this tenant's / this BOM's. */
  @Get(':itemId')
  @Roles(Permissions.PRODUCTION_BOM_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('bomId', new ParseUUIDPipe({ version: '4' })) bomId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string
  ) {
    return this.items.getOne(resolveProductionActor(req), bomId, itemId);
  }

  /** Add an item to a DRAFT BOM. 409 once the header has been submitted. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async create(
    @Request() req: ExRequest,
    @Param('bomId', new ParseUUIDPipe({ version: '4' })) bomId: string,
    @Body() dto: CreateBomItemDto
  ) {
    return this.items.create(resolveProductionActor(req), bomId, dto);
  }

  /** Change an item while its BOM is still editable (DRAFT). 409 once it is submitted. */
  @Patch(':itemId')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('bomId', new ParseUUIDPipe({ version: '4' })) bomId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: UpdateBomItemDto
  ) {
    return this.items.update(resolveProductionActor(req), bomId, itemId, dto);
  }

  /**
   * Delete an item from a DRAFT BOM.
   *
   * `200` with the deleted id rather than `204`, so a caller has a thing to key a toast or a
   * list splice on without re-reading the grid — and so the response mirrors what `coreDelete`
   * already unwraps for every other admin delete.
   */
  @Delete(':itemId')
  @HttpCode(200)
  @Roles(Permissions.PRODUCTION_BOM_MANAGE)
  async remove(
    @Request() req: ExRequest,
    @Param('bomId', new ParseUUIDPipe({ version: '4' })) bomId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string
  ) {
    return this.items.delete(resolveProductionActor(req), bomId, itemId);
  }
}
