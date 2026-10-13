import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest, Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { ModuleFeatureService } from './module-feature.service';
import type {
  ModuleFeatureGrantRow,
  ModuleFeatureStatePage,
  ModuleFeatureSummary,
} from './module-feature.service';
import {
  DeclareFeatureDto,
  GrantFeatureDto,
  ListFeatureTenantsQueryDto,
  UpdateFeatureDto,
} from './dto/module-feature.dto';

/**
 * Phase 54-C (D14, §43.8): the FROZEN feature-entitlement admin surface — six routes as specified,
 * plus the effective-state read the closure fix added so the console never has to infer a decision.
 *
 * WHY IT HANGS OFF `admin/modules` AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * An operator looks for modules and their features in ONE place, and both permission codes are the
 * registry's EXISTING `admin.modules.read` / `admin.modules.manage`. No new permission code is
 * introduced, so entitlement administration is RBAC-administered with the tools that already exist and
 * no permission matrix has to be re-seeded. Every route carries `@Roles(...)`: on `admin/modules/**` a
 * route that forgets it is a route anyone can call.
 *
 * THIS CONTROLLER IS NOT THE REGISTRY CONTROLLER, though both answer under the same prefix. The
 * registry writes `ModuleRegistration`; this one writes `ModuleFeature` and `ModuleFeatureGrant`, which
 * is why §43.8 places it in the platform's entitlement module rather than adding a second writer to the
 * registry. The prefix is a URL convention, not a shared implementation.
 *
 * NO ROUTE LETS A CALLER CHOOSE THE TENANCY OF THE REQUEST. The tenant ids a grant body names are the
 * SUBJECT of a configuration fact under a manage permission — never the tenancy the request runs as,
 * which Core reads from the authenticated actor and from nothing else. A `?tenantId=` query parameter
 * on any route here is ignored by construction: no handler reads one. The effective-state read added
 * for the closure fix keeps that property and is the reason it reports DECISIONS for enumerated tenants
 * instead of accepting a tenant as an argument: the browser may not name a tenancy, so the server names
 * the tenants and answers about each.
 */
@Controller('admin/modules')
@UseGuards(JwtAuthGuard)
export class ModuleFeatureController {
  constructor(private readonly features: ModuleFeatureService) {}

  /**
   * The continuation cursor of a granted-tenant page, as a response header.
   *
   * A HEADER rather than an envelope because the granted-tenant read answers with the bare array the
   * console's client is typed against; the header is what keeps a multi-page list from being silently
   * truncated. Absent header means "this is the last page".
   */
  static readonly NEXT_CURSOR_HEADER = 'X-Next-Cursor';

  /** `GET admin/modules/:moduleId/features` — the declared features, with granted-tenant counts. */
  @Get(':moduleId/features')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async list(@Param('moduleId') moduleId: string): Promise<ModuleFeatureSummary[]> {
    return this.features.list(moduleId);
  }

  /** `POST admin/modules/:moduleId/features` — declare a feature; it starts `enabled = false`. */
  @Post(':moduleId/features')
  @HttpCode(201)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async declare(
    @Request() req: ExRequest,
    @Param('moduleId') moduleId: string,
    @Body() dto: DeclareFeatureDto
  ): Promise<ModuleFeatureSummary> {
    return this.features.declare(moduleId, dto, this.subject(req));
  }

  /** `PATCH admin/modules/:moduleId/features/:featureId` — rename, or turn the offer on/off. */
  @Patch(':moduleId/features/:featureId')
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('moduleId') moduleId: string,
    @Param('featureId') featureId: string,
    @Body() dto: UpdateFeatureDto
  ): Promise<ModuleFeatureSummary> {
    return this.features.update(moduleId, featureId, dto, this.subject(req));
  }

  /** `GET admin/modules/:moduleId/features/:featureId/tenants` — one bounded page of grants. */
  @Get(':moduleId/features/:featureId/tenants')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async listTenants(
    @Param('moduleId') moduleId: string,
    @Param('featureId') featureId: string,
    @Query() query: ListFeatureTenantsQueryDto,
    @Res({ passthrough: true }) res: Response
  ): Promise<ModuleFeatureGrantRow[]> {
    const page = await this.features.listTenants(moduleId, featureId, query);
    if (page.nextCursor) res.setHeader(ModuleFeatureController.NEXT_CURSOR_HEADER, page.nextCursor);
    return page.rows;
  }

  /**
   * `GET admin/modules/:moduleId/features/:featureId/effective-state` — the AUTHORITATIVE page.
   *
   * The same bounded, cursor-continued shape as the granted-tenant read above, with the same header,
   * because the two answer the same question at two levels of completeness: that route lists grants,
   * this one lists the tenants the module admits PLUS the granted tenants, each with the decision the
   * platform will make for it. The browser derives nothing.
   */
  @Get(':moduleId/features/:featureId/effective-state')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async effectiveState(
    @Param('moduleId') moduleId: string,
    @Param('featureId') featureId: string,
    @Query() query: ListFeatureTenantsQueryDto,
    @Res({ passthrough: true }) res: Response
  ): Promise<ModuleFeatureStatePage> {
    const page = await this.features.listTenantStates(moduleId, featureId, query);
    if (page.nextCursor) res.setHeader(ModuleFeatureController.NEXT_CURSOR_HEADER, page.nextCursor);
    return page;
  }

  /** `POST admin/modules/:moduleId/features/:featureId/tenants` — grant to 1-64 tenants. */
  @Post(':moduleId/features/:featureId/tenants')
  @HttpCode(201)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async grant(
    @Request() req: ExRequest,
    @Param('moduleId') moduleId: string,
    @Param('featureId') featureId: string,
    @Body() dto: GrantFeatureDto
  ): Promise<{ granted: number }> {
    return this.features.grant(moduleId, featureId, dto.tenantIds, this.subject(req));
  }

  /** `DELETE admin/modules/:moduleId/features/:featureId/tenants/:tenantId` — revoke one grant. */
  @Delete(':moduleId/features/:featureId/tenants/:tenantId')
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async revoke(
    @Request() req: ExRequest,
    @Param('moduleId') moduleId: string,
    @Param('featureId') featureId: string,
    @Param('tenantId') tenantId: string
  ): Promise<{ revoked: true }> {
    return this.features.revoke(moduleId, featureId, tenantId, this.subject(req));
  }

  /**
   * The attributed administrator, from the authenticated principal and nothing else — the same shape
   * the registry controller uses, and the reason no audit call in this phase takes an actor argument
   * from a request body.
   */
  private subject(req: ExRequest): string {
    const user = (req as ExRequest & { user?: { sub?: string; userId?: string } }).user;
    return user?.sub ?? user?.userId ?? 'unknown';
  }
}
