import { Module } from '@nestjs/common';
import { CmsPrismaService } from './cms-prisma.service';
import { CMS_PRISMA_CLIENT } from '../health/health-tokens';

@Module({
  providers: [
    CmsPrismaService,
    { provide: CMS_PRISMA_CLIENT, useExisting: CmsPrismaService },
  ],
  exports: [CmsPrismaService, CMS_PRISMA_CLIENT],
})
export class CmsPrismaModule {}
