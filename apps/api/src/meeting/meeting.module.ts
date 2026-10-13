import { Module } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { PrismaModule } from '../database/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MeetingService],
  exports: [MeetingService],
})
export class MeetingModule {}
