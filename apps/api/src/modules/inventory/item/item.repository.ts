import { Injectable } from '@nestjs/common';
import type {
  InventoryItem,
  ItemType,
  Prisma,
} from '../../../generated/inventory-client';
import { InventoryPrismaService } from '../database/inventory-prisma.service';
import type { InventoryTransactionHandle } from '../database/inventory-transaction';
import { unwrapInventoryTransaction } from '../database/inventory-transaction';

/**
 * Phase W1: the ONLY file that may issue Prisma statements for inventory items
 * and their unit ratios. Every predicate starts with `tenantId`.
 */
@Injectable()
export class ItemRepository {
  constructor(private readonly prisma: InventoryPrismaService) {}

  private client(tx?: InventoryTransactionHandle) {
    return tx ? unwrapInventoryTransaction(tx) : this.prisma;
  }

  list(
    tenantId: string,
    filters: { search?: string; itemType?: ItemType; activeOnly: boolean },
    page: number,
    pageSize: number
  ): Promise<{ items: InventoryItem[]; total: number }> {
    const where: Prisma.InventoryItemWhereInput = {
      tenantId,
      ...(filters.itemType ? { itemType: filters.itemType } : {}),
      ...(filters.activeOnly ? { status: 'ACTIVE' } : {}),
      ...(filters.search
        ? {
            OR: [
              { sku: { contains: filters.search, mode: 'insensitive' } },
              { name: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return Promise.all([
      this.prisma.inventoryItem.findMany({
        where,
        orderBy: [{ sku: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inventoryItem.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  findById(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).inventoryItem.findFirst({
      where: { tenantId, id },
      include: { units: true },
    });
  }

  findBySku(tenantId: string, sku: string) {
    return this.prisma.inventoryItem.findFirst({ where: { tenantId, sku } });
  }

  create(
    tenantId: string,
    data: {
      sku: string;
      name: string;
      description?: string;
      itemType: ItemType;
      baseUnit: string;
      trackingMode: 'NONE' | 'LOT' | 'SERIAL';
      expiryTracked: boolean;
      createdByUserId: string | null;
    }
  ) {
    return this.prisma.inventoryItem.create({
      data: {
        tenantId,
        sku: data.sku,
        name: data.name,
        description: data.description ?? null,
        itemType: data.itemType,
        baseUnit: data.baseUnit,
        trackingMode: data.trackingMode,
        expiryTracked: data.expiryTracked,
        createdByUserId: data.createdByUserId ?? 'system',
      },
      include: { units: true },
    });
  }

  update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      description?: string;
      trackingMode?: 'NONE' | 'LOT' | 'SERIAL';
      expiryTracked?: boolean;
      updatedByUserId: string | null;
    }
  ) {
    return this.prisma.inventoryItem.updateMany({
      where: { tenantId, id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.trackingMode !== undefined ? { trackingMode: data.trackingMode } : {}),
        ...(data.expiryTracked !== undefined ? { expiryTracked: data.expiryTracked } : {}),
        updatedByUserId: data.updatedByUserId ?? 'system',
      },
    });
  }

  setStatus(
    tenantId: string,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    updatedByUserId: string | null
  ) {
    return this.prisma.inventoryItem.updateMany({
      where: { tenantId, id },
      data: { status, updatedByUserId: updatedByUserId ?? 'system' },
    });
  }

  addUnit(tenantId: string, itemId: string, unit: string, ratioToBase: string, createdByUserId: string | null) {
    return this.prisma.itemUnit.create({
      data: {
        tenantId,
        itemId,
        unit,
        ratioToBase,
        createdByUserId: createdByUserId ?? 'system',
      },
    });
  }

  findUnit(tenantId: string, itemId: string, unit: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).itemUnit.findFirst({ where: { tenantId, itemId, unit } });
  }
}
