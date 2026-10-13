import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  unwrapCommerceTransaction,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { Prisma } from '../../../generated/commerce-client';
import type {
  WorkflowLineRoutingVersion,
  WorkflowTriggerEvent,
} from '../../../generated/commerce-client';

/**
 * Phase C1 Step O (§5.15): the LINE-ROUTING CONFIGURATION persistence boundary.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * Reads and writes on `WorkflowLineRoutingVersion` — the versioned routing configuration
 * that decides which `WorkflowDefinitionVersion` a `PurchaseLine` runs under. It does NOT
 * evaluate rules, resolve actors, or create workflow instances.
 *
 * PHASE C3 (GAP-2) added the two CONFIGURATION reads the HTTP surface needs and nothing
 * else: `findByLabel` (the create-time label collision read) and `listPage` (the paged,
 * newest-first list). Both are reads on the model this file already owns, so the
 * ownership matrix is unchanged and no slice gained a write.
 *
 * TENANCY
 * -------
 * `tenantId` is the first parameter of every public method and appears in every `where`.
 * No `findUnique` is used for tenant-sensitive access.
 */

export interface WorkflowLineRoutingVersionWrite {
  readonly status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';
  readonly versionLabel: string;
  readonly trigger: WorkflowTriggerEvent;
  readonly noRouteBehavior: 'REJECT_OPERATION' | 'LEAVE_UNROUTED';
  readonly multipleMatchBehavior: 'HIGHEST_PRIORITY' | 'AMBIGUOUS_ERROR';
  readonly aggregationPolicy: 'ALL_APPROVED' | 'INDEPENDENT';
  readonly routeRules: unknown;
}

/**
 * PHASE C3 (GAP-2): the optional narrowing of the configuration list read.
 *
 * `search` is the shared query DTO's one text filter, and it is applied to the column that
 * IDENTIFIES a routing version — its `versionLabel`, the only text a caller could quote —
 * so a search can never match a route rule or a trigger nobody stored in that column.
 */
export interface WorkflowLineRoutingVersionFilter {
  readonly search?: string;
}

@Injectable()
export class WorkflowLineRoutingRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  async create(
    tenantId: string,
    data: WorkflowLineRoutingVersionWrite
  ): Promise<WorkflowLineRoutingVersion> {
    return this.prisma.workflowLineRoutingVersion.create({
      data: {
        tenantId,
        status: data.status,
        versionLabel: data.versionLabel,
        trigger: data.trigger,
        noRouteBehavior: data.noRouteBehavior,
        multipleMatchBehavior: data.multipleMatchBehavior,
        aggregationPolicy: data.aggregationPolicy,
        routeRules: data.routeRules as Prisma.InputJsonValue,
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<WorkflowLineRoutingVersion | null> {
    return this.prisma.workflowLineRoutingVersion.findFirst({
      where: { tenantId, id },
    });
  }

  /**
   * PHASE C3 (GAP-2): one routing version by the tenant's own label — the collision read
   * `createVersion` performs before it writes.
   *
   * EXACTLY the shape `WorkflowConfigurationRepository.findVersionByLabel` uses, and for the
   * same reason: the schema's `@@unique([tenantId, versionLabel])` is the GUARANTEE, but a
   * statement that reached it would surface as a driver error rather than as the module's
   * 409 naming the label. A read turns the ordinary case into that refusal; the index still
   * closes the race the read cannot see.
   */
  async findByLabel(
    tenantId: string,
    versionLabel: string
  ): Promise<WorkflowLineRoutingVersion | null> {
    return this.prisma.workflowLineRoutingVersion.findFirst({
      where: { tenantId, versionLabel },
    });
  }

  /**
   * PHASE C3 (GAP-2): one page of the tenant's routing versions as `[rows, total]`, newest
   * first — the read the configuration list route answers with.
   *
   * BOUNDED AND TENANT-SCOPED BY CONSTRUCTION: the window is the caller's (the service
   * clamps it to the module ceiling), the `where` states the tenant in every branch, and the
   * rows and the count are read in ONE transaction so the page and its total are a single
   * snapshot. `id` breaks a `createdAt` tie, so the order is deterministic and a paging
   * client cannot see one row twice.
   */
  async listPage(
    tenantId: string,
    filter: WorkflowLineRoutingVersionFilter,
    window: { skip: number; take: number }
  ) {
    const where = {
      tenantId,
      ...(filter.search
        ? { versionLabel: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.workflowLineRoutingVersion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.workflowLineRoutingVersion.count({ where }),
    ]);
  }

  async findPublishedForTrigger(
    tenantId: string,
    trigger: WorkflowTriggerEvent
  ): Promise<WorkflowLineRoutingVersion | null> {
    return this.prisma.workflowLineRoutingVersion.findFirst({
      where: { tenantId, trigger, status: 'PUBLISHED' },
    });
  }

  async publish(
    tenantId: string,
    id: string,
    tx?: CommerceTransactionHandle
  ): Promise<WorkflowLineRoutingVersion> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;

    await client.workflowLineRoutingVersion.updateMany({
      data: { status: 'PUBLISHED' },
      where: { id, tenantId },
    });

    const row = await client.workflowLineRoutingVersion.findFirst({
      where: { id, tenantId },
    });
    if (!row) {
      throw new Error('WorkflowLineRoutingVersion.publish: row missing after update');
    }
    return row;
  }
}
