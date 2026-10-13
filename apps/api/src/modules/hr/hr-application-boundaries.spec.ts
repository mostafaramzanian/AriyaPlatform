import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

/**
 * Phase 51-HR-ARCH-1B — the HR APPLICATION AND DOMAIN boundary guard.
 *
 * `hr-isolation.spec.ts` answers "is HR still isolated from Core, and still tenant-scoped?".
 * This file answers the question ARCH-1B introduces: "are the LAYERS inside HR still pointed
 * in one direction?". The tiers are:
 *
 *   controller → application service → repository → database client
 *                        ↘ domain (pure) ↗
 *
 * Nothing outside `domain/` may become a dependency of it: `domain/` imports NOTHING, so a
 * rule there is readable, reviewable and testable without a Nest container, a database or a
 * request. That is a falsifiable claim, and the rules below falsify it.
 *
 * It does NOT re-assert what `architecture-boundaries.spec.ts` already proves (CoreAppModule
 * cannot reach HR; HR is instantiated only by the runtimes whose runtime policy names it).
 * A second copy of that would be a second place to update, which is how a guard becomes a
 * comment.
 *
 * These rules are statements about SOURCE. They cannot prove a tenant filter is correct at
 * runtime — the composite tenant foreign keys, the repositories' predicates and
 * `OrganizationUnit_no_cycle_guard` do that. What they CAN do is fail review on the shapes
 * that would silently route around those guarantees: a service that starts talking to
 * Prisma, a controller that starts talking to a repository, a domain helper that starts
 * importing NestJS.
 */

const MODULE_ROOT = __dirname;
const SELF = basename(__filename);

const IMPORT_BLOCK = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"];/g;
const SPECIFIER = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Path relative to the module root, always with `/`, so rules are portable. */
function name(file: string): string {
  return relative(MODULE_ROOT, file).replace(/\\/g, '/');
}

const ALL = walk(MODULE_ROOT).filter((file) => basename(file) !== SELF);
const SOURCE = ALL.filter((file) => !file.endsWith('.spec.ts'));
// Phase B2.5: the relay is INFRASTRUCTURE — it polls the outbox, not a business lifecycle.
// It is deliberately excluded from the APPLICATION_SERVICES boundary tests, which verify
// rules about transport, audit wiring, and async work that only apply to request-scoped
// business services. The relay has its own dedicated tests in hr-audit-outbox-relay.spec.ts
// and is guarded by the isolation spec (hr-isolation.spec.ts).
const HR_RELAY = 'hr-audit-outbox-relay.service.ts';
const APPLICATION_SERVICES = SOURCE.filter(
  (file) =>
    file.endsWith('.service.ts') &&
    !name(file).startsWith('database/') &&
    basename(file) !== HR_RELAY
);
const CONTROLLERS = SOURCE.filter((file) => file.endsWith('.controller.ts'));
const REPOSITORIES = SOURCE.filter((file) => file.endsWith('.repository.ts'));
const DOMAIN_FILES = SOURCE.filter((file) => name(file).startsWith('domain/'));

function source(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Every module specifier the file imports, in source order. */
function importSpecifiers(file: string): string[] {
  return [...source(file).matchAll(SPECIFIER)].map((match) => match[1]);
}

/** The identifiers a `from '<moduleName>'` import binds. */
function importedIdentifiers(file: string, moduleName: string): string[] {
  const identifiers: string[] = [];
  for (const match of source(file).matchAll(IMPORT_BLOCK)) {
    if (match[2] !== moduleName) continue;
    const braces = match[1].match(/\{([\s\S]*?)\}/);
    const named = braces ? braces[1] : match[1];
    for (const part of named.split(',')) {
      const identifier = part
        .replace(/\btype\b/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (identifier) identifiers.push(identifier);
    }
  }
  return identifiers;
}

/** Source with comments removed, so a rule never trips over prose. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function offenders(files: string[], predicate: (file: string) => boolean): string[] {
  return files.filter(predicate).map(name).sort();
}

/**
 * The platform identity port and the gateway that fronts it, spelled so that NEITHER
 * literal appears in this file.
 *
 * `hr-isolation.spec.ts` requires the port's name to occur in exactly one module file — the
 * gateway — and it deliberately scans every OTHER spec in the module as well. Writing the
 * name here would make this guard a second reference to the very thing it guards against,
 * which is why the token is assembled as a character class: `user[-_]?directory` matches the
 * SCREAMING_SNAKE injection token, the camel-case contract type and the kebab-case path, and
 * `hr[-_]identity` matches the gateway in any casing, while neither literal occurs below.
 */
const IDENTITY_PORT = /user[-_]?directory|hr[-_]identity/i;

describe('51-HR-ARCH-1B — the layer inventory', () => {
  it('finds the twelve application services, their controllers, repositories and the domain layer', () => {
    // A guard that silently scans nothing is worse than no guard: every rule below is
    // vacuous if its file set is empty, so the inventory is asserted first.
    // 51-HR-3A added the fifth — `leave/leave.service.ts` — and the assertion is EXACT, so
    // that addition was a deliberate edit here rather than a silent one.
    //
    // 54-E added the SIXTH — `leave/leave-approval.service.ts` — and the EXACTNESS is what made
    // that a reviewed change. The new file is a SECOND leave service rather than more methods on
    // the first, because a decision is an act on a STEP by a different actor under a different
    // permission: `LeaveService` owns what was ASKED FOR, `LeaveApprovalService` owns what was
    // STATED about it. §18's two aggregates, in the layer that enforces the split.
    //
    // 54-F added the SEVENTH — `leave-policy/leave-policy.service.ts` — as a reviewed edit for the
    // same reason. It is its OWN service rather than methods on `LeaveService` because a policy is
    // not a request: a policy VERSION is authored, validated, published and archived on its own
    // lifecycle (§10), governed by its own permission, and the repository it writes through is the
    // policy aggregate's. Folding it into `LeaveService` would put two lifecycles behind one name.
    //
    // 54-H added the EIGHTH — `leave-policy/leave-policy-simulation.service.ts` — and the exactness
    // again did the reviewing. It is a SEPARATE service rather than `simulate()` on `LeavePolicyService`
    // because the two answer opposite questions: the policy service STATES configuration, and its own
    // header records that a hypothetical "what would this do?" surface "would have to invent an answer
    // for a version that does not exist yet". This service answers that question by reading configuration
    // it did not author and returning a decision it does not apply. Keeping them apart is also what makes
    // the read-only guarantee CHECKABLE — the simulation service is provably free of the audit gateway
    // and of every write method, which would be impossible to assert if the two shared a class.
    //
    // 55 added the NINTH through TWELFTH: the Mission request surface, the Mission approval
    // decision surface and the Mission policy authoring surface, mirroring the leave split.
    expect(APPLICATION_SERVICES.map(name).sort()).toEqual([
      'attendance/attendance.service.ts',
      'employees/employees.service.ts',
      'employment/employment.service.ts',
      'leave-policy/leave-policy-simulation.service.ts',
      'leave-policy/leave-policy.service.ts',
      'leave/leave-approval.service.ts',
      'leave/leave.service.ts',
      'mission/mission-approval.service.ts',
      'mission/mission-policy.service.ts',
      'mission/mission.service.ts',
      'organization/organization.service.ts',
      'positions/positions.service.ts',
    ]);
    expect(CONTROLLERS.length).toBeGreaterThan(0);
    expect(REPOSITORIES.length).toBeGreaterThan(0);
    expect(DOMAIN_FILES.length).toBeGreaterThan(0);
  });

  it('rule 1 — a controller delegates and never reaches persistence', () => {
    expect(
      offenders(CONTROLLERS, (file) =>
        importSpecifiers(file).some((specifier) => /prisma|repository|database/i.test(specifier))
      )
    ).toEqual([]);

    expect(
      offenders(CONTROLLERS, (file) => /\bthis\.prisma\b|\.\$transaction\b/.test(code(file)))
    ).toEqual([]);

    for (const controller of CONTROLLERS) {
      expect({
        controller: name(controller),
        delegates: importSpecifiers(controller).some((specifier) => specifier.endsWith('.service')),
      }).toEqual({ controller: name(controller), delegates: true });
    }
  });

  it('rule 2 — an application service carries no transport', () => {
    expect(
      offenders(APPLICATION_SERVICES, (file) => {
        const specifiers = importSpecifiers(file);
        if (specifiers.some((specifier) => /^express$|platform-express/.test(specifier))) {
          return true;
        }
        const common = importedIdentifiers(file, '@nestjs/common');
        return common.includes('Request') || common.includes('Response');
      })
    ).toEqual([]);
  });
});
describe('51-HR-ARCH-1B — domain purity, identity and data access', () => {
  it('rule 3 — the domain layer is framework-free', () => {
    // The strongest available statement of purity: not "only safe modules", but NOTHING.
    // A single `import { ConflictException }` fails here rather than quietly re-coupling a
    // rule to NestJS two lines away from the throw that needs it.
    for (const file of DOMAIN_FILES) {
      expect({ file: name(file), imports: importSpecifiers(file) }).toEqual({
        file: name(file),
        imports: [],
      });
    }

    // A domain SPEC may import its own siblings and nothing else — not `@nestjs/testing`,
    // not a repository, not a fake Prisma driver. Domain rules need no container to test.
    const domainSpecs = ALL.filter((file) => name(file).startsWith('domain/'));
    expect(domainSpecs.length).toBeGreaterThan(0);
    for (const spec of domainSpecs) {
      for (const specifier of importSpecifiers(spec)) {
        expect({ spec: name(spec), specifier, sibling: /^\.\.?\//.test(specifier) }).toEqual({
          spec: name(spec),
          specifier,
          sibling: true,
        });
      }
    }

    // Nor may the rules reach for persistence, audit or identity through any other door.
    expect(
      offenders(
        DOMAIN_FILES,
        (file) =>
          /\brepository\b|AuditService|prisma/i.test(code(file)) || IDENTITY_PORT.test(code(file))
      )
    ).toEqual([]);
  });

  it('rule 4 — a second identity surface cannot be added', () => {
    // `hr-isolation.spec.ts` already pins the port to the gateway file from the outside-in
    // direction. This is the inside-out direction: which HR layers may even NAME the
    // gateway. A repository or a domain rule that learned about identity would be a second
    // way to resolve a person, so both are refused here. Comments are stripped first: this
    // rule is about what a file DEPENDS on, and a doc comment that merely uses the word
    // "identity" is prose, not a dependency.
    expect(offenders(REPOSITORIES, (file) => IDENTITY_PORT.test(code(file)))).toEqual([]);

    expect(offenders(DOMAIN_FILES, (file) => IDENTITY_PORT.test(code(file)))).toEqual([]);

    expect(offenders(CONTROLLERS, (file) => IDENTITY_PORT.test(code(file)))).toEqual([]);
  });

  it('rule 5 — audit stays outside HR persistence', () => {
    // HR writes to the ONE platform audit trail (§49) and never to its own tables: an
    // `AuditLog` in `hr_db` would fork the trail, and an HR repository writing audit rows
    // would make the persistence layer the owner of a compliance record.
    expect(offenders(REPOSITORIES, (file) => /AuditService|AuditLog/.test(code(file)))).toEqual([]);

    expect(
      offenders(
        SOURCE.filter((file) => name(file).startsWith('database/')),
        (file) => /AuditService|AuditLog/.test(code(file))
      )
    ).toEqual([]);

    // Positively: every application service reaches the trail through the HR AUDIT GATEWAY.
    //
    // ARCH-3B moved the surface from `AuditService` to `HrAuditGateway` and the rule got
    // STRONGER rather than merely renamed: four services now name one gateway that stamps the
    // tenant and the event identity from the actor, so a call site can no longer supply — or
    // omit — either. The second assertion is what makes that structural: the gateway is the
    // only file in the module that may import the platform audit seam at all.
    //
    // 54-H ADDED THE ONE SANCTIONED EXCEPTION, AND IT IS NAMED HERE RATHER THAN EXCLUDED BY PATTERN.
    // §14.1 and §26.4 make a SIMULATION write no audit event at all: it is a question, not an act, and
    // §23.7 adds that it "produces no snapshot at all". So `LeavePolicySimulationService` is the module's
    // only application service that must NOT reach the audit gateway, and the loop below asserts that
    // POSITIVELY — an omission would otherwise be indistinguishable from a service that simply forgot,
    // which is the defect this rule exists to catch. The set is written out so a THIRD service cannot
    // join the exception list by being added to a filter.
    const AUDIT_FREE_SERVICES: readonly string[] = Object.freeze([
      // §14: simulation is read-only, so it writes no audit success event and no mutation (§26.4).
      'leave-policy/leave-policy-simulation.service.ts',
    ]);

    const AUDIT_SEAM = /(?:platform\/audit\/audit\.contract|common\/audit\.service)$/;
    const importsSeam = (file: string) =>
      importSpecifiers(file).some((specifier) => AUDIT_SEAM.test(specifier));

    for (const service of APPLICATION_SERVICES) {
      const identifiers = importedIdentifiers(service, '../hr-audit.gateway');
      const expected = !AUDIT_FREE_SERVICES.includes(name(service));

      expect({
        service: name(service),
        usesPlatformAudit: identifiers.includes('HrAuditGateway'),
      }).toEqual({ service: name(service), usesPlatformAudit: expected });
    }

    // Phase B2.5: the relay legitimately imports `AUDIT_PORT` from the platform audit
    // contract. It is infrastructure, not a business service, and has its own dedicated tests.
    expect(offenders(SOURCE, importsSeam).sort()).toEqual([
      'hr-audit-outbox-relay.service.ts',
      'hr-audit.gateway.ts',
    ]);
  });

  it('rule 6 — a tenant-owned read states its tenant (§17 regression guard)', () => {
    // The defect this makes impossible: a future `findById(id)` added for convenience, which
    // reads across tenants unless the caller remembered to filter. Every read in an HR
    // repository must take `tenantId` as its FIRST parameter, so the scope is impossible to
    // pass by accident and impossible to omit by accident.
    const method =
      /^\s{2}(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*[:{]/gm;
    const offenders: string[] = [];

    for (const repository of REPOSITORIES) {
      for (const match of source(repository).matchAll(method)) {
        const [, methodName, parameters] = match;
        if (!/^(find|list|has)/.test(methodName)) continue;
        const first = parameters.split(',')[0].trim();
        if (!first.startsWith('tenantId')) {
          offenders.push(`${name(repository)}::${methodName}(${first || '…'})`);
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });

  it('rule 7 — the application and domain layers start no asynchronous infrastructure', () => {
    // ARCH-1B adds no scheduler, worker, queue or background timer: work in these layers
    // happens inside the request that asked for it, which is what keeps the audit entry, the
    // tenant scope and the HTTP status describing the same event. The Prisma client wrapper
    // under `database/` is deliberately out of scope — owning a connection pool is its job.
    //
    // Phase B2.5: `buildOutboxPayload` and `outbox` variable references in business services
    // are SYNCHRONOUS payload construction, not async infrastructure. The relay (which IS
    // async) is excluded from APPLICATION_SERVICES above. The `outbox` pattern below is
    // narrowed to catch ONLY infrastructure-level outbox usage (e.g. `OutboxRelay`, `outbox.findMany`,
    // `AuditOutbox` model usage), not payload references.
    const governed = [...APPLICATION_SERVICES, ...CONTROLLERS, ...DOMAIN_FILES];

    expect(
      offenders(governed, (file) =>
        /\bsetInterval\b|\bsetTimeout\b|\bnew Worker\b|\bBull\b|\bQueue\b|\bCron\b|EventEmitter|OutboxRelay/i.test(
          code(file)
        )
      )
    ).toEqual([]);
  });
});
