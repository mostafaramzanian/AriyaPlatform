import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { InventoryPageQueryDto } from '../inventory.dto';
import { INVENTORY_ITEM_TYPES, INVENTORY_TRACKING_MODES } from './item-status';
import type { ItemTrackingMode, ItemType } from '../inventory-types';

/**
 * Phase W1: the payload boundaries of the item routes.
 *
 * NEVER ON ANY DTO: `tenantId`, `status` on create (an item is born ACTIVE),
 * `baseQuantity` (the server converts through the declared ratios — a
 * client-supplied normalised quantity would be a fabricated fact).
 */

export class CreateItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(INVENTORY_ITEM_TYPES)
  itemType!: ItemType;

  /** The unit balances normalise to (e.g. "عدد", "kg", "box" as base). */
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  baseUnit!: string;

  @IsOptional()
  @IsIn(INVENTORY_TRACKING_MODES)
  trackingMode?: ItemTrackingMode;

  @IsOptional()
  @IsBoolean()
  expiryTracked?: boolean;
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(INVENTORY_TRACKING_MODES)
  trackingMode?: ItemTrackingMode;

  @IsOptional()
  @IsBoolean()
  expiryTracked?: boolean;
}

export class AddItemUnitDto {
  /** The alternative unit (e.g. "کارتن" for a "عدد"-base item). */
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  /** `1 unit = ratioToBase × baseUnit`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  @Max(999999999999)
  ratioToBase!: number;
}

export class ListItemsQueryDto extends InventoryPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @IsIn(INVENTORY_ITEM_TYPES)
  itemType?: ItemType;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activeOnly?: boolean = true;
}
