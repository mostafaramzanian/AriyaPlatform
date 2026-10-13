import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { DirectoryService } from './directory.service';
import { UsersController } from './users.controller';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, RbacModule, StorageModule],
  providers: [UsersService, DirectoryService],
  controllers: [UsersController],
  exports: [UsersService, DirectoryService],
})
export class UsersModule {}
