import type { ModuleOperationalStateValue } from './module-operational-state';

/**
 * Phase 49M-1: the ONE provisioning seam.
 *
 * WHY THIS FILE IS TYPES ONLY, AND WHY THAT IS NOT THE 49M SITUATION
 * -----------------------------------------------------------------
 * `module-foundations.ts` declares a `ModuleProvisioner` interface that NOTHING
 * implements, and its own header explains why: 49M was told to build extension points
 * and not implementations. This file is the opposite case — `LocalProvisioningProvider`
 * implements it and `ModuleProvisioningService` depends on it — so the interface is a
 * real seam rather than a placeholder.
 *
 * WHAT THE 49M INTERFACE IS AND IS NOT SUPERSEDED BY: `ModuleProvisioner.provision`
 * describes the four MANUAL steps 49M already performs (REGISTER, AUTHENTICATE, VERIFY,
 * ACTIVATE) and stays exactly as it is, still unimplemented, still imported only by the
 * admin projection and its own spec. This interface describes what a control plane DOES
 * to a deployment. Merging them would make `remainingProvisioningSteps` appear to
 * describe an execution it knows nothing about.
 *
 * THE INVARIANT THAT SHAPES EVERY SIGNATURE BELOW: **no method accepts a URL, a
 * hostname, a port, a command string, a shell fragment, an image name or a
 * credential value.** A provider is handed row-derived identifiers and resolves
 * everything else itself, so the probe-arbitrary-host and run-arbitrary-command
 * anti-patterns are unexpressible rather than merely refused. The audit found no
 * Docker/Kubernetes/SSH client and zero `child_process` usages in `src`; this file is
 * how that stays true when someone adds a second provider.
 *
 * NO METHOD HERE THROWS FOR AN OPERATIONAL FAILURE, the same rule 49M imposes on
 * `ModuleTransport.send` and 49L on `IntegrationProvider.send`. A rejected promise in
 * a provisioning step would surface as a 500 on an admin route that should be reporting
 * "failed at VERIFY, CHECKSUM_MISMATCH".
 */

/** Which kind of target a provider serves. Mirrors the `ProvisioningTargetType` enum. */
export type ProvisioningTargetTypeValue = 'LOCAL_SERVER' | 'REMOTE_AGENT';

/** Which operation is being performed. Mirrors the `ProvisioningAction` enum. */
export type ProvisioningActionValue =
  | 'PROVISION'
  | 'CONFIGURE'
  | 'VERIFY'
  | 'ACTIVATE'
  | 'STOP'
  | 'RESTART'
  | 'UPGRADE'
  | 'ROLLBACK'
  | 'DECOMMISSION';

/**
 * Short outcome codes. THE COMPLETE SET a provider may report.
 *
 * A closed union rather than `string`, for the reason 49M gives for its five resolution
 * failures: the admin UI renders Persian text per code, and an open string type is how
 * an un-rendered code reaches an operator as a blank cell.
 *
 * `STEP_UNSUPPORTED` is the load-bearing member. A provider that cannot perform a step
 * returns it and **never returns success** — reporting a restart that did not happen is
 * strictly worse than refusing the request.
 */
export type ProvisioningOutcomeCode =
  | 'OK'
  | 'STEP_UNSUPPORTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TARGET_DISABLED'
  | 'TARGET_UNREACHABLE'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_TOO_LARGE'
  | 'CHECKSUM_MISMATCH'
  | 'CONTRACT_INCOMPATIBLE'
  | 'CAPABILITY_MISSING'
  | 'IDENTITY_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'HEALTH_UNHEALTHY'
  | 'CREDENTIAL_MISSING'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR';

/**
 * The result of one provider step.
 *
 * `supported` IS SEPARATE FROM `ok` deliberately. Collapsing them into one boolean
 * loses the difference between "this provider cannot restart processes" and "the restart
 * failed", and those lead an operator to completely different actions: change the
 * deployment model, versus look at why it broke.
 */
export interface ProvisioningStepOutcome {
  /** Did the step do what it claims? Never true for an unperformed step. */
  ok: boolean;
  /** False when this provider structurally cannot perform the step. */
  supported: boolean;
  code: ProvisioningOutcomeCode;
  /**
   * Provider-side duration. Display and diagnostics only; nothing branches on it.
   */
  durationMs?: number;
}

/**
 * Result of the `verify` step, which answers more than "did it work?".
 *
 * The five booleans ARE the activation gate, kept individually visible for exactly the
 * reason 49M keeps `ModuleHealthVerdict` three-part: a single boolean collapses
 * "unreachable", "wrong version" and "missing a capability" into one indistinguishable
 * failure, which is the situation an operator is trying to tell apart at 3am.
 */
export interface ProvisioningVerification extends ProvisioningStepOutcome {
  artifactIntact: boolean;
  identityMatches: boolean;
  versionMatches: boolean;
  contractCompatible: boolean;
  capabilitiesPresent: boolean;
}

/**
 * Result of `validateTarget`. Read-only: it changes nothing and creates no execution row.
 */
export interface ProvisioningTargetValidation {
  usable: boolean;
  code: ProvisioningOutcomeCode;
}

/**
 * The target, as a provider sees it.
 *
 * NOTE WHAT IS ABSENT: no `url`, no `host`, no `port`, no `credential`. A provider gets
 * the target's KEY and TYPE plus the NAME of a credential, and resolves the rest from
 * configuration — which is why a row an administrator typed can never become a network
 * destination.
 */
export interface ProvisioningTargetRef {
  id: string;
  targetKey: string;
  targetType: ProvisioningTargetTypeValue;
  enabled: boolean;
  /** NAME of a credential, never its value. Null for LOCAL_SERVER. */
  credentialRef: string | null;
}

/**
 * The release, as a provider sees it.
 *
 * `artifactKey` is an OBJECT-STORE KEY resolved through `IStorageProvider.getUrl`, which
 * already issues short-lived signed URLs and already clamps their lifetime. A provider
 * never receives a URL, so it cannot be pointed at an arbitrary origin.
 */
export interface ProvisioningReleaseRef {
  id: string;
  moduleId: string;
  version: string;
  artifactKey: string;
  checksumAlgorithm: string;
  checksum: string;
  artifactBytes: number;
  protocolVersion: number;
  apiContracts: readonly string[];
  requiredCapabilities: readonly string[];
}

/**
 * The instance an action applies to. `instanceKey` is 49M's business identity
 * (`ModuleInstance.instanceId`), never a row id a provider could confuse with it.
 */
export interface ProvisioningInstanceRef {
  /** Row id, when the instance exists. Absent during a first PROVISION. */
  id?: string;
  instanceKey: string;
  moduleId: string;
  /** Currently running version, when known. */
  version?: string;
  /**
   * Capabilities the RUNNING instance declares, from its 49M registration row.
   *
   * Absent during a first PROVISION, where nothing has announced itself yet. Present
   * afterwards so `verify` can check the release's `requiredCapabilities` against what
   * the instance actually offers, using 49M's own `hasCapabilities` rather than a second
   * notion of the same comparison.
   */
  declaredCapabilities?: readonly string[];
}

/**
 * Everything a provider needs for one step, assembled by the SERVICE from rows —
 * never from a request body.
 *
 * `correlationId` is carried from `RequestContextService` and never regenerated, so one
 * id traces admin request -> execution -> provider step -> audit row. `timeoutMs` is
 * always finite and always clamped by the caller: an unbounded provisioning step is an
 * execution that stays RUNNING forever with nothing able to reclaim it.
 */
export interface ProvisioningPlan {
  executionId: string;
  action: ProvisioningActionValue;
  target: ProvisioningTargetRef;
  instance: ProvisioningInstanceRef;
  /** Absent for actions that install nothing (STOP, RESTART, DECOMMISSION). */
  release?: ProvisioningReleaseRef;
  /** The state this step drives toward, already validated by `canTransition`. */
  targetState: ModuleOperationalStateValue;
  correlationId: string;
  timeoutMs: number;
}

/**
 * THE SEAM. Ten methods; one implementation per TARGET TYPE, never one per module.
 *
 * `targetType` is readonly so the registry can index providers by it without a provider
 * being able to change which targets it claims after construction.
 *
 * WHAT MAKES THIS PROVIDER-NEUTRAL RATHER THAN "LOCAL WITH EXTRA STEPS", the same
 * property `IntegrationProviderRegistry` documents for 49L: `ModuleProvisioningService`
 * depends on this interface and on the registry, and never imports
 * `LocalProvisioningProvider`. Adding a remote agent is: write an adapter, add the enum
 * member (already present), register it. No service change, and no business module can
 * see any of it.
 */
export interface IModuleProvisioningProvider {
  readonly targetType: ProvisioningTargetTypeValue;

  /**
   * Read-only pre-flight. Never mutates, never creates an execution row — which is why
   * `ProvisioningAction` has no member for it.
   */
  validateTarget(target: ProvisioningTargetRef): Promise<ProvisioningTargetValidation>;

  /** Place the artifact and create the deployment. */
  provision(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Apply configuration the module needs before it can answer. */
  configure(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** The five-condition gate. All or nothing: there is no partial activation. */
  verify(plan: ProvisioningPlan): Promise<ProvisioningVerification>;

  /** Make the instance eligible to serve. */
  activate(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Stop serving. May legitimately report `STEP_UNSUPPORTED`. */
  stop(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Restart in place. May legitimately report `STEP_UNSUPPORTED`. */
  restart(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Move to a strictly newer release. Ordering is checked BEFORE this is called. */
  upgrade(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Move to a strictly older release. Ordering is checked BEFORE this is called. */
  rollback(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;

  /** Remove the deployment. Terminal, and reached only through DISABLED. */
  decommission(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome>;
}

/**
 * Helper for the common "I cannot do this" answer.
 *
 * Exists so an unsupported step is spelled ONE way. A provider writing
 * `{ ok: false, supported: false, code: 'PROVIDER_ERROR' }` by hand would be reporting a
 * failure where the truth is a capability gap, and the UI would offer a retry that can
 * never succeed.
 */
export function unsupportedStep(): ProvisioningStepOutcome {
  return { ok: false, supported: false, code: 'STEP_UNSUPPORTED' };
}

/** Helper for a successful step. */
export function stepSucceeded(durationMs?: number): ProvisioningStepOutcome {
  return { ok: true, supported: true, code: 'OK', durationMs };
}

/** Helper for a supported step that failed for a stated reason. */
export function stepFailed(
  code: ProvisioningOutcomeCode,
  durationMs?: number,
): ProvisioningStepOutcome {
  return { ok: false, supported: true, code, durationMs };
}
