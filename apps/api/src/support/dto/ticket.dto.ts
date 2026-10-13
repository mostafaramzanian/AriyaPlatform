import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Phase 49G: ticket write contracts.
 *
 * No DTO here carries a `requesterId`, `tenantId`, `trackingNumber` or `status`
 * field. The requester is the authenticated subject, the tenant is a snapshot of
 * that subject's tenant, the tracking number is minted server-side, and status is
 * only ever moved through the dedicated status route — so a client cannot create a
 * ticket that is already resolved, nor file one on someone else's behalf.
 */

export const MAX_TICKET_SUBJECT = 160;
export const MAX_TICKET_BODY = 4000;
export const MAX_TICKET_CATEGORY = 80;
export const MAX_TICKET_COMMENT_BODY = 4000;
export const MAX_TICKET_STATUS_NOTE = 500;
export const MAX_TICKET_SATISFACTION_COMMENT = 1000;
export const MAX_ATTACHMENTS_PER_COMMENT = 5;

export class CreateTicketDto {
  @IsIn(['BUG', 'SUPPORT', 'SUGGESTION', 'CRITICISM', 'COMPLAINT', 'FEATURE_REQUEST'])
  type!: 'BUG' | 'SUPPORT' | 'SUGGESTION' | 'CRITICISM' | 'COMPLAINT' | 'FEATURE_REQUEST';

  /**
   * Requester-declared urgency. Accepted as a hint only — an agent can always
   * override it, and URGENT confers no special routing, because no escalation
   * mechanism exists.
   */
  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_SUBJECT)
  subject!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_BODY)
  body!: string;
}


/**
 * Administrative patch. Every field here requires `admin.support.manage`; a
 * requester has no PATCH capability at all, which is why there is no
 * requester-editable field in this DTO.
 *
 * `status` is deliberately NOT here: a lifecycle transition is a distinct
 * operation with its own validation, history row and notification, so it has its
 * own route rather than hiding inside a general-purpose patch.
 */
export class UpdateTicketDto {
  @IsOptional()
  @IsUUID('4')
  assigneeId?: string;

  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_CATEGORY)
  category?: string;
}

/** Lifecycle transition. Validity is decided by the service's state machine. */
export class ChangeTicketStatusDto {
  @IsIn(['TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_REQUESTER', 'RESOLVED', 'CLOSED'])
  status!:
    | 'TRIAGED'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'WAITING_FOR_REQUESTER'
    | 'RESOLVED'
    | 'CLOSED';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_STATUS_NOTE)
  note?: string;
}

export class CreateTicketCommentDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_COMMENT_BODY)
  body!: string;

  /**
   * Agent-only. A requester who sends `true` is refused rather than silently
   * downgraded, so an internal note can never be authored by the wrong party.
   */
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS_PER_COMMENT)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

/** Requester satisfaction. One per ticket, enforced by a UNIQUE constraint. */
export class CreateTicketSatisfactionDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TICKET_SATISFACTION_COMMENT)
  comment?: string;
}
