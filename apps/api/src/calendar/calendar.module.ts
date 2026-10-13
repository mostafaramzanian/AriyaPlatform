import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { NotificationModule } from '../notifications/notification.module';
import { CalendarController } from './calendar.controller';
import { ReminderService } from './reminder.service';
import { ReminderDispatcherService } from './reminder-dispatcher.service';

/**
 * Phase 49I: Calendar / Personal Reminders.
 *
 * A CORE capability, so it is registered in CoreAppModule (and AppModule) and never
 * in the CMS-only process, which has no Core database.
 *
 * NotificationModule is imported for NotificationService: a fired reminder becomes a
 * persisted in-app Notification through the existing 49E creation path
 * (`createForUser`), which is the ONLY server-side creation path and which snapshots
 * the recipient's own tenant. Nothing here reshapes, extends or bypasses the
 * Notification Center, and no new notification type is introduced — a reminder is
 * INFORMATION.
 *
 * NO RbacModule, unlike SupportModule (49G) and SurveysModule (49H): this phase
 * introduces no permission and no administrative capability, so there is nothing to
 * resolve from the RBAC catalogue. Importing it "for symmetry" would add a dependency
 * nothing here uses.
 *
 * NO StorageModule: reminders have no attachments.
 *
 * ReminderDispatcherService is a provider rather than a separate process, matching
 * AuditDispatcherService — the existing, audited in-process bounded-interval pattern.
 * Its correctness does not depend on being singleton: delivery is claimed with a
 * conditional UPDATE, so running it in several API replicas is safe.
 */
@Module({
  imports: [PrismaModule, NotificationModule],
  controllers: [CalendarController],
  providers: [ReminderService, ReminderDispatcherService],
  exports: [ReminderService],
})
export class CalendarModule {}
