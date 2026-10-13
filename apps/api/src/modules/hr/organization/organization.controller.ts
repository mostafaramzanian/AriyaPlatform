import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RequiresModule } from '../../../platform/entitlement/entitlement.contract';
import { HR_MODULE_ID } from '../hr.constants';
import { OrganizationService } from './organization.service';
import { resolveHrActor } from '../hr-actor';
import {
  CreateOrganizationUnitDto,
  ListUnitsQueryDto,
  SetRecordStatusDto,
  UpdateOrganizationUnitDto,
} from '../dto/organization.dto';

/**
 * Phase 51-HR-1: the organization HTTP surface — `/hr/organization`.
 *
 * FOUR ROUTES, TWO PERMISSIONS:
 *   * `hr.organization.read`   — the tree, the summary and the paged unit list;
 *   * `hr.organization.manage` — create, re-parent, rename, (de)activate.
 *
 * WHY THE TREE IS A SEPARATE ROUTE FROM THE LIST
 * ---------------------------------------------
 * `GET /hr/organization` returns the WHOLE tenant hierarchy nested, which is what the
 * org-chart screen draws, and it is bounded (`MAX_UNITS_FOR_TREE`). `GET
 * /hr/organization/units` is the paged, filterable read a picker or an admin table uses.
 * They are different questions with different shapes, and collapsing them would force the
 * picker to download an entire tree to render a dropdown.
 *
 * `GET /hr/organization/summary` is the real aggregate the HR home screen renders
 * (unit / position / employee counts). Every number is a live `COUNT` over the tenant's
 * own rows — a zero means zero, and nothing here is a placeholder.
 *
 * ROUTE ORDER: `summary` and `units` are literal and are declared before any
 * parameterised route, so neither can be shadowed.
 */
// Phase 54-C (D14, §43.6): the module-level entitlement gate, declared on the surface it
// applies to. Authentication and authorization still run first (they are global guards); this
// one answers "is this TENANCY entitled to `hr`?" and refuses with a frozen §43.2 code.
@Controller('hr/organization')
@RequiresModule(HR_MODULE_ID)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  /** The whole tenant hierarchy, nested. Bounded by `MAX_UNITS_FOR_TREE`. */
  @Get()
  @Roles(Permissions.HR_ORGANIZATION_READ)
  async tree(@Request() req: ExRequest) {
    return this.organization.tree(resolveHrActor(req));
  }

  /** Live counts for the HR home screen. */
  @Get('summary')
  @Roles(Permissions.HR_ORGANIZATION_READ)
  async summary(@Request() req: ExRequest) {
    return this.organization.summary(resolveHrActor(req));
  }

  /** The paged, filterable unit list. */
  @Get('units')
  @Roles(Permissions.HR_ORGANIZATION_READ)
  async listUnits(@Request() req: ExRequest, @Query() query: ListUnitsQueryDto) {
    return this.organization.list(resolveHrActor(req), query);
  }

  @Get('units/:id')
  @Roles(Permissions.HR_ORGANIZATION_READ)
  async getUnit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.organization.getOne(resolveHrActor(req), id);
  }

  @Post('units')
  @HttpCode(201)
  @Roles(Permissions.HR_ORGANIZATION_MANAGE)
  async createUnit(@Request() req: ExRequest, @Body() dto: CreateOrganizationUnitDto) {
    return this.organization.create(resolveHrActor(req), dto);
  }

  /**
   * Renames and/or re-parents a unit.
   *
   * A re-parent that would create a cycle is a 409 with a message, produced by the
   * service's ancestor walk; the `OrganizationUnit_no_cycle_guard` trigger makes the same
   * refusal a database guarantee for every other writer.
   */
  @Patch('units/:id')
  @Roles(Permissions.HR_ORGANIZATION_MANAGE)
  async updateUnit(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateOrganizationUnitDto
  ) {
    return this.organization.update(resolveHrActor(req), id, dto);
  }

  @Patch('units/:id/status')
  @Roles(Permissions.HR_ORGANIZATION_MANAGE)
  async setUnitStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SetRecordStatusDto
  ) {
    return this.organization.setStatus(resolveHrActor(req), id, dto.status);
  }
}
