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
import { LeaveApprovalService } from './leave-approval.service';
import { resolveHrActor } from '../hr-actor';
import {
  CancelLeaveRequestDto,
  CreateLeaveRequestDto,
  ListLeaveRequestsQueryDto,
  UpdateLeaveRequestDto,
} from '../dto/leave.dto';
import { ApproveLeaveRequestDto, RejectLeaveRequestDto } from '../dto/leave-approval.dto';

/**
 * Phase 51-HR-3A: the leave REQUEST HTTP surface — `/hr/leave-requests`.
 *
 * TWO PERMISSIONS: `hr.leave.read` on every GET and `hr.leave.manage` on every write, the same
 * split as employees, organization, positions and attendance, for the same reason.
 *
 * THE DECISION ROUTES ARRIVED WITH THE RULE THAT MAKES THEM ANSWERABLE (Phase 54-E). This file
 * used to state, correctly, that there was no approve or reject route: deciding a request needs
 * "who is entitled to decide THIS one?", and no authoritative approval rule existed. Phase 54-E
 * supplies it — `LeaveApprovalDefinition`/`LeaveApprovalStepDefinition` configure the flow, the
 * router snapshots it into `LeaveApprovalInstance`/`LeaveApprovalStepInstance`, and
 * `resolvedApproverEmployeeId` is the answer to the question this header said was unanswerable. The
 * routes are added here rather than in a second controller because the URL is the same resource:
 * `/hr/leave-requests/:id` is what is being decided, and splitting the surface would make two
 * controllers claim one aggregate.
 *
 * THEY ARE GATED BY `hr.leave.approve`, NOT `hr.leave.manage`, and that is a THIRD permission rather
 * than a reuse. Managing a request is acting on WHAT WAS ASKED FOR; approving is acting on the
 * FLOW, as a different person, under a rule somebody else configured. Collapsing them would grant
 * every operator who may correct a typo the authority to decide the request, which is the
 * separation §25 exists to keep — and `hr.leave.approve` is seeded precisely so that a tenant can
 * grant one and not the other.
 *
 * THE GUARD ANSWERS "MAY THIS ACTOR APPROVE LEAVE AT ALL"; the service answers "MAY THIS ACTOR
 * APPROVE THIS STEP" (§25.2), by comparing the actor to the step's resolved approver. The controller
 * can do no more than the first, because a guard sees a route and never a step — so the weaker
 * question is asked here and the stronger one in `LeaveApprovalService`.
 *
 * THERE IS NO DELETE ROUTE EITHER. A request is a record of what somebody asked for: one that
 * should not stand is WITHDRAWN (which stamps `cancelled_at` and is audited with a reason),
 * never removed — which is what keeps the trail of the withdrawal itself intact (§10).
 *
 * NO SELF-SERVICE ROUTE (`/hr/leave-requests/me`). "My own leave" needs an authoritative
 * employee→login link; HR stores `userId` as an OPTIONAL, non-unique identifier and this phase
 * does not treat that as a licence to expose a personal surface. Self-service arrives with its
 * own permission and its own phase — the same note `AttendanceController` carries.
 *
 * ROUTE ORDER: literal segments are declared before the parameterised `:id` routes so a literal
 * can never be shadowed, matching `AttendanceController` and `EmployeesController`.
 *
 * THE ACTOR IS ALWAYS SERVER-DERIVED. `resolveHrActor(req)` reads the tenant from
 * `RequestContextService` and throws 403 when the request is not tenant-resolved; no route
 * accepts a `tenantId`, and the global `ValidationPipe` (`whitelist` +
 * `forbidNonWhitelisted`) rejects an attempt to send one.
 */
// Phase 54-C (D14, §43.6): TWO declarations, and the module one is not redundant. A feature is
// only ever reachable BEHIND its module (§43.9), and gate 3 of §43.10 requires every HR
// controller to state the module it needs on its own surface — so `@RequiresModule` is declared
// here as well as `@RequiresFeature`, and the two agree by construction because both name
// `HR_MODULE_ID`. The guard merges them into one question (module, then feature) and refuses
// with a frozen §43.2 code; HR never learns the answer itself.
@Controller('hr/leave-requests')
@RequiresModule(HR_MODULE_ID)
@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class LeaveRequestsController {
  constructor(
    private readonly leave: LeaveService,
    private readonly approvals: LeaveApprovalService
  ) {}

  // -- Reads ----------------------------------------------------------------

  @Get()
  @Roles(Permissions.HR_LEAVE_READ)
  async list(@Request() req: ExRequest, @Query() query: ListLeaveRequestsQueryDto) {
    return this.leave.list(resolveHrActor(req), query);
  }

  @Get(':id')
  @Roles(Permissions.HR_LEAVE_READ)
  async getOne(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.leave.getOne(resolveHrActor(req), id);
  }

  // -- Writes ---------------------------------------------------------------

  /**
   * Submits a request. 201 with the row as it was STORED: `status` and `cancelledAt` come back
   * from the database rather than from the body, because neither is a caller's to choose.
   */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_LEAVE_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateLeaveRequestDto) {
    return this.leave.create(resolveHrActor(req), dto);
  }

  /**
   * Withdraws a pending request. 200 rather than 201 because nothing is created: the call
   * moves the row it addresses from `PENDING` to `CANCELLED`, and the response is that row.
   * A second attempt is a 409 — `CANCELLED` is terminal, so a second withdrawal instant can
   * never overwrite the first.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_MANAGE)
  async cancel(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelLeaveRequestDto
  ) {
    return this.leave.cancel(resolveHrActor(req), id, dto);
  }

  /**
   * Restates a pending request's own content. 200 — the request already existed, and what
   * changes is the row it stands for.
   */
  @Patch(':id')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateLeaveRequestDto
  ) {
    return this.leave.update(resolveHrActor(req), id, dto);
  }

  // -- Approvals — the flow, and the decision (§18) -------------------------

  /**
   * The request's CURRENT flow — the instance, its steps in `order`, and the rule version the
   * decisions are made under.
   *
   * `hr.leave.read` rather than `hr.leave.approve`: SEEING which step is waiting is the same
   * authority as seeing the request, and the approver who may decide it already has both. A flow
   * read gated by the approval permission would make a request's progress invisible to the operator
   * who must answer "why is this stuck?".
   *
   * A request with NO live flow answers `null` rather than a 404 (§18.5) — an ungoverned request is
   * a legitimate state, not a missing one.
   */
  @Get(':id/approval')
  @Roles(Permissions.HR_LEAVE_READ)
  async getApprovalFlow(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string
  ) {
    return this.approvals.getLiveFlow(resolveHrActor(req), id);
  }

  /**
   * Approves the step that is currently `ACTIVE`. 200 rather than 201: nothing is created, and the
   * response states what the decision did to the request, the flow and the step.
   *
   * The decided step is READ from the live flow and never named here (see `ApproveLeaveRequestDto`),
   * which is what stops a later step being decided out of turn.
   */
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_APPROVE)
  async approve(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ApproveLeaveRequestDto
  ) {
    return this.approvals.approve(resolveHrActor(req), id, dto.reason);
  }

  /**
   * Rejects the step that is currently `ACTIVE`, which ENDS the flow wherever it stands. 200, for
   * the same reason as above: the act moves rows that already exist.
   *
   * A SEPARATE ROUTE FROM `approve`, not a flag on it, because the decision is what the permission
   * gates — see the DTO header. It is also what the audit trail names (§49), so `approve` and
   * `reject` are queryable apart.
   */
  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_APPROVE)
  async reject(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectLeaveRequestDto
  ) {
    return this.approvals.reject(resolveHrActor(req), id, dto.reason);
  }
}
