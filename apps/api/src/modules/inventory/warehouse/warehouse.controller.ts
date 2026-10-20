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
import { WarehouseService } from './warehouse.service';
import {
  CreateStorageLocationDto,
  CreateWarehouseDto,
  ListWarehousesQueryDto,
  UpdateStorageLocationDto,
  UpdateWarehouseDto,
} from './warehouse.dto';

/**
 * Phase W1: the warehouse/location routes. Same decorator chain every module
 * carries: entitlement declares, the guard decides, `@Roles` names the
 * permission, JWT is innermost.
 *
 * PERMISSIONS: `inventory.read` for reads, `inventory.manage` for every write.
 * PATH PARAMS ARE UUIDs AT THE EDGE; a foreign-tenant id is a 404.
 */
@Controller('inventory')
@RequiresModule(INVENTORY_MODULE_ID)
@RequiresFeature(INVENTORY_MODULE_ID, INVENTORY_FEATURE.STOCK)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class WarehouseController {
  constructor(private readonly warehouses: WarehouseService) {}

  @Get('warehouses')
  @Roles(Permissions.INVENTORY_READ)
  list(@Request() req: ExRequest, @Query() query: ListWarehousesQueryDto) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.list(actor, query);
  }

  @Post('warehouses')
  @Roles(Permissions.INVENTORY_MANAGE)
  create(@Request() req: ExRequest, @Body() dto: CreateWarehouseDto) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.create(actor, dto);
  }

  @Get('warehouses/:id')
  @Roles(Permissions.INVENTORY_READ)
  find(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.findOrFail(actor, id);
  }

  @Patch('warehouses/:id')
  @Roles(Permissions.INVENTORY_MANAGE)
  update(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.update(actor, id, dto);
  }

  @Post('warehouses/:id/deactivate')
  @Roles(Permissions.INVENTORY_MANAGE)
  deactivate(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.setStatus(actor, id, false);
  }

  @Post('warehouses/:id/activate')
  @Roles(Permissions.INVENTORY_MANAGE)
  activate(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.setStatus(actor, id, true);
  }

  @Get('warehouses/:id/locations')
  @Roles(Permissions.INVENTORY_READ)
  listLocations(@Request() req: ExRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.listLocations(actor, id);
  }

  @Post('warehouses/:id/locations')
  @Roles(Permissions.INVENTORY_MANAGE)
  createLocation(
    @Request() req: ExRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStorageLocationDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.createLocation(actor, id, dto);
  }

  @Patch('warehouses/:warehouseId/locations/:id')
  @Roles(Permissions.INVENTORY_MANAGE)
  updateLocation(
    @Request() req: ExRequest,
    @Param('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStorageLocationDto
  ) {
    const actor = resolveInventoryActor(req);
    return this.warehouses.updateLocation(actor, warehouseId, id, dto);
  }
}
