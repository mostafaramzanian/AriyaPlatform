import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationModule } from '../notifications/notification.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { IntegrationsModule } from '../integrations/integration.module';
import { SupportService } from './support.service';
import { SupportAttachmentService } from './support-attachment.service';
import { SupportController } from './support.controller';

/**
 * Phase 49G: Core Support / Ticketing.
 *
 * A CORE capability, so it is registered in CoreAppModule (and AppModule) and never
 * in the CMS-only process, which has no Core database.
 *
 * RbacModule is imported for PermissionService — agent status is resolved from the
 * RBAC catalogue, never from a role-name string or anything the client controls.
 * It also supplies AuditService, which SupportService uses for privileged mutations
 * only.
 *
 * NotificationModule is reused so a ticket event reaches the existing 49E
 * Notification Center rather than a parallel mechanism. StorageModule supplies the
 * same MinIO provider messaging and media already use.
 *
 * No new permission is declared anywhere in this module: `support.tickets` and
 * `admin.support.manage` already exist in the RBAC catalogue.
 *
 * Phase 49L: IntegrationsModule is imported for `AutomationService` ONLY — the emit
 * façade. Ticket lifecycle changes are the first real domain events the integration
 * platform carries (`ticket.created` / `ticket.updated` / `ticket.resolved`).
 *
 * `IntegrationService` is deliberately NOT reachable from here: it is not exported by
 * that module, so nothing in support can configure an integration, read a secret,
 * choose a destination or touch the retry pass. Emission is the whole surface, and it
 * cannot fail a ticket operation — `AutomationService.emit` catches everything.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    NotificationModule,
    RbacModule,
    IntegrationsModule,
  ],
  controllers: [SupportController],
  providers: [SupportService, SupportAttachmentService],
  exports: [SupportService],
})
export class SupportModule {}
