import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RequestContextService } from '../common/request-context.service';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHttpTransport } from './module-http.transport';
import {
  DEFAULT_MODULE_TIMEOUT_MS,
  MAX_MODULE_TIMEOUT_MS,
  MIN_MODULE_TIMEOUT_MS,
  type ModuleActorContext,
  type ModuleCallRequest,
  type ModuleCallResult,
  type ModuleTransport,
} from './module.contract';

/**
 * Phase 49M §24/§35: the ONLY thing a business module is allowed to depend on.
 *
 * WHY THIS FAÇADE EXISTS GIVEN `ModuleRegistryService.resolve`
 * -----------------------------------------------------------
 * `ModuleRegistryService` also owns registration, credential rotation, admin writes and the
 * staleness sweep. A business module that imported it would gain the ability to rotate a
 * module's credential or disable a module from inside a request handler — not because anyone
 * would, but because the seam would permit it, and seams that permit the wrong thing
 * eventually get used for it. This is the same asymmetry 49L uses: `AutomationService` is
 * exported, `IntegrationService` is not.
 *
 * WHAT A CALLER CAN AND CANNOT SEE, WHICH IS THE §35 GUARANTEE
 * -----------------------------------------------------------
 * `call()` takes a LOGICAL module id and returns a normalized result. It does not accept a URL,
 * a host, an instance id, a deployment mode, a header, a token or a tenant; it does not return
 * an endpoint, a status code, a response object or a deployment mode. So a business module
 * CANNOT write
 *
 *     if (module === 'hr' && remote) …
 *
 * not because a rule forbids it, but because neither `'hr'`-specific behaviour nor `remote` is
 * reachable from here. The path is always
 *
 *     ModuleClient → ModuleResolver → ModuleInstance → Transport → Contract
 *
 * and it is the same path for finance, hr, correspondence and anything added later. Moving a
 * module between LOCAL and REMOTE changes a registration row; no caller changes at all.
 *
 * IT NEVER THROWS FOR AN UNAVAILABLE MODULE (§27). Resolution failures, transport failures and
 * missing credentials all come back as `ok: false` with a short code, so a Core operation that
 * consults an optional module stays functional when that module is absent — the behaviour §27
 * demands: "Finance unavailable → Finance-specific UI unavailable → Core remains functional".
 */
@Injectable()
export class ModuleClient {
  private readonly logger = new Logger(ModuleClient.name);

  /**
   * Transports are held as a LIST rather than a single class, so adding a second transport (an
   * in-process one, if §25's "proven necessary" is ever met) is a change here and not a change
   * to any caller. Today there is exactly one, and it serves all four deployment modes.
   */
  private readonly transports: readonly ModuleTransport[];

  constructor(
    private readonly registry: ModuleRegistryService,
    http: ModuleHttpTransport,
  ) {
    this.transports = [http];
  }

  /**
   * Calls one module and returns a normalized result.
   *
   * THE ORDER OF STEPS, AND WHY EACH FAILURE IS SEPARATE:
   *   1. RESOLVE — by logical id and required contract. A missing, disabled, tenant-forbidden,
   *      unhealthy or contract-incompatible module fails here with its own code, so an operator
   *      reading a log knows which of the five it was.
   *   2. CREDENTIAL — resolved separately from the instance, so it never travels on an object a
   *      caller holds. An absent or expired credential is a refusal, never an unsigned request.
   *   3. TRANSPORT — selected by deployment mode. This is the ONLY place the mode is read.
   *   4. SEND — bounded by a clamped timeout.
   */
  async call<TData = unknown, TPayload = unknown>(
    request: ModuleCallRequest<TPayload>,
  ): Promise<ModuleCallResult<TData>> {
    // (1) Discovery. The contract is passed through so an instance that no longer declares it is
    // not selected — §18 applied at call time, not only at registration.
    const resolution = await this.registry.resolve(request.moduleId, request.contract);

    if (!resolution.ok || !resolution.instance) {
      // §39: a controlled error with no network information. The caller learns the module is not
      // usable and nothing about the topology.
      return { ok: false, errorCode: resolution.failure ?? 'MODULE_UNAVAILABLE' };
    }

    const instance = resolution.instance;

    // (2) The credential, fetched on its own. `resolve` deliberately cannot return it.
    const secret = await this.registry.resolveSecret(request.moduleId);

    if (!secret) {
      // Refused rather than sent unsigned. An unsigned cross-module request is an unauthenticated
      // one, and "the credential was missing" is not a reason to make one.
      this.logger.warn(
        { moduleId: request.moduleId, instanceId: instance.instanceId },
        'Module call refused: no usable credential',
      );

      return { ok: false, errorCode: 'MODULE_FORBIDDEN', instanceId: instance.instanceId };
    }

    // (3) Transport selection — the one and only read of `deploymentMode` outside the guard.
    const transport = this.transports.find((candidate) =>
      candidate.modes.includes(instance.deploymentMode),
    );

    if (!transport) {
      // Unreachable today (one transport serves all four modes) and kept as a real branch: if a
      // future transport declares a narrower mode set, a missing one must be a controlled failure
      // rather than a TypeError deeper in the stack.
      this.logger.error(
        { moduleId: request.moduleId, deploymentMode: instance.deploymentMode },
        'No transport registered for deployment mode',
      );

      return { ok: false, errorCode: 'MODULE_UNAVAILABLE', instanceId: instance.instanceId };
    }

    const context = RequestContextService.get();

    // (4) §23: the correlation id is CARRIED, not regenerated, so one identifier traces user
    // request → Core → module → response. A fresh id here would break exactly the trace the
    // section asks for.
    const correlationId = context?.correlationId ?? randomUUID();

    return transport.send<TData>(instance, request, {
      // §21: the tenant comes from the trusted context, never from the caller's request. There is
      // no `request.tenantId` to read even if this line wanted to.
      tenant: { tenantId: context?.tenantId ?? null },
      actor: this.actorFromContext(),
      correlationId,
      requestId: request.requestId ?? randomUUID(),
      secret,
      timeoutMs: this.clampTimeout(request.timeoutMs),
    });
  }

  /**
   * Whether a module is currently usable, without calling it.
   *
   * For a UI that needs to hide a module-specific surface (§27) rather than invoke it. It reuses
   * `resolve`, so "available" means exactly what the call path means by it — a separate
   * definition here would eventually disagree with the one that matters.
   */
  async isAvailable(moduleId: string, contract?: string): Promise<boolean> {
    const resolution = await this.registry.resolve(moduleId, contract);
    return resolution.ok;
  }

  /**
   * Builds the minimal actor context from the current request (§22).
   *
   * A CONVENIENCE THAT ENFORCES MINIMISATION: the result carries `actorId` and `actorType` and
   * nothing else, so a caller cannot accidentally attach an email, a role list or a session by
   * reaching for `req.user` itself. When there is no authenticated user — a background pass, a
   * system-initiated change — it returns undefined rather than a synthetic actor, because "no
   * human did this" is information. Same shape and same reasoning as
   * `AutomationService.actorFromContext` (49L).
   */
  private actorFromContext(): ModuleActorContext | undefined {
    const userId = RequestContextService.get()?.userId;
    return userId ? { actorId: userId, actorType: 'user' } : undefined;
  }

  /**
   * Clamps a caller-supplied timeout into the platform bounds.
   *
   * CLAMPED RATHER THAN REJECTED, because a caller asking for five minutes is asking for a
   * behaviour the platform does not offer, and failing the call would be a worse answer than
   * capping it. The DTO already rejects out-of-range values on the HTTP surface; this protects
   * in-process callers, which have no DTO.
   */
  private clampTimeout(requested?: number): number {
    if (!requested || !Number.isFinite(requested)) return DEFAULT_MODULE_TIMEOUT_MS;

    return Math.min(Math.max(requested, MIN_MODULE_TIMEOUT_MS), MAX_MODULE_TIMEOUT_MS);
  }
}

