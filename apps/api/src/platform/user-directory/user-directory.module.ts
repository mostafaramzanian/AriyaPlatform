import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { CoreUserDirectoryAdapter } from './core-user-directory.adapter';
import { USER_DIRECTORY } from './user-directory.contract';

/**
 * Phase 50-MOD-CORR: the platform's identity seam.
 *
 * A module that has been extracted out of Core still needs to resolve people and
 * tenant membership. It must not thereby acquire Core's Prisma client, Core's schema
 * or Core's migration history — that is the whole point of the extraction. So this
 * module imports `PrismaModule` (Core-only, private to this folder) and exports the
 * PORT token:
 *
 *     imports: [UserDirectoryModule]        // a consuming module's view
 *     constructor(@Inject(USER_DIRECTORY) private users: UserDirectoryContract) {}
 *
 * `useExisting` rather than `useClass` so the adapter is instantiated ONCE per
 * process and shared by every consumer; registering a second `PrismaService`-holding
 * instance to answer the same questions would double a connection-pool consumer for
 * no benefit.
 *
 * Only the token is exported. `CoreUserDirectoryAdapter` stays module-private, so no
 * consumer can bypass the port and reach the Core-flavoured class directly.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    CoreUserDirectoryAdapter,
    { provide: USER_DIRECTORY, useExisting: CoreUserDirectoryAdapter },
  ],
  exports: [USER_DIRECTORY],
})
export class UserDirectoryModule {}
