import type { TrustedTokenClaims } from './token-contract';

/**
 * Phase 51-HR-ARCH-3A: the TENANT RESOLVER port (ADR-0006 §B3).
 *
 * WHAT THIS REPLACES
 * ------------------
 * `TenantContextInterceptor` read `PrismaService.user.findUnique({ where: { id } })` on
 * EVERY authenticated request to learn the caller's tenant — a per-request Core query
 * performed for the sole purpose of filling `RequestContextService`, which every
 * tenant-scoped module (HR included) reads.
 *
 * `tid` makes that query unnecessary: the issuer already knows the tenant, and the claim
 * is authoritative once the signature is. The interceptor keeps its job (populate the
 * request context once per request) and loses its dependency on a database.
 *
 * `source` IS PART OF THE CONTRACT, NOT DEBUGGING SUGAR
 * ----------------------------------------------------
 * "Where did this tenant come from?" has different answers during the migration, and the
 * difference is a security-relevant one: a tenant read from an unverified token's claim
 * would be a tenant an attacker chooses. Reporting the source makes that assertion
 * TESTABLE — the suite that proves HR's authorization path performs no Core read asserts
 * `source === 'claim'`, and cannot pass if resolution quietly falls back to a query.
 */
export type TenantResolutionSource = 'claim' | 'core-database' | 'none';

export interface TenantResolution {
  readonly tenantId: string | null;
  readonly source: TenantResolutionSource;
}

export interface TenantResolutionInput {
  /** The authenticated subject, or null when the request is unauthenticated. */
  readonly userId: string | null;
  /** The VERIFIED claims, or null when there is no verified token. */
  readonly claims: TrustedTokenClaims | null;
}

/**
 * Resolves the tenant for one request.
 *
 * Never throws: "no tenant" is a value (`null`), because the interceptor's contract is to
 * populate a context and the modules above it decide whether an untenanted request is
 * allowed. HR, for instance, refuses it with a 403 — deliberately, since the alternative
 * is an unscoped query.
 */
export abstract class TenantResolver {
  abstract resolve(input: TenantResolutionInput): Promise<TenantResolution>;
}