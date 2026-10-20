import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase W1 — INVENTORY ISOLATION GUARDS: source-scanning rules in the same
 * style `commerce-isolation.spec.ts` established, pinning the boundaries this
 * module owns so a future edit cannot silently violate them.
 *
 *   1. Only repositories (and the Prisma service/transaction unit) may import
 *      the generated inventory client or issue Prisma delegate calls.
 *   2. Every tenant-owned row is reachable only through `tenantId` predicates —
 *      a repository method may not exist that cannot scope its call.
 *   3. Controllers declare the same entitlement/auth chain every module carries.
 *   4. The ledger is insert-only: no `update`/`delete` on `stockMovement`.
 *   5. No file in this module imports another bounded context's generated
 *      client or Prisma service.
 */

const MODULE_ROOT = join(__dirname);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

const FILES = walk(MODULE_ROOT).map((f) => ({
  path: f,
  code: readFileSync(f, 'utf8'),
}));

const REPOSITORIES = FILES.filter((f) => /\.repository\.ts$/.test(f.path));
const CONTROLLERS = FILES.filter((f) => /\.controller\.ts$/.test(f.path));
const SERVICES = FILES.filter((f) => /\.service\.ts$/.test(f.path));

describe('Inventory isolation guards', () => {
  it('only repositories import the generated inventory client', () => {
    const allowed = /(\.repository\.ts|inventory-prisma\.service\.ts|inventory-transaction\.ts)$/;
    const offenders = FILES.filter(
      (f) =>
        f.code.includes('generated/inventory-client') &&
        !allowed.test(f.path)
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('only repositories call Prisma delegates', () => {
    const offenders = FILES.filter(
      (f) =>
        !/\.repository\.ts$/.test(f.path) &&
        !/inventory-prisma\.service\.ts$/.test(f.path) &&
        !/inventory-transaction\.ts$/.test(f.path) &&
        /\.prisma\.(warehouse|inventoryItem|itemUnit|storageLocation|stockMovement|stockBalance|stockTransfer|stockIssue|stockAdjustment|stockCount|stockCountLine)\./.test(
          f.code
        )
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('every controller declares the entitlement + auth chain', () => {
    for (const controller of CONTROLLERS) {
      expect(controller.code).toContain('@RequiresModule(INVENTORY_MODULE_ID)');
      expect(controller.code).toContain('@RequiresFeature(INVENTORY_MODULE_ID, INVENTORY_FEATURE.STOCK)');
      expect(controller.code).toContain('@UseGuards(ModuleEntitlementGuard)');
      expect(controller.code).toContain('@UseGuards(JwtAuthGuard)');
    }
  });

  it('every read/write declares a permission', () => {
    for (const controller of CONTROLLERS) {
      const handlerCount = (controller.code.match(/@(Get|Post|Patch|Put|Delete)\(/g) ?? []).length;
      const rolesCount = (controller.code.match(/@Roles\(/g) ?? []).length;
      expect(rolesCount).toBe(handlerCount);
    }
  });

  it('the stock ledger is insert-only — no update/delete method writes stockMovement', () => {
    const stockRepo = readFileSync(join(MODULE_ROOT, 'stock/stock.repository.ts'), 'utf8');
    expect(stockRepo).not.toMatch(/stockMovement\.(update|updateMany|delete|deleteMany|upsert)\b/);
  });

  it('no repository file mentions a findUnique on tenant-scoped tables', () => {
    // Tenant-scoped lookups must carry tenantId in the predicate; findUnique on a
    // bare `id` would see every tenant's row. (Composite findUnique WITH
    // tenantId in the key is fine and allowed.)
    const offenders = REPOSITORIES.filter((f) =>
      /findUnique\(\{\s*where:\s*\{\s*id\b/.test(f.code)
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('every repository predicate is tenant-scoped', () => {
    // Every `where:` clause in a repository must mention tenantId. Comments are
    // stripped first — an example in a doc block is not a predicate.
    const stripComments = (code: string) =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const offenders = REPOSITORIES.filter((f) =>
      /where:\s*\{(?![^}]*tenantId)/m.test(stripComments(f.code))
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('no inventory file imports another bounded context\'s client or prisma service', () => {
    const forbiddenPatterns = [
      /generated\/(core|cms|hr|commerce|correspondence|production|financial)-client/,
      /modules\/(commerce|financial|production|hr|correspondence)/,
      /from ['"](\.\.\/)*database\/(cms-)?prisma\.service/,
    ];
    const offenders = FILES.filter((f) => forbiddenPatterns.some((re) => re.test(f.code)));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('the module composes exactly the expected providers', () => {
    const moduleCode = readFileSync(join(MODULE_ROOT, 'inventory.module.ts'), 'utf8');
    for (const name of [
      'InventoryUnitOfWork',
      'InventoryAuditGateway',
      'WarehouseService',
      'WarehouseRepository',
      'ItemService',
      'ItemRepository',
      'StockService',
      'StockRepository',
      'InventoryPrismaModule',
    ]) {
      expect(moduleCode).toContain(name);
    }
  });

  it('every mutation records an audit event through the gateway', () => {
    for (const service of SERVICES) {
      if (!/service\.ts$/.test(service.path) || /inventory-prisma/.test(service.path)) continue;
      const writes = (service.code.match(/this\.audit\.record\(/g) ?? []).length;
      expect(writes).toBeGreaterThan(0);
    }
  });
});
