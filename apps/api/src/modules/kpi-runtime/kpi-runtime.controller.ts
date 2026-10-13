/**
 * Phase KPI-RUNTIME — the read-only KPI surface: `GET /api/v1/kpis` and
 * `GET /api/v1/kpis/:technicalKey`, both scoped to the five APPROVED definitions.
 *
 * WHY AUTHORIZATION LIVES HERE AND NOT IN THE SERVICE
 * ---------------------------------------------------
 * The platform's own `ModuleEntitlementGuard` states the rule this module obeys: entitlement
 * is "declared at the boundary and never called from a service". So the ports are injected
 * HERE, and the service receives an already-authorized key set and computes nothing for a key
 * outside it — an unauthorized definition is refused before a seam is ever reached.
 *
 * WHY THE GUARD ITSELF CANNOT EXPRESS THIS SURFACE
 * ------------------------------------------------
 * `ModuleEntitlementGuard` reads ONE static `@RequiresModule` / `@RequiresFeature` pair per
 * handler, but `GET /kpis` serves three modules at once (Production's `production`/`bom`,
 * Commerce's `commerce`/`purchase`, Financial's `financial`/`check-request`). A single
 * class-level declaration would either authorise two thirds of the list it should not, or
 * 403 the third it should serve. The requirement is therefore resolved PER KPI against the
 * same `ENTITLEMENT_PORT` the guard would have asked, in the same §43.9 order — one port,
 * one vocabulary, one place that reads it.
 *
 * THE ROUTE GATE IS STILL DECLARED. `@Roles(...KPI_READ_REMITS)` is a UNION — `RolesGuard`
 * requires at least one — so a caller holding none of the three source remits is refused by
 * the global guard before this controller runs. The per-key filter below is the finer half
 * of the same rule: holding `commerce.read` admits you to the LIST, never to Production's
 * KPIs. `KPI_READ_REMITS` is asserted against the catalog's own `readRemit` values by
 * `kpi-runtime.service.spec.ts`, so the two cannot drift.
 *
 * NO `RbacModule` IS SPECIAL HERE: `@Roles` is metadata the global `RolesGuard` resolves, and
 * `PermissionSource` is the PORT that guard itself consults — the Commerce search-source
 * precedent — never `PermissionService`, `RoleService` or Core's Prisma client.
 */

import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Permissions } from '../../auth/rbac/constants/permissions';
import { PermissionSource } from '../../platform/auth/permission-source.contract';
import {
  ENTITLEMENT_PORT,
  type EntitlementPort,
} from '../../platform/entitlement/entitlement.contract';
import { resolveKpiRuntimeActor } from './kpi-runtime.actor';
import { KpiHistoryQueryDto, KpiPeriodQueryDto } from './kpi-runtime.dto';
import { HISTORY_INVALID_RANGE, HISTORY_RANGE_EXCEEDS_LIMIT } from './kpi-runtime.history';
import { KPI_RUNTIME_PLANS } from './kpi-runtime.plan';
import { KpiRuntimeService, servedKpiDefinitions } from './kpi-runtime.service';

/**
 * The union of the three SOURCE read remits the five approved KPIs answer to — exactly the
 * remits the catalog records as `authorization.readRemit`. Stated once, spread into both
 * `@Roles(...)` calls, and pinned back to the catalog by `kpi-runtime.service.spec.ts`.
 */
export const KPI_READ_REMITS: readonly string[] = [
  Permissions.PRODUCTION_BOM_READ,
  Permissions.COMMERCE_READ,
  Permissions.FINANCIAL_CHECK_READ,
];

/** `403` with a closed code, so a support engineer and a screen read the same sentence. */
function forbidden(code: string): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code });
}

@Controller('kpis')
@UseGuards(JwtAuthGuard)
export class KpiRuntimeController {
  constructor(
    private readonly kpis: KpiRuntimeService,
    private readonly permissions: PermissionSource,
    @Inject(ENTITLEMENT_PORT) private readonly entitlement: EntitlementPort
  ) {}

  /** Every approved KPI this caller may read, for one Jalali month. */
  @Get()
  @Roles(...KPI_READ_REMITS)
  async list(@Request() req: ExRequest, @Query() query: KpiPeriodQueryDto) {
    const actor = resolveKpiRuntimeActor(req);
    const keys = await this.authorize(actor);

    // The union gate above already 403s a caller with none of the three remits; this is the
    // same rule stated where it can be unit-tested without a guard in the container, and it
    // is what stops a caller who holds a remit NO served KPI names from getting `items: []`
    // and reading it as "the catalog is empty".
    if (keys.length === 0) throw forbidden('KPI_NOT_AUTHORIZED');

    return this.kpis.list(actor, keys, query);
  }

  /** Exactly one approved KPI, for one Jalali month. */
  @Get(':technicalKey')
  @Roles(...KPI_READ_REMITS)
  async getOne(
    @Request() req: ExRequest,
    @Param('technicalKey') technicalKey: string,
    @Query() query: KpiPeriodQueryDto
  ) {
    const actor = resolveKpiRuntimeActor(req);

    // UNKNOWN BEFORE UNAUTHORIZED: the catalog itself is public record
    // (`docs/architecture/KPI-CATALOG.md`), so answering "no such key" for a key the catalog
    // never held discloses nothing — while a REAL key this caller may not read still answers
    // 403, never a 404 that would hide a definition the document already publishes.
    if (!servedKpiDefinitions().some((def) => def.technicalKey === technicalKey)) {
      throw new NotFoundException({ statusCode: 404, code: 'KPI_NOT_FOUND', technicalKey });
    }

    const keys = await this.authorize(actor);
    if (!keys.includes(technicalKey)) throw forbidden('KPI_NOT_AUTHORIZED');

    return this.kpis.getOne(actor, technicalKey, query);
  }

  /**
   * Phase KPI-HISTORICAL-INTELLIGENCE — one KPI over a bounded run of months.
   *
   * ROUTE SHAPE: `/kpis/:technicalKey/history` has one more segment than
   * `/kpis/:technicalKey`, so Express can never read `history` as a technical key —
   * declaration order is irrelevant and both single-KPI reads share one
   * authorization block shape. Unknown → 404, unauthorized → 403, oversized →
   * 400 HISTORY_RANGE_EXCEEDS_LIMIT, inverted/undersized → 400 HISTORY_INVALID_RANGE.
   */
  @Get(':technicalKey/history')
  @Roles(...KPI_READ_REMITS)
  async getHistory(
    @Request() req: ExRequest,
    @Param('technicalKey') technicalKey: string,
    @Query() query: KpiHistoryQueryDto
  ) {
    const actor = resolveKpiRuntimeActor(req);

    if (!servedKpiDefinitions().some((def) => def.technicalKey === technicalKey)) {
      throw new NotFoundException({ statusCode: 404, code: 'KPI_NOT_FOUND', technicalKey });
    }

    const keys = await this.authorize(actor);
    if (!keys.includes(technicalKey)) throw forbidden('KPI_NOT_AUTHORIZED');

    try {
      return await this.kpis.getHistory(actor, technicalKey, query);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === HISTORY_RANGE_EXCEEDS_LIMIT) {
        throw new BadRequestException({ statusCode: 400, code });
      }
      if (code === HISTORY_INVALID_RANGE) {
        throw new BadRequestException({ statusCode: 400, code });
      }
      throw error;
    }
  }

  /**
   * The keys this actor may READ — permission first, then entitlement, per definition.
   *
   * The two questions are asked in the order the platform's guard asks them (authorization
   * before entitlement), and the entitlement port is asked ONCE per module+feature pair
   * rather than five times: all five KPIs collapse onto three pairs, and re-asking would be
   * three identical registry round-trips inside one request.
   */
  private async authorize(actor: ReturnType<typeof resolveKpiRuntimeActor>): Promise<string[]> {
    const held = await this.permissions.getEffectivePermissions(actor.userId, actor.claims);
    const decided = new Map<string, boolean>();
    const keys: string[] = [];

    for (const def of servedKpiDefinitions()) {
      if (!held.includes(def.authorization.readRemit)) continue;

      const plan = KPI_RUNTIME_PLANS.get(def.technicalKey);
      // A served definition with no plan cannot be authorized SAFELY — the feature its source
      // route requires would be unknown — so it is dropped rather than served unchecked.
      if (!plan) continue;

      const requirement = `${def.authorization.moduleEntitlement}:${plan.featureId}`;
      let entitled = decided.get(requirement);
      if (entitled === undefined) {
        const decision = await this.entitlement.decide({
          moduleId: def.authorization.moduleEntitlement,
          featureId: plan.featureId,
        });
        entitled = decision.ok;
        decided.set(requirement, entitled);
      }
      if (!entitled) continue;

      keys.push(def.technicalKey);
    }

    return keys;
  }
}
