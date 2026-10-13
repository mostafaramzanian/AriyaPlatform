/**
 * Phase 49M: the provider-neutral, DEPLOYMENT-NEUTRAL module contract.
 *
 * THIS FILE IS THE BOUNDARY, in exactly the sense `integration.contract.ts` (49L) is
 * the boundary for automation. Everything a caller needs in order to reach another
 * module is declared here, and nothing here mentions a hostname, a URL, an HTTP verb,
 * a header, a signature — or a business domain. There is no `HR`, no `FINANCE`, no
 * `employee`, no `invoice`: a module exists because a row exists, never because this
 * file was edited.
 *
 * THE ONE ARCHITECTURAL RULE THIS FILE ENFORCES
 * ---------------------------------------------
 * Local/Remote is a property of DEPLOYMENT, not of a business domain. The call path is
 *
 *     ModuleResolver → ModuleInstance → Transport → Contract
 *
 * and it is the SAME path for every module. A caller says `moduleId` and `contract`;
 * it never learns where the module runs, and it has nothing to branch on if it wanted
 * to. `deploymentMode` appears in this file exactly twice: as an enum-mirroring type,
 * and on the resolved instance the TRANSPORT layer reads. No business type carries it.
 *
 * WHY THIS IS A NEW CONTRACT RATHER THAN AN EXTENSION OF 49L's
 * -----------------------------------------------------------
 * 49L's `IntegrationEvent` is a ONE-WAY, FIRE-AND-FORGET envelope addressed to
 * "whatever automation engine is configured", with a closed event-type enum and no
 * response type at all — `IntegrationProviderResult` carries `accepted` and an opaque
 * reference, deliberately nothing a caller could branch on. That is right for
 * automation and wrong for module invocation, which is REQUEST/RESPONSE, ADDRESSED to
 * one logical module, and needs a typed reply.
 *
 * So 49M EXTENDS 49L rather than competing with it, in three concrete ways:
 *   1. the SAME HMAC scheme, canonicalisation and secret store (see
 *      `module-signature.ts`, which re-uses `integration-signature.ts` outright);
 *   2. the SAME SSRF policy module (`integration-url.guard.ts`), re-used rather than
 *      re-implemented, so there is ONE place that decides what a destination may be;
 *   3. the SAME correlation-id propagation via `RequestContextService`.
 * What is NOT reused is the ENVELOPE, because a request that expects an answer is not
 * an event, and pretending otherwise would mean adding a response field to an event
 * type that 49L guarantees has none.
 */

/**
 * Version of the PLATFORM protocol: registration, discovery, health, signing.
 *
 * Bumped only when one of those shapes changes — never for a module's own version and
 * never for a business contract. A module announcing a different major is
 * INCOMPATIBLE and is not partially activated (§18).
 */
export const MODULE_PROTOCOL_VERSION = 1;

/**
 * Bound on a serialised cross-module request or response body.
 *
 * 256 KiB, four times 49L's envelope bound, and the difference is deliberate: an
 * automation envelope is minimised metadata (§11 of 49L), while a module response is
 * legitimately a page of domain data. It is still bounded, because an unbounded read
 * from a remote module is a memory-exhaustion vector regardless of who deployed it.
 */
export const MAX_MODULE_PAYLOAD_BYTES = 256 * 1024;

/** Per-call timeout bounds, in milliseconds. Mirrors the 49L clamp. */
export const MIN_MODULE_TIMEOUT_MS = 1_000;
export const MAX_MODULE_TIMEOUT_MS = 30_000;
export const DEFAULT_MODULE_TIMEOUT_MS = 10_000;

/**
 * How long an instance may go unheard-from before it is considered stale.
 *
 * 90 seconds against a 30-second heartbeat: three missed beats, not one, so a single
 * slow tick or a brief network blip does not flap a healthy module to UNAVAILABLE.
 * §14 asks for a bounded interval and a stale threshold; these are both.
 */
export const MODULE_HEARTBEAT_INTERVAL_MS = 30_000;
export const MODULE_STALE_AFTER_MS = 90_000;

/** Mirrors the `ModuleType` enum. */
export type ModuleTypeValue = 'CORE' | 'BUSINESS' | 'INTEGRATION';

/**
 * Mirrors the `ModuleDeploymentMode` enum.
 *
 * READ THIS BEFORE USING IT: no business module may branch on this value. It exists
 * for the TRANSPORT layer, which uses it to choose a network policy — and for the
 * admin UI, which displays it. `ModuleClient.call` does not accept it, does not return
 * it, and cannot be influenced by it.
 */
export type ModuleDeploymentModeValue = 'LOCAL' | 'REMOTE' | 'CENTRAL' | 'HYBRID';

/** Mirrors the `ModuleLifecycleState` enum. */
export type ModuleLifecycleValue =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'DISABLED'
  | 'DEREGISTERED'
  | 'INCOMPATIBLE';

/** Mirrors the `ModuleHealthState` enum. */
export type ModuleHealthValue = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'DISABLED' | 'UNKNOWN';

/**
 * Lifecycle states in which an instance may be RESOLVED and CALLED.
 *
 * Declared as data rather than as a condition, so the resolver, the staleness sweep and
 * the admin projection all agree by construction. REGISTERED is deliberately absent: a
 * module that has never been confirmed healthy is not a resolution target, because
 * returning it would make the first real request also the first health check.
 */
export const RESOLVABLE_LIFECYCLES: readonly ModuleLifecycleValue[] = ['ACTIVE', 'DEGRADED'];

/**
 * Lifecycle states from which an instance can still become stale.
 *
 * MUST match the partial-index predicate in
 * `20260905120000_add_module_platform/migration.sql`. Terminal and already-unavailable
 * rows are excluded, which is what keeps the sweep bounded to rows it could act on.
 */
export const SWEEPABLE_LIFECYCLES: readonly ModuleLifecycleValue[] = [
  'REGISTERED',
  'ACTIVE',
  'DEGRADED',
];

/**
 * A capability identifier, e.g. `invoice.read`.
 *
 * A PLAIN STRING, NOT AN ENUM AND NOT A UNION. Capabilities are declared by whichever
 * module owns them; an enum here would mean Core must ship a release before a module
 * can gain a capability, which is precisely the coupling §9 forbids. Core MATCHES these
 * strings and never parses them for meaning — there is no `if (capability.startsWith(…))`
 * anywhere in this phase.
 */
export type ModuleCapabilityId = string;

/** Shape a capability id must satisfy: lower-case dotted/dashed segments. */
export const CAPABILITY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const MAX_CAPABILITY_LENGTH = 96;

/** Shape a contract descriptor must satisfy: `name@v<major>`, e.g. `module.invoke@v1`. */
export const CONTRACT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*@v[0-9]+$/;
export const MAX_CONTRACT_LENGTH = 120;

/**
 * The ONE API contract this phase defines, and the reason there is only one.
 *
 * `module.invoke@v1` is a generic, domain-free request/response envelope: an operation
 * name, a payload, an answer. Defining `invoice.create@v1` here would mean Core owns
 * the shape of a business operation it does not implement — the exact coupling §3
 * forbids. A module declaring a richer contract simply lists it in `apiContracts`; Core
 * matches the string and routes the call without understanding it.
 */
export const CORE_MODULE_CONTRACT = 'module.invoke@v1';

/**
 * The health contract every registered module must serve.
 *
 * A CONTRACT rather than "GET /health returns 200", because §13 is explicit that a 200
 * alone is not application health. A module answers with a state it declares; a 200
 * with no declared state resolves to DEGRADED, never HEALTHY.
 */
export const MODULE_HEALTH_CONTRACT = 'module.health@v1';

/**
 * Stable identity of a logical module and of one of its deployments (§5).
 *
 * TWO FIELDS THAT ARE NEVER CONFLATED. `moduleId` answers "which module"; `instanceId`
 * answers "which deployment of it". Everything addressable is keyed by the first;
 * everything observable — health, version, endpoint — belongs to the second.
 */
export interface ModuleIdentity {
  moduleId: string;
  instanceId: string;
}

/**
 * What a module declares about itself when it registers (§7).
 *
 * WHAT IS ABSENT IS THE POINT. There is no `enabled`, no `tenantScope`, no `tenantIds`,
 * no `permissions` and no `trusted` flag, because §8 forbids trusting a self-declared
 * tenant scope or self-declared permissions. Those live on the REGISTRATION, which only
 * the permission-gated admin API writes. A module can describe itself; it cannot admit
 * itself, widen its own tenant reach or grant itself anything.
 */
export interface ModuleRegistrationRequest {
  moduleId: string;
  instanceId: string;
  /** The module's own semantic version, e.g. `1.2.0`. */
  version: string;
  /** DEPLOYMENT metadata (§6). Recorded, never used to select a code path. */
  deploymentMode: ModuleDeploymentModeValue;
  /** Origin only. Required for every mode except LOCAL; validated against the SSRF policy. */
  baseUrl?: string;
  healthPath?: string;
  capabilities?: ModuleCapabilityId[];
  apiContracts?: string[];
  eventContracts?: string[];
  /** The platform protocol the module speaks. Compared, never trusted (§18). */
  protocolVersion: number;
}

/**
 * The registry's answer to a registration attempt.
 *
 * `accepted: false` with a `lifecycle` of INCOMPATIBLE is a NORMAL, fully-recorded
 * outcome, not an error: §18 requires that an incompatible module is not partially
 * activated, and recording the attempt is how an operator finds out why a module they
 * deployed is not serving. `reason` is a SHORT CODE, never an internal message.
 */
export interface ModuleRegistrationResult {
  accepted: boolean;
  identity: ModuleIdentity;
  lifecycle: ModuleLifecycleValue;
  /** `PROTOCOL_MISMATCH` / `MODULE_DISABLED` / `CONTRACT_MISSING` / `ENDPOINT_REJECTED`. */
  reason?: string;
  /** Heartbeat cadence the module should adopt. Server-chosen and bounded (§14). */
  heartbeatIntervalMs: number;
}

/**
 * One resolved, callable instance — the output of discovery and the input to transport.
 *
 * THIS IS THE ONLY TYPE IN THE PHASE THAT CARRIES BOTH A LOCATION AND A DEPLOYMENT
 * MODE, and it is deliberately NOT what a business caller receives: `ModuleClient.call`
 * consumes it internally and returns only `ModuleCallResult`. That asymmetry is what
 * makes §11's "no hard-coded module URLs" and §35's "no deploymentMode branching in
 * business code" structural rather than aspirational — a caller has no object to read
 * a URL off.
 */
export interface ResolvedModuleInstance {
  moduleId: string;
  instanceId: string;
  version: string;
  deploymentMode: ModuleDeploymentModeValue;
  /** Null only for a LOCAL in-process instance. */
  baseUrl: string | null;
  healthPath: string;
  capabilities: readonly ModuleCapabilityId[];
  apiContracts: readonly string[];
  lifecycle: ModuleLifecycleValue;
  health: ModuleHealthValue;
  lastSeenAt: Date | null;
}

/**
 * A cross-module request, as a caller expresses it.
 *
 * FOUR THINGS A CALLER CANNOT SAY HERE, each an absence with a reason:
 *   - a URL, a host or a port — the destination is resolved (§11/§24);
 *   - a header, a token or a signature — transport owns those (§24);
 *   - a tenant — it comes from the authenticated request context (§21), never from the
 *     caller's payload, so a module cannot be asked to act for another tenant;
 *   - an instance — the resolver picks among candidates (§12), so a caller cannot pin
 *     traffic to one deployment and quietly re-create a single-instance assumption.
 */
export interface ModuleCallRequest<TPayload = unknown> {
  /** LOGICAL module id. Never an instance id, never a URL. */
  moduleId: string;
  /** Contract descriptor, e.g. `module.invoke@v1`. */
  contract: string;
  /** Operation within the contract, e.g. `invoice.create`. Opaque to Core. */
  operation: string;
  payload: TPayload;
  /** Optional per-call override, clamped to the platform bounds. */
  timeoutMs?: number;
  /**
   * Stable id so a retried business operation is not duplicated downstream. Defaults to
   * a fresh UUID. Reuses 49L's idempotency idea rather than inventing a second one.
   */
  requestId?: string;
}

/**
 * NORMALIZED outcome of a cross-module call (§24).
 *
 * No transport detail appears here: no HTTP status, no headers, no response object, no
 * retry counter, no endpoint. A caller learns whether it got an answer, an opaque
 * payload if it did, and a SHORT CODE if it did not. That is the whole surface, which is
 * what keeps a business module from growing a branch on how a module happens to be
 * deployed.
 */
export interface ModuleCallResult<TData = unknown> {
  ok: boolean;
  data?: TData;
  /**
   * `MODULE_UNAVAILABLE` / `MODULE_NOT_FOUND` / `MODULE_FORBIDDEN` / `CONTRACT_UNSUPPORTED`
   * / `TIMEOUT` / `UNREACHABLE` / `HTTP_<status>` / `SSRF_BLOCKED` / `PAYLOAD_TOO_LARGE`
   * / `INVALID_RESPONSE`. Short, internal, safe to log and to show an operator.
   */
  errorCode?: string;
  /** Which instance answered, for tracing. Never an endpoint. */
  instanceId?: string;
  /** Echo of the correlation id used, so a caller can log one identifier end to end. */
  correlationId?: string;
}

/**
 * The minimal actor context carried across a module boundary (§22).
 *
 * TWO FIELDS, AND THE LIST OF WHAT IS EXCLUDED IS LONGER THAN THE TYPE: no email, no
 * display name, no role list, no permission list, no password, no token, no API key, no
 * session id, no JWT. A remote module that needs to know who acted needs an identifier;
 * anything more is data leaving Aria for no reason, and a token leaving Aria is a
 * credential leaving Aria. Identical in shape to 49L's `IntegrationActorContext`, on
 * purpose — one minimisation rule, applied twice.
 */
export interface ModuleActorContext {
  actorId: string;
  actorType: 'user' | 'system';
}

/**
 * Tenant context, as it crosses a module boundary (§21).
 *
 * DERIVED, NEVER ACCEPTED. Every instance of this type in the phase is built from
 * `RequestContextService`, which the `TenantContextInterceptor` populates from the
 * database using the verified JWT subject. Nothing constructs it from a request body,
 * a query parameter or a header, so a client cannot elevate the tenant a module acts
 * for, and a remote module cannot widen its own scope by echoing a different id back.
 *
 * `null` is a real value — a tenant-less platform actor — and is never treated as
 * "any tenant" by any authorization check.
 */
export interface ModuleTenantContext {
  tenantId: string | null;
}

/**
 * What a module's health endpoint is expected to answer (§13).
 *
 * `state` is REQUIRED, and that requirement is the §13 rule in type form: a body without
 * it cannot resolve to HEALTHY, so a module that returns `200 {}` is DEGRADED rather
 * than healthy. `checks` is optional, opaque and display-only — Core never interprets a
 * dependency name.
 */
export interface ModuleHealthReport {
  state: ModuleHealthValue;
  /** The module's own version, cross-checked against the registered instance. */
  version?: string;
  /** Optional named sub-checks. Booleans only: no messages, no internal detail. */
  checks?: Record<string, boolean>;
}

/**
 * The three-part health verdict §13 asks for, kept distinguishable.
 *
 * A single boolean would collapse "we have never heard of it", "we cannot reach it" and
 * "it is up but unwell" into one indistinguishable failure — which is exactly the
 * situation an operator is trying to tell apart at 3am.
 */
export interface ModuleHealthVerdict {
  /** Is the instance in the registry at all? */
  registryKnown: boolean;
  /** Did the endpoint answer? */
  endpointReachable: boolean;
  /** Did the application declare itself well? */
  applicationHealthy: boolean;
  state: ModuleHealthValue;
  /** Short internal code when something failed. Never an upstream body. */
  errorCode?: string;
}

/**
 * The transport port. ONE implementation per transport, never one per module.
 *
 * THE SIGNATURE IS THE SAME FOR LOCAL AND REMOTE (§25/§35): a resolved instance, a
 * request, and an authenticated context. There is no `sendLocal`/`sendRemote` pair and
 * no second business contract, so a module moving between LOCAL and REMOTE changes
 * which implementation is selected and nothing else.
 *
 * `send` MUST NOT THROW for a transport failure — the same rule 49L imposes on
 * `IntegrationProvider.send`, and for the same reason: a rejected promise here would
 * surface as a 500 in whatever business operation made the call, which §27 forbids.
 */
export interface ModuleTransport {
  /** Which deployment modes this implementation serves. */
  readonly modes: readonly ModuleDeploymentModeValue[];

  send<TData = unknown>(
    instance: ResolvedModuleInstance,
    request: ModuleCallRequest,
    context: ModuleCallContext,
  ): Promise<ModuleCallResult<TData>>;
}

/**
 * Everything transport needs that the CALLER does not supply.
 *
 * Assembled by `ModuleClient` from the request context and the resolved registration —
 * never from the caller's arguments. The secret is passed as a separate field rather
 * than hung off the instance, so a log line that dumps the instance cannot print the
 * credential (the same structural choice 49L makes in `IntegrationDispatchTarget`).
 */
export interface ModuleCallContext {
  tenant: ModuleTenantContext;
  actor?: ModuleActorContext;
  /** Carried through so one id traces caller → Core → module → response. */
  correlationId: string;
  requestId: string;
  /** Resolved shared secret. Never logged, never returned, never persisted here. */
  secret: string;
  timeoutMs: number;
}



