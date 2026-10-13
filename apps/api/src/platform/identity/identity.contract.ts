import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';
import {
  MAX_DIRECTORY_IDS,
  type DirectoryUserProfile,
} from '../user-directory/user-directory.contract';

/**
 * Phase ARCH-3B (§7/§8): the `platform.identity@v1` WIRE contract.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ADR-0006 A7 fixes `platform.identity@v1` as "Core, on a dedicated Core-internal signed HTTP
 * surface — one route group, `/platform/v1/identity`, owned by Core and reachable only by an
 * authenticated service caller". The port (`user-directory.contract.ts`, A1) and its Core
 * adapter already existed; what did not exist was the TRANSPORT. Until it does, a business
 * runtime that is a separate process has no way to answer an identity question at all, so the
 * contract is a declaration rather than a consumption point.
 *
 * WHAT IS DELIBERATELY REUSED RATHER THAN REINVENTED
 * --------------------------------------------------
 * The signing scheme is `module-signature.ts`'s HMAC over the canonical request, which is
 * itself 49L's `integration-signature.ts`. The credential is resolved through A8's
 * `resolveCapabilityCredential(moduleId, capability)`. The projection is `DirectoryUserProfile`.
 * Nothing here is a second crypto system, a second credential store or a second identity model
 * — the ADR is explicit that the saving is in the primitives, not in the transport.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 * There is no "return these fields" parameter, no search, no enumeration, no `User` CRUD and no
 * admin variant: A7's "what this surface must never become" list. The four operations below are
 * the entire surface, and a caller that needs a fifth answer is asking for `@v2` (A2) rather
 * than for a flag. The closed enum is how that is enforced structurally instead of by review.
 */

/** The capability descriptor. A `@v2` is a new credential by construction (A2). */
export const PLATFORM_IDENTITY_CONTRACT = 'platform.identity@v1';

/** The route group, exactly as A7 names it. Kept as a constant so a test can assert the mount. */
export const IDENTITY_ROUTE_PREFIX = '/platform/v1/identity';

/**
 * The four approved operations, named after the `UserDirectoryContract` methods they serve.
 *
 * A CLOSED SET, and it is the ADR's list rather than a subset chosen for convenience: a route
 * that served anything else would be the "fifth route" A7 says is a `@v2` event.
 */
export const IDENTITY_OPERATIONS = [
  'findProfiles',
  'filterTenantMembers',
  'findTenantMember',
  'findTenantId',
] as const;

export type IdentityOperation = (typeof IDENTITY_OPERATIONS)[number];

/**
 * Route segment per operation.
 *
 * WHY THE SEGMENTS DO NOT MATCH THE METHOD NAMES. A URL is seen by an operator, and
 * `/filterTenantMembers` reads like an internal function name while `/tenant-members` reads
 * like what it answers. The mapping is here, in one place, so the two can never drift.
 */
export const IDENTITY_ROUTE_SEGMENTS: Record<IdentityOperation, string> = {
  findProfiles: 'profiles',
  filterTenantMembers: 'tenant-members',
  findTenantMember: 'tenant-member',
  findTenantId: 'tenant-of-user',
};

/**
 * Bound on one batch, taken FROM the port rather than restated.
 *
 * A literal here would be a second bound that could be raised in one file and not the other —
 * and the port's bound is the one the adapter's `dedupeIds` actually enforces, which is what
 * decides how many rows Core will read.
 */
export const MAX_IDENTITY_BATCH = MAX_DIRECTORY_IDS;

/** Longest accepted user id. Ids are Core's `User.id`, so this is generous headroom. */
export const MAX_IDENTITY_USER_ID = 64;

/**
 * A batch request: the ids the caller is asking about.
 *
 * The ids are OPAQUE to this surface. It never parses one, never infers a tenant from one and
 * never trusts one as an authorization claim; they are handed to the port, which applies Core's
 * own membership rule.
 */
export class IdentityProfilesRequestDto {
  @IsArray()
  @ArrayMaxSize(MAX_IDENTITY_BATCH)
  @IsString({ each: true })
  @MaxLength(MAX_IDENTITY_USER_ID, { each: true })
  userIds!: string[];
}

/** A single-id request. Used by `tenant-member` and `tenant-of-user`. */
export class IdentityUserRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_IDENTITY_USER_ID)
  userId!: string;
}

/**
 * The RESPONSE projection of every profile-returning operation: the port's allowlist, and nothing
 * else, ever.
 *
 * An ALIAS rather than a re-declared interface, for the reason `MAX_IDENTITY_BATCH` above is taken
 * from the port: a second interface with the same six fields would be a second shape that could drift
 * from the one the adapter actually returns, and A7's "the `DirectoryUserProfile` allowlist and
 * nothing else, ever" would become a coincidence rather than a guarantee. The alias makes the wire's
 * response type and the port's projection ONE declaration.
 *
 * It is not sufficient on its own — an alias constrains the compiler, not the payload. The transport
 * therefore ALSO copies the six fields explicitly (`PlatformIdentityController.toProfile`), so an
 * adapter that one day returns `passwordHash` or a role list alongside the allowlist does not reach
 * the wire even though it type-checks here.
 */
export type IdentityProfileResponse = DirectoryUserProfile;
