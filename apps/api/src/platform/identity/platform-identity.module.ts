import { Module } from '@nestjs/common';
import { ModulePlatformModule } from '../../module-platform/module-platform.module';
import { UserDirectoryModule } from '../user-directory/user-directory.module';
import { PlatformIdentityController } from './platform-identity.controller';

/**
 * Phase ARCH-3B (§7/§8): the `platform.identity@v1` transport, owned by Core.
 *
 * WHY THIS IS A PLATFORM MODULE AND NOT PART OF `ModulePlatformModule`
 * -------------------------------------------------------------------
 * The two are different halves of the same ADR and different kinds of thing.
 * `ModulePlatformModule` owns the REGISTRY: which modules exist, what they may reach, what
 * credential they hold. This module is one CONSUMER of that registry — it answers identity
 * questions for a module that has already been admitted. Folding it in would put a business
 * question ("who is this person?") inside the control plane, and the control plane's own test
 * (`module-platform.module.spec.ts`) asserts that it exports no business surface.
 *
 * WHAT IT IMPORTS, AND WHY EACH IS LOAD-BEARING
 * ---------------------------------------------
 * `ModulePlatformModule` — for `CAPABILITY_CREDENTIAL_RESOLVER` ONLY. That is the token the
 * controller injects, and it is deliberately the narrowest seam in the repository: one method,
 * `resolveCapabilityCredential(moduleId, capability)`, returning a plaintext or `undefined`.
 * This module therefore cannot admit a module, rotate a module-hop credential, read a tenant
 * scope or run the sweep. Exporting `ModuleRegistryService` would have given it all four.
 *
 * `UserDirectoryModule` — for TENANT AUTHORITY. A7 is explicit that the signed `tid` "never
 * substitutes for Core's own membership check", so this transport does not decide whether an id
 * belongs to a tenant: it asks Core's own port, which is the same implementation every other
 * consumer uses. There is no second membership rule anywhere in this folder.
 *
 * IT IMPORTS NO PRISMA MODULE ITSELF, AND CANNOT INJECT ONE. `UserDirectoryModule` does import
 * Core's `PrismaModule` — the adapter has to reach `core_db` to answer at all — but it re-exports
 * ONLY the `USER_DIRECTORY` token, so the handle is present in this graph and is NOT reachable from
 * here: `PlatformIdentityController` has no way to obtain `PrismaService`, and
 * `platform-identity.module.spec.ts` asserts exactly that. The transport therefore cannot query a
 * table even by accident, which is what makes the controller's allowlist claim enforceable rather
 * than aspirational.
 *
 * NOTHING IS EXPORTED. The controller is a route group and the surface ends here: this module
 * exists to expose `/platform/v1/identity` to a signed caller, not to offer convenience methods
 * to Nest-internal consumers. An in-process consumer already has `USER_DIRECTORY` directly,
 * which is cheaper and needs no HMAC (`HrIdentityGateway` is exactly that consumer).
 */
@Module({
  imports: [ModulePlatformModule, UserDirectoryModule],
  controllers: [PlatformIdentityController],
})
export class PlatformIdentityModule {}
