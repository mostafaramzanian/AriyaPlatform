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
import { ReturnHistoryService } from './return-history.service';
import {
  CreateReturnDto,
  ReceiveBackReturnDto,
  RefundReturnDto,
  ReturnDecisionDto,
} from './return.dto';

/**
 * Phase C1 Step S (contract §7): the SIX return routes — and, by the same
 * note that closed Q's and R's surfaces, not one more.
 *
 *     GET   /commerce/purchase-documents/:id/returns                    commerce.read
 *     POST  /commerce/purchase-documents/:id/returns                    commerce.manage
 *     POST  /commerce/purchase-documents/:id/returns/:returnId/approve  commerce.manage
 *     POST  /commerce/purchase-documents/:id/returns/:returnId/reject   commerce.manage
 *     POST  /commerce/purchase-documents/:id/returns/:returnId/receive-back
 *                                                                       commerce.manage
 *     POST  /commerce/purchase-documents/:id/returns/:returnId/refund   commerce.manage
 *
 * THE BOUNDARY IS A MIRROR OF `receiving-history.controller.ts`,
 * DELIBERATELY: the same `commerce/purchase-documents` controller path (a
 * return has no meaning apart from the document it returned from, so there is
 * no `/returns` collection of its own), the same decorator order
 * (`@RequiresModule` → `@RequiresFeature(PURCHASE)` →
 * `@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)` LAST, so
 * authentication is the innermost check and no entitlement question is asked
 * about an anonymous caller), the same actor resolution, and the same absence
 * of rules.
 *
 * PERMISSIONS (§4-H): `commerce.read` for the one read, `commerce.manage`
 * for the five writes — and NO new name. There is no `commerce.approve` and
 * no `commerce.return.*`: the module's six `commerce.*` names are unchanged,
 * because a route that decides returns is still a purchase-scope act.
 *
 * PATH PARAMS ARE UUIDs AT THE EDGE: `ParseUUIDPipe` answers 400 for a
 * non-UUID before any service call, while an id the tenant does not hold
 * remains a 404 from the service — foreign, wrong-document and unknown are
 * indistinguishable by design (§7's path-parameter rule, no probe).
 *
 * EVERY HANDLER PASSES `resolveCommerceActor(req)` — the ONLY identity
 * source. No DTO below can carry `tenantId`, a requester or an actor id (§4-G):
 * who requested a return and who made each transition are facts this server
 * derives from the session, never facts a payload may state.
 *
 * DELIBERATELY ABSENT (S-D4): `PATCH`, `PUT`, `DELETE`, a cancel route, a
 * reverse-return route and any status-stating route — there is no operation
 * that could rewrite or erase a settled return, because C1-S's correction
 * model is NONE. The only non-GET routes are the creation and the four
 * lifecycle commands, each of which APPENDS a row.
 */
@Controller('commerce/purchase-documents')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class ReturnHistoryController {
  constructor(private readonly returns: ReturnHistoryService) {}

  /**
   * The document's WHOLE return history with lines and transitions, oldest
   * first, unpaged (`commerce.read`). Reads audit nothing; no parent status
   * is consulted (§12.6).
   */
  @Get(':id/returns')
  @Roles(Permissions.COMMERCE_READ)
  async listReturns(@Param('id', ParseUUIDPipe) id: string, @Request() req: ExRequest) {
    return this.returns.list(resolveCommerceActor(req), id);
  }

  /**
   * Append one return document — 201 with the stored view (`commerce.manage`).
   * Over-return is refused with 409 against the LOCKED, serialized histories
   * (S-D1/§9), never capped, never accepted for later repair; one bad line
   * rejects the whole document.
   */
  @Post(':id/returns')
  @Roles(Permissions.COMMERCE_MANAGE)
  async createReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReturnDto,
    @Request() req: ExRequest
  ) {
    return this.returns.create(resolveCommerceActor(req), id, dto);
  }

  /**
   * `REQUESTED -> APPROVED` — 201 with the view AFTER the appended
   * transition (`commerce.manage`). An illegal source state is 409
   * `invalid_transition` with no mutation (§8).
   */
  @Post(':id/returns/:returnId/approve')
  @Roles(Permissions.COMMERCE_MANAGE)
  async approveReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('returnId', ParseUUIDPipe) returnId: string,
    @Body() dto: ReturnDecisionDto,
    @Request() req: ExRequest
  ) {
    return this.returns.approve(resolveCommerceActor(req), id, returnId, dto);
  }

  /**
   * `REQUESTED -> REJECTED` — 201 with the view after the row
   * (`commerce.manage`). The return's own REJECTED state IS the rejection:
   * the parent purchase is untouched (§12.2).
   */
  @Post(':id/returns/:returnId/reject')
  @Roles(Permissions.COMMERCE_MANAGE)
  async rejectReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('returnId', ParseUUIDPipe) returnId: string,
    @Body() dto: ReturnDecisionDto,
    @Request() req: ExRequest
  ) {
    return this.returns.reject(resolveCommerceActor(req), id, returnId, dto);
  }

  /**
   * `APPROVED -> RECEIVED_BACK` — 201 with the view after the row
   * (`commerce.manage`). The empty body is complete by design (§7): the empty
   * DTO is bound HERE so the global pipe refuses a stray field with a 400, and
   * it is deliberately NOT forwarded — the command states nothing to read.
   */
  @Post(':id/returns/:returnId/receive-back')
  @Roles(Permissions.COMMERCE_MANAGE)
  async receiveBackReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('returnId', ParseUUIDPipe) returnId: string,
    @Body() _body: ReceiveBackReturnDto,
    @Request() req: ExRequest
  ) {
    return this.returns.receiveBack(resolveCommerceActor(req), id, returnId);
  }

  /**
   * `RECEIVED_BACK -> REFUNDED` through Q's compensation — 201 with the view
   * after the row (`commerce.manage`). The body names Q's `paymentId`; a Q
   * refusal reaches the caller as 409 `refund_compensation_failed` with NO
   * `REFUNDED` transition written (§4-E).
   */
  @Post(':id/returns/:returnId/refund')
  @Roles(Permissions.COMMERCE_MANAGE)
  async refundReturn(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('returnId', ParseUUIDPipe) returnId: string,
    @Body() dto: RefundReturnDto,
    @Request() req: ExRequest
  ) {
    return this.returns.refund(resolveCommerceActor(req), id, returnId, dto);
  }
}
