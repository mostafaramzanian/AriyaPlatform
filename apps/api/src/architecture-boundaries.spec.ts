import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const read = (file: string) => fs.readFileSync(file, 'utf8');

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : entry.name.endsWith('.ts') ? [target] : [];
  });
}

function importsOf(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    return [statement.moduleSpecifier.text];
  });
}

function moduleImports(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) return [];
    if (!ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements
      .map((element) => element.name.text)
      .filter((name) => name.endsWith('Module'));
  });
}

/**
 * Every string VALUE in a file, read from the syntax tree.
 *
 * The distinction matters: a comment that describes a removed fallback
 * (`amqp://user:password@host:port`) is documentation, while the same text as a string
 * literal is a credential in source. Scanning raw text cannot tell them apart, so the
 * credential gate below scans values.
 */
function stringValues(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) values.push(node.text);
    else if (ts.isTemplateExpression(node)) values.push(node.head.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

import {
  DATASOURCE_OWNERS,
  RUNTIME_DATASOURCE_MATRIX,
  RUNTIME_HEALTH_COMPOSITION,
  RUNTIME_IDS,
  notUsedDatasources,
  requiredDatasources,
} from './runtime-datasources';

/**
 * The global-prefix declarations a bootstrap makes, as `app.setGlobalPrefix(prefix, { exclude })`
 * writes them.
 *
 * Read from the syntax tree for the same reason `stringValues` is: the exclusion has to be a VALUE
 * in the call, so a comment explaining why the path is excluded cannot satisfy the rule below. Each
 * declared path is returned as its SOURCE TEXT, which is what lets the rule tell a bootstrap that
 * names the contract constant from one that re-typed the path by hand.
 */
function globalPrefixDeclarations(file: string): { prefix: string; excludes: string[] }[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const declarations: { prefix: string; excludes: string[] }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setGlobalPrefix'
    ) {
      const [prefixArgument, optionsArgument] = node.arguments;
      const excludes: string[] = [];

      if (optionsArgument && ts.isObjectLiteralExpression(optionsArgument)) {
        for (const property of optionsArgument.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            property.name.getText(source) !== 'exclude' ||
            !ts.isArrayLiteralExpression(property.initializer)
          ) {
            continue;
          }

          for (const element of property.initializer.elements) {
            excludes.push(element.getText(source));
          }
        }
      }

      declarations.push({ prefix: prefixArgument ? prefixArgument.getText(source) : '', excludes });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return declarations;
}

function discoverIndependentModules(root: string, srcRoot: string): string[] {
  const prismaRoot = path.join(root, 'prisma');
  const moduleRoot = path.join(srcRoot, 'modules');
  if (!fs.existsSync(prismaRoot) || !fs.existsSync(moduleRoot)) return [];

  const prismaNames = new Set(
    fs.readdirSync(prismaRoot).filter((name) => {
      const stat = fs.statSync(path.join(prismaRoot, name));
      return stat.isDirectory() && fs.existsSync(path.join(prismaRoot, name, 'schema.prisma'));
    }),
  );

  return fs
    .readdirSync(moduleRoot)
    .filter((name) => {
      const stat = fs.statSync(path.join(moduleRoot, name));
      return stat.isDirectory() && prismaNames.has(name);
    })
    .sort();
}

const INDEPENDENT_MODULE_OWNER_REGISTRY = discoverIndependentModules(root, src);

describe('architecture boundaries', () => {
  it('keeps the combined runtime a deterministic superset of Core', () => {
    const combined = new Set(moduleImports(path.join(src, 'app.module.ts')));
    const core = moduleImports(path.join(src, 'core-app.module.ts'));
    const allowedCoreOnly = new Set(['CoreHealthModule']);
    expect(core.filter((module) => !combined.has(module) && !allowedCoreOnly.has(module))).toEqual([]);
    expect(combined.has('CorrespondenceModule')).toBe(true);
    expect(combined.has('BlogModule')).toBe(true);
    expect(combined.has('MediaModule')).toBe(true);
  });

  it('documents a consistent runtime -> datasource ownership matrix', () => {
    expect(requiredDatasources('core')).toEqual(['CORE_DATABASE_URL']);
    expect(requiredDatasources('cms')).toEqual(['CORE_DATABASE_URL', 'CMS_DATABASE_URL']);
    expect(requiredDatasources('combined')).toEqual([
      'CORE_DATABASE_URL',
      'CMS_DATABASE_URL',
      'CORRESPONDENCE_DATABASE_URL',
      // Phase 51-HR-1: the combined runtime hosts the HR module, so `hr_db` joined the set of
      // databases this process must reach.
      'HR_DATABASE_URL',
      // Phase C1 step F: the combined runtime's health graph now imports
      // `CommercePrismaModule`, so `commerce_db` joined the set too — the same edit that
      // flipped the matrix (see runtime-datasources.ts).
      'COMMERCE_DATABASE_URL',
      // Phase PRODUCTION-BOM-HEADER: the combined runtime's health graph now imports
      // `ProductionPrismaModule`, so `production_db` joined the set too — the same edit,
      // in the same place, for the same reason.
      'PRODUCTION_DATABASE_URL',
      // Phase F1 — FINANCIAL FOUNDATION: the combined runtime's health graph now imports
      // `FinancialPrismaModule`, so `finance_db` joined the set too — the same edit, in
      // the same place, for the same reason.
      'FINANCE_DATABASE_URL',
    ]);
    expect(requiredDatasources('future-hr')).toEqual(['CORE_DATABASE_URL', 'HR_DATABASE_URL']);
    expect(RUNTIME_DATASOURCE_MATRIX.combined.datasources.OBSERVABILITY_DATABASE_URL).toBe('optional');
    expect(notUsedDatasources('core')).toEqual([
      'CMS_DATABASE_URL',
      'CORRESPONDENCE_DATABASE_URL',
      'HR_DATABASE_URL',
      // Phase C1: Commerce joined as an OWNER `target` in step A and became `implemented`
      // in step F — but only for the COMBINED runtime, which now composes its Prisma
      // module. The Core-only runtime keeps Commerce `not-used`, so its image ships no
      // Commerce client and never reaches `commerce_db`.
      'COMMERCE_DATABASE_URL',
      // Phase PRODUCTION-BOM-HEADER: the same boundary as Commerce — the Core-only runtime
      // does not serve Production, so it keeps Production `not-used`, ships no Production
      // client and never reaches `production_db`.
      'PRODUCTION_DATABASE_URL',
      // Phase F1 — FINANCIAL FOUNDATION: and the same boundary again for Financial.
      'FINANCE_DATABASE_URL',
    ]);
  });

  it('keeps independently owned business modules out of CoreAppModule', () => {
    const imports = importsOf(path.join(src, 'core-app.module.ts'));
    for (const name of INDEPENDENT_MODULE_OWNER_REGISTRY) {
      const pattern = new RegExp(`(?:${name}|/modules/${name}(?:/|$))`);
      expect(imports.some((value) => pattern.test(value))).toBe(false);
    }
  });

  it('keeps platform implementation free of business-module imports', () => {
    const forbidden = /(?:correspondence|support|surveys|messaging|calendar|\/hr(?:\/|$))/;
    const violations = filesUnder(path.join(src, 'module-platform')).flatMap((file) =>
      importsOf(file).filter((value) => forbidden.test(value)).map((value) => `${file}: ${value}`),
    );
    expect(violations).toEqual([]);
  });

  it('forbids Core Prisma persistence in independent modules', () => {
    // CMS Blog imports Core PrismaModule solely to satisfy the Core audit
    // service dependency in the combined runtime. Business persistence
    // (BlogRepository/MediaService) uses only CmsPrismaService. This single
    // documented exception is excluded from the strict rule.
    const auditExceptionPath = path.join(src, 'modules', 'cms', 'blog', 'blog.module.ts');
    const moduleRoots = INDEPENDENT_MODULE_OWNER_REGISTRY.map((name) => path.join(src, 'modules', name));
    const violations = moduleRoots.flatMap((directory) =>
      filesUnder(directory).flatMap((file) => {
        if (file === auditExceptionPath) return [];
        return importsOf(file)
          .filter((value) => /database\/prisma(?:\.service|\.module)?$/.test(value))
          .map((value) => `${file}: ${value}`);
      }),
    );
    expect(violations).toEqual([]);
  });

  it('keeps UserDirectory adapter free of HR-specific coupling', () => {
    const userDirFiles = filesUnder(path.join(src, 'platform', 'user-directory'));
    const violations = userDirFiles.flatMap((file) =>
      importsOf(file)
        .filter((value) => /modules\/(?:hr|correspondence|cms)|hr(?:\.service|\/)/.test(value))
        .map((value) => `${file}: ${value}`),
    );
    expect(violations).toEqual([]);
  });

  it('keeps the token seam free of business-module and Core-persistence imports', () => {
    // Phase 51-HR-ARCH-3A: `platform/auth` is the seam a standalone business runtime binds. The
    // portability that makes that possible is a property of its IMPORTS, so it is asserted here
    // rather than described in a comment: the seam may not reach into a business module
    // (`modules/`), into Core's Prisma services (`database/prisma`), or into a runtime-owned
    // consumer (`auth/`, `tenant/`, `messaging/`) — any of which would make "HR can bind this
    // without Core" false, because the binding would drag Core's database along with it.
    const seamFiles = filesUnder(path.join(src, 'platform', 'auth'));
    expect(seamFiles.length).toBeGreaterThan(0);

    const forbidden = /(?:^|\/)(?:modules|auth|tenant|messaging|database)\//;
    const violations = seamFiles.flatMap((file) =>
      importsOf(file)
        .filter((value) => forbidden.test(value) || /database\/prisma/.test(value))
        .map((value) => `${file}: ${value}`),
    );

    expect(violations).toEqual([]);
  });

  it('keeps the claim-only implementations free of any Core dependency', () => {
    // These two classes are what a runtime with NO Core database binds. "No Core dependency" is
    // therefore a stronger claim than "does not import PrismaService": the whole import list is
    // checked, so a future edit that reached for a Core helper — a logger, a config service, a
    // cache — fails here instead of silently making the extracted runtime need Core again.
    const claimOnly = [
      path.join(src, 'platform', 'auth', 'token-permission-source.ts'),
      path.join(src, 'platform', 'auth', 'claims-tenant-resolver.ts'),
    ];

    for (const file of claimOnly) {
      const external = importsOf(file).filter((value) => !value.startsWith('.'));
      expect({ file: path.basename(file), external }).toEqual({
        file: path.basename(file),
        external: ['@nestjs/common'],
      });
    }
  });

  it('keeps Core-only health from eagerly depending on CMS or Correspondence DB', () => {
    const coreHealthRoot = path.join(src, 'health', 'core-health.module.ts');
    const coreHealthImports = new Set(importsOf(coreHealthRoot));
    const forbidden = ['CmsPrismaModule', 'CorrespondencePrismaModule'];
    const violations = forbidden.filter((m) => coreHealthImports.has(m) || coreHealthImports.has(`${m}Module`));
    expect(violations).toEqual([]);
  });

  it('binds every independent Prisma schema to its owned datasource — derived from the owner registry', () => {
    // Phase CHECK-ISSUATION: this test used to hold a HAND-WRITTEN `directory → env var`
    // map that stopped at Commerce, so `prisma/production` and `prisma/financial` were
    // checked by nothing while the test kept passing. The map is now the runtime policy's
    // OWN declaration (`DATASOURCE_OWNERS` — the same source health, Docker and
    // `runtime-policy.json` read), so an owner registered there is bound here in the same
    // edit, and the two complementary tripwires below fail on either direction of drift.
    const owners = Object.values(DATASOURCE_OWNERS);
    expect(owners.length).toBeGreaterThanOrEqual(1);

    for (const owner of owners) {
      const schema = path.join(root, owner.prismaSchema);
      expect({ schema: owner.prismaSchema, exists: fs.existsSync(schema) }).toEqual({
        schema: owner.prismaSchema,
        exists: true,
      });
      expect(read(schema)).toContain(`env("${owner.datasource}")`);
    }
  });

  it('registers an owner for EVERY prisma project on disk — a new schema cannot pass the gate silently', () => {
    // The direction the registry-derived test above cannot cover: a NEW Prisma project
    // added under `prisma/` without a `DATASOURCE_OWNERS` entry. Before this tripwire the
    // gap was structural — the owners were a list somebody had to remember to extend, and
    // production/financial proved a list that stops early reads exactly like a list that
    // is complete. Both directions are now asserted as set equality against the filesystem.
    const projectsOnDisk = fs
      .readdirSync(path.join(root, 'prisma'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `prisma/${entry.name}/schema.prisma`)
      .filter((schema) => fs.existsSync(path.join(root, schema)));

    const owned = new Set(Object.values(DATASOURCE_OWNERS).map((owner) => owner.prismaSchema));

    // Non-vacuity: an empty walk would satisfy both filters below and pass by finding
    // nothing to check.
    expect(projectsOnDisk.length).toBeGreaterThanOrEqual(1);

    const unownedProjects = projectsOnDisk.filter((schema) => !owned.has(schema));
    const ghostOwners = [...owned].filter((schema) => !projectsOnDisk.includes(schema));
    expect({ unownedProjects, ghostOwners }).toEqual({ unownedProjects: [], ghostOwners: [] });
  });

  it('ensures CMS uses centralized env validation and CORS builder', () => {
    const cmsAppModule = read(path.join(src, 'cms-app.module.ts'));
    expect(cmsAppModule).toContain('validate: validateEnv');

    const cmsMain = read(path.join(src, 'cms-main.ts'));
    expect(cmsMain).toContain('buildCorsOrigin');
    expect(cmsMain).not.toMatch(/origin:\s*configService\.get<string>\('CORS_ORIGIN'\)\s*\|\|\s*'\*'/);
  });

  it('ensures CMS runtime imports the shared RedisModule so AuthModule can resolve sessions', () => {
    const cmsAppModule = read(path.join(src, 'cms-app.module.ts'));
    expect(cmsAppModule).toContain('RedisModule');
  });

  it('ensures the combined runtime uses the platform-ws adapter, not a Socket.IO default', () => {
    const main = read(path.join(src, 'main.ts'));
    expect(main).toContain('WsAdapter');
    expect(main).toContain("from '@nestjs/platform-ws'");
    expect(main).toContain('useWebSocketAdapter');
  });

  it('does not use the deprecated root Prisma project in executable tooling', () => {
    const executableFiles = [
      path.resolve(root, '..', '..', 'package.json'),
      path.join(root, 'package.json'),
      path.resolve(root, '..', '..', 'infrastructure', 'docker', 'Dockerfile.backend'),
      path.resolve(root, '..', '..', 'infrastructure', 'docker', 'Dockerfile.core'),
      path.resolve(root, '..', '..', 'infrastructure', 'docker', 'Dockerfile.cms'),
      path.join(root, 'entrypoint.sh'),
    ];
    const violations = executableFiles.filter((file) => read(file).includes('prisma/schema.prisma'));
    expect(violations).toEqual([]);
  });

  it('discovers independent modules from prisma/modules pairing and verifies their assets', () => {
    expect(INDEPENDENT_MODULE_OWNER_REGISTRY.length).toBeGreaterThanOrEqual(1);

    for (const name of INDEPENDENT_MODULE_OWNER_REGISTRY) {
      const schema = path.join(root, 'prisma', name, 'schema.prisma');
      const migrations = path.join(root, 'prisma', name, 'migrations');
      const moduleRoot = path.join(src, 'modules', name);
      // CMS Prisma service is at database/cms-prisma.service.ts (the precedent
      // established by Phase 33J); Correspondence and future modules keep it
      // under src/modules/<name>/database/<name>-prisma.service.ts.
      const serviceSearchRoots = name === 'cms' ? [moduleRoot, path.join(src, 'database')] : [moduleRoot];
      const serviceExists = serviceSearchRoots.some((dir) =>
        fs.existsSync(dir) ? filesUnder(dir).some((file) => /prisma\.service\.ts$/.test(path.basename(file))) : false,
      );

      expect({ name, exists: fs.existsSync(schema) }).toEqual({ name, exists: true });
      expect({ name, exists: fs.existsSync(migrations) }).toEqual({ name, exists: true });
      expect({ name, exists: fs.existsSync(moduleRoot) }).toEqual({ name, exists: true });
      expect({ name, exists: serviceExists }).toEqual({ name, exists: true });
    }
  });

  it('does not let independent business modules import Core or Observability Prisma services', () => {
    // A module may import ONLY its own datasource's Prisma service/module.
    // CMS Blog imports PrismaModule for the Core audit service only, which is a
    // documented, approved cross-datasource platform capability.
    const moduleDirs = INDEPENDENT_MODULE_OWNER_REGISTRY.map((name) => path.join(src, 'modules', name));
    const allowedFiles = new Set([
      path.join(src, 'modules', 'cms', 'blog', 'blog.module.ts'),
    ]);
    const ownServicePattern = (name: string) => {
      // CMS Prisma service lives at database/cms-prisma.* as the historical exception;
      // correspondence and future modules keep it under their module root.
      return name === 'cms'
        ? /database\/cms-prisma(?:\.service|\.module)?$/
        : new RegExp(`modules/${name}/database/${name}-prisma(?:\\.service|\\.module)?$`);
    };
    const violations = moduleDirs.flatMap((dir) => {
      const name = path.basename(dir);
      const allowedOwn = ownServicePattern(name);
      return filesUnder(dir).flatMap((file) => {
        if (allowedFiles.has(file)) return [];
        return importsOf(file)
          .filter((value) => /database\/(?:observability-prisma|prisma)(?:\.service|\.module)?$/.test(value))
          .filter((value) => !allowedOwn.test(value))
          .map((value) => `${file}: ${value}`);
      });
    });
    expect(violations).toEqual([]);
  });

  it('binds every implemented health graph through the one derived provider factory', () => {
    for (const runtime of RUNTIME_IDS) {
      const composition = RUNTIME_HEALTH_COMPOSITION[runtime];
      const file = path.join(src, composition.file);

      if (composition.status !== 'implemented') {
        expect({ runtime, exists: fs.existsSync(file) }).toEqual({ runtime, exists: false });
        continue;
      }

      const source = read(file);
      expect({
        runtime,
        derived: source.includes(`createHealthProviders('${runtime}')`),
      }).toEqual({ runtime, derived: true });
      // A module that assembled its own probe registry could disagree with the policy, so
      // naming the registry token here is a defect rather than a detail.
      expect({ runtime, handAssembled: source.includes('DATASOURCE_PROBE_PROVIDERS') }).toEqual({
        runtime,
        handAssembled: false,
      });
    }
  });

  it('keeps the datasource to client binding out of the health engine', () => {
    const engineFile = path.join(src, 'health', 'datasource-health.probe.ts');
    const engine = read(engineFile);
    // Phase CHECK-ISSUATION: the canary list is DERIVED from `health-tokens.ts` itself.
    // The previous hand-written list ended at HR, so a reference to the Commerce,
    // Production or Finance token would not have been flagged — the engine could have
    // re-acquired datasource knowledge one token at a time while this test stayed green.
    // Any `Symbol('..._PRISMA_CLIENT')` declared there is checked automatically.
    const tokenSource = read(path.join(src, 'health', 'health-tokens.ts'));
    const clientTokens = [...tokenSource.matchAll(/Symbol\('([A-Z][A-Z0-9_]*_PRISMA_CLIENT)'\)/g)].map(
      (match) => match[1]
    );
    // Non-vacuity: a rename that breaks the pattern must fail the rule, not empty it.
    expect(clientTokens.length).toBeGreaterThanOrEqual(1);

    // The engine's contract is "probe this datasource, whoever you are". The moment it names
    // a client token it knows which client belongs to which datasource again — and a
    // `switch (datasource)` is how that knowledge used to be written down.
    expect(clientTokens.filter((token) => engine.includes(token))).toEqual([]);
    expect(engine).not.toMatch(/\bswitch\s*\(/);
    expect(engine).toContain('DATASOURCE_PROBE_PROVIDERS');
    expect(importsOf(engineFile).filter((value) => /prisma/i.test(value))).toEqual([]);
  });

  it('declares the datasource to client binding in exactly one place', () => {
    // One declaration, so the binding cannot be half-migrated: a second file naming a client
    // token is a second answer to "which client is this datasource's?".
    const allowed = new Set(['datasource-probe.registry.ts', 'health-tokens.ts']);
    const offenders = filesUnder(path.join(src, 'health'))
      .filter((file) => !allowed.has(path.basename(file)))
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => /_PRISMA_CLIENT/.test(read(file)))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it('reaches datasources through injected tokens, not through a Prisma service', () => {
    // The ARCH-2 gate for "no direct Core Prisma dependency is introduced": only the health
    // MODULES may import a Prisma module (that import IS the instantiation decision the
    // policy controls); every other health file must work through an injected client token.
    const engineFiles = filesUnder(path.join(src, 'health'))
      .filter((file) => !path.basename(file).endsWith('-health.module.ts'))
      .filter((file) => !file.endsWith('.spec.ts'));
    // Phase CHECK-ISSUATION: a PATTERN, not an enumeration. The previous list named five
    // Prisma module files and silently ignored every later one — `production-prisma` and
    // `financial-prisma` were both absent, so a health engine file importing either would
    // have sailed through. Any import resolving to a Prisma module/service file
    // (`database/prisma.module`, `database/cms-prisma.module`,
    // `modules/<x>/database/<x>-prisma.module`, …) is flagged from now on.
    const prismaImport = /(?:^|\/)(?:[\w-]+-)?prisma\.(?:service|module)$/;
    const violations = engineFiles.flatMap((file) =>
      importsOf(file)
        .filter((value) => prismaImport.test(value))
        .map((value) => `${path.basename(file)}: ${value}`)
    );
    expect(violations).toEqual([]);
  });

  it('hosts HR in exactly the runtimes whose policy instantiates it, and in no other root', () => {
    // Phase 51-HR-1 INVERTED this gate, in one place and on purpose. Until HR existed the
    // assertion was "no runtime root may name HR, the health graph may not know it, and the
    // artifacts must not be on disk". HR now exists, so the gate states the boundary that
    // replaced it — derived from the POLICY, never from a hand-written runtime list:
    //
    //   * a runtime marking HR `not-used` (core, cms) may not name HR in its app module or
    //     its health module: it must not reach a datasource its own policy forbids, and both
    //     of those images prune the HR client;
    //   * a runtime that instantiates HR (combined today, future-hr once built) must carry
    //     it, so "HR is not-used everywhere" can never be achieved by wiring HR nowhere.
    const hrImport = /(?:^|\/)(?:modules\/hr|hr-prisma|hr-health\.module)(?:\/|$)/;

    const forbidding = RUNTIME_IDS.filter((runtime) =>
      notUsedDatasources(runtime).includes('HR_DATABASE_URL')
    );
    expect(forbidding).toEqual(['core', 'cms']);

    const rootViolations = forbidding.flatMap((runtime) => {
      const file = path.join(src, RUNTIME_HEALTH_COMPOSITION[runtime].appModuleFile);
      if (!fs.existsSync(file)) return [];
      return importsOf(file)
        .filter((value) => hrImport.test(value))
        .map((value) => `${runtime}: ${value}`);
    });
    const healthViolations = forbidding.flatMap((runtime) =>
      importsOf(path.join(src, RUNTIME_HEALTH_COMPOSITION[runtime].file))
        .filter((value) => hrImport.test(value))
        .map((value) => `${runtime}: ${value}`)
    );
    expect({ rootViolations, healthViolations }).toEqual({
      rootViolations: [],
      healthViolations: [],
    });

    // The composition root is where a business module is served (Option B of the 51-HR
    // audit, the same place Correspondence is registered), and the combined health graph is
    // what binds the HR client. Both halves are asserted, because either one alone leaves a
    // runtime that can serve HR but cannot probe `hr_db`, or the reverse.
    const combinedRootImports = importsOf(path.join(src, 'app.module.ts'));
    const combinedHealthImports = importsOf(path.join(src, 'health', 'combined-health.module.ts'));

    expect(combinedRootImports.some((value) => hrImport.test(value))).toBe(true);
    expect(combinedHealthImports.some((value) => hrImport.test(value))).toBe(true);

    // The artifacts exist now, and `prisma/hr` means a schema and a migration history, not a
    // directory name: a target that never arrived is exactly what the old "absent" assertion
    // could not detect.
    const artifacts = [
      'prisma/hr/schema.prisma',
      'prisma/hr/migrations',
      'src/modules/hr/hr.module.ts',
      'src/modules/hr/database/hr-prisma.module.ts',
      'src/modules/hr/database/hr-prisma.service.ts',
    ];
    expect(artifacts.filter((relative) => fs.existsSync(path.join(root, relative)))).toEqual(
      artifacts
    );

    // Every runtime that exists today either requires HR or is forbidden to see it. Only the
    // standalone HR runtime is still a declared TARGET — no root, no health module, no image
    // (see runtime-policy.spec.ts) — which is a RUNTIME fact, not a datasource one.
    for (const runtime of RUNTIME_IDS) {
      expect({
        runtime,
        requiresHr: requiredDatasources(runtime).includes('HR_DATABASE_URL'),
      }).toEqual({ runtime, requiresHr: runtime !== 'core' && runtime !== 'cms' });
    }
    expect(RUNTIME_HEALTH_COMPOSITION['future-hr'].status).toBe('target');
  });

  it('hosts Commerce in exactly the runtimes whose policy instantiates it, and in no other root', () => {
    // Phase C1 step G: the Commerce twin of the HR gate above, added in the same commit
    // that registers the module — composition and its enforcement land together, exactly
    // as 51-HR-1 did it. Same derivation from the POLICY, for the same reason: "where is
    // Commerce served?" must be an answer the matrix gives, never a list somebody
    // remembers to update.
    //
    //  * a runtime marking Commerce `not-used` (core, cms — and future-hr, which is the
    //    HR-only target) may not name Commerce in its app module or its health module:
    //    those images prune the Commerce client, and a root that named it would boot a
    //    module whose database its own policy forbids;
    //  * the combined runtime instantiates Commerce (`required`) and must carry it, so
    //    "Commerce wired nowhere" can never satisfy the forbidden side by accident.
    const commerceImport = /(?:^|\/)(?:modules\/commerce|commerce-prisma|commerce-health\.module)(?:\/|$)/;

    const forbidding = RUNTIME_IDS.filter((runtime) =>
      notUsedDatasources(runtime).includes('COMMERCE_DATABASE_URL'),
    );
    expect(forbidding).toEqual(['core', 'cms', 'future-hr']);

    // future-hr declares `hr-app.module.ts` / `hr-health.module.ts` as a TARGET that does
    // not exist yet; its ABSENCE is the correct state, so a missing file is skipped — the
    // same guard the HR gate above applies to roots. An EXISTING file is read without
    // exception, which is what makes this a tripwire rather than a comment.
    const rootViolations = forbidding.flatMap((runtime) => {
      const file = path.join(src, RUNTIME_HEALTH_COMPOSITION[runtime].appModuleFile);
      if (!fs.existsSync(file)) return [];
      return importsOf(file)
        .filter((value) => commerceImport.test(value))
        .map((value) => `${runtime}: ${value}`);
    });
    const healthViolations = forbidding.flatMap((runtime) => {
      const file = path.join(src, RUNTIME_HEALTH_COMPOSITION[runtime].file);
      if (!fs.existsSync(file)) return [];
      return importsOf(file)
        .filter((value) => commerceImport.test(value))
        .map((value) => `${runtime}: ${value}`);
    });
    expect({ rootViolations, healthViolations }).toEqual({ rootViolations: [], healthViolations: [] });

    // The positive half, asserted as EXACT import paths on purpose: gate G5 names the
    // MODULE (`CommerceModule` in the composition root), not merely its database module,
    // and the health graph must separately bind the client (`CommercePrismaModule`) — so
    // a regex over "anything commerce" could pass on one of the two wires alone, while
    // these two strings cannot. Either half alone leaves a combined runtime that can
    // serve Commerce but cannot report `commerce_db` ready, or the reverse.
    const combinedRootImports = importsOf(path.join(src, 'app.module.ts'));
    expect(combinedRootImports).toContain('./modules/commerce/commerce.module');
    const combinedHealthImports = importsOf(path.join(src, 'health', 'combined-health.module.ts'));
    expect(combinedHealthImports).toContain('../modules/commerce/database/commerce-prisma.module');

    // Gate G8: C1 must NOT build a standalone Commerce runtime. A root or health module
    // that exists only as files would be invisible to the policy (no runtime declares
    // it), so the tripwire is the files themselves: if they appear, this phase is over
    // and the composition + policy declarations must change FIRST.
    expect(fs.existsSync(path.join(src, 'commerce-app.module.ts'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'health', 'commerce-health.module.ts'))).toBe(false);
  });

  it('has no credential-bearing URL literal in active (non-spec) source', () => {
    // Phase ARCH-2 closed a hard-coded AMQP credential
    // (`amqp://<user>:<password>@rabbitmq:5672`). A comment that DESCRIBES such a fallback is
    // documentation; the same text as a literal is a credential in source. This reads string
    // VALUES from the syntax tree, so it can tell the two apart.
    const active = filesUnder(src).filter((file) => !file.endsWith('.spec.ts'));
    const values = active.flatMap((file) => stringValues(file));
    const credentialUrl =
      /(?:amqp|amqps|redis|rediss|postgres|postgresql):\/\/[^\s'"]*:[^\s'"@/]+@/;

    expect(values.filter((value) => credentialUrl.test(value))).toEqual([]);
    expect(values.filter((value) => value.includes('aria_password'))).toEqual([]);
  });

  it('excludes the JWKS contract path from the global prefix in every bootstrap that sets one', () => {
    // Phase 52-ARCH-3C-R1. `TOKEN_JWKS_PATH` is a contract for OTHER runtimes rather than an API of
    // this one: a verifier points `JWT_JWKS_URI` at `/.well-known/jwks.json` (`.env.example`) and
    // the ingress matches that path exactly (`infrastructure/nginx/conf.d/api.conf`). A bootstrap
    // that sets the `api/v1` prefix WITHOUT excluding it serves the document at
    // `api/v1/.well-known/jwks.json` instead, so the issuer answers 404 at the one URL every
    // verifier is told to use. That was a REAL defect, not a hypothetical one: `main.ts` excluded
    // the path while `core-main.ts` and `cms-main.ts` — Core among them, the runtime that actually
    // issues the tokens — did not.
    //
    // The exclusion must be the CONSTANT, not a re-typed path: `globalPrefixDeclarations` returns
    // each declared value as its source text, so `exclude: ['/.well-known/jwks.json']` fails here
    // even though it would happen to work — the contract has one spelling, and a bootstrap that
    // spells it again is a second copy of the path that nothing keeps in agreement.
    const declaring = filesUnder(src)
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) => ({ file, declarations: globalPrefixDeclarations(file) }))
      .filter(({ declarations }) => declarations.length > 0);

    // Guards the rule against a vacuous pass: if nothing set a prefix any more, the assertion below
    // would be satisfied by having nothing to check.
    expect(declaring.map(({ file }) => path.basename(file)).sort()).toEqual(
      expect.arrayContaining(['main.ts', 'core-main.ts', 'cms-main.ts'])
    );

    const offenders = declaring.flatMap(({ file, declarations }) =>
      declarations
        .filter(({ excludes }) => !excludes.includes('TOKEN_JWKS_PATH'))
        .map(({ prefix, excludes }) => ({ file: path.relative(root, file), prefix, excludes }))
    );

    expect(offenders).toEqual([]);
  });

  // ==========================================================================
  // Phase B3 — CROSS-CONTEXT INTEGRATION POLICY
  //
  // These guards formalize and enforce the bounded-context integration rules:
  //   1. Business modules MUST NOT import from each other's private internals.
  //   2. Cross-context reads MUST go through source-owned contracts/ports.
  //   3. No business module may import another's Prisma service or repository.
  //   4. The approved consumers (Reporting, KPI) may only import through
  //      reporting contracts, constants, and status vocabularies.
  // ==========================================================================

  /**
   * The canonical set of independent business bounded contexts.
   *
   * Each owns its own database, Prisma project, module, and domain logic.
   * Cross-context coupling between these is FORBIDDEN — no direct import
   * of another context's private repositories, services, Prisma modules,
   * or generated clients.
   */
  const BUSINESS_CONTEXTS = [
    'commerce',
    'hr',
    'production',
    'financial',
    'correspondence',
  ] as const;

  it('no business module imports from another business module\'s directory (Phase B3)', () => {
    const violations: { file: string; importsFrom: string; specifier: string }[] = [];

    for (const ctx of BUSINESS_CONTEXTS) {
      const ctxDir = path.join(src, 'modules', ctx);
      if (!fs.existsSync(ctxDir)) continue;

      const ctxFiles = filesUnder(ctxDir).filter((f) => !f.endsWith('.spec.ts'));

      for (const file of ctxFiles) {
        const imports = importsOf(file);
        for (const specifier of imports) {
          // Detect relative imports that reach into another business context's directory.
          // e.g. from '../commerce/...' or '../../modules/hr/...'
          for (const other of BUSINESS_CONTEXTS) {
            if (other === ctx) continue;
            // A relative import that contains `/<other>/` after navigating up
            // from within `modules/<ctx>/` crosses a boundary.
            if (
              specifier.includes(`/${other}/`) ||
              specifier.includes(`../${other}/`) ||
              specifier.startsWith(`../${other}`)
            ) {
              violations.push({
                file: path.relative(src, file),
                importsFrom: other,
                specifier,
              });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('approved cross-context consumers only import contracts, constants, and status vocabularies (Phase B3)', () => {
    // Reporting and KPI are allowed to import from business contexts, but ONLY through
    // approved paths: reporting contracts, reporting modules, constants, and status
    // vocabularies. Never through private repositories, services, or Prisma internals.
    const APPROVED_CONSUMERS = ['reporting', 'kpi-runtime'];
    const violations: { file: string; specifier: string; reason: string }[] = [];

    // Approved import patterns: contracts, constants, status, reporting modules, type-only
    const APPROVED_PATTERNS = [
      /\/reporting\//,           // reporting contract/module paths
      /\.constants$/,            // module constants (MODULE_ID, FEATURE, etc.)
      /\.constants'/,            // ending in .constants'
      /constants$/,              // constants file
      /\/constants/,             // constants directory
      /-status$/,                // status vocabularies
      /-status'/,                // status ending
      /\/bom-status$/,           // BOM status vocabulary
      /\/bom-status'/,           // BOM status ending
      /\/purchase-status$/,      // Purchase status vocabulary
      /\/purchase-status'/,      // Purchase status ending
      /\/check-request-status$/, // Check request status vocabulary
      /\/check-request-status'/, // Check request status ending
      /\/mission-date-time$/,  // HR mission duration-mode vocabulary
      /\/mission-date-time'/,  // HR mission duration-mode ending
      /\/hr-attendance-source$/, // HR attendance source vocabulary
      /\/hr-attendance-source'/, // HR attendance source ending
      /\/return-lifecycle$/, // Return lifecycle state vocabulary
      /\/return-lifecycle'/, // Return lifecycle state ending
    ];

    for (const consumer of APPROVED_CONSUMERS) {
      const consumerDir = path.join(src, 'modules', consumer);
      if (!fs.existsSync(consumerDir)) continue;

      const consumerFiles = filesUnder(consumerDir).filter((f) => !f.endsWith('.spec.ts'));

      for (const file of consumerFiles) {
        const imports = importsOf(file);
        for (const specifier of imports) {
          for (const ctx of BUSINESS_CONTEXTS) {
            if (
              specifier.includes(`/${ctx}/`) ||
              specifier.includes(`../${ctx}/`) ||
              specifier.startsWith(`../${ctx}`)
            ) {
              // This import reaches into a business context — check if it's approved.
              const isApproved = APPROVED_PATTERNS.some((pattern) => pattern.test(specifier));
              if (!isApproved) {
                violations.push({
                  file: path.relative(src, file),
                  specifier,
                  reason: `imports from ${ctx} through a non-approved path`,
                });
              }
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('no business module imports another context\'s Prisma service or generated client (Phase B3)', () => {
    const violations: { file: string; specifier: string }[] = [];

    for (const ctx of BUSINESS_CONTEXTS) {
      const ctxDir = path.join(src, 'modules', ctx);
      if (!fs.existsSync(ctxDir)) continue;

      const ctxFiles = filesUnder(ctxDir).filter((f) => !f.endsWith('.spec.ts'));

      for (const file of ctxFiles) {
        const imports = importsOf(file);
        for (const specifier of imports) {
          for (const other of BUSINESS_CONTEXTS) {
            if (other === ctx) continue;
            // Check if this file imports another context's Prisma service.
            if (
              specifier.includes(`/${other}/database/`) ||
              specifier.includes(`generated/${other}-client`)
            ) {
              violations.push({ file: path.relative(src, file), specifier });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

});
