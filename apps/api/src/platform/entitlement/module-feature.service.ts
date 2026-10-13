import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { RequestContextService } from '../../common/request-context.service';
import { PrismaService } from '../../database/prisma.service';
import { FEATURE_TENANT_PAGE_SIZE } from './dto/module-feature.dto';
import type {
  DeclareFeatureDto,
  ListFeatureTenantsQueryDto,
  UpdateFeatureDto,
} from './dto/module-feature.dto';
import { PlatformEntitlementService } from './platform-entitlement.service';
import { ModuleTenantScope } from '../../generated/core-client';
import { effectiveStateOf } from './entitlement.contract';
import type { EffectiveEntitlementState, EntitlementFailureCode } from './entitlement.contract';

/**
 * Phase 54-C (D14, §43.8): the WRITE side of entitlement — declare, rename/offer, grant, revoke.
 *
 * WHY THIS IS NOT PART OF `PlatformEntitlementService`
 * ---------------------------------------------------
 * That class is the frozen §43.2 DECISION and the only reader of the two entitlement tables on the
 * REQUEST path; this one is the admin plane that WRITES them. Keeping them apart means the decision
 * path cannot acquire a mutation, and a business module cannot reach the write paths at all: nothing
 * here is exported from the module that owns it (§43.6).
 *
 * ONE AUDIT ROW PER CHANGE: a request that changes NOTHING — re-granting tenants that already hold the
 * feature, a PATCH whose values already match, a revoke of a grant that is not there (a `404`) —
 * writes no row. The trail answers "who turned Leave off, and when?", and a no-op row would only make
 * that answer harder to find.
 *
 * THE TENANCY OF A REQUEST IS NEVER TOUCHED. No method reads a tenant from a body, query or header:
 * the tenant ids that appear are the SUBJECTS of a grant or revocation — configuration facts, recorded
 * in the audit row. `tenantId` is never set on the audit options either: that field means "the tenant
 * this EVENT belongs to", and a platform administrative action belongs to the platform.
 */

/** §43.8's six audit actions, one vocabulary for offers, grants and revocations alike. */
export const MODULE_FEATURE_ACTIONS = {
  DECLARED: 'module.feature.declared',
  UPDATED: 'module.feature.updated',
  ENABLED: 'module.feature.enabled',
  DISABLED: 'module.feature.disabled',
  GRANTED: 'module.feature.granted',
  REVOKED: 'module.feature.revoked',
} as const;

/** The audited resource: the feature ROW, as §43.8 states. */
export const MODULE_FEATURE_AUDIT_RESOURCE = 'ModuleFeature';

/** The projection the admin surface returns; identical in shape to the web client's type. */
export interface ModuleFeatureSummary {
  id: string;
  moduleId: string;
  featureId: string;
  displayName: string;
  enabled: boolean;
  grantedTenantCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One tenant's grant. Presence is the grant — there is no second flag to interpret (§43.3). */
export interface ModuleFeatureGrantRow {
  tenantId: string;
  grantedAt: string;
}

/** One bounded page of grants plus the keyset cursor that continues it, or `null` at the end. */
export interface ModuleFeatureTenantPage {
  rows: ModuleFeatureGrantRow[];
  nextCursor: string | null;
}

/**
 * One tenant of a feature's CONFIGURED surface, with the platform's own decision about it.
 *
 * `decision` is the `EntitlementPort`'s answer verbatim — `{ ok: true }` or
 * `{ ok: false, failure }` from the frozen §43.2 set — and NOT a state this layer invents. The
 * console renders it; it does not re-derive it. That is the whole point of this projection: a
 * browser that recomputed "is this tenant entitled?" from `tenantScope`/`tenantIds` could not see
 * `RESTRICTED_MEMBERS` membership, so an entitled tenancy rendered as blocked.
 */
export interface ModuleFeatureTenantState {
  tenantId: string;
  /** Presence of a grant row. Reported for the form's benefit; the decision already uses it. */
  granted: boolean;
  grantedAt: string | null;
  /**
   * §43.8's four-state vocabulary — `ENTITLED`, `BLOCKED_BY_MODULE`, `BLOCKED_BY_FEATURE` or
   * `NOT_GRANTED` — projected from the platform's OWN decision by `effectiveStateOf`, not re-derived
   * from the module's flags. This is the field the console renders.
   */
  effective: EffectiveEntitlementState;
  /**
   * The §43.2 code the decision carried, `'ALLOWED'` when it allowed: the support engineer's exact
   * answer, next to the operator's state. A closed union, never a free-form string.
   */
  reasonCode: 'ALLOWED' | EntitlementFailureCode;
}

/**
 * The CONFIGURED surface of one feature, plus one page of tenants with their effective state
 * (Phase 54-C closure fix, §43.8).
 *
 * CONFIGURED AND EFFECTIVE ARE TWO FIELDS ON PURPOSE. `moduleEnabled` and `featureEnabled` are what
 * an operator SET; `rows[].effective` is what the platform will DECIDE. Turning HR off must not
 * erase the fact that Leave's own offer is on — the console shows both, so re-enabling the module
 * restores the previous answer instead of appearing to have lost it.
 */
export interface ModuleFeatureStatePage {
  moduleId: string;
  featureId: string;
  /** CONFIGURED: the module's own flag. */
  moduleEnabled: boolean;
  /** CONFIGURED: the platform's offer of this feature. */
  featureEnabled: boolean;
  /** Which membership source this module uses; see `PlatformEntitlementService`'s three scopes. */
  tenantScope: ModuleTenantScope;
  /**
   * The size of the module's tenant enumeration — members for `RESTRICTED_MEMBERS`, the legacy
   * array for `RESTRICTED` — or `null` for `ALL`, which enumerates nobody and therefore cannot be
   * counted. `null` is not zero: an `ALL` module's rows are its grants, and this field says so by
   * refusing to pretend the scope was counted.
   */
  tenantCount: number | null;
  rows: ModuleFeatureTenantState[];
  nextCursor: string | null;
}

/** The feature columns the summary reads — declared so the projection cannot drift from the select. */
interface FeatureRow {
  id: string;
  moduleId: string;
  featureId: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The module columns the SCOPE questions need — `enabled`, `tenantScope`, `tenantIds` and the row id
 * the membership child table is keyed by. Declared here so the select and the fields the scope
 * resolution reads cannot drift apart silently, exactly as `FeatureRow` does for the feature read.
 */
interface RegistrationScopeRow {
  id: string;
  enabled: boolean;
  tenantScope: ModuleTenantScope;
  tenantIds: string[];
}

/**
 * Merges two ascending, distinct-per-stream tenant-id pages into one ascending list with no repeats.
 *
 * A tenant that is BOTH a module member and the holder of a grant appears in both streams; "presence
 * is a grant" says nothing about membership, so the console must see one row for it, not two. The
 * merge is linear and the inputs are bounded pages, so this is not a sort over a table.
 */
function mergeDistinct(left: string[], right: string[]): string[] {
  const merged: string[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length || j < right.length) {
    const next =
      j >= right.length || (i < left.length && left[i] <= right[j])
        ? left[i++]
        : right[j++];

    // Skipping a repeat is what makes the merged page's LAST id a correct keyset cursor: `> cursor`
    // on the next call can then never skip a row that shares the boundary id.
    if (merged.length === 0 || merged[merged.length - 1] !== next) merged.push(next);
  }

  return merged;
}

/** Reads a Prisma error code without importing the generated client's error classes. */
const errorCode = (err: unknown): string | null => {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

@Injectable()
export class ModuleFeatureService {
  private readonly logger = new Logger(ModuleFeatureService.name);

  constructor(
    private readonly prisma: PrismaService,
    // The ONE evaluator (§43.2). Required, not optional: every effective-state read on this admin
    // surface is this service's answer, so a deployment without it must fail at BOOT rather than
    // answer a console with nothing — the same fail-closed direction `ENTITLEMENT_PORT` takes.
    private readonly entitlement: PlatformEntitlementService,
    // Optional for the same reason the registry's own audit dependency is: a failed audit write must
    // never be the thing that fails an operator's provisioning request.
    //
    // Phase 54-C (D14): `audit?: AuditService`, NOT `AuditService | null`. The union spelling is a
    // real defect and not a style choice: TypeScript emits `Object` into `design:paramtypes` for a
    // union type, so Nest's injector has no class to resolve and hands the constructor `undefined`
    // — the service then silently ran without an audit sink and `module.feature.*` produced ZERO
    // rows in `core_db."AuditLog"` while every unit test stayed green, because a unit test supplies
    // the dependency itself. The `?` marker is what the registry's `audit?: AuditService` uses, and
    // it is the marker `@Optional()` is designed around.
    @Optional() private readonly audit?: AuditService
  ) {}

  /** The declared features of one module, with each one's granted-tenant COUNT (not the list). */
  async list(moduleId: string): Promise<ModuleFeatureSummary[]> {
    await this.assertModuleRegistered(moduleId);

    const rows = await this.prisma.moduleFeature.findMany({
      where: { moduleId },
      orderBy: { featureId: 'asc' },
      include: { _count: { select: { grants: true } } },
    });

    return rows.map((row) => this.toSummary(row, row._count.grants));
  }

  /**
   * Declares a feature. `enabled` is NOT writable here: the column's own `false` default is the
   * fail-closed rule (§43.3), so a new feature is dark until an operator lights it through `update`,
   * which is the act §43.8 gives its own audit action.
   */
  async declare(
    moduleId: string,
    dto: DeclareFeatureDto,
    actorId: string
  ): Promise<ModuleFeatureSummary> {
    await this.assertModuleRegistered(moduleId);

    let row: FeatureRow;
    try {
      row = await this.prisma.moduleFeature.create({
        data: { moduleId, featureId: dto.featureId, displayName: dto.displayName },
      });
    } catch (err) {
      if (errorCode(err) === 'P2002') {
        throw new ConflictException('این شناسه قابلیت قبلاً برای این ماژول اعلام شده است.');
      }
      throw err;
    }

    await this.record(MODULE_FEATURE_ACTIONS.DECLARED, moduleId, row.featureId, actorId, {
      featureId: row.featureId,
      displayName: row.displayName,
      enabled: row.enabled,
    });

    return this.toSummary(row, 0);
  }

  /**
   * Renames the label and/or turns the platform's OFFER on or off. An empty body is refused rather
   * than read as a no-op, and a body whose values already match is answered without a write or an
   * audit row — see the file header.
   */
  async update(
    moduleId: string,
    featureId: string,
    dto: UpdateFeatureDto,
    actorId: string
  ): Promise<ModuleFeatureSummary> {
    if (dto.displayName === undefined && dto.enabled === undefined) {
      throw new BadRequestException('هیچ تغییری برای اعمال ارسال نشده است.');
    }

    const existing = await this.loadFeatureOrThrow(moduleId, featureId);

    const data: { displayName?: string; enabled?: boolean } = {};
    if (dto.displayName !== undefined && dto.displayName !== existing.displayName) {
      data.displayName = dto.displayName;
    }
    if (dto.enabled !== undefined && dto.enabled !== existing.enabled) {
      data.enabled = dto.enabled;
    }

    if (Object.keys(data).length === 0) return this.toSummary(existing, existing._count.grants);

    const row = await this.prisma.moduleFeature.update({ where: { id: existing.id }, data });

    if (data.displayName !== undefined) {
      await this.record(
        MODULE_FEATURE_ACTIONS.UPDATED,
        moduleId,
        featureId,
        actorId,
        { displayName: row.displayName },
        { displayName: existing.displayName }
      );
    }
    if (data.enabled !== undefined) {
      await this.record(
        row.enabled ? MODULE_FEATURE_ACTIONS.ENABLED : MODULE_FEATURE_ACTIONS.DISABLED,
        moduleId,
        featureId,
        actorId,
        { enabled: row.enabled },
        { enabled: existing.enabled }
      );
    }

    return this.toSummary(row, existing._count.grants);
  }

  /** One bounded, keyset-paginated page of the tenants that HOLD this feature. */
  async listTenants(
    moduleId: string,
    featureId: string,
    query: ListFeatureTenantsQueryDto
  ): Promise<ModuleFeatureTenantPage> {
    const feature = await this.loadFeatureOrThrow(moduleId, featureId);
    const limit = query.limit ?? FEATURE_TENANT_PAGE_SIZE;

    // One row more than the page: its presence is the only honest way to know whether a next page
    // exists without a second COUNT query.
    const rows = await this.prisma.moduleFeatureGrant.findMany({
      where: {
        featureRowId: feature.id,
        ...(query.cursor ? { tenantId: { gt: query.cursor } } : {}),
      },
      orderBy: { tenantId: 'asc' },
      take: limit + 1,
      select: { tenantId: true, grantedAt: true },
    });

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1].tenantId : null;

    return {
      rows: page.map((row) => ({
        tenantId: row.tenantId,
        grantedAt: row.grantedAt.toISOString(),
      })),
      nextCursor,
    };
  }

  /**
   * The AUTHORITATIVE effective-state page for one feature (Phase 54-C closure fix, §43.8).
   *
   * WHY THIS ROUTE EXISTS. The granted-tenant read above reports grants; the module's `tenantScope`
   * and `tenantIds` report a configured scope. Neither is the DECISION, and a console that combined
   * them by hand had to know that `RESTRICTED_MEMBERS` takes its membership from a child table it
   * cannot see — so HR's entitled tenants rendered as blocked. Here the platform answers per tenant,
   * through the same evaluator the request path uses, and the console renders the answer.
   *
   * WHAT IS ENUMERATED, AND WHY IT IS A UNION
   * -----------------------------------------
   * `rows` is the union of the module's tenant ENUMERATION (members for `RESTRICTED_MEMBERS`, the
   * legacy array for `RESTRICTED`, nothing for `ALL`) with the tenants that HOLD a grant. Both halves
   * are facts an operator must see: the enumeration is who the module admits, and a grant written for
   * a tenant outside it is a real, observable row — one the decision refuses as `MODULE_FORBIDDEN`,
   * which is exactly what the console should say about it.
   *
   * The union is paged by TENANT ID (keyset), not by offset: each source is read as its own ordered
   * stream with `tenantId > cursor`, the two streams are merged, and the same cursor is handed to
   * both on the next call. A row can never appear twice or vanish between pages, and no stream is
   * ever read beyond one page more than the caller asked for.
   */
  async listTenantStates(
    moduleId: string,
    featureId: string,
    query: ListFeatureTenantsQueryDto
  ): Promise<ModuleFeatureStatePage> {
    const feature = await this.loadFeatureOrThrow(moduleId, featureId);
    const registration = await this.loadRegistrationOrThrow(moduleId);
    const limit = query.limit ?? FEATURE_TENANT_PAGE_SIZE;
    const take = limit + 1;

    const [membership, grants, tenantCount] = await Promise.all([
      this.enumerationPage(registration, query.cursor ?? null, take),
      this.grantPage(feature.id, query.cursor ?? null, take),
      this.enumerationCount(registration),
    ]);

    const merged = mergeDistinct(membership, grants);
    const page = merged.slice(0, limit);
    const nextCursor = merged.length > limit ? page[page.length - 1] : null;

    // One grant read for the page, then one decision per row — the loop is over a BOUNDED page, and
    // every decision is the platform's own.
    const grantedRows = await this.prisma.moduleFeatureGrant.findMany({
      where: { featureRowId: feature.id, tenantId: { in: page } },
      select: { tenantId: true, grantedAt: true },
    });
    const grantedAt = new Map(grantedRows.map((row) => [row.tenantId, row.grantedAt.toISOString()]));

    const rows: ModuleFeatureTenantState[] = await Promise.all(
      page.map(async (tenantId) => {
        const decision = await this.entitlement.decideForTenant({ moduleId, featureId }, tenantId);

        return {
          tenantId,
          granted: grantedAt.has(tenantId),
          grantedAt: grantedAt.get(tenantId) ?? null,
          effective: effectiveStateOf(decision),
          reasonCode: decision.ok ? ('ALLOWED' as const) : decision.failure,
        };
      })
    );

    return {
      moduleId,
      featureId,
      moduleEnabled: registration.enabled,
      featureEnabled: feature.enabled,
      tenantScope: registration.tenantScope,
      tenantCount,
      rows,
      nextCursor,
    };
  }

  /**
   * Grants the feature to 1-64 named tenants. `skipDuplicates` makes a repeated id — or a tenant that
   * already holds the feature — a no-op instead of a `409`: a grant STATES a desired state, and
   * re-stating it is not an error. The count returned is what the call actually ADDED.
   */
  async grant(
    moduleId: string,
    featureId: string,
    tenantIds: string[],
    actorId: string
  ): Promise<{ granted: number }> {
    const feature = await this.loadFeatureOrThrow(moduleId, featureId);
    const unique = Array.from(new Set(tenantIds));

    let granted = 0;
    try {
      const result = await this.prisma.moduleFeatureGrant.createMany({
        data: unique.map((tenantId) => ({ featureRowId: feature.id, tenantId })),
        skipDuplicates: true,
      });
      granted = result.count;
    } catch (err) {
      // P2003 is the tenant foreign key: the only other foreign key in this insert was just read.
      if (errorCode(err) === 'P2003') {
        throw new BadRequestException('شناسه مستأجر نامعتبر است.');
      }
      throw err;
    }

    if (granted > 0) {
      await this.record(MODULE_FEATURE_ACTIONS.GRANTED, moduleId, featureId, actorId, {
        tenantIds: unique,
        granted,
      });
    }

    return { granted };
  }

  /**
   * Revokes one grant by DELETING it — presence is the grant, so there is no flag to flip and nothing
   * that can outlive the statement. A revoke that removes nothing is a `404` and writes no audit row:
   * the operator's list was stale, and saying so is more useful than a silent success.
   */
  async revoke(
    moduleId: string,
    featureId: string,
    tenantId: string,
    actorId: string
  ): Promise<{ revoked: true }> {
    const feature = await this.loadFeatureOrThrow(moduleId, featureId);

    const result = await this.prisma.moduleFeatureGrant.deleteMany({
      where: { featureRowId: feature.id, tenantId },
    });

    if (result.count === 0) {
      throw new NotFoundException('این مستأجر مجوز این قابلیت را ندارد.');
    }

    await this.record(MODULE_FEATURE_ACTIONS.REVOKED, moduleId, featureId, actorId, { tenantId });

    return { revoked: true };
  }

  /**
   * The module must be REGISTERED before it can declare anything, and the `404` states the same fact
   * the registry's own routes state. The message is spelled here rather than imported from the
   * registry module: platform code reaching into `module-platform` would be the dependency direction
   * this phase exists to prevent.
   */
  /** The module row this surface's scope questions are answered from. */
  private async loadRegistrationOrThrow(moduleId: string): Promise<RegistrationScopeRow> {
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      select: { id: true, enabled: true, tenantScope: true, tenantIds: true },
    });

    if (!registration) throw new NotFoundException('ماژول ثبت‌نشده است.');

    return registration;
  }

  /**
   * One ordered page of the module's tenant enumeration, keyset-filtered by `after`.
   *
   * The three scopes answer differently and deliberately: `RESTRICTED_MEMBERS` reads the D16 child
   * table — ITS ONLY membership source, because the replacement CHECK requires the legacy array to be
   * empty for such a row — `RESTRICTED` reads the legacy array, and `ALL` enumerates nobody. An
   * unrecognised scope enumerates nobody too: this read must not be the one place a fourth enum member
   * silently acquires a meaning.
   */
  private async enumerationPage(
    registration: RegistrationScopeRow,
    after: string | null,
    take: number
  ): Promise<string[]> {
    switch (registration.tenantScope) {
      case ModuleTenantScope.RESTRICTED_MEMBERS: {
        const rows = await this.prisma.moduleRegistrationTenant.findMany({
          where: {
            registrationId: registration.id,
            ...(after ? { tenantId: { gt: after } } : {}),
          },
          orderBy: { tenantId: 'asc' },
          take,
          select: { tenantId: true },
        });

        return rows.map((row) => row.tenantId);
      }

      case ModuleTenantScope.RESTRICTED: {
        // The array is bounded at 64 by its CHECK, so this is a slice of an already-small list and
        // never a second query.
        const ids = [...registration.tenantIds].sort();
        const from = after === null ? 0 : ids.findIndex((id) => id > after);

        return from === -1 ? [] : ids.slice(from, from + take);
      }

      default:
        return [];
    }
  }

  /** The enumeration's SIZE, or `null` for `ALL` — which enumerates nobody and cannot be counted. */
  private async enumerationCount(registration: RegistrationScopeRow): Promise<number | null> {
    switch (registration.tenantScope) {
      case ModuleTenantScope.RESTRICTED_MEMBERS:
        return this.prisma.moduleRegistrationTenant.count({
          where: { registrationId: registration.id },
        });

      case ModuleTenantScope.RESTRICTED:
        return registration.tenantIds.length;

      default:
        return null;
    }
  }

  /** One ordered page of the tenants that HOLD this feature, keyset-filtered by `after`. */
  private async grantPage(
    featureRowId: string,
    after: string | null,
    take: number
  ): Promise<string[]> {
    const rows = await this.prisma.moduleFeatureGrant.findMany({
      where: {
        featureRowId,
        ...(after ? { tenantId: { gt: after } } : {}),
      },
      orderBy: { tenantId: 'asc' },
      take,
      select: { tenantId: true },
    });

    return rows.map((row) => row.tenantId);
  }

  private async assertModuleRegistered(moduleId: string): Promise<void> {
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId },
      select: { moduleId: true },
    });

    if (!registration) throw new NotFoundException('ماژول ثبت‌نشده است.');
  }

  private async loadFeatureOrThrow(
    moduleId: string,
    featureId: string
  ): Promise<FeatureRow & { _count: { grants: number } }> {
    const feature = await this.prisma.moduleFeature.findUnique({
      where: { moduleId_featureId: { moduleId, featureId } },
      include: { _count: { select: { grants: true } } },
    });

    if (!feature) throw new NotFoundException('قابلیت اعلام‌شده برای این ماژول یافت نشد.');

    return feature;
  }

  private toSummary(row: FeatureRow, grantedTenantCount: number): ModuleFeatureSummary {
    return {
      id: row.id,
      moduleId: row.moduleId,
      featureId: row.featureId,
      displayName: row.displayName,
      enabled: row.enabled,
      grantedTenantCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * One audit row, through the SAME boundary the registry's mutations use. `resourceId` is the
   * operator-meaningful identity of the feature row — `moduleId:featureId` — because that pair is what
   * an administrator reads in the trail; a surrogate id would turn "who turned Leave off?" into a
   * database lookup instead of a search.
   */
  private async record(
    action: string,
    moduleId: string,
    featureId: string,
    actorId: string,
    newValue: Record<string, unknown>,
    oldValue?: Record<string, unknown>
  ): Promise<void> {
    if (!this.audit) return;

    const context = RequestContextService.get();

    try {
      await this.audit.log({
        requestId: context?.requestId ?? 'platform-entitlement',
        correlationId: context?.correlationId,
        userId: actorId,
        action,
        resource: MODULE_FEATURE_AUDIT_RESOURCE,
        resourceId: `${moduleId}:${featureId}`,
        oldValue,
        newValue,
        success: true,
      });
    } catch (err) {
      this.logger.warn(
        { action, err: err instanceof Error ? err.message : 'unknown' },
        'Module feature audit write failed'
      );
    }
  }
}
