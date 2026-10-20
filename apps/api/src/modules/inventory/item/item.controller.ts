import {
  Body,
  Controller,
  Get,
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
import { INVENTORY_FEATURE, INVENTORY_MODULE_ID } from '../inventory.constants';
import { resolveInventoryActor } from '../inventory-actor';
import { ItemService } from './item.service';
import {
  AddItemUnitDto,
  CreateItemDto,
  ListItemsQueryDto,
  UpdateItemDto,
} from './item.dto';

/**
 * Phase W1: the item/SKU routes — register, detail, update, activation,
 * unit ratios. `inventory.read` reads; `inventory.manage` writes.
 */
@Controller('inventory/items')
@RequiresModule(INVENTORY_MODULE_ID)
@RequiresFeature(INVENTORY_MODULE_ID, INVENTORY_FEATURE.STOCK)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class ItemController {
  constructor(private readonly items: ItemService) {}

  @Get()
  @Roles(Permissions.INVENTORY_READ)
  list(@Request() req: ExRequest, @Query() query: ListItemsQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.items.list(actor, query);
  }

  @Post()
  @Roles(Permissions.INVENTORY_MANAGE)
  create(@Request() req: ExRequest, @Body() dto: CreateItemDto) {
    const actor = resolveInventoryActor(req);
    return this.items.create(actor, dto);
  }

  @Get(':id')
  @Roles(Permissions.INVENTORY_READ)
  find(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.items.findOrFail(actor, id);
  }

  @Patch(':id')
  @Roles(Permissions.INVENTORY_MANAGE)
  update(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateItemDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.items.update(actor, id, dto);
  }

  @Post(':id/deactivate')
  @Roles(Permissions.INVENTORY_MANAGE)
  deactivate(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.items.setStatus(actor, id, false);
  }

  @Post(':id/activate')
  @Roles(Permissions.INVENTORY_MANAGE)
  activate(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.items.setStatus(actor, id, true);
  }

  @Post(':id/units')
  @Roles(Permissions.INVENTORY_MANAGE)
  addUnit(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddItemUnitDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.items.addUnit(actor, id, dto);
  }
}
