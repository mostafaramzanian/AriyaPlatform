import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { CORE_PRISMA_CLIENT } from '../health/health-tokens';

@Module({
  providers: [
    PrismaService,
    { provide: CORE_PRISMA_CLIENT, useExisting: PrismaService },
  ],
  exports: [PrismaService, CORE_PRISMA_CLIENT],
})
export class PrismaModule {}
