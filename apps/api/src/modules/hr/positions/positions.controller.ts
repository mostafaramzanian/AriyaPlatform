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
import { PositionsService } from './positions.service';
import { resolveHrActor } from '../hr-actor';
import {
  CreatePositionDto,
  ListPositionsQueryDto,
  SetRecordStatusDto,
  UpdatePositionDto,
} from '../dto/organization.dto';

/**
 * Phase 51-HR-1: the position HTTP surface — `/hr/positions`.
 *
 * TWO PERMISSIONS: `hr.positions.read` and `hr.positions.manage`, the same split as
 * employees and organization, for the same reason.
 *
 * NO DELETE ROUTE EXISTS, AND THAT IS THE DESIGN. An employment interval references the
 * position it was held in, so deleting a position would either destroy personnel history
 * (which §10 forbids) or orphan every interval that named it. A position that is no longer
 * used becomes INACTIVE and stays addressable, which is also what makes "this person was a
 * Senior Accountant here from 1399 to 1402" readable after the position is retired.
 *
 * A MOVE IS A PATCH. `organizationUnitId` is editable because moving a slot between units
 * re-labels the position without rewriting anybody's history: the intervals keep pointing
 * at the same position id. An employee's unit is NOT editable this way — that is an
 * effective-dated transfer on `/hr/employees/:id/employment-records`.
 */
// Phase 54-C (D14, §43.6): the module-level entitlement gate, declared on the surface it
// applies to. Authentication and authorization still run first (they are global guards); this
// one answers "is this TENANCY entitled to `hr`?" and refuses with a frozen §43.2 code.
@Controller('hr/positions')
@RequiresModule(HR_MODULE_ID)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @Roles(Permissions.HR_POSITIONS_READ)
  async list(@Request() req: ExRequest, @Query() query: ListPositionsQueryDto) {
    return this.positions.list(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_POSITIONS_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.positions.getOne(resolveHrActor(req), id);
  }

  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_POSITIONS_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreatePositionDto) {
    return this.positions.create(resolveHrActor(req), dto);
  }

  @Patch(':id')
  @Roles(Permissions.HR_POSITIONS_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePositionDto
  ) {
    return this.positions.update(resolveHrActor(req), id, dto);
  }

  @Patch(':id/status')
  @Roles(Permissions.HR_POSITIONS_MANAGE)
  async setStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SetRecordStatusDto
  ) {
    return this.positions.setStatus(resolveHrActor(req), id, dto.status);
  }
}
