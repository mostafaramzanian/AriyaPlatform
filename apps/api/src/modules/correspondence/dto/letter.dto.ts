import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Phase 50: correspondence DTOs.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so any
 * parameter outside these shapes — notably `senderId`, `tenantId`, `status` on
 * create/update, or a `workflow` override — is REJECTED, not silently honoured.
 * The actor and the tenant are always server-derived; the letter number is always
 * server-minted. There is deliberately no DTO field anywhere in this module that a
 * client could use to act as someone else.
 *
 * Rich text arrives as `body` and is NEVER trusted: the service passes it through
 * `sanitizeLetterBody` (allowlist sanitizer) before it can reach storage.
 */

export const LETTER_URGENCIES = ['NORMAL', 'IMPORTANT', 'URGENT', 'CRITICAL'] as const;
export const LETTER_CLASSIFICATIONS = ['NORMAL', 'CONFIDENTIAL', 'SECRET'] as const;
export const REFERRAL_LEVELS = ['NORMAL', 'INFORM', 'REVIEW', 'DECIDE', 'EXECUTE', 'FINAL_APPROVE'] as const;
export const REFERRAL_STATUSES = ['PENDING', 'VIEWED', 'ACTED'] as const;
export const RECIPIENT_KINDS = ['TO', 'CC', 'BCC'] as const;

export const MAX_SUBJECT_LENGTH = 255;
export const MAX_BODY_LENGTH = 200000;
export const MAX_CATEGORY_LENGTH = 100;
export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_RECIPIENTS = 100;

/** Jalali date key, Latin digits, exactly the shape `formatDateKey`/`CoreJalaliDatePicker` emits. */
export const JALALI_DATE_KEY_PATTERN = /^\d{4}\/\d{2}\/\d{2}$/;

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLetterDraftDto {
  @IsString()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(MAX_SUBJECT_LENGTH)
  subject!: string;

  /** Untrusted rich text — sanitized before storage. */
  @IsString()
  @MaxLength(MAX_BODY_LENGTH)
  body!: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(MAX_CATEGORY_LENGTH)
  category?: string | null;

  @IsOptional()
  @IsIn(LETTER_URGENCIES)
  urgency?: (typeof LETTER_URGENCIES)[number];

  /** Requires `correspondence.confidential.manage` when not NORMAL. */
  @IsOptional()
  @IsIn(LETTER_CLASSIFICATIONS)
  classification?: (typeof LETTER_CLASSIFICATIONS)[number];

  /** Optional تاریخ نامه as a Jalali date key; defaults to the send instant. */
  @IsOptional()
  @Matches(JALALI_DATE_KEY_PATTERN, { message: 'letterDate must be a YYYY/MM/DD Jalali date key' })
  letterDate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  recipientIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  ccIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  bccIds?: string[];

  /** Optional client-provided letter number (preview/UX). Format validated; uniqueness checked at send. */
  @IsOptional()
  @IsString()
  @Matches(/^AR-\d{4}-\d{5}$/, { message: 'letterNumber must match AR-YYYY-NNNNN' })
  letterNumber?: string | null;

  /** Signature uploaded/drawn before the draft exists. Linked on create. */
  @IsOptional()
  @IsUUID('4')
  signatureId?: string | null;

  /** Temp attachment ids created before the draft. Linked on create. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tempAttachmentIds?: string[];

  /** Optional scheduled send date (Jalali `YYYY/MM/DD`, Latin digits). */
  @IsOptional()
  @Matches(JALALI_DATE_KEY_PATTERN, { message: 'scheduledAtDate must be a YYYY/MM/DD Jalali date key' })
  scheduledAtDate?: string | null;

  /** Optional scheduled send time (`HH:mm`, Latin digits). Required when scheduledAtDate is set. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'scheduledAtTime must be HH:mm' })
  scheduledAtTime?: string | null;

  /** Idempotency/replay guard for the SEND call, mirrored from the referral contract. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sendKey?: string | null;
}

export class UpdateLetterDraftDto {
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(MAX_SUBJECT_LENGTH)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BODY_LENGTH)
  body?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(MAX_CATEGORY_LENGTH)
  category?: string | null;

  @IsOptional()
  @IsIn(LETTER_URGENCIES)
  urgency?: (typeof LETTER_URGENCIES)[number];

  @IsOptional()
  @IsIn(LETTER_CLASSIFICATIONS)
  classification?: (typeof LETTER_CLASSIFICATIONS)[number];

  @IsOptional()
  @Matches(JALALI_DATE_KEY_PATTERN, { message: 'letterDate must be a YYYY/MM/DD Jalali date key' })
  letterDate?: string | null;

  /** When present, REPLACES the whole recipient set (whole-set semantics like the survey questionnaire). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  recipientIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  ccIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsUUID('4', { each: true })
  bccIds?: string[];

  /** Optional client-provided letter number (preview/UX). Format validated; uniqueness checked at send. */
  @IsOptional()
  @IsString()
  @Matches(/^AR-\d{4}-\d{5}$/, { message: 'letterNumber must match AR-YYYY-NNNNN' })
  letterNumber?: string | null;

  /** Signature uploaded/drawn before the draft exists. Linked on update. */
  @IsOptional()
  @IsUUID('4')
  signatureId?: string | null;

  /** Temp attachment ids created before the draft. Linked on update. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tempAttachmentIds?: string[];

    /** Optional scheduled send date (Jalali `YYYY/MM/DD`, Latin digits). */
  @IsOptional()
  @Matches(JALALI_DATE_KEY_PATTERN, { message: 'scheduledAtDate must be a YYYY/MM/DD Jalali date key' })
  scheduledAtDate?: string | null;

  /** Optional scheduled send time (`HH:mm`, Latin digits). Required when scheduledAtDate is set. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'scheduledAtTime must be HH:mm' })
  scheduledAtTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sendKey?: string | null;
}

export class CorrespondenceQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Transform(trimString)
  @IsIn(['DRAFT', 'READY_TO_SEND', 'SCHEDULED', 'SENT'])
  status?: 'DRAFT' | 'READY_TO_SEND' | 'SCHEDULED' | 'SENT';
}

export class SendLetterDto {
  /** Optional scheduled send date (Jalali `YYYY/MM/DD`, Latin digits). */
  @IsOptional()
  @Matches(JALALI_DATE_KEY_PATTERN, { message: 'scheduledAtDate must be a YYYY/MM/DD Jalali date key' })
  scheduledAtDate?: string | null;

  /** Optional scheduled send time (`HH:mm`, Latin digits). Required when scheduledAtDate is set. */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'scheduledAtTime must be HH:mm' })
  scheduledAtTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sendKey?: string | null;
}

export class ChangeLetterStatusDto {
  @IsIn(['READY_TO_SEND', 'DRAFT', 'CANCELLED'])
  status!: 'READY_TO_SEND' | 'DRAFT' | 'CANCELLED';
}

export class ChangeClassificationDto {
  @IsIn(LETTER_CLASSIFICATIONS)
  classification!: (typeof LETTER_CLASSIFICATIONS)[number];
}

export class MarkLetterDto {
  @IsIn(['VIEWED', 'READ'])
  mark!: 'VIEWED' | 'READ';
}

export class CreateReferralDto {
  @IsUUID('4')
  toUserId!: string;

  @IsIn(REFERRAL_LEVELS)
  level!: (typeof REFERRAL_LEVELS)[number];

  @IsOptional()
  @IsIn(LETTER_URGENCIES)
  urgency?: (typeof LETTER_URGENCIES)[number];

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(MAX_INSTRUCTION_LENGTH)
  instruction?: string | null;

  /** Client attempt to influence confidentiality — accepted shape, overridden by the letter's classification. */
  @IsOptional()
  @IsBoolean()
  isConfidential?: boolean;

  @IsOptional()
  @IsBoolean()
  removeFromInbox?: boolean;

  /** Idempotency/replay guard; UNIQUE in the database. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientKey?: string | null;
}

export class ReferralStatusDto {
  @IsIn(REFERRAL_STATUSES)
  status!: (typeof REFERRAL_STATUSES)[number];
}

export class InboxRemoveDto {
  @IsBoolean()
  remove!: boolean;
}

export class ArchiveLetterDto {
  @IsOptional()
  @IsUUID('4')
  folderId?: string | null;
}

export class ArchiveFolderQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /**
   * The archive list filter. It rides on the SAME query object this DTO validates,
   * so it must be a declared property � under `forbidNonWhitelisted` an undeclared
   * query field is rejected as unknown (which 422'd every folder-filtered list).
   */
  @IsOptional()
  @IsUUID('4')
  folderId?: string | null;
}

export class CreateArchiveFolderDto {
  @IsString()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class UpdateArchiveFolderDto {
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class UploadAttachmentQueryDto {
  @IsUUID('4')
  letterId!: string;
}

export class CorrSearchQueryDto {
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(200)
  /** جستجوی همه فیلدها: letter number, subject, category. */
  q?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(255)
  letterNumber?: string;

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsUUID('4')
  senderId?: string;

  @IsOptional()
  @IsUUID('4')
  recipientId?: string;

  @IsOptional()
  @Transform(trimString)
  @IsIn(['DRAFT', 'READY_TO_SEND', 'SCHEDULED', 'SENT'])
  status?: 'DRAFT' | 'READY_TO_SEND' | 'SCHEDULED' | 'SENT';

  @IsOptional()
  @Transform(trimString)
  @IsIn(LETTER_URGENCIES)
  urgency?: (typeof LETTER_URGENCIES)[number];

  @IsOptional()
  @Transform(trimString)
  @IsIn(LETTER_CLASSIFICATIONS)
  classification?: (typeof LETTER_CLASSIFICATIONS)[number];

  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(100)
  category?: string;

  /** Inclusive lower bound (ISO instant). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dateFrom?: string;

  /** Inclusive upper bound (ISO instant). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  dateTo?: string;

  @IsOptional()
  @Transform(trimString)
  @IsIn(['any', 'yes', 'no'])
  hasAttachments?: 'any' | 'yes' | 'no';

  @IsOptional()
  @Transform(trimString)
  @IsIn(['any', 'yes', 'no'])
  confidential?: 'any' | 'yes' | 'no';

  /** Scope of the search: my-visible letters (default) or tenant-wide (managers only). */
  @IsOptional()
  @Transform(trimString)
  @IsIn(['visible', 'all'])
  scope?: 'visible' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
