import type { TrustedTokenClaims } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the PERMISSION SOURCE port (ADR-0006 §D).
 *
 * WHAT THIS REPLACES
 * ------------------
 * `RolesGuard` injected `PermissionService`, which reads Core's `UserRole` →
 * `RolePermission` → `Permission` tables through Core's Prisma client (behind a Redis
 * cache, but a database read all the same). That makes every authorization decision in
 * every runtime a Core-database decision, which is precisely what makes HR unable to be
 * its own process (ADR-0006 §A/B1).
 *
 * The guard now depends on THIS, and the answer depends on the token's trust level:
 *
 *   * `asymmetric` — the `perm` claim IS the authority. No database is consulted, so the
 *     authorization path of a business runtime does not touch Core at all;
 *   * `legacy-hmac` — Core's cached catalogue, exactly as before this phase. The bridge
 *     keeps today's behaviour rather than half-adopting the new model.
 *
 * WHY THE TRUST LEVEL, AND NOT "IF THE CLAIM IS PRESENT"
 * ----------------------------------------------------
 * "Use `perm` if the token carries it" would make the claim authoritative for ANY token
 * that includes one, including a shared-secret token whose holder could put anything
 * there. The rule is therefore about the token's VERIFIED trust level, which only the
 * verifier can establish — which is why `getEffectivePermissions` takes the claims object
 * the verifier produced rather than a raw payload.
 *
 * RETURNING AN EMPTY LIST IS THE ONLY FAILURE MODE. A source that cannot answer must not
 * throw something the guard might translate into "allow": an empty authority set denies
 * every `@Roles(...)` route and leaves unannotated routes exactly as they were.
 */
export abstract class PermissionSource {
  /**
   * The permissions this request is authorized with.
   *
   * @param userId the subject, for the Core-backed implementation.
   * @param claims the VERIFIED claims, or null when the request has no verified token
   *   (a mocked guard, a direct controller call in a test). Null means "Core is the
   *   authority", never "no permissions".
   */
  abstract getEffectivePermissions(
    userId: string,
    claims: TrustedTokenClaims | null,
  ): Promise<string[]>;
}