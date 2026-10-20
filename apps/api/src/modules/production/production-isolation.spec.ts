import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Phase PRODUCTION-BOM-HEADER: ARCHITECTURE ISOLATION — the bounded context's promises
 * re-read from the file system, so each one is falsifiable rather than documented.
 *
 * The Production slice is deliberately smaller than Commerce's or HR's, so this suite is
 * smaller too. It pins the same six things, because the failure modes do not shrink with
 * the phase:
 *
 *   A. THE ENTRY POINT. Every controller on disk is the one the module registers, and it
 *      carries the whole chain: `@Controller` → `@RequiresModule` → `@RequiresFeature` →
 *      `@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)`. A route added
 *      without a role fails even though every sibling still passes.
 *
 *   B. THE DATABASE IS ONE DATABASE. Nothing under `src/modules/production/**` names
 *      another owner's generated client, another owner's Prisma module, or Core's
 *      `PrismaModule`. The isolation is physical, not conventional.
 *
 *   C. ONE WRITER. `BomHeader`'s delegate is read by exactly two files inside this bounded
 *      context (its own repository and the item repository's parent guard) and `BomItem`'s
 *      by exactly one; no file uses `findUnique` — it cannot carry a tenant predicate, so
 *      an id alone would read another tenant's row.
 *
 *   D. ONE AUDIT SEAM and ONE IDENTITY SEAM. `AUDIT_PORT` appears in the gateway and
 *      nowhere else; `USER_DIRECTORY` appears in the service and nowhere else. Two
 *      gateways would be two opinions about the same envelope.
 *
 *   E. THE COMPOSITION BOUNDARY. `app.module.ts` composes Production and
 *      `core-app.module.ts` does not, so the Core-only deployable boots with zero
 *      Production knowledge.
 *
 *   F. NO DEFERRED SURFACE LEAKED IN. No notification, no search source, no workflow, no
 *      code generation — each is a scope decision recorded in the report, and an import
 *      would make it a dependency instead. The BOM ITEM is NOT deferred any more (Phase
 *      PRODUCTION-BOM-ITEM), so it is no longer on this list.
 *
 * NON-VACUITY. Every scan asserts how many files it read, so a walk that matched zero
 * sources fails instead of passing quietly.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');

/** Every file under `src/modules/production/**`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const allFiles = walk(MODULE_DIR);
const GUARD_FILE = join(MODULE_DIR, 'production-isolation.spec.ts');
const CONTROLLER_SUFFIX = '.controller.ts';

/** The module's own SOURCE: specs excluded, and this file excluded a second time. */
const NON_SPEC = allFiles.filter((file) => !file.endsWith('.spec.ts') && file !== GUARD_FILE);

const sourceOf = (file: string): string => readFileSync(file, 'utf8');

/** The import specifiers a file declares, in order. */
function specifiersOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * A file's CODE: comment lines removed.
 *
 * Several files here MENTION a token in prose in order to explain why they do not hold
 * it — `production.constants.ts` names `AUDIT_PORT`, `production.module.ts` names
 * `PRODUCTION_PRISMA_CLIENT`. A substring scan over prose would therefore count a file
 * as a holder for documenting a decision, and the rule would stop catching the thing it
 * is for the moment a comment named one.
 */
function codeOf(file: string): string {
  return sourceOf(file)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*/')
      );
    })
    .join('\n');
}

/** Non-vacuity: this suite only means something if it is reading real files. */
describe('PRODUCTION-BOM-HEADER: architecture isolation', () => {
  it('is reading a non-empty module (the scans below would otherwise pass vacuously)', () => {
    // Floors, not exact counts: the EXACT counts that must not drift are the controller
    // count and the one-holder lists below. These two exist so a directory walk that
    // suddenly returns nothing fails instead of passing quietly — they were raised when
    // Phase PRODUCTION-BOM-CHANGE added four source files, and they are raised again
    // here: Phase REPORTING-PRODUCTION-REPORT adds the four `production/reporting/**`
    // files (contract, module, reader + its spec), so the floors grow by exactly that
    // much and no more — and again by Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT,
    // which adds the four `production-bom-change-reporting.*` seam files beside them.
    // Phase B2.4: +1 relay service source file.
    expect(allFiles.length).toBeGreaterThanOrEqual(34);
    expect(NON_SPEC.length).toBeGreaterThanOrEqual(22);
    // THREE controllers: the header at `/production/boms`, its child at
    // `/production/boms/:bomId/items`, and (Phase PRODUCTION-BOM-CHANGE) the change request
    // at `/production/bom-change-requests`. Each must carry the whole chain below, so the
    // assertion counts them rather than assuming one — a FOURTH added later has to be
    // noticed here first.
    expect(NON_SPEC.filter((file) => file.endsWith(CONTROLLER_SUFFIX))).toHaveLength(3);
    expect(existsSync(join(MODULE_DIR, 'production.module.ts'))).toBe(true);
  });

  it('A. the one controller on disk is the one the module registers, with the full chain', () => {
    const controllers = NON_SPEC.filter((file) => file.endsWith(CONTROLLER_SUFFIX));
    const moduleSource = sourceOf(join(MODULE_DIR, 'production.module.ts'));

    for (const file of controllers) {
      const source = sourceOf(file);
      const name = file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', '');
      expect({ file: name, registered: moduleSource.includes(name) }).toEqual({
        file: name,
        registered: true,
      });
      // THE ORDER IS THE RULE. Authentication is the INNERMOST check, so an anonymous
      // request is refused before anything asks what it is entitled to. The two
      // decorators are asserted ADJACENT and in order, because `indexOf` would otherwise
      // find the `JwtAuthGuard` IMPORT statement, which precedes both.
      expect(source).toMatch(/@Controller\(/);
      expect(source).toMatch(/@RequiresModule\(PRODUCTION_MODULE_ID\)/);
      expect(source).toMatch(/@RequiresFeature\(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE\.BOM\)/);
      expect(source).toMatch(
        /@UseGuards\(ModuleEntitlementGuard\)\s*\n\s*@UseGuards\(JwtAuthGuard\)/
      );
      // Every route declares exactly one role.
      expect(source).not.toMatch(/@Roles\([^)]*,/);
      expect(source).not.toMatch(/@Public\(/);
      expect(source).not.toMatch(/@Permissions\(/);
      // The actor comes from the session resolver, never from a request field.
      expect(source).toContain('resolveProductionActor(req)');
    }
  });

  it("B. nothing under this module names another owner's client, module or database", () => {
    // The isolation is PHYSICAL, not conventional. A cross-owner import type-checks and
    // boots — `PrismaService` is structurally identical across owners — so only reading
    // the import surface catches it.
    const OWNERS = ['core', 'cms', 'correspondence', 'observability', 'hr', 'commerce'];
    const FORBIDDEN_MODULES = [
      'PrismaModule',
      'HrPrismaModule',
      'CommercePrismaModule',
      'CorrespondencePrismaModule',
      'CmsPrismaModule',
      'ObservabilityPrismaModule',
    ];
    expect({ owners: OWNERS.length, modules: FORBIDDEN_MODULES.length }).toEqual({
      owners: 6,
      modules: 6,
    }); // non-vacuity

    for (const file of NON_SPEC) {
      const relative = file.replace(/\\/g, '/').split('/').pop()!;
      const specifiers = specifiersOf(file);
      for (const owner of OWNERS) {
        const foreign = specifiers.filter((specifier) =>
          specifier.includes(`generated/${owner}-client`)
        );
        expect({ file: relative, owner, foreign }).toEqual({ file: relative, owner, foreign: [] });
      }
      for (const forbidden of FORBIDDEN_MODULES) {
        const imported = specifiers.some((specifier) => specifier.endsWith(forbidden));
        expect({ file: relative, forbidden, imported }).toEqual({
          file: relative,
          forbidden,
          imported: false,
        });
      }
    }
  });

  it('C. one file binds the connection, one imports the client, one issues queries', () => {
    // THREE ONE-HOLDER CLAIMS, each a different failure if a second appeared:
    //  * the TOKEN is bound in exactly one module — a second binding would be a second
    //    connection profile and a second answer to "is production_db reachable?";
    //  * the GENERATED CLIENT is imported by exactly one file — a second import would be
    //    a second handle to the same database, reachable without going through the
    //    repository that carries the tenant predicate;
    //  * every `.bomHeader.` delegate call lives in the repository.
    const tokenHolders = NON_SPEC.filter((file) =>
      codeOf(file).includes('PRODUCTION_PRISMA_CLIENT')
    );
    expect(
      tokenHolders.map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
    ).toEqual(['production-prisma.module']);

    const clientImporters = NON_SPEC.filter((file) =>
      specifiersOf(file).some((specifier) => specifier.includes('generated/production-client'))
    );
    // FOUR files may name the generated package: the service that CONSTRUCTS the client,
    // and the THREE repositories that import TYPES from it (`BomHeader`/`BomItem`/
    // `BomChangeRequest`, `Prisma`). A type import is not a handle, which is why
    // `PrismaClient` itself is asserted as one-holder below. Phase PRODUCTION-BOM-CHANGE
    // added `bom-change.repository`, which is the THIRD repository and therefore the third
    // type-only importer — the shape of the claim is unchanged, its members are not.
    expect(
      clientImporters
        .map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
        .sort()
    ).toEqual([
      'bom-change.repository',
      'bom-item.repository',
      'bom.repository',
      'production-prisma.service',
    ]);

    const clientConstructors = NON_SPEC.filter((file) =>
      specifiersOf(file).some(
        (specifier) =>
          specifier.includes('generated/production-client') &&
          sourceOf(file).includes('import { PrismaClient }')
      )
    );
    expect(
      clientConstructors
        .map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
        .sort()
    ).toEqual(['production-prisma.service']);

    // `BomHeader`'s delegate has TWO legitimate readers, both inside this bounded context:
    // `bom.repository` (the header's own slice) and `bom-item.repository` — the latter only
    // because a parent-conditional INSERT is impossible in Prisma, so it opens a
    // transaction whose FIRST statement guards the header's DRAFT state. Nothing else in
    // this module may touch it.
    const delegators = NON_SPEC.filter((file) => /\.bomHeader\./.test(sourceOf(file)));
    expect(
      delegators.map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', '')).sort()
    ).toEqual(['bom-item.repository', 'bom.repository']);

    // The child delegate has TWO legitimate holders, both inside this bounded context:
    // `bom-item.repository` owns the item slice, and `bom.repository` issues the summary
    // endpoint's `activeItems` COUNT — a read-only `count({ where: { tenantId, ... } })`
    // whose predicate still leads with the tenant, so the "predicate could be forgotten"
    // hazard this guard watches for does not grow.
    const itemDelegators = NON_SPEC.filter((file) => /\.bomItem\./.test(sourceOf(file)));
    expect(
      itemDelegators
        .map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
        .sort()
    ).toEqual(['bom-item.repository', 'bom.repository']);

    // Phase B2.4: the `auditOutbox` delegate is used by the relay service (reads, updates,
    // deletes its own outbox rows) and by the two repositories that write outbox rows
    // atomically inside their `$transaction`. All three are allowed infrastructure writers,
    // not business-model ownership violations.
    const outboxDelegators = NON_SPEC.filter((file) => /\.auditOutbox\./.test(sourceOf(file)));
    expect(
      outboxDelegators
        .map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
        .sort()
    ).toEqual(['bom-change.repository', 'bom.repository', 'production-audit-outbox-relay.service']);

    // Phase PRODUCTION-BOM-CHANGE added `.bomChangeRequest.` and `.bomChangeRequestItem.`
    // delegates — each used by exactly ONE repository, plus `bom.repository`'s read-only
    // `inFlightChanges` COUNT for the list summary, which carries the same leading
    // `tenantId` predicate the rule exists to guarantee.
    const changeRequestDelegators = NON_SPEC.filter((file) =>
      /\.bomChangeRequest\./.test(sourceOf(file))
    );
    expect(
      changeRequestDelegators
        .map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
        .sort()
    ).toEqual(['bom-change.repository', 'bom.repository']);

    for (const file of NON_SPEC) {
      const code = sourceOf(file)
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return (
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*') &&
            !trimmed.startsWith('*/')
          );
        })
        .join('\n');
      expect({
        file: file.replace(/\\/g, '/').split('/').pop(),
        hasFindUnique: /\.findUnique\s*\(/.test(code),
      }).toEqual({ file: file.replace(/\\/g, '/').split('/').pop(), hasFindUnique: false });
    }
  });

  it('D. ONE audit seam and ONE identity seam — a second of either is a second opinion', () => {
    // Phase B2.4: TWO files now hold `AUDIT_PORT` — the gateway (the envelope owner) and the
    // relay (the delivery infrastructure). The relay uses `@Inject(AUDIT_PORT)` to deliver
    // outbox events, but it is NOT a second audit gateway — it never constructs an envelope.
    const auditHolders = NON_SPEC.filter((file) => codeOf(file).includes('AUDIT_PORT'));
    expect(
      auditHolders.map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', '')).sort()
    ).toEqual(['production-audit-outbox-relay.service', 'production-audit.gateway']);

    // The identity port has exactly TWO consumers — the same ONE question ("is this id a
    // member of my tenant?") asked by the two aggregates that snapshot an approver:
    // `bom.service` for the BOM header, and (Phase PRODUCTION-BOM-CHANGE) `bom-change.service`
    // for the change request. Still no gateway: a gateway with two callers that ask the
    // IDENTICAL question would be indirection without a boundary — a decision recorded in
    // `production.module.ts` rather than an omission here. What the assertion protects is
    // that a THIRD file cannot start resolving identity on its own; adding one is a
    // deliberate edit to this line.
    const identityHolders = NON_SPEC.filter((file) => codeOf(file).includes('USER_DIRECTORY'));
    expect(
      identityHolders.map((file) => file.replace(/\\/g, '/').split('/').pop()!.replace('.ts', ''))
    ).toEqual(['bom.service', 'bom-change.service']);

    // Production keeps NO audit LOG table of its own: `AuditLog` is named only as the trail
    // it reaches through the port. Phase B2.4 adds `AuditOutbox` — a delivery BUFFER, not a
    // second trail — so the assertion checks for `AuditLog` specifically rather than any
    // model containing "Audit".
    expect(sourceOf(join(MODULE_DIR, 'production-audit.gateway.ts'))).toContain('AuditLog');
    const productionSchema = readFileSync(
      join(API_DIR, 'prisma', 'production', 'schema.prisma'),
      'utf8'
    );
    expect(productionSchema).not.toMatch(/model\s+\w*AuditLog\w*/);
    // But AuditOutbox IS expected — the durable delivery buffer (Phase B2.4).
    expect(productionSchema).toMatch(/model AuditOutbox \{/);
  });

  it('E. the COMBINED runtime composes Production and the Core-only one does not', () => {
    const appSource = sourceOf(join(SRC_DIR, 'app.module.ts'));
    expect(appSource).toContain(
      "import { ProductionModule } from './modules/production/production.module';"
    );
    expect(appSource).toMatch(/^\s*ProductionModule,$/m);

    const coreSource = sourceOf(join(SRC_DIR, 'core-app.module.ts'));
    expect(coreSource).not.toContain('ProductionModule');
    expect(coreSource).not.toContain('./modules/production');
    // The same boundary Commerce and Correspondence already hold — stated here so a
    // future "just import it into Core as well" fails on all three rather than only on
    // the new one. (HR is deliberately NOT asserted: `HrModule` is composed by
    // `CoreAppModule` today, which is that phase's own decision and not this one's.)
    expect(coreSource).not.toContain('CommerceModule');
    expect(coreSource).not.toContain('CorrespondenceModule');
  });

  it('E2. imports NO RbacModule and injects NOTHING it exports — @Roles is metadata resolved at the composition root', () => {
    // Phase CHECK-ISSUATION: the same rule Financial now holds. `RolesGuard` is a global
    // APP_GUARD whose `PermissionSource` each runtime's composition root binds; a business
    // module that imports `RbacModule` reaches Core's `PrismaModule` and `NotificationModule`
    // transitively, which is exactly what the bounded-context boundary forbids. The
    // `Permissions` constants file and the `@Roles` decorator remain legal declarations.
    const moduleSource = sourceOf(join(MODULE_DIR, 'production.module.ts'));
    expect(moduleSource).not.toContain('rbac.module');

    const rbacModuleImporters = NON_SPEC.filter((file) =>
      /from ['"][^'"]*auth\/rbac\/rbac\.module['"]/.test(sourceOf(file))
    );
    expect(rbacModuleImporters.map((file) => file.replace(/\\/g, '/').split('/').pop())).toEqual(
      []
    );

    const rbacInjectors = NON_SPEC.filter((file) =>
      /\b(PermissionService|RoleService|RolesGuard|CorePermissionSource)\b/.test(codeOf(file))
    );
    expect(rbacInjectors.map((file) => file.replace(/\\/g, '/').split('/').pop())).toEqual([]);
  });

  it('F. no deferred surface leaked in: notification, search, workflow, code generation', () => {
    // Each of these is a SCOPE DECISION recorded in the phase report, not an oversight.
    // An import would turn it into a dependency the next reader has to disentangle.
    //
    // NOTE WHAT IS *NO LONGER* FORBIDDEN, because Phase PRODUCTION-BOM-ITEM moved it into
    // scope: `BomItem` now exists as a real child aggregate, and `standardPartCode` now
    // exists as a NULLABLE, RESERVED column (readable, never written) — which is precisely
    // how the item aggregate could ship while Product Tree Code stays BLOCKED. What remains
    // forbidden is the generation that column must never acquire, spelled `CodeGhatae` /
    // `standardPartCode`-minting: no counter, no prefix, no renumbering.
    const FORBIDDEN = ['Notification', 'PlatformSearchSource', 'Workflow', 'CodeGhatae'];
    expect(FORBIDDEN.length).toBe(4); // non-vacuity

    const byFile = new Map<string, string>(
      NON_SPEC.map((file) => [
        file.replace(/\\/g, '/').split('/').pop()!,
        sourceOf(file)
          .split('\n')
          .filter((line) => {
            const trimmed = line.trim();
            return (
              !trimmed.startsWith('*') &&
              !trimmed.startsWith('//') &&
              !trimmed.startsWith('/*') &&
              !trimmed.startsWith('*/')
            );
          })
          .join('\n'),
      ])
    );

    for (const [file, code] of byFile) {
      for (const name of FORBIDDEN) {
        expect({ file, name, present: code.includes(name) }).toEqual({
          file,
          name,
          present: false,
        });
      }
    }
  });
});
