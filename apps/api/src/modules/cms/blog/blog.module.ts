import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogRepository } from './blog.repository';
import { CmsPrismaModule } from '../../../database/cms-prisma.module';
import { CacheModule } from '@nestjs/cache-manager';
import { NotificationModule } from '../../../notifications/notification.module';
import { CacheService } from '../../../common/cache.service';
import { RequestContextService } from '../../../common/request-context.service';
import { AuditService } from '../../../common/audit.service';
// NOTE (Phase 33J): PrismaModule (Core) is imported here ONLY so the shared,
// RB-03-approved AuditService capability can resolve its Core PrismaService
// dependency (AuditService writes to Core-owned AuditLog/AuditDispatch).
// BlogRepository — CMS's actual business data access — exclusively uses
// CmsPrismaModule/CmsPrismaService below; it never touches PrismaModule.
// This means CMS's own data is fully isolated in cms_db, but CMS's audit
// trail remains a real, approved dependency on Core's database.
import { PrismaModule } from '../../../database/prisma.module';

@Module({
  imports: [CmsPrismaModule, PrismaModule, CacheModule.register(), NotificationModule],
  controllers: [BlogController],
  providers: [BlogService, BlogRepository, CacheService, RequestContextService, AuditService],
  exports: [BlogService],
})
export class BlogModule {}
