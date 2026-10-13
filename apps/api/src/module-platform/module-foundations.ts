import type { ModuleIdentity } from './module.contract';

/**
 * Phase 49M §36/§37/§38: EXTENSION POINTS for synchronisation, conflict policy and
 * provisioning — and nothing else.
 *
 * WHY THIS FILE CONTAINS ONLY TYPES AND ONE PURE FUNCTION
 * ------------------------------------------------------
 * All three sections ask for FOUNDATIONS and explicitly forbid the implementations:
 *   §36 "DO NOT implement synchronization for Business data yet. No generic
 *        'sync everything' engine."
 *   §37 "Do NOT apply a generic conflict policy to actual Business entities.
 *        No HR/Finance data exists yet."
 *   §38 "do NOT automatically create Docker/VM/Kubernetes instances."
 *
 * An interface costs nothing at runtime, cannot be invoked, and cannot acquire a hidden
 * default behaviour. A SERVICE with a `sync()` method that currently throws, by contrast,
 * is an invitation: the next phase implements it against whatever entity is nearest, and
 * the "no generic sync engine" rule is gone. So there is no `ModuleSyncService`, no
 * `ConflictResolver` provider, no `ModuleProvisioner` class, and no table for any of them —
 * only the shapes a later phase would have to satisfy.
 *
 * WHAT WOULD MAKE THIS FILE WRONG: adding an implementation here, or importing it from
 * anything that runs. It is imported by the admin projection (for the declared policy
 * names) and by its own spec. Nothing else.
 */

/**
 * How a future synchronisation would track its position.
 *
 * FOUR ALTERNATIVES, DECLARED AS A UNION so a later phase must CHOOSE rather than support
 * all of them: a cursor (opaque, provider-defined), a monotonic version, a content
 * checksum, or a timestamp. They are not interchangeable — a timestamp cannot detect an
 * out-of-order write, a checksum cannot express progress — and pretending otherwise is how
 * a sync engine ends up with four half-working modes.
 */
export type ModuleSyncPositionKind = 'CURSOR' | 'VERSION' | 'CHECKSUM' | 'TIMESTAMP';

export interface ModuleSyncPosition {
  kind: ModuleSyncPositionKind;
  /** Opaque to Core. A module owns the meaning of its own position. */
  value: string;
}

/**
 * The shape of a future sync request. NOT IMPLEMENTED, and deliberately not tied to any
 * entity: `resource` is a module-owned string, never an Aria table name.
 *
 * `FULL` vs `INCREMENTAL` is kept explicit rather than inferred from whether a position is
 * present, because "no position, therefore full sync" is exactly the inference that turns a
 * lost cursor into an accidental full re-import.
 */
export interface ModuleSyncPlan {
  identity: ModuleIdentity;
  /** Module-owned resource name. Core never maps this to a local table. */
  resource: string;
  mode: 'FULL' | 'INCREMENTAL';
  since?: ModuleSyncPosition;
  /** Bound a future implementation MUST respect. Declared here so it cannot be forgotten. */
  maxRecords: number;
}

/**
 * Conflict policies a future phase may select FROM, per resource.
 *
 *   OWNER_WINS          — the module that owns the resource wins. The safe default for a
 *                         distributed system where one side is authoritative.
 *   VERSION_MISMATCH    — refuse and surface the conflict. Loses nothing.
 *   EXPLICIT_RESOLUTION — a human decides.
 *   LAST_WRITE_WINS     — clock-ordered. LISTED LAST AND NEVER A DEFAULT: it silently
 *                         discards data and depends on clock agreement between machines
 *                         that have no reason to agree. §37 permits it "only where
 *                         explicitly selected", which is why nothing here selects it.
 */
export type ModuleConflictPolicy =
  | 'OWNER_WINS'
  | 'VERSION_MISMATCH'
  | 'EXPLICIT_RESOLUTION'
  | 'LAST_WRITE_WINS';

/**
 * The policies this phase declares as available, in preference order.
 *
 * DECLARED, NOT APPLIED. Nothing in 49M resolves a conflict, because there is no
 * cross-module business data to conflict — no HR, no Finance, no shared entity. This
 * constant exists so the admin UI can show what the platform supports, and so a later
 * phase adding a fifth policy has one place to add it.
 */
export const DECLARED_CONFLICT_POLICIES: readonly ModuleConflictPolicy[] = [
  'OWNER_WINS',
  'VERSION_MISMATCH',
  'EXPLICIT_RESOLUTION',
  'LAST_WRITE_WINS',
];

/**
 * The safe default a future implementation should start from.
 *
 * OWNER_WINS, not LAST_WRITE_WINS: when a remote module owns a record, Core's copy is a
 * cache, and a cache must never overwrite its origin because two clocks disagreed.
 */
export const DEFAULT_CONFLICT_POLICY: ModuleConflictPolicy = 'OWNER_WINS';

/**
 * The lifecycle a future provisioner would walk (§38).
 *
 * FOUR STEPS, IN ORDER, AND EVERY ONE OF THEM ALREADY EXISTS IN THIS PHASE as a manual
 * operation: REGISTER is `POST /modules/register`, AUTHENTICATE is the HMAC verification,
 * VERIFY is the compatibility check plus the health probe, ACTIVATE is the admin enabling
 * the module. That is the point — provisioning would AUTOMATE these steps, not invent new
 * ones, so the type describes existing behaviour rather than promising new behaviour.
 *
 * WHAT PROVISIONING WOULD ADD, and what this phase refuses to build: creating the
 * container/VM/pod the module runs in. §38 defers it, and there is no Docker API client, no
 * Kubernetes client and no cloud SDK in `apps/api/package.json` to build it with (verified).
 */
export type ModuleProvisioningStep = 'REGISTER' | 'AUTHENTICATE' | 'VERIFY' | 'ACTIVATE';

export const PROVISIONING_STEPS: readonly ModuleProvisioningStep[] = [
  'REGISTER',
  'AUTHENTICATE',
  'VERIFY',
  'ACTIVATE',
];

/**
 * The interface a future `ModuleProvisioner` would implement.
 *
 * NO CLASS IMPLEMENTS THIS IN 49M. It is here so that when one does, it must return a
 * per-step outcome rather than a single boolean — a provisioner that reports "failed" is
 * useless at 3am, and one that reports "failed at VERIFY" is not.
 */
export interface ModuleProvisioner {
  provision(
    identity: ModuleIdentity,
  ): Promise<{
    completed: readonly ModuleProvisioningStep[];
    failedAt?: ModuleProvisioningStep;
  }>;
}

/**
 * The one behaviour in this file: which steps remain, given what completed.
 *
 * A PURE FUNCTION over the declared order, so the admin UI can render progress today
 * without any provisioning machinery existing. It is order-preserving and does not assume
 * the completed list is contiguous — a manual operator can perform the steps out of order,
 * and reporting "nothing remains" because the FIRST step is missing would be a lie.
 */
export function remainingProvisioningSteps(
  completed: readonly ModuleProvisioningStep[],
): readonly ModuleProvisioningStep[] {
  const done = new Set(completed);
  return PROVISIONING_STEPS.filter((step) => !done.has(step));
}

