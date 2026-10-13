import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { AI_GATEWAY } from '../platform/ai/ai-gateway.contract';
import { PlatformAIModule } from '../platform/ai/platform-ai.module';

/**
 * Phase AI-ARCH-HARDENING (§29): the AI boundary gates.
 *
 * Every rule here is a regression guard for a debt this phase closed; each one is
 * violated by a plausible future edit, which is what makes it worth asserting:
 *
 *   1. business modules cannot import the AI runtime/configuration (`src/ai/**`) —
 *      the seam for them is the AI gateway contract (`src/platform/ai/**`);
 *   2. search consumes the gateway contract only, never `src/ai` — this is what
 *      keeps "Search → AI embedding" a consumer of a CONTRACT;
 *   3. provider adapters cannot depend on Prisma, persistence, business modules or
 *      the platform/consumer layer;
 *   4. the gateway cannot depend on business modules or concrete provider classes
 *      (it resolves adapters through the registry, not by import);
 *   5. provider adapters know no actor/tenant semantics;
 *   6. exactly ONE AI abstraction exists in the repository: `packages/ai` (the
 *      Phase-A artifact) must stay deleted, and no source may import it;
 *   7. reporting — the first `src/modules/**` consumer of the seam — cannot
 *      reach AI configuration, provider classes, credentials, Core persistence
 *      or environment variables;
 *   8. `PlatformAIModule` exports the `AI_GATEWAY` token and nothing else;
 *   9. the gateway contract still exposes exactly the one capability that has a
 *      real implementation (`embed`), so no consumer can target a stub.
 *
 * The parsing helpers mirror `architecture-boundaries.spec.ts`: imports are read
 * from the SYNTAX TREE, so a mention inside a comment cannot trip a rule.
 */

const root = path.resolve(__dirname, '../..'); // apps/api
const src = path.join(root, 'src');
const repoRoot = path.resolve(root, '..', '..'); // repository root
const aiDir = path.join(src, 'ai');
const gatewayDir = path.join(src, 'platform', 'ai');
const reportingDir = path.join(src, 'modules', 'reporting');

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

/** Resolves a relative specifier to an absolute path; null for non-relative imports. */
const resolveRelative = (file: string, specifier: string): string | null =>
  specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null;

/** True when the resolved import lands inside `directory`. */
const landsIn = (file: string, specifier: string, directory: string): boolean => {
  const resolved = resolveRelative(file, specifier);
  return resolved !== null && (resolved === directory || resolved.startsWith(directory + path.sep));
};

/**
 * True when a file reads `process.env`, detected on member ACCESS rather than on
 * text: a comment that names an environment variable is documentation, and the
 * distinction is the same one `stringValues` in `architecture-boundaries.spec.ts`
 * draws. Reads inside comments do not count; reads in code do.
 */
function readsProcessEnv(file: string): boolean {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env'
    ) {
      found = true;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

/** The member NAMES an interface declares, read from the AST (comments cannot trip it). */
function interfaceMembersOf(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name
  );

  return (declaration?.members ?? []).flatMap((member) => {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) return [];
    return ts.isIdentifier(member.name) ? [member.name.text] : [];
  });
}

const ADAPTERS = ['openai.provider.ts', 'azure-openai.provider.ts', 'claude.provider.ts', 'local-llm.provider.ts'].map(
  (name) => path.join(aiDir, name)
);

describe('AI architecture boundaries (AI-ARCH-HARDENING §29)', () => {
  it('business modules never import the AI runtime/configuration', () => {
    const offenders = filesUnder(path.join(src, 'modules'))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => landsIn(file, specifier, aiDir))
          .map((specifier) => `${path.relative(src, file)} → ${specifier}`)
      );

    expect(offenders).toEqual([]);
  });

  it('search consumes the AI gateway contract only — never src/ai', () => {
    const searchTrees = [path.join(src, 'search'), path.join(src, 'platform', 'search-source')];
    const offenders = searchTrees
      .flatMap((tree) => filesUnder(tree))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => landsIn(file, specifier, aiDir))
          .map((specifier) => `${path.relative(src, file)} → ${specifier}`)
      );

    expect(offenders).toEqual([]);
  });

  it('search actually wires the AI_GATEWAY token (the seam cannot rot silently)', () => {
    for (const file of [
      path.join(src, 'search', 'search.service.ts'),
      path.join(src, 'platform', 'search-source', 'search-embedding.service.ts'),
    ]) {
      expect(read(file)).toContain('AI_GATEWAY');
    }
  });

  it('provider adapters never depend on Prisma, persistence, business modules or the platform', () => {
    const forbiddenRoots = [
      path.join(src, 'database'),
      path.join(src, 'modules'),
      path.join(src, 'search'),
      path.join(src, 'platform'),
      path.join(src, 'generated'),
    ];

    for (const adapter of ADAPTERS) {
      const offending = importsOf(adapter).filter((specifier) => {
        if (specifier.includes('prisma')) return true;
        const resolved = resolveRelative(adapter, specifier);
        return resolved !== null && forbiddenRoots.some((dir) => resolved.startsWith(dir + path.sep));
      });

      expect({ adapter: path.basename(adapter), offending }).toEqual({
        adapter: path.basename(adapter),
        offending: [],
      });
    }
  });

  it('the AI gateway never depends on business modules or concrete provider classes', () => {
    const concreteProviders = [
      'openai.provider',
      'azure-openai.provider',
      'claude.provider',
      'local-llm.provider',
    ];

    for (const file of filesUnder(gatewayDir)) {
      const specs = importsOf(file);

      const importsBusiness = specs.filter((specifier) => {
        const resolved = resolveRelative(file, specifier);
        return resolved !== null && resolved.startsWith(path.join(src, 'modules') + path.sep);
      });

      const importsConcreteProvider = specs.filter((specifier) =>
        concreteProviders.some((name) => specifier.endsWith(name))
      );

      expect({ file: path.relative(src, file), importsBusiness, importsConcreteProvider }).toEqual({
        file: path.relative(src, file),
        importsBusiness: [],
        importsConcreteProvider: [],
      });
    }
  });

  it('provider adapters know no actor/tenant business semantics', () => {
    // The adapter receives input + effective config; identity is the caller's and
    // the resolver's business, never the adapter's.
    const offenders = ADAPTERS.filter((file) => /(tenantId|actorId)/.test(read(file)));

    expect(offenders.map((file) => path.basename(file))).toEqual([]);
  });

  it('exactly one AI abstraction exists: packages/ai stays deleted', () => {
    // The Phase-A `packages/ai` contract was proven dead (zero tracked consumers)
    // and removed in this phase. Two parallel AI contracts is the drift this rule
    // exists to prevent.
    expect(fs.existsSync(path.join(repoRoot, 'packages', 'ai'))).toBe(false);

    const importers = [src, path.join(repoRoot, 'apps', 'web', 'src')]
      .flatMap((tree) => filesUnder(tree))
      .filter((file) => importsOf(file).some((specifier) => specifier.includes('packages/ai')));

    expect(importers).toEqual([]);
  });

  /**
   * Phase REPORTING-AI-CONSUMER: the first `src/modules/**` consumer of the seam.
   *
   * The generic gate above already forbids `src/ai/**` from business modules. The
   * rules below exist because the forbidden surface is WIDER than `src/ai`: the
   * credential helper, Core persistence and the generated AI-config client are
   * separate doors to the same secret, and a provider SDK is a fourth one that a
   * type-level seam alone would not stop.
   *
   * Spec files are excluded from the source audits: a wiring spec stubs
   * `PrismaService`/`NotificationPublisher` to compile the module graph without
   * opening sockets — the technique `reporting.module.spec.ts` and
   * `platform-identity.module.spec.ts` share — and that stub import is a test
   * concern, not a production dependency. What the architecture governs is what
   * Reporting SOURCES can obtain.
   */
  it('reporting cannot reach AI configuration, providers, credentials or persistence', () => {
    const forbiddenDirectories = [aiDir, path.join(src, 'database'), path.join(src, 'generated')];
    const forbiddenFiles = [path.join(src, 'common', 'crypto.service')];
    // The provider SDKs of the providers this platform abstracts. None is a
    // dependency today — that is the point: adding one would pull a provider's
    // transport into business code through a door the path rules cannot see.
    const forbiddenSdkSpecifiers = [
      /^openai$/,
      /^@azure\/openai$/,
      /^@anthropic-ai\/sdk$/,
      /^ollama$/,
    ];

    const offenders = filesUnder(reportingDir)
      .filter((file) => !file.endsWith('.spec.ts'))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => {
            const resolved = resolveRelative(file, specifier);
            const landsInForbiddenDirectory =
              resolved !== null &&
              forbiddenDirectories.some(
                (directory) => resolved === directory || resolved.startsWith(directory + path.sep)
              );

            return (
              landsInForbiddenDirectory ||
              forbiddenFiles.includes(resolved ?? '') ||
              forbiddenSdkSpecifiers.some((pattern) => pattern.test(specifier))
            );
          })
          .map((specifier) => `${path.relative(src, file)} → ${specifier}`)
      );

    expect(offenders).toEqual([]);
  });

  it('reporting reads no environment variables (credentials and provider configuration are platform concerns)', () => {
    const offenders = filesUnder(reportingDir)
      .filter((file) => !file.endsWith('.spec.ts') && readsProcessEnv(file))
      .map((file) => path.relative(src, file));

    expect(offenders).toEqual([]);
  });

  it('reporting actually wires PlatformAIModule (the seam cannot rot silently)', () => {
    const moduleFile = path.join(reportingDir, 'reporting.module.ts');

    // The text check mirrors the search gate above; the AST check is the precise
    // half — the import must LAND IN the platform AI directory, so a mention in a
    // comment cannot satisfy it.
    expect(read(moduleFile)).toContain('PlatformAIModule');
    expect(
      importsOf(moduleFile).some((specifier) => landsIn(moduleFile, specifier, gatewayDir))
    ).toBe(true);
  });

  it('PlatformAIModule exports the AI_GATEWAY token and nothing else', () => {
    // The claim the module's own documentation makes, made executable: it is what
    // keeps the seam one token wide. The day an export is added, every business
    // consumer that imports this module gains that surface too.
    const exported = Reflect.getMetadata('exports', PlatformAIModule) as unknown[] | undefined;

    expect(exported).toEqual([AI_GATEWAY]);
  });

  it('the gateway contract still exposes exactly the one implemented capability', () => {
    // Capability honesty, executable: every TEXT_GENERATION cell in the registry
    // matrix is false and the gateway has no `generateText()`. Adding one to the
    // CONTRACT ahead of a real implementation would let a consumer target a
    // method that throws — or worse, invite a stub. This gate fails on the way
    // in; the phase that adds a real capability updates it deliberately.
    expect(
      interfaceMembersOf(path.join(gatewayDir, 'ai-gateway.contract.ts'), 'AIGatewayContract')
    ).toEqual(['embed']);
  });
});
