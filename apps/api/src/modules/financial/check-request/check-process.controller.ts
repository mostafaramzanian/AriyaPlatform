import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import type { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { FINANCIAL_FEATURE, FINANCIAL_MODULE_ID } from '../financial.constants';
import { resolveFinancialActor } from '../financial-actor';
import { CHECK_ISSUANCE_DEFINITION_V1 } from '../process/check-issuance.definition';

/**
 * Phase CHECK-ISSUATION — `GET /api/v1/financial/check-process`: the PUBLISHED process
 * definition the wizard renders from (brief §13/§14).
 *
 * WHY ITS OWN CONTROLLER: `CheckRequestController` is namespaced at
 * `financial/check-requests`, where `:id` would otherwise swallow a `process` segment.
 * A sibling resource (`financial/check-process`) keeps both route trees literal and the
 * route order irrelevant.
 *
 * WHAT IT RETURNS: the frozen v1 definition object — steps (title, progress label,
 * order, visibility, field policies), actions (label + capability), document sections
 * (state windows, type vocabularies, required-for gates), transitions and terminal
 * states. THE WIZARD BRANCHES ON THIS, never on `if (status === 6)`: the definition IS
 * the source of truth for what to render, and the row's own `process` projection (from
 * `GET …/:id`) says which pinned version + step applies.
 *
 * NO STATE LIVES HERE: a static, validated, immutable value — the same object
 * `assertProcessPublishable` gated at import time. Reads only, `financial.check.read`,
 * behind the identical entitlement/authentication chain every Financial surface carries.
 */
@Controller('financial/check-process')
@RequiresModule(FINANCIAL_MODULE_ID)
@RequiresFeature(FINANCIAL_MODULE_ID, FINANCIAL_FEATURE.CHECK_REQUEST)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class CheckProcessController {
  /**
   * The published definition, as configuration. The actor is still resolved — one code
   * path for "who is asking" across every Financial route, even though this answer is
   * tenant-independent (the process is a property of the MODULE, not of a tenancy).
   */
  @Get()
  @Roles(Permissions.FINANCIAL_CHECK_READ)
  async getProcess(@Request() req: ExRequest) {
    resolveFinancialActor(req);
    return CHECK_ISSUANCE_DEFINITION_V1;
  }
}
