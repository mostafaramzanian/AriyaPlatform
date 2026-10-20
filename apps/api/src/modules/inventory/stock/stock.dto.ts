import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { InventoryPageQueryDto } from '../inventory.dto';

/**
 * Phase W1: the payload boundaries of every stock route.
 *
 * NEVER ON ANY DTO: `tenantId`, `warehouseId`/`locationId` validation results
 * (the server checks tenancy, never trusts them), `status` fields a lifecycle
 * owns, `baseQuantity` (the server converts), `onHand`/`reserved`/`blocked`
 * (balances are derived, never writable), `executed`/`executedAt` facts, and a
 * movement `kind` a caller could use to lie about what an operation was.
 */

const MAX_QTY = 999999999999; // Decimal(18,4) headroom.

class TrackingFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  lotNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  serialNumber?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

export class PostReceiptDto extends TrackingFieldsDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  warehouseId!: string;

  /** StorageLocation id, or omitted for warehouse-level stock. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(MAX_QTY)
  quantity!: number;

  /** The unit the operator counted in; must be the base unit or a declared ItemUnit. */
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  /** What posted this — e.g. `commerce.receipt`, `manual.intake`. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sourceType!: string;

  /** The originating operation's id — idempotency key with sourceType + kind. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sourceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateIssueDto extends TrackingFieldsDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(MAX_QTY)
  quantity!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  /** The internal consumer (person/unit label — an opaque reference). */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  issuedTo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateAdjustmentDto extends TrackingFieldsDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Signed: positive adds, negative removes. Never zero. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-MAX_QTY)
  @Max(MAX_QTY)
  quantity!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @IsIn(['DAMAGE', 'EXPIRY', 'LOSS', 'FOUND', 'CORRECTION', 'OPENING_BALANCE'])
  reason!: 'DAMAGE' | 'EXPIRY' | 'LOSS' | 'FOUND' | 'CORRECTION' | 'OPENING_BALANCE';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateTransferDto extends TrackingFieldsDto {
  @IsUUID()
  itemId!: string;

  @IsUUID()
  fromWarehouseId!: string;

  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  @IsUUID()
  toWarehouseId!: string;

  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(MAX_QTY)
  quantity!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReverseMovementDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateStockCountDto {
  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  lines!: CountLineDto[];
}

class CountLineDto {
  @IsUUID()
  itemId!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class EnterCountLineDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QTY)
  countedQty!: number;
}

export class ListMovementsQueryDto extends InventoryPageQueryDto {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsIn([
    'RECEIPT',
    'ISSUE',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'RETURN_TO_STOCK',
    'SUPPLIER_RETURN',
    'ADJUSTMENT',
    'COUNT_VARIANCE',
    'REVERSAL',
  ])
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceId?: string;
}

export class ListBalancesQueryDto extends InventoryPageQueryDto {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;
}
