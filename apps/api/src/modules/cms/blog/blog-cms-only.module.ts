import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogRepository } from './blog.repository';
import { CmsPrismaModule } from '../../../database/cms-prisma.module';
import { CacheModule } from '@nestjs/cache-manager';
import { CmsNotificationModule } from '../../../notifications/cms-notification.module';
import { CacheService } from '../../../common/cache.service';
import { RequestContextService } from '../../../common/request-context.service';

/**
 * Phase 33K: CMS-only composition of the Blog feature, used by the standalone
 * CMS process (cms-main.ts / CmsAppModule).
 *
 * Unlike the combined-app BlogModule (blog.module.ts), this module does NOT
 * import PrismaModule (Core) and does NOT provide AuditService. BlogService's
 * `auditService` param is @Optional(), so it resolves to `undefined` here —
 * Blog's own persistence (CmsPrismaService) and business logic never touch
 * Core's database. This proves CMS's OWN domain logic has zero Core DB
 * dependency once decoupled from Audit.
 *
 * NOTE: this does not by itself make the CMS process boot without Core DB
 * reachability — see CmsAppModule, which still imports AuthModule (global
 * JwtAuthGuard/RolesGuard) for request authentication/authorization. That is
 * a separate, pre-existing Identity/RBAC dependency on Core's database
 * (JwtStrategy validates tokenVersion via Core `User`; PermissionService
 * reads Core `Role`/`Permission`), unrelated to Audit, and out of scope to
 * redesign in this phase (see Phase 33K report, "Audit Dependency Analysis").
 */
@Module({
  imports: [CmsPrismaModule, CacheModule.register(), CmsNotificationModule],
  controllers: [BlogController],
  providers: [BlogService, BlogRepository, CacheService, RequestContextService],
  exports: [BlogService],
})
export class CmsOnlyBlogModule {}
