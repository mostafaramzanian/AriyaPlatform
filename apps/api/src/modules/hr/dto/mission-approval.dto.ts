import { IsString, MaxLength, MinLength } from 'class-validator';
import { TrimmedReason } from './attendance.dto';
import { MISSION_REASON_MAX_LENGTH } from '../domain/mission-reason';

/**
 * Phase 55: Mission approval decision DTOs.
 *
 * The decision is the URL, not a body field: the route names whether the step is
 * approved, rejected, or sent back for correction. The body only carries the reason.
 */

export class ApproveMissionRequestDto {
  @TrimmedReason()
  @IsString()
  @MaxLength(MISSION_REASON_MAX_LENGTH)
  reason?: string;
}

export class RejectMissionRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MISSION_REASON_MAX_LENGTH)
  reason!: string;
}

export class CorrectMissionRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MISSION_REASON_MAX_LENGTH)
  reason!: string;
}
