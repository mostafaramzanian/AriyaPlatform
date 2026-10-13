import { Module } from '@nestjs/common';
import { NotificationPublisher } from './notification.publisher';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { PrismaModule } from '../database/prisma.module';

/**
 * Core notification module.
 *
 * Holds two independent things that must not be conflated:
 *
 *  - NotificationPublisher — pre-existing RabbitMQ event infrastructure
 *    (`domain_events` topic exchange). Untouched by Phase 49E.
 *  - NotificationService/NotificationController — Phase 49E persistent, in-app
 *    Notification Center backed by the Core `Notification` table.
 *
 * The Notification Center is a CORE capability, so it is registered here (this
 * module is imported by both AppModule and CoreAppModule) and deliberately NOT
 * in CmsNotificationModule, which stays publisher-only for the CMS-only process
 * that has no Core database.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationController],
  providers: [NotificationPublisher, NotificationService],
  exports: [NotificationPublisher, NotificationService],
})
export class NotificationModule {}

