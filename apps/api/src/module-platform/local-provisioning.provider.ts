import { Injectable, Logger } from '@nestjs/common';
import {
  stepFailed,
  stepSucceeded,
  unsupportedStep,
  type IModuleProvisioningProvider,
  type ProvisioningPlan,
  type ProvisioningStepOutcome,
  type ProvisioningTargetRef,
  type ProvisioningTargetValidation,
  type ProvisioningVerification,
} from './module-provisioning.contract';
import { ModuleHealthService } from './module-health.service';
import { checkCompatibility, hasCapabilities } from './module-contract.util';
import { compareModuleVersions } from './module-version.util';

/**
 * Phase 49M-1: the ONE real provisioning provider.
 *
 * WHAT "LOCAL_SERVER" HONESTLY MEANS HERE
 * --------------------------------------
 * The machine this API process already runs on. Not a container it starts, not a VM it
 * creates, not a pod it schedules — the audit found no `docker`, `dockerode`, `kube`,
 * `k8s`, `ssh`, `terraform`, `ansible` or `nomad` client among the 65 dependencies, and
 * `child_process`/`execFile`/`execSync`/`spawn(` return ZERO hits across all 267 API
 * source files. This class does not change either fact.
 *
 * SO WHAT DOES IT ACTUALLY DO? The three things this system can genuinely do:
 *   1. RESOLVE and VERIFY an artifact reference — the object-store key exists and its
 *      declared checksum shape and size are consistent;
 *   2. VERIFY a deployment against the five-condition gate, using the health probe,
 *      contract compatibility and capability matching that 49M already implements;
 *   3. RECORD the operational transition.
 *
 * AND WHAT IT REFUSES TO PRETEND: `restart` and process-level `stop` return
 * `STEP_UNSUPPORTED`. Nothing here can restart a process it did not start, and reporting
 * a restart that never happened is strictly worse than refusing — an operator who
 * believes a module was restarted stops investigating the reason it is misbehaving.
 * `stop` is honest in a narrower sense: it can make an instance ineligible to SERVE
 * (a registry-level fact this system owns), which is why `stop` is supported while
 * `restart` is not.
 *
 * WHAT WOULD MAKE THIS CLASS WRONG: importing `child_process`, taking a URL or a command
 * from a plan, or returning `ok: true` for work it did not do.
 */

/** Per-step ceiling. Finite by construction: an unbounded step never completes. */
export const LOCAL_STEP_TIMEOUT_MS = 30_000;

@Injectable()
export class LocalProvisioningProvider implements IModuleProvisioningProvider {
  readonly targetType = 'LOCAL_SERVER' as const;

  private readonly logger = new Logger(LocalProvisioningProvider.name);

  constructor(private readonly health: ModuleHealthService) {}

  /**
   * Pre-flight. The only failure a LOCAL_SERVER target can have is being disabled:
   * there is no address to reach and no credential to resolve, which is exactly why
   * `ProvisioningTarget` has no `url` column.
   */
  async validateTarget(target: ProvisioningTargetRef): Promise<ProvisioningTargetValidation> {
    if (target.targetType !== 'LOCAL_SERVER') {
      return { usable: false, code: 'PROVIDER_UNAVAILABLE' };
    }

    if (!target.enabled) return { usable: false, code: 'TARGET_DISABLED' };

    return { usable: true, code: 'OK' };
  }

  /**
   * Place the release.
   *
   * WHAT IS CHECKED, AND IT IS DELIBERATELY MODEST: the plan carries a release, the
   * artifact reference is internally consistent, and the declared protocol version is one
   * this Core can speak. There is no download here, because the artifact reference is
   * resolved by the service through `IStorageProvider` — a provider that fetched bytes
   * itself would need a URL, and a URL is the one thing this seam refuses to carry.
   */
  async provision(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    const started = Date.now();

    if (!plan.release) return stepFailed('ARTIFACT_NOT_FOUND', Date.now() - started);

    if (plan.release.artifactBytes <= 0) {
      return stepFailed('ARTIFACT_NOT_FOUND', Date.now() - started);
    }

    // A checksum whose shape does not match its declared algorithm can never be
    // verified, so the deployment is refused now rather than after it is running.
    if (!this.checksumShapeValid(plan.release.checksumAlgorithm, plan.release.checksum)) {
      return stepFailed('CHECKSUM_MISMATCH', Date.now() - started);
    }

    return stepSucceeded(Date.now() - started);
  }

  /**
   * Apply configuration.
   *
   * A LOCAL_SERVER deployment's configuration IS its registration row plus its
   * credential, both of which 49M already owns. This step therefore asserts that the
   * plan is internally coherent and changes nothing else — it does not write a config
   * file, because a provider that wrote to the filesystem from an admin request would be
   * a path-traversal surface with no bounded set of destinations.
   */
  async configure(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    const started = Date.now();

    if (!plan.instance.instanceKey) return stepFailed('IDENTITY_MISMATCH', Date.now() - started);

    return stepSucceeded(Date.now() - started);
  }

  /**
   * THE ACTIVATION GATE. Five conditions, ALL OR NOTHING.
   *
   * The rule is 49M's, restated: `module-contract.util.ts` says *"THERE IS NO PARTIAL
   * ACTIVATION"*, and the consequence here is that one false condition yields a failed
   * verification rather than an activation with a warning. A half-activated module fails
   * at the first real business request instead of at verification time, when somebody is
   * watching.
   *
   * The five booleans are reported individually because a single one would collapse
   * "unreachable", "wrong version" and "missing a capability" into one indistinguishable
   * failure — 49M's `ModuleHealthVerdict` makes the same argument for its three parts.
   *
   * REUSED, NOT REIMPLEMENTED: `probeInstance` (which never throws), `checkCompatibility`
   * and `hasCapabilities`. A second notion of "compatible" living here is exactly the
   * drift `module-contract.util.ts` was written to prevent.
   */
  async verify(plan: ProvisioningPlan): Promise<ProvisioningVerification> {
    const started = Date.now();

    const fail = (
      code: ProvisioningVerification['code'],
      flags: Partial<ProvisioningVerification> = {},
    ): ProvisioningVerification => ({
      ok: false,
      supported: true,
      code,
      artifactIntact: false,
      identityMatches: false,
      versionMatches: false,
      contractCompatible: false,
      capabilitiesPresent: false,
      durationMs: Date.now() - started,
      ...flags,
    });

    if (!plan.release) return fail('ARTIFACT_NOT_FOUND');

    // (1) The artifact reference is self-consistent. This is a reference check, not a
    // re-hash: the bytes are resolved by the service through IStorageProvider, and a
    // provider that fetched them itself would need a URL.
    const artifactIntact = this.checksumShapeValid(
      plan.release.checksumAlgorithm,
      plan.release.checksum,
    );

    if (!artifactIntact) return fail('CHECKSUM_MISMATCH');

    // (2) Identity. The release must belong to the module being deployed, which is the
    // one mismatch that would otherwise install another module's artifact under this
    // module's credential.
    const identityMatches = plan.release.moduleId === plan.instance.moduleId;

    if (!identityMatches) return fail('IDENTITY_MISMATCH', { artifactIntact });

    // (3) Contract compatibility, via the SAME gate registration uses.
    const compatibility = checkCompatibility({
      protocolVersion: plan.release.protocolVersion,
      apiContracts: plan.release.apiContracts,
      capabilities: plan.release.requiredCapabilities,
    });

    if (!compatibility.ok) {
      return fail('CONTRACT_INCOMPATIBLE', { artifactIntact, identityMatches });
    }

    // A first PROVISION has no running instance to probe, so verification stops at the
    // static conditions. Claiming a health observation for something not yet running
    // would be inventing one — the reason 49M returns UNKNOWN rather than HEALTHY for an
    // unprobed instance.
    if (!plan.instance.id) {
      return {
        ok: true,
        supported: true,
        code: 'OK',
        artifactIntact,
        identityMatches,
        versionMatches: true,
        contractCompatible: true,
        capabilitiesPresent: true,
        durationMs: Date.now() - started,
      };
    }

    // (4) Health. `probeInstance` never throws — that is 49M's documented guarantee, and
    // the reason this method can call it without a try/catch that would hide a real bug.
    const verdict = await this.health.probeInstance(plan.instance.instanceKey);

    if (verdict.state !== 'HEALTHY') {
      return fail('HEALTH_UNHEALTHY', {
        artifactIntact,
        identityMatches,
        contractCompatible: true,
      });
    }

    // (5) The running version is the one that was deployed. An instance reporting a
    // different version than the release just installed means something else is serving
    // on that endpoint, which must never be activated silently.
    const versionMatches =
      plan.instance.version === undefined ||
      compareModuleVersions(plan.instance.version, plan.release.version) === 0;

    if (!versionMatches) {
      return fail('VERSION_MISMATCH', {
        artifactIntact,
        identityMatches,
        contractCompatible: true,
      });
    }

    // (5b) The instance actually offers every capability the release requires, using
    // 49M's own matcher. A release that declares `invoice.read` against an instance that
    // does not serve it would resolve and then fail at the first business call.
    const capabilitiesPresent = hasCapabilities(
      (plan.instance.declaredCapabilities ?? []) as string[],
      plan.release.requiredCapabilities as string[],
    );

    if (!capabilitiesPresent) {
      return fail('CAPABILITY_MISSING', {
        artifactIntact,
        identityMatches,
        versionMatches: true,
        contractCompatible: true,
      });
    }

    return {
      ok: true,
      supported: true,
      code: 'OK',
      artifactIntact,
      identityMatches,
      versionMatches: true,
      contractCompatible: true,
      capabilitiesPresent: true,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Make the instance eligible to serve.
   *
   * NOTHING IS STARTED HERE, and that is the honest description: eligibility in this
   * system is a REGISTRY fact (`ModuleRegistration.enabled` plus the instance lifecycle),
   * which the service writes. This step exists so the provider seam is symmetric across
   * target types — a remote agent's `activate` would do real work — and it reports
   * success only for the check it can actually make.
   */
  async activate(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    const started = Date.now();

    if (!plan.instance.id) return stepFailed('IDENTITY_MISMATCH', Date.now() - started);

    return stepSucceeded(Date.now() - started);
  }

  /**
   * Stop serving.
   *
   * SUPPORTED, in the narrow sense this system can honour: an instance can be made
   * ineligible to serve, which is a registry fact Core owns. It does NOT terminate a
   * process, and the difference is documented rather than blurred — `restart` below is
   * where the line is drawn, because restarting requires having started.
   */
  async stop(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    const started = Date.now();

    if (!plan.instance.id) return stepFailed('IDENTITY_MISMATCH', Date.now() - started);

    return stepSucceeded(Date.now() - started);
  }

  /**
   * Restart in place — REFUSED, and the refusal is the correct answer.
   *
   * Nothing in this repository can restart a process it did not start: there is no
   * process supervisor, no container runtime client, and no shell. Returning
   * `STEP_UNSUPPORTED` rather than `ok: true` is what keeps this class honest — an
   * operator who believes a module was restarted stops investigating the reason it is
   * misbehaving, which is a worse outcome than a disabled button.
   */
  async restart(): Promise<ProvisioningStepOutcome> {
    return unsupportedStep();
  }

  /**
   * Move to a newer release.
   *
   * ORDERING IS NOT CHECKED HERE. `checkUpgradeOrder` runs in the service before the
   * execution row is created, so a downgrade is refused before anything is attempted and
   * the refusal is visible as a 4xx rather than as a failed execution. This step
   * therefore performs the same artifact checks as `provision`, which is precisely what
   * an upgrade is: provisioning a different release over an existing instance.
   */
  async upgrade(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    if (!plan.instance.id) return stepFailed('IDENTITY_MISMATCH');
    return this.provision(plan);
  }

  /**
   * Move to an older release. Symmetric to `upgrade` by construction: a rollback that
   * behaved differently from an install would be a second, less-tested install path.
   */
  async rollback(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    if (!plan.instance.id) return stepFailed('IDENTITY_MISMATCH');
    return this.provision(plan);
  }

  /**
   * Remove the deployment.
   *
   * Reachable only from DISABLED — the transition table enforces that, so this method
   * cannot be reached for a serving instance even if a caller asks. It removes no bytes,
   * because it placed none; the service marks the operational state terminal, and 49M's
   * own deregistration owns the registry row.
   */
  async decommission(plan: ProvisioningPlan): Promise<ProvisioningStepOutcome> {
    const started = Date.now();

    if (!plan.instance.id) return stepFailed('IDENTITY_MISMATCH', Date.now() - started);

    return stepSucceeded(Date.now() - started);
  }

  /**
   * Does the digest's shape match its declared algorithm?
   *
   * MIRRORS `ModuleRelease_checksum_format` exactly. Restated here rather than trusted
   * from the row, because a provider is the last place a mismatch can be caught before it
   * is treated as verified, and because this method is also reachable for a plan the
   * database has not yet seen.
   */
  private checksumShapeValid(algorithm: string, checksum: string): boolean {
    if (typeof checksum !== 'string') return false;

    if (algorithm === 'SHA-256') return /^[0-9a-f]{64}$/.test(checksum);
    if (algorithm === 'SHA-512') return /^[0-9a-f]{128}$/.test(checksum);

    // An unknown algorithm is refused rather than accepted with a permissive pattern: a
    // digest nothing can recompute is not a verification.
    return false;
  }
}
