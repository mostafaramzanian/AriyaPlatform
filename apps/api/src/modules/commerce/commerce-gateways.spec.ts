import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase C1 Step H (§21.H / gates I7, I8, I9): the focused architectural guard for the
 * Commerce platform gateways.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS A FILE SCAN RATHER THAN A UNIT TEST
 * -----------------------------------------------------------------------
 * The three claims of §I7–§I9 are about WHO MAY HOLD A REFERENCE, not about what a
 * function returns:
 *
 *   * only `commerce-identity.gateway.ts` may hold `USER_DIRECTORY`;
 *   * only `commerce-audit.gateway.ts` may hold `AUDIT_PORT`;
 *   * only `commerce-notification.gateway.ts` may hold `NotificationPublisher`.
 *
 * The compiler cannot catch a violation of any of them. Nest's DI is STRUCTURAL: every
 * injection is a constructor parameter and every token is a string-plus-provider pair,
 * so a purchase service that wrote
 * `constructor(@Inject(USER_DIRECTORY) private readonly dir: UserDirectoryContract)`
 * would compile, boot, and pass any review that trusted `tsc` — while moving the
 * tenant-membership rule from one place to N. The only mechanism that can fail is one
 * that reads the files.
 *
 * WHY THIS IS A STANDALONE FILE RATHER THAN `commerce-isolation.spec.ts`
 * ----------------------------------------------------------------------
 * The full isolation suite belongs to step T, when repositories, services and
 * controllers exist for it to constrain. Step H has to be verifiable NOW, and its
 * claims must not be deferred into a suite that does not exist yet. Step T is free to
 * absorb or supersede this file — but superseding it means deleting tests that each
 * state a rule, not editing a count.
 *
 * HOW THE SCAN IS BOUNDED
 * -----------------------
 * Every `.ts` file under `src/modules/commerce/`, at any depth, excluding this guard —
 * which necessarily contains every forbidden string as a regex literal, exactly as
 * `hr-isolation.spec.ts` excludes itself. Source files take the full token scan;
 * `.spec.ts` files take the import assertion at the end instead, because a test that
 * writes `USER_DIRECTORY` into a regex is not a consumer of the port, whereas a test
 * that imports the contract is.
 */

const MODULE_DIR = __dirname;
const SRC_DIR = join(__dirname, '..', '..');
const API_DIR = join(SRC_DIR, '..');
const SCHEMA_FILE = join(API_DIR, 'prisma', 'commerce', 'schema.prisma');
const GUARD_BASENAME = 'commerce-gateways.spec.ts';

/** Every TypeScript file in the module, at any depth. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const moduleFiles = walk(MODULE_DIR).filter((file) => !file.endsWith(GUARD_BASENAME));
const sourceFiles = moduleFiles.filter((file) => !file.endsWith('.spec.ts'));
// Deliberately INCLUDING this guard: its platform references are regex literals, never
// `from '...'` specifiers, so the import assertion below cannot fail on it for quoting
// the very tokens it enforces.
const specFiles = walk(MODULE_DIR).filter((file) => file.endsWith('.spec.ts'));

const readModule = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(API_DIR, file).replace(/\\/g, '/');
const readNamed = (relativeName: string) => readModule(join(API_DIR, relativeName));

/**
 * Comment lines dropped before scanning. Without this the guard would report its own
 * neighbours for QUOTING a forbidden token in documentation — every explanation of why
 * a rule exists names the thing the rule forbids.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  );
}

const codeLines = (source: string) =>
  source.split('\n').filter((line) => line.trim().length > 0 && !isCommentLine(line));

/** Files whose CODE (not prose) mentions the pattern. */
function offenderFiles(pattern: RegExp): string[] {
  return sourceFiles
    .filter((file) => codeLines(readModule(file)).some((line) => pattern.test(line)))
    .map(name)
    .sort();
}

/** Every module specifier the file imports, verbatim. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/** The identifiers declared inside one decorator array of `commerce.module.ts`. */
function decoratorArray(moduleSource: string, key: string): string {
  const match = moduleSource.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  return match ? match[1] : '';
}

const IDENTITY_TOKENS = /USER_DIRECTORY|user-directory\.contract/;
const IDENTITY_MODULE = /\bUserDirectoryModule\b/;
const AUDIT_TOKENS = /\bAUDIT_PORT\b|platform\/audit\/audit\.contract/;
const AUDIT_MODULE = /\bPlatformAuditModule\b/;
const NOTIFY_TOKENS = /NotificationPublisher|notification\.publisher/;
// GAP-9: the USER-ADDRESSED half of the same door. `NotificationService` is the Core
// Notification Center's in-process creation contract; the same "one surface" rule applies
// to it, because a service that injected it directly would bypass the recipient
// deduplication, the tenant assertion and the failure policy the gateway owns.
const NOTIFICATION_SERVICE_TOKENS = /NotificationService|notification\.service/;
const NOTIFY_MODULE = /\bNotificationModule\b/;
// PHASE C9 (GAP-5): the platform's SEARCH SOURCE port. One surface registers, projects
// and answers for Commerce; the module imports the seam once.
const SEARCH_SOURCE_TOKENS = /\bSEARCH_SOURCE_PORT\b|search-source\/search-source\.contract/;
const SEARCH_SOURCE_MODULE = /\bPlatformSearchSourceModule\b/;

const IDENTITY_GATEWAY = 'src/modules/commerce/commerce-identity.gateway.ts';
const AUDIT_GATEWAY = 'src/modules/commerce/commerce-audit.gateway.ts';
const NOTIFY_GATEWAY = 'src/modules/commerce/commerce-notification.gateway.ts';
const SEARCH_SOURCE_SURFACE = 'src/modules/commerce/search/commerce-search-source.service.ts';
const COMMERCE_MODULE = 'src/modules/commerce/commerce.module.ts';
/**
 * Phase PURCHASE-REPORT: the ONE other file allowed to import `PlatformAuditModule` —
 * the Commerce-owned narrow READ module Reporting composes. A composition root, not a
 * service: it exists precisely so that Reporting can hold `CommerceAuditGateway`
 * (the single port surface) without importing `CommerceModule` wholesale.
 */
const REPORTING_READ_MODULE =
  'src/modules/commerce/reporting/commerce-purchase-reporting.module.ts';
/**
 * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: the THIRD composition root allowed to
 * import `PlatformAuditModule` — the return read module, which (like the purchase
 * one) binds the audit PORT so its narrow reader can offer a timeline; the gateway
 * still decides nothing and every offender remains a `*.module.ts` root.
 */
const RETURN_READ_MODULE = 'src/modules/commerce/reporting/return-lifecycle-reporting.module.ts';
const GATEWAYS = [IDENTITY_GATEWAY, AUDIT_GATEWAY, NOTIFY_GATEWAY];

const moduleSource = readNamed(COMMERCE_MODULE);

describe('Commerce platform gateways (C1 step H)', () => {
  it('actually inspects the module — this guard must not pass on an empty file set', () => {
    // Falsifiable: `walk` returning [] (a moved directory, a typo'd path) would make
    // every offenderFiles() assertion below return [] and read as a clean bill of
    // health. A floor plus a membership check turns that silent pass into a failure.
    expect(moduleFiles.length).toBeGreaterThanOrEqual(7);
    expect(sourceFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of moduleFiles) {
      expect(name(file)).toMatch(/^src\/modules\/commerce\//);
    }
    expect(moduleFiles.map(name)).toEqual(
      expect.arrayContaining([
        COMMERCE_MODULE,
        'src/modules/commerce/commerce.constants.ts',
        'src/modules/commerce/database/commerce-prisma.module.ts',
        'src/modules/commerce/database/commerce-prisma.service.ts',
        ...GATEWAYS,
      ])
    );
  });

  it('keeps Core identity behind exactly ONE surface: CommerceIdentityGateway (gate I7)', () => {
    // Falsifiable: a purchase service that injected USER_DIRECTORY itself would still
    // type-check — Nest tokens are structural — and this list would gain a second path.
    expect(offenderFiles(IDENTITY_TOKENS)).toEqual([IDENTITY_GATEWAY]);
    // The platform module is imported once, at this module's composition root, and
    // nowhere else; a service importing it would bypass the gateway by construction.
    expect(offenderFiles(IDENTITY_MODULE)).toEqual([COMMERCE_MODULE]);

    const gateway = readNamed(IDENTITY_GATEWAY);
    expect(codeLines(gateway).join('\n')).toContain('@Inject(USER_DIRECTORY)');
    expect(importSpecifiers(gateway)).toEqual([
      '@nestjs/common',
      '../../platform/user-directory/user-directory.contract',
    ]);
    // The allowlisted projection is re-exported rather than re-declared, so a Commerce
    // service can describe a person without naming the contract itself.
    expect(gateway).toContain('export type { DirectoryUserProfile };');
    // The two answers gate I7 names: membership, and names for a rendered page.
    expect(codeLines(gateway).join('\n')).toMatch(/async assertMember\(/);
    expect(codeLines(gateway).join('\n')).toMatch(/async profilesFor\(/);
  });

  it('keeps the platform audit port behind exactly TWO surfaces: gateway + relay (gate I8)', () => {
    // Phase B2.3: the relay service also injects AUDIT_PORT to deliver durable outbox events.
    // The gateway stamps tenant context; the relay forwards pre-stamped outbox payloads.
    const AUDIT_RELAY = 'src/modules/commerce/commerce-audit-outbox-relay.service.ts';
    expect(offenderFiles(AUDIT_TOKENS)).toEqual([AUDIT_RELAY, AUDIT_GATEWAY].sort());
    // PHASE PURCHASE-REPORT: the platform module may now appear in TWO files, and both
    // are COMPOSITION ROOTS — `commerce.module.ts` and the narrow read module Reporting
    // imports. The rule this check protects is not "one file" for its own sake: it is
    // that no SERVICE reaches the platform module and bypasses the gateway by
    // construction. So the list is now pinned as exactly the two roots, plus a shape
    // check that every offender IS a module file — a `*.service.ts` importing
    // `PlatformAuditModule` fails both assertions, and the second one names why.
    const auditModuleImporters = offenderFiles(AUDIT_MODULE);
    // PHASE REPORTING-COMMERCE-RETURN-LIFECYCLE: the list grows to THREE roots — the
    // return read module joins because its timeline reads the same port through the
    // SAME gateway. The rule is unchanged and still enforced below: every importer
    // IS a composition root, never a service reaching around the gateway.
    expect(auditModuleImporters).toEqual(
      [COMMERCE_MODULE, REPORTING_READ_MODULE, RETURN_READ_MODULE].sort()
    );
    expect(auditModuleImporters.every((file) => file.endsWith('.module.ts'))).toBe(true);

    const gateway = readNamed(AUDIT_GATEWAY);
    const lines = codeLines(gateway).join('\n');
    expect(lines).toContain('@Inject(AUDIT_PORT)');
    expect(importSpecifiers(gateway)).toContain('../../platform/audit/audit.contract');
    // §9: auditId is caller-generated and never derived from requestId.
    expect(lines).toContain('randomUUID()');
    // The tenant stamp comes from the actor, never from a request field and never from
    // a default — this is the whole point of routing §I8 through one file.
    expect(lines).toContain('tenantId: actor.tenantId');
    // And the result stays inside the gateway: an audit failure must not become a
    // business error branch, so no Commerce service can be handed AuditRecordResult.
    expect(lines).not.toContain('AuditRecordResult');
    // PHASE C7: the port gained `read` (P-AUDIT-READ), and the gateway is still the ONLY
    // file that touches it — the read is exposed HERE, as the gateway's second method,
    // rather than by letting a service reach for the port itself.
    expect(lines).toContain('async read(');
    expect(lines).toContain('this.audit.read(');
    // And a failed read stays a REJECTED result, never an exception or a fallback page:
    // the closed code the service maps to a 503 is produced at this boundary too.
    expect(lines).toContain("return { status: 'rejected', code: 'AUDIT_READ_FAILED' };");

    // The resource vocabulary is the step-G constants record, not an arbitrary string.
    expect(importSpecifiers(gateway)).toContain('./commerce.constants');
    expect(readNamed('src/modules/commerce/commerce.constants.ts')).toContain(
      'export const COMMERCE_AUDIT_RESOURCE'
    );
    expect(lines).toContain('resource: CommerceAuditResource;');
  });

  it('keeps notification infrastructure behind exactly ONE surface: CommerceNotificationGateway (gate I9)', () => {
    expect(offenderFiles(NOTIFY_TOKENS)).toEqual([NOTIFY_GATEWAY]);
    expect(offenderFiles(NOTIFY_MODULE)).toEqual([COMMERCE_MODULE]);

    const gateway = readNamed(NOTIFY_GATEWAY);
    const lines = codeLines(gateway).join('\n');
    expect(importSpecifiers(gateway)).toContain('../../notifications/notification.publisher');
    // GAP-9: the gateway holds BOTH platform surfaces. The transport publisher and the
    // Notification Center contract — and the second one is what makes a user-addressed
    // notification possible without a Commerce service reaching Core.
    expect(importSpecifiers(gateway)).toContain('../../notifications/notification.service');
    expect(lines).toContain('private readonly publisher: NotificationPublisher,');
    expect(lines).toContain('private readonly notifications: NotificationService');
    expect(lines).toContain('await this.publisher.publish(');
    expect(lines).toContain('await this.notifications.createForUser(');
    // The recipient is EXACTLY the caller's list, and the tenant travels as the
    // assertion Core enforces — never as a placement override.
    expect(lines).toContain('userId: recipientUserId,');
    expect(lines).toContain('tenantId: actor.tenantId,');
    // Deduplicated at this boundary, so two domain paths that resolve the same owner for
    // one transition still produce one row per user.
    expect(lines).toContain('...new Set(');
    // The actor is NOT filtered out here: the caller decides who the recipient is, and
    // the gateway must not silently drop an id the domain proved to be the owner.
    expect(lines).not.toContain('recipientUserId === actor.userId');
    // The platform-owned envelope fields are applied AFTER the caller's payload spread,
    // so no event body can displace them.
    expect(lines.indexOf('...payload')).toBeLessThan(lines.indexOf('tenantId: actor.tenantId'));
  });
  it('keeps the Core Notification Center behind the same ONE surface (GAP-9)', () => {
    // The user-addressed half of gate I9. Falsifiable in exactly the same way: a Commerce
    // service that injected `NotificationService` itself would type-check, boot, and write
    // rows that never passed the gateway's deduplication or its tenant assertion — and only
    // this list would notice that the module had grown a second notification path.
    expect(offenderFiles(NOTIFICATION_SERVICE_TOKENS)).toEqual([NOTIFY_GATEWAY]);
    // The Core module that PROVIDES the service is imported at one composition root, and
    // it is the same import the publisher already needed: GAP-9 added no module edge.
    expect(offenderFiles(NOTIFY_MODULE)).toEqual([COMMERCE_MODULE]);
    // No Commerce file may name the Core notification TABLE or its generated client: the
    // gateway talks to the service CONTRACT, never to persistence. (Commerce's own Prisma
    // project is a different artifact and is governed by the gateway-persistence rule
    // below, so this scan names the Core client and the core table's delegate only.)
    expect(
      offenderFiles(
        /core-client|\bnotification\.(create|updateMany|findMany|findFirst|deleteMany)\b/
      )
    ).toEqual([]);
  });

  it('keeps the platform search source behind exactly ONE surface: CommerceSearchSourceService (C9)', () => {
    // Falsifiable for the same reason as the three above: Nest tokens are structural, so a
    // second file injecting SEARCH_SOURCE_PORT would type-check and boot — and would
    // project into the `commerce.purchase-document` namespace (or answer authorization
    // from a second rule) without a single compile error. Only this list notices.
    expect(offenderFiles(SEARCH_SOURCE_TOKENS)).toEqual([SEARCH_SOURCE_SURFACE]);
    expect(offenderFiles(SEARCH_SOURCE_MODULE)).toEqual([COMMERCE_MODULE]);

    const adapter = readNamed(SEARCH_SOURCE_SURFACE);
    const lines = codeLines(adapter).join('\n');
    expect(lines).toContain('@Inject(SEARCH_SOURCE_PORT)');
    expect(lines).toContain('CommerceSearchSourceService implements SearchSourceAdapter');
    // The port, the permission seam the RolesGuard asks, Commerce's own constants and the
    // repository that owns every statement — and NOTHING else. In particular no Core
    // client, no index table and no core database name may appear in the ONE file that
    // holds the port: the schema half of the boundary is this list.
    expect(importSpecifiers(adapter)).toEqual([
      '@nestjs/common',
      '../../../auth/rbac/constants/permissions',
      '../../../platform/auth/permission-source.contract',
      '../../../platform/search-source/search-source.contract',
      '../commerce.constants',
      '../purchase/purchase.repository',
    ]);
    expect(lines).not.toMatch(/core-client|SearchDocument|core_db|PrismaService|PrismaModule/);
    // Authorization re-reads the AUTHORITATIVE row through that repository — a batched,
    // tenant-first read, never a per-candidate query and never the index.
    expect(lines).toContain('findDocumentSearchRowsByIds(actor.tenantId, entityIds)');
    // The source supplies a TEMPLATE; the platform composes and encodes the href.
    expect(lines).not.toMatch(/href|https?:\/\//);
  });

  it('wires the three gateways, and imports — but never re-exports — the platform modules', () => {
    const imports = importSpecifiers(moduleSource);
    expect(imports).toContain('../../platform/user-directory/user-directory.module');
    expect(imports).toContain('../../platform/audit/platform-audit.module');
    expect(imports).toContain('../../notifications/notification.module');

    const providers = decoratorArray(moduleSource, 'providers');
    const exports = decoratorArray(moduleSource, 'exports');
    expect(providers).toContain('CommerceIdentityGateway');
    expect(providers).toContain('CommerceAuditGateway');
    expect(providers).toContain('CommerceNotificationGateway');
    // A gateway that is provided but absent from this module's declared surface would
    // become unreachable the moment a later step reaches for it; the export list states
    // the §I7–§I9 boundary explicitly.
    expect(exports).toContain('CommerceIdentityGateway');
    expect(exports).toContain('CommerceAuditGateway');
    expect(exports).toContain('CommerceNotificationGateway');
    // Repositories and services ARRIVED with step L, the first step that owns a domain
    // slice, and the step-H reading of this assertion ("the shell declares gateways
    // only") is replaced by the rule the sentence above ALWAYS stated: they are PROVIDED
    // and never EXPORTED (C1). The two halves are different refusals — a repository in
    // `exports` would let another module query `commerce_db` behind this module's back,
    // while a repository in `providers` is exactly where HR puts its own — so both are
    // asserted, and an empty provider list cannot pass either half.
    expect(providers).toContain('PurchaseRepository');
    expect(providers).toContain('PurchaseService');
    // Step M adds the second slice the same way, in the same edit that keeps this rule
    // readable: a repository that is provided but NOT named here could be dropped from
    // `providers` — or quietly exported — and every unit test would still pass, because
    // each one mocks the collaborator it wants instead of resolving the module.
    expect(providers).toContain('WorkflowConfigurationRepository');
    expect(providers).toContain('WorkflowConfigurationService');
    expect(exports).not.toMatch(/Repository|Service\b/);
    expect(exports).not.toMatch(/Module\b/);
    // Step H declares gateways only, and this assertion was written to hold exactly until
    // the step that OWNS entitlement landed it: step J now imports PlatformEntitlementModule
    // (with the platform guard provided in CommerceModule — asserted, together with the
    // constants↔SQL join, by commerce-entitlement.spec.ts). The rule engine is imported by
    // O (line-level routing), the first Commerce step that evaluates rules.
    expect(decoratorArray(moduleSource, 'imports')).toMatch(/PureRuleEngineModule/);
    expect(decoratorArray(moduleSource, 'imports')).toContain('PlatformEntitlementModule');
  });

  it('keeps every gateway free of persistence of any kind', () => {
    // Falsifiable: the gateway's whole value is that it does not know where the data
    // lives. A repository or a Prisma client reaching one of these three files would
    // type-check and boot — Commerce's own client is perfectly importable from here —
    // and only this scan would notice that the boundary had become two-way.
    const forbidden =
      /HrPrismaService|CommercePrismaService|PrismaService|PrismaModule|core-client|hr-client|commerce-client/;
    for (const gateway of GATEWAYS) {
      const source = readNamed(gateway);
      expect(codeLines(source).join('\n')).not.toMatch(forbidden);
      expect(importSpecifiers(source).join('\n')).not.toMatch(/generated\/|database\/prisma/);
      // Thin adapters are @Injectable classes with a constructor and methods: nothing
      // in this file may declare a table, a query or a scheduler of its own.
      expect(codeLines(source).join('\n')).toContain('@Injectable()');
    }
  });

  it('introduces no forbidden asynchronous work (gate I19)', () => {
    // C1's boundary is synchronous domain work: no timers, no cron, no queue consumer.
    // One such line added "for later" would make Commerce fail to boot in a runtime
    // that has not enabled it, which is exactly what I19 exists to prevent.
    // EXCEPTION: CommerceAuditOutboxRelayService (Phase B2.3) uses setInterval to poll
    // the local AuditOutbox — the same pattern Financial adopted in Phase B2.
    const forbidden =
      /\bsetInterval\b|\bsetTimeout\b|@nestjs\/schedule|\bBullModule\b|\bcron\b|\bqueue\b/i;
    const RELAY_BASENAME = 'commerce-audit-outbox-relay.service.ts';
    for (const file of sourceFiles) {
      if (file.endsWith(RELAY_BASENAME)) continue;
      expect(codeLines(readModule(file)).join('\n')).not.toMatch(forbidden);
    }
  });

  it('records audit against the step-G vocabulary and uses only AuditOutbox for delivery, never a second trail', () => {
    // §I8 wants ONE trail. Commerce owns `commerce_db` and must not grow a second one
    // that would disagree with the platform about what "recorded" means. `AuditOutbox`
    // is a DELIVERY mechanism (Phase B2.3), not a second trail — its rows are relayed
    // and deleted. Any other `model Audit*` would be a second trail.
    expect(existsSync(SCHEMA_FILE)).toBe(true);
    const schema = readFileSync(SCHEMA_FILE, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Allow AuditOutbox (delivery mechanism), forbid AuditLog/AuditTrail/etc (second trail).
    const auditModels = [...schema.matchAll(/\bmodel\s+(Audit\w*)/g)].map((m) => m[1]);
    for (const name of auditModels) {
      expect(name).toBe('AuditOutbox');
    }
  });

  it('does not let a Commerce spec file import the platform contracts directly', () => {
    // A test that WRITES the word USER_DIRECTORY into a regex is not a consumer; a test
    // that imports the contract is, and it would silently become a second dependency of
    // the port the moment someone reached for the type in an assertion.
    for (const file of specFiles) {
      expect(importSpecifiers(readModule(file)).join('\n')).not.toMatch(
        /user-directory\.contract|platform\/audit\/audit\.contract|notification\.publisher/
      );
    }
  });
});
