import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Phase 49H: survey write contracts.
 *
 * No DTO here carries a `tenantId`, `createdById`, `status`, `publishedAt`,
 * `closedAt` or `userId` field. The author is the authenticated subject, the tenant
 * is a snapshot of that subject's tenant, and status moves only through the
 * dedicated status route — so a client cannot create a survey that is already
 * published, publish one by writing a timestamp, or author one on someone else's
 * behalf.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an
 * unexpected property is rejected rather than silently dropped.
 */

export const MAX_SURVEY_TITLE = 200;
export const MAX_SURVEY_DESCRIPTION = 2000;
export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_LABEL = 200;
export const MAX_ANSWER_TEXT = 2000;

/** Bounds on questionnaire size. A survey must ask something, and cannot be endless. */
export const MAX_QUESTIONS_PER_SURVEY = 50;
export const MAX_OPTIONS_PER_QUESTION = 20;

/** The rating scale is fixed at 1..5, matching TicketSatisfaction. */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

export const QUESTION_TYPES = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TEXT',
  'RATING',
] as const;

export type QuestionTypeLiteral = (typeof QUESTION_TYPES)[number];

export class SurveyOptionInputDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_OPTION_LABEL)
  label!: string;
}

/**
 * One question in an authoring payload.
 *
 * `order` is NOT accepted from the client: position is the index of the question in
 * the `questions` array, assigned server-side. Accepting it would let a caller
 * submit duplicate or sparse positions that the
 * `SurveyQuestion_surveyId_order_key` index would then reject with a confusing
 * conflict.
 *
 * `options` / `maxSelections` are validated against `type` in the service, not
 * here: class-validator cannot express "required for these two types, forbidden for
 * the others" without a custom validator, and the rule needs to be stated once, in
 * the place that also enforces it at submission time.
 */
export class SurveyQuestionInputDto {
  @IsIn(QUESTION_TYPES)
  type!: QuestionTypeLiteral;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_QUESTION_TEXT)
  text!: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  /** MULTIPLE_CHOICE only; refused for every other type by the service. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_OPTIONS_PER_QUESTION)
  maxSelections?: number;

  /** Required and non-empty for the two choice types; refused for TEXT and RATING. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OPTIONS_PER_QUESTION)
  @ValidateNested({ each: true })
  @Type(() => SurveyOptionInputDto)
  options?: SurveyOptionInputDto[];
}

export class CreateSurveyDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SURVEY_TITLE)
  title!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MAX_SURVEY_DESCRIPTION)
  description?: string;

  /**
   * Whether results withhold respondent identity. Settable at creation and while
   * the survey is still a DRAFT; frozen afterwards, because changing it later would
   * retroactively alter the privacy terms participants answered under.
   */
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  /**
   * Optional availability window. ISO-8601 strings; the service rejects an inverted
   * window, as does the `Survey_window_order` CHECK.
   */
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUESTIONS_PER_SURVEY)
  @ValidateNested({ each: true })
  @Type(() => SurveyQuestionInputDto)
  questions!: SurveyQuestionInputDto[];
}

/**
 * DRAFT-only edit. `questions` is optional: when present it REPLACES the whole
 * questionnaire, because a partial patch of a nested, ordered structure cannot
 * express deletion or reordering unambiguously. The service refuses the whole
 * request once the survey has left DRAFT.
 */
export class UpdateSurveyDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SURVEY_TITLE)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(MAX_SURVEY_DESCRIPTION)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUESTIONS_PER_SURVEY)
  @ValidateNested({ each: true })
  @Type(() => SurveyQuestionInputDto)
  questions?: SurveyQuestionInputDto[];
}

/**
 * Lifecycle transition. Only the two forward edges exist as inputs; there is no
 * 'DRAFT' target, so a published survey can never be demoted back to a draft.
 */
export class ChangeSurveyStatusDto {
  @IsIn(['PUBLISHED', 'CLOSED'])
  status!: 'PUBLISHED' | 'CLOSED';
}

/**
 * One answer in a submission.
 *
 * Exactly one value shape is populated, decided by the question's type and
 * validated by the service against the questionnaire it actually belongs to:
 *   SINGLE_CHOICE   → optionIds with exactly one entry
 *   MULTIPLE_CHOICE → optionIds, within maxSelections
 *   TEXT            → textValue
 *   RATING          → ratingValue
 *
 * `optionIds` is always a list, even for SINGLE_CHOICE, so the wire shape does not
 * change between the two choice types and the service has one code path to check.
 */
export class SubmitAnswerDto {
  @IsUUID('4')
  questionId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OPTIONS_PER_QUESTION)
  @IsUUID('4', { each: true })
  optionIds?: string[];

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ANSWER_TEXT)
  textValue?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_RATING)
  @Max(MAX_RATING)
  ratingValue?: number;
}

export class SubmitSurveyResponseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_QUESTIONS_PER_SURVEY)
  @ValidateNested({ each: true })
  @Type(() => SubmitAnswerDto)
  answers!: SubmitAnswerDto[];
}

