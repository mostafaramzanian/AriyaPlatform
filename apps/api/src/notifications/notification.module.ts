import { Module } from '@nestjs/common';
import { NotificationPublisher } from './notification.publisher';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { EmailService } from './email/email.service';
import { PrismaModule } from '../database/prisma.module';

/**
 * Core notification module.
 *
 * Holds three independent things that must not be conflated:
 *
 *  - NotificationPublisher — pre-existing RabbitMQ event infrastructure
 *    (`domain_events` topic exchange). Untouched by Phase 49E.
 *  - NotificationService/NotificationController — Phase 49E persistent, in-app
 *    Notification Center backed by the Core `Notification` table.
 *  - PHASE PASSWORD-RESET-CODE: `EmailService` — the process's ONE SMTP seam, registered and
 *    EXPORTED here so a consumer that needs mail injects it rather than constructing a second
 *    transport. It was defined but never provided before this phase, which is exactly why the
 *    password-reset mail was never delivered: nobody could inject it. It has no database
 *    dependency, so registering it in the Core module is safe for every runtime that imports
 *    this module.
 *
 * The Notification Center is a CORE capability, so it is registered here (this
 * module is imported by both AppModule and CoreAppModule) and deliberately NOT
 * in CmsNotificationModule, which stays publisher-only for the CMS-only process
 * that has no Core database.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationController],
  providers: [NotificationPublisher, NotificationService, EmailService],
  exports: [NotificationPublisher, NotificationService, EmailService],
})
export class NotificationModule {}

