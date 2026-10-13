import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { validateRuleSetVersion } from '../../../rules/core/rule-validator';
import type { RuleConditionNode } from '../../../rules/rule-condition.interface';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import {
  COMMERCE_AUDIT_RESOURCE,
  COMMERCE_DEFAULT_PAGE_SIZE,
  COMMERCE_MAX_PAGE_SIZE,
} from '../commerce.constants';
import type { CommercePageQueryDto } from '../dto/commerce-query.dto';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { COMMERCIAL_AUDIT_ACTION, COMMERCIAL_FAILURE } from './commercial.constants';
import { CommercialConfigurationRepository } from './commercial-configuration.repository';
import { CommercialLiaisonResolver } from './commercial-liaison';
import {
  commercialApprovalApplicabilityRuleSet,
  commercialAssignmentRuleId,
  commercialAssignmentRuleSet,
} from './commercial-rule';
import type { CommercialAssignmentRule } from './commercial-rule';
import {
  isCommercialApprovalActivation,
  isCommercialApprovalApprover,
  isCommercialAssignmentTrigger,
  isCommercialMatchBehavior,
  isCommercialNoAssignmentBehavior,
  isCommercialProjectionPolicy,
} from './commercial-status';
import type {
  CreateCommercialConfigurationDto,
  CreateCommercialGroupDto,
  UpdateCommercialConfigurationDto,
  UpdateCommercialGroupDto,
} from './commercial.dto';

/**
 * Phase C1 Step P (§7, §9): the COMMERCIAL CONFIGURATION surface — Commercial Groups
 * and versioned commercial policy. Repositories persist; this service validates and
 * orchestrates.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 *  * groups: create, rename, swap liaison — with code uniqueness, tenant ownership and
 *    liaison validation (§3-K, §7);
 *  * versions: create, edit-a-draft, validate, publish, archive — the §7 checklist in
 *    full, applied to the ROW rather than to the request, so a version written by any
 *    path is checked the same way before it may govern a purchase.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 * No Prisma statement (gate A: statements live in `.repository.ts` files), no rule
 * evaluation beyond `validateRuleSetVersion`'s static report, no identity lookup
 * outside `CommercialLiaisonResolver`, and no `tenantId` taken from a caller — the
 * actor is the only source of the tenant.
 *
 * THE VALIDATE-THEN-PUBLISH FLOW IS M AND O'S, NOT A NEW ONE: `validate` walks
 * DRAFT → VALIDATED, `publish` requires VALIDATED and archives the previously
 * published version in the SAME unit of work (§7.9, §3-B's single-published
 * invariant). Immutability is both stated here (a published row is refused with its
 * status named) and executed by the repository's conditional `status: 'DRAFT'`
 * predicate — the two cannot drift, because the statement would refuse a write the
 * service allowed.
 */

/** One stored version, as the repository returns it — structural, no generated client. */
export type CommercialConfigurationRecord = NonNullable<
  Awaited<ReturnType<CommercialConfigurationRepository['findConfigurationById']>>
>;

/** One stored group. */
export type CommercialGroupRecord = NonNullable<
  Awaited<ReturnType<CommercialConfigurationRepository['findGroupById']>>
>;

@Injectable()
export class CommercialConfigurationService {
  constructor(
    private readonly configurationRepository: CommercialConfigurationRepository,
    private readonly liaison: CommercialLiaisonResolver,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  /**
   * One page of the tenant's groups, ordered by their own code.
   *
   * PHASE C8 (GAP-5): the shared `search` filter now REACHES the repository, and the page
   * and its `total` are read by ONE statement pair inside `listGroupPage` — a page and a
   * total built from two different predicates would let a client page past the end of its
   * own query. The actor still supplies the tenant and nothing else: `search` narrows
   * WITHIN `actor.tenantId` and cannot widen it, which is the property every other
   * Commerce list search already has.
   */
  async listGroups(actor: CommerceActor, query: CommercePageQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      COMMERCE_MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE)
    );

    const [items, total] = await this.configurationRepository.listGroupPage(
      actor.tenantId,
      { search: query.search },
      { skip: (page - 1) * pageSize, take: pageSize }
    );

    return { items, page, pageSize, total };
  }

  /** One group, or 404 for an id this tenant does not hold (never a 403: no existence leaks). */
  async getGroup(actor: CommerceActor, id: string): Promise<CommercialGroupRecord> {
    const group = await this.configurationRepository.findGroupById(actor.tenantId, id);
    if (!group) throw new NotFoundException('Commercial group not found');
    return group;
  }

  /**
   * Create a group (§9).
   *
   * A PRESENT `liaisonUserId` is validated as a tenant member BEFORE the row exists —
   * storing an identity outside this tenant would create a row no assignment could
   * ever resolve, because §3-K refuses rather than falls back. An ABSENT one is legal:
   * §3-K models "no configured liaison" as a real state.
   *
   * `null` from the repository is EXACTLY the tenant's `code` collision (the repository
   * maps that one constraint and rethrows everything else), reported with the
   * contract's own code rather than as a 500 from the unique index.
   */
  async createGroup(actor: CommerceActor, dto: CreateCommercialGroupDto) {
    if (dto.liaisonUserId) {
      await this.liaison.assertTenantMember(actor, dto.liaisonUserId, `group ${dto.code}`);
    }

    const group = await this.configurationRepository.createGroup(actor.tenantId, {
      code: dto.code,
      name: dto.name,
      liaisonUserId: dto.liaisonUserId ?? null,
    });

    if (!group) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_GROUP_CODE_TAKEN,
        message: `A commercial group with code ${dto.code} already exists in this tenant.`,
      });
    }

    await this.audit.record(actor, {
      action: COMMERCIAL_AUDIT_ACTION.GROUP_CREATED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_GROUP,
      resourceId: group.id,
      newValue: { code: group.code, name: group.name, liaisonUserId: group.liaisonUserId },
    });

    return group;
  }

  /**
   * Rename a group and/or swap its liaison (§8, §9).
   *
   * THE SWAP CHANGES CONFIGURATION AND NOTHING ELSE (§3-C): no assignment row, no
   * history row and no approval is touched. Current assignments keep the user resolved
   * AT ASSIGNMENT TIME, which is exactly what makes January's liaison discoverable
   * after February's swap.
   *
   * A changed liaison produces its OWN audit event (`liaison_changed`) beside the
   * generic `updated`, because "who changed this group's liaison?" is the question §9
   * singles out and a trail that answered it only under `updated` would not be
   * searchable by that act.
   *
   * Absent field = untouched; `null` = cleared (the DTO keeps the two apart).
   */
  async updateGroup(actor: CommerceActor, id: string, dto: UpdateCommercialGroupDto) {
    const before = await this.getGroup(actor, id);

    if (dto.liaisonUserId !== undefined && dto.liaisonUserId !== null) {
      await this.liaison.assertTenantMember(actor, dto.liaisonUserId, `group ${before.code}`);
    }

    const updated = await this.configurationRepository.updateGroup(actor.tenantId, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.liaisonUserId !== undefined ? { liaisonUserId: dto.liaisonUserId } : {}),
    });
    if (!updated) throw new NotFoundException('Commercial group not found');

    if (dto.name !== undefined) {
      await this.audit.record(actor, {
        action: COMMERCIAL_AUDIT_ACTION.GROUP_UPDATED,
        resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_GROUP,
        resourceId: updated.id,
        oldValue: { name: before.name },
        newValue: { name: updated.name },
        changedFields: ['name'],
      });
    }

    if (dto.liaisonUserId !== undefined && dto.liaisonUserId !== before.liaisonUserId) {
      await this.audit.record(actor, {
        action: COMMERCIAL_AUDIT_ACTION.LIAISON_CHANGED,
        resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_GROUP,
        resourceId: updated.id,
        oldValue: { liaisonUserId: before.liaisonUserId },
        newValue: { liaisonUserId: updated.liaisonUserId },
        changedFields: ['liaisonUserId'],
      });
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // CommercialConfigurationVersion (§3-B, §3-G, §7)
  // ---------------------------------------------------------------------------

  /**
   * One page of the tenant's configuration versions, newest first.
   *
   * PHASE C8 (GAP-5): `search` (the shared DTO's text filter) reaches the repository, where
   * the rows and the `total` are read by ONE statement pair — a filtered read therefore
   * reports `total` = the number of versions the caller can actually page through. Nothing
   * else moves: the window arithmetic, the ordering and the row projection are exactly what
   * they were, and the tenant is still `actor.tenantId`.
   */
  async listConfigurations(actor: CommerceActor, query: CommercePageQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      COMMERCE_MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE)
    );

    const [items, total] = await this.configurationRepository.listConfigurationPage(
      actor.tenantId,
      { search: query.search },
      { skip: (page - 1) * pageSize, take: pageSize }
    );

    return { items, page, pageSize, total };
  }

  /** One version — the READ carries the whole row, conditions and rules included. */
  async getConfiguration(actor: CommerceActor, id: string): Promise<CommercialConfigurationRecord> {
    const version = await this.configurationRepository.findConfigurationById(actor.tenantId, id);
    if (!version) throw new NotFoundException('Commercial configuration not found');
    return version;
  }

  /**
   * Create a DRAFT version (§9).
   *
   * Nothing structural is decided here: §7's checks belong to `validate` and `publish`,
   * because a DRAFT exists precisely so an administrator can iterate on it before it is
   * held to the checklist. What IS decided is that the label is unique (§7.1) — a
   * `null` back from the repository is the collision the schema refused, and the
   * contract's named failure is what the caller sees rather than a 500.
   *
   * The row is born `DRAFT` (the column's own default), and `PUBLISHED` is reachable
   * only through this service's `publish`.
   */
  async createConfiguration(actor: CommerceActor, dto: CreateCommercialConfigurationDto) {
    await this.assertLabelAvailable(actor, dto.versionLabel);

    const version = await this.configurationRepository.createConfiguration(actor.tenantId, {
      versionLabel: dto.versionLabel,
      assignmentTrigger: dto.assignmentTrigger,
      noAssignmentBehavior: dto.noAssignmentBehavior,
      matchBehavior: dto.matchBehavior,
      assignmentRules: dto.assignmentRules,
      approvalActivation: dto.approvalActivation,
      approvalApprover: dto.approvalApprover ?? null,
      approverUserId: dto.approverUserId ?? null,
      applicabilityCondition: dto.applicabilityCondition ?? null,
      projectionPolicy: dto.projectionPolicy,
    });

    if (!version) throw this.labelTaken(dto.versionLabel);

    await this.audit.record(actor, {
      action: COMMERCIAL_AUDIT_ACTION.CONFIGURATION_CREATED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_CONFIGURATION_VERSION,
      resourceId: version.id,
      newValue: { versionLabel: version.versionLabel, status: version.status },
    });

    return version;
  }

  /**
   * Edit a DRAFT (§9: "edit draft only").
   *
   * TWO CONDITIONS, CHECKED IN THIS ORDER because the second is the honest answer to
   * the first: a version that is not a DRAFT is refused with its own status named (an
   * administrator who tried to edit a PUBLISHED version needs to know it is published),
   * and only then is the edit considered.
   *
   * `undefined` = untouched, `null` = clear. Only fields the caller stated become part
   * of the patch, so two concurrent editors of different fields cannot overwrite each
   * other's work with values they never sent (the discipline `purchase.service.update`
   * states for documents).
   *
   * Immutability is RE-STATED here and EXECUTED by the repository's conditional
   * `status: 'DRAFT'` predicate: a `null` back means the version moved on while this
   * request was being applied, answered as a conflict rather than as a silent success.
   */
  async updateConfiguration(
    actor: CommerceActor,
    id: string,
    dto: UpdateCommercialConfigurationDto
  ): Promise<CommercialConfigurationRecord> {
    const before = await this.getConfiguration(actor, id);
    if (before.status !== 'DRAFT') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: `A commercial configuration in status ${before.status} is immutable; edit a draft or create a new version.`,
      });
    }

    if (dto.versionLabel !== undefined && dto.versionLabel !== before.versionLabel) {
      await this.assertLabelAvailable(actor, dto.versionLabel, id);
    }

    const updated = await this.configurationRepository.updateDraftConfiguration(
      actor.tenantId,
      id,
      {
        ...(dto.versionLabel !== undefined ? { versionLabel: dto.versionLabel } : {}),
        ...(dto.assignmentTrigger !== undefined
          ? { assignmentTrigger: dto.assignmentTrigger }
          : {}),
        ...(dto.noAssignmentBehavior !== undefined
          ? { noAssignmentBehavior: dto.noAssignmentBehavior }
          : {}),
        ...(dto.matchBehavior !== undefined ? { matchBehavior: dto.matchBehavior } : {}),
        ...(dto.assignmentRules !== undefined ? { assignmentRules: dto.assignmentRules } : {}),
        ...(dto.approvalActivation !== undefined
          ? { approvalActivation: dto.approvalActivation }
          : {}),
        ...(dto.approvalApprover !== undefined ? { approvalApprover: dto.approvalApprover } : {}),
        ...(dto.approverUserId !== undefined ? { approverUserId: dto.approverUserId } : {}),
        ...(dto.applicabilityCondition !== undefined
          ? { applicabilityCondition: dto.applicabilityCondition }
          : {}),
        ...(dto.projectionPolicy !== undefined ? { projectionPolicy: dto.projectionPolicy } : {}),
      }
    );

    if (!updated) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The commercial configuration is no longer a draft; it may not be edited.',
      });
    }

    return updated;
  }

  /**
   * Run the §7 checklist and walk DRAFT → VALIDATED (§9).
   *
   * The checklist runs against the ROW, not against the request: whatever wrote this
   * version is checked the same way, and the result is what `publish` will re-run before
   * it lets the version govern a purchase. Identity checks are made HERE, before any
   * transaction is opened — a gateway round trip inside a unit of work holds a
   * connection open for a network call.
   */
  async validateConfiguration(actor: CommerceActor, id: string) {
    const row = await this.getConfiguration(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: `Only a DRAFT configuration may be validated; this one is ${row.status}.`,
      });
    }

    await this.assertPublishable(actor, row);

    const validated = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.configurationRepository.validateConfigurationIn(actor.tenantId, tx, id)
    );
    if (!validated) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The commercial configuration is no longer a draft; it may not be validated.',
      });
    }

    await this.audit.record(actor, {
      action: COMMERCIAL_AUDIT_ACTION.CONFIGURATION_VALIDATED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_CONFIGURATION_VERSION,
      resourceId: validated.id,
      oldValue: { status: row.status },
      newValue: { status: validated.status },
    });

    return validated;
  }

  /**
   * Validate + publish + archive the previous version (§9, §7.9, §3-B).
   *
   * ALL THREE ARE ONE UNIT OF WORK. Publishing without archiving would leave two
   * published versions and force §3-B's ambiguity refusal on the next activation;
   * archiving without publishing would retire the tenant's policy without replacing
   * it. The repository performs both statements on the handle, so a failure between
   * them rolls the pair back.
   *
   * The §7 checklist runs BEFORE the unit of work, for the reason stated on `validate`:
   * it needs the identity gateway. A version that fails it never reaches the
   * transaction at all.
   */
  async publishConfiguration(actor: CommerceActor, id: string) {
    const row = await this.getConfiguration(actor, id);
    if (row.status === 'PUBLISHED') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'A published configuration is immutable; publish a new version instead.',
      });
    }
    if (row.status === 'ARCHIVED') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'An archived configuration cannot be published; create a new version.',
      });
    }

    await this.assertPublishable(actor, row);

    const published = await this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      // DRAFT → VALIDATED inside the same act as VALIDATED → PUBLISHED: §9's route is
      // "validate + publish", and a version validated by a previous request simply
      // already satisfies the first transition.
      if (row.status === 'DRAFT') {
        const validated = await this.configurationRepository.validateConfigurationIn(
          actor.tenantId,
          tx,
          id
        );
        if (!validated) return null;
      }
      return this.configurationRepository.publishConfigurationIn(actor.tenantId, tx, id);
    });

    if (!published) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The commercial configuration could not be published from its current state.',
      });
    }

    await this.audit.record(actor, {
      action: COMMERCIAL_AUDIT_ACTION.CONFIGURATION_PUBLISHED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_CONFIGURATION_VERSION,
      resourceId: published.id,
      oldValue: { status: row.status },
      newValue: { status: published.status, versionLabel: published.versionLabel },
    });

    return published;
  }

  /**
   * Archive a version (§9).
   *
   * An explicit call never no-ops (§3-A): archiving an already-archived version is a
   * conflict naming the status, not a 200 that says nothing. Archiving the PUBLISHED
   * version is deliberately ALLOWED — it retires the tenant's policy, after which §3-A
   * makes automatic commercial effects no-ops until a new one is published.
   */
  async archiveConfiguration(actor: CommerceActor, id: string) {
    const row = await this.getConfiguration(actor, id);
    if (row.status === 'ARCHIVED') {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The commercial configuration is already archived.',
      });
    }

    const archived = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.configurationRepository.archiveConfigurationIn(actor.tenantId, tx, id)
    );
    if (!archived) {
      throw new ConflictException({
        code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
        message: 'The commercial configuration could not be archived from its current state.',
      });
    }

    await this.audit.record(actor, {
      action: COMMERCIAL_AUDIT_ACTION.CONFIGURATION_ARCHIVED,
      resource: COMMERCE_AUDIT_RESOURCE.COMMERCIAL_CONFIGURATION_VERSION,
      resourceId: archived.id,
      oldValue: { status: row.status },
      newValue: { status: archived.status },
    });

    return archived;
  }

  // ---------------------------------------------------------------------------
  // §7 — the publish/validation checklist, executed against the stored ROW
  // ---------------------------------------------------------------------------

  /**
   * §7 in order, as written: every numbered rule below is the contract's own number.
   *
   * THE FAILURE IS ALWAYS A NAMED ERROR WITH A PRECISE REASON (§7's closing
   * paragraph) — never a truncation, never a coercion and never a silent pass. Three
   * codes are in play and each is the contract's: `COMMERCIAL_CONFIGURATION_INVALID`
   * for a §7 rule the version breaks, `COMMERCIAL_RULE_INVALID` for a condition or set
   * the rule engine refuses (§8), and `COMMERCIAL_RESOLVER_UNSUPPORTED` for §7.7's
   * unsupported resolver.
   *
   * §7.9 (publishing archives the previously published version) is NOT asserted here:
   * it is an action, and the repository performs it in the same unit of work as the
   * publish itself. Asserting it would describe a state the caller is about to change.
   */
  private async assertPublishable(actor: CommerceActor, row: CommercialConfigurationRecord) {
    // §7.1 — presence. Uniqueness is schema-enforced and pre-checked at write time.
    if (!row.versionLabel || row.versionLabel.trim().length === 0) {
      throw this.invalid('§7.1: versionLabel must be present.');
    }

    // §7.2 — the three closed vocabularies, plus the two behavioural ones §3-D fixes.
    if (!isCommercialAssignmentTrigger(row.assignmentTrigger)) {
      throw this.invalid(`§7.2: unsupported assignmentTrigger "${row.assignmentTrigger}".`);
    }
    if (!isCommercialApprovalActivation(row.approvalActivation)) {
      throw this.invalid(`§7.2: unsupported approvalActivation "${row.approvalActivation}".`);
    }
    if (!isCommercialProjectionPolicy(row.projectionPolicy)) {
      throw this.invalid(`§7.2: unsupported projectionPolicy "${row.projectionPolicy}".`);
    }
    if (!isCommercialNoAssignmentBehavior(row.noAssignmentBehavior)) {
      throw this.invalid(`§7.2: unsupported noAssignmentBehavior "${row.noAssignmentBehavior}".`);
    }
    if (!isCommercialMatchBehavior(row.matchBehavior)) {
      throw this.invalid(`§7.2: unsupported matchBehavior "${row.matchBehavior}".`);
    }

    // §7.7 — no unsupported resolver anywhere. Checked before §7.5/§7.8 so an
    // unexecutable resolver is reported as WHAT it is rather than as a missing field.
    if (row.approvalApprover !== null && !isCommercialApprovalApprover(row.approvalApprover)) {
      throw this.resolverUnsupported(
        `§7.7: unsupported approver resolver "${row.approvalApprover}"; only LINE_COMMERCIAL_LIAISON and CONFIGURED_USER are executable.`
      );
    }

    // §7.3 — every rule entry: present label, integer priority, a group of THIS
    // tenant, and a condition the frozen catalogue admits.
    const rules = this.readAssignmentRules(row.assignmentRules);
    const groupIds = new Set(await this.configurationRepository.listGroupIds(actor.tenantId));
    const seenRuleIds = new Set<string>();

    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      if (!rule || typeof rule !== 'object') {
        throw this.invalid(`§7.3: assignmentRules[${index}] must be an object.`);
      }
      if (typeof rule.label !== 'string' || rule.label.trim().length === 0) {
        throw this.invalid(`§7.3: assignmentRules[${index}].label must be present.`);
      }
      if (!Number.isSafeInteger(rule.priority)) {
        throw this.invalid(`§7.3: assignmentRules[${index}].priority must be an integer.`);
      }
      if (typeof rule.commercialGroupId !== 'string' || !groupIds.has(rule.commercialGroupId)) {
        throw this.invalid(
          `§7.3: assignmentRules[${index}].commercialGroupId does not exist in this tenant.`
        );
      }

      // Two entries producing the SAME rule id would make "which rule decided?" have
      // two answers and would collide inside the engine's own id space. The id comes
      // from the planner itself, so validation and execution can never spell it apart.
      const ruleId = commercialAssignmentRuleId(rule.commercialGroupId, rule.label);
      if (seenRuleIds.has(ruleId)) {
        throw this.invalid(
          `§7.3: assignmentRules[${index}] duplicates the rule label "${rule.label}" for the same group.`
        );
      }
      seenRuleIds.add(ruleId);
    }

    // §7.3 (conditions) and §7.4 (applicability) both mean "the reused catalogue
    // admits it", and `validateRuleSetVersion` IS that question: the sets are built
    // with `fields` bound to the frozen catalogues (§5), so an unknown fact is refused
    // here with the engine's own issue list rather than by a second field walker that
    // could disagree with the engine.
    const assignmentValidation = validateRuleSetVersion(commercialAssignmentRuleSet(rules));
    if (!assignmentValidation.valid) {
      throw this.ruleInvalid(
        `§7.3: the assignment rule set is invalid: ${assignmentValidation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`
      );
    }

    if (row.applicabilityCondition !== null && row.applicabilityCondition !== undefined) {
      const condition = row.applicabilityCondition as unknown as RuleConditionNode;
      const applicabilityValidation = validateRuleSetVersion(
        commercialApprovalApplicabilityRuleSet(condition)
      );
      if (!applicabilityValidation.valid) {
        throw this.ruleInvalid(
          `§7.4: the applicability condition is invalid: ${applicabilityValidation.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')}`
        );
      }
    }

    // §7.8 — a required activation must state how an approver resolves; NOT_REQUIRED
    // needs nothing, because it never creates a record.
    if (row.approvalActivation !== 'NOT_REQUIRED' && !row.approvalApprover) {
      throw this.invalid(
        `§7.8: approvalActivation ${row.approvalActivation} requires an approvalApprover.`
      );
    }

    // §7.5 — CONFIGURED_USER must name a user, and that user must be a tenant member.
    // Reported as §7's own failure (not as a liaison failure): §7's closing paragraph
    // makes every checklist break a `COMMERCIAL_CONFIGURATION_INVALID` with a precise
    // reason, and this is §7.5 rather than §3-K.
    if (row.approvalActivation !== 'NOT_REQUIRED' && row.approvalApprover === 'CONFIGURED_USER') {
      if (!row.approverUserId) {
        throw this.invalid('§7.5: approvalApprover CONFIGURED_USER requires approverUserId.');
      }
      if (!(await this.liaison.isTenantMember(actor, row.approverUserId))) {
        throw this.invalid('§7.5: approverUserId is not a member of this tenant.');
      }
    }

    // §7.6 — the approver must exist by the time it is asked to act. With assignment at
    // document workflow approval, an approval that activates at SUBMISSION would try to
    // resolve a LINE_COMMERCIAL_LIAISON on a line that has no assignment yet (§3-G).
    if (
      row.approvalApprover === 'LINE_COMMERCIAL_LIAISON' &&
      row.assignmentTrigger !== 'PURCHASE_SUBMITTED' &&
      row.approvalActivation !== 'NOT_REQUIRED' &&
      row.approvalActivation !== row.assignmentTrigger
    ) {
      throw this.invalid(
        `§7.6: approvalActivation ${row.approvalActivation} is earlier than assignmentTrigger ${row.assignmentTrigger}; a LINE_COMMERCIAL_LIAISON approver would not exist yet.`
      );
    }
  }

  /** §7.3's stored candidate list, as the planner's own type. Shape is checked by the caller. */
  private readAssignmentRules(raw: unknown): readonly CommercialAssignmentRule[] {
    if (!Array.isArray(raw)) {
      throw this.invalid('§7.3: assignmentRules must be an array.');
    }
    return raw as readonly CommercialAssignmentRule[];
  }

  // ---------------------------------------------------------------------------
  // The three §7 failure shapes, spelled once
  // ---------------------------------------------------------------------------

  private invalid(reason: string): ConflictException {
    return new ConflictException({
      code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
      message: reason,
    });
  }

  private ruleInvalid(reason: string): ConflictException {
    return new ConflictException({
      code: COMMERCIAL_FAILURE.COMMERCIAL_RULE_INVALID,
      message: reason,
    });
  }

  private resolverUnsupported(reason: string): ConflictException {
    return new ConflictException({
      code: COMMERCIAL_FAILURE.COMMERCIAL_RESOLVER_UNSUPPORTED,
      message: reason,
    });
  }

  private labelTaken(versionLabel: string): ConflictException {
    return new ConflictException({
      code: COMMERCIAL_FAILURE.COMMERCIAL_CONFIGURATION_INVALID,
      message: `A commercial configuration with versionLabel ${versionLabel} already exists in this tenant (§7.1).`,
    });
  }

  /**
   * §7.1's uniqueness pre-check, in ONE place so create and rename cannot answer it
   * differently. `exceptId` lets an edit keep its own label; the schema's unique index
   * remains the last line of defence for the concurrent case (§7.1 calls it
   * "schema-enforced" precisely because a check alone cannot close a race).
   */
  private async assertLabelAvailable(
    actor: CommerceActor,
    versionLabel: string,
    exceptId?: string
  ): Promise<void> {
    const existing = await this.configurationRepository.findConfigurationByLabel(
      actor.tenantId,
      versionLabel,
      exceptId
    );
    if (existing) throw this.labelTaken(versionLabel);
  }
}
