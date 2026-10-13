import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import {
  PURCHASE_COMPLETION_SOURCE_STATUSES,
  type PurchaseCompletionSourceStatus,
} from '../purchase/purchase-status';
import { PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH } from './purchase-completion-policy';

/**
 * PHASE C4-R (GAP-3): the wire contract of the completion-policy configuration routes —
 * `commerce/completion-policies`, its detail read, its draft edit and its
 * validate/publish/archive walk.
 *
 * WHAT IS ON THE WIRE, AND WHY EACH FIELD IS GROUNDED
 * --------------------------------------------------
 * A policy version is the row `PurchaseCompletionPolicyVersion`, and every writable member
 * below is one the configuration actually holds:
 *
 *   * `versionLabel` — the tenant's own label (the `VARCHAR(64)` the row stores), unique
 *     inside the tenant, exactly like a routing version's or a commercial version's label;
 *   * `allowedFromStatuses` — THE POLICY: the statuses a purchase document may be
 *     completed FROM, each one a member of the purchase document's OWN lifecycle
 *     vocabulary minus the destination (`PURCHASE_COMPLETION_SOURCE_STATUSES`). The
 *     boundary refuses anything else at the edge: `CLOSED`, a foreign lifecycle's state
 *     such as `PAID` or `FULLY_RECEIVED`, or an invented string is a 422/400 here rather
 *     than a row the publish checklist would later refuse.
 *
 * WHY THE STRUCTURAL CHECKS ARE NOT HERE. "Is this configuration a policy at all?" — an
 * empty set, a duplicate member, a value stored by some other path — is answered by the
 * publication checklist against the STORED ROW (`completionPolicyIssues`), because a row
 * may reach the table by a path that never passed through this DTO. What this file owns is
 * the request SHAPE; what the checklist owns is the row's MEANING. The two are deliberately
 * not the same function twice: membership is shape (an enum, `@IsIn`), totality is meaning.
 *
 * WHAT IS DELIBERATELY NOT ON THE WIRE
 * ------------------------------------
 *  * NO `tenantId`, no `id`, no `status`, no timestamps: the tenant is `resolveCommerceActor`,
 *    and the lifecycle is walked by the routes that own each transition (`/validate`,
 *    `/publish`, `/archive`), never by a client writing a status — a client-settable status
 *    is how "a published configuration is immutable" gets a bypass. The global pipe's
 *    `whitelist` + `forbidNonWhitelisted` makes sending one a 400 rather than an ignored
 *    field.
 *  * NO prerequisite fields, no condition tree, no expression, no formula: the model has
 *    none (see `purchase-completion-policy.ts`), so there is nothing here to carry one.
 *  * NO permission, role or approver configuration: who may act is Core/RBAC's, and this
 *    module must not grow a permission editor.
 */

/** Open ONE policy version as a DRAFT. Publication is a separate, validated transition. */
export class CreatePurchaseCompletionPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PURCHASE_COMPLETION_MAX_VERSION_LABEL_LENGTH)
  versionLabel!: string;

  /**
   * The statuses completion is permitted FROM. At least one — a policy that names none
   * could complete nothing, and the honest spelling of that state is a tenant with no
   * published policy (which fails closed). At most the whole candidate vocabulary: a set
   * cannot be larger than its members.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PURCHASE_COMPLETION_SOURCE_STATUSES.length)
  @IsIn(PURCHASE_COMPLETION_SOURCE_STATUSES, { each: true })
  allowedFromStatuses!: PurchaseCompletionSourceStatus[];
}

/**
 * Change a DRAFT's status set. The label is NOT editable here: it is the row's identity for
 * the tenant (the same choice `updateDraftConfiguration` makes for the fields it accepts),
 * and a rename is a new version rather than a rewrite of an audit trail's subject.
 */
export class UpdatePurchaseCompletionPolicyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PURCHASE_COMPLETION_SOURCE_STATUSES.length)
  @IsIn(PURCHASE_COMPLETION_SOURCE_STATUSES, { each: true })
  allowedFromStatuses!: PurchaseCompletionSourceStatus[];
}

/**
 * The list query: the shared page window and its `search`, and nothing else.
 *
 * `search` keeps the meaning `CommercePageQueryDto` states — a free-text match against the
 * record's own identifying column, which for a policy version is its `versionLabel`. There
 * is deliberately NO `status` filter: the workflow version list has none either, and a
 * filter invented here would be a query shape no contract defines.
 */
export class ListPurchaseCompletionPoliciesQueryDto extends CommercePageQueryDto {}
