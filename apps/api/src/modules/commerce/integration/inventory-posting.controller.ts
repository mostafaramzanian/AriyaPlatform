import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { resolveCommerceActor } from '../commerce-actor';
import { InventoryIntegrationService } from './inventory-integration.service';

/**
 * Phase W2-B: the integration's OPERATIONAL surface — the two routes that
 * make a cross-database posting failure visible and repairable.
 *
 *     GET  /commerce/inventory-postings?status=…          commerce.read
 *     POST /commerce/inventory-postings/:id/retry          commerce.manage
 *
 * WHY THESE EXIST AT ALL: a receipt can commit while its inventory posting
 * fails (unknown SKU, undeclared unit, inactive warehouse, insufficient
 * stock) — no transaction spans the two databases, so the failure must be a
 * stored, queryable state with an explicit repair act, not a lost exception.
 * `GET` is the queue (PENDING/FAILED is "needs attention"); `retry` re-runs
 * one posting through the Inventory port — idempotent by construction, and
 * the only mutation this surface performs. NO PATCH/PUT/DELETE: a posting
 * row is either planned by a business act or repaired by a retry; it is
 * never edited.
 *
 * PERMISSIONS follow the module's existing seven-name catalogue — the read
 * under `commerce.read`, the repair under `commerce.manage` (the same
 * permission the receiving writes carry); no eighth name is invented.
 */
@Controller('commerce/inventory-postings')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class InventoryPostingController {
  constructor(private readonly integration: InventoryIntegrationService) {}

  /**
   * The tenant's posting queue, optionally narrowed by `status`
   * (`PENDING` | `POSTED` | `FAILED`). Bounded, oldest first.
   */
  @Get()
  @Roles(Permissions.COMMERCE_READ)
  async list(@Query('status') status: string | undefined, @Request() req: ExRequest) {
    return this.integration.list(resolveCommerceActor(req), status);
  }

  /**
   * Re-attempt ONE posting — idempotent: a POSTED row answers itself, a
   * foreign or absent id answers 404. The Inventory ledger's own
   * `(sourceType, sourceId, kind)` unique is the last line of defence, so a
   * retried posting can never produce a second movement.
   */
  @Post(':id/retry')
  @Roles(Permissions.COMMERCE_MANAGE)
  async retry(@Param('id', ParseUUIDPipe) id: string, @Request() req: ExRequest) {
    return this.integration.retry(resolveCommerceActor(req), id);
  }
}
