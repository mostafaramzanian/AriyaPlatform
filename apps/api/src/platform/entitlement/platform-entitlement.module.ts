import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { RbacModule } from '../../auth/rbac/rbac.module';
import { ENTITLEMENT_PORT } from './entitlement.contract';
import { ModuleFeatureController } from './module-feature.controller';
import { ModuleFeatureService } from './module-feature.service';
import { PlatformEntitlementService } from './platform-entitlement.service';

/**
 * Phase 54-C (D14, §43.4): the platform's ENTITLEMENT seam.
 *
 * WHAT IT EXPORTS, AND WHAT THAT DELIBERATELY EXCLUDES
 * ---------------------------------------------------
 * Only the PORT TOKEN. `PlatformEntitlementService` and `ModuleFeatureService` stay
 * module-private, so no consumer can reach a concrete class and each half of the surface — the §43.2
 * decision and the §43.8 admin writes — has exactly one implementation. The port is what a consumer
 * binds; the writes are what it can never reach.
 *
 * WHY `RbacModule` IS IMPORTED HERE (D14, §43.8)
 * ---------------------------------------------
 * The feature controller answers under `admin/modules/**`, so it needs the same two things the
 * registry controller needs: `RolesGuard`, which enforces `@Roles(...)` on every route, and
 * `AuditService`, which writes the `module.feature.*` mutation trail. Both are provided by
 * `RbacModule` — the very import `module-platform.module.ts` already makes for its own admin surface.
 * This adds no coupling a consumer did not already have: `HrModule` imports `RbacModule` for its `hr.*`
 * permission gates.
 *
 * `ModuleEntitlementGuard` is NOT exported either, and that is not an oversight: §43.6 has the
 * owning module list it in `providers` (`HrModule.providers`), and Nest instantiates a guard in
 * the module that declares it. HR therefore needs two things it can get — the guard CLASS
 * (an import from a controller file, which §43.6 explicitly allows) and the `ENTITLEMENT_PORT`
 * token (exported here) — plus `Reflector`, which Nest provides globally. Exporting the guard
 * from here as well would work, but it would make HR's dependency on the platform look like a
 * platform provider it must import rather than a gate it applies, and the wiring is written to
 * be readable exactly as §43.6 describes it.
 *
 * `useExisting` rather than `useClass`, the same choice `platform-audit.module.ts` and
 * `module-platform.module.ts` already make, and for the same reason: one instance, one resolver,
 * so there is no second copy of the decision logic to drift.
 *
 * IF THE PORT IS NOT PROVIDED in a module that applies the guard, Nest fails at BOOT rather than
 * at request time — the guard injects the token with no `@Optional()`. That is deliberate: a
 * misconfigured deployment must not start and then refuse, nor start and then allow.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [ModuleFeatureController],
  providers: [
    PlatformEntitlementService,
    ModuleFeatureService,
    { provide: ENTITLEMENT_PORT, useExisting: PlatformEntitlementService },
  ],
  exports: [ENTITLEMENT_PORT],
})
export class PlatformEntitlementModule {}
