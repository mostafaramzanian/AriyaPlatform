import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { SurveysService } from './surveys.service';
import { SurveysController } from './surveys.controller';

/**
 * Phase 49H: Core Surveys / Participation.
 *
 * A CORE capability, so it is registered in CoreAppModule (and AppModule) and never
 * in the CMS-only process, which has no Core database.
 *
 * RbacModule is imported for PermissionService — manager and results-viewer status
 * are resolved from the RBAC catalogue, never from a role-name string or anything the
 * client controls. It also supplies AuditService, which SurveysService uses for
 * privileged mutations only.
 *
 * NO NotificationModule and NO StorageModule, unlike SupportModule (49G): this phase
 * neither notifies nor stores files. Importing them "for symmetry" would add
 * dependencies nothing here uses.
 *
 * Unlike 49G, this module DOES introduce permissions: `admin.surveys.manage` and
 * `admin.surveys.results` are new in the RBAC catalogue and seeded into `core_db` by
 * `20260830130000_seed_survey_permission_grants`, granted to SUPER_ADMIN and ADMIN
 * only. Participation itself is deliberately not permission-gated.
 */
@Module({
  imports: [PrismaModule, RbacModule],
  controllers: [SurveysController],
  providers: [SurveysService],
  exports: [SurveysService],
})
export class SurveysModule {}
