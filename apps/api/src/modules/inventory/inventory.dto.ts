import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Phase W1: the shared Inventory read contract — page/pageSize, the same shape
 * CommercePageQueryDto established. Lists are server-paged, never unbounded.
 */
export class InventoryPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;
}
