import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { RequiresModule } from '../../../platform/entitlement/entitlement.contract';
import { HR_MODULE_ID } from '../hr.constants';
import { AttendanceService } from './attendance.service';
import { resolveHrActor } from '../hr-actor';
import {
  AdjustAttendanceDto,
  ClockInDto,
  ClockOutDto,
  ListAttendanceQueryDto,
} from '../dto/attendance.dto';

/**
 * Phase 51-HR-3: the attendance HTTP surface — `/hr/attendance`.
 *
 * TWO PERMISSIONS: `hr.attendance.read` on every GET and `hr.attendance.manage` on every
 * write, the same split as employees, organization and positions, for the same reason.
 *
 * THERE IS NO SELF-SERVICE ROUTE (`/hr/attendance/me`), AND ITS ABSENCE IS THE DESIGN.
 * "My own attendance" needs an authoritative employee→login link; HR stores `userId` as
 * an OPTIONAL, non-unique identifier and this phase does not treat that as a licence to
 * expose a personal surface (see the note in the Core seed migration and `hr-actor.ts`).
 * An ungated route would also contradict this module's rule that EVERY HR route carries
 * an `hr.*` permission — a rule `hr-isolation.spec.ts` enforces mechanically. Self-service
 * arrives with its own permission and its own phase.
 *
 * THERE IS NO DELETE ROUTE EITHER. Attendance is evidence: a punch that should not count
 * is CORRECTED (a `MANUAL` row stating why, §13), never removed — which is what makes the
 * register answer "what did we know, and when did we know it" rather than only "what do
 * we say now".
 *
 * ROUTE ORDER: literal segments (`clock-in`, `adjustments`) are declared before the
 * parameterised `:id` routes so a literal can never be shadowed, matching
 * `EmployeesController`, `CorrespondenceController` (50) and `SupportController` (49G).
 *
 * THE ACTOR IS ALWAYS SERVER-DERIVED. `resolveHrActor(req)` reads the tenant from
 * `RequestContextService` and throws 403 when the request is not tenant-resolved; no
 * route accepts a `tenantId`, and the global `ValidationPipe`
 * (`whitelist` + `forbidNonWhitelisted`) rejects an attempt to send one.
 */
// Phase 54-C (D14, §43.6): the module-level entitlement gate, declared on the surface it
// applies to. Authentication and authorization still run first (they are global guards); this
// one answers "is this TENANCY entitled to `hr`?" and refuses with a frozen §43.2 code.
@Controller('hr/attendance')
@RequiresModule(HR_MODULE_ID)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // -- Reads ----------------------------------------------------------------

  @Get()
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListAttendanceQueryDto) {
    return this.attendance.list(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_ATTENDANCE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.attendance.getOne(resolveHrActor(req), id);
  }

  // -- Writes ---------------------------------------------------------------

  /**
   * Opens a day. `clockIn` may be omitted — the punch path means "now" — and the day the
   * row belongs to is DERIVED from the instant, never sent.
   */
  @Post('clock-in')
  @HttpCode(201)
  @Roles(Permissions.HR_ATTENDANCE_MANAGE)
  async clockIn(@Request() req: ExRequest, @Body() dto: ClockInDto) {
    return this.attendance.clockIn(resolveHrActor(req), dto);
  }

  /**
   * Records the one MANUAL correction for an employee-day. 200 rather than 201 because
   * the call is idempotent per day: it either creates the correction or restates it, and
   * the response is the single row that now stands for that day.
   */
  @Post('adjustments')
  @HttpCode(200)
  @Roles(Permissions.HR_ATTENDANCE_MANAGE)
  async adjust(@Request() req: ExRequest, @Body() dto: AdjustAttendanceDto) {
    return this.attendance.adjust(resolveHrActor(req), dto);
  }

  /** Closes an open day. The id is the punch; the body carries at most the instant. */
  @Post(':id/clock-out')
  @HttpCode(200)
  @Roles(Permissions.HR_ATTENDANCE_MANAGE)
  async clockOut(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ClockOutDto
  ) {
    return this.attendance.clockOut(resolveHrActor(req), id, dto);
  }
}
