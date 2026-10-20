import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { HR_EMPLOYMENT_TYPES, type HrEmploymentType } from './hr-query.dto';
import { MAX_EMPLOYEE_CODE_LENGTH } from './employee.dto';

/**
 * ui-redesign (employees directory): the «بارگذاری گروهی» payload — `POST
 * /hr/employees/import`.
 *
 * Rows are named by CODES (`unitCode`, `positionCode`, `managerEmployeeCode`), not
 * UUIDs: the CSV a human prepares references the same identifiers the screens show.
 * The service resolves each code through the tenant-scoped repositories before it
 * reaches `create`, so a wrong code is a per-row error rather than a FK violation.
 *
 * The batch is bounded at 500 rows — the cap is the DTO's statement about intent,
 * not a guess about memory: larger files belong to a staged migration, not a screen.
 */
export class ImportEmployeeRowDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/)
  @MaxLength(MAX_EMPLOYEE_CODE_LENGTH)
  employeeCode!: string;

  @IsIn(HR_EMPLOYMENT_TYPES)
  employmentType!: HrEmploymentType;

  /** `YYYY-MM-DD`, the API's date-only contract. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @IsString()
  @MaxLength(64)
  unitCode!: string;

  @IsString()
  @MaxLength(64)
  positionCode!: string;

  /** Optional personnel CODE of the manager — resolved to the employee id server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerEmployeeCode?: string;

  /** Optional Core identity id; the tenant-membership check in `create` still applies. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;
}

export class ImportEmployeesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportEmployeeRowDto)
  rows!: ImportEmployeeRowDto[];
}
