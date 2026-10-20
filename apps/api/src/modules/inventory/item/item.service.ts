import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InventoryActor } from '../inventory-actor';
import { InventoryAuditGateway } from '../inventory-audit.gateway';
import { INVENTORY_AUDIT_RESOURCE } from '../inventory.constants';
import { ItemRepository } from './item.repository';
import type { ListItemsQueryDto } from './item.dto';

/**
 * Phase W1: item/SKU and unit-ratio rules. An item is never deleted — it
 * deactivates. A ratio is never deleted while movements in that unit could
 * exist (v1: ratios are append-only; the auditable change is a new versioned
 * row only when a correction path is designed — until then, wrong ratios are
 * deactivated items' problem, stated honestly).
 */
@Injectable()
export class ItemService {
  constructor(
    private readonly items: ItemRepository,
    private readonly audit: InventoryAuditGateway
  ) {}

  list(actor: InventoryActor, query: ListItemsQueryDto) {
    return this.items.list(
      actor.tenantId,
      {
        search: query.search?.trim(),
        itemType: query.itemType,
        activeOnly: query.activeOnly !== false,
      },
      query.page ?? 1,
      query.pageSize ?? 50
    );
  }

  async findOrFail(actor: InventoryActor, id: string) {
    const item = await this.items.findById(actor.tenantId, id);
    if (!item) throw new NotFoundException('Item not found.');
    return item;
  }

  async create(
    actor: InventoryActor,
    dto: {
      sku: string;
      name: string;
      description?: string;
      itemType: 'STOCKED' | 'NON_STOCKED' | 'SERVICE';
      baseUnit: string;
      trackingMode?: 'NONE' | 'LOT' | 'SERIAL';
      expiryTracked?: boolean;
    }
  ) {
    const sku = dto.sku.trim();
    const existing = await this.items.findBySku(actor.tenantId, sku);
    if (existing) {
      throw new ConflictException(`SKU "${sku}" already exists in this tenant.`);
    }
    if (dto.itemType !== 'STOCKED') {
      if ((dto.trackingMode ?? 'NONE') !== 'NONE' || dto.expiryTracked) {
        throw new BadRequestException(
          'Only STOCKED items carry tracking or expiry policies — a non-stocked row never moves.'
        );
      }
    }
    const item = await this.items.create(actor.tenantId, {
      sku,
      name: dto.name.trim(),
      description: dto.description,
      itemType: dto.itemType,
      baseUnit: dto.baseUnit.trim(),
      trackingMode: dto.trackingMode ?? 'NONE',
      expiryTracked: dto.expiryTracked === true && dto.itemType === 'STOCKED',
      createdByUserId: actor.userId,
    });
    await this.audit.record(actor, {
      action: 'inventory.item.create',
      resource: INVENTORY_AUDIT_RESOURCE.ITEM,
      resourceId: item.id,
      newValue: { sku: item.sku, itemType: item.itemType, baseUnit: item.baseUnit },
    });
    return item;
  }

  async update(
    actor: InventoryActor,
    id: string,
    dto: {
      name?: string;
      description?: string;
      trackingMode?: 'NONE' | 'LOT' | 'SERIAL';
      expiryTracked?: boolean;
    }
  ) {
    await this.findOrFail(actor, id);
    await this.items.update(actor.tenantId, id, {
      name: dto.name?.trim(),
      description: dto.description,
      trackingMode: dto.trackingMode,
      expiryTracked: dto.expiryTracked,
      updatedByUserId: actor.userId,
    });
    const item = await this.findOrFail(actor, id);
    await this.audit.record(actor, {
      action: 'inventory.item.update',
      resource: INVENTORY_AUDIT_RESOURCE.ITEM,
      resourceId: id,
      newValue: dto,
    });
    return item;
  }

  async setStatus(actor: InventoryActor, id: string, active: boolean) {
    const item = await this.findOrFail(actor, id);
    const target = active ? 'ACTIVE' : 'INACTIVE';
    if (item.status === target) return item;
    await this.items.setStatus(actor.tenantId, id, target, actor.userId);
    await this.audit.record(actor, {
      action: active ? 'inventory.item.activate' : 'inventory.item.deactivate',
      resource: INVENTORY_AUDIT_RESOURCE.ITEM,
      resourceId: id,
      oldValue: { status: item.status },
      newValue: { status: target },
    });
    return this.findOrFail(actor, id);
  }

  async addUnit(actor: InventoryActor, id: string, dto: { unit: string; ratioToBase: number }) {
    const item = await this.findOrFail(actor, id);
    const unit = dto.unit.trim();
    if (unit === item.baseUnit) {
      throw new BadRequestException('The base unit has ratio 1 by definition; it is not re-declared.');
    }
    const existing = await this.items.findUnit(actor.tenantId, id, unit);
    if (existing) {
      throw new ConflictException(`Unit "${unit}" is already declared for item ${item.sku}.`);
    }
    const row = await this.items.addUnit(
      actor.tenantId,
      id,
      unit,
      String(dto.ratioToBase),
      actor.userId
    );
    await this.audit.record(actor, {
      action: 'inventory.item.unit.add',
      resource: INVENTORY_AUDIT_RESOURCE.ITEM,
      resourceId: id,
      newValue: { unit, ratioToBase: dto.ratioToBase },
    });
    return row;
  }
}
