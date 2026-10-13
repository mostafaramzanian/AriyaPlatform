import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { createHealthProviders } from './health.providers';
import { PrismaModule } from '../database/prisma.module';
import { CmsPrismaModule } from '../database/cms-prisma.module';

/**
 * Phase ARCH-1.3: the health graph of the CMS runtime.
 *
 * `imports` lists exactly the Prisma modules of the datasources this runtime
 * INSTANTIATES, i.e. the non-`not-used` entries of `RUNTIME_DATASOURCE_MATRIX.cms`:
 *
 *   CORE_DATABASE_URL  required → PrismaModule
 *   CMS_DATABASE_URL   required → CmsPrismaModule
 *   OBSERVABILITY_DATABASE_URL  not-used → not imported (CMS has no observability
 *                               database; the observability interceptor degrades
 *                               to a no-op, see observability.interceptor.ts)
 *   CORRESPONDENCE_DATABASE_URL not-used → not imported
 *   HR_DATABASE_URL             not-used → not imported
 */
@Module({
  imports: [PrismaModule, CmsPrismaModule],
  controllers: [HealthController],
  providers: createHealthProviders('cms'),
  exports: [HealthService],
})
export class CmsHealthModule {}
