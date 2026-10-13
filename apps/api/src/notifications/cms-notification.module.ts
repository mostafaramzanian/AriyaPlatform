import { Module } from '@nestjs/common';
import { NotificationPublisher } from './notification.publisher';

/**
 * Phase 33K: CMS-scoped variant of NotificationModule.
 *
 * Deliberately does NOT import PrismaModule (Core). NotificationPublisher's
 * `prisma` constructor param is @Optional() (see notification.publisher.ts) —
 * it is only used there as a best-effort fallback to persist an AuditDispatch
 * retry record when a RabbitMQ publish fails. In a CMS-only process that has
 * no Core database connection, that fallback is skipped (already logged) and
 * publishing itself is unaffected.
 *
 * The combined single-process app (AppModule) continues to use the regular
 * NotificationModule, which does import PrismaModule, so existing behavior
 * (audit-dispatch retry persistence) is unchanged there.
 */
@Module({
  providers: [NotificationPublisher],
  exports: [NotificationPublisher],
})
export class CmsNotificationModule {}
