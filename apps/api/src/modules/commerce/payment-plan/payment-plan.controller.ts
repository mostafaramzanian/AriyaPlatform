import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
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
import { PaymentPlanService } from './payment-plan.service';
import {
  CancelPaymentPlanDto,
  CreatePaymentPlanDto,
  ExecuteInstallmentDto,
  SupersedePaymentPlanDto,
} from './payment-plan.dto';

/**
 * PAYMENT PLAN: the payment-instruction routes — the same
 * `commerce/purchase-documents` path the payment history hangs off, because a
 * plan likewise has no meaning apart from the document it settles.
 *
 * PERMISSIONS (the §10 split, extended by one decision verb):
 *   read                     `commerce.read`
 *   create/submit/cancel/
 *   supersede/cancel stage/
 *   execute stage            `commerce.manage`  — the same remit as appending
 *                             a payment record;
 *   approve plan / stage     `commerce.approve` — a DECISION, like every other
 *                             approval in the module. The requirements' "each
 *                             later payment needs the group/manager's
 *                             approval" lands on the two `commerce.approve`
 *                             routes and nowhere else.
 *
 * DELIBERATELY ABSENT: `PATCH`, `PUT`, `DELETE` — there is no edit act on a
 * plan or a stage; revision is `supersede`, correction is `cancel`. Path
 * params are UUIDs / ints at the edge; a foreign id stays a 404 from the
 * service.
 */
@Controller('commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PaymentPlanController {
  constructor(private readonly plans: PaymentPlanService) {}

  @Get(':id/payment-plans')
  @Roles(Permissions.COMMERCE_READ)
  async listPlans(@Param('id', ParseUUIDPipe) id: string, @Request() req: ExRequest) {
    return this.plans.list(resolveCommerceActor(req), id);
  }

  @Post(':id/payment-plans')
  @Roles(Permissions.COMMERCE_MANAGE)
  async createPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePaymentPlanDto,
    @Request() req: ExRequest
  ) {
    return this.plans.create(resolveCommerceActor(req), id, dto);
  }

  @Get(':id/payment-plans/:planId')
  @Roles(Permissions.COMMERCE_READ)
  async getPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Request() req: ExRequest
  ) {
    return this.plans.get(resolveCommerceActor(req), id, planId);
  }

  @Post(':id/payment-plans/:planId/submit')
  @Roles(Permissions.COMMERCE_MANAGE)
  async submitPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Request() req: ExRequest
  ) {
    return this.plans.submit(resolveCommerceActor(req), id, planId);
  }

  @Post(':id/payment-plans/:planId/approve')
  @Roles(Permissions.COMMERCE_APPROVE)
  async approvePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Request() req: ExRequest
  ) {
    return this.plans.approve(resolveCommerceActor(req), id, planId);
  }

  @Post(':id/payment-plans/:planId/cancel')
  @Roles(Permissions.COMMERCE_MANAGE)
  async cancelPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CancelPaymentPlanDto,
    @Request() req: ExRequest
  ) {
    return this.plans.cancel(resolveCommerceActor(req), id, planId, dto);
  }

  @Post(':id/payment-plans/:planId/supersede')
  @Roles(Permissions.COMMERCE_MANAGE)
  async supersedePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: SupersedePaymentPlanDto,
    @Request() req: ExRequest
  ) {
    return this.plans.supersede(resolveCommerceActor(req), id, planId, dto);
  }

  @Post(':id/payment-plans/:planId/installments/:seq/approve')
  @Roles(Permissions.COMMERCE_APPROVE)
  async approveInstallment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Request() req: ExRequest
  ) {
    return this.plans.approveInstallment(resolveCommerceActor(req), id, planId, seq);
  }

  @Post(':id/payment-plans/:planId/installments/:seq/cancel')
  @Roles(Permissions.COMMERCE_MANAGE)
  async cancelInstallment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Request() req: ExRequest
  ) {
    return this.plans.cancelInstallment(resolveCommerceActor(req), id, planId, seq);
  }

  @Post(':id/payment-plans/:planId/installments/:seq/execute')
  @Roles(Permissions.COMMERCE_MANAGE)
  async executeInstallment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() dto: ExecuteInstallmentDto,
    @Request() req: ExRequest
  ) {
    return this.plans.executeInstallment(resolveCommerceActor(req), id, planId, seq, dto);
  }
}
