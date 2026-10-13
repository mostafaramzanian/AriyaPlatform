import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Phase 49F: conversation creation.
 *
 * There is no `createdBy`, `senderId` or `tenantId` field: the creator is the
 * authenticated subject and the tenant is a snapshot of that subject's tenant.
 * The client can only say who else is in the conversation.
 *
 * DIRECT takes exactly one participant (the other person) and never a name;
 * GROUP takes 1..49 participants plus a required name. Those shapes are asserted
 * in the service, which owns the rule, so the DTO stays a plain bounded-input
 * contract.
 */
export const MAX_GROUP_PARTICIPANTS = 49;

export class CreateConversationDto {
  @IsIn(['DIRECT', 'GROUP'])
  type!: 'DIRECT' | 'GROUP';

  /**
   * Other members. The caller is always added server-side and must not be listed
   * here — a self-referencing participant is rejected rather than deduplicated,
   * so a malformed client cannot create a conversation with itself.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_GROUP_PARTICIPANTS)
  @IsUUID('4', { each: true })
  participantIds!: string[];

  /** Group title. Rejected for DIRECT by the service. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

/**
 * Phase 49F: message send payload, shared by the HTTP fallback route and the
 * `message.send` WebSocket event so both paths validate identically.
 *
 * `conversationId` is a path parameter over HTTP and part of the payload over WS;
 * it is declared optional here and always resolved by the caller, never trusted
 * to select a conversation the sender does not belong to.
 */
export const MAX_MESSAGE_BODY = 4000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export class SendMessageDto {
  /**
   * Plain text. Trimmed, must be non-empty, bounded. Markup is not escaped here
   * because the client renders text nodes only — but the length bound is also a
   * database CHECK, so nothing oversized can be persisted by any path.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_BODY)
  body!: string;

  /**
   * Client-generated idempotency key. A retried send with the same key returns
   * the existing message instead of inserting a duplicate.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  clientMessageId?: string;

  /**
   * Ids returned by the attachment upload endpoint. Ownership is re-checked
   * server-side: an attachment uploaded by someone else, or already bound to a
   * message, is refused.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS_PER_MESSAGE)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

/**
 * Phase 49F: WebSocket payload wrapper. Over HTTP the conversation comes from the
 * path; over WS it must be in the payload, so the socket-facing shape adds it.
 */
export class WsSendMessageDto extends SendMessageDto {
  @IsUUID('4')
  conversationId!: string;
}

/** Payload for every conversation-targeted WS event that carries no other data. */
export class WsConversationRefDto {
  @IsUUID('4')
  conversationId!: string;
}
