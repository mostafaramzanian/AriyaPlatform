import { LocalProvisioningProvider } from './local-provisioning.provider';
import type { ProvisioningPlan } from './module-provisioning.contract';

/**
 * Phase 49M-1 §2.1/§2.5: the one real provider.
 *
 * WHAT THIS FILE PROVES, in order of how badly each would hurt if it were false:
 *
 *  1. `restart` REFUSES. It returns `supported: false` with `STEP_UNSUPPORTED` and never
 *     `ok: true`. An operator who believes a module was restarted stops investigating why it
 *     is misbehaving, which is strictly worse than a disabled button.
 *  2. THE ACTIVATION GATE IS ALL-OR-NOTHING. Five conditions, and one false condition fails
 *     the whole verification with a distinguishable code — never activation-with-a-warning.
 *  3. NO STEP THROWS. Every method resolves, because a rejection would surface as a 500 on
 *     an admin route that should be reporting "failed at VERIFY, CHECKSUM_MISMATCH".
 */

const HEX64 = 'a'.repeat(64);

const plan = (over: Partial<ProvisioningPlan> = {}): ProvisioningPlan => ({
  executionId: 'exec-1',
  action: 'PROVISION',
  target: {
    id: 'tgt-1',
    targetKey: 'local-primary',
    targetType: 'LOCAL_SERVER',
    enabled: true,
    credentialRef: null,
  },
  instance: { instanceKey: 'finance-prod-01', moduleId: 'finance' },
  release: {
    id: 'rel-1',
    moduleId: 'finance',
    version: '1.0.0',
    artifactKey: 'modules/finance/1.0.0/bundle.tgz',
    checksumAlgorithm: 'SHA-256',
    checksum: HEX64,
    artifactBytes: 2048,
    protocolVersion: 1,
    apiContracts: ['module.invoke@v1'],
    requiredCapabilities: [],
  },
  targetState: 'PROVISIONING',
  correlationId: 'corr-1',
  timeoutMs: 30_000,
  ...over,
});

describe('LocalProvisioningProvider', () => {
  const health = { probeInstance: jest.fn() };
  const build = () => new LocalProvisioningProvider(health as never);

  beforeEach(() => {
    health.probeInstance.mockReset();
    health.probeInstance.mockResolvedValue({
      registryKnown: true,
      endpointReachable: true,
      applicationHealthy: true,
      state: 'HEALTHY',
    });
  });

  it('serves LOCAL_SERVER and nothing else', () => {
    expect(build().targetType).toBe('LOCAL_SERVER');
  });

  describe('validateTarget', () => {
    it('accepts an enabled LOCAL_SERVER target', async () => {
      await expect(build().validateTarget(plan().target)).resolves.toEqual({
        usable: true,
        code: 'OK',
      });
    });

    it('refuses a disabled target', async () => {
      const target = { ...plan().target, enabled: false };

      await expect(build().validateTarget(target)).resolves.toEqual({
        usable: false,
        code: 'TARGET_DISABLED',
      });
    });

    it('refuses a target of the wrong type', async () => {
      const target = { ...plan().target, targetType: 'REMOTE_AGENT' as const };

      await expect(build().validateTarget(target)).resolves.toEqual({
        usable: false,
        code: 'PROVIDER_UNAVAILABLE',
      });
    });
  });

  describe('restart — the honest refusal', () => {
    it('reports STEP_UNSUPPORTED and never success', async () => {
      const outcome = await build().restart();

      expect(outcome.ok).toBe(false);
      expect(outcome.supported).toBe(false);
      expect(outcome.code).toBe('STEP_UNSUPPORTED');
    });
  });

  describe('provision', () => {
    it('succeeds for a consistent artifact reference', async () => {
      const outcome = await build().provision(plan());

      expect(outcome.ok).toBe(true);
      expect(outcome.supported).toBe(true);
      expect(outcome.code).toBe('OK');
    });

    it('refuses a plan with no release', async () => {
      const outcome = await build().provision(plan({ release: undefined }));

      expect(outcome).toMatchObject({ ok: false, code: 'ARTIFACT_NOT_FOUND' });
    });

    it('refuses a checksum whose shape does not match its algorithm', async () => {
      // A digest nothing can recompute is not a verification, so it is refused before the
      // deployment rather than after it is running.
      const outcome = await build().provision(
        plan({ release: { ...plan().release!, checksum: 'abc' } }),
      );

      expect(outcome).toMatchObject({ ok: false, code: 'CHECKSUM_MISMATCH' });
    });

    it('refuses an unknown checksum algorithm rather than accepting it', async () => {
      const outcome = await build().provision(
        plan({ release: { ...plan().release!, checksumAlgorithm: 'CRC32', checksum: 'deadbeef' } }),
      );

      expect(outcome).toMatchObject({ ok: false, code: 'CHECKSUM_MISMATCH' });
    });
  });

  describe('verify — the five-condition gate', () => {
    const running = (over: Partial<ProvisioningPlan> = {}) =>
      plan({
        action: 'VERIFY',
        targetState: 'VERIFYING',
        instance: {
          id: 'inst-1',
          instanceKey: 'finance-prod-01',
          moduleId: 'finance',
          version: '1.0.0',
          declaredCapabilities: ['invoice.read'],
        },
        ...over,
      });

    it('passes when all five conditions hold', async () => {
      const outcome = await build().verify(running());

      expect(outcome).toMatchObject({
        ok: true,
        supported: true,
        code: 'OK',
        artifactIntact: true,
        identityMatches: true,
        versionMatches: true,
        contractCompatible: true,
        capabilitiesPresent: true,
      });
    });

    it('fails on a checksum shape mismatch and reports nothing else as passing', async () => {
      const outcome = await build().verify(
        running({ release: { ...plan().release!, checksum: 'nope' } }),
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe('CHECKSUM_MISMATCH');
      expect(outcome.artifactIntact).toBe(false);
      // ALL OR NOTHING: nothing downstream is claimed to have passed.
      expect(outcome.identityMatches).toBe(false);
      expect(outcome.versionMatches).toBe(false);
      expect(outcome.contractCompatible).toBe(false);
      expect(outcome.capabilitiesPresent).toBe(false);
    });

    it('fails when the release belongs to a different module', async () => {
      // The one mismatch that would otherwise install another module's artifact under this
      // module's credential.
      const outcome = await build().verify(
        running({ release: { ...plan().release!, moduleId: 'hr' } }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        code: 'IDENTITY_MISMATCH',
        artifactIntact: true,
        identityMatches: false,
      });
    });

    it('fails when the release declares an incompatible protocol', async () => {
      const outcome = await build().verify(
        running({ release: { ...plan().release!, protocolVersion: 2 } }),
      );

      expect(outcome).toMatchObject({ ok: false, code: 'CONTRACT_INCOMPATIBLE' });
    });

    it('fails when the release does not serve the base contract', async () => {
      const outcome = await build().verify(
        running({ release: { ...plan().release!, apiContracts: ['invoice.read@v1'] } }),
      );

      expect(outcome).toMatchObject({ ok: false, code: 'CONTRACT_INCOMPATIBLE' });
    });

    it('fails when the health probe is not HEALTHY', async () => {
      health.probeInstance.mockResolvedValue({
        registryKnown: true,
        endpointReachable: false,
        applicationHealthy: false,
        state: 'UNAVAILABLE',
        errorCode: 'TIMEOUT',
      });

      const outcome = await build().verify(running());

      expect(outcome).toMatchObject({
        ok: false,
        code: 'HEALTH_UNHEALTHY',
        contractCompatible: true,
      });
    });

    it('fails when the running version is not the deployed version', async () => {
      // Something else is serving on that endpoint; activating silently would hide it.
      const outcome = await build().verify(
        running({
          instance: {
            id: 'inst-1',
            instanceKey: 'finance-prod-01',
            moduleId: 'finance',
            version: '0.9.0',
            declaredCapabilities: [],
          },
        }),
      );

      expect(outcome).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
    });

    it('fails when a required capability is missing', async () => {
      const outcome = await build().verify(
        running({
          release: { ...plan().release!, requiredCapabilities: ['invoice.write'] },
          instance: {
            id: 'inst-1',
            instanceKey: 'finance-prod-01',
            moduleId: 'finance',
            version: '1.0.0',
            declaredCapabilities: ['invoice.read'],
          },
        }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        code: 'CAPABILITY_MISSING',
        versionMatches: true,
        contractCompatible: true,
        capabilitiesPresent: false,
      });
    });

    it('does not probe during a first PROVISION, and does not claim a health observation', async () => {
      // Claiming HEALTHY for something not yet running would be inventing an observation —
      // the reason 49M returns UNKNOWN for an unprobed instance.
      const outcome = await build().verify(plan({ action: 'VERIFY', targetState: 'VERIFYING' }));

      expect(outcome.ok).toBe(true);
      expect(health.probeInstance).not.toHaveBeenCalled();
    });

    it('refuses a plan with no release', async () => {
      const outcome = await build().verify(running({ release: undefined }));

      expect(outcome).toMatchObject({ ok: false, code: 'ARTIFACT_NOT_FOUND' });
    });
  });
});
