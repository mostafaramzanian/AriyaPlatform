import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PlatformIdentityModule } from './platform-identity.module';
import { PlatformIdentityController } from './platform-identity.controller';
import { ModulePlatformModule } from '../../module-platform/module-platform.module';
import { ModuleRegistryService } from '../../module-platform/module-registry.service';
import { UserDirectoryModule } from '../user-directory/user-directory.module';
import { USER_DIRECTORY } from '../user-directory/user-directory.contract';
import { PrismaService } from '../../database/prisma.service';
import { NotificationPublisher } from '../../notifications/notification.publisher';
import { IDENTITY_OPERATIONS, IDENTITY_ROUTE_PREFIX } from './identity.contract';

/**
 * Phase ARCH-3B (§7/§8): the WIRING of the `platform.identity@v1` transport.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM THE CONTROLLER SPEC
 * --------------------------------------------------------
 * `platform-identity.controller.spec.ts` builds its subject with explicit providers, which proves
 * the LOGIC and says nothing about whether `PlatformIdentityModule` resolves or where it is
 * mounted. Both failures are boot-time failures: a missing provider throws in a container, and a
 * module nobody imports produces a route group that simply does not exist — the second is the
 * worse one, because the code, the tests and the ADR would all look correct while a separate
 * runtime got 404 for every call.
 *
 * So this file asserts four things the controller spec cannot:
 *
 *  1. THE REAL GRAPH RESOLVES, controller and port included.
 *  2. THE DECLARED SEAM IS WHAT IT CLAIMS: nothing is exported, so the surface really does end at
 *     the route group and no Nest-internal consumer can bypass the HMAC by importing this module.
 *  3. BOTH COMPOSITION ROOTS REGISTER IT. `AppModule` and `CoreAppModule` are read as source,
 *     because "it is registered in the combined runtime too" is exactly the claim that silently
 *     rots when one of the two files is edited.
 *  4. THE TRANSPORT CANNOT REACH THE CONTROL PLANE OR THE DATABASE. The controller may name the
 *     one-method resolver and the port; it may not name `ModuleRegistryService` (which would give
 *     it credential rotation) or `PrismaService` (which would let it query a table directly and
 *     bypass the allowlist).
 */

const SRC = path.resolve(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(file, 'utf8');

/**
 * One property of the controller's PROTOTYPE, typed.
 *
 * Nest stores route and `Public()` metadata on the prototype, and `PlatformIdentityController` declares
 * an index signature for none of it, so a cast is unavoidable. It is made ONCE here, through `unknown`,
 * rather than as `any` at each read: an `any` would also silence a typo in a property NAME, which is
 * the one mistake these two assertions are supposed to catch.
 */
const prototypeOf = (name: string): object =>
  (PlatformIdentityController.prototype as unknown as Record<string, object>)[name];

/** Import specifiers, read off the AST — see the import-graph test for why raw text is not enough. */
const importsOf = (file: string): string[] => {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : []
  );
};

describe('PlatformIdentityModule wiring', () => {
  /**
   * Two stubs, both for the same reason — a wiring test must not open a socket:
   *  - `PrismaService`, which would connect to Postgres;
   *  - `NotificationPublisher`, which opens a RabbitMQ connection in its CONSTRUCTOR and arrives
   *    transitively through `ModulePlatformModule` → `RbacModule` → `NotificationModule`. That is
   *    pre-existing behaviour rather than anything this phase introduced, but leaving it live would
   *    hold the Jest worker open and mask a real leak later.
   * Everything else — `CryptoService`, `RolesGuard`, the resolver, the directory adapter — resolves
   * for real, which is the point.
   */
  const prismaStub = {
    moduleRegistration: {},
    moduleCapabilityCredential: {},
    user: {},
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const publisherStub = { publish: jest.fn().mockResolvedValue(undefined) };

  const build = () =>
    Test.createTestingModule({ imports: [PlatformIdentityModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(NotificationPublisher)
      .useValue(publisherStub)
      .compile();

  it('resolves the real module graph, controller and port included', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(PlatformIdentityController)).toBeInstanceOf(PlatformIdentityController);
    // The port is resolvable FROM HERE because `UserDirectoryModule` exports it; that is the same
    // binding an in-process consumer receives, so the transport and `HrIdentityGateway` cannot drift
    // into two different identity implementations.
    expect(moduleRef.get(USER_DIRECTORY)).toBeDefined();

    await moduleRef.close();
  });

  it('cannot inject the registry or a Prisma handle, because neither is reachable', async () => {
    const moduleRef = await build();

    // Nest resolves a provider by walking the module's own scope and its imports' exports. Both of
    // these must be absent, and the assertion is on the RESOLUTION rather than on the imports list,
    // because "it is not imported" is not the same claim as "it cannot be obtained".
    expect(() => moduleRef.get(ModuleRegistryService, { strict: true })).toThrow();
    expect(() => moduleRef.get(PrismaService, { strict: true })).toThrow();

    await moduleRef.close();
  });

  it('EXPORTS nothing, so the surface ends at the route group', () => {
    // An exported controller or port would let a Nest-internal consumer reach identity answers
    // WITHOUT a credential, which is the one thing the ADR forbids: the HMAC is not optional
    // decoration, it is the authorization edge.
    const exported = Reflect.getMetadata('exports', PlatformIdentityModule) as
      unknown[] | undefined;

    expect(exported ?? []).toHaveLength(0);
    expect(exported ?? []).not.toContain(USER_DIRECTORY);
  });

  it('declares one controller and exactly the two load-bearing imports', () => {
    expect(Reflect.getMetadata('controllers', PlatformIdentityModule)).toEqual([
      PlatformIdentityController,
    ]);
    // `ModulePlatformModule` for the one-method credential seam, `UserDirectoryModule` for tenant
    // authority. Nothing else: no business module, no observability module, no second database.
    expect(Reflect.getMetadata('imports', PlatformIdentityModule)).toEqual([
      ModulePlatformModule,
      UserDirectoryModule,
    ]);
  });

  it('is registered in BOTH composition roots', () => {
    // The combined runtime and the Core-only runtime must expose the same route group: a business
    // runtime cannot be asked to care which deployable answered it. Read as source, because this is
    // a statement about two files rather than about one runtime.
    for (const root of ['app.module.ts', 'core-app.module.ts']) {
      const source = read(path.join(SRC, root));

      expect(source).toContain(
        "import { PlatformIdentityModule } from './platform/identity/platform-identity.module';"
      );
      expect(source).toMatch(/^ {4}PlatformIdentityModule,$/m);
    }
  });

  it('is mounted at the ADR route group, with exactly the four approved operations', () => {
    const mounted = Reflect.getMetadata(PATH_METADATA, PlatformIdentityController) as string;

    // The mount is the ADR's own constant rather than a string that could drift from it, and it is
    // deliberately the `platform/v1` half only: the `api/v1` half comes from the global prefix.
    expect(mounted).toBe(IDENTITY_ROUTE_PREFIX.slice(1));

    const handlers = Object.getOwnPropertyNames(PlatformIdentityController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, prototypeOf(name))
    );

    // THE CLOSED SET. A fifth route is A7's "@v2 event", so this fails on the way in rather than in
    // review: the handler names are compared against the ADR's own list.
    expect(handlers.sort()).toEqual([...IDENTITY_OPERATIONS].sort());
  });

  it('marks every route Public, because the credential is the authorization edge', () => {
    // `isPublic` is the key `Public()` writes and `JwtAuthGuard` consults. A route that lost the
    // decorator would be gated by a JWT no machine caller can present, so it is asserted per route
    // rather than on the class.
    for (const operation of IDENTITY_OPERATIONS) {
      const handler = prototypeOf(operation);

      expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
    }
  });

  it('imports the control plane only through the one-method resolver, and no database at all', () => {
    // ASSERTED ON THE IMPORT GRAPH, not on the file's text: the controller's own documentation
    // NAMES `ModuleRegistryService` in order to explain why it is not injected, and a text search
    // would flag the explanation instead of the dependency. The question here is what the module can
    // OBTAIN, which is what the imports answer.
    const files = ['platform-identity.controller.ts', 'platform-identity.module.ts'].map((file) =>
      path.join(SRC, 'platform', 'identity', file)
    );

    for (const file of files) {
      const imports = importsOf(file);

      // Admission, credential rotation, tenant-scope reads and the sweep all live behind this
      // service. Reaching it would make the transport able to mint what it authenticates against.
      expect(imports).not.toContain('../../module-platform/module-registry.service');
      // No database import anywhere: a query is not merely unimplemented, it is unreachable.
      expect(imports.filter((value) => /prisma|database/i.test(value))).toEqual([]);
    }

    // And the positive half — the three imports that ARE load-bearing.
    const [controller] = files.map(importsOf);

    expect(controller).toContain('../../module-platform/capability-credential.resolver');
    expect(controller).toContain('../../module-platform/module-signature');
    expect(controller).toContain('../user-directory/user-directory.contract');
  });
});
