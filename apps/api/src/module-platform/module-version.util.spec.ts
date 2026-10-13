import {
  checkRollbackOrder,
  checkUpgradeOrder,
  compareModuleVersions,
  isValidModuleVersion,
  parseModuleVersion,
} from './module-version.util';

/**
 * Phase 49M-1 §2.5: version ordering.
 *
 * WHY THIS SPEC LEADS WITH `10.0.0` vs `9.0.0`: that pair is the entire reason this module
 * exists instead of a string comparison. Lexicographically `'10.0.0' < '9.0.0'`, so a string
 * fallback would report a downgrade as an upgrade — the worst failure available to a control
 * plane that can replace a running module.
 */

describe('parseModuleVersion', () => {
  it('accepts exactly what ModuleInstance_version_format accepts', () => {
    expect(parseModuleVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseModuleVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseModuleVersion('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
    expect(parseModuleVersion('1.0.0-rc.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'rc.1',
    });
    expect(parseModuleVersion('1.0.0+build.5')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      build: 'build.5',
    });
  });

  it('refuses everything the database CHECK refuses', () => {
    // The migration's regex rejects each of these, so accepting them here would let the
    // comparison operate on values that can never appear in a row.
    for (const bad of ['', 'latest', 'v2', '2', '1.2', '1.2.3.4', 'a.b.c', '1.2.-3', ' 1.2.3']) {
      expect(parseModuleVersion(bad)).toBeUndefined();
      expect(isValidModuleVersion(bad)).toBe(false);
    }
  });

  it('refuses non-strings and absurd lengths without throwing', () => {
    for (const bad of [undefined, null, 0, {}, []] as unknown[]) {
      expect(parseModuleVersion(bad as string)).toBeUndefined();
    }

    // `Number('1'.repeat(400))` is Infinity, and two Infinity majors compare EQUAL — which
    // would make two different versions look identical. Refused by length first.
    expect(parseModuleVersion(`${'1'.repeat(400)}.0.0`)).toBeUndefined();
  });
});

describe('compareModuleVersions', () => {
  it('orders numerically, not lexicographically', () => {
    expect(compareModuleVersions('10.0.0', '9.0.0')).toBeGreaterThan(0);
    expect(compareModuleVersions('9.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareModuleVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareModuleVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  it('compares major, then minor, then patch', () => {
    expect(compareModuleVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareModuleVersions('1.2.0', '1.1.99')).toBeGreaterThan(0);
    expect(compareModuleVersions('1.1.2', '1.1.1')).toBeGreaterThan(0);
    expect(compareModuleVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('sorts a pre-release below its own release', () => {
    expect(compareModuleVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareModuleVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareModuleVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBeLessThan(0);
    expect(compareModuleVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('ignores build metadata', () => {
    // Two builds of one version differ only in their artifact checksum, which is what a caller
    // must compare if it needs to tell them apart.
    expect(compareModuleVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareModuleVersions('1.0.0+a', '1.0.0')).toBe(0);
  });

  it('returns undefined rather than falling back to string comparison', () => {
    expect(compareModuleVersions('latest', '1.0.0')).toBeUndefined();
    expect(compareModuleVersions('1.0.0', 'v2')).toBeUndefined();
    expect(compareModuleVersions('', '')).toBeUndefined();
  });

  it('is antisymmetric across every pair it can order', () => {
    const versions = ['0.0.1', '0.1.0', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];

    for (const a of versions) {
      for (const b of versions) {
        const forward = compareModuleVersions(a, b) as number;
        const backward = compareModuleVersions(b, a) as number;

        // `Math.sign` alone would compare -0 against 0 under Object.is, so normalise to an
        // integer: the property under test is the ORDER, not the numeric identity of zero.
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
        expect(Math.abs(Math.sign(forward))).toBe(a === b ? 0 : 1);
      }
    }
  });
});

describe('checkUpgradeOrder', () => {
  it('permits a strictly newer target', () => {
    expect(checkUpgradeOrder('1.0.0', '1.0.1')).toEqual({ ok: true });
    expect(checkUpgradeOrder('1.0.0', '2.0.0')).toEqual({ ok: true });
    expect(checkUpgradeOrder('9.0.0', '10.0.0')).toEqual({ ok: true });
    expect(checkUpgradeOrder('1.0.0-rc.1', '1.0.0')).toEqual({ ok: true });
  });

  it('refuses a silent downgrade', () => {
    // The specific hazard: a module rolled back by an "upgrade" loses whatever the newer
    // version wrote.
    expect(checkUpgradeOrder('10.0.0', '9.0.0')).toEqual({ ok: false, failure: 'NOT_NEWER' });
    expect(checkUpgradeOrder('2.0.0', '1.9.9')).toEqual({ ok: false, failure: 'NOT_NEWER' });
  });

  it('reports SAME_VERSION distinctly from NOT_NEWER', () => {
    // Re-deploying the identical version is a legitimate repair intent; telling the operator
    // "not newer" would send them looking for a version bump they do not have.
    expect(checkUpgradeOrder('1.2.3', '1.2.3')).toEqual({ ok: false, failure: 'SAME_VERSION' });
    expect(checkUpgradeOrder('1.2.3+a', '1.2.3+b')).toEqual({
      ok: false,
      failure: 'SAME_VERSION',
    });
  });

  it('refuses an unparseable version instead of guessing', () => {
    expect(checkUpgradeOrder('latest', '1.0.0')).toEqual({
      ok: false,
      failure: 'VERSION_MALFORMED',
    });
    expect(checkUpgradeOrder('1.0.0', 'v2')).toEqual({
      ok: false,
      failure: 'VERSION_MALFORMED',
    });
  });
});

describe('checkRollbackOrder', () => {
  it('permits a strictly older target', () => {
    expect(checkRollbackOrder('1.0.1', '1.0.0')).toEqual({ ok: true });
    expect(checkRollbackOrder('10.0.0', '9.0.0')).toEqual({ ok: true });
    expect(checkRollbackOrder('1.0.0', '1.0.0-rc.1')).toEqual({ ok: true });
  });

  it('refuses an upgrade wearing a rollback label', () => {
    // A "rollback" forward would bypass whatever additional checks an upgrade carries.
    expect(checkRollbackOrder('1.0.0', '1.0.1')).toEqual({ ok: false, failure: 'NOT_OLDER' });
    expect(checkRollbackOrder('9.0.0', '10.0.0')).toEqual({ ok: false, failure: 'NOT_OLDER' });
  });

  it('refuses the same version and a malformed version', () => {
    expect(checkRollbackOrder('1.2.3', '1.2.3')).toEqual({ ok: false, failure: 'SAME_VERSION' });
    expect(checkRollbackOrder('1.2.3', 'nope')).toEqual({
      ok: false,
      failure: 'VERSION_MALFORMED',
    });
  });

  it('is the exact mirror of checkUpgradeOrder', () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ['1.0.0', '1.0.1'],
      ['1.0.1', '1.0.0'],
      ['9.0.0', '10.0.0'],
      ['1.0.0-rc.1', '1.0.0'],
    ];

    for (const [current, target] of pairs) {
      // Exactly one direction may be legal for any two DIFFERENT versions.
      expect(checkUpgradeOrder(current, target).ok).toBe(
        !checkRollbackOrder(current, target).ok,
      );
    }
  });
});
