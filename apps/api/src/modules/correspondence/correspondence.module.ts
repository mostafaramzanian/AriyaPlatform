import { Module } from '@nestjs/common';
import { RbacModule } from '../../auth/rbac/rbac.module';
import { NotificationModule } from '../../notifications/notification.module';
import { StorageModule } from '../../storage/storage.module';
import { UserDirectoryModule } from '../../platform/user-directory/user-directory.module';
import { CorrespondencePrismaModule } from './database/correspondence-prisma.module';
import { CorrespondenceService } from './correspondence.service';
import { CorrespondenceController } from './correspondence.controller';
import { CorrespondenceAttachmentService } from './correspondence-attachment.service';
import { CorrespondenceSignatureService } from './correspondence-signature.service';
import { LetterNumberService } from './letter-number.service';
import { ScheduledSendDispatcherService } from './jobs/scheduled-send.dispatcher';

/**
 * Phase 50-MOD-CORR: Official Correspondence / مکاتبات اداری — now an INDEPENDENT
 * business module rather than a Core capability.
 *
 * WHAT CHANGED, AND WHY IT IS NOT COSMETIC
 * ---------------------------------------
 * Correspondence owns `correspondence_db`, its own Prisma project
 * (`prisma/correspondence/schema.prisma`), its own generated client, its own
 * migration history and its own data-access layer. It is registered in
 * `AppModule` — the composition root — and is NO LONGER imported by
 * `CoreAppModule`. Before this phase it lived in `src/correspondence/**`, its
 * tables lived in `core_db` beside `"User"` with ON DELETE CASCADE foreign keys,
 * and a `setInterval` inside `CorrespondenceService` did its scheduling.
 *
 * Precedent for every mechanism here: `src/modules/cms/**` (33J) for the module
 * namespace and the owned client, and `ReminderDispatcherService` (49I) for the
 * scheduler pattern.
 *
 * DEPENDENCIES, each for a concrete reason and none "for symmetry"
 * ----------------------------------------------------------------
 *  - CorrespondencePrismaModule: the module's OWN database. Core's PrismaModule is
 *    deliberately ABSENT — the §25 isolation spec fails the build if it appears.
 *  - UserDirectoryModule: the platform PORT for identity. Two real needs survive the
 *    extraction — "is this id a member of my tenant?" and "what is this person
 *    called?" — and a module with no access to either could not validate a recipient
 *    or render a letter. It receives four allowlisted lookups, never Core's client,
 *    never Core's schema.
 *  - RbacModule: PermissionService — manager/confidential entitlements are resolved
 *    from the RBAC catalogue, never from a role-name string; it also supplies
 *    AuditService for the security-sensitive mutations (send, classification).
 *  - NotificationModule: NotificationService.createForUser — the SINGLE server-side
 *    notification creation path (49E); correspondence never writes Notification rows
 *    directly, and a notification failure never fails a send.
 *  - StorageModule: IStorageProvider (MinIO) — attachments and signatures reuse the
 *    platform's existing secure object storage and signed-URL flow (49F/49G), not a
 *    second storage mechanism.
 *
 * SCHEDULING
 * ----------
 * `ScheduledSendDispatcherService` is a provider HERE because the job is the module's
 * own concern: it claims due letters in `correspondence_db` and asks the module's own
 * service to send them. It is deliberately NOT a Core scheduler reaching into this
 * database — that would rebuild exactly the coupling this phase removed.
 *
 * Introduces THREE permissions (`correspondence.manage`,
 * `correspondence.confidential.read`, `correspondence.confidential.manage`), seeded
 * in core_db by 20260912120500_seed_correspondence_permission_grants, granted to
 * SUPER_ADMIN and ADMIN only. The personal workflow (drafts, send, inbox, referral
 * of visible letters, personal archive) is deliberately NOT permission-gated.
 */
@Module({
  imports: [
    CorrespondencePrismaModule,
    UserDirectoryModule,
    RbacModule,
    NotificationModule,
    StorageModule,
  ],
  controllers: [CorrespondenceController],
  providers: [
    CorrespondenceService,
    CorrespondenceAttachmentService,
    CorrespondenceSignatureService,
    LetterNumberService,
    ScheduledSendDispatcherService,
  ],
  exports: [CorrespondenceService],
})
export class CorrespondenceModule {}