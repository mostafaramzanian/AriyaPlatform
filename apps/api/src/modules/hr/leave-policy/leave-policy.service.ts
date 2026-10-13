import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeavePolicyRepository } from './leave-policy.repository';
import type {
  LeaveLimitWrite,
  StoredLeaveLimit,
  StoredLeavePolicyVersion,
} from './leave-policy.repository';
import { validateLeavePolicyVersion } from './leave-policy-validation';
import type { AuthoredLeaveLimit } from './leave-policy-validation';
import { resolveLeaveLimitWindow } from '../leave-policy-window';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  CreateLeavePolicyDto,
  CreateLeavePolicyVersionDto,
  LeavePolicyLimitDto,
  ResolveEffectiveLeavePolicyQueryDto,
  UpdateLeavePolicyVersionDto,
} from '../dto/leave-policy.dto';
import { LEAVE_POLICY_LIMIT_CONSUMED_STATES } from '../domain/leave-policy-authoring';
import {
  isLeaveLimitApplicableToEmploymentType,
  type LeaveLimitEmploymentType,
} from '../domain/leave-policy';
import {
  isLeavePolicyVersionStatus,
  isLeavePolicyVersionTransitionAllowed,
} from '../domain/leave-policy-version';
import { LEAVE_REQUEST_STATUS_TRANSITIONS } from '../domain/leave-status';
import type { LeaveRequestStatus } from '../domain/leave-status';
import { HR_EMPLOYMENT_TYPES } from '../dto/hr-query.dto';
import { EmployeeRepository } from '../employees/employees.repository';
import { LeaveRepository } from '../leave/leave.repository';

/**
 * Phase 54-F (§10.3, §10.4, §11, §12, §15, §15.6, §16): leave POLICY authoring and its four-state
 * lifecycle — the only surface through which a policy version becomes a rule anybody is governed by.
 *
 * WHY THIS SERVICE EXISTS AND WHAT IT IS NOT
 * ------------------------------------------
 * The repository already presses on rows, the domain already states the four states and the legal
 * moves between them, and `leave-policy-validation.ts` already decides what a version is REFUSED
 * for. What was missing was the thing that OWNS THE SEQUENCE: read the row, check the state is what
 * the caller believes, gather the facts the validator needs, hand them over, translate the refusals
 * into an HTTP answer, perform the act, and write the audit row. Every one of those steps is a
 * decision, and a controller that performed them would be a controller holding a lifecycle.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   * NO RULE EVALUATION. §11's own division of labour: this phase CONFIGURES the rules and the
 *     engine ENFORCES them. Nothing here decides how many days a request consumes, whether a limit
 *     is exceeded, or which rule wins — the request path is a later phase's, and answering any of
 *     those questions here would put a second, disagreeing evaluator in the repository.
 *   * NO SIMULATION AND NO PREVIEW. §12.3's "conflict report" is what `validate` returns; a
 *     hypothetical "what if I published this" surface would have to invent an answer for a version
 *     that does not exist yet.
 *   * NO SCHEDULED PUBLICATION. A version is published by an ACT. There is no `publishAt` column
 *     and no job here: §10.4's "publishing a new version archives the previous one in the same act"
 *     is a statement about one transaction, and spreading it across two clock readings would make
 *     "at most one in force" true only most of the time.
 *   * NO MUTATION OF A PUBLISHED OR ARCHIVED VERSION. Enforced twice, deliberately: this service's
 *     `DRAFT` precondition refuses the write in application code, and
 *     `hr_assert_leave_policy_version_immutable` refuses the UPDATE in the database even for a
 *     writer that bypasses this class.
 *
 * THE TENANCY RULE
 * ----------------
 * `actor.tenantId` is the first argument of every repository call below, and there is no code path
 * that reads a tenant from client input (`hr-actor.ts`). A version id from another tenant resolves
 * to `null` and becomes a 404 — indistinguishable from one that does not exist, which is the
 * intended answer: a distinguishable 403 would confirm the row exists somewhere.
 */
@Injectable()
export class LeavePolicyService {
  constructor(
    private readonly policies: LeavePolicyRepository,
    private readonly employees: EmployeeRepository,
    private readonly leave: LeaveRepository,
    private readonly audit: HrAuditGateway
  ) {}

  // -------------------------------------------------------------------------
  // Policy container
  // -------------------------------------------------------------------------

  /** §15.1: creates the policy CONTAINER. It has no rules of its own; its versions do. */
  async createPolicy(actor: HrActor, dto: CreateLeavePolicyDto) {
    const policy = await this.policies.createPolicy(actor.tenantId, {
      code: dto.code,
      name: dto.name,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY,
      resourceId: policy.id,
      newValue: { code: policy.code, name: policy.name },
    });

    return policy;
  }

  /** Reads one policy. The 404 is the same whether the row is absent or another tenant's. */
  async getPolicy(actor: HrActor, policyId: string) {
    return this.requirePolicy(actor, policyId);
  }

  // -------------------------------------------------------------------------
  // Authoring (DRAFT only)
  // -------------------------------------------------------------------------

  /**
   * Authors a version and its limits. THE VERSION IS BORN `DRAFT` and this method cannot produce
   * anything else — `createVersion` hard-codes the initial state, so a create call cannot skip the
   * validate gate by declaring a later one.
   *
   * THE WINDOWS ARE RESOLVED HERE, NOT SENT. The DTO carries no `windowStart`/`windowEnd` on
   * purpose (§16.2): a caller that could supply one could declare a window disagreeing with the
   * year it claims to govern. The period kind and the version's own `jalaliYear` travel to
   * `resolveLeaveLimitWindow`, the module's one calendar boundary, and the result is stored.
   */
  async createVersion(actor: HrActor, policyId: string, dto: CreateLeavePolicyVersionDto) {
    await this.requirePolicy(actor, policyId);

    const version = await this.policies.createVersion(actor.tenantId, policyId, {
      versionLabel: dto.versionLabel,
      jalaliYear: dto.jalaliYear,
      effectiveFrom: toStoredDay(dto.effectiveFrom),
      // The DTO's `effectiveTo` is TRI-STATE for authoring (§15.4): absent means "open-ended" on
      // create, which is the same stored fact as an explicit `null`, and both must land as SQL NULL
      // rather than as `Invalid Date`. `undefined` and `null` are therefore collapsed HERE, before
      // the conversion, instead of being handed to `toStoredDay`.
      effectiveTo:
        dto.effectiveTo === undefined || dto.effectiveTo === null
          ? null
          : toStoredDay(dto.effectiveTo),
      payload: dto.payload,
      limits: toLimitWrites(dto.limits, dto.jalaliYear),
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY_VERSION,
      resourceId: version.id,
      newValue: { versionLabel: version.versionLabel, status: version.status },
    });

    return version;
  }

  /**
   * Restates a `DRAFT` version.
   *
   * THE STATE CHECK COMES FIRST, and it is what makes the write safe rather than merely guarded:
   * `updateDraftVersion`/`replaceVersionLimits` carry no status predicate of their own (they trust
   * the caller, as the repository header says), so this method is the place the `DRAFT` precondition
   * is actually established. The database agrees independently — the immutability trigger refuses a
   * limit write whose parent is `PUBLISHED` or `ARCHIVED` — so a bypassed check here is still a
   * refused write there, not a corrupted published version.
   *
   * `limits` ABSENT MEANS "LEAVE THEM ALONE". An empty default would silently delete every limit of
   * a version whose label was the only thing being corrected, which is why the DTO distinguishes an
   * absent array from an empty one and this method forwards that distinction unchanged.
   */
  async updateVersion(
    actor: HrActor,
    policyId: string,
    versionId: string,
    dto: UpdateLeavePolicyVersionDto
  ) {
    const version = await this.requireVersion(actor, policyId, versionId);
    requireDraft(version, 'edited');

    // The YEAR the limits resolve against is the year the version will HAVE, not the year it had:
    // changing both in one call must not resolve the limits against the stale one.
    const jalaliYear = dto.jalaliYear ?? version.jalaliYear;

    const updated = await this.policies.updateDraftVersion(actor.tenantId, policyId, versionId, {
      versionLabel: dto.versionLabel ?? version.versionLabel,
      jalaliYear,
      effectiveFrom:
        dto.effectiveFrom === undefined ? version.effectiveFrom : toStoredDay(dto.effectiveFrom),
      effectiveTo: resolveEffectiveTo(version, dto.effectiveTo),
      payload: dto.payload ?? version.payload,
    });

    if (dto.limits !== undefined) {
      await this.policies.replaceVersionLimits(
        actor.tenantId,
        policyId,
        versionId,
        toLimitWrites(dto.limits, jalaliYear)
      );
    }

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY_VERSION,
      resourceId: versionId,
      changedFields: Object.keys(dto),
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // The lifecycle (§10.3, §10.4, §11)
  // -------------------------------------------------------------------------

  /**
   * `DRAFT → VALIDATED`: runs the gate and reports EVERY refusal, or records the acceptance.
   *
   * WHY THE FACTS ARE GATHERED HERE RATHER THAN IN THE VALIDATOR
   * -----------------------------------------------------------
   * `validateLeavePolicyVersion` is a pure function of its inputs and reads no clock and no table
   * (its header states this). The facts it needs are exactly the questions only this layer can
   * answer: which leave types this tenant has, which request states the current lifecycle can reach,
   * which interval a live published version of this policy occupies, and which employment scopes
   * this tenant's vocabulary accepts. Assembling them is the service's job; deciding what they
   * IMPLY is the validator's.
   *
   * A REFUSAL IS REPORTED IN FULL, NOT CUT AT THE FIRST PROBLEM. §12.3 requires the refusal to be
   * readable: the caller gets every refusal code, each with the limit index and leave type it
   * concerns, so a five-limit policy with five problems is ONE round trip.
   */
  async validateVersion(actor: HrActor, policyId: string, versionId: string) {
    const version = await this.requireVersion(actor, policyId, versionId);
    requireDraft(version, 'validated');

    const limits = await this.policies.findLimitsForPolicyVersion(actor.tenantId, versionId);
    const published = await this.policies.findPublishedVersion(actor.tenantId, policyId);

    const refusals = validateLeavePolicyVersion(toAuthoredVersion(version, limits), {
      knownLeaveTypeIds: await this.knownLeaveTypeIds(actor, limits),
      reachableRequestStatuses: reachableRequestStatuses(),
      publishedInterval: intervalOf(published),
      knownEmploymentTypes: knownEmploymentTypes(),
      resolveLimitWindow: resolveLeaveLimitWindow,
      // THE STORED WINDOW, and this is the non-null case the validator's header describes: a version
      // being validated has already had its windows resolved and written, so the window is read back
      // and checked against an INDEPENDENT resolution of the year it declares. Passing `null` here
      // would re-resolve and compare the resolver against itself, which cannot detect a window that
      // disagrees with its own year.
      storedWindow: windowOf(limits),
    });

    if (refusals.length > 0) {
      throw new BadRequestException({
        code: 'LEAVE_POLICY_VERSION_REFUSED',
        message: 'This version cannot be validated; the report lists every refusal.',
        refusals,
      });
    }

    const validated = await this.policies.applyVersionTransition(
      actor.tenantId,
      policyId,
      versionId,
      { from: 'DRAFT', to: 'VALIDATED', at: new Date(), byEmployeeId: null }
    );

    // `null` means the row was not `DRAFT` when the compare-and-set ran — another request validated
    // it in between. That is a conflict rather than a retry, because the caller's belief about the
    // state was wrong and a silent success would hide that the document it approved is not the one
    // it read.
    if (validated === null) {
      throw new ConflictException(
        'This version was validated or published by another request; re-read it before retrying.'
      );
    }

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.VALIDATE,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY_VERSION,
      resourceId: versionId,
      oldValue: { status: 'DRAFT' },
      newValue: { status: 'VALIDATED' },
    });

    return validated;
  }

  /**
   * `VALIDATED → PUBLISHED`, ARCHIVING THE PREDECESSOR IN THE SAME ACT (§10.4, §11).
   *
   * WHAT THIS METHOD CONTRIBUTES OVER THE REPOSITORY
   * ------------------------------------------------
   * The repository's `publishVersion` already performs the archive-first transaction with a
   * compare-and-set, and that is where atomicity lives — an application-level "archive then publish"
   * would leave a window in which neither version is in force. What is added here is the two things
   * the repository cannot decide: that the TARGET has passed the gate, and that a publish whose
   * interval collides with the version currently in force is REFUSED rather than performed.
   *
   * THE OVERLAP REFUSAL IS A RE-VALIDATION, NOT A SECOND RULE. §10.4 permits exactly one published
   * version per policy "at a time", and the database states the same thing as
   * `LeavePolicyVersion_published_overlap_excl`. A version may have been validated when no
   * predecessor existed and then be published after one appeared, so the check runs AGAIN against
   * the interval in force NOW. The refusal is the validator's own `PUBLISHED_INTERVAL_OVERLAP`,
   * produced by the same function, so the two paths cannot drift.
   *
   * WHY THE PREDECESSOR IS NOT THE CALLER'S CHOICE. The repository finds whatever is currently
   * `PUBLISHED` inside the transaction. The rule is not "withdraw the one you name" but "withdraw
   * whatever is in force", and letting a caller name it would let two callers name two different
   * ones.
   */
  async publishVersion(actor: HrActor, policyId: string, versionId: string) {
    const version = await this.requireVersion(actor, policyId, versionId);

    if (version.status !== 'VALIDATED') {
      // §10.3/§11: `DRAFT → PUBLISHED` is absent from the transition table, so a DRAFT version is
      // refused on the grounds that it has not passed the gate — not merely that the state is wrong.
      throw new ConflictException(
        `Only a VALIDATED version may be published; this one is ${version.status}.`
      );
    }

    const predecessor = await this.policies.findPublishedVersion(actor.tenantId, policyId);

    if (predecessor !== null && predecessor.id !== versionId) {
      const limits = await this.policies.findLimitsForPolicyVersion(actor.tenantId, versionId);

      const overlapRefusals = validateLeavePolicyVersion(toAuthoredVersion(version, limits), {
        knownLeaveTypeIds: new Set(limits.map((limit) => limit.leaveTypeId)),
        reachableRequestStatuses: reachableRequestStatuses(),
        publishedInterval: intervalOf(predecessor),
        knownEmploymentTypes: knownEmploymentTypes(),
        resolveLimitWindow: resolveLeaveLimitWindow,
        storedWindow: windowOf(limits),
      }).filter((issue) => issue.refusal === 'PUBLISHED_INTERVAL_OVERLAP');

      if (overlapRefusals.length > 0) {
        throw new ConflictException({
          code: 'LEAVE_POLICY_VERSION_REFUSED',
          message:
            'This version would occupy an interval the version currently in force already covers; ' +
            'publishing it would leave two equally-current versions of this policy.',
          refusals: overlapRefusals,
        });
      }
    }

    const published = await this.policies.publishVersion(actor.tenantId, policyId, versionId, {
      at: new Date(),
      byEmployeeId: await this.requireActorEmployeeId(actor),
    });

    if (published === null) {
      throw new ConflictException(
        'This version is no longer VALIDATED; another request changed its state first.'
      );
    }

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.PUBLISH,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY_VERSION,
      resourceId: versionId,
      oldValue: { status: 'VALIDATED' },
      newValue: { status: 'PUBLISHED', archivedPredecessorId: predecessor?.id ?? null },
    });

    return published;
  }

  /**
   * `PUBLISHED → ARCHIVED`: takes a version out of selection WITHOUT publishing a successor.
   *
   * THIS IS NOT A CONVENIENCE WRAPPER AROUND `publish`. The two acts differ in what they leave
   * behind: publishing a successor archives its predecessor AND puts new rules in force, while
   * archiving alone withdraws the current version and leaves the policy with nothing published — a
   * legitimate state (§11 permits the transition and says nothing about requiring a successor) that
   * a tenant reaches while preparing next year's rules. Orchestrating one through the other would
   * have made "no version in force" reachable only as a side effect of a publish that had nothing to
   * publish.
   *
   * AN ARCHIVED VERSION STAYS RESOLVABLE (§10.3, §10.5). §23's guarantee — that a historical
   * evaluation can explain itself — requires the version that governed to remain readable, and the
   * column that makes it unselectable for NEW evaluations is `status`, not deletion. Nothing here
   * removes, rewrites or re-dates the row.
   */
  async archiveVersion(actor: HrActor, policyId: string, versionId: string, reason?: string) {
    const version = await this.requireVersion(actor, policyId, versionId);

    if (version.status !== 'PUBLISHED') {
      throw new ConflictException(
        `Only a PUBLISHED version may be archived; this one is ${version.status}.`
      );
    }

    // The domain is the authority on legality; this consults it rather than restating it.
    if (!isLeavePolicyVersionTransitionAllowed('PUBLISHED', 'ARCHIVED')) {
      throw new ConflictException('The lifecycle does not permit archiving a published version.');
    }

    const archived = await this.policies.applyVersionTransition(
      actor.tenantId,
      policyId,
      versionId,
      { from: 'PUBLISHED', to: 'ARCHIVED', at: new Date(), byEmployeeId: null }
    );

    if (archived === null) {
      throw new ConflictException(
        'This version is no longer PUBLISHED; another request archived or replaced it first.'
      );
    }

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.ARCHIVE,
      resource: HR_AUDIT_RESOURCE.LEAVE_POLICY_VERSION,
      resourceId: versionId,
      oldValue: { status: 'PUBLISHED' },
      newValue: { status: 'ARCHIVED' },
      reason: reason ?? null,
    });

    return archived;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The version in force for this policy.
   *
   * `PUBLISHED` ONLY, AND THAT IS THE WHOLE POINT OF THE READ. A version whose effective window has
   * ended but which has not been superseded is still the published one (the domain header's
   * distinction), so this does not filter by day: "which version governs this policy?" and "which
   * version governs this DAY?" are different questions, and the second belongs to the effective
   * resolver the request path will use.
   */
  async getPublishedVersion(actor: HrActor, policyId: string) {
    await this.requirePolicy(actor, policyId);

    const published = await this.policies.findPublishedVersion(actor.tenantId, policyId);

    if (published === null) {
      throw new NotFoundException('This policy has no published version.');
    }

    return published;
  }

  /** One version with its limits, both read tenant-scoped. */
  async getVersion(actor: HrActor, policyId: string, versionId: string) {
    const version = await this.requireVersion(actor, policyId, versionId);
    const limits = await this.policies.findLimitsForPolicyVersion(actor.tenantId, versionId);

    return { version, limits };
  }

  /**
   * THE EFFECTIVE-POLICY RESOLVER (§10.3-§10.5, §12, §15.4): "which PUBLISHED version governs this
   * context, and which of its limits are applicable?" — the authoritative application-level answer
   * the request path and the explanation renderer both need.
   *
   * WHY THIS IS HERE AND NOT IN THE REPOSITORY
   * -----------------------------------------
   * `findPublishedVersion` answers "which version of this POLICY is published?" and is a primitive:
   * it takes a `policyId`, so a caller must already know which policy it is asking about. That is the
   * wrong question for a request path, which knows only a LEAVE TYPE and a DAY — exactly the inputs
   * §15.4 authorises. Composing "which policy covers this leave type on this day, and is it
   * published?" is a POLICY DECISION, and `findLimitsForLeaveType`'s own doc says answering it in a
   * `WHERE` clause would hide a policy decision inside a query. So the decision lives here.
   *
   * WHY THE CALLER CANNOT NAME A VERSION
   * -----------------------------------
   * The signature takes a DAY, a LEAVE TYPE and an EMPLOYMENT SCOPE — and no `policyId`, no
   * `versionId`, no `status`. §12 makes this resolver authoritative precisely so that a caller
   * cannot force an `ARCHIVED` or `DRAFT` version into service; a parameter naming a version would
   * be an ANSWER to the question this method exists to ask, and §10.5's "still resolvable for
   * historical references" would decay into "selectable by anyone who can guess an id".
   *
   * THE FOUR GUARANTEES, AND WHERE EACH IS ENFORCED
   * -----------------------------------------------
   *   * PUBLISHED versions are eligible — asserted by the repository narrowing on
   *     `status: 'PUBLISHED'`, not by a filter written here that a second reader could forget.
   *   * ARCHIVED versions are NOT selected for a new evaluation. They are absent from the
   *     `PUBLISHED` narrowing, so withdrawal needs no extra predicate: archiving removes a version
   *     from selection by the act that archives it.
   *   * ARCHIVED versions REMAIN HISTORICALLY RESOLVABLE, but only when the caller says so
   *     (`includeArchived`), which is the explicit acknowledgement that it is asking "what did this
   *     resolve to back then?" rather than "what governs now?". A single implementation serves both
   *     questions so the two answers cannot drift apart.
   *   * Tenant isolation is structural: every read below is `actor.tenantId`-first, so a policy of
   *     another tenant is not found rather than refused (§24.6).
   *
   * `effectiveFrom`/`effectiveTo` REMAIN AUTHORITATIVE FOR DATE APPLICABILITY (§11): they decide
   * which version is in force ON THE DAY, and they are applied by the DATE narrowing on the limits
   * below. They are NOT a substitute for `ARCHIVED` — a superseded version is withdrawn by `status`
   * even on a day its window covers, which is the whole reason 54-F added the fourth state.
   *
   * THE REFUSAL IS THE SPEC'S (§15.8): when nothing governs, this returns the honest "no policy has
   * been stated" shape rather than inventing a default policy nobody approved. It answers `policy:
   * null` with an empty limit set instead of throwing, because "no policy covers this" is a real
   * configuration state a tenant is allowed to be in, and the request path's refusal decision
   * belongs to the rule that evaluates entitlements — not to a lookup that could not find one.
   */
  async resolveEffective(actor: HrActor, query: ResolveEffectiveLeavePolicyQueryDto) {
    // §15.4/§12: the day is a QUESTION and the server answers "today" when none is asked. The
    // default belongs at this boundary, not in the repository, so a stored read never reads a clock.
    const asOf = query.asOf === undefined ? toStoredDay(todayIso()) : toStoredDay(query.asOf);

    // The candidate limits for the day, already narrowed by the effective window. `employmentType` is
    // NOT pushed into this narrowing for the reason `findLimitsForLeaveType` documents: whether a
    // scope applies is §16.6's decision with a refusal consequence, and pre-filtering here would turn
    // "context is insufficient" into "no limit was found" — a different answer.
    //
    // THE LEAVE TYPE IS REQUIRED, and the DTO's `@IsOptional()` on it is deliberately not honoured
    // here: the route and the service disagree on purpose, and the service is the authority. A
    // resolution without a leave type has nothing to resolve — limits hang off leave types, so
    // "every type of the policy" would have to answer with every policy's every limit for the day,
    // which is not an answer to the question §12 makes this resolver authoritative for. A caller
    // that omits it is REFUSED rather than served a superset it will misread.
    if (query.leaveTypeId === undefined) {
      throw new BadRequestException('A leave type is required to resolve the effective policy.');
    }

    const candidates = await this.policies.findLimitsForLeaveType(
      actor.tenantId,
      query.leaveTypeId,
      asOf
    );

    // The applicability decision is THREE-VALUED at its own boundary (`true` / `false` / a refusal
    // for "this scope cannot be decided from the context given"). A candidate that cannot be decided
    // is NOT silently dropped here: dropping it would turn §16.7's "refuse because context is
    // missing" into "no limit governs you", which the invariants state is a different answer. So the
    // undecidable candidates travel with the result and the caller refuses on them.
    const applicable: StoredLeaveLimit[] = [];
    const undecidable: StoredLeaveLimit[] = [];

    for (const limit of candidates) {
      const verdict = isLeaveLimitApplicableToEmploymentType(
        limit.employmentType as LeaveLimitEmploymentType | null,
        (query.employmentType ?? null) as LeaveLimitEmploymentType | null
      );

      if (verdict === true) applicable.push(limit);
      else if (verdict === false) continue;
      else undecidable.push(limit);
    }

    const scoped = applicable;

    // The version that governs, resolved from the candidates' OWN policy ids rather than from a
    // caller-supplied one. A limit names its version, and a version names its policy, so the day's
    // limits are what identify the configuration in force — there is no second source that could
    // disagree with them.
    const versionIds = [...new Set(scoped.map((limit) => limit.policyVersionId))];

    const governing: StoredLeavePolicyVersion[] = [];
    for (const versionId of versionIds) {
      const version = await this.policies.findVersionById(actor.tenantId, versionId);

      if (version === null) continue;

      // PUBLISHED governs a NEW evaluation. An ARCHIVED version is returned ONLY on request, and it
      // is returned as a historical fact rather than as a selectable configuration.
      if (version.status === 'PUBLISHED') {
        governing.push(version);
      } else if (query.includeArchived === true && version.status === 'ARCHIVED') {
        governing.push(version);
      }
    }

    // At most one version governs a policy, so more than one distinct POLICY in force for one leave
    // type on one day is an ambiguous configuration — refused rather than resolved by a tiebreak
    // nobody specified. §12.3 names conflicting definitions as a validation refusal, and choosing
    // which of two policies the tenant meant is the "silent winner" D11 forbids.
    const policyIds = [...new Set(governing.map((version) => version.policyId))];

    if (policyIds.length > 1) {
      throw new ConflictException(
        'More than one leave policy covers this leave type on this day; the configuration is ambiguous.'
      );
    }

    const policy =
      policyIds.length === 0 ? null : await this.policies.findPolicy(actor.tenantId, policyIds[0]);

    return {
      asOf: query.asOf ?? todayIso(),
      policy,
      version: governing.length === 0 ? null : governing[0],
      limits: scoped,
      // Carried rather than dropped: the request path refuses on these (§16.7) instead of treating
      // them as "no limit applies", which would grant an entitlement nobody stated.
      undecidableLimits: undecidable,
      // The two questions get different answers, so the caller can always tell which one it received.
      historical: query.includeArchived === true,
    };
  }

  // -------------------------------------------------------------------------
  // Preconditions — each one refuses rather than defaults
  // -------------------------------------------------------------------------

  private async requirePolicy(actor: HrActor, policyId: string) {
    const policy = await this.policies.findPolicy(actor.tenantId, policyId);

    if (policy === null) throw new NotFoundException('Leave policy not found.');

    return policy;
  }

  private async requireVersion(actor: HrActor, policyId: string, versionId: string) {
    const version = await this.policies.findVersion(actor.tenantId, policyId, versionId);

    if (version === null) throw new NotFoundException('Leave policy version not found.');

    // A stored row carrying a state the domain does not know is a DATA defect, and it is reported as
    // one rather than mapped onto the nearest member — the same distinction the domain's
    // `isLeavePolicyVersionTransitionAllowed` draws with its `null`.
    if (!isLeavePolicyVersionStatus(version.status)) {
      throw new ConflictException(
        `This version carries an unrecognized lifecycle state (${String(version.status)}).`
      );
    }

    return version;
  }

  /**
   * The acting operator's own employee id, for `published_by_employee_id`.
   *
   * §10.4 requires the publication to record WHO performed it, and the column is NOT NULL for a
   * published row (the migration's state CHECK ties the two together). A Core user is not an
   * employee, so the link has to be resolved — and when it cannot be, the publish is REFUSED rather
   * than stamped with a guess. A `null` publisher would either break the CHECK or have to be
   * represented by an employee id nobody can look up, and "somebody published this" is exactly the
   * sentence an audit trail exists to make answerable.
   */
  private async requireActorEmployeeId(actor: HrActor): Promise<string> {
    if (actor.userId === null) {
      throw new ConflictException(
        'Publishing a leave policy requires an authenticated operator: the publication records who performed it.'
      );
    }

    // `findByIdentityUserId` is the module's one Core-identity -> HR-employee lookup (Phase 54-E
    // §25.2), reused rather than duplicated so the direction of that crossing stays single: a Core id
    // becomes an HR id here and nowhere else, so no path can expose a login.
    const employee = await this.employees.findByIdentityUserId(actor.tenantId, actor.userId);

    if (employee === null) {
      throw new ConflictException(
        'This operator has no employee record in this tenant, so a publication cannot be attributed.'
      );
    }

    return employee.id;
  }

  /**
   * Which of the referenced leave types exist in THIS tenant.
   *
   * AN EMPTY SET IS A MEANINGFUL ANSWER and the validator treats it as one: a version whose every
   * leave type is unresolvable is refused for every limit, rather than accepted on the grounds that
   * "nothing was known to be wrong". The fail-closed direction is stated here, where the set is
   * built, so a reader does not have to infer it from the validator's absence-handling.
   *
   * The reads go through the leave aggregate's OWN repository: the type catalogue belongs to
   * `LeaveType`, and asking `LeavePolicyRepository` about it would make the policy repository a
   * second reader of a table another aggregate owns.
   */
  private async knownLeaveTypeIds(
    actor: HrActor,
    limits: readonly StoredLeaveLimit[]
  ): Promise<ReadonlySet<string>> {
    const referenced = [...new Set(limits.map((limit) => limit.leaveTypeId))];

    const resolved = await Promise.all(
      referenced.map(async (leaveTypeId) => {
        const type = await this.leave.findTypeById(actor.tenantId, leaveTypeId);

        return type === null ? null : leaveTypeId;
      })
    );

    return new Set(resolved.filter((id): id is string => id !== null));
  }
}

// -- Module-level helpers ---------------------------------------------------
// Outside the class because none of them reads `this` or a clock: they convert between shapes three
// layers already agreed on, and a private method would imply the class owns the conversion.

/**
 * A STORED version plus its stored limits, read as the untrusted authored shape the validator's
 * single entry point accepts.
 *
 * The two callers (`validateVersion` and `publishVersion`) present the same document, so the mapping
 * exists once: a second inline conversion is how one caller ends up checking a subtly different body
 * than the other.
 */
function toAuthoredVersion(version: StoredLeavePolicyVersion, limits: readonly StoredLeaveLimit[]) {
  return {
    versionLabel: version.versionLabel,
    jalaliYear: version.jalaliYear,
    effectiveFrom: formatStoredDay(version.effectiveFrom),
    effectiveTo: version.effectiveTo === null ? null : formatStoredDay(version.effectiveTo),
    payload: version.payload,
    limits: limits.map(toAuthoredLimit),
  };
}

/**
 * The request states the CURRENT lifecycle can actually reach (§16.4/§21.6).
 *
 * DERIVED FROM THE TRANSITION TABLE RATHER THAN LISTED. A state no transition can enter is one no
 * request can ever be in, so a limit consuming only it would be met by nobody — which the validator
 * refuses as INSUFFICIENT CONTEXT. Listing the reachable set by hand would be a second answer that
 * silently drifts the day a transition is added.
 */
function reachableRequestStatuses(): ReadonlySet<LeaveRequestStatus> {
  const reachable = new Set<string>();

  for (const [from, targets] of Object.entries(LEAVE_REQUEST_STATUS_TRANSITIONS)) {
    reachable.add(from);
    for (const target of targets as readonly string[]) reachable.add(target);
  }

  return reachable as ReadonlySet<LeaveRequestStatus>;
}

/**
 * The employment scopes this tenant's vocabulary accepts (§16.6).
 *
 * The vocabulary is `HR_EMPLOYMENT_TYPES`, the same closed list the DTO's own `HrEmploymentType`
 * union is derived from and the same set the column's type carries — so a member the validator
 * accepts is a member the database can store, and the two cannot disagree. §16.6's "applies to every
 * employment type" is expressed by an ABSENT scope, not by a member, which is why nothing is added
 * here to mean "all".
 */
function knownEmploymentTypes(): ReadonlySet<string> {
  return new Set<string>(HR_EMPLOYMENT_TYPES);
}

/**
 * The stored effective interval of one version, as the validator's two-day shape (`end: null` means
 * open-ended, §15.4), or `null` when no version is published.
 */
function intervalOf(
  version: StoredLeavePolicyVersion | null
): { readonly start: string; readonly end: string | null } | null {
  if (version === null) return null;

  return {
    start: formatStoredDay(version.effectiveFrom),
    end: version.effectiveTo === null ? null : formatStoredDay(version.effectiveTo),
  };
}

/**
 * The stored window of a limit set, or `null` when no limit was stored to read back.
 *
 * A version whose limits were never written has no window to be wrong about, so `null` — which the
 * validator's header states means "resolve and confirm" — is the honest answer rather than a window
 * invented here. The window is a property of the VERSION rather than of each limit: the DTO resolves
 * every limit from the version's own `jalaliYear`, so a set whose rows disagreed would be a defect
 * `LIMIT_WINDOW_YEAR_MISMATCH` names, and reading the first row is therefore the check rather than a
 * sample.
 */
function windowOf(limits: readonly StoredLeaveLimit[]): { start: string; end: string } | null {
  const first = limits[0];

  if (first === undefined) return null;

  return { start: formatStoredDay(first.windowStart), end: formatStoredDay(first.windowEnd) };
}

/** A STORED limit, read as an authored one so the validator's single entry point can judge it. */
function toAuthoredLimit(limit: StoredLeaveLimit): AuthoredLeaveLimit {
  return {
    leaveTypeId: limit.leaveTypeId,
    employmentType: limit.employmentType,
    maximum: limit.maximum,
    countingBasis: limit.countingBasis,
    period: limit.period,
    // The stored state list is the authority; the fallback exists only because the authored shape
    // admits `undefined`, and an empty array would be read as "consumes nothing" — a different, and
    // worse, refusal than the one the stored row actually earns.
    consumesStates:
      limit.consumesStates.length > 0
        ? limit.consumesStates
        : [...LEAVE_POLICY_LIMIT_CONSUMED_STATES],
    effectiveFrom: formatStoredDay(limit.effectiveFrom),
    effectiveTo: limit.effectiveTo === null ? null : formatStoredDay(limit.effectiveTo),
  };
}

/** The authored limits, with each window RESOLVED through the module's one calendar boundary. */
function toLimitWrites(
  limits: readonly LeavePolicyLimitDto[],
  jalaliYear: number
): LeaveLimitWrite[] {
  return limits.map((limit) => {
    // §16.2: resolved HERE and stored, so no reader ever resolves it again — and so the window and
    // the year cannot disagree, because one call produced both.
    const window = resolveLeaveLimitWindow(limit.period, jalaliYear);

    return {
      leaveTypeId: limit.leaveTypeId,
      // §16.6: an ABSENT scope means "applies to every employment type", which the column expresses
      // as SQL NULL — so `undefined` and `null` are one stored fact and are collapsed here rather than
      // travelling to the repository as two different shapes meaning the same thing.
      employmentType: limit.employmentType ?? null,
      maximum: limit.maximum,
      countingBasis: limit.countingBasis,
      period: limit.period,
      jalaliYear,
      windowStart: toStoredDay(window.start),
      windowEnd: toStoredDay(window.end),
      consumesStates: limit.consumesStates,
      effectiveFrom: toStoredDay(limit.effectiveFrom),
      // Same tri-state collapse as the version's own `effectiveTo`: for a limit, an absent end means
      // "no end", which is the SQL NULL the authored shape spells `undefined` and the stored shape
      // spells `null`.
      effectiveTo:
        limit.effectiveTo === undefined || limit.effectiveTo === null
          ? null
          : toStoredDay(limit.effectiveTo),
    };
  });
}

/**
 * The `effectiveTo` an update should store: absent means "leave it alone", `null` means "make it
 * open-ended", and a day means "end it here". The three are different intentions, and collapsing the
 * first two would make it impossible to open-end a version by update.
 */
function resolveEffectiveTo(
  version: StoredLeavePolicyVersion,
  update: string | null | undefined
): Date | null {
  if (update === undefined) return version.effectiveTo;
  if (update === null) return null;

  return toStoredDay(update);
}

/** A `DRAFT`-only precondition, refused with the verb the caller attempted (§10.3). */
function requireDraft(version: StoredLeavePolicyVersion, verb: string): void {
  if (version.status !== 'DRAFT') {
    throw new ConflictException(
      `Only a DRAFT version may be ${verb}; this one is ${version.status}.`
    );
  }
}

/**
 * `YYYY-MM-DD` → the `Date` a `@db.Date` column stores.
 *
 * PARSED AS UTC MIDNIGHT, deliberately: constructing the date from parts in LOCAL time would make the
 * stored day depend on the server's timezone, and a version effective on the 1st in Tehran and on the
 * 28th of the previous month in UTC is the class of defect this one line prevents.
 */
function toStoredDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The inverse, so a stored day reads back as the `YYYY-MM-DD` the validator's calendar produces. */
function formatStoredDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/**
 * The server's today, as the `YYYY-MM-DD` the resolver's `asOf` is spelled in (§15.4).
 *
 * A LOCAL DAY, NOT A UTC ONE, and that is the opposite choice from `toStoredDay` — deliberately. A
 * stored `@db.Date` names a calendar day and must not shift with the server's timezone, so it is
 * parsed as UTC. "Today" is a different question: §15.4's default answers "as of when the question
 * was asked", which is a fact about the tenant's day, and an operator in Tehran asking at 02:00 must
 * not be answered with yesterday because the server runs in UTC.
 */
function todayIso(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');

  return `${now.getFullYear()}-${month}-${day}`;
}
