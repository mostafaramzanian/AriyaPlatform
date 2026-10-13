import { Injectable, Logger } from '@nestjs/common';
import {
  MODULE_ACTOR_HEADER,
  MODULE_CORRELATION_HEADER,
  MODULE_ID_HEADER,
  MODULE_PROTOCOL_HEADER,
  MODULE_REQUEST_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TENANT_HEADER,
  MODULE_TIMESTAMP_HEADER,
  signModuleRequest,
} from './module-signature';
import { buildModuleUrl, evaluateModuleEndpoint } from './module-url.guard';
import {
  MAX_MODULE_PAYLOAD_BYTES,
  MODULE_PROTOCOL_VERSION,
  type ModuleCallContext,
  type ModuleCallRequest,
  type ModuleCallResult,
  type ModuleDeploymentModeValue,
  type ModuleTransport,
  type ResolvedModuleInstance,
} from './module.contract';

/**
 * Phase 49M §24/§25/§26: the HTTP transport, and the ONLY file that knows a module is
 * reached over a network.
 *
 * ONE TRANSPORT FOR EVERY DEPLOYMENT MODE — THE §25/§35 REQUIREMENT, LITERALLY
 * ---------------------------------------------------------------------------
 * `modes` below lists all four. There is no `LocalTransport` and no `RemoteTransport`,
 * because §25 is explicit that LOCAL "may still use the same contract" and that two business
 * paths must not exist. The consequence is worth stating plainly: moving a module from LOCAL
 * to REMOTE changes ONE COLUMN and no code at all — same client, same transport, same
 * contract, same signature, same response handling.
 *
 * What DOES vary by mode is the NETWORK POLICY, and it varies in exactly one place: the
 * endpoint policy call below, which requires HTTPS off-host. That is a transport concern by
 * definition, and it reads `deploymentMode` — never `moduleId`. Grep for a module name in
 * this file and you will find none, because none can exist: the method receives a resolved
 * instance and has no way to ask what business domain it serves.
 *
 * IN-PROCESS TRANSPORT IS DELIBERATELY NOT BUILT. §25 permits it "only if proven necessary",
 * and nothing has proven it: there is no in-process module in this repository to dispatch to,
 * and building a second transport for a hypothetical caller would create the two-path
 * situation the section forbids. A LOCAL instance today therefore registers an endpoint
 * (`http://localhost:PORT`) and is called over loopback HTTP — one path, measurable, with no
 * special case.
 *
 * TRANSPORT IS THE GLOBAL `fetch`, matching `N8nIntegrationProvider` (49L), `OpenAIProvider`
 * (49J) and `HealthService`. No HTTP client dependency is added: `axios` IS in
 * `apps/api/package.json` but nothing under `src/` imports it (re-verified for this phase),
 * so using it here would activate a dormant dependency for no benefit.
 * `AbortSignal.timeout` is used rather than a bare `setTimeout` + `AbortController` pair
 * because its timer is unref'd, so a pending call cannot hold the event loop — or a Jest run
 * — open.
 *
 * NOTHING IS LOGGED THAT COULD CARRY A SECRET OR A PAYLOAD (§23). What is logged: module id,
 * instance id, contract, operation, status code, duration. Not the signature, not the
 * headers, not the request body, not the response body.
 */

/** Only 2xx counts as success. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Bytes of a module response we are willing to read.
 *
 * Bounded for the same reason 49L bounds its response read, and larger because a module
 * response is legitimately domain data rather than an acknowledgement. A module that streams
 * indefinitely — hostile or merely broken — cannot exhaust this process's memory.
 */
const MAX_RESPONSE_BYTES = MAX_MODULE_PAYLOAD_BYTES;

/** Path every module serves for the base contract. Fixed, so no caller can choose it. */
export const MODULE_INVOKE_PATH = '/module/v1/invoke';

@Injectable()
export class ModuleHttpTransport implements ModuleTransport {
  /** Every mode. See the class comment: one transport, by design. */
  readonly modes: readonly ModuleDeploymentModeValue[] = ['LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID'];

  private readonly logger = new Logger(ModuleHttpTransport.name);

  /**
   * Delivers one call and returns a NORMALIZED result.
   *
   * NEVER THROWS. Every failure — a rejected endpoint, an over-large payload, a timeout, an
   * unreachable host, a 4xx, a 5xx, an unparseable body — comes back as `ok: false` with a
   * short code, because §27 requires that an unavailable module must not crash Core and a
   * rejected promise here would surface as a 500 in whoever made the call.
   */
  async send<TData = unknown>(
    instance: ResolvedModuleInstance,
    request: ModuleCallRequest,
    context: ModuleCallContext,
  ): Promise<ModuleCallResult<TData>> {
    // An instance with no endpoint cannot be called over this transport. The resolver already
    // filters these out; it is re-checked because the type permits null and a null URL would
    // otherwise reach `new URL()` as the string "null".
    if (!instance.baseUrl) {
      return { ok: false, errorCode: 'MODULE_UNAVAILABLE', instanceId: instance.instanceId };
    }

    // §40, applied AGAIN immediately before the request rather than trusted from registration
    // time: `INTEGRATION_ALLOW_PRIVATE_TARGETS` is environment configuration and can be revoked
    // without the row changing, and a stored endpoint that was legal last week must not still
    // be dialled this week.
    const policy = evaluateModuleEndpoint(instance.baseUrl, instance.deploymentMode);

    if (!policy.ok) {
      this.logger.warn(
        { moduleId: instance.moduleId, instanceId: instance.instanceId, reason: policy.errorCode },
        'Module call blocked by endpoint policy',
      );

      return { ok: false, errorCode: 'SSRF_BLOCKED', instanceId: instance.instanceId };
    }

    let url: string;

    try {
      url = buildModuleUrl(instance.baseUrl, MODULE_INVOKE_PATH);
    } catch {
      return { ok: false, errorCode: 'SSRF_BLOCKED', instanceId: instance.instanceId };
    }

    /**
     * THE WIRE ENVELOPE.
     *
     * `tenantId` and `actor` travel in the BODY as well as in headers because both are covered
     * by the signature through the canonical string — see `moduleSignatureMaterial`. The
     * receiving module must read the tenant from the SIGNED material, never from an unsigned
     * header, which is what makes §21 enforceable at the far end rather than merely intended at
     * this one.
     */
    const envelope = {
      protocolVersion: MODULE_PROTOCOL_VERSION,
      contract: request.contract,
      operation: request.operation,
      requestId: context.requestId,
      correlationId: context.correlationId,
      tenantId: context.tenant.tenantId,
      ...(context.actor
        ? { actor: { actorId: context.actor.actorId, actorType: context.actor.actorType } }
        : {}),
      payload: request.payload,
    };

    const body = JSON.stringify(envelope);

    // Bounded BEFORE the request, on the serialised form — which is what crosses the wire and
    // what the signature covers. Refused rather than truncated: a truncated payload would be a
    // silently different request.
    if (Buffer.byteLength(body, 'utf8') > MAX_MODULE_PAYLOAD_BYTES) {
      return { ok: false, errorCode: 'PAYLOAD_TOO_LARGE', instanceId: instance.instanceId };
    }

    const timestamp = String(Date.now());
    const signature = signModuleRequest(context.secret, {
      method: 'POST',
      path: new URL(url).pathname,
      timestamp,
      identity: {
        moduleId: instance.moduleId,
        requestId: context.requestId,
        tenantId: context.tenant.tenantId,
      },
      body,
    });

    const startedAt = Date.now();
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [MODULE_SIGNATURE_HEADER]: signature,
          [MODULE_TIMESTAMP_HEADER]: timestamp,
          [MODULE_ID_HEADER]: instance.moduleId,
          [MODULE_REQUEST_HEADER]: context.requestId,
          [MODULE_CORRELATION_HEADER]: context.correlationId,
          [MODULE_PROTOCOL_HEADER]: String(MODULE_PROTOCOL_VERSION),
          // Sent so the far end can read them without parsing the body; both are ALSO in the
          // signed body, and the receiver must trust the signed copy.
          ...(context.tenant.tenantId ? { [MODULE_TENANT_HEADER]: context.tenant.tenantId } : {}),
          ...(context.actor ? { [MODULE_ACTOR_HEADER]: context.actor.actorId } : {}),
        },
        body,
        signal: AbortSignal.timeout(context.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';

      // The caught error is NOT spread into the log: a fetch failure message can include the
      // full URL, which is operator infrastructure detail (§39).
      this.logger.warn(
        {
          moduleId: instance.moduleId,
          instanceId: instance.instanceId,
          contract: request.contract,
          operation: request.operation,
          durationMs: Date.now() - startedAt,
          reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
        },
        'Module call failed before a response was received',
      );

      return {
        ok: false,
        errorCode: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
        instanceId: instance.instanceId,
        correlationId: context.correlationId,
      };
    }

    return this.interpret<TData>(instance, request, context, response, startedAt);
  }

  /**
   * Turns a received response into a normalized result.
   *
   * Split out of `send` so the failure-before-response path and the failure-after-response path
   * are visibly separate: they produce different codes and only one of them has a status to
   * report.
   */
  private async interpret<TData>(
    instance: ResolvedModuleInstance,
    request: ModuleCallRequest,
    context: ModuleCallContext,
    response: Response,
    startedAt: number,
  ): Promise<ModuleCallResult<TData>> {
    const durationMs = Date.now() - startedAt;

    if (!isSuccess(response.status)) {
      this.logger.warn(
        {
          moduleId: instance.moduleId,
          instanceId: instance.instanceId,
          contract: request.contract,
          operation: request.operation,
          status: response.status,
          durationMs,
        },
        'Module rejected the call',
      );

      // `HTTP_<status>` and nothing else: the upstream body is never surfaced, because a
      // module's error message can echo request content back to a caller that must not see it.
      return {
        ok: false,
        errorCode: `HTTP_${response.status}`,
        instanceId: instance.instanceId,
        correlationId: context.correlationId,
      };
    }

    const data = await this.readBody<TData>(response);

    if (data === undefined) {
      return {
        ok: false,
        errorCode: 'INVALID_RESPONSE',
        instanceId: instance.instanceId,
        correlationId: context.correlationId,
      };
    }

    this.logger.log(
      {
        moduleId: instance.moduleId,
        instanceId: instance.instanceId,
        contract: request.contract,
        operation: request.operation,
        status: response.status,
        durationMs,
      },
      'Module call succeeded',
    );

    return {
      ok: true,
      data,
      instanceId: instance.instanceId,
      correlationId: context.correlationId,
    };
  }

  /**
   * Reads and parses a bounded response body.
   *
   * Returns UNDEFINED for an unparseable or over-large body rather than throwing, so the caller
   * reports `INVALID_RESPONSE` instead of raising. An empty body is a legal "no data" answer and
   * resolves to `null`, which is distinguishable from `undefined` — the difference between "the
   * module said nothing" and "the module said something we could not read".
   */
  private async readBody<TData>(response: Response): Promise<TData | undefined> {
    try {
      const text = await response.text();

      if (text.length > MAX_RESPONSE_BYTES) return undefined;
      if (!text) return null as TData;

      const parsed: unknown = JSON.parse(text);

      if (!parsed || typeof parsed !== 'object') return undefined;

      // The module answers `{ data: … }`; anything else is a contract violation rather than
      // something to guess at. `data` may legitimately be absent, meaning "no payload".
      const record = parsed as { data?: unknown };
      return (record.data ?? null) as TData;
    } catch {
      return undefined;
    }
  }
}


