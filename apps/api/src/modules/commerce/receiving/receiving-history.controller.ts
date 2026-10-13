import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { resolveCommerceActor } from '../commerce-actor';
import { ReceivingHistoryService } from './receiving-history.service';
import { CompensateReceiptLineDto, CreateReceiptDto } from './receiving.dto';

/**
 * Phase C1 Step R (contract R7/R8, §6): the THREE receiving routes — and not
 * one more.
 *
 *     GET   /commerce/purchase-documents/:id/receipts        commerce.read
 *     POST  /commerce/purchase-documents/:id/receipts        commerce.manage
 *     POST  /commerce/purchase-documents/:id/receipts/:receiptLineId/compensate
 *                                                            commerce.manage
 *
 * THE BOUNDARY IS A MIRROR OF `payment-history.controller.ts`, DELIBERATELY:
 * the same `commerce/purchase-documents` controller path (a receipt has no
 * meaning apart from the document it receives against, so there is no
 * `/receipts` collection of its own), the same decorator order
 * (`@RequiresModule` → `@RequiresFeature(PURCHASE)` → `@UseGuards(
 * ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)`, so authentication is
 * the innermost check and no entitlement question is asked about an anonymous
 * caller), the same actor resolution, and the same absence of rules.
 *
 * PERMISSIONS (R8): `commerce.read` for the one read, `commerce.manage` for
 * both writes. NO receiving-specific permission is created — the module's six
 * `commerce.*` names are unchanged.
 *
 * PATH PARAMS ARE UUIDs AT THE EDGE: `ParseUUIDPipe` answers 400 for a
 * non-UUID before any service call, while an id the tenant does not hold
 * remains a 404 from the service (indistinguishable from absent, §3-E).
 *
 * DELIBERATELY ABSENT (R7): `PATCH`, `PUT` and `DELETE` — there is no route
 * that could rewrite or erase a settled receiving event. A correction is a
 * POST that APPENDS a compensating event, which is why the only non-GET route
 * beyond the append is `/compensate` and not an update of anything.
 */
@Controller('commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class ReceivingHistoryController {
  constructor(private readonly receiving: ReceivingHistoryService) {}

  /**
   * The document's WHOLE receipt history beside the per-line receiving
   * projection — ordered, received and `NOT_RECEIVED` /
   * `PARTIALLY_RECEIVED` / `FULLY_RECEIVED` for every line (`commerce.read`).
   */
  @Get(':id/receipts')
  @Roles(Permissions.COMMERCE_READ)
  async listReceipts(@Param('id', ParseUUIDPipe) id: string, @Request() req: ExRequest) {
    return this.receiving.list(resolveCommerceActor(req), id);
  }

  /**
   * Append one receiving event — 201 with the stored row (`commerce.manage`).
   * Over-receipt is refused with 409 against the locked, committed history
   * (R1/R2), never capped and never accepted for later repair.
   */
  @Post(':id/receipts')
  @Roles(Permissions.COMMERCE_MANAGE)
  async appendReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReceiptDto,
    @Request() req: ExRequest
  ) {
    return this.receiving.append(resolveCommerceActor(req), id, dto);
  }

  /**
   * Append the COMPENSATING event — 201 with the stored row
   * (`commerce.manage`). The target is the PATH's `receiptLineId`; a payload
   * cannot point the link at another row, and the original receipt row is
   * never modified (R4).
   */
  @Post(':id/receipts/:receiptLineId/compensate')
  @Roles(Permissions.COMMERCE_MANAGE)
  async compensateReceiptLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('receiptLineId', ParseUUIDPipe) receiptLineId: string,
    @Body() dto: CompensateReceiptLineDto,
    @Request() req: ExRequest
  ) {
    return this.receiving.compensate(resolveCommerceActor(req), id, receiptLineId, dto);
  }
}
