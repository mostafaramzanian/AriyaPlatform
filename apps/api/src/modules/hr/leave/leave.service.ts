import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeaveRepository } from './leave.repository';
import { EmployeeRepository } from '../employees/employees.repository';
import { EmploymentRepository } from '../employment/employment.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE, HR_EMPLOYEE_CODE_PATTERN } from '../hr.constants';
import {
  CancelLeaveRequestDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  ListLeaveRequestsQueryDto,
  ListLeaveTypesQueryDto,
  UpdateLeaveRequestDto,
  UpdateLeaveTypeDto,
} from '../dto/leave.dto';
import { resolvePageWindow } from '../dto/hr-query.dto';
import { normalizeEmployeeCode } from '../dto/employee.dto';
import {
  canTransitionLeaveRequest,
  isLeaveRequestRestatable,
  type LeaveRequestStatus,
} from '../domain/leave-status';
import { LeavePolicyService } from '../leave-policy/leave-policy.service';
import {
  evaluateLeaveRequestAgainstLimits,
  type LeaveLimitRuntimePorts,
  type StoredLimitRow,
} from '../leave-policy/leave-limit-runtime';
import { isLeaveLimitEmploymentType, type LeaveLimitConsumedState } from '../domain/leave-policy';
import type { LeaveLimitEvaluation } from '../leave-policy/leave-limit-enforcement';
import type { StoredLeaveLimit } from '../leave-policy/leave-policy.repository';

/**
 * Phase 51-HR-3A: leave — `LeaveRequest` and the tenant's own `LeaveType` catalogue in `hr_db`.
 *
 * WHAT A REQUEST RECORDS, AND WHAT THIS SERVICE REFUSES TO DECIDE
 * ---------------------------------------------------------------
 * A request records WHAT was asked FOR — who, of which type, over which days, and why — and
 * NOTHING about whether it may be granted. There is no `APPROVED` member, no `approverId` and
 * no `decidedAt`, because no authoritative approval rule exists in this repository: the
 * readiness audit sketches "approve/reject for the reporting subtree" and that traversal does
 * not exist, so a decision state nobody can legitimately write would be a promise with a
 * column name rather than a placeholder. `hr.leave.approve` is therefore NOT introduced and NOT
 * seeded — a permission that claims subtree authority before the traversal exists is the widest
 * kind of lie, because it would be GRANTED.
 *
 * The ONE transition that needs no new policy IS implemented: a pending request is WITHDRAWN,
 * by the operator who holds `hr.leave.manage`, through the ordinary HR authorization model. Its
 * legality is stated once, in `domain/leave-status.ts`, and read here through
 * `canTransitionLeaveRequest` rather than re-derived from an `if` in this file.
 *
 * THE FOUR RULES THIS SERVICE OWNS, EACH WITH A DATABASE GUARANTEE BEHIND IT
 * ------------------------------------------------------------------------
 *   1. THE PERIOD IS A REAL PERIOD. `endDate >= startDate` is a 400 here, and
 *      `LeaveRequest_period_check` refuses it in `hr_db` even for a writer that bypasses this
 *      class. A single day is `startDate = endDate`, which is the ordinary case.
 *   2. A REQUEST STATES WHY. `reason` is required, trimmed, and refused when blank — the same
 *      rule `LeaveRequest_reason_check` states with `btrim`.
 *   3. THE PERSON AND THE TYPE ARE THE ACTOR'S OWN. The employee is read through the
 *      tenant-scoped `EmployeeRepository`, the type through this module's tenant-scoped lookup,
 *      and `LeaveRequest_tenant_employee_fkey` / `LeaveRequest_tenant_leave_type_fkey` — BOTH
 *      composite `(tenant_id, …)` keys — make a cross-tenant request impossible to write at all.
 *   4. A WITHDRAWAL IS TERMINAL AND WRITES ITS OWN TIMESTAMP. `status` and `cancelledAt` move
 *      together, in ONE statement, because `LeaveRequest_cancelled_state_check` ties them in
 *      both directions.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, WITH THE PHASE THAT WILL
 * ---------------------------------------------------------
 *   * NO APPROVAL AND NO REJECTION — no permission, no transition and no column exist for them
 *     (see above). They arrive with their authority, their permission and its Core seed row, in
 *     ONE change.
 *   * NO BALANCE, ENTITLEMENT, ACCRUAL OR CARRY-OVER. There is no such column and no such
 *     arithmetic here (§13, and the migration's own list of what it refuses to invent): a
 *     remaining-days number that a support call can contradict is worse than no number.
 *   * NO OVERLAP RULE, AND NONE IS INVENTED HERE. "Leave must not overlap another leave" is
 *     audit §13's PROPOSAL, not an agreed policy; refusing an overlapping range in this service
 *     would refuse legitimate rows (a corrected request, a re-recorded range) in the name of a
 *     rule nobody approved, and a request that looks like a duplicate is therefore ACCEPTED
 *     rather than second-guessed. Both rows are stored RAW so the rule can be evaluated later
 *     against real data, and a constraint added later can carry a deliberate backfill decision
 *     instead of an accidental one.
 *   * NO DAY ARITHMETIC. Which days of a range are working days is a question for the calendar
 *     and the shift; a stored `durationDays` would be a second answer that can disagree.
 *   * NO SELF-SERVICE. "My own leave" needs an authoritative employee→login link, which this
 *     module stores without treating it as a licence to expose a personal surface
 *     (`hr-actor.ts`); self-service arrives with its own permission and its own phase.
 *
 * TENANCY. Every query begins with `actor.tenantId`, an id is only ever read through a
 * tenant-scoped predicate (another tenant's row is a 404, indistinguishable from a missing one),
 * and the writes address the compound `(tenant_id, id)` unique key rather than an id alone.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly leave: LeaveRepository,
    private readonly employees: EmployeeRepository,
    private readonly employment: EmploymentRepository,
    private readonly audit: HrAuditGateway,
    private readonly policies: LeavePolicyService
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The register page, latest period first.
   *
   * The date bounds are resolved HERE rather than in the repository: "which window does the
   * caller mean" is a CALENDAR question, and the persistence layer stays a layer that only knows
   * how to press on `start_date` / `end_date`.
   */
  async list(actor: HrActor, query: ListLeaveRequestsQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);
    const { from, to } = LeaveService.resolveWindow(query);

    const [items, total] = await this.leave.listRequestPage(
      actor.tenantId,
      {
        employeeId: query.employeeId,
        leaveTypeId: query.leaveTypeId,
        status: query.status,
        from,
        to,
      },
      { skip, take }
    );

    return { items: items.map((row) => LeaveService.serialize(row)), total, page, pageSize };
  }

  /** One request, or 404 — another tenant's request is indistinguishable from a missing one. */
  async getOne(actor: HrActor, id: string) {
    const row = await this.leave.findRequestById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Leave request not found');
    return LeaveService.serialize(row);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Submits a request.
   *
   * ORDER OF OPERATIONS IS THE CONTRACT. The employee is verified first (404 for a foreign or
   * unknown id, 409 for a terminated one), then the leave type (404 when it is not the actor's,
   * 409 when it has been retired), then the period, and only then is anything written — so a
   * refusal never leaves a row behind, and the caller is told the FIRST thing that is wrong
   * rather than the last.
   *
   * THE STATUS IS NOT TAKEN FROM THE CALLER, and there is no path here that can produce
   * anything but the initial state: the repository writes it as a constant. A request born
   * APPROVED — on the day that member exists — would be an approval nobody gave.
   */
  async create(actor: HrActor, dto: CreateLeaveRequestDto) {
    const employee = await this.resolveEmployee(actor, dto.employeeId);
    const leaveType = await this.resolveSelectableType(actor, dto.leaveTypeId);
    const { startDate, endDate } = LeaveService.resolvePeriod(dto.startDate, dto.endDate);

    await this.enforceLeaveLimits(actor, employee, leaveType.id, startDate, endDate);

    const row = await this.leave.createRequest(actor.tenantId, {
      employeeId: employee.id,
      leaveTypeId: leaveType.id,
      startDate,
      endDate,
      reason: dto.reason,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: row.id,
      newValue: {
        employeeId: row.employeeId,
        leaveTypeId: row.leaveTypeId,
        startDate: LeaveService.toDayKey(row.startDate),
        endDate: LeaveService.toDayKey(row.endDate),
        reason: row.reason,
        status: row.status,
      },
    });

    return LeaveService.serialize(row);
  }

  /**
   * Phase 54-G: the entitlement decision a submitted request must survive BEFORE it is written.
   *
   * WHY THIS SITS BETWEEN THE VALIDATION AND THE INSERT
   * ---------------------------------------------------
   * §16 is explicit that a limit is "typed policy data that is EVALUATED, never a stored counter",
   * so the only place it can act is where a request enters — and it must act BEFORE
   * `createRequest`, because a request written first and refused second is a stored request the
   * limit did not actually govern. The order in `create` is therefore: WHO (employee), WHAT (type),
   * WHEN (period), WHETHER (this call), THEN the row.
   *
   * THREE OUTCOMES, AND NONE OF THEM IS INVENTED HERE
   * -------------------------------------------------
   *   * UNGOVERNED — §16.7/§21.7 render "no policy has been stated" as exactly that. The request
   *     proceeds with NO entitlement decision: it is neither auto-approved nor auto-rejected, and
   *     no default limit is conjured. This is why the helper returns rather than refusing.
   *   * REFUSED — a limit the request exceeds, or §16.6's insufficient context. Both PREVENT the
   *     insert, and the refusal is thrown as a 409 carrying the typed grounds (limitRef, basis,
   *     maximum, window) rather than a bare message, because "which rule said no" is the answer the
   *     operator actually needs.
   *   * PERMITTED — every applicable limit was evaluated and none was exceeded. The insert follows.
   *
   * THE CLOCK IS THE ONLY SOURCE OF `asOf`. A caller-supplied date would let a request be judged
   * against a policy that does not govern the day it is for, so `now()` is read inside
   * `evaluateLeaveRequestAgainstLimits` and never travels through the DTO. Likewise the governing
   * version is resolved by 54-F's `resolveEffective` from the leave type and the day — no request
   * body can name the configuration that judges it, and there is no bypass flag to pass.
   */
  private async enforceLeaveLimits(
    actor: HrActor,
    employee: { id: string },
    leaveTypeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<void> {
    // §16.6: the employment type is NOT on the employee row — it is declared by the effective-dated
    // `EmploymentRecord` interval COVERING this requested range. Resolving it here (on the domain
    // side, before the engine is asked) is what keeps the generic engine free of calendar and
    // employment-interval arithmetic (D12). `null` means no single interval covers the whole range,
    // which is §16.6's insufficient-context case: it travels through as `null` and is REFUSED by the
    // evaluator for any scoped limit — never widened into a match and never assumed.
    const employmentType = await this.employment.findIntervalCoveringRange(
      actor.tenantId,
      employee.id,
      startDate,
      endDate
    );

    const outcome = await evaluateLeaveRequestAgainstLimits(this.limitPorts(), {
      actor,
      leaveTypeId,
      employeeId: employee.id,
      // §16.6: the closed vocabulary, straight off the covering interval. `null` stays `null` — it
      // means "no employment type can be stated for this range", an insufficient-context case for a
      // scoped limit that must never be widened into a match.
      employmentType,
    });

    // §16.7/§21.7: nothing governs this request, so there is no verdict to give — and giving one
    // anyway (in either direction) would be the default-policy invention this phase forbids.
    if (!outcome.governed) return;

    const refused = [...outcome.undecidable, ...outcome.refusals];
    if (refused.length === 0) return;

    throw new ConflictException(LeaveService.describeLimitRefusal(refused));
  }

  /**
   * The refusal as a message, stated in §16.7's own grounds — `limitRef`, `countingBasis`,
   * `maximum`, `windowStart`, `windowEnd` — plus the count that produced it.
   *
   * THE MESSAGE, NOT THE CONTRACT. `LeaveLimitEvaluation` is the typed answer the caller reasons
   * about; this turns it into the sentence an operator reads, and it is deliberately the ONLY place
   * that does so. §23.5's rule is that a decision must be able to show its arithmetic ("4 of 3"
   * rather than "refused"), so every refusal names the limit, the basis it was counted on, the
   * actual count against the maximum, and the window it was counted over. An insufficient-context or
   * unusable-configuration refusal has no count to show, so it states its own reason instead of a
   * fabricated zero.
   */
  private static describeLimitRefusal(refused: readonly LeaveLimitEvaluation[]): string {
    const lines = refused.map((evaluation) => {
      const head = `leave limit ${evaluation.limitRef}`;

      // Two non-refusable arms exist and mean different things: a REFUSAL carries its own reason
      // (insufficient context, unusable configuration), while `applicable: false` is a limit that
      // simply does not govern this request. A caller that reached here was handed one of the
      // former, but the type carries both, so the distinction is stated rather than assumed — an
      // not-applicable limit has no grounds to print and is named as such instead of fabricated.
      if (!evaluation.refusable) {
        return 'refusal' in evaluation
          ? `${head}: ${evaluation.refusal}`
          : `${head}: not applicable`;
      }

      return (
        `${head}: ${evaluation.count} of ${evaluation.maximum} ` +
        `${evaluation.countingBasis} between ` +
        `${LeaveService.toDayKey(evaluation.windowStart)} and ` +
        `${LeaveService.toDayKey(evaluation.windowEnd)}`
      );
    });

    return `Leave request exceeds the effective policy: ${lines.join('; ')}.`;
  }

  /**
   * The four things the runtime evaluator needs, bound to this service's own collaborators.
   *
   * A METHOD RATHER THAN A STORED FIELD, so the ports are built per evaluation and the module's
   * existing collaborators stay private. `resolveEffective` is passed as a BOUND FUNCTION so the
   * evaluator cannot reach anything else on `LeavePolicyService` — the composition in
   * `leave-limit-runtime.ts` is a function of these four ports and nothing more.
   */
  private limitPorts(): LeaveLimitRuntimePorts {
    return {
      // The resolver answers with the STORED row, whose `employmentType` is the column's own
      // `string | null`. It is validated to the closed vocabulary HERE — at the boundary the
      // enforcement module documents (`isLeaveLimitEmploymentType`) — rather than trusted as a
      // cast, so an unrecognized stored value becomes a refusal the evaluator can state instead of
      // a value the scope rule would silently mismatch against. The extra fields the resolver
      // returns (`policy`, `historical`, …) are structural extras the port does not read.
      resolveEffective: async (actor, query) => {
        const resolution = await this.policies.resolveEffective(actor, query);
        return {
          version: resolution.version === null ? null : { id: resolution.version.id },
          limits: resolution.limits.map(LeaveService.toStoredLimitRow),
          undecidableLimits: resolution.undecidableLimits.map(LeaveService.toStoredLimitRow),
        };
      },
      // The rows arrive with the WIDER `LeaveRequestStatus`; the counting contract takes the
      // narrower `LeaveLimitConsumedState`. The statuses are already predicate-narrowed by the
      // query to the limit's own configured states (validated enforceable before the read), so
      // this is a narrowing of a known-safe value, checked rather than cast.
      findCountableRequests: async (tenantId, filter) => {
        const rows = await this.leave.findCountableRequests(tenantId, filter);
        return rows.map((row) => ({
          id: row.id,
          startDate: row.startDate,
          endDate: row.endDate,
          status: row.status as LeaveLimitConsumedState,
        }));
      },
      now: () => new Date(),
    };
  }

  /**
   * The stored limit row, narrowed to the runtime port's shape — with `employmentType` VALIDATED,
   * not cast.
   *
   * The resolver answers with `StoredLeaveLimit`, whose `employmentType` is the column's own
   * `string | null`. `isLeaveLimitEmploymentType` (the domain's closed-vocabulary guard) turns an
   * unrecognized stored value into `null` — §16.6's "cannot state the type" — so the evaluator
   * REFUSES as insufficient context rather than silently mismatching a value the scope rule cannot
   * recognize. An unchecked cast here would let a database value the vocabulary does not know reach
   * `isLeaveLimitApplicableToEmploymentType`, which answers a refusal only because a caller
   * remembered to route it through; validating at this boundary makes the check unconditional.
   */
  private static toStoredLimitRow(limit: StoredLeaveLimit): StoredLimitRow {
    return {
      id: limit.id,
      policyVersionId: limit.policyVersionId,
      leaveTypeId: limit.leaveTypeId,
      employmentType: isLeaveLimitEmploymentType(limit.employmentType)
        ? limit.employmentType
        : null,
      maximum: limit.maximum,
      countingBasis: limit.countingBasis,
      consumesStates: limit.consumesStates,
      windowStart: limit.windowStart,
      windowEnd: limit.windowEnd,
    };
  }

  /**
   * Restates a request, writing ONLY what actually changed.
   *
   * RESTATABLE IS A FACT ABOUT THE STORED ROW, so it is read from the row and answered by the
   * domain rule rather than by a request field: a withdrawn request is a decision about
   * authority that this phase does not have, so a correction to it is a NEW request — which is
   * also what keeps the trail of the withdrawal intact.
   *
   * THE EFFECTIVE PERIOD IS RESOLVED BEFORE IT IS VALIDATED. Either bound may be sent alone
   * (moving one end is the ordinary edit), so the pair is completed from the stored row FIRST
   * and checked as a pair SECOND — otherwise a half-update that inverts the range would reach
   * `LeaveRequest_period_check` and surface as a 500 instead of a 400.
   *
   * ONLY THE CHANGED FIELDS ARE WRITTEN, and `changedFields` on the audit event is derived from
   * that same comparison, so a PUT-shaped body that restates what is already stored writes nothing
   * and reports nothing: the stored row comes back untouched, with NO statement and NO audit event.
   * An audit row describing an act that did not happen is the failure this avoids — the same early
   * return `PositionsService.setStatus` makes when the state asked for is the state already stored.
   */
  async update(actor: HrActor, id: string, dto: UpdateLeaveRequestDto) {
    const before = await this.leave.findRequestById(actor.tenantId, id);
    if (!before) throw new NotFoundException('Leave request not found');

    if (!isLeaveRequestRestatable(before.status)) {
      throw new ConflictException(
        `A ${before.status} request cannot be restated; submit a new request instead.`
      );
    }

    const startDate =
      dto.startDate !== undefined
        ? LeaveService.parseDay(dto.startDate, 'startDate')
        : before.startDate;
    const endDate =
      dto.endDate !== undefined ? LeaveService.parseDay(dto.endDate, 'endDate') : before.endDate;
    if (endDate < startDate) {
      throw new BadRequestException('endDate must not precede startDate.');
    }

    // "CHANGED" IS DECIDED IN DAYS, not by whether the caller sent the field. A PUT-shaped body that
    // restates the stored period word for word must write NOTHING: otherwise every such call moves
    // `updated_at` on a row that did not change, and anything reading that column — a report, an
    // incremental sync, a concurrency check — sees an edit nobody made. The comparison is the same
    // one `changedFields` below makes, so the statement and the trail cannot disagree about what
    // happened.
    const periodChanged = {
      startDate: LeaveService.toDayKey(startDate) !== LeaveService.toDayKey(before.startDate),
      endDate: LeaveService.toDayKey(endDate) !== LeaveService.toDayKey(before.endDate),
    };

    const leaveTypeId = dto.leaveTypeId;
    if (leaveTypeId !== undefined && leaveTypeId !== before.leaveTypeId) {
      await this.resolveSelectableType(actor, leaveTypeId);
    }
    if (
      leaveTypeId === undefined &&
      dto.startDate === undefined &&
      dto.endDate === undefined &&
      dto.reason === undefined
    ) {
      throw new BadRequestException('Nothing to update: send at least one field.');
    }

    const patch = {
      ...(leaveTypeId !== undefined && leaveTypeId !== before.leaveTypeId ? { leaveTypeId } : {}),
      ...(periodChanged.startDate ? { startDate } : {}),
      ...(periodChanged.endDate ? { endDate } : {}),
      ...(dto.reason !== undefined && dto.reason !== before.reason ? { reason: dto.reason } : {}),
    };

    // NOTHING CHANGED, SO THERE IS NO ACT: no statement and no audit event — the same early return
    // `PositionsService.setStatus` makes when the status asked for is the status already stored. An
    // audit row describing an act that did not happen is the failure this avoids, and the stored row
    // is the truthful answer to a restatement that restated nothing.
    if (Object.keys(patch).length === 0) return LeaveService.serialize(before);

    const row = await this.leave.updateRequest(actor.tenantId, id, patch);

    const changedFields = [
      ...(row.leaveTypeId !== before.leaveTypeId ? ['leaveTypeId'] : []),
      ...(LeaveService.toDayKey(row.startDate) !== LeaveService.toDayKey(before.startDate)
        ? ['startDate']
        : []),
      ...(LeaveService.toDayKey(row.endDate) !== LeaveService.toDayKey(before.endDate)
        ? ['endDate']
        : []),
      ...(row.reason !== before.reason ? ['reason'] : []),
    ];

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: row.id,
      oldValue: {
        leaveTypeId: before.leaveTypeId,
        startDate: LeaveService.toDayKey(before.startDate),
        endDate: LeaveService.toDayKey(before.endDate),
        reason: before.reason,
      },
      newValue: {
        leaveTypeId: row.leaveTypeId,
        startDate: LeaveService.toDayKey(row.startDate),
        endDate: LeaveService.toDayKey(row.endDate),
        reason: row.reason,
      },
      changedFields,
    });

    return LeaveService.serialize(row);
  }

  /**
   * Withdraws a pending request: `PENDING -> CANCELLED`, the one transition this phase owns.
   *
   * THE LEGALITY IS ASKED OF THE DOMAIN, NOT ASSUMED. `canTransitionLeaveRequest` reads the table
   * in `domain/leave-status.ts`, so this method states WHAT the act is and the domain states
   * WHETHER it is possible — which is what keeps the service and the migration's
   * `LeaveRequest_cancelled_state_check` from drifting apart when approval lands.
   *
   * A WITHDRAWN REQUEST CANNOT BE WITHDRAWN AGAIN: `CANCELLED` has an EMPTY transition list
   * rather than no entry, so a second attempt is a 409 that says so instead of a silent success
   * that would write a second withdrawal instant over the first.
   *
   * THE REASON GOES TO THE TRAIL, NOT TO THE ROW — see `CancelLeaveRequestDto`: a withdrawal is
   * an event, the row has no column for one, and §13's shape for "an act that overrides
   * somebody's own record" is actor + stated reason + audit event.
   */
  async cancel(actor: HrActor, id: string, dto: CancelLeaveRequestDto) {
    const before = await this.leave.findRequestById(actor.tenantId, id);
    if (!before) throw new NotFoundException('Leave request not found');

    const target: LeaveRequestStatus = 'CANCELLED';
    if (!canTransitionLeaveRequest(before.status, target)) {
      throw new ConflictException(
        `A ${before.status} request cannot be withdrawn; a withdrawn request is terminal.`
      );
    }

    const row = await this.leave.cancelRequest(actor.tenantId, id, new Date());

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CANCEL,
      resource: HR_AUDIT_RESOURCE.LEAVE,
      resourceId: row.id,
      oldValue: { status: before.status, cancelledAt: null },
      newValue: {
        status: row.status,
        cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      },
      changedFields: ['status', 'cancelledAt'],
      reason: dto.reason,
    });

    return LeaveService.serialize(row);
  }

  // -------------------------------------------------------------------------
  // The type catalogue
  // -------------------------------------------------------------------------

  /** One page of the tenant's OWN catalogue. */
  async listTypes(actor: HrActor, query: ListLeaveTypesQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);

    const [items, total] = await this.leave.listTypePage(
      actor.tenantId,
      { status: query.status, search: query.search },
      { skip, take }
    );

    return { items, total, page, pageSize };
  }

  /** One catalogue entry, or 404 — another tenant's entry is a missing one. */
  async getType(actor: HrActor, id: string) {
    const row = await this.leave.findTypeById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Leave type not found');
    return row;
  }

  /**
   * Adds an entry to the tenant's own catalogue.
   *
   * THE CODE IS NORMALISED BEFORE THE UNIQUENESS PRE-CHECK, not after: checking the raw value
   * would let `annual` pass and then collide with a stored `ANNUAL` at the unique index, which is
   * a 500 for a caller who did nothing wrong. Same ordering rule — and the same helper — as
   * `EmployeesService`, because `LeaveType_tenantId_code_key` is unique on the NORMALISED value.
   *
   * The pre-check makes the ordinary duplicate a comprehensible 409; the index stays the arbiter,
   * and the loser of a genuine race is translated to the SAME 409 by `createTypeOrConflict`
   * instead of surfacing as a 500.
   */
  async createType(actor: HrActor, dto: CreateLeaveTypeDto) {
    const code = normalizeEmployeeCode(dto.code);
    if (!HR_EMPLOYEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException(
        'code must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"'
      );
    }

    const existing = await this.leave.findTypeByCode(actor.tenantId, code);
    if (existing) {
      throw new ConflictException(`This organization already has a leave type coded ${code}.`);
    }

    const row = await this.createTypeOrConflict(actor, code, dto.name);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_TYPE,
      resourceId: row.id,
      newValue: { code: row.code, name: row.name, status: row.status },
    });

    return row;
  }

  /**
   * Renames an entry, or takes it out of use and puts it back.
   *
   * RETIREMENT IS A STATUS AND NEVER A DELETE: `INACTIVE` stops a type from being chosen for a
   * NEW request while every request already recorded against it keeps rendering its name — and a
   * type that has been requested is `ON DELETE RESTRICT` in `hr_db` in any case. This update path
   * is therefore the ONLY way an entry leaves use, which is why it exists in this phase at all.
   *
   * `code` is not updatable — see `UpdateLeaveTypeDto`: it is the key the tenant's own reports and
   * imports cite, so renaming it is a new entry rather than an edit.
   */
  async updateType(actor: HrActor, id: string, dto: UpdateLeaveTypeDto) {
    const before = await this.leave.findTypeById(actor.tenantId, id);
    if (!before) throw new NotFoundException('Leave type not found');

    if (dto.name === undefined && dto.status === undefined) {
      throw new BadRequestException('Nothing to update: send name or status.');
    }

    const row = await this.leave.updateType(actor.tenantId, id, {
      ...(dto.name !== undefined && dto.name !== before.name ? { name: dto.name } : {}),
      ...(dto.status !== undefined && dto.status !== before.status ? { status: dto.status } : {}),
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_TYPE,
      resourceId: row.id,
      oldValue: { name: before.name, status: before.status },
      newValue: { name: row.name, status: row.status },
      changedFields: [
        ...(row.name !== before.name ? ['name'] : []),
        ...(row.status !== before.status ? ['status'] : []),
      ],
    });

    return row;
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  /**
   * The employee a request may be written for, or a refusal.
   *
   * THE ORDER OF THE TWO REFUSALS IS THE SAME AS `AttendanceService.resolveEmployee`, on
   * purpose: a foreign or unknown id is a 404 (indistinguishable, so ids cannot be probed),
   * and a TERMINATED person is a 409 — their employment has ended, so a leave request for them
   * is a data-entry error rather than a claim about the organization's work. `INACTIVE` is
   * allowed for the reason stated there: it is an administrative label for a record currently
   * out of use, and somebody on long-term leave is exactly that.
   *
   * `EmployeeRepository.findById` is tenant-scoped, so this is also where
   * `LeaveRequest_tenant_employee_fkey` gets its service-side counterpart: the composite key is
   * the guarantee, and this read is what makes the ordinary case a comprehensible error rather
   * than a raw foreign-key violation.
   */
  private async resolveEmployee(actor: HrActor, employeeId: string) {
    const employee = await this.employees.findById(actor.tenantId, employeeId);
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === 'TERMINATED') {
      throw new ConflictException(
        'Leave cannot be recorded for a terminated employee; rehire the person first.'
      );
    }
    return employee;
  }

  /**
   * The leave type a request may name, or a refusal.
   *
   * A RETIRED TYPE IS A 409 AND NOT A 404. The row still exists and is still addressable —
   * every request recorded against it must keep rendering its name — so pretending it is
   * missing would be a lie about the catalogue; what is refused is its use for a NEW or
   * RESTATED request, which is exactly what `INACTIVE` means (`LeaveType.status`). A type of
   * another tenant is absent rather than forbidden, because the lookup is tenant-scoped, and
   * gets the 404 a nonexistent id gets.
   *
   * The lookup is the module's OWN tenant-scoped read rather than a presence check issued from
   * here: the service asks a question the persistence layer already knows how to scope, so the
   * tenancy rule is not restated.
   */
  private async resolveSelectableType(actor: HrActor, leaveTypeId: string) {
    const leaveType = await this.leave.findTypeById(actor.tenantId, leaveTypeId);
    if (!leaveType) throw new NotFoundException('Leave type not found');
    if (leaveType.status !== 'ACTIVE') {
      throw new ConflictException(
        `Leave type ${leaveType.code} is ${leaveType.status} and cannot be chosen for a request.`
      );
    }
    return leaveType;
  }

  /**
   * The INSERT, with the loser of a concurrent create translated to the same 409 the
   * pre-check produces.
   *
   * The pre-check in `createType` makes the ordinary duplicate a comprehensible error; the
   * unique index `LeaveType_tenantId_code_key` is the ARBITER, and two concurrent creates can
   * both find nothing. A race must not surface as a 500 for a caller who did nothing wrong.
   * The same fix as `PositionsService.createPositionOrConflict` and
   * `AttendanceService.createPunch`, for the same reason.
   */
  private async createTypeOrConflict(actor: HrActor, code: string, name: string) {
    try {
      return await this.leave.createType(actor.tenantId, { code, name });
    } catch (err) {
      if (LeaveService.isUniqueViolation(err)) {
        throw new ConflictException(`This organization already has a leave type coded ${code}.`);
      }
      throw err;
    }
  }

  /**
   * The register's date window, resolved once.
   *
   * Both bounds are GREGORIAN `YYYY-MM-DD` days, resolved to the UTC midnight instant Prisma
   * stores for a `@db.Date` column, and they mean INTERSECTION with a request's own period
   * (see `LeaveRepository.listRequestPage`) — not containment, which would hide a long request
   * that swallows the window whole.
   *
   * The FORMAT is validated by the DTO (`HR_ISO_DATE_PATTERN`) and the DATE ITSELF here, so a
   * well-shaped but nonexistent day such as `2026-02-31` is a 400 rather than a filter that
   * silently matches nothing. An inverted window is refused for the same reason
   * `LeaveRequest_period_check` refuses an inverted request: the two bounds describe ONE range,
   * and there is no range in which the later day precedes the earlier one.
   */
  private static resolveWindow(query: ListLeaveRequestsQueryDto): { from?: Date; to?: Date } {
    const from = query.from ? LeaveService.parseDay(query.from, 'from') : undefined;
    const to = query.to ? LeaveService.parseDay(query.to, 'to') : undefined;

    if (from && to && to < from) {
      throw new BadRequestException('to must not precede from.');
    }

    return { from, to };
  }

  /**
   * A submitted period, resolved to the pair of `@db.Date` days, or a refusal.
   *
   * THE PAIR IS CHECKED AS A PAIR, before anything is written, so an inverted range is a 400
   * from the service rather than a 500 from `LeaveRequest_period_check`. A single day is
   * `startDate = endDate` and is the ordinary case rather than a special one.
   *
   * No arithmetic happens: how many WORKING days the range contains is a question for the
   * calendar and the shift (§13), and a `durationDays` computed here would be a second answer
   * that can disagree with them.
   */
  private static resolvePeriod(startDate: string, endDate: string) {
    const from = LeaveService.parseDay(startDate, 'startDate');
    const to = LeaveService.parseDay(endDate, 'endDate');

    if (to < from) {
      throw new BadRequestException('endDate must not precede startDate.');
    }

    return { startDate: from, endDate: to };
  }

  /**
   * `YYYY-MM-DD` → the UTC midnight instant Prisma stores for a `@db.Date` column.
   *
   * The DTO's `Matches` guarantees the SHAPE; this guards the remaining hole in it — a well-shaped
   * but NONEXISTENT day such as `2026-02-31`. `Date` does not answer `NaN` for that string: the ISO
   * parser accepts day 31 in any month and ROLLS IT OVER, so the naive parse above would store
   * `2026-03-03` for a request that asked for the 31st of February — a silently WRONG day on a
   * leave record. The day is therefore read back through `toDayKey` and compared with what was
   * sent, which is the only check that distinguishes an existing day from a rolled-over one.
   *
   * The same split as `AttendanceService.parseGregorianDay` — shape in the DTO, day here — with the
   * round trip added, because the shape check alone would let a wrong day through. The DTO pattern
   * is `^\d{4}-\d{2}-\d{2}$`, so a value this accepts is always a canonical day key.
   */
  private static parseDay(value: string, field: string): Date {
    const day = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime()) || LeaveService.toDayKey(day) !== value) {
      throw new BadRequestException(`${field} must be a real YYYY-MM-DD date`);
    }
    return day;
  }

  /**
   * The wire view of a request: `startDate` and `endDate` are DAYS, not instants.
   *
   * `@db.Date` columns ARE calendar days; their `Date` objects are an artifact of the driver,
   * and emitting them as `2026-09-18T00:00:00.000Z` would hand the caller a timestamp that
   * reads as "midnight UTC" to somebody in Tehran — the exact ambiguity the whole-day contract
   * exists to remove. The module's other date-only columns already read this way
   * (`AttendanceService.serialize`, `serializeEmploymentRecord`), so a leave request reads the
   * same as a personnel file or a register row. `cancelledAt` stays an ISO INSTANT: it is a
   * moment, and a moment stripped of its offset is a different moment.
   *
   * Applied at the BOUNDARY only — the six returns in this class. The rules, the repository and
   * the audit payloads keep working with the stored `Date`, so nothing that compares or writes
   * DAYS can be handed a string.
   */
  private static serialize<T extends { startDate: Date; endDate: Date }>(row: T) {
    return {
      ...row,
      startDate: LeaveService.toDayKey(row.startDate),
      endDate: LeaveService.toDayKey(row.endDate),
    };
  }

  /** `YYYY-MM-DD` for a stored `@db.Date`, read back in UTC so the day never shifts. */
  private static toDayKey(day: Date): string {
    return day.toISOString().slice(0, 10);
  }

  /**
   * The Prisma unique-constraint code.
   *
   * Read structurally rather than by importing a Prisma error type: this module reaches its
   * database through `HrPrismaService` and deliberately imports nothing from the generated
   * client, which is what keeps a Core client from being reachable here at all (see
   * `hr-isolation.spec.ts`). `AttendanceService` and Core's `integration.service.ts` use the
   * same shape.
   */
  private static isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }
}
