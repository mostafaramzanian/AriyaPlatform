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
import { LeavePolicyService } from './leave-policy.service';
import { LeavePolicySimulationService } from './leave-policy-simulation.service';
import { resolveHrActor } from '../hr-actor';
import {
  ArchiveLeavePolicyVersionDto,
  CreateLeavePolicyDto,
  CreateLeavePolicyVersionDto,
  ResolveEffectiveLeavePolicyQueryDto,
  UpdateLeavePolicyVersionDto,
} from '../dto/leave-policy.dto';
import { SimulateLeavePolicyVersionDto } from '../dto/leave-policy-simulation.dto';

/**
 * Phase 54-F (§10.3-§10.5, §11, §12, §15): the tenant's leave POLICY authoring surface —
 * `/hr/leave-policies`.
 *
 * WHAT THIS SURFACE IS. `LeaveTypesController` names the KINDS of leave a tenant grants; this
 * surface states what each kind ENTITLES a person to, as a versioned instrument that is authored,
 * validated, published and archived. The two are deliberately different routes with different
 * permissions, because naming a catalogue entry and putting a rule in force against every employee
 * are different acts by different roles.
 *
 * THE CONTROLLER HOLDS NO LIFECYCLE. Every precondition (is this row DRAFT? is this transition
 * legal? does the body validate?) is decided in `LeavePolicyService`, which consults the domain's
 * transition table and the validator. This class' whole job is to translate HTTP into an actor plus
 * a body, and to declare the permission each act needs — a controller that also decided "may this
 * version be published?" would be a second, disagreeing evaluator reachable by a different route.
 *
 * WHAT THE CLIENT MAY NOT CONTROL, AND WHY THERE IS NO ROUTE FOR IT:
 *   * `tenantId` — never a parameter anywhere; it comes from `resolveHrActor(req)` (§24.6).
 *   * the lifecycle state — the routes ARE the transitions (`/validate`, `/publish`, `/archive`), so
 *     a client names an ACT rather than setting a column. There is no `PATCH { status }`.
 *   * the governing version — `/effective` takes a day and a leave type, and NOT a version id (§12).
 *   * the author of a publication — `publishedByEmployeeId` is derived server-side.
 *
 * ONE NAMESPACE, `/hr/leave-policies`, and ONE PERMISSION PAIR: `hr.leave.policy` on the writes and
 * `hr.leave.read` on the reads. The write string is singular rather than a read/manage pair for the
 * reason stated beside it in `permissions.ts`: an administrator who may state the rules is already
 * fully trusted with them, so a read half would grant a string no route gates on.
 *
 * ROUTE ORDER FOLLOWS THE MODULE'S CONVENTION: every literal segment before any `:param`, so
 * `/effective` cannot be swallowed by `/:policyId` and be parsed as a policy whose id is the literal
 * string "effective".
 */
// Phase 54-C (D14, §43.6): policy authoring is the THIRD leaf of the leave feature, and it carries
// both declarations for the same reason the other two do. The question `FEATURE_NOT_GRANTED`
// answers — "did this tenant have leave before it was withheld?" — is a question about the leave
// feature, and a policy that governed nothing before the feature was withheld is not a second
// operator decision.
@Controller('hr/leave-policies')
@RequiresModule(HR_MODULE_ID)
@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)
@UseGuards(ModuleEntitlementGuard)
@UseGuards(JwtAuthGuard)
export class LeavePoliciesController {
  constructor(
    private readonly policiesService: LeavePolicyService,
    private readonly simulationService: LeavePolicySimulationService
  ) {}

  // -- Effective resolution --------------------------------------------------
  // DECLARED FIRST, BEFORE `/:policyId`, for the route-order reason in the class comment.

  /**
   * §12, §15.4: which PUBLISHED version governs this context, and which limits apply?
   *
   * GATED ON `hr.leave.read` RATHER THAN THE AUTHORING STRING, because the question this answers is
   * "what does my tenant grant?", which is exactly what `hr.leave.read` means. An employee filing a
   * request has to be able to see the rule their request is judged against; gating this on the
   * authoring permission would make the rules readable only by those who may rewrite them.
   *
   * `includeArchived` is the ONLY way an ARCHIVED version is returned, and it is off by default: a
   * caller that does not ask for history receives the version in force for new evaluations (§10.5).
   */
  @Get('effective')
  @Roles(Permissions.HR_LEAVE_READ)
  async effective(@Request() req: ExRequest, @Query() query: ResolveEffectiveLeavePolicyQueryDto) {
    return this.policiesService.resolveEffective(resolveHrActor(req), query);
  }

  // -- Policy container ------------------------------------------------------
  // The container carries no rules of its own (§15.1); it is what versions hang from. Creating it is
  // an authoring act, so it takes the authoring permission; reading it takes `hr.leave.read`.

  /** §15.1: creates the policy container. 201 with the stored row. */
  @Post()
  @HttpCode(201)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async createPolicy(@Request() req: ExRequest, @Body() dto: CreateLeavePolicyDto) {
    return this.policiesService.createPolicy(resolveHrActor(req), dto);
  }

  @Get(':policyId')
  @Roles(Permissions.HR_LEAVE_READ)
  async getPolicy(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string
  ) {
    return this.policiesService.getPolicy(resolveHrActor(req), policyId);
  }

  /**
   * The version in force for this policy, or 404 — §10.3's "the version new evaluations resolve to".
   *
   * 404 RATHER THAN AN EMPTY BODY, because "this policy has no published version" is an answer a
   * caller must not confuse with "here is a version": the authoring screens need to distinguish
   * "nothing is in force yet" from "a version was returned", and an empty 200 would make the two
   * look alike.
   */
  @Get(':policyId/published')
  @Roles(Permissions.HR_LEAVE_READ)
  async getPublishedVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string
  ) {
    return this.policiesService.getPublishedVersion(resolveHrActor(req), policyId);
  }

  // -- Authoring (DRAFT only) ------------------------------------------------

  /** Authors a NEW version and its limits. It is born DRAFT and cannot be born anything else. */
  @Post(':policyId/versions')
  @HttpCode(201)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async createVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Body() dto: CreateLeavePolicyVersionDto
  ) {
    return this.policiesService.createVersion(resolveHrActor(req), policyId, dto);
  }

  /**
   * One version with its limits.
   *
   * THIS IS THE HISTORICAL-RESOLUTION READ, and it is gated on `hr.leave.read` because §10.5's
   * guarantee — that a past evaluation can explain itself — needs the version that governed to be
   * readable by whoever is looking at the explanation. It deliberately does NOT refuse an ARCHIVED
   * version: withholding one here would be the opposite of "still resolvable", and this route answers
   * "tell me about THIS version" rather than "which version governs?".
   */
  @Get(':policyId/versions/:versionId')
  @Roles(Permissions.HR_LEAVE_READ)
  async getVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policiesService.getVersion(resolveHrActor(req), policyId, versionId);
  }

  /** Restates a DRAFT. 200 — the version already existed. Any other state is a 409. */
  @Patch(':policyId/versions/:versionId')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async updateVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() dto: UpdateLeavePolicyVersionDto
  ) {
    return this.policiesService.updateVersion(resolveHrActor(req), policyId, versionId, dto);
  }

  // -- Lifecycle -------------------------------------------------------------
  // THE THREE TRANSITIONS ARE ROUTES RATHER THAN A `status` FIELD ON A PATCH, so a client asks for
  // an ACT it may be authorised to perform instead of writing a state machine's edge. Each
  // precondition and the legality of the move are decided in the service from the domain table.

  /** `DRAFT -> VALIDATED` (§10.3, §12.3). A refusal is a 400 carrying the validation report. */
  @Post(':policyId/versions/:versionId/validate')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async validateVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policiesService.validateVersion(resolveHrActor(req), policyId, versionId);
  }

  /**
   * `VALIDATED -> PUBLISHED`, archiving the predecessor IN THE SAME ACT (§10.4, §11).
   *
   * 200 RATHER THAN 201: the version already existed and what changed is its standing. There is no
   * body: the predecessor is found inside the transaction rather than named by the caller, because
   * the rule is "withdraw whatever is in force" and not "withdraw the one you name".
   */
  @Post(':policyId/versions/:versionId/publish')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async publishVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string
  ) {
    return this.policiesService.publishVersion(resolveHrActor(req), policyId, versionId);
  }

  /**
   * `PUBLISHED -> ARCHIVED` — withdrawal WITHOUT a successor, which may leave the policy with
   * nothing in force (§10.3, §11).
   *
   * THE `reason` IS OPTIONAL AND IS AUDITED. It is not required, because §11 permits the transition
   * unconditionally and a mandatory reason would refuse a legal act over a missing sentence; when it
   * is given it travels to the audit entry, which is where an operator reads "why was this
   * withdrawn?" — the same treatment a rejected leave request's reason receives.
   */
  @Post(':policyId/versions/:versionId/archive')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async archiveVersion(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
    @Body() dto: ArchiveLeavePolicyVersionDto
  ) {
    return this.policiesService.archiveVersion(
      resolveHrActor(req),
      policyId,
      versionId,
      dto.reason
    );
  }

  // -- Simulation (§14, D4) --------------------------------------------------

  /**
   * §14's non-mutating simulation: "what would the engine decide under this configuration, and why?"
   *
   * POST RATHER THAN GET, THOUGH NOTHING IS WRITTEN, and the reason is the body: §14's request carries a
   * `ruleSetId`, a version selector, an instant and a typed context, and a GET would have to spell all of
   * that into a query string — where a context object has no honest representation and the parameters
   * end up in access logs. §14's own API shape is `POST …/simulate`, and it is followed.
   *
   * `200`, NOT `201`: nothing is created (§14.1, §23.7 — "simulation produces no snapshot at all").
   *
   * GATED ON `hr.leave.policy`, THE AUTHORING PERMISSION, AND ON NOTHING ELSE (2A). §14.6 makes
   * simulation an administrator's act — "never available to an ordinary employee" — and the authoring
   * permission is exactly the authority to state configuration, so a caller who may rewrite a policy is
   * one who may ask what a hypothetical configuration would do. `hr.leave.read` is deliberately NOT
   * sufficient: reading what is in force is a different capability from interrogating what could be.
   *
   * THE POLICY IS THE ROUTE, so a simulation cannot be run against a policy the caller did not name, and
   * the version selector travels in the BODY rather than the path because a simulation may legitimately
   * ask about the currently effective version *without knowing its id* — which is §14's "defaults to the
   * currently published version".
   *
   * THE CALLER DOES NOT CHOOSE ITS EVIDENCE LEVEL (§13.3, §27.2, §27.6). There is no `level` in the
   * request body; the service derives it from this route's own capability. The reason is that §27.2
   * requires a ROLE-APPROPRIATE PROJECTION rather than "client-side filtering of a fat response", and a
   * caller-selected level is precisely that filtering moved to the server. See
   * `LEAVE_POLICY_SIMULATION_EVIDENCE_LEVEL` for why this route is `HR_ADMIN` and cannot be
   * `PLATFORM_ADMIN`.
   */
  @Post(':policyId/simulate')
  @HttpCode(200)
  @Roles(Permissions.HR_LEAVE_POLICY)
  async simulate(
    @Request() req: ExRequest,
    @Param('policyId', new ParseUUIDPipe({ version: '4' })) policyId: string,
    @Body() dto: SimulateLeavePolicyVersionDto
  ) {
    /**
     * THE ACTOR IS RESOLVED INLINE AS THE FIRST ARGUMENT, matching every other handler on this
     * controller and `hr-isolation.spec.ts` rule 6 — which asserts the shape
     * `.method(resolveHrActor(req), …)` rather than merely "an actor reaches the service". The guard is
     * deliberately strict, so this call is written the way the rule reads rather than relaxing the rule
     * to accommodate a local variable.
     *
     * THE BODY IS MAPPED, NOT FORWARDED. `dto` is a validated request shape and the service takes the
     * application's own input type, so the translation is explicit: the context's own coordinates become
     * the question's coordinates, and the subject's employee id becomes the read's filter. Nothing here
     * decides anything — the flags, the refusals and the arithmetic all live in the service (§14's
     * "business logic stays out of the controller").
     */
    return this.simulationService.resolveAndSimulate(resolveHrActor(req), policyId, {
      ruleSetId: dto.ruleSetId,
      ...(dto.versionId === undefined ? {} : { versionId: dto.versionId }),
      ...(dto.evaluationInstant === undefined ? {} : { evaluationInstant: dto.evaluationInstant }),
      ...(dto.subject === undefined ? {} : { employeeId: dto.subject.employeeId }),
      /**
       * THE DAY IS DERIVED FROM THE INSTANT WHEN THE CALLER NAMED NO RANGE, so a simulation of "what
       * would happen today?" resolves the governance of the SAME day it evaluates on. Reading two clocks
       * — one for the governing-policy day and one for the evaluation instant — is how a simulation
       * reports a decision under a version that was not in force on the day it claims.
       */
      ...(dto.evaluationInstant === undefined ? {} : { asOf: dto.evaluationInstant.slice(0, 10) }),
      leaveTypeId: dto.context.leaveTypeId,
      ...(dto.context.employmentType === undefined
        ? {}
        : { employmentType: dto.context.employmentType }),
      ...(dto.context.requestedFrom === undefined
        ? {}
        : { requestedFrom: dto.context.requestedFrom }),
      ...(dto.context.requestedTo === undefined ? {} : { requestedTo: dto.context.requestedTo }),
    });
  }
}
