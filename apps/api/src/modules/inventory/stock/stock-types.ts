import type { StockRepository } from './stock.repository';
import type { ItemRepository } from '../item/item.repository';

/**
 * Phase W1: the row types the service speaks, DERIVED from the repository
 * method signatures rather than re-declared — a mirror can never drift from
 * the generated client when it is computed from the repository's own return
 * types, and the service still never imports the generated client.
 */

export type StockMovement = NonNullable<Awaited<ReturnType<StockRepository['findMovement']>>>;
export type StockTransfer = NonNullable<Awaited<ReturnType<StockRepository['findTransfer']>>>;
export type StockIssue = Awaited<ReturnType<StockRepository['listIssues']>>['items'][number];
export type StockAdjustment = Awaited<ReturnType<StockRepository['listAdjustments']>>['items'][number];
export type StockCount = NonNullable<Awaited<ReturnType<StockRepository['findCount']>>>;
export type InventoryItem = NonNullable<Awaited<ReturnType<ItemRepository['findById']>>>;
