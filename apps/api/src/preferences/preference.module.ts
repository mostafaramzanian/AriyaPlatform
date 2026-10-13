import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { PreferenceController } from './preference.controller';
import { PreferenceService } from './preference.service';

/**
 * Phase 49K: Core Experience Platform — personalization module.
 *
 * PrismaModule for the single `UserPreference` row per user.
 *
 * RbacModule, and for a narrower reason than in 49G/49H/49J: this module introduces NO
 * permission and gates NO route. `PermissionService` is imported purely to FILTER what
 * a read returns — a pinned href whose permission has since been revoked stops being
 * returned — so RBAC here is an output filter, never an entry check. That is why
 * `RolesGuard` is not applied to anything in `PreferenceController`.
 *
 * NO NotificationModule: changing your own theme notifies nobody. Unlike 49I, where a
 * fired reminder becomes a notification, nothing in this module produces an event.
 *
 * NO CalendarModule / NotificationModule / SearchModule, even though the dashboard
 * widgets display data from all three. The WIDGETS live in `apps/web` and each fetches
 * from the capability's own route, which enforces its own authorization edge. Importing
 * those services here to build an aggregated payload would put this module in the
 * position of re-deciding what a user may see — the exact mistake `search.module.ts`
 * documents avoiding, and one that would make every widget's authorization rule exist
 * in two places.
 *
 * Service is EXPORTED so a later phase can read a user's density or motion preference
 * server-side (for example when rendering an email) without another module reaching
 * into `PrismaService` directly.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [PreferenceController],
  providers: [PreferenceService],
  exports: [PreferenceService],
})
export class PreferencesModule {}
