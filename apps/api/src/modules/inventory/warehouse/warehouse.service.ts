import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InventoryActor } from '../inventory-actor';
import { InventoryAuditGateway } from '../inventory-audit.gateway';
import { INVENTORY_AUDIT_RESOURCE } from '../inventory.constants';
import { WarehouseRepository } from './warehouse.repository';
import type { ListWarehousesQueryDto } from './warehouse.dto';

/**
 * Phase W1: warehouse and storage-location rules. The service orchestrates;
 * `WarehouseRepository` owns the statements; every audit goes through the
 * gateway. A warehouse never disappears — it deactivates, and only when it
 * holds no stock and no open transfer (a deactivated warehouse with stock
 * would make that stock unreachable).
 */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly warehouses: WarehouseRepository,
    private readonly audit: InventoryAuditGateway
  ) {}

  list(actor: InventoryActor, query: ListWarehousesQueryDto) {
    return this.warehouses.list(
      actor.tenantId,
      { status: query.status, search: query.search?.trim() },
      query.page ?? 1,
      query.pageSize ?? 50
    );
  }

  async findOrFail(actor: InventoryActor, id: string) {
    const warehouse = await this.warehouses.findById(actor.tenantId, id);
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    return warehouse;
  }

  async create(
    actor: InventoryActor,
    dto: { code: string; name: string; description?: string; address?: string }
  ) {
    const code = dto.code.trim();
    const existing = await this.warehouses.findByCode(actor.tenantId, code);
    if (existing) {
      throw new ConflictException(`Warehouse code "${code}" already exists in this tenant.`);
    }
    const warehouse = await this.warehouses.create(actor.tenantId, {
      code,
      name: dto.name.trim(),
      description: dto.description,
      address: dto.address,
      createdByUserId: actor.userId,
    });
    await this.audit.record(actor, {
      action: 'inventory.warehouse.create',
      resource: INVENTORY_AUDIT_RESOURCE.WAREHOUSE,
      resourceId: warehouse.id,
      newValue: { code: warehouse.code, name: warehouse.name },
    });
    return warehouse;
  }

  async update(
    actor: InventoryActor,
    id: string,
    dto: { name?: string; description?: string; address?: string }
  ) {
    await this.findOrFail(actor, id);
    await this.warehouses.update(actor.tenantId, id, {
      name: dto.name?.trim(),
      description: dto.description,
      address: dto.address,
      updatedByUserId: actor.userId,
    });
    const warehouse = await this.findOrFail(actor, id);
    await this.audit.record(actor, {
      action: 'inventory.warehouse.update',
      resource: INVENTORY_AUDIT_RESOURCE.WAREHOUSE,
      resourceId: id,
      newValue: dto,
    });
    return warehouse;
  }

  async setStatus(actor: InventoryActor, id: string, active: boolean) {
    const warehouse = await this.findOrFail(actor, id);
    if (!active) {
      const [stocked, openTransfer] = await Promise.all([
        this.warehouses.hasStock(actor.tenantId, id),
        this.warehouses.hasOpenTransfer(actor.tenantId, id),
      ]);
      if (stocked) {
        throw new ConflictException(
          'Warehouse still holds stock; move it out before deactivation — deactivating would strand the quantity.'
        );
      }
      if (openTransfer) {
        throw new ConflictException('Warehouse has an open transfer; resolve it before deactivation.');
      }
    }
    if (warehouse.status === (active ? 'ACTIVE' : 'INACTIVE')) return warehouse;
    await this.warehouses.setStatus(actor.tenantId, id, active ? 'ACTIVE' : 'INACTIVE', actor.userId);
    await this.audit.record(actor, {
      action: active ? 'inventory.warehouse.activate' : 'inventory.warehouse.deactivate',
      resource: INVENTORY_AUDIT_RESOURCE.WAREHOUSE,
      resourceId: id,
      oldValue: { status: warehouse.status },
      newValue: { status: active ? 'ACTIVE' : 'INACTIVE' },
    });
    return this.findOrFail(actor, id);
  }

  async listLocations(actor: InventoryActor, warehouseId: string) {
    await this.findOrFail(actor, warehouseId);
    return this.warehouses.listLocations(actor.tenantId, warehouseId);
  }

  async createLocation(
    actor: InventoryActor,
    warehouseId: string,
    dto: { code: string; name?: string }
  ) {
    await this.findOrFail(actor, warehouseId);
    const code = dto.code.trim();
    const existing = await this.warehouses.findLocationByCode(actor.tenantId, warehouseId, code);
    if (existing) {
      throw new ConflictException(`Location code "${code}" already exists in this warehouse.`);
    }
    const location = await this.warehouses.createLocation(actor.tenantId, warehouseId, {
      code,
      name: dto.name?.trim(),
    });
    await this.audit.record(actor, {
      action: 'inventory.location.create',
      resource: INVENTORY_AUDIT_RESOURCE.LOCATION,
      resourceId: location.id,
      newValue: { warehouseId, code: location.code, name: location.name },
    });
    return location;
  }

  async updateLocation(
    actor: InventoryActor,
    warehouseId: string,
    id: string,
    dto: { name?: string; active?: boolean }
  ) {
    const location = await this.warehouses.findLocationInWarehouse(actor.tenantId, warehouseId, id);
    if (!location) throw new NotFoundException('Location not found in this warehouse.');
    if (dto.active === false) {
      const stocked = await this.warehouses.locationHasStock(actor.tenantId, warehouseId, id);
      if (stocked) {
        throw new ConflictException('Location still holds stock; move it before deactivation.');
      }
    }
    await this.warehouses.updateLocation(actor.tenantId, warehouseId, id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.active !== undefined ? { status: dto.active ? 'ACTIVE' : 'INACTIVE' } : {}),
    });
    await this.audit.record(actor, {
      action: 'inventory.location.update',
      resource: INVENTORY_AUDIT_RESOURCE.LOCATION,
      resourceId: id,
      newValue: dto,
    });
    return this.warehouses.findLocationInWarehouse(actor.tenantId, warehouseId, id);
  }
}
