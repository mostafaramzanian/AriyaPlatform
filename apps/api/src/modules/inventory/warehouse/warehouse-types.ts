import type { WarehouseRepository } from './warehouse.repository';

/** See `stock-types.ts` — derived from the repository, never re-declared. */
export type Warehouse = NonNullable<Awaited<ReturnType<WarehouseRepository['findById']>>>;
export type StorageLocation = NonNullable<Awaited<ReturnType<WarehouseRepository['findLocation']>>>;
