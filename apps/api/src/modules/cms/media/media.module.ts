import { Module } from '@nestjs/common';
import { CmsPrismaModule } from '../../../database/cms-prisma.module';
import { StorageModule } from '../../../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { RequestContextService } from '../../../common/request-context.service';

@Module({
  imports: [CmsPrismaModule, StorageModule],
  controllers: [MediaController],
  providers: [MediaService, RequestContextService],
  exports: [MediaService],
})
export class MediaModule {}
