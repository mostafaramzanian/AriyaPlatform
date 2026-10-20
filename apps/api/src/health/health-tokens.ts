/**
 * Phase ARCH-1.2: runtime-agnostic injection tokens for datasource clients.
 * Phase ARCH-1.3: `RUNTIME_ID` is a SYMBOL token bound per health module by
 * `createHealthProviders(runtime)`, not a string literal repeated in every module.
 * Phase ARCH-2: these tokens are consumed ONLY by the probe registry, never by the
 * probe engine (see `datasource-probe.registry.ts`).
 *
 * HealthService and its probes consume these tokens so that runtime-specific health
 * modules can decide which Prisma modules to import without forcing every runtime to
 * load every generated Prisma client at module-require time.
 *
 * A token here carries the client of exactly ONE datasource and nothing else. The
 * binding "this token belongs to this datasource" is declared once, in
 * `DATASOURCE_PROBES`, and the engine receives an already-assembled
 * `DATASOURCE_PROBE_PROVIDERS` registry — which is why `datasource-health.probe.ts`
 * no longer names a single one of these tokens.
 */

/** The runtime this process is serving: 'core' | 'cms' | 'combined' | 'future-hr'. */
export const RUNTIME_ID = Symbol('RUNTIME_ID');

export const CORE_PRISMA_CLIENT = Symbol('CORE_PRISMA_CLIENT');
export const CMS_PRISMA_CLIENT = Symbol('CMS_PRISMA_CLIENT');
export const CORRESPONDENCE_PRISMA_CLIENT = Symbol('CORRESPONDENCE_PRISMA_CLIENT');
export const OBSERVABILITY_PRISMA_CLIENT = Symbol('OBSERVABILITY_PRISMA_CLIENT');

/**
 * Phase ARCH-2: the HR datasource client token.
 *
 * Phase 51-HR-1 PROVIDES this token: `HrPrismaModule` binds it to `HrPrismaService`,
 * and the combined health graph imports that module, so HR is registered exactly where
 * the policy instantiates it. The seam is unchanged and deliberate — the registry
 * describes HOW to probe `HR_DATABASE_URL`, the policy decides WHETHER a runtime
 * probes it, and binding this token is the only thing that activates HR. That is what
 * let Phase 51-HR-1 add HR to the combined runtime without touching the engine.
 *
 * Binding is still OPTIONAL per graph, and that is the fail-closed property: a runtime
 * whose policy requires HR but whose graph carries no HR client cannot report itself
 * ready. Its HR probe is `failed` — an instantiated, required datasource with no
 * registered provider is a blocking failure — rather than silently `ok`.
 */
export const HR_PRISMA_CLIENT = Symbol('HR_PRISMA_CLIENT');

/**
 * Phase C1: the Commerce datasource client token.
 *
 * `CommercePrismaModule` PROVIDES this token (Phase C1 step E), binding it to
 * `CommercePrismaService`, and the combined health graph imports that module in
 * step F — the exact seam `HR_PRISMA_CLIENT` documents above. `DATASOURCE_PROBES`
 * describes HOW to probe `COMMERCE_DATABASE_URL`; the runtime policy decides WHETHER
 * a runtime probes it; binding this token is the only thing that activates Commerce.
 *
 * Binding is OPTIONAL per graph for the same fail-closed reason: a runtime whose
 * policy requires Commerce but whose graph carries no Commerce client reports its
 * Commerce probe as `failed` rather than silently `ok`.
 */
export const COMMERCE_PRISMA_CLIENT = Symbol('COMMERCE_PRISMA_CLIENT');

/**
 * Phase PRODUCTION-BOM-HEADER: the Production datasource client token.
 *
 * `ProductionPrismaModule` PROVIDES this token, binding it to `ProductionPrismaService`,
 * and binding it is the only thing that activates the Production probe — the exact seam
 * `COMMERCE_PRISMA_CLIENT` documents above. `DATASOURCE_PROBES.PRODUCTION_DATABASE_URL`
 * carries the probe definition; until a runtime composes that module the probe is never
 * reached, because every runtime's policy declares what it instantiates.
 */
export const PRODUCTION_PRISMA_CLIENT = Symbol('PRODUCTION_PRISMA_CLIENT');

/**
 * Phase F1 — FINANCIAL FOUNDATION: the Financial datasource client token.
 *
 * `FinancialPrismaModule` PROVIDES this token, binding it to `FinancialPrismaService`,
 * and binding it is the only thing that activates the Financial probe — the exact seam
 * `PRODUCTION_PRISMA_CLIENT` documents above. `DATASOURCE_PROBES.FINANCE_DATABASE_URL`
 * carries the probe definition; until a runtime composes that module the probe is never
 * reached, because every runtime's policy declares what it instantiates.
 */
export const FINANCE_PRISMA_CLIENT = Symbol('FINANCE_PRISMA_CLIENT');

/**
 * Phase W1 — WAREHOUSE / INVENTORY FOUNDATION: the same binding seam for the
 * Inventory Prisma client. `DATASOURCE_PROBES.INVENTORY_DATABASE_URL` joins the
 * registry the moment `InventoryPrismaModule` binds this token — the same move
 * `FINANCE_PRISMA_CLIENT` documents above.
 */
export const INVENTORY_PRISMA_CLIENT = Symbol('INVENTORY_PRISMA_CLIENT');

export interface PrismaLikeClient {
  $queryRaw: (query: unknown) => Promise<unknown>;
}

export interface ObservabilityPrismaLike {
  ping(): Promise<boolean>;
}
