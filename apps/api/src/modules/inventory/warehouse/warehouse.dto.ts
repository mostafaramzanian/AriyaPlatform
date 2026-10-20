import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { InventoryPageQueryDto } from '../inventory.dto';

/**
 * Phase W1: the payload boundaries of the warehouse/location routes.
 *
 * NEVER ON ANY DTO: `tenantId` (the actor resolves it) and `status` on a create
 * (a warehouse is born ACTIVE, deactivated by its own act). `forbidNonWhitelisted`
 * makes an extraneous field a 400, not a silently ignored one.
 */

export class CreateWarehouseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

export class ListWarehousesQueryDto extends InventoryPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}

export class CreateStorageLocationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;
}

export class UpdateStorageLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
