import { Test } from '@nestjs/testing';
import { ModulePlatformModule } from './module-platform.module';
import { ModuleClient } from './module-client.service';
import { ModuleHealthService } from './module-health.service';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleSweepService } from './module-sweep.service';
import { ModuleHttpTransport } from './module-http.transport';
import { ModuleProvisioningService } from './module-provisioning.service';
import { ModuleProvisioningController } from './module-provisioning.controller';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import { LocalProvisioningProvider } from './local-provisioning.provider';
import { CAPABILITY_CREDENTIAL_RESOLVER } from './capability-credential.resolver';
import { PrismaService } from '../database/prisma.service';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { NotificationPublisher } from '../notifications/notification.publisher';

/**
 * Phase 49M: the module wiring itself.
 *
 * WHY THIS FILE EXISTS: every other spec in this phase constructs its subject with explicit
 * providers, which proves the LOGIC and says nothing about whether `ModulePlatformModule` actually
 * resolves. A missing provider or a circular import would surface only at boot — in a container, in a
 * log nobody is watching. This compiles the real module graph.
 *
 * WHAT IT ALSO ASSERTS, and this is the load-bearing half:
 *
 *  - `ModuleClient` IS EXPORTED and `ModuleRegistryService` IS NOT. That asymmetry is the §24/§35
 *    contract made structural: a business module can CALL, and cannot reach registration,
 *    credentials, admin writes or the sweep even by accident. If somebody later adds the registry to
 *    `exports`, this test fails and they have to justify it. 49M-1's control plane is held to the
 *    same rule: none of its three providers is exported either.
 *  - ARCH-3B ADDS A THIRD EXPORT AND CHANGES NONE OF THE ABOVE. `CAPABILITY_CREDENTIAL_RESOLVER` is
 *    a one-method READ seam rather than the registry, so the asymmetry survives: the identity and
 *    audit transports can ask "the credential for this `(moduleId, capability)` pair, or undefined"
 *    and still cannot admit, rotate, read a tenant scope or sweep. The binding is `useExisting`, so
 *    this spec also pins the identity of the seam to the ONE registry instance — a seam satisfied by
 *    a second, divergent resolver would be an A8 bypass with a plausible-looking shape.
 *  - THE SWEEP TIMER IS UNREF'D. The module is initialised and destroyed; a leaked interval would
 *    hang this run.
 *
 * TWO PROVIDERS ARE STUBBED, both for the same reason — a wiring test must not open a socket:
 *  - `PrismaService`, which would connect to Postgres;
 *  - `NotificationPublisher`, which opens a RabbitMQ connection in its CONSTRUCTOR and is pulled in
 *    transitively by `RbacModule` → `NotificationModule`. That is pre-existing behaviour rather than
 *    anything this phase introduced, but leaving it live would make this file hold the Jest worker
 *    open and mask a real leak later.
 * Everything else — `RolesGuard`, `PermissionService`, `AuditService`, `CryptoService` — resolves for
 * real, which is the point.
 */

describe('ModulePlatformModule wiring', () => {
  const prismaStub = {
    moduleRegistration: {},
    moduleInstance: {},
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const publisherStub = { publish: jest.fn().mockResolvedValue(undefined) };

  const build = () =>
    Test.createTestingModule({ imports: [ModulePlatformModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(NotificationPublisher)
      .useValue(publisherStub)
      .compile();

  it('resolves every provider in the real module graph', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(ModuleRegistryService)).toBeInstanceOf(ModuleRegistryService);
    expect(moduleRef.get(ModuleHealthService)).toBeInstanceOf(ModuleHealthService);
    expect(moduleRef.get(ModuleClient)).toBeInstanceOf(ModuleClient);
    expect(moduleRef.get(ModuleSweepService)).toBeInstanceOf(ModuleSweepService);
    expect(moduleRef.get(ModuleHttpTransport)).toBeInstanceOf(ModuleHttpTransport);

    // 49M-1. The control plane resolves in the SAME graph, which is the claim that a
    // separate ModuleProvisioningModule would have needed a circular import to make.
    expect(moduleRef.get(ModuleProvisioningService)).toBeInstanceOf(ModuleProvisioningService);
    expect(moduleRef.get(ProvisioningProviderRegistry)).toBeInstanceOf(
      ProvisioningProviderRegistry
    );
    expect(moduleRef.get(LocalProvisioningProvider)).toBeInstanceOf(LocalProvisioningProvider);

    await moduleRef.close();
  });

  it('resolves the local provider THROUGH the registry, never by direct injection', async () => {
    // The seam: ModuleProvisioningService depends on the registry only. If it ever injected a
    // provider class directly, the control plane would stop being provider-neutral.
    const moduleRef = await build();

    const registry = moduleRef.get(ProvisioningProviderRegistry);

    expect(registry.resolve('LOCAL_SERVER')).toBe(moduleRef.get(LocalProvisioningProvider));
    expect(registry.resolve('REMOTE_AGENT')).toBeUndefined();

    await moduleRef.close();
  });

  it('starts and stops without leaking the sweep timer', async () => {
    const moduleRef = await build();

    // `init()` runs OnModuleInit, which starts the interval; `close()` runs OnModuleDestroy. A
    // non-unref'd or uncleared timer would keep this Jest worker alive.
    const app = await moduleRef.init();
    await app.close();

    expect(app).toBeDefined();
  });

  it('EXPORTS the client, the health service and the one-method resolver seam — NOT the registry', () => {
    // Read off the module metadata rather than inferred from behaviour, so the assertion is about the
    // declared seam. A business module importing ModulePlatformModule gets exactly these three.
    const exported = Reflect.getMetadata('exports', ModulePlatformModule) as unknown[];

    expect(exported).toContain(ModuleClient);
    expect(exported).toContain(ModuleHealthService);

    // ARCH-3B's ONE addition, and the reason it is not the registry: the platform transports need a
    // single READ — "the plaintext credential for this `(moduleId, capability)` pair, or undefined".
    // Exporting `ModuleRegistryService` to satisfy that would have handed every importer admission,
    // credential rotation, tenant-scope reads and the sweep, which is precisely the asymmetry the
    // absences below exist to preserve.
    expect(exported).toContain(CAPABILITY_CREDENTIAL_RESOLVER);

    // THE IMPORTANT ABSENCES.
    expect(exported).not.toContain(ModuleRegistryService);
    expect(exported).not.toContain(ModuleSweepService);
    expect(exported).not.toContain(ModuleHttpTransport);

    // 49M-1 ADDS NOTHING TO `exports`, for the reason the registry is not exported: a business
    // module that could reach the provisioning service could redeploy or decommission another
    // module. The control plane is reachable only through its permission-gated controller.
    expect(exported).not.toContain(ModuleProvisioningService);
    expect(exported).not.toContain(ProvisioningProviderRegistry);
    expect(exported).not.toContain(LocalProvisioningProvider);
    expect(exported).toHaveLength(3);
  });

  it('binds the resolver seam to the ONE registry instance, so a second resolver cannot appear', async () => {
    const moduleRef = await build();

    // The module uses `useExisting`, not `useClass`. A `useClass` would compile, resolve and pass
    // every other assertion in this file while answering from a SECOND resolver — a divergent
    // credential source wearing the approved interface's shape, which is what an A8 bypass looks like
    // from the outside. So the claim asserted here is identity, not type.
    expect(moduleRef.get(CAPABILITY_CREDENTIAL_RESOLVER)).toBe(
      moduleRef.get(ModuleRegistryService)
    );

    await moduleRef.close();
  });

  it('registers the provisioning controller alongside the two registry controllers', () => {
    const controllers = Reflect.getMetadata('controllers', ModulePlatformModule) as unknown[];

    expect(controllers).toContain(ModuleProvisioningController);
    expect(controllers).toHaveLength(3);
  });

  it('imports only Prisma and RBAC — no business module, and no IntegrationsModule', () => {
    // 49M reuses 49L's signature and URL primitives as pure FUNCTIONS, not as providers, so there is
    // deliberately no module-level dependency in either direction.
    const imports = Reflect.getMetadata('imports', ModulePlatformModule) as unknown[];

    expect(imports).toEqual([PrismaModule, RbacModule]);
  });
});
