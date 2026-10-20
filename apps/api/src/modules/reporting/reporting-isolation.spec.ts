import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';

/**
 * Phase REPORTING-CONTEXT + REPORTING-CHECK-REQUEST-REPORT + REPORTING-PURCHASE-REPORT +
 * REPORTING-PRODUCTION-REPORT + REPORTING-HR-PERSONNEL-TRAFFIC: ARCHITECTURE
 * ISOLATION — the bounded context's promises re-read from the file system, so
 * each one is falsifiable rather than documented.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ----------------------------
 * The REPORTING-CONTEXT foundation established this suite when the repository
 * held NO Reporting business contract (evidence inventory:
 * `docs/reports/PHASE-REPORTING-BOUNDED-CONTEXT.md`). The CHECK-REQUEST-REPORT
 * phase lands the FIRST such contract — «گزارش وضعیت و گردش درخواست‌های
 * صدور چک» — the PURCHASE-REPORT phase the second — «گزارش وضعیت و
 * چرخه عمر درخواست‌های خرید» — the PRODUCTION-REPORT phase the third —
 * «گزارش خلاصه و وضعیت عملیات تولید» — and the HR-PERSONNEL-TRAFFIC phase the
 * fourth — «گزارش تردد پرسنل». This suite guards the seam each one
 * arrived through rather than the absence they replaced. Every needle below names the
 * phase that moved it.
 *
 * The AI half of the boundary is deliberately NOT here: `src/ai/ai-boundaries.spec.ts`
 * owns it (Reporting sources may reach only `src/platform/ai/**` — never AI
 * configuration, providers, credentials, Core persistence or `process.env`). This
 * suite owns the CONTEXT half, in six groups:
 *
 *   A. THE ENTRY POINT. The module composes EXACTLY `[PlatformAIModule,
 *      PlatformEntitlementModule, FinancialCheckRequestReportingModule,
 *      CommercePurchaseReportingModule, ProductionReportingModule,
 *      HrPersonnelTrafficReportingModule]` and registers
 *      EXACTLY the four report controllers + their services. A fifth route or service
 *      added without a contract fails here first; the comment on the controller
 *      assertion names the full chain every route must carry.
 *
 *   B. NO PERSISTENCE. Reporting owns no schema, no datasource and no client:
 *      no `prisma/reporting`, no `REPORTING_DATABASE_URL` in the runtime policy,
 *      and no Prisma surface of ANY owner importable from this context's sources.
 *      The Financial-owned narrow read module (`financial/reporting/**`) is the
 *      FIRST approved exception to the owner-client rule — and each exception is
 *      asserted as an exception, not a widening (see group C).
 *
 *   C. DEPENDENCY DIRECTION. Every relative import lands inside this module, the
 *      AI seam (`src/platform/ai/**`), the entitlement + auth-metadata seams,
 *      or one of the FOUR APPROVED read seams:
 *      `src/modules/financial/reporting/**`, `src/modules/commerce/reporting/**`,
 *      `src/modules/production/reporting/**` and `src/modules/hr/reporting/**`,
 *      plus each owner's module/feature-id constants (`financial.constants.ts` /
 *      `commerce.constants.ts` / `production.constants.ts` / `hr.constants.ts`) and its
 *      pure source vocabulary (each set named explicitly in the APPROVED list below).
 *      Repository, service, controller, Prisma client, generated client and
 *      DTO-internals imports from any owner fail here. Packages are `@nestjs/common`,
 *      `class-validator`, `class-transformer` (DTO validation) and `express`
 *      (request typing).
 *
 *   D. AUTHORIZATION. No `RbacModule`, no RBAC service injection, no
 *      `reporting.*` permission string and no `REPORTING` PermissionDomain member:
 *      each report reads EXACTLY the remit its SOURCE already covers —
 *      `financial.check.read` for the check-request report, `commerce.read` for
 *      the purchase report, `production.bom.read` for the production report and
 *      `hr.attendance.read` for the personnel-traffic report — so
 *      inventing a second permission would be
 *      authorization theatre. A future report over a DIFFERENT remit seeds its permission
 *      AND this gate's update in the same change (as this phase does for HR
 *      personnel traffic).
 *
 *   E. COMPOSITION. The combined runtime composes Reporting; the Core-only and
 *      CMS-only runtimes boot with zero Reporting knowledge.
 *
 *   F. NO DEFERRED SURFACE. No notification, no search-source, no workflow, no
 *      scheduler — and no report-PLATFORM vocabulary (dashboard / widget / KPI /
 *      metric / warehouse / ...) anywhere in code. The CHECK-REQUEST-REPORT
 *      vocabulary allowlist below names the ONE report's words so the gate can
 *      tell «a real report landed» from «a platform is accreting».
 *
 * NON-VACUITY. Every scan asserts how much it read, so a walk that matched zero
 * sources fails instead of passing quietly, and the non-spec file list is EXACT:
 * a new source file means the contract grew, and this suite must read it
 * before the tree ships it.
 */
const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');

/** Every file under `src/modules/reporting/**`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const allFiles = walk(MODULE_DIR);

/** The module's own SOURCE: specs excluded (this file is a spec too). */
const NON_SPEC = allFiles.filter((file) => !file.endsWith('.spec.ts'));

const sourceOf = (file: string): string => readFileSync(file, 'utf8');

/** The import specifiers a file declares, in order. */
function specifiersOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * A file's CODE: comment lines removed.
 *
 * The module's header explains — in prose — every rule this suite asserts,
 * including words like "controller" and "permission". Scanning that prose would
 * make the documentation of a rule violate it; only code may trip a code gate.
 */
function codeOf(file: string): string {
  return sourceOf(file)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*/')
      );
    })
    .join('\n');
}

const base = (file: string): string => file.replace(/\\/g, '/').split('/').pop()!;

describe('REPORTING-CONTEXT: architecture isolation', () => {
  it('is reading the module it claims to guard (non-vacuity)', () => {
    // Floors plus an EXACT list: the CHECK-REQUEST-REPORT + PURCHASE-REPORT +
    // REPORTING-PRODUCTION-REPORT + REPORTING-HR-PERSONNEL-TRAFFIC contract
    // surface — the composition root, the actor, the four reports' DTOs, services and
    // controllers. A new source file means the contract grew, and this suite must
    // confront it deliberately rather than silently widen.
    expect(allFiles.length).toBeGreaterThanOrEqual(3);
    expect(NON_SPEC.map(base).sort()).toEqual(
      [
        'check-request-report.controller.ts',
        'check-request-report.dto.ts',
        'check-request-report.presentation.ts',
        'check-request-report.service.ts',
        'hr-leave-report.controller.ts',
        'hr-leave-report.dto.ts',
        'hr-leave-report.presentation.ts',
        'hr-leave-report.service.ts',
        'hr-mission-report.controller.ts',
        'hr-mission-report.dto.ts',
        'hr-mission-report.presentation.ts',
        'hr-mission-report.service.ts',
        'hr-personnel-traffic-report.controller.ts',
        'hr-personnel-traffic-report.dto.ts',
        'hr-personnel-traffic-report.presentation.ts',
        'hr-personnel-traffic-report.service.ts',
        'payment-history-report.controller.ts',
        'payment-history-report.dto.ts',
        'payment-history-report.presentation.ts',
        'payment-history-report.service.ts',
        'return-lifecycle-report.controller.ts',
        'return-lifecycle-report.dto.ts',
        'return-lifecycle-report.presentation.ts',
        'return-lifecycle-report.service.ts',
        'production-bom-change-report.controller.ts',
        'production-bom-change-report.dto.ts',
        'production-bom-change-report.presentation.ts',
        'production-bom-change-report.service.ts',
        'production-report.controller.ts',
        'production-report.dto.ts',
        'production-report.presentation.ts',
        'production-report.service.ts',
        'purchase-report.controller.ts',
        'purchase-report.dto.ts',
        'purchase-report.presentation.ts',
        'purchase-report.service.ts',
        'receiving-report.controller.ts',
        'receiving-report.dto.ts',
        'receiving-report.presentation.ts',
        'receiving-report.service.ts',
        'report-docx.writer.ts',
        'report-export.model.ts',
        'report-export.ts',
        'report-xlsx.writer.ts',
        'reporting-actor.ts',
        'reporting.module.ts',
      ].sort()
    );
    expect(existsSync(join(MODULE_DIR, 'reporting.module.ts'))).toBe(true);
  });

  describe('A. the entry point: exactly the report surfaces the contracts establish', () => {
    it('registers exactly the TEN report controllers + their services', () => {
      // Code-only (see `codeOf`): the module's header is ALLOWED to discuss
      // controllers and providers — the CODE may not carry more than the TEN
      // report surfaces the contracts establish.
      // Why an exact-name match instead of single-line regex above: splitting and
      // trimming each controller row keeps the assertion readable across four
      // surfaces, whereas pinning punctuation (`]` after `,` vs none) tests only a
      // style choice that Prettier owns. What this gate pins is the SET of report
      // surfaces — nothing more, nothing earlier.
      const code = codeOf(join(MODULE_DIR, 'reporting.module.ts'));
      const controllersBlock = /controllers\s*:\s*\[([\s\S]*?)\]/.exec(code)?.[1] ?? '';
      expect(
        controllersBlock
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      ).toEqual([
        'CheckRequestReportController',
        'PurchaseReportController',
        'PaymentHistoryReportController',
        'ReturnLifecycleReportController',
        'ReceivingReportController',
        'ProductionReportController',
        'ProductionBomChangeReportController',
        'HrPersonnelTrafficReportController',
        'HrLeaveReportController',
        'HrMissionReportController',
      ]);
      expect(code).toMatch(
        /providers\s*:\s*\[\s*ModuleEntitlementGuard,\s*CheckRequestReportService,\s*PurchaseReportService,\s*PaymentHistoryReportService,\s*ReturnLifecycleReportService,\s*ReceivingReportService,\s*ProductionReportService,\s*ProductionBomChangeReportService,\s*HrPersonnelTrafficReportService,\s*HrLeaveReportService,\s*HrMissionReportService,?\s*\]/
      );
      // Exactly TEN controller files on disk: the ten report routes. An
      // eleventh route without a contract fails here first. (Phase
      // REPORTING-PRODUCTION-BOM-CHANGE-REPORT added the fifth file; phase
      // REPORTING-HR-LEAVE-REQUEST the sixth; REPORTING-HR-MISSION-REQUEST the
      // seventh; REPORTING-COMMERCE-PAYMENT-HISTORY the eighth; phase
      // REPORTING-COMMERCE-RETURN-LIFECYCLE the ninth; phase
      // REPORTING-COMMERCE-RECEIVING-STATUS the tenth — each named in
      // this suite's own lists.)
      expect(NON_SPEC.filter((file) => file.endsWith('.controller.ts')).map(base)).toEqual(
        [
          'check-request-report.controller.ts',
          'hr-leave-report.controller.ts',
          'hr-mission-report.controller.ts',
          'hr-personnel-traffic-report.controller.ts',
          'payment-history-report.controller.ts',
          'production-bom-change-report.controller.ts',
          'production-report.controller.ts',
          'purchase-report.controller.ts',
          'receiving-report.controller.ts',
          'return-lifecycle-report.controller.ts',
        ].sort()
      );
      // All four report routes carry the whole chain every sibling context carries:
      //   @Controller -> @RequiresModule(<MODULE_ID>) -> [-> @RequiresFeature(...)
      //   when the SOURCE declares a feature] -> @UseGuards(ModuleEntitlementGuard)
      //   -> @UseGuards(JwtAuthGuard)
      // plus `@Roles(...)` on every handler and the server-derived actor. The HR
      // surface deliberately has NO @RequiresFeature: HR declares no attendance
      // feature (`HR_FEATURE` carries leave + mission), and a decorator naming a
      // feature that no provisioning migration seeds would 403 a tenancy HR itself
      // serves — so its ABSENCE is asserted by the controller's own spec.
      for (const name of [
        'check-request-report.controller.ts',
        'hr-leave-report.controller.ts',
        'hr-mission-report.controller.ts',
        'hr-personnel-traffic-report.controller.ts',
        'payment-history-report.controller.ts',
        'production-bom-change-report.controller.ts',
        'production-report.controller.ts',
        'purchase-report.controller.ts',
        'receiving-report.controller.ts',
        'return-lifecycle-report.controller.ts',
      ]) {
        const controller = sourceOf(join(MODULE_DIR, name));
        expect({ name, controller: controller.includes('@Controller(') }).toEqual({
          name,
          controller: true,
        });
        const featureRequired = name !== 'hr-personnel-traffic-report.controller.ts';
        for (const marker of [
          '@RequiresModule(',
          ...(featureRequired ? ['@RequiresFeature('] : []),
          'ModuleEntitlementGuard',
          'JwtAuthGuard',
          '@Roles(',
          'resolveReportingActor',
        ]) {
          expect({ name, marker, present: controller.includes(marker) }).toEqual({
            name,
            marker,
            present: true,
          });
        }
      }
    });

    it('composes EXACTLY the AI seam, the entitlement gate and the ten approved read modules', () => {
      // Pinning the WHOLE set (not merely `toContain`) is what makes the import
      // surface a CONTRACT: a further import fails here first and must be justified
      // by a real Reporting requirement, not by symmetry.
      const code = codeOf(join(MODULE_DIR, 'reporting.module.ts'));
      const imports = /imports\s*:\s*\[([\s\S]*?)\]/.exec(code)?.[1] ?? '';
      expect([...imports.matchAll(/([A-Za-z]+Module)\b/g)].map((match) => match[1]).sort()).toEqual(
        [
          'CommercePaymentReportingModule',
          'CommercePurchaseReportingModule',
          'CommerceReceivingReportingModule',
          'CommerceReturnLifecycleReportingModule',
          'FinancialCheckRequestReportingModule',
          'HrLeaveRequestReportingModule',
          'HrMissionRequestReportingModule',
          'HrPersonnelTrafficReportingModule',
          'PlatformAIModule',
          'PlatformEntitlementModule',
          'ProductionBomChangeReportingModule',
          'ProductionReportingModule',
        ].sort()
      );
    });
  });

  describe('B. persistence: this context owns NO database', () => {
    it('has no prisma directory, schema or migration history', () => {
      // A datasource would have to answer "why does Reporting own this data?"
      // with nothing: no contract in the repository assigns source-of-record or
      // derived data to this context. The day one does, this gate — plus
      // `runtime-datasources.ts`, the health graph and the migration history —
      // changes together, in one deliberate phase.
      expect(existsSync(join(API_DIR, 'prisma', 'reporting'))).toBe(false);
    });

    it('declares no REPORTING datasource in the runtime policy', () => {
      const datasources = sourceOf(join(SRC_DIR, 'runtime-datasources.ts'));
      expect(datasources).not.toContain('REPORTING_DATABASE_URL');
    });

    it('names no Prisma surface of ANY owner in this context’s sources', () => {
      // Core's `PrismaService`, another owner's `*-prisma.module`, a generated
      // `*-client` — all of them are the same failure: Reporting reading a
      // source context's tables directly instead of through an approved
      // contract. The isolation must be physical, not conventional.
      const violations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter(
            (specifier) =>
              /prisma/i.test(specifier) ||
              /generated\//.test(specifier) ||
              /database\//.test(specifier)
          )
          .map((specifier) => `${base(file)} -> ${specifier}`)
      );
      expect(violations).toEqual([]);
      // Non-vacuity: the import surface just cleared must actually exist.
      expect(NON_SPEC.flatMap((file) => specifiersOf(file)).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('C. dependency direction: only the approved seams, never a sibling implementation', () => {
    it('resolves every relative import inside this module or an approved seam', () => {
      // Approved seams (Phase CHECK-REQUEST-REPORT + PURCHASE-REPORT +
      // REPORTING-PRODUCTION-REPORT + REPORTING-HR-PERSONNEL-TRAFFIC +
      // REPORTING-VISUALIZATION-EXPORT): this module, the AI seam, the entitlement
      // contract + guard, the auth metadata (Roles
      // decorator), the RBAC permission VALUES (never the module), the FOUR
      // source-owned read seams — `financial/reporting/**`,
      // `commerce/reporting/**`, `production/reporting/**` and `hr/reporting/**`,
      // plus each owner's module/feature-id constants and
      // the pure source vocabulary (ordinals/labels/days, no Prisma, no repository,
      // no clock). A repository, service, controller, Prisma client, generated
      // client or DTO-internals import from any owner fails here.
      //
      // `calendar` joins the seam list for ONE reason: a generated document reads
      // dates the way the product does, and `src/calendar/jalali.util.ts` is the
      // platform's ONLY calendar authority (it is also where `APP_TIME_ZONE` lives —
      // the named zone the export renders instants in). It is pure arithmetic over
      // Intl — no Prisma, no repository, no service, no clock reading — and the
      // allowance names the DIRECTORY so any future import from that module is a
      // deliberate seam decision rather than a silent widening.
      const seamDirs = [
        join(SRC_DIR, 'platform', 'ai'),
        join(SRC_DIR, 'platform', 'entitlement'),
        join(SRC_DIR, 'auth', 'decorators'),
        join(SRC_DIR, 'auth', 'guards'),
        join(SRC_DIR, 'auth', 'rbac', 'constants'),
        join(SRC_DIR, 'common'),
        join(SRC_DIR, 'calendar'),
      ];
      const violations: string[] = [];
      let relative = 0;

      for (const file of NON_SPEC) {
        for (const specifier of specifiersOf(file)) {
          if (!specifier.startsWith('.')) continue;
          relative += 1;
          const target = resolve(dirname(file), specifier);
          const inModule = target === MODULE_DIR || target.startsWith(MODULE_DIR + sep);
          const inSeam = seamDirs.some((dir) => target === dir || target.startsWith(dir + sep));
          // The read seams are named by SPECIFIER (relative imports resolve to
          // `../financial/...` / `../commerce/...` / `../production/...` /
          // `../hr/...` from here,
          // never to a string containing `modules/financial/`, `modules/commerce/`,
          // `modules/production/` or `modules/hr/`): the contract +
          // narrow module + reader, the module/feature-id constants, and the pure
          // source vocabulary (ordinals + labels + the attendance day window, no
          // Prisma, no repository, no clock).
          const normalized = specifier.replace(/\\/g, '/');
          const inApprovedFinancialSeam =
            normalized.includes('../financial/reporting/') ||
            normalized.includes('../financial/financial.constants') ||
            normalized.includes('../financial/check-request/check-request-status');
          const inApprovedCommerceSeam =
            normalized.includes('../commerce/reporting/') ||
            normalized.includes('../commerce/commerce.constants') ||
            normalized.includes('../commerce/purchase/purchase-status') ||
            normalized.includes('../commerce/payment/payment-status') ||
            normalized.includes('../commerce/returns/return-lifecycle') ||
            normalized.includes('../commerce/receiving/receiving-status');
          const inApprovedProductionSeam =
            normalized.includes('../production/reporting/') ||
            normalized.includes('../production/production.constants') ||
            normalized.includes('../production/bom/bom-status');
          const inApprovedHrSeam =
            normalized.includes('../hr/reporting/') ||
            normalized.includes('../hr/domain/leave-status') ||
            normalized.includes('../hr/domain/mission-status') ||
            normalized.includes('../hr/domain/mission-date-time') ||
            normalized.includes('../hr/domain/mission-options') ||
            normalized.includes('../hr/hr.constants') ||
            normalized.includes('../hr/attendance/attendance-window') ||
            normalized.includes('../hr/attendance/hr-attendance-source');
          if (
            !inModule &&
            !inSeam &&
            !inApprovedFinancialSeam &&
            !inApprovedCommerceSeam &&
            !inApprovedProductionSeam &&
            !inApprovedHrSeam
          )
            violations.push(`${base(file)} -> ${specifier}`);
        }
      }

      expect(violations).toEqual([]);
      expect(relative).toBeGreaterThanOrEqual(1);
    });

    it('names only the approved packages', () => {
      // `@nestjs/common` (Nest primitives — including the `StreamableFile` an export
      // route answers with), `class-validator` + `class-transformer` (DTO validation,
      // the same pair every sibling DTO uses) and `express` (request typing, the same
      // import every sibling controller uses) — plus the TWO document writers the
      // REPORTING-VISUALIZATION-EXPORT phase admitted: `exceljs` (OOXML spreadsheet)
      // and `docx` (OOXML Word document). Both were proven absent from the workspace
      // before they were added (no zip/xlsx/docx capability existed anywhere in the
      // repository — only upload MIME allowlists), and both are imported by
      // `export/*.writer.ts` alone, over the presentation model — never by a route, a
      // service or a source seam. A queue client, a CSV writer, anything else — same
      // change that justifies it.
      const packages = NON_SPEC.flatMap((file) =>
        specifiersOf(file).filter((specifier) => !specifier.startsWith('.'))
      );
      expect([...new Set(packages)].sort()).toEqual(
        [
          '@nestjs/common',
          'class-transformer',
          'class-validator',
          'docx',
          'exceljs',
          'express',
        ].sort()
      );
    });

    it('never reaches a Financial, Commerce, Production or HR implementation — only the approved read seams', () => {
      // The approved seams are `../financial/reporting/**`, `../commerce/reporting/**`,
      // `../production/reporting/**` and `../hr/reporting/**` (contract + narrow module +
      // reader), each owner's constants file for the module/feature ids, and each
      // owner's pure vocabulary. For HR that vocabulary is the register's own pure
      // modules — `attendance-window.ts` (the ONE day-window implementation the report
      // and the register share) and `hr-attendance-source.ts` (the closed two-member
      // source set) — no Prisma, no repository, no service, no DTO. Everything else
      // under those four directories — repository, service, controller, Prisma
      // module/service, generated client, DTO internals — fails here, as does any
      // other bounded context.
      const APPROVED: readonly [string, readonly string[]][] = [
        [
          '../financial/',
          ['reporting/', 'financial.constants', 'check-request/check-request-status'],
        ],
        [
          '../commerce/',
          [
            'reporting/',
            'commerce.constants',
            'purchase/purchase-status',
            'payment/payment-status',
            'returns/return-lifecycle',
            'receiving/receiving-status',
          ],
        ],
        ['../production/', ['reporting/', 'production.constants', 'bom/bom-status']],
        [
          '../hr/',
          [
            'reporting/',
            'hr.constants',
            'domain/leave-status',
            'domain/mission-status',
            'domain/mission-date-time',
            'domain/mission-options',
            'attendance/attendance-window',
            'attendance/hr-attendance-source',
          ],
        ],
      ];
      const violations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) => {
            const normalized = specifier.replace(/\\/g, '/');
            return APPROVED.some(
              ([owner, allowed]) =>
                normalized.includes(owner) &&
                !allowed.some((suffix) => normalized.includes(`${owner}${suffix}`))
            );
          })
          .map((specifier) => `${base(file)} -> ${specifier}`)
      );
      expect(violations).toEqual([]);

      // Absolute-style specifiers naming a bounded context's directory are refused
      // outright. `modules/production` stays HERE as well as on the APPROVED list above
      // for a precise reason: the only sanctioned way to reach the Production seam is the
      // RELATIVE `../production/...` form that entry matches, so an
      // `../../modules/production/**` spelling of a repository, service or controller
      // fails here instead of sneaking past the suffix rule. Correspondence, HR and CMS
      // have no approved entry beyond each owner's relative APPROVED list above, so
      // their absolute-style paths are refused here too.
      const foreign = /(modules\/production|modules\/correspondence|modules\/hr|modules\/cms)/;
      const foreignViolations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) => foreign.test(specifier))
          .map((specifier) => `${base(file)} -> ${specifier}`)
      );
      expect(foreignViolations).toEqual([]);

      // No generated-client or Prisma-module import of ANY owner: the four read seams
      // own the only database handles Reporting may transitively reach, and none of the
      // handles is reachable by name from here.
      const prismaViolations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) =>
            /generated|prisma\.service|prisma\.module|prisma-service|prisma-module/i.test(specifier)
          )
          .map((specifier) => `${base(file)} -> ${specifier}`)
      );
      expect(prismaViolations).toEqual([]);
    });
  });

  describe('D. authorization: the source owners existing read remits — no second permission', () => {
    it('imports NO RbacModule and injects nothing it exports', () => {
      // The same rule Financial, Production, HR and Commerce hold: `@Roles` is
      // metadata resolved by the GLOBAL `RolesGuard` at each composition root.
      // Importing `RbacModule` here would pull Core's `PrismaModule` and
      // `NotificationModule` into this bounded context transitively.
      const rbacImporters = NON_SPEC.filter((file) =>
        /from ['"][^'"]*auth\/rbac\/rbac\.module['"]/.test(sourceOf(file))
      );
      expect(rbacImporters.map(base)).toEqual([]);

      const rbacInjectors = NON_SPEC.filter((file) =>
        /\b(PermissionService|RoleService|RolesGuard|CorePermissionSource)\b/.test(codeOf(file))
      );
      expect(rbacInjectors.map(base)).toEqual([]);
    });

    it('declares no `reporting.*` permission in the RBAC constants', () => {
      // Each report reads EXACTLY the remit its SOURCE already covers —
      // `financial.check.read` for the check-request report, `commerce.read`
      // for the purchase report, `production.bom.read` for the production report and
      // `hr.attendance.read` for the personnel-traffic report —
      // so a second permission would be a second answer
      // to the same question with no seeder, no grant and no role behind it. A
      // future report over a DIFFERENT remit seeds its permission AND flips this
      // gate in one change.
      const permissions = sourceOf(join(SRC_DIR, 'auth', 'rbac', 'constants', 'permissions.ts'));
      expect(permissions).not.toMatch(/['"]reporting\./);
    });

    it('gates each report on the remit of the SOURCE it reads — one remit per route', () => {
      // Least privilege, executable: every handler carries exactly one `@Roles(...)`,
      // and that string is the read remit of the bounded context whose rows the route
      // exposes — never a manage, approve, stage or invented reporting value.
      //
      // FIVE HANDLERS PER CONTROLLER SINCE THE VISUALIZATION-EXPORT PHASE: list, the two
      // export routes, one row, one timeline. The export pair answers to the SAME remit
      // as the list it renders — an export is a view of the report, so it can never be
      // the surface that widens who reads these rows.
      //
      // PHASE REPORTING-COMMERCE-PAYMENT-HISTORY: the eighth controller carries FOUR —
      // list, both exports, one row, and NO timeline (the payment audit trail is bound
      // to the DOCUMENT, so a per-row timeline would lie by grain; the contract records
      // the ruling and the route is ABSENT rather than dishonest). The count travels
      // with each entry so the exception is visible, not implied.
      const EXPECTED: readonly [string, string, number][] = [
        ['check-request-report.controller.ts', 'FINANCIAL_CHECK_READ', 5],
        ['hr-leave-report.controller.ts', 'HR_LEAVE_READ', 5],
        ['hr-mission-report.controller.ts', 'HR_MISSION_READ', 5],
        ['hr-personnel-traffic-report.controller.ts', 'HR_ATTENDANCE_READ', 5],
        ['payment-history-report.controller.ts', 'COMMERCE_READ', 4],
        ['production-bom-change-report.controller.ts', 'PRODUCTION_BOM_READ', 5],
        ['production-report.controller.ts', 'PRODUCTION_BOM_READ', 5],
        // PHASE W2-C: the sixth route is `GET …/aging` and the seventh is
        // `GET …/cost` — pending aging and committed cost, under the same
        // `commerce.read` remit.
        ['purchase-report.controller.ts', 'COMMERCE_READ', 7],
        // PHASE REPORTING-COMMERCE-RETURN-LIFECYCLE: the ninth controller carries FIVE —
        // list, both exports, one row, one timeline — because the return audit trail is
        // bound to the RETURN row, so the timeline answers this row's own history.
        ['return-lifecycle-report.controller.ts', 'COMMERCE_READ', 5],
        // PHASE REPORTING-COMMERCE-RECEIVING-STATUS: the tenth controller carries FOUR —
        // list, both exports, one row, NO timeline — because the receiving audit trail is
        // bound to the RECEIPT EVENT while this row is a PURCHASE LINE: a timeline here
        // would answer by the wrong grain, so the route is ABSENT rather than dishonest
        // (the payment register's ruling, applied to the same-shaped audit).
        ['receiving-report.controller.ts', 'COMMERCE_READ', 4],
      ];
      expect(EXPECTED).toHaveLength(10);

      for (const [name, remit, count] of EXPECTED) {
        const controller = sourceOf(join(MODULE_DIR, name));
        const roles = [...controller.matchAll(/@Roles\(([^)]*)\)/g)].map((m) => m[1]);
        expect({ name, count: roles.length }).toEqual({ name, count });
        for (const entry of roles) {
          expect({ name, entry, hasRemit: entry.includes(remit) }).toEqual({
            name,
            entry,
            hasRemit: true,
          });
          expect(entry).not.toMatch(
            /MANAGE|APPROVE|ALLOCATE|REVIEW|ISSUE|DELIVER|CONFIGURE|WORKFLOW/
          );
        }
      }
    });

    it('adds no REPORTING member to the PermissionDomain enum', () => {
      // The enum lives in Core's schema because permissions are Core-owned.
      // A new domain member is exactly the "placeholder permission matrix
      // merely because the module exists" the phase brief forbids.
      const schema = sourceOf(join(API_DIR, 'prisma', 'core', 'schema.prisma'));
      expect(schema).not.toMatch(/enum PermissionDomain\s*\{[^}]*\bREPORTING\b/);
    });
  });

  describe('E. the composition boundary', () => {
    it('app.module composes ReportingModule; core-app and cms-app do not', () => {
      // The combined runtime is where every business bounded context is served;
      // the Core-only and CMS-only deployables must boot with zero Reporting
      // knowledge. The registration is read as source because "it boots with
      // Reporting" rots silently when a composition root is edited.
      const combined = sourceOf(join(SRC_DIR, 'app.module.ts'));
      expect(combined).toContain(
        "import { ReportingModule } from './modules/reporting/reporting.module';"
      );
      expect(combined).toMatch(/^ {4}ReportingModule,$/m);

      for (const root of ['core-app.module.ts', 'cms-app.module.ts']) {
        const source = sourceOf(join(SRC_DIR, root));
        expect({ root, namesModule: source.includes('ReportingModule') }).toEqual({
          root,
          namesModule: false,
        });
        expect({ root, pathsModule: /modules\/reporting/.test(source) }).toEqual({
          root,
          pathsModule: false,
        });
      }
    });
  });

  describe('F. no deferred surface leaked in', () => {
    it('imports no notification, search-source, workflow or scheduler machinery', () => {
      // Each name is a SCOPE DECISION recorded in the phase report, not an
      // oversight: scheduling and subscriptions need a requirement, search
      // integration needs a Search contract, notifications need an event.
      const forbidden =
        /(notifications\/|platform\/search-source|workflow|@nestjs\/schedule|from ['"][^'"]*cron)/;
      const violations = NON_SPEC.flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) => forbidden.test(specifier))
          .map((specifier) => `${base(file)} -> ${specifier}`)
      );
      expect(violations).toEqual([]);
    });

    it('contains no report-PLATFORM vocabulary — only the four report vocabularies this suite guards', () => {
      // The names below are what "Reporting" is MOST OFTEN assumed to mean and
      // what no requirement establishes: dashboards, builders, schedules,
      // exports, warehouses, AI. The four report contracts establish exactly
      // four vocabularies — the check-request status & flow report, the purchase
      // request status & lifecycle report, the production summary & operational
      // status report and the HR personnel-traffic report — so
      // the code may name `report`/`summary`/`timeline` (the reports' own
      // words) but none of the platform words below. A future contract that
      // DOES establish one of these updates this list in the same change that
      // specifies it.
      const FORBIDDEN = [
        'dashboard',
        'widget',
        'kpi',
        'metric',
        'chart',
        'timeseries',
        'clickhouse',
        'elasticsearch',
        'olap',
        'materialized',
        'warehouse',
        'scheduler',
        'cron',
        'subscription',
        'etl',
        'schedule',
        'artificialintelligence',
      ];
      expect(FORBIDDEN.length).toBe(17); // non-vacuity of the list itself

      // Scan on word boundaries: `export` as a SUBSTRING appears in honest
      // words (`exports`, `exported`), and the bare TypeScript `export`
      // keyword names no product surface — so the Export FEATURE gets its own
      // assertion below (the exact export routes each controller exposes) instead
      // of a vocabulary entry here.
      for (const file of NON_SPEC) {
        const tokens = codeOf(file)
          .toLowerCase()
          .replace(/[_-]/g, '')
          .split(/[^a-z\u0600-\u06ff]+/);
        for (const name of FORBIDDEN) {
          expect({ file: base(file), name, present: tokens.includes(name) }).toEqual({
            file: base(file),
            name,
            present: false,
          });
        }
      }
    });

    it('exposes EXACTLY the three reads plus the two format routes — and no write verb ever', () => {
      // Rewritten by REPORTING-VISUALIZATION-EXPORT, which established the export
      // contract this suite now pins from the other side: a report surface is
      //
      //   GET list · GET export/xlsx · GET export/docx · GET :id · GET :id/timeline
      //
      // Nothing more. The export pair is a VIEW of the same report — same class-level
      // guards, same remit (group D), same DTO — so the surface cannot grow a verb, a
      // fourth format or a download helper without failing here. (`export class` is the
      // TypeScript keyword naming the controller itself — not a surface — so the scan
      // looks for route and handler shapes, not the substring, and `xlsx`/`docx` are
      // spelled in the routes while the word `excel`/`csv`/`pdf` stays refused: a
      // format this phase does not render must not appear as an affordance.)
      // W2-C added ONE route to the purchase report alone: `GET aging` — the
      // pending-purchase aging report. Every other surface keeps its five reads.
      const expectedHandlers: Record<string, string[]> = {
        'purchase-report.controller.ts': [
          'aging',
          'cost',
          'exportdocx',
          'exportxlsx',
          'getone',
          'gettimeline',
          'list',
        ].sort(),
      };
      for (const name of [
        'check-request-report.controller.ts',
        'hr-leave-report.controller.ts',
        'hr-mission-report.controller.ts',
        'hr-personnel-traffic-report.controller.ts',
        'production-bom-change-report.controller.ts',
        'production-report.controller.ts',
        'purchase-report.controller.ts',
        'return-lifecycle-report.controller.ts',
      ]) {
        const controller = codeOf(join(MODULE_DIR, name)).toLowerCase();
        for (const forbidden of [
          'download',
          'csv',
          'pdf',
          'excel',
          '@post(',
          '@put(',
          '@patch(',
          '@delete(',
        ]) {
          expect({ name, forbidden, present: controller.includes(forbidden) }).toEqual({
            name,
            forbidden,
            present: false,
          });
        }
        // Exactly the pinned read handlers, by name — list, both formats, one
        // row, timeline; purchase-report additionally exposes `aging` (W2-C),
        // declared before `:id` so it can never be swallowed as a document id.
        const handlers = [
          ...new Set([...controller.matchAll(/async\s+(\w+)\s*\(/g)].map((m) => m[1])),
        ].sort();
        const expected = expectedHandlers[name] ?? [
          'exportdocx',
          'exportxlsx',
          'getone',
          'gettimeline',
          'list',
        ].sort();
        expect({ name, count: (controller.match(/@get\(/g) ?? []).length }).toEqual({
          name,
          count: expected.length,
        });
        expect({ name, handlers }).toEqual({ name, handlers: expected });
        // The two format routes exist under the repository's trailing-verb convention.
        for (const route of ["@get('export/xlsx')", "@get('export/docx')"]) {
          expect({ name, route, present: controller.includes(route.toLowerCase()) }).toEqual({
            name,
            route,
            present: true,
          });
        }
      }

      // PHASE REPORTING-COMMERCE-PAYMENT-HISTORY: the EIGHTH controller — same forbidden
      // verbs and formats, same export-route convention, but EXACTLY FOUR reads: list,
      // both formats, one row. Its ABSENT fifth route is the timeline the contract
      // refuses (document-bound audit grain), pinned here so neither a dishonest
      // timeline nor a stray write verb can arrive silently.
      const paymentName = 'payment-history-report.controller.ts';
      const payment = codeOf(join(MODULE_DIR, paymentName)).toLowerCase();
      for (const forbidden of [
        'download',
        'csv',
        'pdf',
        'excel',
        '@post(',
        '@put(',
        '@patch(',
        '@delete(',
      ]) {
        expect({ name: paymentName, forbidden, present: payment.includes(forbidden) }).toEqual({
          name: paymentName,
          forbidden,
          present: false,
        });
      }
      expect({ name: paymentName, count: (payment.match(/@get\(/g) ?? []).length }).toEqual({
        name: paymentName,
        count: 4,
      });
      expect({
        name: paymentName,
        handlers: [
          ...new Set([...payment.matchAll(/async\s+(\w+)\s*\(/g)].map((m) => m[1])),
        ].sort(),
      }).toEqual({
        name: paymentName,
        handlers: ['exportdocx', 'exportxlsx', 'getone', 'list'].sort(),
      });
      for (const route of ["@get('export/xlsx')", "@get('export/docx')"]) {
        expect({
          name: paymentName,
          route,
          present: payment.includes(route.toLowerCase()),
        }).toEqual({ name: paymentName, route, present: true });
      }

      // PHASE REPORTING-COMMERCE-RECEIVING-STATUS: the TENTH controller — same
      // forbidden verbs and formats, same export-route convention, but EXACTLY
      // FOUR reads: list, both formats, one row. Its ABSENT fifth route is the
      // timeline the contract refuses (receipt-event audit grain over a
      // purchase-line row), pinned here so neither a dishonest timeline nor a
      // stray write verb can arrive silently.
      const receivingName = 'receiving-report.controller.ts';
      const receiving = codeOf(join(MODULE_DIR, receivingName)).toLowerCase();
      for (const forbidden of [
        'download',
        'csv',
        'pdf',
        'excel',
        '@post(',
        '@put(',
        '@patch(',
        '@delete(',
      ]) {
        expect({ name: receivingName, forbidden, present: receiving.includes(forbidden) }).toEqual({
          name: receivingName,
          forbidden,
          present: false,
        });
      }
      expect({
        name: receivingName,
        count: (receiving.match(/@get\(/g) ?? []).length,
      }).toEqual({ name: receivingName, count: 4 });
      expect({
        name: receivingName,
        handlers: [
          ...new Set([...receiving.matchAll(/async\s+(\w+)\s*\(/g)].map((m) => m[1])),
        ].sort(),
      }).toEqual({
        name: receivingName,
        handlers: ['exportdocx', 'exportxlsx', 'getone', 'list'].sort(),
      });
      for (const route of ["@get('export/xlsx')", "@get('export/docx')"]) {
        expect({
          name: receivingName,
          route,
          present: receiving.includes(route.toLowerCase()),
        }).toEqual({ name: receivingName, route, present: true });
      }
    });
  });
});
