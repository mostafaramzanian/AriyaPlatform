/**
 * Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: the Inventory module's own
 * constants, in the shape `financial.constants.ts` established.
 *
 * The values below are shared across files that cannot import each other: the
 * module id must agree between the controller decorators, the Core provisioning
 * migration's SQL and the platform's registry rows — none of which live under
 * `src/modules/inventory/**`.
 */

/**
 * The module's CANONICAL ID — `inventory` — as the platform's registry knows it
 * (`core_db."ModuleRegistration".moduleId`). Inventory declares the requirement;
 * the platform's `ModuleEntitlementGuard` decides whether the tenant holds it.
 */
export const INVENTORY_MODULE_ID = 'inventory';

/**
 * The FEATURE ids Inventory declares. ONE member today: `stock` — the
 * warehouse/item/ledger capability this phase ships. Read/manage/approve are
 * questions of WHO may act (permissions), not of whether the tenant holds the
 * capability.
 */
export const INVENTORY_FEATURE = {
  STOCK: 'stock',
} as const;

/**
 * The audit `resource` strings for the rows Inventory audits — written through
 * `AUDIT_PORT` into `core_db."AuditLog"`; Inventory keeps no audit table of its
 * own. One member per aggregate.
 */
export const INVENTORY_AUDIT_RESOURCE = {
  WAREHOUSE: 'inventory.warehouse',
  LOCATION: 'inventory.storage_location',
  ITEM: 'inventory.item',
  MOVEMENT: 'inventory.stock_movement',
  TRANSFER: 'inventory.stock_transfer',
  ISSUE: 'inventory.stock_issue',
  ADJUSTMENT: 'inventory.stock_adjustment',
  COUNT: 'inventory.stock_count',
} as const;
