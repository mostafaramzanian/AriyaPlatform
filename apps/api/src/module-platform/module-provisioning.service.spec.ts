import { ModuleProvisioningService } from './module-provisioning.service';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import { LocalProvisioningProvider } from './local-provisioning.provider';
import { RequestContextService } from '../common/request-context.service';

/**
 * Phase 49M-1 §2.5/§2.6: the control plane's refusal and execution rules.
 *
 * WHAT THIS FILE PROVES, ordered by what each would cost if it were false:
 *
 *  1. A DOWNGRADE CANNOT BE REQUESTED AS AN UPGRADE. Refused before a row is written, with a
 *     code that distinguishes "not newer" from "same version".
 *  2. A WITHDRAWN RELEASE IS NEVER DEPLOYABLE, including as a rollback target. That is the
 *     entire reason WITHDRAWN and DEPRECATED are separate enum members.
 *  3. AN ILLEGAL TRANSITION IS REFUSED, and the reason comes from the pure table rather than
 *     from a second opinion held here.
 *  4. A SECOND ACTION AGAINST AN IN-FLIGHT INSTANCE IS REFUSED, not queued.
 *  5. A REPEATED SUBMIT COLLAPSES onto the existing execution instead of deploying twice.
 *  6. REMOTE_AGENT IS REFUSED at request time, so no execution exists that nothing can run.
 *  7. REFUSALS ARE AUDITED. A refusal that leaves no trace is indistinguishable from a
 *     request nobody made.
 *
 * The Prisma layer is a hand-built stub rather than a real client: every assertion here is
 * about a DECISION, and a decision that needs a database to be observed is a decision that is
 * hard to test. The four tables' CHECK constraints are exercised separately against a real
 * Postgres in the migration verification.
 */

const REG = { id: 'reg-1', moduleId: 'finance' };
const TARGET = {
  id: 'tgt-1',
  targetKey: 'local-primary',
  targetType: 'LOCAL_SERVER' as const,
  enabled: true,
  credentialRef: null,
};

const request = (over: Record<string, unknown> = {}) => ({
  moduleId: 'finance',
  action: 'PROVISION' as const,
  targetKey: 'local-primary',
  requestKey: 'req-0001',
  releaseVersion: '1.0.0',
  ...over,
});

describe('ModuleProvisioningService', () => {
  let prisma: {
    moduleRegistration: { findUnique: jest.Mock };
    provisioningTarget: { findUnique: jest.Mock };
    moduleInstance: { findUnique: jest.Mock };
    moduleRelease: { findUnique: jest.Mock };
    moduleProvisioningExecution: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    moduleOperationalStatus: { findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock };
  };

  let audit: { log: jest.Mock };
  /**
   * 49M-2. The FULL facade is stubbed, not only the `provisioning` method this service uses: a
   * partial stub would turn a misdirected emission into a TypeError instead of a failed
   * assertion.
   */
  let lifecycle: {
    record: jest.Mock;
    integration: jest.Mock;
    module: jest.Mock;
    provisioning: jest.Mock;
  };
  let registry: ProvisioningProviderRegistry;
  let service: ModuleProvisioningService;

  beforeEach(() => {
    prisma = {
      moduleRegistration: { findUnique: jest.fn().mockResolvedValue(REG) },
      provisioningTarget: { findUnique: jest.fn().mockResolvedValue(TARGET) },
      moduleInstance: { findUnique: jest.fn() },
      // A PUBLISHED 1.0.0 is the default so each test can vary ONE thing. Tests that care
      // about status or ordering override it explicitly.
      moduleRelease: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'rel-1', version: '1.0.0', releaseStatus: 'PUBLISHED' }),
      },
      moduleProvisioningExecution: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'exec-1' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      moduleOperationalStatus: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    audit = { log: jest.fn().mockResolvedValue(undefined) };

    lifecycle = {
      record: jest.fn(),
      integration: jest.fn(),
      module: jest.fn(),
      provisioning: jest.fn(),
    };

    registry = new ProvisioningProviderRegistry(
      new LocalProvisioningProvider({ probeInstance: jest.fn() } as never),
    );

    // 49M-2: the lifecycle sink is the FOURTH constructor argument. It is `@Optional()` on the
    // service, so passing it here — rather than leaving it undefined as before — is what makes
    // the emission assertions below capable of failing.
    service = new ModuleProvisioningService(
      prisma as never,
      registry,
      audit as never,
      lifecycle as never,
    );
  });

  const publishedRelease = (over: Record<string, unknown> = {}) => ({
    id: 'rel-1',
    version: '1.0.0',
    releaseStatus: 'PUBLISHED',
    ...over,
  });

  const instanceAt = (state: string, version = '1.0.0') => ({
    id: 'inst-1',
    moduleId: 'finance',
    version,
    operationalStatus: { operationalState: state, currentVersion: version },
  });

  describe('request — refusals before any row is written', () => {
    it('refuses an unknown module', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'MODULE_NOT_FOUND',
      });

      expect(prisma.moduleProvisioningExecution.create).not.toHaveBeenCalled();
    });

    it('refuses an unknown target', async () => {
      prisma.provisioningTarget.findUnique.mockResolvedValue(null);

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'TARGET_NOT_FOUND',
      });
    });

    it('refuses a disabled target', async () => {
      prisma.provisioningTarget.findUnique.mockResolvedValue({ ...TARGET, enabled: false });

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'TARGET_DISABLED',
      });
    });

    it('refuses REMOTE_AGENT with PROVIDER_UNAVAILABLE and writes nothing', async () => {
      // DEFERRED is a refusal at request time, not an execution nothing can ever run.
      prisma.provisioningTarget.findUnique.mockResolvedValue({
        ...TARGET,
        targetType: 'REMOTE_AGENT',
        credentialRef: 'agent-token-1',
      });

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'PROVIDER_UNAVAILABLE',
      });

      expect(prisma.moduleProvisioningExecution.create).not.toHaveBeenCalled();
    });

    it('refuses RESTART because the provider declares it unsupported', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE'));

      await expect(
        service.request('admin-1', request({ action: 'RESTART', instanceKey: 'finance-prod-01' })),
      ).resolves.toEqual({ accepted: false, refusal: 'STEP_UNSUPPORTED' });
    });

    it('refuses a non-PROVISION action with no instance key', async () => {
      await expect(
        service.request('admin-1', request({ action: 'STOP', releaseVersion: undefined })),
      ).resolves.toEqual({ accepted: false, refusal: 'INSTANCE_NOT_FOUND' });
    });

    it('refuses an instance that belongs to a different module', async () => {
      // Reported as INSTANCE_NOT_FOUND rather than a distinct code, so the two answers cannot
      // be compared to enumerate another module's instance ids.
      prisma.moduleInstance.findUnique.mockResolvedValue({
        ...instanceAt('ACTIVE'),
        moduleId: 'hr',
      });

      await expect(
        service.request(
          'admin-1',
          request({ action: 'STOP', instanceKey: 'hr-prod-01', releaseVersion: undefined }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'INSTANCE_NOT_FOUND' });
    });
  });

  describe('request — transition legality comes from the pure table', () => {
    it('refuses STOP from a DECOMMISSIONED instance as TERMINAL_STATE', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('DECOMMISSIONED'));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'STOP', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'TERMINAL_STATE' });
    });

    it('refuses DECOMMISSION from ACTIVE as ILLEGAL_TRANSITION', async () => {
      // Decommissioning is destructive and must pass through a deliberate DISABLED step.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE'));

      await expect(
        service.request(
          'admin-1',
          request({
            action: 'DECOMMISSION',
            instanceKey: 'finance-prod-01',
            releaseVersion: undefined,
          }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'ILLEGAL_TRANSITION' });
    });

    it('accepts DECOMMISSION from DISABLED', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('DISABLED'));

      await expect(
        service.request(
          'admin-1',
          request({
            action: 'DECOMMISSION',
            instanceKey: 'finance-prod-01',
            releaseVersion: undefined,
          }),
        ),
      ).resolves.toMatchObject({ accepted: true, executionId: 'exec-1' });
    });

    it('refuses a second action while the instance is mid-flight', async () => {
      // Two provisioning runs against one instance race on the same artifact and config.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('UPDATING'));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'STOP', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'EXECUTION_IN_PROGRESS' });
    });

    it('refuses when a PENDING or RUNNING execution already exists for the instance', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE'));
      prisma.moduleProvisioningExecution.count.mockResolvedValue(1);

      await expect(
        service.request(
          'admin-1',
          request({ action: 'STOP', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'EXECUTION_IN_PROGRESS' });
    });
    it('prefers EXECUTION_IN_PROGRESS over ILLEGAL_TRANSITION when both apply', async () => {
      // UPDATING has no edge to DISABLED, so the transition check would also refuse this.
      // ILLEGAL_TRANSITION would tell the operator the action is never allowed, when in fact
      // it becomes legal the moment the upgrade lands. "Wait" is the actionable answer.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('UPDATING'));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'STOP', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'EXECUTION_IN_PROGRESS' });
    });
  });

  describe('request — release resolution and version ordering', () => {
    it('refuses a PROVISION with no release version', async () => {
      await expect(
        service.request('admin-1', request({ releaseVersion: undefined })),
      ).resolves.toEqual({ accepted: false, refusal: 'RELEASE_NOT_FOUND' });
    });

    it('refuses an unknown release version', async () => {
      prisma.moduleRelease.findUnique.mockResolvedValue(null);

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'RELEASE_NOT_FOUND',
      });
    });

    it('refuses a DRAFT release', async () => {
      prisma.moduleRelease.findUnique.mockResolvedValue(
        publishedRelease({ releaseStatus: 'DRAFT' }),
      );

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: false,
        refusal: 'RELEASE_NOT_PUBLISHED',
      });
    });

    it('refuses a WITHDRAWN release even as a rollback target', async () => {
      // The entire reason WITHDRAWN and DEPRECATED are separate members: a release pulled for
      // a security reason must not remain reachable by rolling back to it.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '2.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(
        publishedRelease({ version: '1.0.0', releaseStatus: 'WITHDRAWN' }),
      );

      await expect(
        service.request(
          'admin-1',
          request({
            action: 'ROLLBACK',
            instanceKey: 'finance-prod-01',
            releaseVersion: '1.0.0',
          }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'RELEASE_NOT_PUBLISHED' });
    });

    it('allows a DEPRECATED release for ROLLBACK but not for UPGRADE', async () => {
      // Deprecated means "do not deploy new", not "unsafe". Blocking it outright would strand
      // an instance whose only known-good previous version has since been deprecated.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '2.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(
        publishedRelease({ version: '1.0.0', releaseStatus: 'DEPRECATED' }),
      );

      await expect(
        service.request(
          'admin-1',
          request({ action: 'ROLLBACK', instanceKey: 'finance-prod-01', releaseVersion: '1.0.0' }),
        ),
      ).resolves.toMatchObject({ accepted: true });

      prisma.moduleRelease.findUnique.mockResolvedValue(
        publishedRelease({ version: '3.0.0', releaseStatus: 'DEPRECATED' }),
      );

      await expect(
        service.request(
          'admin-1',
          request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '3.0.0' }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'RELEASE_NOT_PUBLISHED' });
    });

    it('refuses a downgrade presented as an UPGRADE with NOT_NEWER', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '2.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '1.9.0' }));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '1.9.0' }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'NOT_NEWER' });
    });

    it('refuses a no-op UPGRADE with SAME_VERSION, distinct from NOT_NEWER', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '2.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '2.0.0' }));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '2.0.0' }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'SAME_VERSION' });
    });

    it('refuses an upgrade presented as a ROLLBACK with NOT_OLDER', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '1.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '2.0.0' }));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'ROLLBACK', instanceKey: 'finance-prod-01', releaseVersion: '2.0.0' }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'NOT_OLDER' });
    });

    it('refuses an unparseable running version rather than guessing the order', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', 'latest'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '2.0.0' }));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '2.0.0' }),
        ),
      ).resolves.toEqual({ accepted: false, refusal: 'VERSION_MALFORMED' });
    });

    it('accepts a genuine UPGRADE', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '1.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '1.1.0' }));

      await expect(
        service.request(
          'admin-1',
          request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '1.1.0' }),
        ),
      ).resolves.toMatchObject({ accepted: true, status: 'PENDING', deduplicated: false });
    });
  });

  describe('request — idempotency and audit', () => {
    it('collapses a repeated submit onto the existing execution', async () => {
      // The whole point of enforcing idempotence: a double-click deploys once.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue({
        id: 'exec-existing',
        status: 'PENDING',
      });

      await expect(service.request('admin-1', request())).resolves.toEqual({
        accepted: true,
        executionId: 'exec-existing',
        status: 'PENDING',
        deduplicated: true,
      });

      expect(prisma.moduleProvisioningExecution.create).not.toHaveBeenCalled();
    });

    it('folds module, action, release and caller token into the idempotency key', async () => {
      await service.request('admin-1', request());

      expect(prisma.moduleProvisioningExecution.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { idempotencyKey: 'finance:PROVISION:1.0.0:req-0001' },
        }),
      );
    });

    it('treats a different action under the same request key as a different request', async () => {
      // Otherwise a UI that reuses its token would silently swallow the second, real action.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '1.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '1.1.0' }));

      await service.request(
        'admin-1',
        request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '1.1.0' }),
      );

      expect(prisma.moduleProvisioningExecution.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { idempotencyKey: 'finance:UPGRADE:1.1.0:req-0001' } }),
      );
    });

    it('records an accepted execution as claimable immediately, never as terminal', async () => {
      await service.request('admin-1', request());

      const data = prisma.moduleProvisioningExecution.create.mock.calls[0][0].data;

      expect(data).toMatchObject({
        status: 'PENDING',
        action: 'PROVISION',
        targetState: 'PROVISIONING',
        actorId: 'admin-1',
      });

      // NULL here would mean "not retryable", which the terminal_not_retryable CHECK
      // reserves for finished rows.
      expect(data.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('snapshots instanceKey alongside the FK so a deleted instance keeps its history', async () => {
      // The defect the shadow DB caught: ON DELETE SET NULL on instanceId collided with the
      // nonprovision_requires_instance CHECK. instanceKey is never nulled.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE'));

      await service.request(
        'admin-1',
        request({ action: 'STOP', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
      );

      expect(prisma.moduleProvisioningExecution.create.mock.calls[0][0].data).toMatchObject({
        instanceId: 'inst-1',
        instanceKey: 'finance-prod-01',
      });
    });

    it('audits a refusal, because a refusal that leaves no trace is invisible', async () => {
      prisma.provisioningTarget.findUnique.mockResolvedValue({ ...TARGET, enabled: false });

      await service.request('admin-1', request());

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'module.provisioning.refused',
          resource: 'ModuleProvisioningExecution',
          userId: 'admin-1',
          newValue: expect.objectContaining({ refusal: 'TARGET_DISABLED' }),
        }),
      );
    });

    it('audits an acceptance', async () => {
      await service.request('admin-1', request());

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'module.provisioning.requested',
          resourceId: 'exec-1',
        }),
      );
    });

    it('still accepts when the audit write fails', async () => {
      // The deployment is the fact; the log is the record of it. Losing the record must not
      // roll back the fact.
      audit.log.mockRejectedValue(new Error('audit down'));

      await expect(service.request('admin-1', request())).resolves.toMatchObject({
        accepted: true,
      });
    });
  });

  describe('runExecution — the conditional-UPDATE claim', () => {
    const executionRow = (over: Record<string, unknown> = {}) => ({
      id: 'exec-1',
      moduleId: 'finance',
      action: 'PROVISION',
      targetState: 'PROVISIONING',
      attemptCount: 1,
      correlationId: 'corr-1',
      actorId: 'admin-1',
      instanceId: 'inst-1',
      instanceKey: 'finance-prod-01',
      target: TARGET,
      release: {
        id: 'rel-1',
        moduleId: 'finance',
        version: '1.0.0',
        artifactKey: 'modules/finance/1.0.0/bundle.tgz',
        checksumAlgorithm: 'SHA-256',
        checksum: 'a'.repeat(64),
        artifactBytes: 2048,
        protocolVersion: 1,
        apiContracts: ['module.invoke@v1'],
        requiredCapabilities: [],
      },
      instance: { id: 'inst-1', version: '1.0.0', capabilities: [] },
      ...over,
    });

    it('does nothing when another process already claimed the row', async () => {
      // The loser of the race. `count === 0` because the row is no longer PENDING.
      prisma.moduleProvisioningExecution.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');

      expect(prisma.moduleProvisioningExecution.findUnique).not.toHaveBeenCalled();
      expect(prisma.moduleProvisioningExecution.update).not.toHaveBeenCalled();
    });

    it('claims only a PENDING row, and counts the attempt', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(executionRow());

      await service.runExecution('exec-1');

      expect(prisma.moduleProvisioningExecution.updateMany).toHaveBeenCalledWith({
        where: { id: 'exec-1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'RUNNING',
          attemptCount: { increment: 1 },
        }),
      });
    });

    it('writes the operational transition and closes the row as SUCCEEDED', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(executionRow());

      await expect(service.runExecution('exec-1')).resolves.toBe('OK');

      expect(prisma.moduleOperationalStatus.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { instanceRowId: 'inst-1' },
          create: expect.objectContaining({ operationalState: 'PROVISIONING' }),
        }),
      );

      expect(prisma.moduleProvisioningExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SUCCEEDED',
            errorCode: null,
            failedStep: null,
            // Terminal rows are NOT claimable. Also enforced by the
            // terminal_not_retryable CHECK.
            nextAttemptAt: null,
          }),
        }),
      );
    });

    it('records an unsupported step as FAILED with its own code, never as success', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        executionRow({ action: 'RESTART', targetState: 'UPDATING' }),
      );

      await expect(service.runExecution('exec-1')).resolves.toBe('STEP_UNSUPPORTED');

      expect(prisma.moduleProvisioningExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'STEP_UNSUPPORTED',
            failedStep: 'RESTART',
            nextAttemptAt: null,
          }),
        }),
      );

      // No state was advanced on an unsupported step.
      expect(prisma.moduleOperationalStatus.upsert).not.toHaveBeenCalled();
    });

    it('mirrors the failure code onto the operational status row', async () => {
      // So the admin list can explain an unhealthy instance without joining history.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        executionRow({ action: 'RESTART', targetState: 'UPDATING' }),
      );
      prisma.moduleOperationalStatus.findUnique.mockResolvedValue({
        operationalState: 'PROVISIONING',
      });

      await service.runExecution('exec-1');

      expect(prisma.moduleOperationalStatus.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operationalState: 'FAILED',
            lastErrorCode: 'STEP_UNSUPPORTED',
          }),
        }),
      );
    });

    it('does not force FAILED onto a terminal instance', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        executionRow({ action: 'RESTART', targetState: 'UPDATING' }),
      );
      prisma.moduleOperationalStatus.findUnique.mockResolvedValue({
        operationalState: 'DECOMMISSIONED',
      });

      await service.runExecution('exec-1');

      expect(prisma.moduleOperationalStatus.update).not.toHaveBeenCalled();
    });

    it('fails with PROVIDER_UNAVAILABLE when the target type no longer resolves', async () => {
      // Re-checked at execution time, not assumed from acceptance time.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        executionRow({ target: { ...TARGET, targetType: 'REMOTE_AGENT' } }),
      );

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_UNAVAILABLE');
    });

    it('fails with TARGET_DISABLED when the target was disabled after acceptance', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        executionRow({ target: { ...TARGET, enabled: false } }),
      );

      await expect(service.runExecution('exec-1')).resolves.toBe('TARGET_DISABLED');
    });

    it('refuses to write a transition that became illegal after acceptance', async () => {
      // A concurrent decommission between acceptance and execution. Writing PROVISIONING
      // because it was legal earlier is the exact bug a transition table exists to prevent.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(executionRow());
      prisma.moduleOperationalStatus.findUnique.mockResolvedValue({
        operationalState: 'DECOMMISSIONED',
        currentVersion: '1.0.0',
      });

      await expect(service.runExecution('exec-1')).resolves.toBe('OK');

      expect(prisma.moduleOperationalStatus.upsert).not.toHaveBeenCalled();
    });

    it('never throws, even when a write blows up mid-run', async () => {
      // An unhandled rejection terminates the Node process, turning one bad artifact into an
      // outage. Every failure becomes a terminal row with a code instead.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(executionRow());
      prisma.moduleOperationalStatus.findUnique.mockRejectedValue(new Error('db gone'));

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');
    });

    it('returns PROVIDER_ERROR when the claimed row vanished', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(null);

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');
    });

  // ───────────────────────────────────────────────────────────────────────────
  // 49M-2 — the lifecycle timeline
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * WHY THESE ASSERT THE PAYLOAD AND NOT THE CALL COUNT ALONE: the sink is the `@Optional()`
   * fourth constructor argument, so a spec that forgot to pass it would get a silent no-op and a
   * green suite. Every test below reads the emitted `eventType`, `phase` and `outcomeCode`.
   *
   * `lifecycle.provisioning` IS THE ASSERTED METHOD. The facade is what stamps
   * `domain: 'PROVISIONING'` and `subjectType`, so a caller reaching for `record` directly would
   * be free to mislabel the row.
   */
  describe('lifecycle emission', () => {
    const emitted = (index = 0) => {
      const [eventType, phase, subject, extra] = lifecycle.provisioning.mock.calls[index] as [
        string,
        string,
        { id?: string; key?: string },
        {
          actorType?: string;
          actorId?: string | null;
          tenantId?: string | null;
          outcomeCode?: string | null;
          module?: { moduleId?: string | null; instanceId?: string | null; deploymentMode?: string | null };
          detail?: Record<string, unknown>;
        },
      ];

      return { eventType, phase, subject, extra };
    };

    /** The shape `runExecution` selects. Mirrors the fixture the claim tests above use. */
    const runnableRow = (over: Record<string, unknown> = {}) => ({
      id: 'exec-1',
      moduleId: 'finance',
      action: 'PROVISION',
      targetState: 'PROVISIONING',
      attemptCount: 1,
      correlationId: 'corr-1',
      actorId: 'admin-1',
      instanceId: 'inst-1',
      instanceKey: 'finance-prod-01',
      target: TARGET,
      release: {
        id: 'rel-1',
        moduleId: 'finance',
        version: '1.0.0',
        artifactKey: 'modules/finance/1.0.0/bundle.tgz',
        checksumAlgorithm: 'SHA-256',
        checksum: 'a'.repeat(64),
        artifactBytes: 2048,
        protocolVersion: 1,
        apiContracts: ['module.invoke@v1'],
        requiredCapabilities: [],
      },
      instance: { id: 'inst-1', version: '1.0.0', capabilities: [] },
      ...over,
    });

    it('emits an accepted request as STARTED, never as SUCCEEDED', async () => {
      // The row exists and is claimable; NOTHING has been deployed. A SUCCEEDED phase here
      // would make an accepted-then-failed run read as two successes.
      await service.request('admin-1', request());

      expect(lifecycle.provisioning).toHaveBeenCalledTimes(1);

      const { eventType, phase, subject, extra } = emitted();

      expect(eventType).toBe('provisioning.execution.requested');
      expect(phase).toBe('STARTED');
      // Keyed by the EXECUTION id, which is what a polling operator holds.
      expect(subject).toEqual({ id: 'exec-1', key: 'finance' });
      expect(extra.actorType).toBe('USER');
      expect(extra.actorId).toBe('admin-1');
      expect(extra.outcomeCode).toBeNull();
      expect(extra.detail).toEqual({
        action: 'PROVISION',
        targetKey: 'local-primary',
        targetState: 'PROVISIONING',
        releaseVersion: '1.0.0',
      });
    });

    it('carries the tenant the execution row was written with', async () => {
      // Read from the SAME context the row used, so the lifecycle row cannot disagree with the
      // execution it describes.
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-9',
        startTime: Date.now(),
        tenantId: 'tenant-3',
      });

      await service.request('admin-1', request());

      const { extra } = emitted();

      expect(extra.tenantId).toBe('tenant-3');
      expect(prisma.moduleProvisioningExecution.create.mock.calls[0][0].data.tenantId).toBe(
        'tenant-3',
      );
    });

    it('emits NOTHING for a deduplicated submit, which changed no state', async () => {
      // A double-click deploys once, and it must also produce ONE timeline entry — the row from
      // the original request.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue({
        id: 'exec-existing',
        status: 'PENDING',
      });

      await expect(service.request('admin-1', request())).resolves.toMatchObject({
        deduplicated: true,
      });

      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });

    it('emits REFUSED — not FAILED — for a policy decision, with the specific code', async () => {
      // Nothing failed and nothing was skipped: a policy declined the request. Normalizing this
      // to FAILED would make an operator's illegal transition indistinguishable from a provider
      // blowing up mid-deploy.
      prisma.provisioningTarget.findUnique.mockResolvedValue({ ...TARGET, enabled: false });

      await service.request('admin-1', request());

      const { eventType, phase, subject, extra } = emitted();

      expect(eventType).toBe('provisioning.execution.refused');
      expect(phase).toBe('REFUSED');
      // THE MODULE ID, not an execution id, because no execution row exists — that is what
      // refusal means. It matches the `resourceId` the audit row uses.
      expect(subject).toEqual({ id: 'finance', key: 'finance' });
      expect(extra.outcomeCode).toBe('TARGET_DISABLED');
      expect(extra.actorId).toBe('admin-1');
      expect(audit.log.mock.calls[0][0].resourceId).toBe('finance');
    });

    it('keeps each refusal code verbatim rather than collapsing them', async () => {
      // `NOT_NEWER` and `SAME_VERSION` lead an operator to different actions, which is the whole
      // reason the refusal union is closed and specific.
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE', '2.0.0'));
      prisma.moduleRelease.findUnique.mockResolvedValue(publishedRelease({ version: '1.0.0' }));

      await service.request(
        'admin-1',
        request({ action: 'UPGRADE', instanceKey: 'finance-prod-01', releaseVersion: '1.0.0' }),
      );

      expect(emitted().extra.outcomeCode).toBe('NOT_NEWER');
    });

    it('emits REFUSED for an illegal transition, keyed to the same subject as the audit row', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceAt('ACTIVE'));

      await service.request(
        'admin-1',
        request({ action: 'DECOMMISSION', instanceKey: 'finance-prod-01', releaseVersion: undefined }),
      );

      const { phase, extra } = emitted();

      expect(phase).toBe('REFUSED');
      expect(extra.outcomeCode).toBe('ILLEGAL_TRANSITION');
      expect(extra.module).toMatchObject({ moduleId: 'finance', instanceId: 'finance-prod-01' });
    });

    it('emits exactly ONE row for a refusal, never a REQUESTED row as well', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await service.request('admin-1', request());

      expect(lifecycle.provisioning).toHaveBeenCalledTimes(1);
      expect(emitted().eventType).toBe('provisioning.execution.refused');
    });

    it('emits the terminal row as SUCCEEDED, attributed to SYSTEM', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());

      await expect(service.runExecution('exec-1')).resolves.toBe('OK');

      expect(lifecycle.provisioning).toHaveBeenCalledTimes(1);

      const { eventType, phase, subject, extra } = emitted();

      expect(eventType).toBe('provisioning.execution.completed');
      expect(phase).toBe('SUCCEEDED');
      expect(subject).toEqual({ id: 'exec-1', key: 'finance' });
      // SYSTEM, not MODULE and not the requesting user: a terminal transition is written by the
      // API's own execution loop, not by the module being deployed.
      expect(extra.actorType).toBe('SYSTEM');
      expect(extra.actorId).toBeNull();
      expect(extra.outcomeCode).toBe('OK');
      expect(extra.detail).toEqual({
        status: 'SUCCEEDED',
        action: 'PROVISION',
        targetState: 'PROVISIONING',
        version: '1.0.0',
      });
      expect(extra.module).toEqual({
        moduleId: 'finance',
        instanceId: 'finance-prod-01',
        deploymentMode: null,
      });
    });

    it('emits FAILED with STEP_UNSUPPORTED rather than reporting an unperformed step', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        runnableRow({ action: 'RESTART', targetState: 'UPDATING' }),
      );

      await expect(service.runExecution('exec-1')).resolves.toBe('STEP_UNSUPPORTED');

      const { phase, extra } = emitted();

      expect(phase).toBe('FAILED');
      // `phase` normalizes; `outcomeCode` does not. "This provider cannot restart processes" and
      // "the restart failed" lead an operator to different actions.
      expect(extra.outcomeCode).toBe('STEP_UNSUPPORTED');
      expect(extra.detail).toMatchObject({ status: 'FAILED', action: 'RESTART' });
    });

    it('keeps a provider TIMEOUT verbatim under a normalized FAILED phase', async () => {
      jest.spyOn(registry, 'resolve').mockReturnValue({
        provision: jest.fn().mockResolvedValue({ ok: false, supported: true, code: 'TIMEOUT' }),
      } as never);
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());

      await expect(service.runExecution('exec-1')).resolves.toBe('TIMEOUT');

      const { phase, extra } = emitted();

      expect(phase).toBe('FAILED');
      expect(extra.outcomeCode).toBe('TIMEOUT');
    });

    it('attributes a run with no plan to a NULL module rather than inventing one', async () => {
      // `finish()` is reachable with `plan === null` when the provider could not be resolved.
      // Naming a module there would attribute a failure to the wrong one; the `executionId` in
      // `subjectId` still identifies the run.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(
        runnableRow({ target: { ...TARGET, targetType: 'REMOTE_AGENT' } }),
      );

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_UNAVAILABLE');

      const { subject, extra } = emitted();

      expect(subject).toEqual({ id: 'exec-1', key: undefined });
      expect(extra.module).toMatchObject({ moduleId: null });
      expect(extra.outcomeCode).toBe('PROVIDER_UNAVAILABLE');
    });

    it('emits a terminal row even when the run died on an unexpected throw', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());
      prisma.moduleOperationalStatus.findUnique.mockRejectedValue(new Error('db gone'));

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');

      const { eventType, phase, extra } = emitted();

      expect(eventType).toBe('provisioning.execution.completed');
      expect(phase).toBe('FAILED');
      expect(extra.outcomeCode).toBe('PROVIDER_ERROR');
    });

    it('emits exactly ONE terminal row per run, never one per provider step', async () => {
      // `dispatch()` routes one action to one provider method inside a single `runExecution`;
      // a per-step row would only repeat the `action` the terminal row already carries.
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());

      await service.runExecution('exec-1');

      expect(lifecycle.provisioning).toHaveBeenCalledTimes(1);
    });

    it('emits NOTHING when the claim is lost, rather than a SKIPPED row', async () => {
      // The claim is a conditional UPDATE whose loser does nothing. A row here would record
      // CONTENTION, not lifecycle — REQUESTED already marks the start and the terminal row the
      // end, so the run this process did not get is fully described by the winner's rows.
      prisma.moduleProvisioningExecution.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');

      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });

    it('emits NOTHING when the claimed row vanished before it could be read', async () => {
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(null);

      await expect(service.runExecution('exec-1')).resolves.toBe('PROVIDER_ERROR');

      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });

    it('never writes into another domain’s timeline', async () => {
      await service.request('admin-1', request());

      expect(lifecycle.record).not.toHaveBeenCalled();
      expect(lifecycle.integration).not.toHaveBeenCalled();
      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('accepts the request when the emission itself throws', async () => {
      // The facade's `void` return defends against a rejected promise; the try/catch in
      // `emitLifecycle` defends against a SYNCHRONOUS throw, which is what this reproduces. A
      // control plane that could not deploy because the log database was unreachable would
      // invert the decision that made observability optional.
      lifecycle.provisioning.mockImplementation(() => {
        throw new Error('observability down');
      });

      await expect(service.request('admin-1', request())).resolves.toMatchObject({
        accepted: true,
        executionId: 'exec-1',
      });
    });

    it('closes a run out when the emission throws on the terminal path', async () => {
      lifecycle.provisioning.mockImplementation(() => {
        throw new Error('observability down');
      });
      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());

      await expect(service.runExecution('exec-1')).resolves.toBe('OK');
    });

    it('runs unchanged when observability is not wired at all', async () => {
      // The `@Optional()` fourth argument asserted rather than assumed — this is the exact shape
      // every other test in this file used before 49M-2.
      const withoutObservability = new ModuleProvisioningService(
        prisma as never,
        registry,
        audit as never,
      );

      prisma.moduleProvisioningExecution.findUnique.mockResolvedValue(runnableRow());

      await expect(withoutObservability.runExecution('exec-1')).resolves.toBe('OK');
      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });
  });

  });
});
