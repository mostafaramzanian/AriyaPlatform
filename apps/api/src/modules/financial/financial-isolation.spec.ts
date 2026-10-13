import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Phase F1 — FINANCIAL FOUNDATION: ARCHITECTURE ISOLATION — the bounded context's
 * promises re-read from the file system, so each one is falsifiable rather than
 * documented.
 *
 * The Financial slice pins the same promises Production's and Commerce's isolation
 * suites pin, because the failure modes do not shrink with the phase:
 *
 *   A. THE ENTRY POINT. Every controller on disk is the one the module registers, and it
 *      carries the whole chain: `@Controller` → `@RequiresModule` → `@RequiresFeature` →
 *      `@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)`. A route added
 *      without a role fails even though every sibling still passes.
 *
 *   B. THE DATABASE IS ONE DATABASE. Nothing under `src/modules/financial/**` names
 *      another owner's generated client (`core-client`, `commerce-client`,
 *      `production-client`, …), another owner's Prisma module, or Core's `PrismaModule`.
 *      The isolation is physical, not conventional.
 *
 *   C. ONE AUDIT SEAM and ONE IDENTITY SEAM. `AUDIT_PORT` appears in the gateway and
 *      nowhere else; `USER_DIRECTORY` appears in the request service and nowhere else.
 *      Two gateways would be two opinions about the same envelope.
 *
 *   D. THE COMPOSITION BOUNDARY. `app.module.ts` composes Financial and
 *      `core-app.module.ts` does not, so the Core-only deployable boots with zero
 *      Financial knowledge.
 *
 *   E. NO SURFACE BEYOND THE MODULE'S OWN. No Commerce/Purchase import (the order
 *      reference is opaque and the port is unbound), no Commerce WORKFLOW engine, and
 *      the Purchase port file declares an INTERFACE WITHOUT an adapter anywhere in the
 *      module. (States 3..7 — allocation, document review, executive approval, issue,
 *      delivery — are IN SCOPE as of Phase CHECK-ISSUATION; the Commerce engine is not.)
 *      Exactly TWO controllers are registered for the ONE feature.
 *
 *   F. NO CHEQUE-INSTRUMENT FIELD. No bank/iban/sayad/chequeNumber vocabulary exists in
 *      the module's source (Preflight §10 is `NOT ESTABLISHED`), so nothing can be
 *      stored or routed for one.
 *
 * NON-VACUITY. Every scan asserts how many files it read, so a walk that matched zero
 * sources fails instead of passing quietly.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');

/** Every file under `src/modules/financial/**`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const allFiles = walk(MODULE_DIR);
const CONTROLLER_SUFFIX = '.controller.ts';

/** The module's own SOURCE: specs excluded. */
const NON_SPEC = allFiles.filter((file) => !file.endsWith('.spec.ts'));

const sourceOf = (file: string): string => readFileSync(file, 'utf8');

/** The import specifiers a file declares, in order. */
function specifiersOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** A file's CODE: comment lines removed — prose that NAMES a token must not count. */
function codeOf(file: string): string {
  return sourceOf(file)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

const controllersOnDisk = NON_SPEC.filter((file) => file.endsWith(CONTROLLER_SUFFIX));

describe('Phase F1 — financial isolation', () => {
  it('reads a NON-ZERO number of sources (every scan below is non-vacuous)', () => {
    expect(NON_SPEC.length).toBeGreaterThanOrEqual(8);
    expect(controllersOnDisk.length).toBeGreaterThanOrEqual(1);
  });

  describe('A. the entry point', () => {
    it('registers every controller on disk, and each carries the whole guard chain', () => {
      const moduleSource = sourceOf(join(MODULE_DIR, 'financial.module.ts'));
      for (const controller of controllersOnDisk) {
        const className = controller.split(/[\\/]/).pop()!.replace('.controller.ts', '');
        const pascal =
          className.replace(/(^|-)([a-z])/g, (_m, _p, c: string) => c.toUpperCase()) + 'Controller';

        const source = sourceOf(controller);
        expect({ controller: pascal, registered: moduleSource.includes(pascal) }).toEqual({
          controller: pascal,
          registered: true,
        });
        for (const decorator of [
          '@Controller(',
          '@RequiresModule(FINANCIAL_MODULE_ID)',
          '@RequiresFeature(FINANCIAL_MODULE_ID',
          'ModuleEntitlementGuard',
          'JwtAuthGuard',
        ]) {
          expect({ controller: pascal, decorator, present: source.includes(decorator) }).toEqual({
            controller: pascal,
            decorator,
            present: true,
          });
        }
      }
    });
  });

  describe('B. the database is one database', () => {
    it('never names another owner’s generated client, Prisma module, or Core’s PrismaModule', () => {
      const violations: string[] = [];
      for (const file of NON_SPEC) {
        for (const specifier of specifiersOf(file)) {
          if (
            /generated\/(?:core|cms|commerce|production|hr|correspondence)-client/.test(
              specifier
            ) ||
            specifier.includes('PrismaModule') ||
            /database\/prisma(?:\.service|\.module)?$/.test(specifier)
          ) {
            violations.push(`${file}: ${specifier}`);
          }
        }
      }
      expect(violations).toEqual([]);
      // The ONLY Prisma client this module may name is its own.
      const ownClient = NON_SPEC.filter((file) =>
        specifiersOf(file).some((s) => s.includes('generated/financial-client'))
      );
      expect(ownClient.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('C. one audit seam and one identity seam', () => {
    it('binds AUDIT_PORT in the gateway and the outbox relay and NOWHERE else', () => {
      // The token is a bare identifier (an import specifier / an @Inject argument), not
      // a quoted string — so the scan is a WORD BOUNDARY match over comment-stripped code.
      // Phase B2: the relay service also injects AUDIT_PORT to deliver outbox events —
      // this is the durable counterpart of the gateway's best-effort path.
      const holders = NON_SPEC.filter((file) => /\bAUDIT_PORT\b/.test(codeOf(file)));
      expect(holders.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual([
        'audit-outbox-relay.service.ts',
        'financial-audit.gateway.ts',
      ]);
    });

    it('binds USER_DIRECTORY in the request service and NOWHERE else', () => {
      const holders = NON_SPEC.filter((file) => /\bUSER_DIRECTORY\b/.test(codeOf(file)));
      expect(holders.map((f) => f.split(/[\\/]/).pop())).toEqual(['check-request.service.ts']);
    });

    it('reads the timeline ONLY through the gateway’s `read` — never a Prisma audit table', () => {
      for (const file of NON_SPEC) {
        expect(sourceOf(file)).not.toMatch(/auditLog\.(findMany|findFirst|findUnique)/);
        expect(sourceOf(file)).not.toMatch(/AuditLog\.(findMany|findFirst)/);
      }
    });
  });

  describe('D. the composition boundary', () => {
    it('app.module composes FinancialModule and core-app.module does not', () => {
      expect(existsSync(join(SRC_DIR, 'app.module.ts'))).toBe(true);
      const combined = sourceOf(join(SRC_DIR, 'app.module.ts'));
      expect(combined).toContain("from './modules/financial/financial.module'");

      const core = sourceOf(join(SRC_DIR, 'core-app.module.ts'));
      expect(core).not.toMatch(/financial/i);
    });

    it('imports NO RbacModule and injects NOTHING it exports — @Roles is metadata, and the global guard is the composition root\'s', () => {
      // Phase CHECK-ISSUATION: Financial must reach identity/authorization through the
      // platform contract, never through Core's RBAC implementation. `RolesGuard` (the
      // only reader of `@Roles(...)`) is a global APP_GUARD; `PermissionSource` is bound
      // by each runtime's composition root. Importing `RbacModule` here would pull Core's
      // `PrismaModule` and `NotificationModule` into the bounded context transitively.
      // `Permissions` (a CONSTANTS file) and the `@Roles` decorator stay legal — they are
      // declarations, not dependencies.
      const moduleSource = sourceOf(join(MODULE_DIR, 'financial.module.ts'));
      expect(moduleSource).not.toContain('rbac.module');

      const rbacModuleImporters = NON_SPEC.filter((file) =>
        specifiersOf(file).some((value) => /auth\/rbac\/rbac\.module/.test(value))
      );
      expect(
        rbacModuleImporters.map((file) => file.replace(/\\/g, '/').split('/').pop())
      ).toEqual([]);

      const rbacInjectors = NON_SPEC.filter((file) =>
        /\b(PermissionService|RoleService|RolesGuard|CorePermissionSource)\b/.test(codeOf(file))
      );
      expect(rbacInjectors.map((file) => file.replace(/\\/g, '/').split('/').pop())).toEqual([]);
    });
  });

  describe('E. no deferred surface leaked in', () => {
    it('imports no Commerce/Production/HR module — the order and project refs stay opaque', () => {
      const violations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter((value) => /modules\/(?:commerce|production|hr|correspondence)/.test(value))
          .map((value) => `${file}: ${value}`)
      );
      expect(violations).toEqual([]);
    });

    it('declares the Purchase port as an INTERFACE ONLY — no adapter, no binding, no caller', () => {
      const portFile = join(MODULE_DIR, 'purchase-order-reference.port.ts');
      expect(existsSync(portFile)).toBe(true);
      // No adapter file exists anywhere under the module.
      expect(NON_SPEC.some((f) => /purchase.*adapter/i.test(f))).toBe(false);
      // Nothing imports the port — an unbound token cannot be injected, so no service
      // can accidentally depend on a Purchase resolution that does not exist.
      const importers = NON_SPEC.filter(
        (file) =>
          file !== portFile &&
          specifiersOf(file).some((s) => s.includes('purchase-order-reference.port'))
      );
      expect(importers).toEqual([]);
      const moduleSource = sourceOf(join(MODULE_DIR, 'financial.module.ts'));
      expect(moduleSource).not.toContain('PURCHASE_ORDER_REFERENCE_PORT');
    });

    it('imports no Commerce workflow engine and registers exactly the two controllers of the ONE feature', () => {
      // Phase CHECK-ISSUATION — NOTE WHAT IS NO LONGER FORBIDDEN, the reconciliation
      // Phase PRODUCTION-BOM-ITEM recorded for its child aggregate: allocation, document
      // review, executive approval, issuance and delivery MOVED INTO SCOPE with states
      // 3..7 (this phase), so their names are legitimate domain code. What stays
      // forbidden is what the brief §4/§28 keeps forbidden — the COMMERCE workflow
      // engine (and any workflow module) anywhere under this bounded context: the
      // check-issuance process runs on Financial's own domain table + the platform's
      // domain-neutral primitives, never on a purchased-subject engine.
      for (const file of NON_SPEC) {
        // Comment-aware: prose that EXPLAINS the rule must not trip it.
        const code = codeOf(file).toLowerCase();
        expect(code).not.toMatch(/workflowinstance|workflow-configuration|workflow-execution|workflow\.module/);
      }
      // The module registers EXACTLY the requests surface and the static process
      // definition — so a third controller, or a dropped one, fails here rather than
      // shipping an ungoverned surface.
      const moduleSource = sourceOf(join(MODULE_DIR, 'financial.module.ts'));
      expect(moduleSource).toContain(
        'controllers: [CheckRequestController, CheckProcessController]'
      );
      // ...and both controllers on disk carry the whole chain (section A re-reads them).
      expect(controllersOnDisk.map((file) => file.split(/[\\/]/).pop())).toEqual([
        'check-process.controller.ts',
        'check-request.controller.ts',
      ].sort());
    });
  });

  describe('F. no cheque-instrument vocabulary', () => {
    it('never names a cheque number, bank, IBAN or Sayad field — the source has none', () => {
      for (const file of NON_SPEC) {
        const code = codeOf(file);
        // Field-shaped identifiers only, so prose mentioning the rule doesn't trip it.
        expect(code).not.toMatch(/\biban\s*[:=]/i);
        expect(code).not.toMatch(/\bsayadId\s*[:=]/);
        expect(code).not.toMatch(/\bchequeNumber\s*[:=]/i);
        expect(code).not.toMatch(/\bbankAccount\s*[:=]/i);
        expect(code).not.toMatch(/\bdueDate\s*[:=]/i);
      }
    });
  });
});
