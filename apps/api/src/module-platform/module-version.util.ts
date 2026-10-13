/**
 * Phase 49M-1: version ordering for upgrade and rollback.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The 49M-1 audit searched `apps/api/src` for `semverCompare`, `compareVersions` and
 * `isNewerVersion` and found ZERO. `semver` is not among the 65 dependencies in
 * `apps/api/package.json` either. So an upgrade path had three options, and the third was
 * chosen:
 *
 *   1. Add `semver`. Rejected: a new production dependency for one numeric comparison, whose
 *      range/prerelease/coercion surface is far larger than anything used here.
 *   2. Compare with `===` only. Rejected: without ordering, "upgrade" and "rollback" become the
 *      same operation, and nothing can refuse a downgrade presented as an upgrade.
 *   3. This file: a small total order over the versions the DATABASE already accepts.
 *
 * WHY IT IS SAFE TO BE THIS SMALL
 * -------------------------------
 * `ModuleInstance_version_format` already refuses anything but
 * `^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$`, so `latest`, `v2`, `2` and `1.2` cannot be
 * stored. That CHECK is this module's precondition, and the same regex is restated here rather
 * than imported from the DTO so the comparison cannot silently start accepting a shape the
 * database would reject.
 *
 * WHAT THIS IS NOT: a semver implementation. There is no range matching (`^1.2.0`, `>=2`), no
 * caret/tilde logic, and no build-metadata precedence. Those would all be dead code — nothing
 * in the platform stores a range — and dead comparison code is the kind a later phase trusts
 * without reading.
 */

/** Mirrors `ModuleInstance_version_format` exactly. */
const VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:([-+])([0-9A-Za-z.-]+))?$/;

export interface ParsedModuleVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier without the leading `-`. Absent when the version is a release. */
  prerelease?: string;
  /** Build metadata without the leading `+`. Never affects ordering. */
  build?: string;
}

/**
 * Parses a stored version, or returns undefined.
 *
 * UNDEFINED RATHER THAN A THROW, following `parseContract`: every caller is a validation or
 * comparison path that must turn a bad value into a refusal code, not into a 500.
 *
 * A component that is not a safe integer is refused rather than clamped —
 * `Number('1'.repeat(400))` is `Infinity`, and an Infinity major would compare equal to another
 * Infinity major, quietly making two different versions look identical.
 */
export function parseModuleVersion(value: string): ParsedModuleVersion | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;

  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }

  const parsed: ParsedModuleVersion = { major, minor, patch };

  if (match[4] === '-') parsed.prerelease = match[5];
  if (match[4] === '+') parsed.build = match[5];

  return parsed;
}

/** True when the string is a version this platform can store and compare. */
export function isValidModuleVersion(value: string): boolean {
  return parseModuleVersion(value) !== undefined;
}

/**
 * Total order over two versions: negative when `a < b`, positive when `a > b`, `0` when equal.
 *
 * Returns `undefined` when EITHER side is unparseable. It does NOT fall back to string
 * comparison, and that is the load-bearing decision in this file: `'10.0.0' < '9.0.0'`
 * lexicographically, so a string fallback would report a downgrade as an upgrade — the single
 * worst failure this module could have. An undefined result forces the caller to refuse the
 * operation instead of guessing.
 *
 * PRE-RELEASE PRECEDENCE, kept minimal and explicit: `1.0.0-rc.1` sorts BELOW `1.0.0`, because a
 * release outranks its own pre-releases. Two pre-releases at the same numeric version are
 * compared as plain strings — enough to order `rc.1` against `rc.2`, and deliberately not a full
 * dot-separated identifier comparison, which would be unused precision.
 *
 * BUILD METADATA IS IGNORED for ordering, so `1.0.0+a` and `1.0.0+b` compare equal. A caller
 * that needs to distinguish two builds of one version must compare the artifact checksum, which
 * is the only thing that actually differs between them.
 */
export function compareModuleVersions(a: string, b: string): number | undefined {
  const left = parseModuleVersion(a);
  const right = parseModuleVersion(b);

  if (!left || !right) return undefined;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  // Equal numerics. A release outranks any pre-release of the same version.
  if (left.prerelease === undefined && right.prerelease === undefined) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;

  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Why an upgrade or rollback was refused on version grounds. Short codes only.
 *
 * `SAME_VERSION` is separate from `NOT_NEWER`/`NOT_OLDER` because re-deploying the identical
 * version is a legitimate operator intent (a repair), and an operator who sees "not newer" when
 * they meant "redeploy this" will try again with a bumped version they do not have.
 */
export type VersionOrderFailure =
  | 'VERSION_MALFORMED'
  | 'SAME_VERSION'
  | 'NOT_NEWER'
  | 'NOT_OLDER';

export interface VersionOrderCheck {
  ok: boolean;
  failure?: VersionOrderFailure;
}

/**
 * Gate for an UPGRADE: the target must be strictly newer than what is running.
 *
 * A silent downgrade is the specific hazard here — a module rolled back by an upgrade request
 * loses whatever the newer version wrote — so equality and inversion are BOTH refused, with
 * distinguishable codes.
 */
export function checkUpgradeOrder(current: string, target: string): VersionOrderCheck {
  const order = compareModuleVersions(current, target);

  if (order === undefined) return { ok: false, failure: 'VERSION_MALFORMED' };
  if (order === 0) return { ok: false, failure: 'SAME_VERSION' };
  if (order > 0) return { ok: false, failure: 'NOT_NEWER' };

  return { ok: true };
}

/**
 * Gate for a ROLLBACK: the target must be strictly older than what is running.
 *
 * Symmetric to `checkUpgradeOrder` on purpose. A "rollback" to a newer version is an upgrade
 * wearing the wrong label, and it would bypass whatever additional checks an upgrade carries.
 */
export function checkRollbackOrder(current: string, target: string): VersionOrderCheck {
  const order = compareModuleVersions(current, target);

  if (order === undefined) return { ok: false, failure: 'VERSION_MALFORMED' };
  if (order === 0) return { ok: false, failure: 'SAME_VERSION' };
  if (order < 0) return { ok: false, failure: 'NOT_OLDER' };

  return { ok: true };
}
