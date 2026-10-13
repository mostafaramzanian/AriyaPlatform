import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
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
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import { PendingDecisionsService } from './pending-decisions.service';

/**
 * PHASE C2 (GAP-1b): `GET /api/v1/commerce/pending-decisions` — the authenticated user's
 * cross-system pending-decision inbox as a PAGED, server-enforced read.
 *
 * THE PATTERN IT FOLLOWS IS EXACTLY THE MODULE'S LIST ROUTE: resolve the actor from the
 * request (never a field), delegate, return `{items, page, pageSize, total}`. There is no
 * user id in the query and no `userId` parameter on the path: "mine" is the session, so
 * querying another user's inbox is not expressible here, only in code the client cannot
 * reach. The route is plural and noun-shaped like every other collection route in this
 * module, reads via `COMMERCE_READ` (it is a view over purchase data — the list convention,
 * not the approver-only gate the DECIDE routes use), and is declared here rather than on
 * the workflow controller because it is a view across TWO decision systems and belongs to
 * neither.
 *
 * Semantics: eligibility comes from the two repositories' predicates (the same the DECIDE
 * routes enforce), ordering is deterministic (createdAt desc, id asc), and a decision
 * between this read and its action becomes 409 on that action — never a stale checkbox.
 */
@Controller('commerce')
@RequiresModule(COMMERCE_MODULE_ID)
@RequiresFeature(COMMERCE_MODULE_ID, COMMERCE_FEATURE.PURCHASE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PendingDecisionsController {
  constructor(private readonly pending: PendingDecisionsService) {}

  @Get('pending-decisions')
  @Roles(Permissions.COMMERCE_READ)
  async list(@Request() req: ExRequest, @Query() query: CommercePageQueryDto) {
    return this.pending.list(resolveCommerceActor(req), query);
  }
}
