import { Injectable } from '@nestjs/common';
import { ModuleTenantScope } from '../../generated/core-client';
import { PrismaService } from '../../database/prisma.service';
import { RequestContextService } from '../../common/request-context.service';
import type {
  EntitlementDecision,
  EntitlementPort,
  EntitlementRequest,
} from './entitlement.contract';

/**
 * Phase 54-C (D14, §43.4): the ONE implementation of the frozen §43.2 decision order.
 *
 * WHAT THIS CLASS IS THE ONLY READER OF
 * -------------------------------------
 * `ModuleFeature` and `ModuleFeatureGrant` are read HERE and nowhere else in the tree. A
 * business module that could read a grant table would be deciding its own entitlement, which is
 * the coupling §43.6 forbids — so the surface is one port, and this is its implementation.
 *
 * WHAT IT READS AT THE MODULE LEVEL, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------------------
 * The module level is a NARROW, fail-closed read of the registry row: `enabled`,
 * `tenantScope`, `tenantIds`, plus — and only for a `RESTRICTED_MEMBERS` row — whether the
 * child table holds this tenant. It is NOT `ModuleRegistryService.resolve()`, and that is §43.1's
 * decision, not an oversight: `resolve()` is the OUTBOUND path and additionally demands a live,
 * fresh, contract-matching `ModuleInstance` (`module-registry.service.ts` L1058-L1121), which an
 * INBOUND request into a module's own API does not have and must not need. Using `resolve()`
 * here would refuse every request to every module that does not also run as a remote peer.
 *
 * THE THREE SCOPES, EACH WITH EXACTLY ONE MEMBERSHIP SOURCE (D16, §45.4)
 * ---------------------------------------------------------------------
 *  * `ALL`                  → no membership read at all. The scope is the answer.
 *  * `RESTRICTED`           → the legacy `tenantIds` array, and nothing else. Byte-identical to
 *                             what `resolve()` applies, so existing modules are unaffected.
 *  * `RESTRICTED_MEMBERS`   → the `ModuleRegistrationTenant` child table, and nothing else.
 *                             The array cannot be a second source of truth for such a row: the
 *                             replacement CHECK requires it to be EMPTY (§45.4 item 3).
 *
 * A scope the enum does not name refuses rather than admits. That branch is unreachable while
 * the enum has three members, and it exists because the failure mode it prevents — a fourth
 * member arriving and being silently admitted by a missing case — is the widening §45.4 was
 * written to make impossible.
 *
 * THE TENANT IS NEVER AN ARGUMENT (§25 rule 7, §21). It comes from
 * `RequestContextService`, the same source `resolve()` uses (`module-registry.service.ts`
 * L1079), so one request has one tenant authority. `null` is a real value and is checked as
 * one: a tenant-less caller is admitted only by an `ALL` module and can never match a grant.
 */

/**
 * The narrow registration read this service performs — the columns the decision needs and no
 * others. Declared here rather than reusing a Prisma payload type so the select and the fields
 * the decision reads cannot drift apart silently.
 */
interface RegistrationScopeRow {
  id: string;
  enabled: boolean;
  tenantScope: ModuleTenantScope;
  tenantIds: string[];
}

@Injectable()
export class PlatformEntitlementService implements EntitlementPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The frozen nine-step order of §43.2, each step able only to make the outcome MORE
   * restrictive. The steps are numbered in the spec; here they are the statement order, and
   * every `return` above the feature level is why a disabled module cannot be rescued by a
   * feature and a forbidden tenant never reaches the feature tables at all.
   *
   * THE TENANT IS THE AMBIENT ONE. This method reads it from `RequestContextService` and hands
   * it to `decideForTenant`, which holds the whole order — so the request path and the admin
   * path below share one evaluator and the order cannot be implemented twice.
   */
  async decide(input: EntitlementRequest): Promise<EntitlementDecision> {
    return this.decideForTenant(input, RequestContextService.get()?.tenantId ?? null);
  }

  /**
   * The SAME frozen order, asked about a tenant the CALLER NAMES (Phase 54-C closure fix, §43.8).
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT A WIDENING OF §25 RULE 7
   * ----------------------------------------------------------
   * The admin console has to tell an operator what the platform will decide for a tenant it is
   * CONFIGURING, and §43.8's console must not re-derive that answer in the browser: a second
   * implementation of the decision is exactly the drift that made HR's entitled tenants render as
   * `BLOCKED_BY_MODULE`. So the answer is asked for here, once per tenant, by the SAME code the
   * request path uses.
   *
   * Rule 7 forbids a client from selecting the TENANCY OF A REQUEST. This method does not: it is
   * not on `EntitlementPort`, no consumer can reach it (`platform-entitlement.module.ts` exports
   * the port token and nothing else), and the tenant it names is the SUBJECT of an administrative
   * question — the same distinction `GrantFeatureDto` documents for the grant body. The ambient
   * tenant is still the only tenant a REQUEST can be admitted under.
   *
   * `tenantId` is `string | null` because `null` is a real answer, not an omission: a tenant-less
   * caller is admitted only by an `ALL` module and can never match a grant (§43.2 steps 3 and 7).
   */
  async decideForTenant(
    input: EntitlementRequest,
    tenantId: string | null
  ): Promise<EntitlementDecision> {
    // Steps 1-3 — the module level.
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId: input.moduleId },
      select: { id: true, enabled: true, tenantScope: true, tenantIds: true },
    });

    if (!registration) return { ok: false, failure: 'MODULE_NOT_FOUND' };
    if (!registration.enabled) return { ok: false, failure: 'MODULE_DISABLED' };

    if (!(await this.tenantInScope(registration, tenantId))) {
      return { ok: false, failure: 'MODULE_FORBIDDEN' };
    }

    // Step 4 — the module level was the whole question.
    if (!input.featureId) return { ok: true };

    // Steps 5-6 — the feature is DECLARED, and the platform offers it.
    const feature = await this.prisma.moduleFeature.findUnique({
      where: { moduleId_featureId: { moduleId: input.moduleId, featureId: input.featureId } },
      select: { id: true, enabled: true },
    });

    if (!feature) return { ok: false, failure: 'FEATURE_NOT_FOUND' };
    if (!feature.enabled) return { ok: false, failure: 'FEATURE_DISABLED' };

    // Step 7 — a grant is a per-tenant row, so a tenant-less caller can never match one. The
    // grant table is not even queried for it: there is no key to query it with.
    if (tenantId === null) return { ok: false, failure: 'FEATURE_NOT_GRANTED' };

    // Step 8 — PRESENCE IS THE GRANT (D14, §43.3).
    const grant = await this.prisma.moduleFeatureGrant.findUnique({
      where: { featureRowId_tenantId: { featureRowId: feature.id, tenantId } },
      select: { id: true },
    });

    if (!grant) return { ok: false, failure: 'FEATURE_NOT_GRANTED' };

    // Step 9.
    return { ok: true };
  }

  /**
   * The module-level tenant check, EXHAUSTIVE over the scope members (D16, §45.4 item 3).
   *
   * A `switch` rather than an `if` chain, and with a refusing `default`, for the reason
   * `resolve()` is being given the same shape: the previous form of this check — "refuse when
   * the scope is `RESTRICTED` and the tenant is not listed" — admits every scope it does not
   * recognise, so adding an enum member would have WIDENED access silently. Here an
   * unrecognised scope is the one case that can never be admitted.
   */
  private async tenantInScope(
    registration: RegistrationScopeRow,
    tenantId: string | null
  ): Promise<boolean> {
    switch (registration.tenantScope) {
      case ModuleTenantScope.ALL:
        // No membership read: for an ALL-scoped module the scope itself is the answer, and
        // querying a membership table would be reading an input the decision does not use.
        return true;

      case ModuleTenantScope.RESTRICTED:
        // The legacy array, unchanged and un-extended (D16): 1-64 ids, enforced by the CHECK.
        return tenantId !== null && registration.tenantIds.includes(tenantId);

      case ModuleTenantScope.RESTRICTED_MEMBERS:
        return this.holdsMembership(registration.id, tenantId);

      default:
        return false;
    }
  }

  /**
   * THE one Core-owned membership read (D16, §45.4 item 4): presence of a row in
   * `ModuleRegistrationTenant` is the membership, keyed by the child table's own unique
   * constraint, so the lookup is index-covered and cannot return more than one row.
   *
   * `null` short-circuits to `false` before the query: "no tenant" is not a member of any
   * enumeration, and there is no key to look it up by.
   */
  private async holdsMembership(registrationId: string, tenantId: string | null): Promise<boolean> {
    if (tenantId === null) return false;

    const row = await this.prisma.moduleRegistrationTenant.findUnique({
      where: { registrationId_tenantId: { registrationId, tenantId } },
      select: { id: true },
    });

    return row !== null;
  }
}
