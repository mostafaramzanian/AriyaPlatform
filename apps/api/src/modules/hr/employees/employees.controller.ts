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
import { EmployeesService } from './employees.service';
import { EmploymentService } from '../employment/employment.service';
import { resolveHrActor } from '../hr-actor';
import {
  CreateEmployeeDto,
  CreateEmploymentRecordDto,
  SetEmployeeStatusDto,
  TerminateEmploymentDto,
  UpdateEmployeeDto,
} from '../dto/employee.dto';
import { ListEmployeesQueryDto } from '../dto/hr-query.dto';

/**
 * Phase 51-HR-1: the personnel-record HTTP surface — `/hr/employees`.
 *
 * AUTHORIZATION IS TWO PERMISSIONS, NOT FOUR
 * -----------------------------------------
 *   * `hr.employees.read`   — every GET;
 *   * `hr.employees.manage` — every write.
 *
 * Reading personnel data and changing it are genuinely different entitlements, and a
 * third level would be authorization theatre: there is no HR operation here that a
 * manager may read but not write, nor one a writer may not read.
 *
 * THE ACTOR IS ALWAYS SERVER-DERIVED. `resolveHrActor(req)` reads the tenant from
 * `RequestContextService` and throws 403 when the request is not tenant-resolved. There
 * is NO `tenantId` parameter anywhere in this contract, so no route can be made to act
 * on another tenant's records, and the global `ValidationPipe`
 * (`whitelist` + `forbidNonWhitelisted`) rejects an attempt to send one.
 *
 * ROUTE ORDER: literal segments are declared before the parameterised `:id` routes so a
 * literal can never be shadowed, matching `CorrespondenceController` (50) and
 * `SupportController` (49G).
 *
 * WHAT IS DELIBERATELY ABSENT: attendance, leave, mission, overtime and surveys. Those
 * belong to the Lovable HR reference's own feature set, not to this module's domain, and
 * exposing an empty endpoint for each would be a surface that promises data the module
 * does not have.
 */
// Phase 54-C (D14, §43.6): the entitlement declarations sit on the surface they apply to.
// `@RequiresModule` states WHAT this controller needs; `ModuleEntitlementGuard` asks the
// platform whether THIS tenancy is entitled and refuses with the frozen §43.2 code. HR
// DECLARES the requirement and never decides it — entitlement appears in an HR controller or
// `hr.module.ts` and nowhere else in the module.
@Controller('hr/employees')
@RequiresModule(HR_MODULE_ID)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly employment: EmploymentService
  ) {}

  // -- Reads ----------------------------------------------------------------

  @Get()
  @Roles(Permissions.HR_EMPLOYEES_READ)
  async list(@Request() req: ExRequest, @Query() query: ListEmployeesQueryDto) {
    return this.employees.list(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_EMPLOYEES_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.employees.getOne(resolveHrActor(req), id);
  }

  /** The personnel file: every interval this person has ever had, newest first. */
  @Get(':id/employment-records')
  @Roles(Permissions.HR_EMPLOYEES_READ)
  async listEmploymentRecords(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.employment.history(resolveHrActor(req), id);
  }

  // -- Writes ---------------------------------------------------------------

  /** Creates the personnel record AND its first employment interval, atomically. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(resolveHrActor(req), dto);
  }

  @Patch(':id')
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateEmployeeDto
  ) {
    return this.employees.update(resolveHrActor(req), id, dto);
  }

  @Patch(':id/status')
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async setStatus(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SetEmployeeStatusDto
  ) {
    return this.employees.setStatus(resolveHrActor(req), id, dto.status);
  }

  /**
   * TRANSFER / PROMOTION: opens a new interval and closes the current one.
   *
   * A POST to a history collection, not a PATCH to the employee, because the previous
   * interval must survive. The request body carries no effective-from override beyond
   * `startDate`, and no unit or position may be omitted: a partial transfer would be a
   * half-recorded move.
   */
  @Post(':id/employment-records')
  @HttpCode(201)
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async openInterval(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateEmploymentRecordDto
  ) {
    return this.employment.openInterval(resolveHrActor(req), id, dto);
  }

  /** Ends employment. Nothing is deleted; every interval is retained. */
  @Post(':id/terminate')
  @HttpCode(200)
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async terminate(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TerminateEmploymentDto
  ) {
    return this.employment.terminate(resolveHrActor(req), id, dto);
  }

  /** Re-engages a previously terminated employee by APPENDING a new interval. */
  @Post(':id/rehire')
  @HttpCode(201)
  @Roles(Permissions.HR_EMPLOYEES_MANAGE)
  async rehire(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CreateEmploymentRecordDto
  ) {
    return this.employment.rehire(resolveHrActor(req), id, dto);
  }
}
