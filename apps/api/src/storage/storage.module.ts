import { Module } from '@nestjs/common';
import { MinioProvider } from './minio.provider';

@Module({
  providers: [
    {
      provide: 'IStorageProvider',
      useClass: MinioProvider,
    },
  ],
  exports: ['IStorageProvider'],
})
export class StorageModule {}
