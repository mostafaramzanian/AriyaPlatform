import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  USER_DIRECTORY,
  UserDirectoryContract,
  DirectoryUserProfile,
} from '../../platform/user-directory/user-directory.contract';
import { HrActor } from './hr-actor';

/**
 * RE-EXPORTED, NOT RE-DECLARED, and deliberately the ONLY name this module takes from
 * the platform contract. A consumer (currently `EmployeesService`) must describe the
 * shape it renders without importing `platform/user-directory/user-directory.contract`
 * itself — otherwise the module would reference the port from two files, which is
 * exactly what `hr-isolation.spec.ts` forbids. `export type` keeps this a compile-time
 * alias with no runtime import, so the emitted JavaScript is unchanged.
 */
export type { DirectoryUserProfile };

/**
 * Phase 51-HR-1 (§6d): the ONE surface through which HR reads Core identity.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A WRAPPER FOR ITS OWN SAKE
 * -----------------------------------------------------------------
 * HR owns `hr_db` and cannot join Core's `"User"` table: there is no cross-database
 * foreign key, and `Employee.userId` is a plain string. But HR has two REAL needs that
 * only Core can answer:
 *
 *   1. "is this id a member of MY tenant?" — before linking an employee to a login, and
 *      before treating an id as a manager;
 *   2. "what is this person called?" — every HR list renders a name, and the id alone
 *      cannot produce one.
 *
 * The audit's §6d names this as the only permitted cross-boundary surface and requires
 * the two answers to come from ONE place. The alternative — each HR service injecting
 * `USER_DIRECTORY` and re-implementing the tenant check — is how one of them eventually
 * forgets `filterTenantMembers` and links an employee to another tenant's login. That is
 * a cross-tenant identity leak, and no constraint in `hr_db` can see it, because
 * `userId` is an opaque string with no FK.
 *
 * THE DEPENDENCY DIRECTION, RESTATED BECAUSE IT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * This file depends on the INTERFACE (`USER_DIRECTORY`), never on Core's Prisma client,
 * Core's schema or Core's `PrismaService`. `CoreUserDirectoryAdapter` in
 * `src/platform/user-directory/` is the single implementation that touches `core_db`,
 * and it lives on the PLATFORM side — so HR compiles without Core's schema and the
 * architecture spec's "keeps UserDirectory adapter free of HR-specific coupling" gate
 * stays true from both directions.
 *
 * CONSEQUENCE FOR EVERY FUTURE HR PHASE, STATED AS A RULE
 * ------------------------------------------------------
 * `hr-isolation.spec.ts` asserts that NO OTHER FILE IN THIS MODULE references
 * `USER_DIRECTORY`. Attendance (51-HR-2), leave (51-HR-3) and reports (51-HR-4) all need
 * names — they get them from `profilesFor` here, not by injecting the port again. If a
 * third method is ever needed, it is added HERE, where the tenant rule is already
 * written down and already tested.
 *
 * WHAT THIS PORT MUST NEVER GROW INTO
 * -----------------------------------
 * The directory returns an ALLOWLISTED projection: first name, last name, avatar, job
 * title, department. No email, no role, no permission, no credential-adjacent column,
 * and no way to enumerate an organization's accounts or to learn who is an
 * administrator. This gateway does not widen it; it re-exports it. A method here that
 * answered "who is an admin?" would re-couple HR to Core's identity model, which is the
 * coupling the whole module boundary exists to prevent.
 */
@Injectable()
export class HrIdentityGateway {
  constructor(@Inject(USER_DIRECTORY) private readonly directory: UserDirectoryContract) {}

  /**
   * The write-time link check: a Core identity may only be referenced if it belongs to
   * the ACTOR'S tenant.
   *
   * `filterTenantMembers` — not `findProfiles` — is the right primitive, and the choice
   * is a security decision rather than a stylistic one: it answers with IDS ONLY, so HR
   * learns "this one is mine" and never "that one exists but belongs to somebody else".
   * A probe cannot use this method to discover whether an id exists elsewhere.
   *
   * The rejection is a generic `BadRequestException`, not a `NotFoundException`, for the
   * same reason: a 404 here would confirm the id is absent, and a 403 would confirm it is
   * present-but-foreign. Both are answers an attacker wants; "userId is not a member of
   * this tenant" is the only statement that is true in both cases.
   *
   * A `null`/`undefined` id is NOT an error — an employee may be recorded before they
   * have a login — so this is a no-op for them rather than a throw. That is why the
   * parameter is optional: the caller does not have to branch before calling.
   */
  async assertMember(actor: HrActor, userId: string | null | undefined): Promise<void> {
    if (!userId) return;

    const members = await this.directory.filterTenantMembers(actor.tenantId, [userId]);
    if (!members.includes(userId)) {
      throw new BadRequestException('userId is not a member of this tenant');
    }
  }

  /**
   * The batched identity projection for a whole page of rows, keyed by id.
   *
   * ONE call for the page, never one per row: `Employee` lists render a name for every
   * line, and a per-row read would turn a 20-row page into 21 round trips against Core.
   *
   * A MISSING PROFILE IS A NORMAL STATE, NOT AN ERROR. An employee may be employed before
   * they have a login, and a login may have been deleted since — HR history must survive
   * that (§16), so `Employee.userId` is retained as the historical actor and the map
   * simply has no entry for it. The caller renders `identity: null`.
   *
   * Deduplication happens in the PORT (`dedupeIds`), not here, so the bound on batch size
   * lives with the contract that documents it.
   */
  async profilesFor(
    userIds: readonly (string | null | undefined)[]
  ): Promise<Map<string, DirectoryUserProfile>> {
    const unique = [
      ...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
    ];
    if (unique.length === 0) return new Map();

    const profiles = await this.directory.findProfiles(unique);
    return new Map(profiles.map((profile) => [profile.id, profile]));
  }
}
