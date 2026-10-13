import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { PrismaModule } from '../database/prisma.module';
import { CoreTenantResolver } from './core-tenant-resolver';
import { TenantResolver } from '../platform/auth/tenant-resolver.contract';

/**
 * Phase 51-HR-ARCH-3A: the tenant seam.
 *
 * `CoreTenantResolver` is Core's implementation, bound to the PORT token so that the
 * consumer (`TenantContextInterceptor`, registered globally in every runtime) depends on
 * `TenantResolver` and never on Core's Prisma client. A runtime with no Core database — the
 * standalone HR runtime this work is a prerequisite for — binds `ClaimsTenantResolver`
 * (platform/auth) here instead, and its interceptor code is unchanged.
 *
 * `useExisting` rather than `useClass`, matching `UserDirectoryModule`'s precedent: the
 * resolver holds a Prisma client, and registering a second instance to answer the same
 * question would double a connection-pool consumer for no benefit.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    TenantService,
    CoreTenantResolver,
    { provide: TenantResolver, useExisting: CoreTenantResolver },
  ],
  exports: [TenantService, TenantResolver],
})
export class TenantModule {}
