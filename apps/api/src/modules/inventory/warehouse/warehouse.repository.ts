import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  StorageLocation,
  Warehouse,
} from '../../../generated/inventory-client';
import { InventoryPrismaService } from '../database/inventory-prisma.service';
import type { InventoryTransactionHandle } from '../database/inventory-transaction';
import { unwrapInventoryTransaction } from '../database/inventory-transaction';

/**
 * Phase W1: the ONLY file that may issue Prisma statements for warehouses and
 * storage locations. Every predicate starts with `tenantId`; a lookup that
 * could see another tenant's row is a 404-shaped answer, never a leak.
 */
@Injectable()
export class WarehouseRepository {
  constructor(private readonly prisma: InventoryPrismaService) {}

  private client(tx?: InventoryTransactionHandle) {
    return tx ? unwrapInventoryTransaction(tx) : this.prisma;
  }

  list(
    tenantId: string,
    filters: { status?: 'ACTIVE' | 'INACTIVE'; search?: string },
    page: number,
    pageSize: number
  ): Promise<{ items: Warehouse[]; total: number }> {
    const where: Prisma.WarehouseWhereInput = {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            OR: [
              { code: { contains: filters.search, mode: 'insensitive' } },
              { name: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return Promise.all([
      this.prisma.warehouse.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.warehouse.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  findById(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).warehouse.findFirst({ where: { tenantId, id } });
  }

  findByCode(tenantId: string, code: string) {
    return this.prisma.warehouse.findFirst({ where: { tenantId, code } });
  }

  create(
    tenantId: string,
    data: { code: string; name: string; description?: string; address?: string; createdByUserId: string | null }
  ) {
    return this.prisma.warehouse.create({
      data: {
        tenantId,
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        address: data.address ?? null,
        createdByUserId: data.createdByUserId ?? 'system',
      },
    });
  }

  update(
    tenantId: string,
    id: string,
    data: { name?: string; description?: string; address?: string; updatedByUserId: string | null }
  ) {
    return this.prisma.warehouse.updateMany({
      where: { tenantId, id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        updatedByUserId: data.updatedByUserId ?? 'system',
      },
    });
  }

  setStatus(
    tenantId: string,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    updatedByUserId: string | null,
    tx?: InventoryTransactionHandle
  ) {
    return this.client(tx).warehouse.updateMany({
      where: { tenantId, id },
      data: { status, updatedByUserId: updatedByUserId ?? 'system' },
    });
  }

  /** True while ANY balance row for the warehouse is non-zero. */
  async hasStock(tenantId: string, warehouseId: string, tx?: InventoryTransactionHandle) {
    const row = await this.client(tx).stockBalance.findFirst({
      where: {
        tenantId,
        warehouseId,
        OR: [{ onHand: { not: 0 } }, { reserved: { not: 0 } }, { blocked: { not: 0 } }],
      },
      select: { tenantId: true },
    });
    return row !== null;
  }

  /** True while a transfer touching this warehouse is not terminal. */
  async hasOpenTransfer(tenantId: string, warehouseId: string, tx?: InventoryTransactionHandle) {
    const row = await this.client(tx).stockTransfer.findFirst({
      where: {
        tenantId,
        status: { in: ['DRAFT', 'DISPATCHED'] },
        OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }],
      },
      select: { tenantId: true },
    });
    return row !== null;
  }

  listLocations(tenantId: string, warehouseId: string) {
    return this.prisma.storageLocation.findMany({
      where: { tenantId, warehouseId },
      orderBy: [{ code: 'asc' }],
    });
  }

  findLocation(tenantId: string, id: string, tx?: InventoryTransactionHandle) {
    return this.client(tx).storageLocation.findFirst({ where: { tenantId, id } });
  }

  findLocationByCode(tenantId: string, warehouseId: string, code: string) {
    return this.prisma.storageLocation.findFirst({ where: { tenantId, warehouseId, code } });
  }

  /** Locations may be searched by id (for DTO validation) or code (for UX). */
  findLocationInWarehouse(
    tenantId: string,
    warehouseId: string,
    id: string,
    tx?: InventoryTransactionHandle
  ) {
    return this.client(tx).storageLocation.findFirst({ where: { tenantId, warehouseId, id } });
  }

  createLocation(
    tenantId: string,
    warehouseId: string,
    data: { code: string; name?: string }
  ): Promise<StorageLocation> {
    return this.prisma.storageLocation.create({
      data: { tenantId, warehouseId, code: data.code, name: data.name ?? null },
    });
  }

  updateLocation(
    tenantId: string,
    warehouseId: string,
    id: string,
    data: { name?: string; status?: 'ACTIVE' | 'INACTIVE' }
  ) {
    return this.prisma.storageLocation.updateMany({
      where: { tenantId, warehouseId, id },
      data,
    });
  }

  async locationHasStock(tenantId: string, warehouseId: string, locationId: string) {
    const row = await this.prisma.stockBalance.findFirst({
      where: {
        tenantId,
        warehouseId,
        locationId,
        OR: [{ onHand: { not: 0 } }, { reserved: { not: 0 } }, { blocked: { not: 0 } }],
      },
      select: { tenantId: true },
    });
    return row !== null;
  }
}
