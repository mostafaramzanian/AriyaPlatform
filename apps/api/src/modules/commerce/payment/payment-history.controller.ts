import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { COMMERCE_FEATURE, COMMERCE_MODULE_ID } from '../commerce.constants';
import { resolveCommerceActor } from '../commerce-actor';
import { PaymentHistoryService } from './payment-history.service';
import { CompensatePaymentDto, CreatePaymentDto, ListPaymentsQueryDto } from './payment.dto';

/**
 * Phase C1 Step Q (§6, gates §14-F/I7–I9, §10): the three payment routes — and, by the
 * purchase controller's own note, exactly the history that was always meant to hang off
 * `/purchase-documents/:id/…`.
 *
 * THE BOUNDARY IS A MIRROR OF `purchase.controller.ts`, DELIBERATELY: the same
 * `commerce/purchase-documents` controller path (the path names the ROW the calls
 * address — a payment has no meaning apart from the document it settles, so there is no
 * `/payments` collection of its own), the same decorator order, the same actor
 * resolution, and the same absence of rules. `@RequiresModule` + `@RequiresFeature`
 * DECLARE the requirement; the platform's `ModuleEntitlementGuard` decides it;
 * `@Roles` declares who may act; `@UseGuards(JwtAuthGuard)` is LAST so authentication
 * is the innermost check and no entitlement question is ever asked about an
 * anonymous caller.
 *
 * PERMISSIONS (contract Q7): `commerce.read` for the one read, `commerce.manage` for
 * the two writes — the §10 split the purchase routes use. `commerce.approve` stays
 * absent: no payment route decides anything, and Q requires no new permission name.
 *
 * PATH PARAMS ARE UUIDs AT THE EDGE: `ParseUUIDPipe` answers 400 for a non-UUID before
 * any service call, while an id the tenant does not hold remains a 404 from the service
 * (indistinguishable from absent, §3-E).
 *
 * DELIBERATELY ABSENT (§6): `PATCH`, `PUT` and `DELETE` — a status-transition route, a
 * `currency` or `reversesPaymentId` field on any payload, and any payment list outside
 * a document. An empty `POST …/compensate` body is complete by design (§3-D).
 */
@Controller('commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PaymentHistoryController {
  constructor(private readonly payments: PaymentHistoryService) {}

  /**
   * One page of the document's payment history, oldest first, beside the payment
   * status projected over the WHOLE history (`commerce.read`).
   */
  @Get(':id/payments')
  @Roles(Permissions.COMMERCE_READ)
  async listPayments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListPaymentsQueryDto,
    @Request() req: ExRequest
  ) {
    return this.payments.list(resolveCommerceActor(req), id, query);
  }

  /** Append one payment event — 201 with the stored row (`commerce.manage`). */
  @Post(':id/payments')
  @Roles(Permissions.COMMERCE_MANAGE)
  async appendPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePaymentDto,
    @Request() req: ExRequest
  ) {
    return this.payments.append(resolveCommerceActor(req), id, dto);
  }

  /**
   * Append the compensating row — 201 with the stored row (`commerce.manage`). The
   * target is the PATH's `paymentId`; a payload cannot point the link at another row.
   */
  @Post(':id/payments/:paymentId/compensate')
  @Roles(Permissions.COMMERCE_MANAGE)
  async compensatePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: CompensatePaymentDto,
    @Request() req: ExRequest
  ) {
    return this.payments.compensate(resolveCommerceActor(req), id, paymentId, dto);
  }
}
