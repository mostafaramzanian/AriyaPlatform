import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  USER_DIRECTORY,
  UserDirectoryContract,
  DirectoryUserProfile,
} from '../../platform/user-directory/user-directory.contract';

/**
 * RE-EXPORTED, NOT RE-DECLARED — and the only name this module takes from the platform
 * contract.
 *
 * A Commerce service that renders a purchase list still has to DESCRIBE the person it is
 * rendering, and that description is `DirectoryUserProfile`. If it imported
 * `platform/user-directory/user-directory.contract` itself in order to get the type, the
 * port would be referenced from two files — which is precisely the erosion the Step-H
 * gateway guard asserts against (it fails on a second file naming `USER_DIRECTORY`).
 * `export type` makes this a compile-time alias: the emitted JavaScript contains no
 * runtime import, so the dependency-direction gate that keeps this module free of Core's
 * schema stays true either way.
 */
export type { DirectoryUserProfile };

/**
 * Phase C1 Step H (§21.H / gate I7): the ONE surface through which Commerce reads Core
 * identity.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Commerce owns `commerce_db` and cannot join Core's `"User"` table — PostgreSQL cannot
 * express a foreign key across databases. Every `userId` Commerce will ever store
 * (a purchase requester, an approver, a commercial liaison) is therefore a plain opaque
 * string. Yet Commerce has two needs only Core can answer:
 *
 *   1. "is this id a member of MY TENANT?" — before a purchase document may name a
 *      requester or an approver;
 *   2. "what is this person called?" — a purchase list renders a name, and an id alone
 *      cannot produce one.
 *
 * Gate I7 names this boundary and requires both answers to come from ONE place. The
 * alternative — every Commerce service injecting `USER_DIRECTORY` and re-implementing
 * the tenant check — is how one of them eventually skips `filterTenantMembers` and
 * records a purchase against another tenant's login. No constraint inside `commerce_db`
 * can catch that, because the identity column is an opaque string with no referential
 * constraint at all.
 *
 * THE DEPENDENCY DIRECTION, RESTATED BECAUSE IT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * This file depends on the INTERFACE (`USER_DIRECTORY`), never on Core's Prisma client,
 * Core's schema or Core's `PrismaService`. `CoreUserDirectoryAdapter` in
 * `src/platform/user-directory/` is the single implementation that touches `core_db`, it
 * lives on the platform side, and the architecture spec already guards the other half of
 * the claim ("keeps UserDirectory adapter free of business-module coupling"). Commerce
 * keeps the claim true from this side by not importing the port anywhere else.
 *
 * CONSEQUENCE FOR EVERY FUTURE COMMERCE STEP, STATED AS A RULE
 * -----------------------------------------------------------
 * The Step-H guard asserts that NO OTHER FILE IN THIS MODULE names `USER_DIRECTORY`.
 * Steps L through S (purchase document, workflow, commercial, payment, receiving,
 * return) all need membership and names; they reach them through `assertMember` and
 * `profilesFor` here. A third method is added HERE, where the tenant rule is written
 * down, documented and tested once — not beside a service that happens to need it.
 *
 * THE ACTOR PARAMETER IS STRUCTURAL, ON PURPOSE
 * ---------------------------------------------
 * `assertMember` takes only `{ tenantId }` and not a named actor type. Step I is what
 * introduces `commerce-actor.ts` and `resolveCommerceActor(req)`; declaring a second
 * actor model here would put two descriptions of "who is acting" into one module before
 * the first controller exists. TypeScript's structural typing means the server-derived
 * actor of Step I satisfies this parameter unchanged, so the gateway needs no edit when
 * that step lands.
 *
 * WHAT THIS PORT MUST NEVER GROW INTO
 * -----------------------------------
 * The directory returns an ALLOWLISTED projection — first name, last name, avatar, job
 * title, department. No email, no role, no permission, no credential-adjacent column,
 * and no way to enumerate an organization or to learn who is an administrator. This
 * gateway does not widen it; it re-exports it. A method here that answered "who may
 * approve purchases?" would re-couple Commerce to Core's identity model, and "who may
 * approve" is a Commerce permission question that belongs to the entitlement seam
 * (step J), never to the directory.
 *
 * The compiler cannot enforce any of this, which is why the guard exists: structural DI
 * means ANY file in this module can write `@Inject(USER_DIRECTORY)` and type-check. Only
 * a test that scans the files fails when a second consumer appears.
 */
@Injectable()
export class CommerceIdentityGateway {
  constructor(@Inject(USER_DIRECTORY) private readonly directory: UserDirectoryContract) {}

  /**
   * The write-time link check: a Core identity may only be referenced if it belongs to
   * the ACTOR'S tenant.
   *
   * A missing `userId` is a PASS — the column is nullable, so "no one assigned yet" is a
   * legal row — but a present one must be a member of the acting tenant. Publishing the
   * platform's `filterTenantMembers` may in future take one already-loaded member list;
   * keeping it that way matters here, because this is the only place in Commerce that
   * filters membership on purpose, and a per-service copy of the filter is exactly what
   * gate I7 exists to prevent.
   *
   * `BadRequestException`, not `NotFoundException`: it is the caller's request that
   * contains an id which is not a member of this tenant, and the id must not be echoed
   * back or logged.
   */
  async assertMember(
    actor: { tenantId: string },
    userId: string | null | undefined
  ): Promise<void> {
    if (!userId) return;

    const members = await this.directory.filterTenantMembers(actor.tenantId, [userId]);
    if (!members.includes(userId)) {
      throw new BadRequestException('userId is not a member of this tenant');
    }
  }

  /**
   * The batched identity projection for a whole page of rows, keyed by id.
   *
   * A purchase list of fifty rows that rendered its requester names one identity lookup
   * at a time would be fifty round trips into another module's database from a single
   * HTTP request. One call, one map; a `Map` rather than a `Record` so a synthetic id
   * such as `"__proto__"` cannot poison the prototype of the consumer. Ids are deduped
   * FIRST: a purchase document whose requester is also its approver asks once.
   *
   * `Map<string, DirectoryUserProfile>` rather than a nullable lookup: a row whose id
   * resolves to nothing is absent from the map, and a render path treats "absent" as the
   * label it must show — a person who left, or a wrong tenant id that slipped into a
   * record. Absence is data here, and it is the signal for the audit reconciliation this
   * gateway deliberately does not perform.
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
