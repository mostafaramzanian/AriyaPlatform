import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationModule } from '../notifications/notification.module';
import { TokenAuthModule } from '../platform/auth/token-auth.module';
import { MessagingService } from './messaging.service';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingController } from './messaging.controller';
import { MessagingGateway } from './messaging.gateway';
import { CONNECTION_REGISTRY, InProcessConnectionRegistry } from './connection-registry';

/**
 * Phase 49F: Internal Messaging.
 *
 * A CORE capability, so it is registered in CoreAppModule and never in the
 * CMS-only process, which has no Core database.
 *
 * The connection registry is bound through the CONNECTION_REGISTRY token rather
 * than the class, so the fan-out implementation can be swapped without touching
 * the service or the gateway. It is a singleton by construction: presence lives in
 * that instance's maps, so a second instance would report a user as offline while
 * their socket is held by the first.
 *
 * Phase 51-HR-ARCH-3A: `JwtModule` used to be registered here, with its own copy of
 * `JWT_SECRET`, because the gateway had to verify a token itself — there is no HTTP
 * request for the guard chain to run against during a WebSocket handshake. The gateway now
 * uses the platform `TokenVerifier` through `TokenAuthModule`, so this module holds no
 * signing material and cannot drift from the HTTP path's definition of an acceptable token.
 *
 * No Kafka, Redis, Bull or Socket.IO import appears anywhere in this module.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    // Reused so an offline recipient still learns about a message through the
    // existing Notification Center rather than a parallel mechanism.
    NotificationModule,
    // The platform token verifier — the same one the HTTP guard chain uses.
    TokenAuthModule,
  ],
  controllers: [MessagingController],
  providers: [
    MessagingService,
    MessagingAttachmentService,
    MessagingGateway,
    { provide: CONNECTION_REGISTRY, useClass: InProcessConnectionRegistry },
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
