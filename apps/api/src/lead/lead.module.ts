import { Module } from '@nestjs/common';
import { LeadService } from './lead.service';
import { PrismaModule } from '../database/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [LeadService],
  exports: [LeadService],
})
export class LeadModule {}
