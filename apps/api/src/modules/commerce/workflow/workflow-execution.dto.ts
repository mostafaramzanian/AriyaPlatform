import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CommercePageQueryDto } from '../dto/commerce-query.dto';
import {
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_STEP_DECISIONS,
  type WorkflowInstanceStatus,
} from './workflow-run-status';

/**
 * PHASE C2 (GAP-1): the request contracts of the workflow-execution routes the N contract
 * (§11) specifies — the HTTP shape for capabilities the domain already had.
 *
 * WHY THIS FILE LOOKS LIKE EVERY OTHER DTO HERE. The pagination envelope is
 * `CommercePageQueryDto` (the module's one page/pageSize/search base, with the ceiling
 * enforced once), the vocabularies are the RUNTIME's own closed sets imported from
 * `workflow-run-status` (never a literal restated where it could drift), and there is no
 * `tenantId` field anywhere — the global pipe's `whitelist` + `forbidNonWhitelisted` makes
 * sending one a 400, and the actor comes from `resolveCommerceActor(req)`.
 */

/**
 * The ceiling on a decision comment, mirrored from the COLUMN rather than invented:
 * `WorkflowStepInstance.decisionComment` is `VarChar(500)`, so 500 is the point where the
 * DTO stops accepting what the schema could store. (The commercial decision's own DTO
 * mirrors its `Text` column with 1000 — each bound follows its own column.)
 */
export const MAX_WORKFLOW_DECISION_COMMENT_LENGTH = 500;

/**
 * §11's LIST query: the shared page window plus the two filters the repository's
 * `listInstancePage` already supports. There is deliberately NO `approverId` filter: "my
 * runs" is answered by the session-scoped `GET /commerce/pending-decisions`, never by a
 * client-supplied identity used as a filter — an identity a caller can type is not an
 * authorization source.
 */
export class ListWorkflowInstancesQueryDto extends CommercePageQueryDto {
  @IsOptional()
  @IsIn(WORKFLOW_INSTANCE_STATUSES)
  status?: WorkflowInstanceStatus;

  /**
   * The run's subject. The repository pairs this with
   * `subjectType = PURCHASE_DOCUMENT`, so it is a document id — an opaque reference, the
   * same UUID constraint the other opaque-id filters use.
   */
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}

/**
 * §11's DECIDE body: `decision` is the runtime's own `WORKFLOW_STEP_DECISIONS` (APPROVED |
 * REJECTED) and `comment` is the optional reason the column holds. The ACTOR is never a
 * field: who may decide is `resolvedApproverId` on the step, verified server-side against
 * the authenticated principal.
 */
export class WorkflowStepDecisionDto {
  @IsIn(WORKFLOW_STEP_DECISIONS)
  decision!: (typeof WORKFLOW_STEP_DECISIONS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_WORKFLOW_DECISION_COMMENT_LENGTH)
  comment?: string;
}
