import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HR_ISO_DATE_PATTERN } from '../hr.constants';
import { TrimmedReason } from './attendance.dto';
import { HR_EMPLOYMENT_TYPES, HrEmploymentType } from './hr-query.dto';
import {
  LEAVE_POLICY_LIMIT_CONSUMED_STATES,
  LEAVE_POLICY_LIMIT_COUNTING_BASES,
  LEAVE_POLICY_LIMIT_PERIODS,
} from '../domain/leave-policy-authoring';

/**
 * Phase 54-F: LEAVE POLICY authoring DTOs — the write contract for policies, versions and limits.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY DTO HERE
 * ----------------------------------------------
 *   * `tenantId` — resolved from the request context (`resolveHrActor`), never sent, exactly as in
 *     `leave.dto.ts`. The global `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`, so an
 *     attempt to send one is a 400 rather than a silently ignored field. §11 forbids a client from
 *     naming the tenant it is writing into;
 *   * `status` — the lifecycle state is the SERVER's (`LEAVE_POLICY_VERSION_TRANSITIONS` in
 *     `domain/leave-policy-version.ts`). A version born `PUBLISHED` would be an act nobody
 *     performed, and the transition table refuses the shortcut anyway;
 *   * `publishedAt` / `publishedByEmployeeId` / `archivedAt` — stamps of the acts that produced
 *     them, set by the service that performs the act. Accepting them here would let a caller claim a
 *     publication that never happened;
 *   * `policyId` on the authoring body — the policy is the ROUTE (`/hr/leave-policies/:policyId`),
 *     so it cannot disagree with the URL it was posted to.
 *
 * WHY THE LIMIT SHAPE REUSES THE DOMAIN VOCABULARIES RATHER THAN RESTATING THEM
 * --------------------------------------------------------------------------
 * `@IsIn(LEAVE_POLICY_LIMIT_CONSUMED_STATES)` and its two siblings make the 400 that a bad
 * vocabulary member earns the SAME list the validator refuses against, so a payload can never be
 * accepted by the pipe and then refused by the validator for the same reason with a different
 * message. The validator still re-checks — it is the guarantee, and the pipe is the courtesy, the
 * same relationship `LeaveRequest_period_check` has with `CreateLeaveRequestDto`.
 */

/** Upper bounds matching the `varchar` widths in `hr_db`, so a 400 precedes a 22001. */
export const MAX_LEAVE_POLICY_NAME_LENGTH = 200;
export const MAX_LEAVE_POLICY_VERSION_LABEL_LENGTH = 200;
export const MAX_LEAVE_POLICY_NOTES_LENGTH = 2000;

/**
 * Bounds on the number of limits one version may carry in a single authoring call.
 *
 * A CAP RATHER THAN NO CAP, and deliberately generous: the limit list is validated in memory
 * (quadratic in the duplicate/overlap checks) and persisted in one transaction, so an unbounded
 * array is a way to make one request expensive. 200 is far beyond any real leave catalogue and
 * turns "somebody sent 100k rows" into a 400 rather than a long transaction holding a policy lock.
 */
export const MAX_LEAVE_POLICY_LIMITS = 200;

const DATE_MESSAGE = 'must be a calendar day in YYYY-MM-DD form, e.g. 2026-03-01';

/**
 * One limit as a caller may AUTHOR it.
 *
 * NO `windowStart`/`windowEnd`, NO `jalaliYear` AND NO DERIVED FIELD. The window is RESOLVED by the
 * server from `period` + the version's own `jalaliYear` through the module's one calendar boundary
 * (`leave-policy-window.ts`), which is what stops a caller from declaring a window that disagrees
 * with the year it claims to govern (§16.2: "the window belongs to the version's own stated Jalali
 * year"). Accepting a client-resolved window would make that agreement unverifiable.
 */
export class LeavePolicyLimitDto {
  /** The leave type this limit counts. Must belong to the actor's tenant (§15.2/§24.3). */
  @IsUUID('4')
  leaveTypeId!: string;

  /**
   * The employment scope, or `null`/absent for "applies to every employment type" (§16.6).
   *
   * TYPED AS THE CLOSED VOCABULARY, NOT AS `string`, because the column this becomes is the Prisma
   * `EmploymentType` enum: a caller sending an undeclared member must be REFUSED by validation rather
   * than carry a `string` down to the repository, where the mismatch would surface either as a cast
   * (silently admitting a value the database rejects) or as a runtime write error. `@IsIn`
   * makes the closed list the runtime check and `HrEmploymentType` makes it the compile-time one, so
   * the two cannot disagree — which is the property `LeavePolicyRepository`'s write widening relies
   * on when it assigns this to the enum without a cast.
   */
  @IsOptional()
  @IsString()
  @IsIn(HR_EMPLOYMENT_TYPES)
  @MaxLength(64)
  employmentType?: HrEmploymentType | null;

  /** §16: an integer maximum greater than zero. */
  @IsInt()
  @Min(1)
  maximum!: number;

  /** §16.1: how the maximum is counted. Mandatory — the server never implies a basis. */
  @IsIn(LEAVE_POLICY_LIMIT_COUNTING_BASES)
  countingBasis!: (typeof LEAVE_POLICY_LIMIT_COUNTING_BASES)[number];

  /** §16.2: the period the maximum applies to. A closed vocabulary. */
  @IsIn(LEAVE_POLICY_LIMIT_PERIODS)
  period!: (typeof LEAVE_POLICY_LIMIT_PERIODS)[number];

  /** §16.4: which request states consume the limit. Required and non-empty. */
  @IsIn(LEAVE_POLICY_LIMIT_CONSUMED_STATES, { each: true })
  @ArrayMinSize(1)
  consumesStates!: (typeof LEAVE_POLICY_LIMIT_CONSUMED_STATES)[number][];

  /** §15.4: the first day this limit is in force. Required. */
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveFrom ${DATE_MESSAGE}` })
  effectiveFrom!: string;

  /** §15.4: the last day, or absent for open-ended. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveTo ${DATE_MESSAGE}` })
  effectiveTo?: string | null;
}

/**
 * Authors a NEW version under an existing policy: `POST /hr/leave-policies/:policyId/versions`.
 *
 * THE VERSION IS BORN `DRAFT` AND THE PAYLOAD SAYS NOTHING ELSE. §11 writes the lifecycle as
 * `DRAFT ──validate──▶ VALIDATED ──publish──▶ PUBLISHED`, so a caller cannot reach either later
 * state by declaring one — it must call the validate and publish routes, and each of those asks its
 * own question.
 *
 * THE LIMIT LIST IS THE WHOLE SET, NOT A PATCH. A version's limits are one fact — the same reason
 * they live in one transaction and one repository — so authoring states them all and a change states
 * them all again. A merge-style body would make "remove limit X" unexpressible without a second
 * verb.
 */
export class CreateLeavePolicyVersionDto {
  /** §10.1/§15: the label identifying this version within its policy. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_POLICY_VERSION_LABEL_LENGTH)
  versionLabel!: string;

  /** §15.4/D10: the Jalali year this version is authored for. Required. */
  @IsInt()
  jalaliYear!: number;

  /** §15.4: the first day the version is in force. Required. */
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveFrom ${DATE_MESSAGE}` })
  effectiveFrom!: string;

  /** §15.4: the last day, or absent for open-ended. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveTo ${DATE_MESSAGE}` })
  effectiveTo?: string | null;

  /**
   * §15.6: the authored body stored alongside the version so an old explanation can be rendered
   * from it (§10.6, §13.2). Stored verbatim — this phase does not interpret it.
   */
  @IsObject()
  payload!: Record<string, unknown>;

  /** The version's limits. May be empty at authoring time; validation decides whether it is enough. */
  @ValidateNested({ each: true })
  @Type(() => LeavePolicyLimitDto)
  @ArrayMaxSize(MAX_LEAVE_POLICY_LIMITS)
  limits!: LeavePolicyLimitDto[];
}

/**
 * Withdraws a published version: `POST /hr/leave-policies/:policyId/versions/:versionId/archive`.
 *
 * WHY THE BODY IS NOT EMPTY, WHEN THE SERVICE TREATS `reason` AS OPTIONAL
 * ---------------------------------------------------------------------
 * Both facts come from the same contract, and they do not conflict. §10.3 classifies archiving as a
 * LIFECYCLE act on a version that is CURRENTLY IN FORCE, and §10.4 is explicit that archiving under
 * a successor is something the PUBLISH does — so this route's meaning is "withdraw the rules with
 * nothing to replace them", which is exactly the case an operator is later asked to explain. §23.5
 * therefore requires the act to be answerable after the fact.
 *
 * The DTO keeps the field OPTIONAL rather than mandating it because the archived predecessor of a
 * publish has no reason at all — the successor's own validation report is the justification — and a
 * required field would force that same null to be spelled as a blank string. The difference is
 * carried by the body's shape, which is what a DTO is for, and the audit entry records a null
 * reason honestly instead of an empty one.
 *
 * NOTHING ELSE IS IN THE BODY. There is no `versionId` (the version is the ROUTE), no `status` (the
 * act IS the transition — see the controller header), and no actor: §16's rule that a client never
 * sends an identity applies here as everywhere else.
 */
/**
 * Withdraws a PUBLISHED version: `POST /hr/leave-policies/:policyId/versions/:versionId/archive`.
 *
 * WHY THE BODY IS OPTIONAL RATHER THAN ABSENT. §11 permits `PUBLISHED -> ARCHIVED` unconditionally,
 * so a mandatory field would refuse a legal act over a missing sentence.
 *
 * THERE IS NO `status` FIELD, and its absence is the point: the route IS the transition, so a client
 * requests the act rather than writing the state machine's target. A `status` here would let a caller
 * name any of the four states on a `PUBLISHED` row, including the two §11 forbids from it.
 */
export class ArchiveLeavePolicyVersionDto {
  /**
   * Why the rules were withdrawn. Trimmed through the module's ONE spelling of a reason
   * (`TrimmedReason`, shared with `CancelLeaveRequestDto` and the approval decisions), so
   * `'   '` cannot be recorded as an explanation anywhere in this module.
   */
  @IsOptional()
  @TrimmedReason()
  reason?: string;
}

/** Creates the POLICY itself — the container whose versions carry the configuration. */
export class CreateLeavePolicyDto {
  /** §15.1: the policy's own code, unique per tenant. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  /** §15.1: the display name. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_POLICY_NAME_LENGTH)
  name!: string;
}

/**
 * Restates a DRAFT version: `PATCH /hr/leave-policies/:policyId/versions/:versionId`.
 *
 * `label`, `jalaliYear` AND `effectiveFrom` ARE ALL EDITABLE WHILE DRAFT, because a draft is
 * authored. They stop being editable the moment the version is validated or published — and that is
 * enforced by the service's transition guard plus the immutability trigger, not by omitting fields
 * here, since a DTO cannot know the row's state.
 *
 * `limits` REPLACES THE WHOLE SET when present. Absent means "leave the limits alone", which is why
 * it is optional rather than defaulting to `[]`: an empty default would silently delete every limit
 * of a version whose title was the only thing being corrected.
 */
export class UpdateLeavePolicyVersionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_POLICY_VERSION_LABEL_LENGTH)
  versionLabel?: string;

  @IsOptional()
  @IsInt()
  jalaliYear?: number;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveFrom ${DATE_MESSAGE}` })
  effectiveFrom?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `effectiveTo ${DATE_MESSAGE}` })
  effectiveTo?: string | null;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LeavePolicyLimitDto)
  @ArrayMaxSize(MAX_LEAVE_POLICY_LIMITS)
  limits?: LeavePolicyLimitDto[];
}

/**
 * Asks "which published version governs this context?": `GET /hr/leave-policies/effective`.
 *
 * THE ONLY INPUTS ARE THE ONES §15.4/§12 AUTHORISE: a day, a leave type, and an employment scope.
 * There is deliberately NO `policyVersionId`, NO `policyId`, NO `status` AND NO `tenantId`, because
 * §12 makes this resolver authoritative — a caller who could name the version would be able to
 * force an ARCHIVED or DRAFT one into service, which is precisely what §10.5's "historically
 * resolvable" guarantee must not become.
 *
 * `asOf` IS OPTIONAL and defaults to the server's today. Defaulting is safe where a caller-supplied
 * value is not: a date is a QUESTION ("as of when?"), and the default answer is unambiguous, whereas
 * a caller-supplied version is an ANSWER to the question this route exists to ask.
 */
export class ResolveEffectiveLeavePolicyQueryDto {
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `asOf ${DATE_MESSAGE}` })
  asOf?: string;

  /** Narrows the resolution to limits of one leave type. Absent means "every type of the policy". */
  @IsOptional()
  @IsUUID('4')
  leaveTypeId?: string;

  /**
   * The employment scope to resolve for. Absent means the query is scoped ONLY by leave type, and
   * the resolver returns every applicable scope rather than guessing one (§16.6: an unscoped limit
   * "applies to every employment type", so absence is a real answer, not a missing input).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  employmentType?: string;

  /**
   * Whether to include a historically ARCHIVED version when no PUBLISHED version covers the day.
   *
   * EXPLICIT AND DEFAULT-FALSE, because the two questions are different (§10.5, §12): "what governs
   * this request?" must never answer with an archived version, while "what did this resolve to back
   * then?" may. A single route serves both so the two answers come from one implementation, and the
   * flag is the caller's acknowledgement that it is asking the second question.
   */
  @IsOptional()
  @IsBoolean()
  includeArchived?: boolean;
}
