import {
  CAPABILITY_PATTERN,
  CONTRACT_PATTERN,
  CORE_MODULE_CONTRACT,
  MAX_CAPABILITY_LENGTH,
  MAX_CONTRACT_LENGTH,
  MODULE_PROTOCOL_VERSION,
  type ModuleCapabilityId,
} from './module.contract';

/**
 * Phase 49M §16/§17/§18: contract identity, comparison and the compatibility gate.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CONTRACT TYPES
 * --------------------------------------------------
 * `module.contract.ts` declares WHAT a contract descriptor is; this file decides WHETHER
 * two of them can talk. Keeping the decision in one place means the registration path,
 * the resolver and the admin projection cannot drift into three slightly different
 * notions of "compatible" — which is the realistic failure mode, because each of them is
 * tempted to add "…but allow this one case".
 *
 * THE RULE, STATED ONCE
 * ---------------------
 * A contract descriptor is `<name>@v<major>`. Two descriptors are compatible IFF the
 * name matches exactly AND the major matches exactly. There is no "v2 can read v1"
 * fallback and no minor-version negotiation, for a reason that is a property of this
 * codebase rather than a preference: nothing here can inspect a remote module's response
 * shape, so a silent downgrade would mean Core sends a v2 request and interprets a v1
 * answer as if it were v2. §16 permits backward-compatible ADDITIONS within a major,
 * which is exactly what "major must match" allows — a module adding a field to
 * `module.invoke@v1` needs no change here, while one changing a field's meaning must
 * publish `@v2` and will not be silently accepted in its place.
 */

/** A parsed contract descriptor. */
export interface ParsedContract {
  name: string;
  major: number;
}

/**
 * Parses `name@v<major>`, or returns undefined.
 *
 * Returns UNDEFINED rather than throwing, because both callers are validation paths that
 * must turn a bad value into a rejection reason, not into a 500: a module registering
 * with a malformed contract gets INCOMPATIBLE with a code, and an admin filter with a
 * typo gets an empty result.
 */
export function parseContract(descriptor: string): ParsedContract | undefined {
  if (typeof descriptor !== 'string' || descriptor.length > MAX_CONTRACT_LENGTH) {
    return undefined;
  }

  if (!CONTRACT_PATTERN.test(descriptor)) return undefined;

  const at = descriptor.lastIndexOf('@v');
  const name = descriptor.slice(0, at);
  const major = Number(descriptor.slice(at + 2));

  // The pattern already guarantees digits, so this only catches an absurd length that
  // `Number` would turn into Infinity — worth refusing rather than storing.
  if (!Number.isSafeInteger(major) || major < 0) return undefined;

  return { name, major };
}

/** True when two descriptors name the same contract at the same major. */
export function contractsCompatible(required: string, offered: string): boolean {
  const a = parseContract(required);
  const b = parseContract(offered);

  if (!a || !b) return false;

  return a.name === b.name && a.major === b.major;
}

/** True when `offered` contains a descriptor compatible with `required`. */
export function satisfiesContract(required: string, offered: readonly string[]): boolean {
  return offered.some((candidate) => contractsCompatible(required, candidate));
}

/** True when the descriptor is well-formed. Used by the DTO's per-entry validation. */
export function isValidContract(descriptor: string): boolean {
  return parseContract(descriptor) !== undefined;
}

/**
 * True when a capability id is well-formed.
 *
 * SHAPE ONLY — never meaning. There is deliberately no list of known capabilities to
 * check against, because §9 gives capability ownership to the declaring module: a
 * registry-side allowlist would mean Core must ship a release before a module can offer
 * anything new, which is the coupling this phase exists to remove.
 */
export function isValidCapability(capability: string): boolean {
  return (
    typeof capability === 'string' &&
    capability.length > 0 &&
    capability.length <= MAX_CAPABILITY_LENGTH &&
    CAPABILITY_PATTERN.test(capability)
  );
}

/**
 * True when the instance declares every capability in `required`.
 *
 * EXACT STRING MATCHING, no prefix or wildcard semantics. `invoice.*` is not a thing
 * here: a wildcard would require Core to understand capability hierarchy, and a module
 * that wants a coarse capability can simply declare a coarse one.
 */
export function hasCapabilities(
  declared: readonly ModuleCapabilityId[],
  required: readonly ModuleCapabilityId[],
): boolean {
  if (required.length === 0) return true;

  const owned = new Set(declared);
  return required.every((capability) => owned.has(capability));
}

/** Why a registration was refused. Short codes; never an internal message. */
export type CompatibilityFailure =
  | 'PROTOCOL_MISMATCH'
  | 'CONTRACT_MISSING'
  | 'CONTRACT_MALFORMED'
  | 'CAPABILITY_MALFORMED';

export interface CompatibilityResult {
  ok: boolean;
  failure?: CompatibilityFailure;
}

/**
 * The §18 gate, applied before an instance may become ACTIVE.
 *
 * FOUR CHECKS, IN THIS ORDER, and the order is the cheapest-first rule the 49L signature
 * verifier follows: the protocol integer, then the presence of the base contract, then
 * the shape of every declared contract, then the shape of every capability.
 *
 * THERE IS NO PARTIAL ACTIVATION. §18 is explicit, and the consequence is visible in the
 * caller: a failure here produces lifecycle INCOMPATIBLE — not ACTIVE-with-a-warning, not
 * ACTIVE-minus-one-capability. A module Core cannot fully speak to is not resolvable,
 * because a half-activated module fails at the first real business request instead of at
 * registration, when somebody is watching.
 */
export function checkCompatibility(candidate: {
  protocolVersion: number;
  apiContracts: readonly string[];
  capabilities: readonly string[];
}): CompatibilityResult {
  if (candidate.protocolVersion !== MODULE_PROTOCOL_VERSION) {
    return { ok: false, failure: 'PROTOCOL_MISMATCH' };
  }

  // The base contract is MANDATORY: it is how Core invokes anything at all, so a module
  // that does not serve it can be registered and recorded but never called, and
  // pretending otherwise would produce a module that resolves and then 404s.
  if (!satisfiesContract(CORE_MODULE_CONTRACT, candidate.apiContracts)) {
    return { ok: false, failure: 'CONTRACT_MISSING' };
  }

  if (!candidate.apiContracts.every(isValidContract)) {
    return { ok: false, failure: 'CONTRACT_MALFORMED' };
  }

  if (!candidate.capabilities.every(isValidCapability)) {
    return { ok: false, failure: 'CAPABILITY_MALFORMED' };
  }

  return { ok: true };
}
