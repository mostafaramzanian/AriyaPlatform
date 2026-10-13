import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommerceActor } from '../commerce-actor';
import { CommerceAuditGateway } from '../commerce-audit.gateway';
import { COMMERCE_AUDIT_RESOURCE } from '../commerce.constants';
import {
  CommerceUnitOfWork,
  type CommerceTransactionHandle,
} from '../database/commerce-transaction';
import {
  canCompletePurchaseDocument,
  type PurchaseDocumentStatus,
} from '../purchase/purchase-status';
import { PurchaseRepository } from '../purchase/purchase.repository';
import { PurchaseService } from '../purchase/purchase.service';
import {
  PURCHASE_COMPLETION_AUDIT_ACTION,
  PURCHASE_COMPLETION_FAILURE,
} from './completion.constants';
import {
  describeAllowedFromStatuses,
  readAllowedFromStatuses,
} from './purchase-completion-policy';
import { PurchaseCompletionPolicyRepository } from './purchase-completion-policy.repository';

/**
 * PHASE C4-R (GAP-3): THE COMPLETION ACT — the ONE service that may move a
 * `PurchaseDocument` to `CLOSED` (C1 §29).
 *
 * THE ARCHITECTURE THIS FILE IMPLEMENTS (brief §14), LITERALLY:
 *
 *   HTTP controller
 *     ↓ resolveCommerceActor (the controller's only act)
 *   PurchaseCompletionService            ← this file
 *     ↓ PurchaseCompletionPolicyRepository.findPublished  (the policy resolver)
 *     ↓ domain reads (PurchaseRepository, tenant-scoped)
 *     ↓ ONE conditional transition (PurchaseRepository.writeCompletedIn)
 *     ↓ the module's established wire projection (PurchaseService.getOne)
 *
 * THE CONTROLLER DECIDES NOTHING: it does not read a policy, does not inspect a status and
 * does not assemble a rule. Everything between "a request arrived" and "a row moved" is
 * here, and everything below here is a repository statement.
 *
 * THE ORDER OF THE FOUR REFUSALS IS THE CONTRACT:
 *   1. the document must exist IN THIS TENANT — else 404 (never 403: existence is not
 *      confirmed across tenants);
 *   2. the document must not already be `CLOSED` — else 409 `DOCUMENT_ALREADY_COMPLETED`
 *      (the stable "already completed" fact, checked before the policy so a repeat click is
 *      answered the same way in every tenant, configured or not);
 *   3. the tenant must have a PUBLISHED policy — else 409 `POLICY_NOT_CONFIGURED`. THIS IS
 *      THE FAIL-CLOSED RULE (brief §18): no policy means completion is unavailable, and the
 *      service NEVER falls back to a draft, to "latest", to a default, or to "no
 *      prerequisites". A stored policy that cannot be evaluated is refused the same way;
 *   4. the policy must NAME the document's current status — else 409 `STATUS_NOT_ALLOWED`,
 *      the configured business rule doing the work decisions D1 used to leave open.
 *
 * THEN THE WRITE, ONCE, CONDITIONALLY: `writeCompletedIn` carries the policy's whole source
 * set in its `where` AND `completedAt: null`, so a second completion — raced by another
 * actor, or by a commercial projection moving the document — matches nothing and answers
 * the established 409 `WRITE_CONFLICT`. One winner, one refusal, no double-recorded actor,
 * and no silent success.
 *
 * WHAT THIS FILE MUST NEVER DO: read payment, receiving, workflow or return state (no
 * policy dimension references them — the model has none), touch a `PaymentRecord`, a
 * `Receipt`, a `ReturnDocument` or a `WorkflowInstance` (C1 §29 keeps those lifecycles
 * independent, and completion changes only the document's own status), decide WHO may act
 * (Core/RBAC's `commerce.manage` guard on the route), or accept a tenant, an actor id or a
 * completion timestamp from a request.
 */
@Injectable()
export class PurchaseCompletionService {
  constructor(
    private readonly documents: PurchaseRepository,
    private readonly policies: PurchaseCompletionPolicyRepository,
    private readonly purchases: PurchaseService,
    private readonly audit: CommerceAuditGateway,
    private readonly unitOfWork: CommerceUnitOfWork
  ) {}

  /**
   * Complete ONE purchase document (`POST /commerce/purchase-documents/:id/close`).
   *
   * The answer is the document as the GET route projects it — the SAME projection, read
   * back through the same service after the write, so a client cannot receive a shape this
   * module's next read would not reproduce.
   */
  async close(actor: CommerceActor, id: string) {
    const document = await this.documents.findDocumentById(actor.tenantId, id);
    if (!document) throw new NotFoundException('Purchase document not found');

    if (document.status === 'CLOSED') {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.DOCUMENT_ALREADY_COMPLETED,
        message: 'This purchase document is already completed.',
      });
    }

    const policy = await this.policies.findPublished(actor.tenantId);
    if (!policy) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED,
        message:
          'No purchase completion policy is published for this tenant, so purchases cannot be completed.',
      });
    }

    const allowedFromStatuses = readAllowedFromStatuses(policy.allowedFromStatuses);
    if (!allowedFromStatuses) {
      // A PUBLISHED row that cannot be evaluated — a shape that should be impossible
      // (publication runs the same checklist) and is nevertheless answered as NOT
      // CONFIGURED rather than guessed at: fail closed means fail closed here too.
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.POLICY_NOT_CONFIGURED,
        message:
          'The published purchase completion policy is not evaluable, so purchases cannot be completed.',
      });
    }

    if (!canCompletePurchaseDocument(document.status, allowedFromStatuses)) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.STATUS_NOT_ALLOWED,
        message: `A purchase document in status ${document.status} may not be completed under the published policy (allowed: ${describeAllowedFromStatuses(allowedFromStatuses)}).`,
      });
    }

    const completedAt = new Date();

    // Phase B2.3: build the durable outbox payload BEFORE the unit of work.
    const outbox = this.audit.buildOutboxPayload(actor, {
      action: PURCHASE_COMPLETION_AUDIT_ACTION.DOCUMENT_CLOSED,
      resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT,
      resourceId: id,
      oldValue: { status: document.status },
      newValue: {
        status: 'CLOSED',
        completedAt: completedAt.toISOString(),
        completedByUserId: actor.userId,
        completionPolicyVersionId: policy.id,
      },
    });

    const completed = await this.unitOfWork.run((tx: CommerceTransactionHandle) =>
      this.documents.writeCompletedIn(
        actor.tenantId,
        tx,
        id,
        {
          fromStatuses: allowedFromStatuses as readonly PurchaseDocumentStatus[],
          completedByUserId: actor.userId,
          completedAt,
          completionPolicyVersionId: policy.id,
        },
        outbox
      )
    );

    if (!completed) {
      throw new ConflictException({
        code: PURCHASE_COMPLETION_FAILURE.WRITE_CONFLICT,
        message:
          'The purchase document left the statuses this policy permits while this request was being applied.',
      });
    }

    return this.purchases.getOne(actor, completed.id);
  }
}
