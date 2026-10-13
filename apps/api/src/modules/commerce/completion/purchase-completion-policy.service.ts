import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import { resolveCommercePageWindow } from '../dto/commerce-query.dto';
import {
  PURCHASE_COMPLETION_AUDIT_ACTION,
  PURCHASE_COMPLETION_FAILURE,
} from './completion.constants';
import {
  PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH,
  completionPolicyIssues,
} from './purchase-completion-policy';
import { PurchaseCompletionPolicyRepository } from './purchase-completion-policy.repository';
import type {
  CreatePurchaseCompletionPolicyDto,
  ListPurchaseCompletionPoliciesQueryDto,
  UpdatePurchaseCompletionPolicyDto,
} from './purchase-completion-policy.dto';

/**
 * PHASE C4-R (GAP-3): the COMPLETION POLICY configuration surface — the versioned row's
 * whole lifecycle: list, read one, open a DRAFT, edit a DRAFT, validate, publish and
 * archive.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT MUST NEVER DO
 * ---------------------------------------------
 * It owns the §16 CHECKLIST (applied to the STORED ROW, not to the request) and the
 * lifecycle transitions around it. It issues NO Prisma statement (statements live in
 * `.repository.ts`), decides NO rule beyond that checklist (the policy's MEANING is
 * `completionPolicyIssues`/`readAllowedFromStatuses`, pure), reads no payment, workflow,
 * receiving or return state (the model references none), and never takes a tenant from a
 * caller: every method scopes with `actor.tenantId`.
 *
 * THE LIFECYCLE IS THE ESTABLISHED ONE, WITH THE COMMERCIAL CONFIGURATION AS THE CLOSEST
 * PRECEDENT (DRAFT → VALIDATED → PUBLISHED → ARCHIVED, single published row per tenant):
 * `validate` walks DRAFT → VALIDATED, `publish` accepts a DRAFT (validating it on the same
 * handle) or an already-VALIDATED row and ARCHIVES the previously published one IN THE SAME
 * UNIT OF WORK, and `archive` is the one way out of PUBLISHED. Immutability is stated here
 * (a published row is refused with its status named) AND executed by the repository's
 * conditional predicate — the two cannot drift, because the statement would refuse a write
 * the service allowed.
 *
 * WHY PUBLICATION RE-RUNS THE CHECKLIST. A row may reach the table by a path that never
 * passed the boundary (a fixture, a future migration, a repair script). The gate is
 * therefore on the ROW: whatever wrote it, it is checked the same way before it may govern
 * a purchase, and a refused publication writes NOTHING — the row keeps the status it had
 * and no audit row is recorded for a transition that did not happen.
 */

/** One stored policy version, as the repository returns it — structural, no generated client. */
export type PurchaseCompletionPolicyRecord = NonNullable<
  Awaited<ReturnType<PurchaseCompletionPolicyRepository['findById']>>
>;

/** The wire view: the row's own columns, and never the `tenantId` that scopes it. */
export interface PurchaseCompletionPolicyView {
  id: string;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED';
  versionLabel: string;
  allowedFromStatuses: readonly string[];
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PurchaseCompletionPolicyService {
  constructor(
    private readonly policies: PurchaseCompletionPolicyRepository,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  /** One page of the tenant's policy versions, newest first. */
  async listPolicies(actor: CommerceActor, query: ListPurchaseCompletionPoliciesQueryDto) {
    const window = resolveCommercePageWindow(query);
    const [rows, total] = await this.policies.listPage(
      actor.tenantId,
      { search: query.search },
      window
    );

    return {
      items: rows.map((row) => PurchaseCompletionPolicyService.view(row)),
      page: window.page,
      pageSize: window.pageSize,
      total,
    };
  }

  /** One policy version by id — tenant-qualified by construction, 404 for any other. */
  async getPolicy(actor: CommerceActor, id: string): Promise<PurchaseCompletionPolicyView> {
    return PurchaseCompletionPolicyService.view(await this.requirePolicy(actor, id));
  }

  /**
   * Open ONE policy version as a DRAFT.
   *
   * THE LABEL IS THE ONE THING THIS METHOD DECIDES: trimmed (whitespace is not a label),
   * bounded against the `VARCHAR(64)` it lands in, and pre-checked for uniqueness inside the
   * tenant — the read that turns the ordinary collision into the module's named 409 instead
   * of a driver error. The SCHEMA's unique index remains the last line of defence for the
   * concurrent case.
   *
   * THE SET IS CHECKED BEFORE THE INSERT TOO, so a create that could never be published is
   * refused at the boundary with the same reasons the checklist would give — the DTO has
   * already refused anything outside the vocabulary; this catches the shapes a DTO cannot
   * express as an enum (an empty array that slipped through some other path, a duplicate
   * member).
   */
  async createPolicy(actor: CommerceActor, dto: CreatePurchaseCompletionPolicyDto) {
    const versionLabel = this.assertLabel(dto.versionLabel);
    this.assertPolicyShape(dto.allowedFromStatuses);

    const existing = await this.policies.findByLabel(actor.tenantId, versionLabel);
    if (existing) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_LABEL_TAKEN,
        message: `A completion policy labelled "${versionLabel}" already exists in this tenant.`,
      });
    }

    const row = await this.policies.create(actor.tenantId, {
      status: 'DRAFT',
      versionLabel,
      allowedFromStatuses: [...dto.allowedFromStatuses],
    });

    await this.audit.record(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_CREATED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: row.id,
      newValue: {
        versionLabel: row.versionLabel,
        status: row.status,
        allowedFromStatuses: row.allowedFromStatuses,
      },
    });

    return PurchaseCompletionPolicyService.view(row);
  }

  /**
   * Change a DRAFT's status set. Only a DRAFT may be edited: a validated or published
   * configuration is the one purchases were completed under, and a change to it is a NEW
   * version — the same rule the commercial configuration and the workflow version state.
   */
  async updatePolicy(actor: CommerceActor, id: string, dto: UpdatePurchaseCompletionPolicyDto) {
    const row = await this.requirePolicy(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: `Only a DRAFT completion policy may be edited; this one is ${row.status}.`,
      });
    }
    this.assertPolicyShape(dto.allowedFromStatuses);

    const updated = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.policies.updateDraftIn(actor.tenantId, tx, id, [...dto.allowedFromStatuses])
    );
    if (!updated) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'The completion policy is no longer a draft; it may not be edited.',
      });
    }

    await this.audit.record(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_UPDATED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: updated.id,
      changedFields: ['allowedFromStatuses'],
      oldValue: { allowedFromStatuses: row.allowedFromStatuses },
      newValue: { allowedFromStatuses: updated.allowedFromStatuses },
    });

    return PurchaseCompletionPolicyService.view(updated);
  }

  /**
   * Run the checklist against the STORED ROW and walk DRAFT → VALIDATED.
   *
   * A refusal writes nothing: the row stays a DRAFT, no audit row is recorded, and the
   * client receives the deterministic list of reasons. Publication re-runs the same check,
   * so a VALIDATED row is never trusted blindly.
   */
  async validatePolicy(actor: CommerceActor, id: string): Promise<PurchaseCompletionPolicyView> {
    const row = await this.requirePolicy(actor, id);
    if (row.status !== 'DRAFT') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: `Only a DRAFT completion policy may be validated; this one is ${row.status}.`,
      });
    }
    this.assertStoredPolicy(row);

    const validated = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.policies.validateIn(actor.tenantId, tx, id)
    );
    if (!validated) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'The completion policy is no longer a draft; it may not be validated.',
      });
    }

    await this.audit.record(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_VALIDATED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: validated.id,
      oldValue: { status: row.status },
      newValue: { status: validated.status },
    });

    return PurchaseCompletionPolicyService.view(validated);
  }

  /**
   * Put ONE policy in force (validate if needed, publish, archive the previous one — all
   * one unit of work), so the tenant ends with EXACTLY ONE published policy: the row the
   * completion act will read.
   *
   * A PUBLISHED row may not be re-published (immutability) and an ARCHIVED row may not be
   * revived — the one way back is a new version, which is what makes "which policy governed
   * this completion" answerable from the document's pin.
   */
  async publishPolicy(actor: CommerceActor, id: string): Promise<PurchaseCompletionPolicyView> {
    const row = await this.requirePolicy(actor, id);
    if (row.status === 'PUBLISHED') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'A published completion policy is immutable; publish a new version instead.',
      });
    }
    if (row.status === 'ARCHIVED') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'An archived completion policy cannot be published; create a new version.',
      });
    }
    this.assertStoredPolicy(row);

    const published = await this.unitOfWork.run(async (tx: CommerceTransactionHandle) => {
      // DRAFT → VALIDATED inside the same act as VALIDATED → PUBLISHED: the route is
      // "validate + publish", and a row validated by an earlier request already satisfies
      // the first transition.
      if (row.status === 'DRAFT') {
        const validated = await this.policies.validateIn(actor.tenantId, tx, id);
        if (!validated) return null;
      }
      return this.policies.publishIn(actor.tenantId, tx, id);
    });
    if (!published) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'The completion policy left a publishable status while this request was applied.',
      });
    }

    await this.audit.record(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_PUBLISHED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: published.id,
      oldValue: { status: row.status },
      newValue: { status: published.status, allowedFromStatuses: published.allowedFromStatuses },
    });

    return PurchaseCompletionPolicyService.view(published);
  }

  /**
   * ARCHIVE a policy version — including the published one, which RETIRES completion for
   * the tenant: with no PUBLISHED row, the completion act fails closed
   * (`PURCHASE_COMPLETION_POLICY_NOT_CONFIGURED`) until a new policy is published. That is
   * not a silent deletion: the row keeps its status and any purchase completed under it
   * keeps its pin.
   */
  async archivePolicy(actor: CommerceActor, id: string): Promise<PurchaseCompletionPolicyView> {
    const row = await this.requirePolicy(actor, id);
    if (row.status === 'ARCHIVED') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'This completion policy is already archived.',
      });
    }

    const archived = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.policies.archiveIn(actor.tenantId, tx, id)
    );
    if (!archived) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: 'The completion policy was archived while this request was being applied.',
      });
    }

    await this.audit.record(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.POLICY_ARCHIVED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_COMPLETION_POLICY_VERSION,
      resourceId: archived.id,
      oldValue: { status: row.status },
      newValue: { status: archived.status },
    });

    return PurchaseCompletionPolicyService.view(archived);
  }

  // ---------------------------------------------------------------------------
  // The checks, spelled once
  // ---------------------------------------------------------------------------

  /** The label, trimmed and bounded, or a 400 stating which bound was broken. */
  private assertLabel(raw: string): string {
    const versionLabel = raw.trim();
    if (versionLabel.length === 0) {
      throw new BadRequestException('The completion policy versionLabel must not be empty.');
    }
    if (versionLabel.length > PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH) {
      throw new BadRequestException(
        `The completion policy versionLabel must be at most ${PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH} characters.`
      );
    }
    return versionLabel;
  }

  /** The request's set, checked by the SAME pure rule the publication checklist applies. */
  private assertPolicyShape(allowedFromStatuses: readonly string[]): void {
    const issues = completionPolicyIssues([...allowedFromStatuses]);
    if (issues.length > 0) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: issues.join(' '),
      });
    }
  }

  /**
   * The STORED row's checklist — what publication requires.
   * `PURCHASE_COMPLETION_POLICY_INVALID` with the COMPLETE reason list, never a partial
   * guess: the same deterministic report `completionPolicyIssues` produces for any value,
   * so a row written before this module existed is refused with the same words as a bad
   * request.
   */
  private assertStoredPolicy(row: PurchaseCompletionPolicyRecord): void {
    const issues = completionPolicyIssues(row.allowedFromStatuses);
    if (issues.length > 0) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_INVALID,
        message: issues.join(' '),
      });
    }
  }

  /** One policy version or a 404 — never a 403, so existence is not confirmed across tenants. */
  private async requirePolicy(
    actor: CommerceActor,
    id: string
  ): Promise<PurchaseCompletionPolicyRecord> {
    const row = await this.policies.findById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Purchase completion policy not found');
    return row;
  }

  /**
   * The row's own columns, without the tenant that scopes it — a response body is not a
   * place to learn which tenant a caller was resolved to, and `tenantId` would be exactly
   * that. The `status` is the server's value: a client never sent one and never will.
   */
  private static view(row: PurchaseCompletionPolicyRecord): PurchaseCompletionPolicyView {
    return {
      id: row.id,
      status: row.status,
      versionLabel: row.versionLabel,
      allowedFromStatuses: Array.isArray(row.allowedFromStatuses)
        ? (row.allowedFromStatuses as readonly string[])
        : [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
