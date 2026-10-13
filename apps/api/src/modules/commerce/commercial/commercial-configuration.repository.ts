import { Injectable } from '@nestjs/common';
import { CommercePrismaService } from '../database/commerce-prisma.service';
import {
  CommerceTransactionHandle,
  unwrapCommerceTransaction,
} from '../database/commerce-transaction';
import { Prisma } from '../../../generated/commerce-client';
import type {
  CommercialConfigurationVersion,
  CommercialGroup,
} from '../../../generated/commerce-client';

/**
 * Phase C1 Step P: the CONFIGURATION persistence boundary — `CommercialGroup`
 * and `CommercialConfigurationVersion`.
 *
 * WHAT THIS FILE OWNS: reads and writes on the two configuration tables. It
 * does NOT validate §7 rules, resolve identities, evaluate rules, or write
 * audit — the service above it owns those.
 *
 * TENANCY: `tenantId` is the first parameter of every public method and
 * appears in every `where`. No `findUnique` is used for tenant-sensitive
 * access; composite uniques are addressed through tenant-scoped `findFirst`
 * or `updateMany` predicates (the repository guard's rules).
 *
 * LIFECYCLE: published versions are immutable — `updateDraftConfiguration` is
 * a CONDITIONAL write on `status: 'DRAFT'`, so the immutability the service
 * states is also the statement the database executes.
 */

export interface CommercialGroupWrite {
  readonly code: string;
  readonly name: string;
  readonly liaisonUserId: string | null;
}

export interface CommercialGroupPatch {
  readonly name?: string;
  readonly liaisonUserId?: string | null;
}

/**
 * PHASE C8 (GAP-5): the optional narrowing of a GROUP list read.
 *
 * `search` is the shared query DTO's one text filter (`CommercePageQueryDto.search`),
 * whose PUBLISHED meaning is «free-text match against the record's own identifying
 * column». A commercial group has TWO identifying columns and both are human-facing:
 * `code` (the tenant's own stable handle, unique inside the tenant) and `name` (the
 * label the surface renders). BOTH are matched, OR-combined — the exact shape
 * `WorkflowConfigurationRepository.listDefinitionPage` already applies to a workflow
 * definition's `code`/`name`, adopted rather than re-invented. Nothing else on the row
 * is searched: a liaison identity is an opaque reference and no enum or rule payload is
 * text a person types.
 *
 * BEFORE C8 THE PARAMETER WAS ACCEPTED AND IGNORED on this route (the DTO is the shared
 * base, the repository took no filter), which is the dishonest parameter this module's
 * DTOs and comments explicitly refuse. The phase makes it real rather than removing it,
 * because the entity HAS an identifying column to match.
 */
export interface CommercialGroupFilter {
  readonly search?: string;
}

/**
 * PHASE C8 (GAP-5): the optional narrowing of a CONFIGURATION-VERSION list read.
 *
 * ONE column: `versionLabel` — the tenant's own label for the version and the only text
 * that identifies it. It is the SAME column the completion-policy list and the
 * line-routing list already match on (`…/completion-policies`, `…/routing-versions`), so
 * every versioned configuration surface answers a `search` the same way. The rules,
 * applicability conditions and policy enums stored beside it are deliberately NOT
 * searched: they are configuration payload, not identifiers.
 *
 * Same before/after as `CommercialGroupFilter`: accepted-and-ignored until C8, honoured
 * now.
 */
export interface CommercialConfigurationFilter {
  readonly search?: string;
}

export interface CommercialConfigurationWrite {
  readonly versionLabel: string;
  readonly assignmentTrigger: 'PURCHASE_SUBMITTED' | 'AFTER_DOCUMENT_WORKFLOW_APPROVED';
  readonly noAssignmentBehavior: 'REJECT_OPERATION' | 'LEAVE_UNASSIGNED';
  readonly matchBehavior: 'HIGHEST_PRIORITY' | 'AMBIGUOUS_ERROR';
  readonly assignmentRules: unknown;
  readonly approvalActivation:
    'NOT_REQUIRED' | 'PURCHASE_SUBMITTED' | 'AFTER_DOCUMENT_WORKFLOW_APPROVED';
  readonly approvalApprover: 'LINE_COMMERCIAL_LIAISON' | 'CONFIGURED_USER' | null;
  readonly approverUserId: string | null;
  readonly applicabilityCondition: unknown | null;
  readonly projectionPolicy:
    | 'DOCUMENT_WORKFLOW'
    | 'ALL_LINES'
    | 'DOCUMENT_WORKFLOW_AND_COMMERCIAL'
    | 'ALL_LINES_AND_COMMERCIAL';
}

@Injectable()
export class CommercialConfigurationRepository {
  constructor(private readonly prisma: CommercePrismaService) {}

  // ---------------------------------------------------------------------------
  // CommercialGroup
  // ---------------------------------------------------------------------------

  /**
   * CREATE — or `null` when this tenant's `code` uniqueness was violated.
   *
   * WHY THE CONSTRAINT IS TRANSLATED HERE (and nowhere else). `@@unique([tenantId,
   * code])` is the real answer to "may two groups share a code", and only the
   * statement that violates it can report WHICH constraint refused. The service must
   * not import the generated client to ask (gate A), and a pre-check alone would lose
   * exactly the race it exists to win. So the repository maps ONE constraint — the
   * tenant's `code` — to `null`, which the service turns into the contract's
   * `COMMERCIAL_GROUP_CODE_TAKEN`, and rethrows everything else unchanged: no other
   * failure is swallowed and no business rule is decided here.
   */
  async createGroup(tenantId: string, data: CommercialGroupWrite): Promise<CommercialGroup | null> {
    try {
      return await this.prisma.commercialGroup.create({ data: { tenantId, ...data } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        CommercialConfigurationRepository.isCodeCollision(error.meta)
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * True when a `P2002` names the group CODE constraint and nothing else.
   *
   * `meta.target` is the offending index, spelled either as one string or as a list of
   * columns depending on the connector. Reading it as a list and requiring a member
   * that names `code` is what stops a future unique index — say, on `liaisonUserId` —
   * from being reported to the caller as "that code is taken".
   */
  private static isCodeCollision(meta: unknown): boolean {
    return CommercialConfigurationRepository.targetNames(meta).some((name) =>
      name.toLowerCase().includes('code')
    );
  }

  /** True when a `P2002` names the version LABEL constraint (§7.1's uniqueness). */
  private static isLabelCollision(meta: unknown): boolean {
    return CommercialConfigurationRepository.targetNames(meta).some((name) =>
      name.toLowerCase().includes('label')
    );
  }

  /**
   * The offending index of a `P2002`, as a list of names.
   *
   * `meta.target` is spelled either as one string or as a list of columns depending on
   * the connector; normalising it here is what lets both callers require the RIGHT
   * member rather than accepting any unique violation as their own error.
   */
  private static targetNames(meta: unknown): string[] {
    const target = (meta as { readonly target?: unknown } | null | undefined)?.target;
    const names = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
    return names.filter((name): name is string => typeof name === 'string');
  }

  async findGroupById(
    tenantId: string,
    id: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialGroup | null> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.commercialGroup.findFirst({ where: { tenantId, id } });
  }

  /**
   * PHASE C8 (GAP-5): one page of the tenant's groups AND its filtered total, read as ONE
   * snapshot — the shape `purchase.repository.listPage`,
   * `purchase-completion-policy.repository.listPage` and
   * `workflow-line-routing.repository.listPage` already use.
   *
   * WHY ONE METHOD AND NOT `listGroups` + `countGroups` ANY MORE: a page cut by one
   * predicate and a total counted by another describe two different sets, and once this
   * list takes a filter that stops being a style question — the `total` a paging client
   * trusts would still count the unfiltered rows, so the last page of a filtered read
   * would never arrive. The array-form transaction is the module's snapshot discipline:
   * the rows and the count describe one moment.
   *
   * `contains` + `mode: 'insensitive'` is the module's ONE text-filter semantics (the pair
   * every other Commerce list search uses), and `search` narrows to `code` OR `name` — the
   * two columns that IDENTIFY a group, exactly as the workflow-definition list matches a
   * definition's `code`/`name`. Ordering is unchanged (`code` asc): a search narrows the
   * set, it never reorders it.
   */
  async listGroupPage(
    tenantId: string,
    filter: CommercialGroupFilter,
    window: { skip: number; take: number }
  ): Promise<[CommercialGroup[], number]> {
    const where = {
      tenantId,
      ...(filter.search
        ? {
            // Everything else on the row is an opaque identity or a timestamp — not text a
            // person types.
            OR: [
              { code: { contains: filter.search, mode: 'insensitive' as const } },
              { name: { contains: filter.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.commercialGroup.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.commercialGroup.count({ where }),
    ]);
  }

  /** Every group id of the tenant — the §7.3 existence check reads ids, not rows. */
  async listGroupIds(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.commercialGroup.findMany({
      where: { tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async updateGroup(
    tenantId: string,
    id: string,
    patch: CommercialGroupPatch
  ): Promise<CommercialGroup | null> {
    const { count } = await this.prisma.commercialGroup.updateMany({
      where: { tenantId, id },
      data: { ...patch },
    });
    if (count === 0) return null;
    return this.prisma.commercialGroup.findFirst({ where: { tenantId, id } });
  }

  // ---------------------------------------------------------------------------
  // CommercialConfigurationVersion
  // ---------------------------------------------------------------------------

  /**
   * The DRAFT's siblings read by LABEL (§7.1's uniqueness pre-check).
   *
   * The schema's `@@unique([tenantId, versionLabel])` is still the real answer to "may
   * two versions share a label"; this read exists so the common case is a 409 naming
   * the field rather than a unique-index error, and `exceptId` lets an edit of a
   * version ignore ITSELF.
   */
  async findConfigurationByLabel(
    tenantId: string,
    versionLabel: string,
    exceptId?: string
  ): Promise<CommercialConfigurationVersion | null> {
    return this.prisma.commercialConfigurationVersion.findFirst({
      where: { tenantId, versionLabel, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    });
  }

  /**
   * CREATE a DRAFT — or `null` when this tenant's `versionLabel` uniqueness was
   * violated.
   *
   * Same reasoning as `createGroup`: the service must not import the generated client
   * to ask which constraint refused, and a pre-check alone loses the race it exists to
   * win. Only the LABEL constraint maps to `null`; every other failure is rethrown
   * unchanged, so no second condition is ever reported as a duplicate label.
   */
  async createConfiguration(
    tenantId: string,
    data: CommercialConfigurationWrite
  ): Promise<CommercialConfigurationVersion | null> {
    try {
      return await this.prisma.commercialConfigurationVersion.create({
        data: {
          tenantId,
          versionLabel: data.versionLabel,
          assignmentTrigger: data.assignmentTrigger,
          noAssignmentBehavior: data.noAssignmentBehavior,
          matchBehavior: data.matchBehavior,
          assignmentRules: data.assignmentRules as never,
          approvalActivation: data.approvalActivation,
          approvalApprover: data.approvalApprover,
          approverUserId: data.approverUserId,
          applicabilityCondition:
            data.applicabilityCondition === null || data.applicabilityCondition === undefined
              ? Prisma.DbNull
              : (data.applicabilityCondition as never),
          projectionPolicy: data.projectionPolicy,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        CommercialConfigurationRepository.isLabelCollision(error.meta)
      ) {
        return null;
      }
      throw error;
    }
  }

  async findConfigurationById(
    tenantId: string,
    id: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialConfigurationVersion | null> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.commercialConfigurationVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * PHASE C8 (GAP-5): one page of the tenant's configuration versions AND its filtered
   * total, read as ONE snapshot — the same shape the group page above uses.
   *
   * `search` matches `versionLabel` and nothing else: it is the column that IDENTIFIES a
   * version (the natural key `findVersionByLabel` already addresses a version by) and the
   * column the completion-policy list and the line-routing list match, so every versioned
   * configuration surface answers a `search` the same way. The rules payload, the
   * applicability condition and the policy enums stay unsearched by construction: matching
   * a status word would return rows whose "match" exists only in the query.
   *
   * Ordering is unchanged (`createdAt` desc) — a search narrows the set, never reorders it.
   */
  async listConfigurationPage(
    tenantId: string,
    filter: CommercialConfigurationFilter,
    window: { skip: number; take: number }
  ): Promise<[CommercialConfigurationVersion[], number]> {
    const where = {
      tenantId,
      ...(filter.search
        ? { versionLabel: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    return this.prisma.$transaction([
      this.prisma.commercialConfigurationVersion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.commercialConfigurationVersion.count({ where }),
    ]);
  }

  /**
   * Edit a DRAFT — conditionally: the `status: 'DRAFT'` predicate makes
   * immutability the statement's own guard, so a published version cannot be
   * edited even if the service's check were bypassed. `null` = not a draft.
   */
  async updateDraftConfiguration(
    tenantId: string,
    id: string,
    patch: Partial<CommercialConfigurationWrite>
  ): Promise<CommercialConfigurationVersion | null> {
    const { count } = await this.prisma.commercialConfigurationVersion.updateMany({
      where: { tenantId, id, status: 'DRAFT' },
      data: {
        ...(patch.versionLabel !== undefined ? { versionLabel: patch.versionLabel } : {}),
        ...(patch.assignmentTrigger !== undefined
          ? { assignmentTrigger: patch.assignmentTrigger }
          : {}),
        ...(patch.noAssignmentBehavior !== undefined
          ? { noAssignmentBehavior: patch.noAssignmentBehavior }
          : {}),
        ...(patch.matchBehavior !== undefined ? { matchBehavior: patch.matchBehavior } : {}),
        ...(patch.assignmentRules !== undefined
          ? { assignmentRules: patch.assignmentRules as never }
          : {}),
        ...(patch.approvalActivation !== undefined
          ? { approvalActivation: patch.approvalActivation }
          : {}),
        ...(patch.approvalApprover !== undefined
          ? { approvalApprover: patch.approvalApprover }
          : {}),
        ...(patch.approverUserId !== undefined ? { approverUserId: patch.approverUserId } : {}),
        ...(patch.applicabilityCondition !== undefined
          ? {
              applicabilityCondition:
                patch.applicabilityCondition === null
                  ? Prisma.DbNull
                  : (patch.applicabilityCondition as never),
            }
          : {}),
        ...(patch.projectionPolicy !== undefined
          ? { projectionPolicy: patch.projectionPolicy }
          : {}),
      },
    });
    if (count === 0) return null;
    return this.prisma.commercialConfigurationVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * The tenant's PUBLISHED policy — §3-B's "currently published version", read at the
   * first commercial activation. The handle is accepted because that read happens
   * inside the activation's unit of work; §3-B's ambiguity is answered by the CALLER
   * (two rows → `COMMERCIAL_CONFIGURATION_AMBIGUOUS`), never by this statement picking
   * one.
   */
  async listPublishedConfigurations(
    tenantId: string,
    tx?: CommerceTransactionHandle
  ): Promise<CommercialConfigurationVersion[]> {
    const client = tx ? unwrapCommerceTransaction(tx) : this.prisma;
    return client.commercialConfigurationVersion.findMany({
      where: { tenantId, status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** DRAFT → VALIDATED, conditionally (§7's validate-then-publish flow). */
  async validateConfigurationIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<CommercialConfigurationVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.commercialConfigurationVersion.updateMany({
      where: { tenantId, id, status: 'DRAFT' },
      data: { status: 'VALIDATED' },
    });
    if (count === 0) return null;
    return client.commercialConfigurationVersion.findFirst({ where: { tenantId, id } });
  }

  /**
   * PUBLISH inside the caller's unit of work (§7.9): archive EVERY currently
   * published version of the tenant, then publish this one — so at most one
   * PUBLISHED row exists afterwards. `count === 0` on the final update means
   * the row was not VALIDATED (the service validated it first) and the whole
   * unit rolls back.
   */
  async publishConfigurationIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<CommercialConfigurationVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    await client.commercialConfigurationVersion.updateMany({
      where: { tenantId, status: 'PUBLISHED', NOT: { id } },
      data: { status: 'ARCHIVED' },
    });
    const { count } = await client.commercialConfigurationVersion.updateMany({
      where: { tenantId, id, status: 'VALIDATED' },
      data: { status: 'PUBLISHED' },
    });
    if (count === 0) return null;
    return client.commercialConfigurationVersion.findFirst({ where: { tenantId, id } });
  }

  /** ARCHIVE a version — conditional on not already archived. */
  async archiveConfigurationIn(
    tenantId: string,
    tx: CommerceTransactionHandle,
    id: string
  ): Promise<CommercialConfigurationVersion | null> {
    const client = unwrapCommerceTransaction(tx);
    const { count } = await client.commercialConfigurationVersion.updateMany({
      where: { tenantId, id, status: { in: ['DRAFT', 'VALIDATED', 'PUBLISHED'] } },
      data: { status: 'ARCHIVED' },
    });
    if (count === 0) return null;
    return client.commercialConfigurationVersion.findFirst({ where: { tenantId, id } });
  }
}
