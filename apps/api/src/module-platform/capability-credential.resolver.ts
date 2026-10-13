/**
 * Phase ARCH-3B (ADR-0006 A7/A8): the CAPABILITY CREDENTIAL resolution seam.
 *
 * WHY A SEPARATE TOKEN EXISTS INSTEAD OF EXPORTING `ModuleRegistryService`
 * ---------------------------------------------------------------------
 * The identity and audit transports live in `src/platform/**` and must resolve the credential
 * for ONE `(moduleId, capability)` pair. The obvious wiring — export `ModuleRegistryService`
 * from `ModulePlatformModule` and inject it — was rejected, and the rejection is the point of
 * this file: `ModulePlatformModule`'s failure to export that class is a TESTED property
 * (`module-platform.module.spec.ts`), because a business module that can reach the registry can
 * admit modules, rotate module-hop credentials, read the tenant scope and run the sweep. A
 * transport needing one read-only question is not a reason to hand out that surface.
 *
 * So the seam is a TOKEN whose interface is ONE METHOD. A consumer that imports
 * `ModulePlatformModule` and injects `CAPABILITY_CREDENTIAL_RESOLVER` can ask "what is this
 * module's credential for this capability?" and can do nothing else: the interface has no write,
 * no list, no registration, and no second method to widen. `useExisting` binds it to the real
 * service, so there is exactly ONE implementation and no second, divergent resolver.
 *
 * WHAT THE INTERFACE DELIBERATELY DOES NOT RETURN
 * -----------------------------------------------
 * No envelope, no expiry, no `hasSecret`, no row. It returns the PLAINTEXT of a usable
 * credential or `undefined`, which is the only shape a verifier can consume and the smallest
 * possible disclosure: the caller cannot learn whether a credential exists-but-is-expired
 * versus does-not-exist, cannot enumerate a module's capabilities, and never holds a ciphertext
 * it could persist or log. `undefined` is the single failure value for every reason — unknown
 * module, unknown capability, expired, undecryptable — exactly as
 * `ModuleRegistryService.resolveCapabilityCredential` documents, so a caller must fail closed
 * rather than decide which reason is which.
 *
 * EXPIRY IS ENFORCED BY THE IMPLEMENTATION, NOT BY THE CALLER. That is why this seam exposes no
 * expiry value for a caller to interpret: a resolver that handed out an expired credential
 * "with the date attached" would put the fail-closed decision in every consumer, and one of
 * them would eventually forget it.
 */
export interface CapabilityCredentialResolver {
  /**
   * The plaintext credential for one `(moduleId, capability)` pair, or `undefined` when there
   * is no USABLE credential. Never throws; never logs material.
   */
  resolveCapabilityCredential(moduleId: string, capability: string): Promise<string | undefined>;
}

/**
 * DI token. A string token, matching `USER_DIRECTORY` (`platform/user-directory`) and the
 * platform's `@Inject('IStorageProvider')` convention rather than introducing a Symbol idiom
 * used nowhere else in this repository.
 */
export const CAPABILITY_CREDENTIAL_RESOLVER = 'CapabilityCredentialResolver' as const;
