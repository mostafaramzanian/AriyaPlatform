import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityLifecycleService } from '../observability/observability-lifecycle.service';
import type {
  LifecycleEventInput,
  LifecyclePhaseValue,
} from '../observability/observability.contract';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import {
  canTransition,
  checkTransition,
  isInFlightState,
  type ModuleOperationalStateValue,
} from './module-operational-state';
import { checkRollbackOrder, checkUpgradeOrder } from './module-version.util';
import type {
  ProvisioningActionValue,
  ProvisioningOutcomeCode,
  ProvisioningPlan,
} from './module-provisioning.contract';

/**
 * Phase 49M-1: the provisioning control plane.
 *
 * WHAT THIS SERVICE OWNS, AND THE ORDER MATTERS
 * --------------------------------------------
 * 1. REFUSE what must not be attempted — before any row is written:
 *      unknown module/target/release, disabled target, missing provider,
 *      illegal operational transition, wrong version ordering, an execution already in
 *      flight for the instance.
 * 2. RECORD the execution (PENDING) with its `idempotencyKey`, so a repeated submit is a
 *    no-op enforced by a UNIQUE constraint rather than by a read-then-write race.
 * 3. RETURN 202 with the execution id. Nothing is awaited past this point on the request
 *    path: holding an HTTP request open across a download, a digest pass and a health
 *    probe converts a browser timeout into an unknown deployment state.
 * 4. RUN the claimed execution, drive the provider step, then write the operational state
 *    transition and the audit row.
 *
 * WHY REFUSAL COMES FIRST: every check in step 1 is cheap, local and reversible, and each
 * one turns a would-be failed deployment into a 4xx an operator can read. A control plane
 * that accepts first and discovers later produces execution history full of failures that
 * were knowable at request time.
 *
 * WHAT THIS SERVICE DOES NOT DO: it never imports a provider class (only the registry), it
 * never touches `ModuleInstance.lifecycle` (that column belongs to 49M's four writers), it
 * runs no shell, and it holds no secret value. Credential material is a REFERENCE resolved
 * by a provider at use time.
 */

/** Bounded attempts per execution. */
export const MAX_PROVISIONING_ATTEMPTS = 3;

/** Per-step ceiling handed to a provider. Always finite. */
export const PROVISIONING_STEP_TIMEOUT_MS = 30_000;

/** Page ceiling for the execution-history read, matching 49M's `MAX_MODULE_PAGE`. */
export const MAX_EXECUTION_PAGE = 100;

/**
 * Audit action names. Explicit constants rather than string literals at the call sites,
 * the same shape `module-registry.service.ts` uses for its own actions.
 */
export const PROVISIONING_AUDIT_ACTIONS = {
  REQUESTED: 'module.provisioning.requested',
  REFUSED: 'module.provisioning.refused',
  COMPLETED: 'module.provisioning.completed',
} as const;

/**
 * Phase 49M-2: lifecycle event types for the control plane.
 *
 * THREE, MIRRORING `PROVISIONING_AUDIT_ACTIONS` EXACTLY, and that one-to-one mapping is the
 * point: an execution has exactly three moments worth recording — it was accepted, it was
 * refused before anything was attempted, or it reached a terminal status — and every one of
 * them already has an audit action, a call site and a test.
 *
 * NO PER-STEP EVENT. `dispatch()` routes one action to one provider method inside a single
 * `runExecution`; emitting there would produce a row per provider call whose only content is
 * the same `action` the terminal row already carries. `failedStep` on the execution row is
 * where a mid-run failure is located.
 *
 * NO EVENT FOR THE `PENDING → RUNNING` CLAIM. The claim is a conditional UPDATE whose loser
 * does nothing, so a row per claim attempt would record contention rather than lifecycle.
 * REQUESTED already marks the start; the terminal row marks the end.
 */
const LIFECYCLE_EVENTS = {
  REQUESTED: 'provisioning.execution.requested',
  REFUSED: 'provisioning.execution.refused',
  COMPLETED: 'provisioning.execution.completed',
} as const;

/** Which operational state each action drives toward. */
const ACTION_TARGET_STATE: Record<ProvisioningActionValue, ModuleOperationalStateValue> = {
  PROVISION: 'PROVISIONING',
  CONFIGURE: 'CONFIGURING',
  VERIFY: 'VERIFYING',
  ACTIVATE: 'ACTIVE',
  STOP: 'DISABLED',
  RESTART: 'UPDATING',
  UPGRADE: 'UPDATING',
  ROLLBACK: 'UPDATING',
  DECOMMISSION: 'DECOMMISSIONED',
} as const;

/** Why a request was refused before anything was attempted. */
export type ProvisioningRefusal =
  | 'MODULE_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_DISABLED'
  | 'RELEASE_NOT_FOUND'
  | 'RELEASE_NOT_PUBLISHED'
  | 'INSTANCE_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'STEP_UNSUPPORTED'
  | 'UNKNOWN_STATE'
  | 'TERMINAL_STATE'
  | 'ILLEGAL_TRANSITION'
  | 'EXECUTION_IN_PROGRESS'
  | 'VERSION_MALFORMED'
  | 'SAME_VERSION'
  | 'NOT_NEWER'
  | 'NOT_OLDER';

export interface ProvisioningRequest {
  moduleId: string;
  action: ProvisioningActionValue;
  targetKey: string;
  /** Business identity of the instance. Absent only for a first PROVISION. */
  instanceKey?: string;
  /** Release version to install. Required for PROVISION, UPGRADE and ROLLBACK. */
  releaseVersion?: string;
  /**
   * Caller-supplied de-duplication token, folded into the `idempotencyKey`.
   *
   * The CALLER supplies it so a retried submit from the same UI interaction collapses onto
   * one execution. A server-generated token would make every retry a new deployment, which
   * is the failure the UNIQUE constraint exists to prevent.
   */
  requestKey: string;
}

export interface ProvisioningAccepted {
  accepted: true;
  executionId: string;
  status: 'PENDING';
  /** True when this request matched an existing execution rather than creating one. */
  deduplicated: boolean;
}

export interface ProvisioningRefused {
  accepted: false;
  refusal: ProvisioningRefusal;
}

export type ProvisioningRequestResult = ProvisioningAccepted | ProvisioningRefused;

@Injectable()
export class ModuleProvisioningService {
  private readonly logger = new Logger(ModuleProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvisioningProviderRegistry,
    private readonly audit: AuditService,
    // 49M-2. `@Optional()` even though `ObservabilityModule` is `@Global()` and this therefore
    // always resolves in the real graph. Two reasons, and the second is the load-bearing one:
    //   1. `module-provisioning.service.spec.ts` constructs the subject with
    //      `new ModuleProvisioningService(prisma, registry, audit)` — a required fourth
    //      parameter would make every existing test of this class construct an object whose
    //      emission path throws on first use.
    //   2. Observability is optional infrastructure. `ObservabilityPrismaService` deliberately
    //      swallows a failed connect so the API boots without observability_db; a control plane
    //      that could not deploy a module because the log database was unreachable would invert
    //      that decision.
    // NOTE the asymmetry with `audit` above, which is NOT optional here: this service was
    // written after 49M and its audit trail is mandatory. That is left exactly as it was.
    @Optional() private readonly lifecycle?: ObservabilityLifecycleService,
  ) {}

  /**
   * Accept or refuse one provisioning request.
   *
   * RETURNS A RESULT, NEVER THROWS FOR A REFUSAL. Every refusal above is a state an
   * operator caused and can fix, so it becomes a normalised code the UI renders — the same
   * rule 49M applies to its five resolution failures. `NotFoundException` is reserved for
   * an id that does not exist at all, because a 404 is the honest answer there.
   */
  async request(actorId: string, dto: ProvisioningRequest): Promise<ProvisioningRequestResult> {
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId: dto.moduleId },
      select: { id: true, moduleId: true },
    });

    if (!registration) return this.refuse(actorId, dto, 'MODULE_NOT_FOUND');

    const target = await this.prisma.provisioningTarget.findUnique({
      where: { targetKey: dto.targetKey },
      select: {
        id: true,
        targetKey: true,
        targetType: true,
        enabled: true,
        credentialRef: true,
      },
    });

    if (!target) return this.refuse(actorId, dto, 'TARGET_NOT_FOUND');
    if (!target.enabled) return this.refuse(actorId, dto, 'TARGET_DISABLED');

    // The provider is resolved BEFORE any row is written, so a REMOTE_AGENT request is
    // refused rather than recorded as an execution nothing can ever run.
    const provider = this.providers.resolve(target.targetType);

    if (!provider) return this.refuse(actorId, dto, 'PROVIDER_UNAVAILABLE');

    // A step the provider structurally cannot perform is refused here too. Accepting it
    // would produce an execution whose only possible outcome is STEP_UNSUPPORTED.
    const descriptor = this.providers.describe(target.targetType);

    if (descriptor?.unsupportedActions.includes(dto.action)) {
      return this.refuse(actorId, dto, 'STEP_UNSUPPORTED');
    }

    // ── Instance resolution ────────────────────────────────────────────────────────
    // Every action except PROVISION acts on an existing instance. That is also a CHECK
    // constraint on the table; asserting it here turns a 500 into a readable refusal.
    let instanceRowId: string | undefined;
    let instanceVersion: string | undefined;
    let currentState: ModuleOperationalStateValue = 'REGISTERED';

    if (dto.action !== 'PROVISION') {
      if (!dto.instanceKey) return this.refuse(actorId, dto, 'INSTANCE_NOT_FOUND');

      const instance = await this.prisma.moduleInstance.findUnique({
        where: { instanceId: dto.instanceKey },
        select: {
          id: true,
          moduleId: true,
          version: true,
          operationalStatus: { select: { operationalState: true, currentVersion: true } },
        },
      });

      // A cross-module instance key is INSTANCE_NOT_FOUND rather than a distinct code:
      // "finance-prod-01 is not an instance of hr" and "no such instance" are the same
      // actionable fact, and a separate code would let a caller enumerate other modules'
      // instance ids by comparing the two answers.
      if (!instance || instance.moduleId !== registration.moduleId) {
        return this.refuse(actorId, dto, 'INSTANCE_NOT_FOUND');
      }

      instanceRowId = instance.id;
      instanceVersion = instance.operationalStatus?.currentVersion ?? instance.version;
      currentState = (instance.operationalStatus?.operationalState ??
        'REGISTERED') as ModuleOperationalStateValue;
    }

    // ── Concurrency, checked BEFORE transition legality ───────────────────────────
    // ORDER MATTERS HERE. A STOP requested while an upgrade is running would fail the
    // transition check too (UPDATING has no edge to DISABLED), but ILLEGAL_TRANSITION would
    // tell the operator the action is never allowed — when in fact it becomes legal the
    // moment the upgrade lands. EXECUTION_IN_PROGRESS is the actionable answer: wait.
    if (instanceRowId && isInFlightState(currentState)) {
      return this.refuse(actorId, dto, 'EXECUTION_IN_PROGRESS');
    }

    if (instanceRowId) {
      const inFlight = await this.prisma.moduleProvisioningExecution.count({
        where: { instanceId: instanceRowId, status: { in: ['PENDING', 'RUNNING'] } },
      });

      if (inFlight > 0) return this.refuse(actorId, dto, 'EXECUTION_IN_PROGRESS');
    }

    // ── Transition legality ───────────────────────────────────────────────────────
    // The pure table decides, and it is the ONLY thing that decides. A caller never names
    // a state: the action implies one via ACTION_TARGET_STATE.
    const targetState = ACTION_TARGET_STATE[dto.action];

    if (dto.action !== 'PROVISION') {
      const transition = checkTransition(currentState, targetState);

      if (!transition.ok) {
        return this.refuse(actorId, dto, transition.failure as ProvisioningRefusal);
      }
    }

    // ── Release resolution and version ordering ───────────────────────────────────
    let releaseRowId: string | undefined;
    let releaseVersion: string | undefined;

    if (dto.action === 'PROVISION' || dto.action === 'UPGRADE' || dto.action === 'ROLLBACK') {
      if (!dto.releaseVersion) return this.refuse(actorId, dto, 'RELEASE_NOT_FOUND');

      const release = await this.prisma.moduleRelease.findUnique({
        where: { moduleId_version: { moduleId: dto.moduleId, version: dto.releaseVersion } },
        select: { id: true, version: true, releaseStatus: true },
      });

      if (!release) return this.refuse(actorId, dto, 'RELEASE_NOT_FOUND');

      // WITHDRAWN is refused for every action, including ROLLBACK. A release withdrawn for
      // a security reason must not remain a legal rollback target — that is the whole
      // reason WITHDRAWN and DEPRECATED are separate enum members.
      const deployable =
        release.releaseStatus === 'PUBLISHED' ||
        (release.releaseStatus === 'DEPRECATED' && dto.action === 'ROLLBACK');

      if (!deployable) return this.refuse(actorId, dto, 'RELEASE_NOT_PUBLISHED');

      releaseRowId = release.id;
      releaseVersion = release.version;

      // ORDERING IS DECIDED HERE, before anything is attempted, so a downgrade presented
      // as an upgrade is a 4xx rather than a failed execution — and so the refusal names
      // the reason (`NOT_NEWER` vs `SAME_VERSION`) instead of a generic failure.
      if (dto.action === 'UPGRADE' || dto.action === 'ROLLBACK') {
        const current = instanceVersion;

        if (!current) return this.refuse(actorId, dto, 'VERSION_MALFORMED');

        const order =
          dto.action === 'UPGRADE'
            ? checkUpgradeOrder(current, release.version)
            : checkRollbackOrder(current, release.version);

        if (!order.ok) return this.refuse(actorId, dto, order.failure as ProvisioningRefusal);
      }
    }

    // ── Record, then return 202 ───────────────────────────────────────────────────
    // The key includes the module, the action, the release and the caller's token, so a
    // repeated submit collapses while a genuinely different request does not.
    const idempotencyKey = `${dto.moduleId}:${dto.action}:${releaseVersion ?? '-'}:${dto.requestKey}`;

    const context = RequestContextService.get();

    // A UNIQUE violation is the EXPECTED path for a double submit, so it is handled rather
    // than caught-and-logged: the caller gets the existing execution id and `deduplicated`,
    // which is the whole point of enforcing idempotence in the database.
    const existing = await this.prisma.moduleProvisioningExecution.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      return {
        accepted: true,
        executionId: existing.id,
        status: 'PENDING',
        deduplicated: true,
      };
    }

    const execution = await this.prisma.moduleProvisioningExecution.create({
      data: {
        registrationId: registration.id,
        moduleId: registration.moduleId,
        instanceId: instanceRowId,
        instanceKey: dto.instanceKey,
        releaseId: releaseRowId,
        targetId: target.id,
        action: dto.action,
        status: 'PENDING',
        targetState,
        idempotencyKey,
        tenantId: context?.tenantId ?? null,
        actorId,
        correlationId: context?.correlationId,
        // Claimable immediately. NULL would mean "not retryable", which is reserved for
        // terminal rows by `ModuleProvisioningExecution_terminal_not_retryable`.
        nextAttemptAt: new Date(),
      },
      select: { id: true },
    });

    await this.record(PROVISIONING_AUDIT_ACTIONS.REQUESTED, actorId, execution.id, {
      moduleId: dto.moduleId,
      action: dto.action,
      targetKey: dto.targetKey,
      instanceKey: dto.instanceKey ?? null,
      releaseVersion: releaseVersion ?? null,
      targetState,
    });

    // STARTED, not SUCCEEDED. The row exists and is claimable; nothing has been deployed. A
    // SUCCEEDED phase here would make an accepted-then-failed run read as two successes.
    //
    // `tenantId` and the actor come from the SAME `context` the execution row was written with
    // a few lines above, so the lifecycle row cannot disagree with the execution it describes.
    // `correlationId` is resolved by the writer from `RequestContextService`, never passed —
    // see `ObservabilityCorrelation`.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.REQUESTED,
      'STARTED',
      execution.id,
      dto.moduleId,
      actorId,
      {
        action: dto.action,
        targetKey: dto.targetKey,
        targetState,
        releaseVersion: releaseVersion ?? null,
      },
      { instanceId: dto.instanceKey ?? null, tenantId: context?.tenantId ?? null },
    );

    return { accepted: true, executionId: execution.id, status: 'PENDING', deduplicated: false };
  }

  /**
   * Run one PENDING execution.
   *
   * THE CLAIM IS A CONDITIONAL `UPDATE`, which is the audited in-repo precedent
   * (`AutomationRetryService`, `AuditDispatcherService`, `ReminderDispatcherService`,
   * `ModuleSweepService`) and the reason no new broker or scheduler is introduced. Two
   * processes racing on the same row: exactly one `updateMany` reports `count === 1`, and
   * the loser does nothing. Correctness comes from the operation's shape rather than from
   * process topology.
   *
   * NEVER THROWS. A rejected promise here would become an unhandled rejection in whatever
   * timer or request kicked it off, and an unhandled rejection terminates the Node process
   * — turning one bad artifact into an outage. Every failure becomes a terminal row with a
   * code.
   */
  async runExecution(executionId: string): Promise<ProvisioningOutcomeCode> {
    // Claim: PENDING → RUNNING, only if still PENDING.
    const claimed = await this.prisma.moduleProvisioningExecution.updateMany({
      where: { id: executionId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date(), attemptCount: { increment: 1 } },
    });

    if (claimed.count !== 1) return 'PROVIDER_ERROR';

    const execution = await this.prisma.moduleProvisioningExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        moduleId: true,
        action: true,
        targetState: true,
        attemptCount: true,
        correlationId: true,
        actorId: true,
        instanceId: true,
        instanceKey: true,
        target: {
          select: {
            id: true,
            targetKey: true,
            targetType: true,
            enabled: true,
            credentialRef: true,
          },
        },
        release: {
          select: {
            id: true,
            moduleId: true,
            version: true,
            artifactKey: true,
            checksumAlgorithm: true,
            checksum: true,
            artifactBytes: true,
            protocolVersion: true,
            apiContracts: true,
            requiredCapabilities: true,
          },
        },
        instance: { select: { id: true, version: true, capabilities: true } },
      },
    });

    if (!execution) return 'PROVIDER_ERROR';

    try {
      const provider = this.providers.resolve(execution.target.targetType);

      // The target could have been disabled, or its type could have become unresolvable,
      // between acceptance and execution. Re-checked here rather than assumed, the same
      // two-point validation 49M applies to an endpoint.
      if (!provider) {
        return await this.finish(execution.id, 'FAILED', 'PROVIDER_UNAVAILABLE', null);
      }

      if (!execution.target.enabled) {
        return await this.finish(execution.id, 'FAILED', 'TARGET_DISABLED', null);
      }

      const plan: ProvisioningPlan = {
        executionId: execution.id,
        action: execution.action as ProvisioningActionValue,
        target: {
          id: execution.target.id,
          targetKey: execution.target.targetKey,
          targetType: execution.target.targetType,
          enabled: execution.target.enabled,
          credentialRef: execution.target.credentialRef,
        },
        instance: {
          id: execution.instance?.id,
          instanceKey: execution.instanceKey ?? '',
          moduleId: execution.moduleId,
          version: execution.instance?.version,
          declaredCapabilities: execution.instance?.capabilities ?? [],
        },
        release: execution.release
          ? {
              id: execution.release.id,
              moduleId: execution.release.moduleId,
              version: execution.release.version,
              artifactKey: execution.release.artifactKey,
              checksumAlgorithm: execution.release.checksumAlgorithm,
              checksum: execution.release.checksum,
              artifactBytes: execution.release.artifactBytes,
              protocolVersion: execution.release.protocolVersion,
              apiContracts: execution.release.apiContracts,
              requiredCapabilities: execution.release.requiredCapabilities,
            }
          : undefined,
        targetState: execution.targetState as ModuleOperationalStateValue,
        correlationId: execution.correlationId ?? 'module-provisioning',
        timeoutMs: PROVISIONING_STEP_TIMEOUT_MS,
      };

      const outcome = await this.dispatch(provider, plan);

      // An UNSUPPORTED step is recorded as FAILED with its own code, never as success.
      // `supported: false` and `ok: false` are both present on the outcome precisely so
      // this distinction survives into the row.
      if (!outcome.ok) {
        return await this.finish(execution.id, 'FAILED', outcome.code, plan);
      }

      await this.applyState(plan, execution.id);

      return await this.finish(execution.id, 'SUCCEEDED', 'OK', plan);
    } catch (err) {
      this.logger.error(
        {
          executionId,
          err: err instanceof Error ? err.message : 'unknown',
        },
        'Provisioning execution failed unexpectedly',
      );

      return await this.finish(execution.id, 'FAILED', 'PROVIDER_ERROR', null);
    }
  }

  /**
   * Route one action to one provider method.
   *
   * A `switch` rather than `provider[action.toLowerCase()]`. Dynamic dispatch on a string
   * from a row is how `'constructor'` becomes a callable, and an exhaustive switch also
   * makes TypeScript fail the build when a tenth action is added without a case — which a
   * lookup table silently would not.
   */
  private async dispatch(
    provider: NonNullable<ReturnType<ProvisioningProviderRegistry['resolve']>>,
    plan: ProvisioningPlan,
  ) {
    switch (plan.action) {
      case 'PROVISION':
        return provider.provision(plan);
      case 'CONFIGURE':
        return provider.configure(plan);
      case 'VERIFY':
        return provider.verify(plan);
      case 'ACTIVATE':
        return provider.activate(plan);
      case 'STOP':
        return provider.stop(plan);
      case 'RESTART':
        return provider.restart(plan);
      case 'UPGRADE':
        return provider.upgrade(plan);
      case 'ROLLBACK':
        return provider.rollback(plan);
      case 'DECOMMISSION':
        return provider.decommission(plan);
      default:
        return { ok: false, supported: false, code: 'PROVIDER_ERROR' as const };
    }
  }

  /**
   * Write the operational transition for a successful step.
   *
   * `canTransition` IS RE-CHECKED HERE, even though `request` already checked it. The two
   * checks are not redundant: an execution is accepted at one moment and runs at another,
   * and the state can have moved in between (a concurrent disable, a retry after a
   * failure). Writing a state the table forbids because it was legal earlier is exactly the
   * class of bug a transition table exists to prevent.
   *
   * The upsert is how a first PROVISION creates the 1:1 row and every later action updates
   * it. `previousVersion` is set only when the version actually changes, so a rollback
   * target is never equal to the running version — which the
   * `ModuleOperationalStatus_previous_differs_from_current` CHECK also refuses.
   */
  private async applyState(plan: ProvisioningPlan, executionId: string): Promise<void> {
    if (!plan.instance.id) return;

    const existing = await this.prisma.moduleOperationalStatus.findUnique({
      where: { instanceRowId: plan.instance.id },
      select: { operationalState: true, currentVersion: true },
    });

    const from = (existing?.operationalState ?? 'REGISTERED') as ModuleOperationalStateValue;

    if (existing && !canTransition(from, plan.targetState)) {
      this.logger.warn(
        { executionId, from, to: plan.targetState },
        'Operational state moved after acceptance; transition no longer legal',
      );
      return;
    }

    const nextVersion = plan.release?.version ?? existing?.currentVersion ?? null;
    const versionChanged = Boolean(
      existing?.currentVersion && nextVersion && existing.currentVersion !== nextVersion,
    );

    await this.prisma.moduleOperationalStatus.upsert({
      where: { instanceRowId: plan.instance.id },
      create: {
        instanceRowId: plan.instance.id,
        moduleId: plan.instance.moduleId,
        operationalState: plan.targetState,
        stateChangedAt: new Date(),
        lastExecutionId: executionId,
        currentReleaseId: plan.release?.id ?? null,
        currentVersion: nextVersion,
      },
      update: {
        operationalState: plan.targetState,
        stateChangedAt: new Date(),
        lastExecutionId: executionId,
        currentReleaseId: plan.release?.id ?? undefined,
        currentVersion: nextVersion,
        previousVersion: versionChanged ? existing?.currentVersion : undefined,
        // Cleared on success: a stale code beside a healthy state is worse than no code,
        // because an operator reads it as a current problem.
        lastErrorCode: null,
      },
    });
  }

  /**
   * Close an execution out.
   *
   * `nextAttemptAt` GOES TO NULL for every terminal status, which is not decoration: it is
   * what keeps the claim index confined to live work, and it is also enforced by
   * `ModuleProvisioningExecution_terminal_not_retryable`. A retryable failure is a NEW
   * request with the same `requestKey`, not a row that lingers as claimable.
   *
   * On failure the code is ALSO mirrored onto the operational status row, so the admin list
   * can show why an instance is unhealthy without joining execution history.
   */
  private async finish(
    executionId: string,
    status: 'SUCCEEDED' | 'FAILED',
    code: ProvisioningOutcomeCode,
    plan: ProvisioningPlan | null,
  ): Promise<ProvisioningOutcomeCode> {
    await this.prisma.moduleProvisioningExecution.update({
      where: { id: executionId },
      data: {
        status,
        completedAt: new Date(),
        nextAttemptAt: null,
        errorCode: status === 'FAILED' ? code : null,
        failedStep: status === 'FAILED' ? (plan?.action ?? null) : null,
      },
    });

    if (status === 'FAILED' && plan?.instance.id) {
      // FAILED is reachable from every non-terminal state, so this transition is legal
      // wherever the run started — except from a terminal one, which `canTransition`
      // refuses and this code respects rather than forcing.
      const existing = await this.prisma.moduleOperationalStatus.findUnique({
        where: { instanceRowId: plan.instance.id },
        select: { operationalState: true },
      });

      const from = (existing?.operationalState ?? 'REGISTERED') as ModuleOperationalStateValue;

      if (canTransition(from, 'FAILED')) {
        await this.prisma.moduleOperationalStatus.update({
          where: { instanceRowId: plan.instance.id },
          data: {
            operationalState: 'FAILED',
            stateChangedAt: new Date(),
            lastExecutionId: executionId,
            lastErrorCode: code,
          },
        });
      }
    }

    await this.record(PROVISIONING_AUDIT_ACTIONS.COMPLETED, null, executionId, {
      status,
      code,
      action: plan?.action ?? null,
      moduleId: plan?.instance.moduleId ?? null,
      instanceKey: plan?.instance.instanceKey ?? null,
    });

    // THE TERMINAL EMISSION, and the only one in `runExecution`. It fires for BOTH outcomes
    // from the single place every terminal path funnels through — `finish()` is called by the
    // provider-unavailable branch, the target-disabled branch, the `!outcome.ok` branch, the
    // success branch and the unexpected-error catch — so a run cannot end without a row and
    // cannot produce two.
    //
    // `attempt` IS LEFT NULL rather than plumbed through: `ProvisioningPlan` is the PROVIDER
    // seam and has no attempt field, and widening a shared contract to decorate a log row is
    // the wrong trade. `ModuleProvisioningExecution.attemptCount` remains the source for it,
    // reachable by `executionId`.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.COMPLETED,
      status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      executionId,
      plan?.instance.moduleId ?? null,
      null,
      {
        status,
        action: plan?.action ?? null,
        targetState: plan?.targetState ?? null,
        version: plan?.release?.version ?? null,
      },
      { instanceId: plan?.instance.instanceKey ?? null },
      // The domain's own code, verbatim: OK / CHECKSUM_MISMATCH / PROVIDER_UNAVAILABLE /
      // TARGET_DISABLED / STEP_UNSUPPORTED / PROVIDER_ERROR. `phase` normalizes, this does not.
      code,
    );

    return code;
  }

  /**
   * Read one execution. The polling target for the `202` response.
   *
   * Throws `NotFoundException` for an unknown id — unlike a refusal, "no such execution" is
   * genuinely a 404 and not an operational state to render.
   */
  async getExecution(executionId: string) {
    const execution = await this.prisma.moduleProvisioningExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        moduleId: true,
        instanceKey: true,
        action: true,
        status: true,
        targetState: true,
        attemptCount: true,
        failedStep: true,
        errorCode: true,
        correlationId: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        target: { select: { targetKey: true, targetType: true } },
        release: { select: { version: true } },
      },
    });

    if (!execution) throw new NotFoundException('Execution not found');

    // NOTE WHAT IS NOT PROJECTED: `idempotencyKey` (it embeds a caller token),
    // `credentialRef`, and `artifactKey`. An admin surface has no need for any of them, and
    // the cheapest way to guarantee they are never returned is not to select them.
    return execution;
  }

  /**
   * Execution history for one module, newest first.
   *
   * Bounded by `MAX_EXECUTION_PAGE` rather than accepting an arbitrary `take`: an unbounded
   * history read is a memory-exhaustion vector on a table that only grows.
   */
  async listExecutions(moduleId: string, take = 50) {
    const bounded = Math.min(Math.max(1, take), MAX_EXECUTION_PAGE);

    return this.prisma.moduleProvisioningExecution.findMany({
      where: { moduleId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: bounded,
      select: {
        id: true,
        instanceKey: true,
        action: true,
        status: true,
        targetState: true,
        attemptCount: true,
        failedStep: true,
        errorCode: true,
        createdAt: true,
        completedAt: true,
        release: { select: { version: true } },
      },
    });
  }

  /**
   * Record a refusal and return it.
   *
   * REFUSALS ARE AUDITED, not just returned. "Somebody tried to roll back to a withdrawn
   * release and was refused" is exactly the line an operator needs during an incident, and a
   * refusal that leaves no trace is indistinguishable from a request nobody made.
   */
  private async refuse(
    actorId: string,
    dto: ProvisioningRequest,
    refusal: ProvisioningRefusal,
  ): Promise<ProvisioningRefused> {
    await this.record(PROVISIONING_AUDIT_ACTIONS.REFUSED, actorId, dto.moduleId, {
      action: dto.action,
      targetKey: dto.targetKey,
      instanceKey: dto.instanceKey ?? null,
      releaseVersion: dto.releaseVersion ?? null,
      refusal,
    });

    // 'REFUSED' is a first-class phase precisely for this case: nothing failed and nothing was
    // skipped — a policy decision declined the request. Normalizing it to FAILED would make an
    // operator's illegal transition indistinguishable from a provider blowing up mid-deploy.
    //
    // `subjectId` IS THE MODULE ID HERE, NOT AN EXECUTION ID, because no execution row exists —
    // that is what refusal means. It matches the `resourceId` the audit row above uses, so the
    // two trails point at the same subject.
    this.emitLifecycle(
      LIFECYCLE_EVENTS.REFUSED,
      'REFUSED',
      dto.moduleId,
      dto.moduleId,
      actorId,
      {
        action: dto.action,
        targetKey: dto.targetKey,
        releaseVersion: dto.releaseVersion ?? null,
      },
      { instanceId: dto.instanceKey ?? null },
      refusal,
    );

    return { accepted: false, refusal };
  }

  /**
   * Audit one event.
   *
   * Mirrors `ModuleRegistryService.record` exactly, including swallowing an audit failure
   * with a warning: an audit write that throws must not roll back a deployment that already
   * happened, because the deployment is the fact and the log is the record of it.
   *
   * `correlationId` comes from `RequestContextService` and is never regenerated.
   */
  private async record(
    action: string,
    actorId: string | null,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;

    const context = RequestContextService.get();

    try {
      await this.audit.log({
        requestId: context?.requestId ?? 'module-provisioning',
        correlationId: context?.correlationId,
        userId: actorId,
        action,
        resource: 'ModuleProvisioningExecution',
        resourceId,
        newValue: payload,
        success: true,
      });
    } catch (err) {
      this.logger.warn(
        { action, err: err instanceof Error ? err.message : 'unknown' },
        'Module provisioning audit write failed',
      );
    }
  }

  /**
   * Emit one lifecycle transition into observability_db, best-effort.
   *
   * PHASE 49M-2. Beside `record()` above, never instead of it: that one writes
   * `core_db."AuditLog"`, this writes `observability_db."LifecycleEvent"` — a different
   * database, a different connection pool, a different retention policy. The audit row proves
   * WHO deployed; this row is the interleaved timeline an operator reads when a run
   * half-succeeded, alongside the integration and module events of the same minute.
   *
   * SAME FAILURE POSTURE AS `record()`, for the identical reason stated there: an observability
   * write that throws must not roll back a deployment that already happened, because the
   * deployment is the fact and the log is the record of it. The emission is `void` and
   * unawaited, so it cannot extend the caller's latency either.
   *
   * `moduleId` IS NULLABLE HERE, unlike in the registry. `finish()` can be reached with
   * `plan === null` (a provider that could not be resolved, an unexpected throw before the plan
   * was built), and inventing an id in that case would attribute a failure to the wrong module.
   * A null is honest; the `executionId` in `subjectId` still identifies the run.
   */
  private emitLifecycle(
    eventType: string,
    phase: LifecyclePhaseValue,
    subjectId: string,
    moduleId: string | null,
    actorId: string | null,
    detail: Record<string, unknown> = {},
    context: { instanceId?: string | null; tenantId?: string | null } = {},
    outcomeCode?: string,
  ): void {
    if (!this.lifecycle) return;

    try {
      const extra: Partial<LifecycleEventInput> = {
        // SYSTEM, not MODULE, when there is no actor: a terminal transition is written by the
        // API's own execution loop, not by the module being deployed. The registry's
        // module-initiated announcements are the opposite case and use MODULE there.
        actorType: actorId ? 'USER' : 'SYSTEM',
        actorId,
        tenantId: context.tenantId ?? null,
        outcomeCode: outcomeCode ?? null,
        module: {
          moduleId,
          instanceId: context.instanceId ?? null,
          deploymentMode: null,
        },
        detail,
      };

      this.lifecycle.provisioning(
        eventType,
        phase,
        { id: subjectId, key: moduleId ?? undefined },
        extra,
      );
    } catch (err) {
      this.logger.warn(
        { eventType, err: err instanceof Error ? err.message : 'unknown' },
        'Module provisioning lifecycle emission failed',
      );
    }
  }
}

