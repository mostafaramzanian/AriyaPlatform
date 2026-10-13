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
import {
  RequiresFeature,
  RequiresModule,
} from '../../../platform/entitlement/entitlement.contract';
import { HR_FEATURE, HR_MODULE_ID } from '../hr.constants';
import { LeaveService } from './leave.service';
import { resolveHrActor } from '../hr-actor';
import { CreateLeaveTypeDto, ListLeaveTypesQueryDto, UpdateLeaveTypeDto } from '../dto/leave.dto';

/**
 * Phase 51-HR-3A: the tenant's OWN leave catalogue — `/hr/leave-types`.
 *
 * WHY THIS SURFACE EXISTS AT ALL. Nothing is seeded, anywhere: which leave kinds an
 * organization grants — annual, sick, unpaid, and what each one ENTITLES a person to — is that
 * organization's own policy. A taxonomy invented in a migration or a seed would be worn as a
 * default by every tenant that did not replace it, and a default that affects somebody's pay is
 * not a convenience. So the tenant names its own types here, and until it does the leave screen
 * offers nothing to request OF — the honest rendering of "no policy has been stated yet".
 *
 * ONE PERMISSION PAIR, THE SAME AS EVERYWHERE IN THIS MODULE: `hr.leave.read` on the reads and
 * `hr.leave.manage` on the writes. A separate `hr.leave.types.*` pair would let a tenant grant
 * "may record leave" while withholding "may name the kinds of leave", which is not a distinction
 * this phase has any rule about — and a permission that no rule expresses is a promise the
 * enforcement does not keep.
 *
 * THERE IS NO DELETE ROUTE. `LeaveRequest_tenant_leave_type_fkey` is `ON DELETE RESTRICT`, so a
 * type that has ever been requested cannot be removed from under its own history; retirement is
 * a STATUS (`INACTIVE`), which is what lets a historical request keep rendering the name of the
 * leave it was recorded under while the entry is unavailable for anything new.
 *
 * THERE IS NO `code` IN THE PATCH BODY. A catalogue code is an identity node, exactly as it is
 * on `OrganizationUnit`: `name` and `status` move, and renaming the key a tenant's own reports
 * and imports cite is a NEW entry rather than an edit.
 *
 * ROUTE ORDER, THE ACTOR, AND THE PERMISSIONS follow `LeaveRequestsController` exactly —
 * literals before `:id`, and the actor always server-derived.
 */
// Phase 54-C (D14, §43.6): the leave catalogue is the SECOND leaf of the same feature. It
// carries both declarations for the same reason `LeaveRequestsController` does — `hr.leave.read`
// and `hr.leave.manage` are the same permission pair as the requests surface, and whether a
// tenant HAD the leave catalogue before it was withheld is exactly the question
// `FEATURE_NOT_GRANTED` answers. The catalogue is not a second feature: one feature, one
// operator decision.
@Controller('hr/leave-types')
@RequiresModule(HR_MODULE_ID)
@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class LeaveTypesController {
  constructor(private readonly leave: LeaveService) {}

  // -- Reads ----------------------------------------------------------------

  @Get()
  @Roles(Permissions.HR_LEAVE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListLeaveTypesQueryDto) {
    return this.leave.listTypes(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_LEAVE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.leave.getType(resolveHrActor(req), id);
  }

  // -- Writes ---------------------------------------------------------------

  /** Adds an entry. 201 with the stored row, including the lifecycle state it was born in. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_LEAVE_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateLeaveTypeDto) {
    return this.leave.createType(resolveHrActor(req), dto);
  }

  /** Renames the entry, retires it, or returns it to use. 200 — the entry already existed. */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateLeaveTypeDto
  ) {
    return this.leave.updateType(resolveHrActor(req), id, dto);
  }
}
