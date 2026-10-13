import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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
  ValidateNested,
} from 'class-validator';
import { HR_ISO_DATE_PATTERN } from '../hr.constants';
import { HrPageQueryDto } from './hr-query.dto';
import { TrimmedReason } from './attendance.dto';
import { MISSION_REQUEST_STATUSES } from '../domain/mission-status';
import { MISSION_DURATION_MODES } from '../domain/mission-date-time';
import { MISSION_ROUTING_MODES, MISSION_SELF_APPROVAL_MODES } from '../domain/mission-approval';
import type {
  MissionRequestStatus,
  MissionRoutingMode,
  MissionSelfApprovalMode,
} from '../domain/mission-approval';
import type { MissionDurationMode } from '../domain/mission-options';

export const MAX_MISSION_DESCRIPTION_LENGTH = 1000;
export const MAX_MISSION_DESTINATION_LENGTH = 200;
export const MAX_MISSION_OPTION_CODE_LENGTH = 64;
export const MAX_MISSION_OPTION_LABEL_LENGTH = 200;
export const MAX_MISSION_POLICY_LABEL_LENGTH = 200;

const DATE_MESSAGE = 'must be a calendar day in YYYY-MM-DD form, e.g. 2026-03-01';

class MissionOptionSelectionDto {
  @IsUUID('4')
  optionGroupId!: string;

  @IsUUID('4')
  missionOptionId!: string;
}

export class CreateMissionRequestDto {
  @IsUUID('4')
  employeeId!: string;

  @Matches(HR_ISO_DATE_PATTERN, { message: `startDate ${DATE_MESSAGE}` })
  startDate!: string;

  @Matches(HR_ISO_DATE_PATTERN, { message: `endDate ${DATE_MESSAGE}` })
  endDate!: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/, {
    message: 'startTime must be HH:MM or HH:MM:SS',
  })
  startTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/, {
    message: 'endTime must be HH:MM or HH:MM:SS',
  })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_MISSION_DESTINATION_LENGTH)
  destination?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_MISSION_DESCRIPTION_LENGTH)
  description?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => MissionOptionSelectionDto)
  selections!: MissionOptionSelectionDto[];
}

export class UpdateMissionRequestDto {
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `endDate ${DATE_MESSAGE}` })
  endDate?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/, {
    message: 'startTime must be HH:MM or HH:MM:SS',
  })
  startTime?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/, {
    message: 'endTime must be HH:MM or HH:MM:SS',
  })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_MISSION_DESTINATION_LENGTH)
  destination?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_MISSION_DESCRIPTION_LENGTH)
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MissionOptionSelectionDto)
  selections?: MissionOptionSelectionDto[];
}

export class CancelMissionRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListMissionRequestsQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  @IsOptional()
  @IsIn(MISSION_REQUEST_STATUSES)
  status?: MissionRequestStatus;

  @IsOptional()
  @IsIn(MISSION_DURATION_MODES)
  durationMode?: MissionDurationMode;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

export class CreateMissionReportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}

export class CreateMissionOptionGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_CODE_LENGTH)
  code!: string;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_LABEL_LENGTH)
  label!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateMissionOptionGroupDto {
  @IsOptional()
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_LABEL_LENGTH)
  label?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateMissionOptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_CODE_LENGTH)
  code!: string;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_LABEL_LENGTH)
  label!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateMissionOptionDto {
  @IsOptional()
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_OPTION_LABEL_LENGTH)
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

class MissionApprovalStepDefinitionDto {
  @IsInt()
  @Min(1)
  order!: number;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUUID('4')
  approverEmployeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  approverRole?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class CreateMissionApprovalDefinitionDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsIn(MISSION_ROUTING_MODES)
  routingMode!: MissionRoutingMode;

  @IsIn(MISSION_SELF_APPROVAL_MODES)
  selfApprovalMode!: MissionSelfApprovalMode;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MissionApprovalStepDefinitionDto)
  steps!: MissionApprovalStepDefinitionDto[];
}

export class UpdateMissionApprovalDefinitionDto {
  @IsOptional()
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(MISSION_ROUTING_MODES)
  routingMode?: MissionRoutingMode;

  @IsOptional()
  @IsIn(MISSION_SELF_APPROVAL_MODES)
  selfApprovalMode?: MissionSelfApprovalMode;

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'DRAFT'])
  status?: 'ACTIVE' | 'INACTIVE' | 'DRAFT';
}

export class CreateMissionPolicyVersionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MISSION_POLICY_LABEL_LENGTH)
  label!: string;

  @IsOptional()
  @IsString()
  ruleSetId?: string;

  /** The typed rule-set version document (RuleSetVersion). */
  configuration!: unknown;
}

export class PublishMissionPolicyVersionDto {
  @IsOptional()
  @IsString()
  ruleSetId?: string;
}
