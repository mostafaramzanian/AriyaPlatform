import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { ObservabilityHealthService } from './observability-health.service';
import { ObservabilityReadService } from './observability-read.service';
import {
  ApplicationLogQueryDto,
  AuditEventQueryDto,
  LifecycleEventQueryDto,
  SecurityEventQueryDto,
} from './dto/observability-query.dto';
import {
  LIFECYCLE_DOMAINS,
  LIFECYCLE_PHASES,
  LOG_LEVELS,
  LOG_MESSAGE_CODES,
  LOG_SOURCES,
  SECURITY_EVENT_TYPES,
  SECURITY_SEVERITIES,
} from './observability.contract';

/**
 * Phase 49M-2: the admin read API.
 *
 * READ ONLY, WITH NO WRITE ROUTE ANYWHERE. There is no `POST /admin/observability/logs`, and
 * that absence is the design: an HTTP endpoint that accepts log lines is an unauthenticated
 * (or thinly authenticated) way to fill the database, and every legitimate producer is inside
 * this process and injects `ObservabilityService` directly. Remote modules report through the
 * 49M module protocol, which already authenticates them.
 *
 * NO DELETE ROUTE EITHER. Deletion happens only by retention policy. An administrator who
 * could delete individual audit or security rows could erase the evidence of their own
 * actions, which would make the entire table worthless as an audit trail — the property is
 * only meaningful if nobody can curate it.
 *
 * EVERY ROUTE IS GATED BY `admin.observability.read`, EXCEPT the security route, which is
 * gated by `admin.security.read` INSTEAD. That substitution — rather than adding a second
 * permission — is forced by the guard's semantics: `RolesGuard` resolves the `@Roles(...)`
 * list with `.some(...)`, so naming two permissions GRANTS access to holders of either one.
 * Listing both on the security route would have widened it to OPERATIONS_ADMIN, the exact
 * opposite of the intent. Naming only the narrower permission keeps `SecurityEvent` — failed
 * logins, denied permissions, masked identifiers — inside the SUPER_ADMIN/SECURITY_ADMIN
 * audience while OPERATIONS_ADMIN still reads application logs and lifecycle history.
 *
 * `/health` AND `/metrics` ARE HERE RATHER THAN ON THE PUBLIC HEALTH CONTROLLER on purpose:
 * they expose queue depth, drop counts and the effective configuration, which is operational
 * detail rather than a liveness answer, and the main `/health` must stay green when the log
 * database is down (logging is optional infrastructure).
 */
@Controller('admin/observability')
@UseGuards(JwtAuthGuard)
export class ObservabilityController {
  constructor(
    private readonly read: ObservabilityReadService,
    private readonly health: ObservabilityHealthService,
  ) {}

  /**
   * The vocabularies the UI needs to build its filters.
   *
   * DECLARED FIRST DELIBERATELY. Nest matches in declaration order, and while none of these
   * paths currently shadow one another, the ordering hazard that `ModuleRegistryController`,
   * `UsersController` and `IntegrationController` all document is avoided by keeping the
   * literal paths ahead of anything parameterised.
   *
   * It exists so the admin page does not keep its own copy of the level list, the message-code
   * vocabulary or the security event types. A client-side copy is how a UI ends up offering a
   * filter value the backend stopped emitting.
   */
  @Get('vocabulary')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  vocabulary() {
    return {
      levels: LOG_LEVELS,
      sources: LOG_SOURCES,
      messageCodes: LOG_MESSAGE_CODES,
      securityEventTypes: SECURITY_EVENT_TYPES,
      securitySeverities: SECURITY_SEVERITIES,
      lifecycleDomains: LIFECYCLE_DOMAINS,
      lifecyclePhases: LIFECYCLE_PHASES,
    };
  }

  /** Writer state, connectivity and the effective configuration. Never a credential. */
  @Get('health')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  async healthCheck() {
    return this.health.check();
  }

  /** Provider-neutral metric samples. No Prometheus dependency — see the health service. */
  @Get('metrics')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  metrics() {
    return { samples: this.health.metrics() };
  }

  @Get('logs')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  async logs(@Query() query: ApplicationLogQueryDto) {
    return this.read.findApplicationLogs(query);
  }

  @Get('audit-events')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  async auditEvents(@Query() query: AuditEventQueryDto) {
    return this.read.findAuditEvents(query);
  }

  /**
   * Security events. GATED ON `admin.security.read` ALONE, and that is not an oversight.
   *
   * `RolesGuard` resolves the `@Roles(...)` list with `.some(...)` — a caller needs ANY ONE of
   * the named permissions, not all of them. So writing
   * `@Roles(ADMIN_OBSERVABILITY_READ, ADMIN_SECURITY_READ)` here would WIDEN access to
   * everyone holding observability read, including OPERATIONS_ADMIN, rather than restricting
   * it. Naming only the narrower permission is the sole way to express "security audience
   * only" with an OR-semantics guard.
   *
   * WHO THAT IS, from RolePermissions in auth/rbac/constants/roles.ts: SUPER_ADMIN and
   * SECURITY_ADMIN hold `admin.security.read`. ADMIN and OPERATIONS_ADMIN do not — so neither
   * can enumerate failed login attempts, denied permissions, or the IP addresses behind them,
   * while both keep full access to application logs and lifecycle history.
   */
  @Get('security-events')
  @Roles(Permissions.ADMIN_SECURITY_READ)
  async securityEvents(@Query() query: SecurityEventQueryDto) {
    return this.read.findSecurityEvents(query);
  }

  @Get('lifecycle-events')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  async lifecycleEvents(@Query() query: LifecycleEventQueryDto) {
    return this.read.findLifecycleEvents(query);
  }

  /** Retention history: proof that pruning is running, and what it deleted. */
  @Get('retention-runs')
  @Roles(Permissions.ADMIN_OBSERVABILITY_READ)
  async retentionRuns() {
    return { items: await this.read.findRetentionRuns() };
  }
}
