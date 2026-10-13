/**
 * RBAC Module
 * Configures role-based access control for the application
 */

import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { NotificationModule } from '../../notifications/notification.module';
import { PrismaModule } from '../../database/prisma.module';
import { RolesGuard } from './guards/roles.guard';
import { CorePermissionSource } from './services/core-permission-source';
import { PermissionSource } from '../../platform/auth/permission-source.contract';
import { PermissionService } from './services/permission.service';
import { RoleService } from './services/role.service';
import { HierarchyValidationService } from './services/hierarchy-validation.service';
import { RbacController } from './rbac.controller';
import { AuditService } from '../../common/audit.service';
import { DevelopmentRbacController } from './development-rbac.controller';
import { DevRbacCompatController } from './dev-rbac-compat.controller';

const isDevelopment =
  process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

@Module({
  imports: [PrismaModule, CacheModule.register(), NotificationModule],
  controllers: [
    RbacController,
    ...(isDevelopment ? [DevelopmentRbacController, DevRbacCompatController] : []),
  ],
  providers: [
    RolesGuard,
    PermissionService,
    // Phase 51-HR-ARCH-3A: Core's binding of the permission port. `RolesGuard` (a global
    // APP_GUARD) injects `PermissionSource`; this is the implementation the combined
    // runtime uses, because it still serves legacy tokens. A runtime with no Core database
    // binds `TokenPermissionSource` (platform/auth) instead.
    CorePermissionSource,
    { provide: PermissionSource, useExisting: CorePermissionSource },
    RoleService,
    AuditService,
    HierarchyValidationService,
  ],
  exports: [
    RolesGuard,
    PermissionService,
    PermissionSource,
    RoleService,
    AuditService,
    HierarchyValidationService,
  ],
})
export class RbacModule {}
