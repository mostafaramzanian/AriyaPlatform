import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type {
  LeaveLimitConsumedState,
  LeaveLimitCountingBasis,
  LeaveLimitPeriodKind,
} from '../domain/leave-policy';
import type { LeavePolicyVersionStatus } from '../domain/leave-policy-version';
import type { HrEmploymentType } from '../dto/hr-query.dto';
import type { LeaveLimitWindow } from '../leave-policy-window';

/**
 * Phase 54-D (§15, §16): the LEAVE POLICY persistence boundary — the versions and the limits.
 *
 * WHY THIS FILE IS SEPARATE FROM `leave/leave.repository.ts`
 * --------------------------------------------------------
 * That file is one aggregate (`LeaveRequest`) with its leaf (`LeaveType`), and its header explains
 * why they stay together: the composite `(tenant_id, leave_type_id)` foreign key makes them one
 * fact. A policy version and its limits are ALSO one fact, for the same reason — but they are a
 * DIFFERENT fact from a request, owned by a different service, and `LeaveService` must never reach
 * a policy table to decide whether a request is permitted. Two aggregates, two files.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT REFUSES TO OWN
 * ----------------------------------------------
 * It returns STORED configuration. It does NOT resolve Jalali windows inside its queries.
 *
 * That division is the approved architecture for this unit, and it is deliberate rather than
 * incidental: `leave-policy-window.ts` sits one tier out from `domain/` precisely because it
 * imports `calendar/jalali.util`, and the calendar is a separate module with its own single answer
 * to "when does the tenant's year start". A second Jalali implementation appearing beside the
 * first is the drift `hr-application-boundaries.spec.ts` rule 3 exists to prevent.
 *
 * So `period` + `jalaliYear` travel to the caller as stored, and the caller resolves them once
 * through `resolveLeaveLimitWindow`, the one existing boundary. The resolved window is then handed
 * to the engine as two inclusive `YYYY-MM-DD` days (§16.2).
 *
 * EVERY READ CARRIES THE TENANT, and `tenantId` is the FIRST parameter of every method, matching
 * `LeaveRepository`'s convention. `findUnique` appears nowhere: it cannot carry a tenant predicate
 * at all, so a limit row could be reached by id alone from the wrong tenant.
 *
 * THIS FILE IS NO LONGER READ-ONLY (Phase 54-F). It gained exactly the writes the authoring and
 * publication lifecycle needs — create policy, create version with its limits in one transaction,
 * restate a DRAFT version, and the two state transitions — and NOTHING ELSE. It still owns no
 * policy DECISION: whether a version may be validated, what makes a body unpublishable, which
 * version is effective on a day, and whether two limits conflict are all answered one tier up, in
 * `leave-policy-validation.ts` and `leave-policy.service.ts`. A repository that decided them would
 * put policy rules in the persistence layer, which is the same error as putting calendar arithmetic
 * here.
 *
 * `publishVersion` IS THE ONE WRITE THAT ACTS ON TWO ROWS, and it is one transaction for that
 * reason: §10.4/§11 require the successor's publication and the predecessor's archiving to be ONE
 * act, so there is never an externally visible instant in which two versions of one policy both
 * read as currently published. Doing it as two calls would make that state observable by any
 * concurrent reader, however short the window.
 */

/**
 * One policy version as it is STORED — the lifecycle state the publication rules act on.
 *
 * `status` is typed as the declared four-state vocabulary rather than `string`, so a stored row can
 * only be described in terms of states the domain knows. A row carrying anything else is a DATA
 * defect, not a lifecycle state, and the service reports it as such rather than mapping it onto the
 * nearest member — the same distinction `isLeavePolicyVersionTransitionAllowed`'s `null` draws.
 */
export interface StoredLeavePolicyVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly versionLabel: string;
  readonly status: LeavePolicyVersionStatus;
  readonly jalaliYear: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly payload: unknown;
  readonly publishedAt: Date | null;
  readonly publishedByEmployeeId: string | null;
}

/**
 * One authored limit as it is WRITTEN. Carries the RESOLVED window because the caller has already
 * been through the module's one calendar boundary (`leave-policy-window.ts`) — see the file header:
 * a repository has no business performing calendar arithmetic, so the window arrives decided.
 */
export interface LeaveLimitWrite {
  readonly leaveTypeId: string;
  readonly employmentType: HrEmploymentType | null;
  readonly maximum: number;
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly period: LeaveLimitPeriodKind;
  readonly jalaliYear: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly consumesStates: readonly LeaveLimitConsumedState[];
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

/**
 * One policy version's authored fields, as the service hands them to the repository.
 *
 * `status` IS ABSENT DELIBERATELY — it is the service's, reached through
 * `applyVersionTransition`/`publishVersion` and never set by an authoring call.
 *
 * `validatedAt` AND `archivedAt` ARE ALSO ABSENT, AND THAT IS A FACT ABOUT THE SCHEMA RATHER THAN
 * AN OMISSION: `LeavePolicyVersion` stores only `published_at`/`published_by_employee_id`, because
 * publication is the one lifecycle instant the specification requires to be retained (§23.5 — "it
 * *was* published"). When a version was checked and when it was withdrawn are both derivable from
 * the ROW THAT SUPERSEDED IT (`effective_from`, `published_at`), so storing them separately would
 * create a second answer that can disagree with the version history.
 */
export interface LeavePolicyVersionWrite {
  readonly versionLabel: string;
  readonly jalaliYear: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly payload: unknown;
  readonly limits: readonly LeaveLimitWrite[];
}

/**
 * One policy as it is stored.
 *
 * NO `description`: `LeavePolicy` carries `code` and `name` only. The omitted field is called out
 * rather than silently dropped, because a caller that expects to round-trip a description would
 * otherwise conclude the write silently failed.
 */
export interface StoredLeavePolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
}

/**
 * One limit as it is STORED, carrying its configured Jalali period rather than a Gregorian window.
 *
 * `consumesStates` is typed as the declared vocabulary rather than `string[]`, so a stored row can
 * only be described in terms of states the domain knows. It is NOT filtered, narrowed or validated
 * here: deciding whether a declared set can be counted today is `leaveLimitEnforceabilityRefusal`'s
 * question in `domain/leave-policy.ts`, and answering it in the repository would put a policy
 * decision in the persistence layer.
 */
export interface StoredLeaveLimit {
  readonly id: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly leaveTypeId: string;
  /** NULL means "applies to every employment type" (§16.6). */
  readonly employmentType: string | null;
  readonly maximum: number;
  readonly countingBasis: LeaveLimitCountingBasis;
  readonly period: LeaveLimitPeriodKind;
  readonly jalaliYear: number;
  /** The authored window, as stored — NOT re-derived here. */
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly consumesStates: readonly LeaveLimitConsumedState[];
  readonly effectiveFrom: Date;
  /** NULL means open-ended. */
  readonly effectiveTo: Date | null;
}

/**
 * A resolved limit: the stored row plus the inclusive Gregorian window its period resolves to.
 *
 * The stored `windowStart`/`windowEnd` columns are kept as authored history (they are what an
 * explanation is rendered from), while `window` is the engine-ready pair the caller resolved.
 */
export interface ResolvedLeaveLimit extends StoredLeaveLimit {
  readonly window: LeaveLimitWindow;
}
/**
 * A write row for `createMany`, widened from an authored limit.
 *
 * WHY THIS FUNCTION EXISTS RATHER THAN A CAST AT EACH CALL SITE
 * ------------------------------------------------------------
 * Two of a limit's fields cross a boundary at this exact point, and both crossings are the same
 * crossing:
 *
 *   * `employmentType` is stated in the API's own vocabulary (`HrEmploymentType`, from
 *     `dto/hr-query.dto`) and stored as the Prisma enum of the same name. The two are structurally
 *     identical — `HR_EMPLOYMENT_TYPES` is declared "Matches `EmploymentType` in
 *     `prisma/hr/schema.prisma`" — so the assignment is checked against the schema, NOT cast past it.
 *   * `consumesStates` is a `readonly` array of the domain's vocabulary, while the column takes a
 *     MUTABLE array of the Prisma enum. Widening the readonly array is the whole difference; the
 *     MEMBERS are still checked, so an undeclared state remains a compile error rather than a row
 *     the database rejects at runtime.
 *
 * Typing this once here keeps both checks in one place and keeps the repository free of the generated
 * client — which is a module rule, not a preference: `hr-isolation.spec.ts` asserts that EXACTLY ONE
 * file imports `generated/hr-client`, because that is what keeps the connection lifecycle and the
 * datasource activation a single fact.
 */
function toLeaveLimitWriteRow(
  tenantId: string,
  policyId: string,
  policyVersionId: string,
  limit: LeaveLimitWrite
) {
  return {
    tenantId,
    policyId,
    policyVersionId,
    leaveTypeId: limit.leaveTypeId,
    employmentType: limit.employmentType,
    maximum: limit.maximum,
    countingBasis: limit.countingBasis,
    period: limit.period,
    jalaliYear: limit.jalaliYear,
    windowStart: limit.windowStart,
    windowEnd: limit.windowEnd,
    // A fresh MUTABLE array, so the stored row cannot alias the caller's frozen input.
    consumesStates: [...limit.consumesStates],
    effectiveFrom: limit.effectiveFrom,
    effectiveTo: limit.effectiveTo,
  };
}

/**
 * The READ PATH for leave limits (§16), tenant-scoped on every call.
 *
 * WHY `tenantId` IS ALWAYS THE FIRST PARAMETER
 * --------------------------------------------
 * `leave.repository.ts` established the convention, and the reason is not stylistic: the tenant is
 * the OUTERMOST scope of every HR fact, so a reader that takes it first cannot be called without
 * the caller having resolved it. Omitting it is a compile error rather than a query that happens to
 * return another tenant's limits because nobody added the predicate.
 *
 * The tenant NEVER arrives from a DTO: `HrActor.tenantId` is resolved fail-closed from the request
 * context, and the service layer that calls this repository is the only place that knows it.
 */
@Injectable()
export class LeavePolicyRepository {
  constructor(private readonly prisma: HrPrismaService) {}

  /**
   * Every limit reachable for one leave type, as STORED.
   *
   * WHAT "REACHABLE" MEANS, AND WHAT IS DELIBERATELY LEFT OUT
   * --------------------------------------------------------
   * This narrows by tenant, leave type and the `effectiveFrom`/`effectiveTo` window that must
   * contain `onDay` — the effective-dating comparison a stored row can answer on its own. It does
   * NOT narrow by employment type, because that is a §16.6 SCOPE decision with a refusal
   * consequence when context is missing, and it does NOT narrow by policy version status or by
   * policy selection: which PUBLISHED version governs a request is the selection resolver's
   * question, and answering it here would hide a policy decision inside a WHERE clause.
   *
   * So the caller receives candidate limits and applies the frozen rules
   * (`isLeaveLimitApplicableToEmploymentType`, `leaveLimitEnforceabilityRefusal`) where those rules
   * live. A repository that pre-filtered them would turn "refuse because context is missing" into
   * "no limit was found", which the invariants state is NOT the same answer.
   *
   * `period` and `jalaliYear` are returned unresolved on purpose (architecture choice (a)):
   * converting a Jalali year into Gregorian days needs `calendar/jalali.util`, and a repository
   * has no business performing calendar arithmetic.
   */
  async findLimitsForLeaveType(
    tenantId: string,
    leaveTypeId: string,
    onDay: Date
  ): Promise<StoredLeaveLimit[]> {
    const rows = await this.prisma.leaveLimitDefinition.findMany({
      where: {
        tenantId,
        leaveTypeId,
        effectiveFrom: { lte: onDay },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDay } }],
      },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => this.toStoredLimit(row));
  }

  /**
   * The limits belonging to one policy VERSION.
   *
   * This is the authoring-side read: a version's limits are its own, and `policyVersionId` is the
   * narrowest scope that still proves the caller knows which version it is asking about. The tenant
   * predicate is applied as well, so a version id from another tenant returns nothing rather than
   * a version id that happens to be guessed correctly.
   *
   * No effective-date narrowing happens here: a version's limits are read as a set when the
   * version itself is being inspected, not as of a day.
   */
  async findLimitsForPolicyVersion(
    tenantId: string,
    policyVersionId: string
  ): Promise<StoredLeaveLimit[]> {
    const rows = await this.prisma.leaveLimitDefinition.findMany({
      where: { tenantId, policyVersionId },
      orderBy: [{ leaveTypeId: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => this.toStoredLimit(row));
  }

  /**
   * The single storage mapping, so both readers describe a row identically.
   *
   * `consumesStates` is cast to the declared vocabulary rather than validated: the column is
   * constrained by the migration to those values, and re-validating here would duplicate a rule the
   * database already enforces. Whether a declared state can be COUNTED is a different question,
   * answered by the domain.
   */
  private toStoredLimit(row: {
    id: string;
    tenantId: string;
    policyId: string;
    policyVersionId: string;
    leaveTypeId: string;
    employmentType: string | null;
    maximum: number;
    countingBasis: string;
    period: string;
    jalaliYear: number;
    windowStart: Date;
    windowEnd: Date;
    consumesStates: string[];
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }): StoredLeaveLimit {
    return {
      id: row.id,
      tenantId: row.tenantId,
      policyId: row.policyId,
      policyVersionId: row.policyVersionId,
      leaveTypeId: row.leaveTypeId,
      employmentType: row.employmentType,
      maximum: row.maximum,
      countingBasis: row.countingBasis as LeaveLimitCountingBasis,
      period: row.period as LeaveLimitPeriodKind,
      jalaliYear: row.jalaliYear,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      consumesStates: row.consumesStates as LeaveLimitConsumedState[],
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
  }

  // -- Authoring (Phase 54-F, §15) ------------------------------------------

  /**
   * The policy, if it belongs to this tenant.
   *
   * `findFirst` WITH A TENANT PREDICATE rather than `findUnique` by id (file header): the id comes
   * from a URL, and a URL is caller-supplied. Resolving through the tenant means a policy id
   * guessed from another tenant resolves to `null`, which the service reports as `POLICY_UNRESOLVED`
   * — the same answer as a policy that does not exist, so the two are not distinguishable to the
   * caller.
   */
  async findPolicy(tenantId: string, policyId: string): Promise<StoredLeavePolicy | null> {
    const row = await this.prisma.leavePolicy.findFirst({
      where: { id: policyId, tenantId },
    });

    if (row === null) return null;

    return {
      id: row.id,
      tenantId: row.tenantId,
      code: row.code,
      name: row.name,
    };
  }

  /** Creates the policy CONTAINER. Versions are authored against it afterwards. */
  async createPolicy(
    tenantId: string,
    input: { code: string; name: string }
  ): Promise<StoredLeavePolicy> {
    const row = await this.prisma.leavePolicy.create({
      data: {
        tenantId,
        code: input.code,
        name: input.name,
      },
    });

    return {
      id: row.id,
      tenantId: row.tenantId,
      code: row.code,
      name: row.name,
    };
  }

  /**
   * Authors a version AND ITS LIMITS in ONE transaction.
   *
   * WHY ONE TRANSACTION. A version whose limits were written by a second call has a window in which
   * it exists with none, and a concurrent validator would be entitled to read that state and refuse
   * a version whose author did nothing wrong. The two writes are one fact (file header: a version
   * and its limits are one fact, the same way a request and its leave type are), so they commit
   * together or not at all.
   *
   * THE STATUS IS NOT A PARAMETER. The row is created `DRAFT` because §11's lifecycle starts there;
   * making the initial state a caller's argument would let a create call skip the validate gate.
   */
  async createVersion(
    tenantId: string,
    policyId: string,
    input: LeavePolicyVersionWrite
  ): Promise<StoredLeavePolicyVersion> {
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.leavePolicyVersion.create({
        data: {
          tenantId,
          policyId,
          versionLabel: input.versionLabel,
          status: 'DRAFT',
          jalaliYear: input.jalaliYear,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          payload: input.payload as never,
        },
      });

      if (input.limits.length > 0) {
        await tx.leaveLimitDefinition.createMany({
          data: input.limits.map((limit) =>
            toLeaveLimitWriteRow(tenantId, policyId, version.id, limit)
          ),
        });
      }

      return this.toStoredVersion(version);
    });
  }

  // -- Version reads and transitions (Phase 54-F, §10-§12) ------------------

  /**
   * One version of one policy, scoped to the tenant.
   *
   * `policyId` IS BOTH A PREDICATE AND A CORRECTNESS CHECK, not decoration: a version id alone
   * would let a caller address a version through the wrong policy's URL, and the service's
   * `policyId`-scoped rules would then apply to a version that does not belong to it.
   */
  async findVersion(
    tenantId: string,
    policyId: string,
    versionId: string
  ): Promise<StoredLeavePolicyVersion | null> {
    const row = await this.prisma.leavePolicyVersion.findFirst({
      where: { id: versionId, policyId, tenantId },
    });

    if (row === null) return null;

    return this.toStoredVersion(row);
  }

  /**
   * ONE version by its own id, WITHOUT naming its policy — the read the effective-policy resolver
   * needs, and the only place in this repository a version is addressed this way.
   *
   * WHY THIS EXISTS ALONGSIDE `findVersion`, WHICH ALSO TAKES AN ID. `findVersion` requires the
   * `policyId` as well, and that is the right shape for authoring: a caller there has already chosen
   * a policy and must prove the version belongs to it, or `policyId`-scoped rules would apply to a
   * version of a different policy. The resolver has no `policyId` to give — it is going FROM a limit
   * TO the version that owns it, and demanding a policy id would force it to guess the answer it is
   * trying to find. `tenantId` is still first and still mandatory, so the narrowing that matters for
   * isolation is unchanged; what is dropped is an identifier the caller cannot honestly supply.
   *
   * THE STATUS IS NOT NARROWED HERE, and that is deliberate: the caller decides whether an ARCHIVED
   * version answers its question (historical resolution) or does not (new selection), and a repository
   * that pre-filtered to PUBLISHED would make the historical guarantee unreachable.
   */
  async findVersionById(
    tenantId: string,
    versionId: string
  ): Promise<StoredLeavePolicyVersion | null> {
    const row = await this.prisma.leavePolicyVersion.findFirst({
      where: { id: versionId, tenantId },
    });

    if (row === null) return null;

    return this.toStoredVersion(row);
  }

  /**
   * The version of this policy that is currently `PUBLISHED`, if any.
   *
   * AT MOST ONE, and that is a DATABASE invariant rather than a hopeful read: the partial unique
   * index added by the 54-F migration allows one PUBLISHED row per policy, so this method's
   * `findFirst` cannot be hiding a second. A `findMany` here would imply the state is possible and
   * push the ambiguity onto every caller.
   */
  async findPublishedVersion(
    tenantId: string,
    policyId: string
  ): Promise<StoredLeavePolicyVersion | null> {
    const row = await this.prisma.leavePolicyVersion.findFirst({
      where: { tenantId, policyId, status: 'PUBLISHED' },
    });

    if (row === null) return null;

    return this.toStoredVersion(row);
  }

  /** Rewrites a DRAFT version's own fields. The caller has already proved the row is `DRAFT`. */
  async updateDraftVersion(
    tenantId: string,
    policyId: string,
    versionId: string,
    input: Omit<LeavePolicyVersionWrite, 'limits'>
  ): Promise<StoredLeavePolicyVersion> {
    const row = await this.prisma.leavePolicyVersion.update({
      where: { id: versionId },
      data: {
        versionLabel: input.versionLabel,
        jalaliYear: input.jalaliYear,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        payload: input.payload as never,
      },
    });

    return this.toStoredVersion(row);
  }

  /**
   * Replaces a DRAFT version's whole limit set.
   *
   * DELETE-THEN-INSERT IN ONE TRANSACTION, because the limit rows have no stable identity worth
   * preserving: a limit is identified by its SCOPE (leave type + employment type + interval), not by
   * its id, and an id-preserving merge would have to guess which authored limit corresponds to which
   * stored one. Replacing the set states that plainly.
   *
   * THE IMMUTABILITY TRIGGER IS NOT BYPASSED HERE: it refuses a limit write whose parent version is
   * `PUBLISHED` or `ARCHIVED`, so this method succeeds exactly when the version is a draft — which
   * is the caller's precondition, not this method's guess.
   */
  async replaceVersionLimits(
    tenantId: string,
    policyId: string,
    versionId: string,
    limits: readonly LeaveLimitWrite[]
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.leaveLimitDefinition.deleteMany({ where: { tenantId, policyVersionId: versionId } });

      if (limits.length === 0) return;

      await tx.leaveLimitDefinition.createMany({
        data: limits.map((limit) => toLeaveLimitWriteRow(tenantId, policyId, versionId, limit)),
      });
    });
  }

  /**
   * Moves a version's lifecycle state, with the transition ALREADY CHECKED by the caller.
   *
   * THE `where` CARRIES THE EXPECTED CURRENT STATE, so this is a COMPARE-AND-SET rather than a blind
   * write: two concurrent callers both reading `VALIDATED` cannot both validate, because the second
   * update matches no row and this method answers `null`. That is the database arbitrating the race,
   * which is the only place it can be arbitrated — an application read-then-write would leave the
   * window open between the read and the write.
   *
   * `null` IS NOT AN ERROR: it means "the row was not in the state you read". The service turns it
   * into a 409 naming both states, which is more useful than a driver-level "0 rows".
   */
  async applyVersionTransition(
    tenantId: string,
    policyId: string,
    versionId: string,
    input: {
      readonly from: LeavePolicyVersionStatus;
      readonly to: LeavePolicyVersionStatus;
      readonly at: Date;
      readonly byEmployeeId: string | null;
    }
  ): Promise<StoredLeavePolicyVersion | null> {
    const data =
      input.to === 'VALIDATED'
        ? { status: 'VALIDATED' as const }
        : input.to === 'PUBLISHED'
          ? {
              status: 'PUBLISHED' as const,
              publishedAt: input.at,
              publishedByEmployeeId: input.byEmployeeId,
            }
          : { status: 'ARCHIVED' as const };

    const updated = await this.prisma.leavePolicyVersion.updateMany({
      where: { id: versionId, policyId, tenantId, status: input.from },
      data,
    });

    if (updated.count === 0) return null;

    return this.findVersion(tenantId, policyId, versionId);
  }

  /**
   * PUBLISHES a version AND ARCHIVES ITS PREDECESSOR, as ONE transaction (§10.4, §11).
   *
   * THE ORDER IS DELIBERATE AND IT IS ARCHIVE-FIRST. The partial unique index permits one PUBLISHED
   * row per policy, so publishing before archiving would momentarily violate it and fail — the very
   * index this phase relies on to make "at most one version in force" true rather than hoped. This
   * order keeps the invariant satisfied at EVERY statement boundary, not merely at commit.
   *
   * THE PREDECESSOR IS FOUND INSIDE THE TRANSACTION rather than passed in: a caller that named the
   * predecessor would be choosing which version to withdraw, and the rule is not "withdraw the one
   * you name" but "withdraw whatever is currently in force".
   *
   * THE TARGET'S UPDATE IS A COMPARE-AND-SET ON `VALIDATED`, for the reason stated on
   * `applyVersionTransition`: it is what makes a concurrent double-publish fail rather than produce
   * two publications.
   *
   * THROWING ROLLS THE WHOLE THING BACK, which is the point: if the target did not move, the
   * predecessor's archiving must not stand either — otherwise a refused publish would leave the
   * policy with NO version in force.
   */
  async publishVersion(
    tenantId: string,
    policyId: string,
    versionId: string,
    input: { readonly at: Date; readonly byEmployeeId: string }
  ): Promise<StoredLeavePolicyVersion | null> {
    return this.prisma.$transaction(async (tx) => {
      const predecessor = await tx.leavePolicyVersion.findFirst({
        where: { tenantId, policyId, status: 'PUBLISHED' },
      });

      if (predecessor !== null && predecessor.id !== versionId) {
        await tx.leavePolicyVersion.updateMany({
          where: { id: predecessor.id, tenantId, policyId, status: 'PUBLISHED' },
          data: { status: 'ARCHIVED' },
        });
      }

      const published = await tx.leavePolicyVersion.updateMany({
        where: { id: versionId, policyId, tenantId, status: 'VALIDATED' },
        data: {
          status: 'PUBLISHED',
          publishedAt: input.at,
          publishedByEmployeeId: input.byEmployeeId,
        },
      });

      if (published.count === 0) {
        // Rolled back on the way out — see the doc comment: a refused publish must not leave the
        // predecessor archived.
        throw new Error('LEAVE_POLICY_VERSION_NOT_VALIDATED');
      }

      const row = await tx.leavePolicyVersion.findFirst({
        where: { id: versionId, policyId, tenantId },
      });

      return row === null ? null : this.toStoredVersion(row);
    });
  }

  /**
   * The single version mapping, so every reader describes a version row identically.
   *
   * `status` is CAST HERE AND VALIDATED BY THE CALLER. The cast is unavoidable — Prisma's generated
   * type for the column is the enum it knows, which is the same four members — but the DATABASE is
   * what guarantees the set, and a row carrying anything else could only exist if the migration's
   * CHECK were dropped. The job service re-checks with `isLeavePolicyVersionStatus` and refuses on
   * an unrecognized state rather than mapping it to the nearest member.
   */
  private toStoredVersion(row: {
    id: string;
    tenantId: string;
    policyId: string;
    versionLabel: string;
    status: string;
    jalaliYear: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    payload: unknown;
    publishedAt: Date | null;
    publishedByEmployeeId: string | null;
  }): StoredLeavePolicyVersion {
    return {
      id: row.id,
      tenantId: row.tenantId,
      policyId: row.policyId,
      versionLabel: row.versionLabel,
      status: row.status as LeavePolicyVersionStatus,
      jalaliYear: row.jalaliYear,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      payload: row.payload,
      publishedAt: row.publishedAt,
      publishedByEmployeeId: row.publishedByEmployeeId,
    };
  }
}
