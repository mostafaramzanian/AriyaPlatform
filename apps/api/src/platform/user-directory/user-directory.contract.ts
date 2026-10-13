/**
 * Phase 50-MOD-CORR: the USER DIRECTORY port.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Before this phase, Correspondence read Core's identity tables directly:
 * `this.prisma.user.findMany(...)` for a recipient set, `findFirst` for a referral
 * target, `findUnique` for a tenant, and Prisma `include`s on `Letter.sender`,
 * `LetterRecipient.user`, `LetterReferral.from/to` and `LetterTrackingEvent.actor`.
 * That was possible only because correspondence tables lived in `core_db` beside
 * `"User"`. After the extraction those relations cannot exist (DC-CORR-01: identity
 * columns are plain Strings, and there is no cross-database foreign key), yet the
 * domain still has four REAL needs:
 *
 *   1. is this id a member of MY tenant? (recipient validation, referral target)
 *   2. which tenant does this id belong to? (the scheduler has no request context)
 *   3. what is this id's name/job-title/avatar? (every projection renders a person)
 *   4. what are the names for THESE ids? (list hydration, one batched read)
 *
 * Those four needs are exactly the four methods below — the port is derived from the
 * call sites that existed, not from a guess about what a directory might offer.
 *
 * THE DIRECTION OF THE DEPENDENCY
 * -------------------------------
 * The port is declared HERE, outside both Core and the domain module, and the module
 * depends on the INTERFACE (`USER_DIRECTORY`), never on Core's Prisma client.
 * `CoreUserDirectoryAdapter` (Core-owned, in this folder) is the one implementation
 * that touches `core_db`. The module therefore compiles without Core's schema and
 * without Core's client, which is what the §25 isolation spec asserts.
 *
 * WHAT THIS PORT MUST NEVER GROW INTO
 * ----------------------------------
 * It returns an ALLOWLISTED person projection and nothing else: no email, no
 * passwordHash, no tokenVersion, no status, no roles, no permissions, no tenant
 * membership beyond "yes/no". A caller can render a person and validate a tenant
 * edge; it cannot use this port to enumerate an organization's accounts, to learn
 * who is an administrator, or to read a credential-adjacent column. Widening it
 * would quietly re-couple a business module to Core's identity model, which is the
 * coupling this extraction removed.
 */

/**
 * DI token for the port. A string token, matching the platform's existing
 * `@Inject('IStorageProvider')` convention rather than introducing a Symbol idiom
 * used nowhere else in this repository.
 */
export const USER_DIRECTORY = 'UserDirectoryContract' as const;

/**
 * Bound on one batched lookup.
 *
 * The largest legitimate batch is a page of letters or a referral list, both of
 * which are capped far below this (`MAX_CORRESPONDENCE_LIMIT` = 100, and a letter
 * carries at most `MAX_RECIPIENTS` = 50 recipients). The bound exists so a caller
 * with a bug cannot turn hydration into an unbounded `IN (...)` scan against Core's
 * identity table; it is generous headroom, not a business limit.
 */
export const MAX_DIRECTORY_IDS = 200;

/**
 * The allowlisted person projection every caller receives.
 *
 * Structurally identical to the correspondence projection it replaces, so the API
 * response shape did not change when the relations were removed. Every field is
 * nullable except the id: an identity record can legitimately lack a name, and a
 * deleted identity is represented by the absence of a profile rather than a throw.
 */
export interface DirectoryUserProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
}

/**
 * Identity lookups a consuming module is allowed to make against the platform.
 *
 * Implementations are Core-owned and may be slow or briefly unavailable; every
 * method is therefore ASYNC and none of them throws for a missing id. "Not found" is
 * a value (null / empty array), because in this domain a missing identity is a
 * normal historical state — the actor of an old letter may have been deleted — and
 * a throw would turn a rendering concern into a 500.
 */
export interface UserDirectoryContract {
  /**
   * Profiles for the ids that EXIST. Ids with no identity are simply absent from the
   * result; the caller decides how to render an unknown actor. Order of the result is
   * not guaranteed — callers key by id.
   */
  findProfiles(userIds: readonly string[]): Promise<DirectoryUserProfile[]>;

  /**
   * The subset of `userIds` that are members of `tenantId`.
   *
   * This is the ONE tenant-boundary check available to a module, and it answers with
   * ids only: a caller learns "these are mine", never "that one belongs to someone
   * else" — the distinction a probing attacker would use.
   */
  filterTenantMembers(tenantId: string, userIds: readonly string[]): Promise<string[]>;

  /** One tenant member, or null when the id does not exist or is not in `tenantId`. */
  findTenantMember(tenantId: string, userId: string): Promise<DirectoryUserProfile | null>;

  /**
   * The tenant a user belongs to, or null when the user is gone or has no tenant.
   * Needed by background work, which has no request context to read a tenant from.
   */
  findTenantId(userId: string): Promise<string | null>;
}

/**
 * Normalises an id list before a lookup: drops empty values, removes duplicates and
 * enforces `MAX_DIRECTORY_IDS`.
 *
 * Exported because it is a pure rule the adapter must not re-implement and the spec
 * pins directly. Duplicates are removed BEFORE the bound is applied, so a caller that
 * sends the same 5 ids 100 times still gets one real query.
 */
export function dedupeIds(userIds: readonly string[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();

  for (const id of userIds) {
    if (typeof id !== 'string' || id.length === 0 || known.has(id)) continue;
    known.add(id);
    seen.push(id);
    if (seen.length === MAX_DIRECTORY_IDS) break;
  }

  return seen;
}