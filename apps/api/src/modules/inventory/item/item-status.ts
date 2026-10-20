import type { ItemTrackingMode, ItemType } from '../inventory-types';

/**
 * Phase W1: the closed vocabularies mirrored for validation lists, so the DTO
 * layer never hand-writes a value the enum does not define.
 */
export const INVENTORY_ITEM_TYPES = ['STOCKED', 'NON_STOCKED', 'SERVICE'] as const;
export const INVENTORY_TRACKING_MODES = ['NONE', 'LOT', 'SERIAL'] as const;

export type InventoryItemTypeName = ItemType;
export type InventoryTrackingModeName = ItemTrackingMode;
