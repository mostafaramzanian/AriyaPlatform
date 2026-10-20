/**
 * Phase W1: the enum/row vocabulary mirrored as local types, so DTOs and
 * services never import the generated client — the same pattern Commerce's
 * `payment-status.ts` established. The generated Prisma types remain the truth
 * inside repositories; these mirrors are what the service/API layer speaks.
 */

export type WarehouseStatus = 'ACTIVE' | 'INACTIVE';
export type LocationStatus = 'ACTIVE' | 'INACTIVE';
export type ItemType = 'STOCKED' | 'NON_STOCKED' | 'SERVICE';
export type ItemTrackingMode = 'NONE' | 'LOT' | 'SERIAL';
export type InventoryItemStatus = 'ACTIVE' | 'INACTIVE';
export type StockMovementKind =
  | 'RECEIPT'
  | 'ISSUE'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'RETURN_TO_STOCK'
  | 'SUPPLIER_RETURN'
  | 'ADJUSTMENT'
  | 'COUNT_VARIANCE'
  | 'REVERSAL';
export type StockTransferStatus = 'DRAFT' | 'DISPATCHED' | 'RECEIVED' | 'CANCELLED';
export type StockAdjustmentReason =
  | 'DAMAGE'
  | 'EXPIRY'
  | 'LOSS'
  | 'FOUND'
  | 'CORRECTION'
  | 'OPENING_BALANCE';
export type StockCountStatus = 'OPEN' | 'POSTED' | 'CANCELLED';
