import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ModuleRegistryService } from './module-registry.service';
import { buildModuleUrl, evaluateModuleEndpoint } from './module-url.guard';
import {
  DEFAULT_MODULE_TIMEOUT_MS,
  MODULE_STALE_AFTER_MS,
  type ModuleHealthReport,
  type ModuleHealthValue,
  type ModuleHealthVerdict,
} from './module.contract';

/**
 * Phase 49M §13: module health, and the three facts it keeps apart.
 *
 * WHY A 200 IS NOT HEALTH
 * -----------------------
 * §13 is explicit: "Do not equate HTTP 200 alone with complete application health unless that
 * is the project convention." The audit answers the "unless": Core's OWN `/ready` endpoint
 * (`HealthService.getReadinessStatus`) returns per-dependency booleans and gates readiness on
 * the database specifically, so this repository's convention is already that health is a
 * DECLARED STATE rather than a status code. This service follows that convention:
 *
 *   registryKnown      — is the instance in the registry at all?
 *   endpointReachable  — did the endpoint answer?
 *   applicationHealthy — did the application DECLARE itself well?
 *
 * A 200 with no `state` in the body therefore resolves to DEGRADED, not HEALTHY. That is not
 * pedantry: a module behind a proxy that answers 200 while the module itself is down is the
 * single most common way a health check lies, and returning HEALTHY there would make the whole
 * mechanism decorative.
 *
 * PROBING IS EXPLICIT, NEVER AMBIENT (§14/§45). There is no interval in this class. The
 * `ModuleSweepService` runs the STALENESS pass — which is a database query, not a network call
 * — and probes happen only when an administrator presses "test connection" or when
 * `probeInstance` is called deliberately. That is the §45 requirement not to add discovery
 * calls to normal requests, and it is why a thousand page loads cost zero outbound requests.
 */
@Injectable()
export class ModuleHealthService {
  private readonly logger = new Logger(ModuleHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  /**
   * Probes ONE instance's health endpoint and records the verdict.
   *
   * NEVER THROWS (§27). Every failure — unknown instance, no endpoint, blocked endpoint,
   * timeout, unreachable, non-2xx, unparseable body, undeclared state — becomes a verdict with
   * a short code. A health check that can throw is a health check that can take down the page
   * displaying it.
   */
  async probeInstance(instanceId: string): Promise<ModuleHealthVerdict> {
    const instance = await this.prisma.moduleInstance.findUnique({
      where: { instanceId },
      select: {
        instanceId: true,
        deploymentMode: true,
        baseUrl: true,
        healthPath: true,
        version: true,
        registration: { select: { enabled: true } },
      },
    });

    // (a) registryKnown — false, and nothing else is even attempted. An unknown instance is not
    // probed, so this route cannot be used to make Core issue a request on behalf of a caller
    // who guessed an id.
    if (!instance) {
      return {
        registryKnown: false,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNKNOWN',
        errorCode: 'UNKNOWN_INSTANCE',
      };
    }

    // A DISABLED module is not probed at all. Probing it would produce a HEALTHY reading for a
    // module an administrator has switched off, which is a contradiction an operator would then
    // have to reconcile.
    if (!instance.registration.enabled) {
      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'DISABLED',
      };
    }

    if (!instance.baseUrl) {
      // A LOCAL in-process instance legitimately has no endpoint. There is nothing to probe, and
      // claiming HEALTHY on that basis would be inventing an observation.
      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNKNOWN',
        errorCode: 'NO_ENDPOINT',
      };
    }

    // §40 again, immediately before the request: the policy is environment configuration and can
    // change without the row changing.
    const policy = evaluateModuleEndpoint(instance.baseUrl, instance.deploymentMode);

    if (!policy.ok) {
      await this.registry.recordProbe(instance.instanceId, 'UNAVAILABLE', 'SSRF_BLOCKED');

      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: 'SSRF_BLOCKED',
      };
    }

    const verdict = await this.request(
      instance.baseUrl,
      instance.healthPath,
      instance.version,
    );

    await this.registry.recordProbe(instance.instanceId, verdict.state, verdict.errorCode);

    return verdict;
  }

  /**
   * The network half of a probe.
   *
   * SPLIT OUT so the resolution/policy decisions above are readable without the fetch noise, and
   * so the state-mapping rules below sit in one place.
   */
  private async request(
    baseUrl: string,
    healthPath: string,
    registeredVersion: string,
  ): Promise<ModuleHealthVerdict> {
    let url: string;

    try {
      url = buildModuleUrl(baseUrl, healthPath);
    } catch {
      // `buildModuleUrl` throws only when the path would change the origin — a stored `healthPath`
      // of `//evil.example/x`. Treated as blocked, not as unreachable.
      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: 'SSRF_BLOCKED',
      };
    }

    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        // `AbortSignal.timeout` rather than a manual controller: its timer is unref'd, so a pending
        // probe cannot hold the process — or a Jest run — open.
        signal: AbortSignal.timeout(DEFAULT_MODULE_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';

      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      };
    }

    if (response.status < 200 || response.status >= 300) {
      // REACHABLE BUT UNWELL — and the distinction matters: `endpointReachable: true` with
      // `applicationHealthy: false` tells an operator the network is fine and the module is not,
      // which is a completely different investigation from a timeout.
      return {
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: `HTTP_${response.status}`,
      };
    }

    const report = await this.readReport(response);

    // THE §13 RULE, IN ONE BRANCH: a 200 with no declared state is DEGRADED, never HEALTHY.
    if (!report) {
      return {
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: false,
        state: 'DEGRADED',
        errorCode: 'NO_HEALTH_STATE',
      };
    }

    // A VERSION MISMATCH IS DEGRADED, NOT UNAVAILABLE. The module is up and answering; what it is
    // not is the version the registry recorded, which usually means it was redeployed without
    // re-registering. Refusing to route to it would take down a working module over bookkeeping;
    // reporting HEALTHY would hide that the registry now describes something else.
    if (report.version && report.version !== registeredVersion) {
      return {
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: report.state === 'HEALTHY',
        state: 'DEGRADED',
        errorCode: 'VERSION_DRIFT',
      };
    }

    // A module MAY declare DEGRADED or UNAVAILABLE about itself, and that is believed: it knows
    // more about its own dependencies than a probe does. Anything else it declares — including a
    // state this platform does not recognise — is DEGRADED rather than trusted.
    const state: ModuleHealthValue =
      report.state === 'HEALTHY' || report.state === 'DEGRADED' || report.state === 'UNAVAILABLE'
        ? report.state
        : 'DEGRADED';

    return {
      registryKnown: true,
      endpointReachable: true,
      applicationHealthy: state === 'HEALTHY',
      state,
      ...(state === 'HEALTHY' ? {} : { errorCode: 'MODULE_REPORTED_UNHEALTHY' }),
    };
  }

  /**
   * Reads a bounded health body, or undefined.
   *
   * BOUNDED at 8 KiB: a health report is a state and a handful of booleans, so anything larger is
   * either a mistake or an attempt to make this endpoint expensive. `checks` is copied through
   * only for BOOLEAN values — a module returning
   * `{ checks: { db: "connection refused at 10.0.0.5:5432" } }` would otherwise put its internal
   * topology into Core's admin UI, which is precisely what §10 forbids.
   */
  private async readReport(response: Response): Promise<ModuleHealthReport | undefined> {
    try {
      const text = (await response.text()).slice(0, 8 * 1024);
      if (!text) return undefined;

      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return undefined;

      const record = parsed as { state?: unknown; version?: unknown; checks?: unknown };

      if (typeof record.state !== 'string') return undefined;

      const checks: Record<string, boolean> = {};

      if (record.checks && typeof record.checks === 'object' && !Array.isArray(record.checks)) {
        for (const [key, value] of Object.entries(record.checks as Record<string, unknown>)) {
          if (typeof value === 'boolean' && key.length <= 64) checks[key] = value;
        }
      }

      return {
        state: record.state as ModuleHealthValue,
        version: typeof record.version === 'string' ? record.version : undefined,
        checks,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * The registry's view of an instance, WITHOUT a network call.
   *
   * This is what the admin list and any UI badge use: it answers from stored state plus the
   * staleness clock, so rendering a page with twenty modules costs one query and zero outbound
   * requests (§45). `endpointReachable` here means "we heard from it recently", a weaker claim
   * than a live probe — which is why the admin projection returns `lastSeenAt` beside it rather
   * than presenting the two as equivalent.
   */
  async verdictFromRegistry(instanceId: string): Promise<ModuleHealthVerdict> {
    const instance = await this.prisma.moduleInstance.findUnique({
      where: { instanceId },
      select: {
        health: true,
        lastSeenAt: true,
        registration: { select: { enabled: true } },
      },
    });

    if (!instance) {
      return {
        registryKnown: false,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNKNOWN',
        errorCode: 'UNKNOWN_INSTANCE',
      };
    }

    if (!instance.registration.enabled) {
      return {
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'DISABLED',
      };
    }

    const fresh =
      instance.lastSeenAt !== null &&
      Date.now() - instance.lastSeenAt.getTime() <= MODULE_STALE_AFTER_MS;

    // A stale instance reads UNAVAILABLE regardless of the last health it reported: the last
    // report is old news, and presenting it as current is how a dead module keeps looking alive.
    const state: ModuleHealthValue = fresh
      ? (instance.health as ModuleHealthValue)
      : 'UNAVAILABLE';

    return {
      registryKnown: true,
      endpointReachable: fresh,
      applicationHealthy: fresh && instance.health === 'HEALTHY',
      state,
      ...(fresh ? {} : { errorCode: 'HEARTBEAT_STALE' }),
    };
  }
}


