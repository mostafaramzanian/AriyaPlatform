import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RULE_LIMITS } from '../../../rules/core/rule-limits';
import { COMMERCIAL_ASSIGNMENT_RULE_ID_PREFIX } from './commercial.constants';
import {
  COMMERCIAL_APPROVAL_ACTIVATIONS,
  COMMERCIAL_APPROVAL_APPROVERS,
  COMMERCIAL_APPROVAL_DECISIONS,
  COMMERCIAL_ASSIGNMENT_TRIGGERS,
  COMMERCIAL_MATCH_BEHAVIORS,
  COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS,
  COMMERCIAL_PROJECTION_POLICIES,
} from './commercial-status';

/**
 * Phase C1 Step P (§9): the wire contract of the fifteen commercial routes — groups,
 * configuration versions, assignments and approvals. Nothing else.
 *
 * WHAT IS NOT ON THE WIRE, AND NEVER WILL BE
 * ------------------------------------------
 *  * NO `tenantId` — it comes from `resolveCommerceActor(req)`. The global pipe's
 *    `whitelist` + `forbidNonWhitelisted` makes sending one a 400, so no caller can
 *    widen its own scope by stating a tenant.
 *  * NO status/`id` field a caller could write: a version's lifecycle is walked by the
 *    routes that own each transition, an approval's decision by its own route, and an
 *    assignment's state by the assignment engine or the manual assign route.
 *  * NO quotation, requester-confirmation, correction or completion field — §9 closes
 *    the surface at these four categories and §11 defers the rest.
 *
 * WHY THE COLUMN WIDTHS ARE MIRRORED HERE: without a DTO bound a too-long value reaches
 * Postgres and comes back as a driver error — a 500 for what is a client mistake. With
 * the bound it is a 400 naming the field, and the database constraint stays the last
 * line of defence rather than the only one.
 */

/** `CommercialGroup.code` — `VARCHAR(64)`. */
export const MAX_COMMERCIAL_GROUP_CODE_LENGTH = 64;

/** `CommercialGroup.name` — `VARCHAR(128)`. */
export const MAX_COMMERCIAL_GROUP_NAME_LENGTH = 128;

/** `CommercialConfigurationVersion.versionLabel` — `VARCHAR(64)`. */
export const MAX_COMMERCIAL_VERSION_LABEL_LENGTH = 64;

/** The reason captured on a manual reassignment (P7) — `CommercialAssignmentHistory.reason`. */
export const MAX_COMMERCIAL_REASON_LENGTH = 500;

/** The optional decision comment (§9) — `CommercialApproval.comment`. */
export const MAX_COMMERCIAL_COMMENT_LENGTH = 1000;

/**
 * The longest assignment rule LABEL the engine will accept.
 *
 * Derived, never typed as a literal, because the bound is the ENGINE's and not this
 * file's: a rule id is `commercial-assign:<group uuid>:<label>` and `isSafeIdentifier`
 * refuses anything longer than `RULE_LIMITS.maxIdentifierLength` (§7.3 validates the
 * built set, so an over-long label would fail at publish with a rule-engine code rather
 * than at the boundary with a field error). Binding it HERE turns that into a 400 that
 * names `label` — and the derivation can never drift from the id builder, because both
 * read the same prefix constant.
 */
export const MAX_COMMERCIAL_RULE_LABEL_LENGTH =
  RULE_LIMITS.maxIdentifierLength - COMMERCIAL_ASSIGNMENT_RULE_ID_PREFIX.length - 36 - 1;

/** An assignment rule list is bounded by the engine's own rule-count limit (§7.3). */
export const MAX_COMMERCIAL_ASSIGNMENT_RULES = RULE_LIMITS.maxRulesPerSet;

/**
 * THE USER REFERENCES IN THIS FILE ARE PLATFORM USER IDS, NOT UUIDs (GAP-8).
 *
 * `liaisonUserId` and `approverUserId` name a Core identity, and the platform's
 * contract for one is an OPAQUE BOUNDED STRING: `@IsString()` plus the platform
 * identity wire's 64-character bound — exactly the shape `actorUserId` in
 * `workflow-configuration.dto.ts` already uses, and exactly what the platform's own
 * signed identity transport accepts. The platform's seeded administrator is
 * `super-admin-user`; a UUID-shaped value is merely another opaque string and stays
 * legal, but a v4 check would refuse real members.
 *
 * The tenant boundary is unchanged and lives where it always did:
 * `CommercialLiaisonResolver.assertTenantMember` → `CommerceIdentityGateway.assertMember`
 * → the user directory. Only Commerce-OWNED ids in this file (`commercialGroupId`,
 * `documentId`, `lineId`, `groupId`) keep `@IsUUID('4')` — those name rows this module
 * mints itself.
 */

/**
 * Create a Commercial Group (§9, P2).
 *
 * `liaisonUserId` is OPTIONAL because "a group with no configured liaison" is a real,
 * modelled state (§3-K, schema note): resolution refuses by name when such a group
 * decides a line, rather than the group being unrepresentable. A PRESENT value is
 * validated as a tenant member before it is stored — nothing inside `commerce_db` can
 * check that, because there is no relation across databases.
 *
 * `code` is the tenant's own stable key and is unique per tenant
 * (`@@unique([tenantId, code])`); `name` is what the surface renders and may be
 * renamed freely. There is deliberately no hierarchy, no manager and no permission
 * field — P2 fixes the group at "tenant-local business grouping" and §3-L removes
 * deletion from the surface entirely.
 */
export class CreateCommercialGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_GROUP_CODE_LENGTH)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_GROUP_NAME_LENGTH)
  name!: string;

  /**
   * The group's liaison — a platform user id (opaque, 1..64 chars). A PRESENT value is
   * validated as a tenant member before the row exists; GAP-8: never validated as a UUID.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  liaisonUserId?: string;
}

/**
 * Rename a group and/or swap its liaison (§8, §9).
 *
 * `undefined` — the field is not part of this edit; the stored value is untouched.
 * `null`     — the field is being CLEARED, which for `liaisonUserId` puts the group
 *              back into §3-K's "not configured" state on purpose.
 *
 * `@IsOptional()` accepts both, so the distinction survives validation and the service
 * applies it. A DTO that defaulted a missing field to `null` would silently erase a
 * liaison the caller never mentioned.
 *
 * `code` is NOT editable: it is the tenant's key on the row and every assignment rule
 * references the row by id, so changing it would re-key history that §3-C promises to
 * preserve.
 */
export class UpdateCommercialGroupDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_GROUP_NAME_LENGTH)
  name?: string;

  /**
   * The replacement liaison — a platform user id (opaque, 1..64 chars) when stated;
   * `null` clears the group back to "not configured". Never validated as a UUID.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  liaisonUserId?: string | null;
}

/**
 * ONE tenant-authored assignment candidate (§3-D): `{ label, priority, condition,
 * commercialGroupId }` — exactly the shape O stores in `routeRules`.
 *
 * `condition` is an OPTIONAL allowlist-validated node. It is accepted as an object here
 * and proved against the frozen LINE catalogue when the version is validated/published
 * (§7.3): a condition naming any other fact is refused, which is what keeps a rule from
 * reaching a raw Prisma row (§5). `null`/absent means unconditional, and the planner
 * fills the tautology — "no condition" and "false" are different statements.
 *
 * `priority` is bounded by the ENGINE's own range rather than by a number chosen here,
 * so the DTO cannot accept a value §7.3 would then refuse at publish.
 */
export class CommercialAssignmentRuleInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_RULE_LABEL_LENGTH)
  label!: string;

  @IsInt()
  @Min(RULE_LIMITS.minPriority)
  @Max(RULE_LIMITS.maxPriority)
  priority!: number;

  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown> | null;

  @IsUUID('4')
  commercialGroupId!: string;
}

/**
 * Create a DRAFT commercial configuration version (§9).
 *
 * Every member below is a closed vocabulary validated with `@IsIn` against the SAME
 * tuples `commercial-status.ts` exports — so a value the schema's enum cannot store is
 * a 400 here rather than a database error, and a value added to the tuple appears in
 * both places at once.
 *
 * The structural rules of §7 (group membership, catalogue-allowed facts, approver
 * timing, resolver support) are NOT enforced here on purpose: they need the database
 * and the identity gateway, and they are enforced by `validate` and `publish`, which is
 * where §7 says they belong. What IS enforced here is shape — so an obviously
 * malformed version is refused at the edge with a field error instead of being stored
 * as an unvalidatable draft.
 */
export class CreateCommercialConfigurationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_VERSION_LABEL_LENGTH)
  versionLabel!: string;

  @IsIn(COMMERCIAL_ASSIGNMENT_TRIGGERS)
  assignmentTrigger!: (typeof COMMERCIAL_ASSIGNMENT_TRIGGERS)[number];

  @IsIn(COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)
  noAssignmentBehavior!: (typeof COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)[number];

  @IsIn(COMMERCIAL_MATCH_BEHAVIORS)
  matchBehavior!: (typeof COMMERCIAL_MATCH_BEHAVIORS)[number];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COMMERCIAL_ASSIGNMENT_RULES)
  @ValidateNested({ each: true })
  @Type(() => CommercialAssignmentRuleInputDto)
  assignmentRules!: CommercialAssignmentRuleInputDto[];

  @IsIn(COMMERCIAL_APPROVAL_ACTIVATIONS)
  approvalActivation!: (typeof COMMERCIAL_APPROVAL_ACTIVATIONS)[number];

  @IsOptional()
  @IsIn(COMMERCIAL_APPROVAL_APPROVERS)
  approvalApprover?: (typeof COMMERCIAL_APPROVAL_APPROVERS)[number] | null;

  /**
   * The configuration's own approver (CONFIGURED_USER) — a platform user id (opaque,
   * 1..64 chars), membership-checked at validate/publish. GAP-8: never a UUID.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  approverUserId?: string | null;

  /**
   * The optional bound applicability condition (§3-G) over the frozen DOCUMENT
   * catalogue. Omitted/null = "applicable for every assigned line"; the SERVICE
   * persists `false` outcomes on the approval row rather than recomputing them (§5).
   */
  @IsOptional()
  @IsObject()
  applicabilityCondition?: Record<string, unknown> | null;

  @IsIn(COMMERCIAL_PROJECTION_POLICIES)
  projectionPolicy!: (typeof COMMERCIAL_PROJECTION_POLICIES)[number];
}

/**
 * Edit a DRAFT (§9: "edit draft only").
 *
 * Published versions are immutable — §3-B and the repository's own conditional
 * `status: 'DRAFT'` predicate both say so — so a PATCH against a published version is
 * refused by the service with the version's actual status named, before the statement
 * is even issued.
 *
 * Every field is optional; a field that is ABSENT is untouched (the same distinction
 * `UpdateCommercialGroupDto` draws), which is why the service builds its patch from
 * `!== undefined` rather than by spreading a partially-defaulted object.
 */
export class UpdateCommercialConfigurationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_VERSION_LABEL_LENGTH)
  versionLabel?: string;

  @IsOptional()
  @IsIn(COMMERCIAL_ASSIGNMENT_TRIGGERS)
  assignmentTrigger?: (typeof COMMERCIAL_ASSIGNMENT_TRIGGERS)[number];

  @IsOptional()
  @IsIn(COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)
  noAssignmentBehavior?: (typeof COMMERCIAL_NO_ASSIGNMENT_BEHAVIORS)[number];

  @IsOptional()
  @IsIn(COMMERCIAL_MATCH_BEHAVIORS)
  matchBehavior?: (typeof COMMERCIAL_MATCH_BEHAVIORS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COMMERCIAL_ASSIGNMENT_RULES)
  @ValidateNested({ each: true })
  @Type(() => CommercialAssignmentRuleInputDto)
  assignmentRules?: CommercialAssignmentRuleInputDto[];

  @IsOptional()
  @IsIn(COMMERCIAL_APPROVAL_ACTIVATIONS)
  approvalActivation?: (typeof COMMERCIAL_APPROVAL_ACTIVATIONS)[number];

  @IsOptional()
  @IsIn(COMMERCIAL_APPROVAL_APPROVERS)
  approvalApprover?: (typeof COMMERCIAL_APPROVAL_APPROVERS)[number] | null;

  /**
   * The replacement approver — a platform user id (opaque, 1..64 chars) when stated;
   * `null` clears it. GAP-8: never a UUID.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  approverUserId?: string | null;

  @IsOptional()
  @IsObject()
  applicabilityCondition?: Record<string, unknown> | null;

  @IsOptional()
  @IsIn(COMMERCIAL_PROJECTION_POLICIES)
  projectionPolicy?: (typeof COMMERCIAL_PROJECTION_POLICIES)[number];
}

/**
 * The `?documentId=` read of §9 — both the assignment and the approval list are
 * document-scoped reads, because §3-J makes every commercial record line-scoped and a
 * line has no address of its own on the wire.
 *
 * `documentId` is REQUIRED: a commercial list without one would either read the whole
 * tenant (which `commerce.read` is not a licence for) or silently return nothing.
 */
export class CommercialDocumentQueryDto {
  @IsUUID('4')
  documentId!: string;
}

/**
 * Manual assignment / reassignment (§9): `lineId`, `groupId`, optional `reason`.
 *
 * `lineId`, not `documentId` — P3 is LINE-FIRST and §3-J forbids any inference of a
 * document-level owner. A call naming an already-assigned line is a REASSIGNMENT (P7)
 * that writes history, never an overwrite; a call naming a line whose document is
 * terminal is refused with `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE` (§3-H).
 *
 * `reason` is the P7 capture. It is optional here because an ordinary correction does
 * not owe prose — but whatever is sent is persisted on the history row, which is the
 * only place a later reader will find it.
 */
export class CreateCommercialAssignmentDto {
  @IsUUID('4')
  lineId!: string;

  @IsUUID('4')
  groupId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_COMMERCIAL_REASON_LENGTH)
  reason?: string;
}

/**
 * A commercial decision (§9): `decision` plus an optional `comment`.
 *
 * `APPROVED` / `REJECTED` only — and the route this is posted to resolves the record
 * first, so a caller cannot state WHICH record it decides. The acting user must EQUAL
 * the stored approver (§3-G); the DTO cannot weaken that, because the check reads
 * `approverUserId` off the row rather than anything on the wire.
 */
export class CommercialApprovalDecisionDto {
  @IsIn(COMMERCIAL_APPROVAL_DECISIONS)
  decision!: (typeof COMMERCIAL_APPROVAL_DECISIONS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COMMERCIAL_COMMENT_LENGTH)
  comment?: string;
}
