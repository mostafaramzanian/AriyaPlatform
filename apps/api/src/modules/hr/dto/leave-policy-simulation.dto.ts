import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HR_ISO_DATE_PATTERN } from '../hr.constants';
import { LEAVE_LIMIT_RULE_SET_ID } from '../domain/leave-policy';

/**
 * Phase 54-H (§14, §24, §25): the SIMULATION request contract — `POST …/simulate`.
 *
 * WHAT §14 ASKS FOR, AND HOW THE SHAPE BELOW HONOURS IT
 * ----------------------------------------------------
 * §14 freezes the semantics and calls the naming indicative:
 *
 *     { ruleSetId, version?, evaluationInstant?, context, subject?: { employeeId } }
 *
 * Every member is present. `ruleSetId` is a bounded `string` rather than a closed `@IsIn`, because
 * this phase owns exactly ONE rule set and the service refuses any other — validation must not become
 * a second place where the rule-set identity is spelled, which is the drift
 * `leave-policy.spec.ts`'s "single namespaced constant, so three sites cannot drift" test exists to
 * prevent.
 *
 * WHAT IS DELIBERATELY ABSENT, AS A SHAPE RATHER THAN A CHECK
 * ----------------------------------------------------------
 *   * `tenantId` — §14.3 and §24.1: "the tenant comes from the resolved HR actor, never from a request
 *     body". The global `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`, so an attempt to
 *     send one is a 400 rather than a silently ignored field, and `hr-isolation.spec.ts` rule 7 makes
 *     a DTO that declares one a build failure.
 *   * `status` — the lifecycle state is the STORED row's. A body that could name one would let a
 *     caller claim a DRAFT is PUBLISHED for the duration of a simulation.
 *   * `policyVersionId` / `publishedAt` / `force` / `skipLimitCheck` — §14.1 makes a simulation
 *     non-mutating and §16 has no bypass. A "what if, but ignoring the limit" flag would answer a
 *     question the configuration does not ask.
 *   * `approverId` / availability claims — §39 defers approval-chain policy, and no authoritative
 *     source for such a fact exists in this phase.
 */

/** Per-field length bounds, matching the widths the stored columns already use. */
export const MAX_SIMULATION_RULE_SET_ID_LENGTH = 128;
export const MAX_SIMULATION_VERSION_LENGTH = 64;

/** The subject whose facts are assembled. §14's `subject`, with only the field it names (§28.7). */
export class SimulateSubjectDto {
  /**
   * Whose records the collections are assembled from.
   *
   * IT IS NOT AUTHORIZATION. §24.6 keeps an employee's view to their own request, but this is an
   * ADMINISTRATIVE simulation surface gated on `hr.leave.policy` (§14.6: "simulation requires the
   * configuration/administration permission for the relevant level — never available to an ordinary
   * employee"), so an administrator may ask about one employee's records. The value is used ONLY as a
   * query filter, always under the actor's own tenant, so it can narrow a read and never widen one.
   */
  @IsUUID('4')
  employeeId!: string;
}

/**
 * §14's `context`: the typed facts the simulated question is about.
 *
 * EVERY FIELD IS A §16 COORDINATE, and the list mirrors the declared catalogue's scalar half exactly.
 * It is deliberately NOT a `Record<string, unknown>` passthrough: a body carrying arbitrary facts
 * would let a caller state facts no catalogue declares, and §8.3 refuses an undeclared field at
 * evaluation — so the run would fail as a validation problem deep in the engine rather than at the
 * boundary where it can be explained.
 *
 * `consumesStates` IS ABSENT ON PURPOSE (the resolved 54-H decision): the authored set belongs to the
 * LIMIT's own stored definition and reaches the engine through the projected rule's `where` clause,
 * never as a caller-supplied fact. Accepting it here would let a caller simulate a policy whose
 * consumed-state set differs from the one in force.
 */
export class SimulateLeaveLimitContextDto {
  /** The leave type the question is about. Required to resolve a governing version and to filter. */
  @IsUUID('4')
  leaveTypeId!: string;

  /**
   * §16.6's employment scope of the subject's range.
   *
   * OPTIONAL, and its ABSENCE is meaningful rather than defaulted: §16.6 refuses a scoped limit as
   * insufficient context when the type cannot be stated, and the service forwards absence as absence
   * so the engine reports the fact as missing instead of matching a value nobody supplied.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  employmentType?: string;

  /** The requested range's inclusive bounds. `requestedTo` defaults to `requestedFrom`. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, {
    message: 'requestedFrom must be a calendar day, e.g. 2026-03-01',
  })
  requestedFrom?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, {
    message: 'requestedTo must be a calendar day, e.g. 2026-03-01',
  })
  requestedTo?: string;
}

/**
 * The §14 simulation body.
 *
 * THERE IS NO `level` FIELD, AND ITS ABSENCE IS THE POINT (§13.3, §27.2, §33.8)
 * ---------------------------------------------------------------------------
 * §27.2 is explicit that a role-appropriate projection is made SERVER-SIDE: "the payload a lower layer
 * receives does not *contain* the advanced detail at all — role-appropriate projection, not
 * client-side filtering of a fat response". A `level` the client supplies is the opposite of that: it
 * makes the caller the authority on how much disclosure it receives, so a holder of this route's
 * permission could ask for the platform-administrator projection and be given priority, specificity,
 * complete match history and conflict reports.
 *
 * So the evidence level is DERIVED, on the server, from the capability this route already
 * authorises — `hr.leave.policy` — and it is exactly `HR_ADMIN`. §27.6 gives the reason the
 * derivation belongs there rather than in the body: "the level is per surface, not per person
 * forever … which layer is shown follows the *capability being used*, which is what the permission
 * gates already express". The permission gate IS this route's capability, so the level is a fact
 * about the route.
 *
 * `PLATFORM_ADMIN` IS NOT REACHABLE HERE, and that is deliberate rather than an omission: §31 places
 * the Level-3 surface (rule builder, version comparison, full explanation tree, cross-tenant
 * inspection "authorized by a platform permission and audited") on a separate Platform Admin surface
 * with its own permission. Nothing in this phase defines that permission, and inventing one to widen
 * this route would be the "new permission" STOP condition. A future platform surface must be designed
 * and authorized on its own terms (§31).
 *
 * `evaluationInstant` IS OPTIONAL IN THE BODY AND ALWAYS EXPLICIT IN THE ENGINE (D12): the service
 * defaults it at the boundary, so a caller may omit it for "now" while the engine never reads a clock.
 */
export class SimulateLeavePolicyVersionDto {
  /** §14: which rule set to simulate. This surface owns `hr.leave.limit` and refuses anything else. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SIMULATION_RULE_SET_ID_LENGTH)
  ruleSetId!: string;

  /**
   * The exact stored version to simulate, by its `versionId`.
   *
   * ABSENT MEANS "THE CURRENTLY EFFECTIVE PUBLISHED CONFIGURATION" (§14: "defaults to the currently
   * published version"). Supplying it selects one named configuration, INCLUDING a `DRAFT` or
   * `VALIDATED` one — the whole point of a simulation surface (Choice 1B), and why this is a lookup for
   * a named version rather than a governance question.
   *
   * A UUID RATHER THAN THE HUMAN-READABLE LABEL, matching the convention every other version route on
   * this controller already uses (`GET|PATCH :policyId/versions/:versionId`, all behind
   * `ParseUUIDPipe({ version: '4' })`). A label would need a scan of the policy's versions to resolve
   * and would introduce a second way to name one row; the id is resolved directly through the
   * tenant-scoped `findVersion(tenantId, policyId, versionId)`, so tenancy and policy scope are part of
   * the read rather than a filter applied afterwards.
   */
  @IsOptional()
  @IsUUID('4')
  versionId?: string;

  /**
   * When to evaluate, ISO-8601 with an explicit offset.
   *
   * OPTIONAL AND DEFAULTED AT THE BOUNDARY (§14, D12). When supplied it is used UNCHANGED — never
   * replaced by server time — so the same state and the same body reproduce the same answer
   * (§36.4's idempotency).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  evaluationInstant?: string;

  /**
   * The typed facts of the simulated question.
   *
   * `@ValidateNested` + `@Type` ARE NOT DECORATION — WITHOUT THEM NOTHING IS CHECKED. A bare
   * `context!: SimulateLeaveLimitContextDto` declares a TYPE and no validation metadata, so a body whose
   * `context` is a string, an array, or a `{ leaveTypeId: 42 }` would reach the service unvalidated and
   * fail later as a 500 from deep inside fact assembly rather than as a 400 naming the field. The
   * `@Type(() => …)` is what makes `class-transformer` build the nested instance, since the global pipe
   * runs with `transform` — the same pairing every nested DTO in `leave-policy.dto.ts` already uses
   * (`@ValidateNested({ each: true }) @Type(() => LeavePolicyLimitDto)`).
   */
  @ValidateNested()
  @Type(() => SimulateLeaveLimitContextDto)
  context!: SimulateLeaveLimitContextDto;

  /** §14's `subject`: whose records the collections are assembled from. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SimulateSubjectDto)
  subject?: SimulateSubjectDto;
}

/**
 * The rule-set identity this surface simulates, re-exported so a caller (and the wiring test) names
 * the same constant the service validates rather than a literal repeated in a second file.
 */
export const SIMULATED_LEAVE_RULE_SET_ID: string = LEAVE_LIMIT_RULE_SET_ID;
