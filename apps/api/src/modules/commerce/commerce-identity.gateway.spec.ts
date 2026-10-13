import { BadRequestException } from '@nestjs/common';
import { CommerceIdentityGateway } from './commerce-identity.gateway';

/**
 * GAP-8 (WS6.B) — COMMERCE AUTHORIZATION: the membership matrix, at the seam where
 * Commerce asks the platform "is this identity one of mine?".
 *
 * `assertMember` is the ONE place in the module that filters membership on purpose
 * (gate I7 counts its callers; it forbids a second). Every write path funnels through
 * it, so this matrix pins the contract the whole module leans on:
 *
 *   1. an OPAQUE member id succeeds — whatever its shape: a non-UUID string and a
 *      canonical UUID-v4 string are treated as ONE opaque value, never parsed;
 *   2. a non-member id is refused with the exact boundary message;
 *   3. a CROSS-TENANT id is refused with the SAME message — the directory answers
 *      "not in this tenant", never "belongs to someone else", so the refusal cannot
 *      be used to probe which tenant an id does belong to;
 *   4. an unknown (never-created) id is refused identically — existence is not
 *      distinguishable from foreignness on the wire;
 *   5. `null`/`undefined` pass WITHOUT a directory call: the columns are nullable and
 *      "nobody assigned yet" is a legal row.
 *
 * The directory double is structural on purpose: this spec lives inside the Commerce
 * module, where the Step-H guard forbids importing the platform contract directly.
 * `ConstructorParameters` derives the exact port type from the gateway's own
 * constructor, so the fake still has to SATISFY `UserDirectoryContract` without
 * naming it.
 *
 * Covered elsewhere, deliberately: the malformed-shape (non-string) and >64-char
 * refusals are DTO-bound (`purchase.dto.spec.ts`, `commercial.dto.spec.ts`), and the
 * real-database end of this matrix — the REAL `CoreUserDirectoryAdapter` against the
 * REAL seeded rows — is `test/commerce-gap8-identity.e2e-spec.ts`.
 */
type DirectoryDouble = ConstructorParameters<typeof CommerceIdentityGateway>[0];

const profileOf = (id: string) => ({
  id,
  firstName: 'Gap',
  lastName: 'Eight',
  avatarUrl: null,
  jobTitle: 'Tester',
  department: 'QA',
});

function build(options?: {
  membersByTenant?: Record<string, readonly string[]>;
  profiles?: readonly ReturnType<typeof profileOf>[];
}) {
  const membersByTenant = options?.membersByTenant ?? {};
  const profiles: ReturnType<typeof profileOf>[] = [...(options?.profiles ?? [])];

  const filterTenantMembers = jest.fn(async (tenantId: string, userIds: readonly string[]) => {
    const members = membersByTenant[tenantId] ?? [];
    return userIds.filter((id) => members.includes(id));
  });
  const findProfiles = jest.fn(async (userIds: readonly string[]) =>
    profiles.filter((profile) => userIds.includes(profile.id))
  );

  const directory: DirectoryDouble = {
    findProfiles,
    filterTenantMembers,
    findTenantMember: jest.fn(async () => null),
    findTenantId: jest.fn(async () => null),
  };

  return { gateway: new CommerceIdentityGateway(directory), filterTenantMembers, findProfiles };
}

describe('CommerceIdentityGateway.assertMember (GAP-8) — the membership matrix', () => {
  const tenantA = 'tenant-gap8-a';

  it('accepts an opaque non-UUID member id verbatim', async () => {
    const member = 'gap8-opaque-member-1';
    const { gateway, filterTenantMembers } = build({
      membersByTenant: { [tenantA]: [member] },
    });

    await expect(gateway.assertMember({ tenantId: tenantA }, member)).resolves.toBeUndefined();

    // The directory is asked with the ACTOR's tenant and the id as given — no parse,
    // no normalization, no shape assumption anywhere on the path.
    expect(filterTenantMembers).toHaveBeenCalledTimes(1);
    expect(filterTenantMembers).toHaveBeenCalledWith(tenantA, [member]);
  });

  it('accepts a canonical UUID-v4 member id as ONE opaque string — the shape is not special-cased', async () => {
    const member = '3f6d2f60-6b4a-4e9b-9e0a-7f1f0c5a1d21';
    const { gateway, filterTenantMembers } = build({
      membersByTenant: { [tenantA]: [member] },
    });

    await expect(gateway.assertMember({ tenantId: tenantA }, member)).resolves.toBeUndefined();
    expect(filterTenantMembers).toHaveBeenCalledWith(tenantA, [member]);
  });

  it('accepts both shapes through the SAME path with the SAME call shape', async () => {
    const opaque = 'gap8-opaque-member-2';
    const uuid = '3f6d2f60-6b4a-4e9b-9e0a-7f1f0c5a1d21';
    const { gateway, filterTenantMembers } = build({
      membersByTenant: { [tenantA]: [opaque, uuid] },
    });

    await gateway.assertMember({ tenantId: tenantA }, opaque);
    await gateway.assertMember({ tenantId: tenantA }, uuid);

    expect(filterTenantMembers).toHaveBeenNthCalledWith(1, tenantA, [opaque]);
    expect(filterTenantMembers).toHaveBeenNthCalledWith(2, tenantA, [uuid]);
  });


  it('refuses a non-member with the exact boundary message', async () => {
    const { gateway } = build({ membersByTenant: { [tenantA]: [] } });

    await expect(
      gateway.assertMember({ tenantId: tenantA }, 'gap8-not-a-member')
    ).rejects.toThrow(BadRequestException);
    await expect(
      gateway.assertMember({ tenantId: tenantA }, 'gap8-not-a-member')
    ).rejects.toThrow('userId is not a member of this tenant');
  });

  it('refuses a cross-tenant id with the SAME message — foreignness is not disclosed', async () => {
    const foreign = 'gap8-foreign-member';
    // The id IS a real member — of ANOTHER tenant. `filterTenantMembers` answers only
    // about the ACTOR's tenant, so from here it is simply absent from the result.
    const { gateway, filterTenantMembers } = build({
      membersByTenant: { 'tenant-gap8-b': [foreign] },
    });

    await expect(
      gateway.assertMember({ tenantId: tenantA }, foreign)
    ).rejects.toThrow('userId is not a member of this tenant');
    expect(filterTenantMembers).toHaveBeenCalledWith(tenantA, [foreign]);
  });

  it('refuses an unknown id with the SAME message — nonexistence is not disclosed', async () => {
    const { gateway } = build({ membersByTenant: { [tenantA]: ['gap8-known'] } });

    const attempts = ['gap8-never-existed', '3f6d2f60-6b4a-4e9b-9e0a-7f1f0c5a1d99'];
    for (const unknown of attempts) {
      await expect(gateway.assertMember({ tenantId: tenantA }, unknown)).rejects.toThrow(
        'userId is not a member of this tenant'
      );
    }
  });

  it('never echoes the refused id in the exception message', async () => {
    const { gateway } = build();
    const id = 'gap8-must-not-be-echoed';

    const raised = await gateway
      .assertMember({ tenantId: tenantA }, id)
      .then(() => null, (error: unknown) => error);

    expect(raised).toBeInstanceOf(BadRequestException);
    expect(String((raised as BadRequestException).getResponse())).not.toContain(id);
    expect(String((raised as BadRequestException).message)).not.toContain(id);
  });

  it('passes null/undefined as "nobody assigned" WITHOUT asking the directory', async () => {
    const { gateway, filterTenantMembers } = build();

    await expect(gateway.assertMember({ tenantId: tenantA }, null)).resolves.toBeUndefined();
    await expect(gateway.assertMember({ tenantId: tenantA }, undefined)).resolves.toBeUndefined();

    expect(filterTenantMembers).not.toHaveBeenCalled();
  });
});


describe('CommerceIdentityGateway.profilesFor (GAP-8) — batched hydration of opaque ids', () => {
  it('dedupes ids before asking the directory and keys the map by the exact id', async () => {
    const member = 'gap8-opaque-member-3';
    const { gateway, findProfiles } = build({ profiles: [profileOf(member)] });

    const map = await gateway.profilesFor([member, member, member]);

    expect(findProfiles).toHaveBeenCalledTimes(1);
    expect(findProfiles).toHaveBeenCalledWith([member]);
    expect(map.get(member)?.id).toBe(member);
  });

  it('drops null/undefined/empty entries instead of asking the directory about them', async () => {
    const { gateway, findProfiles } = build();

    const map = await gateway.profilesFor([null, undefined, '', 'gap8-real']);

    expect(findProfiles).toHaveBeenCalledWith(['gap8-real']);
    expect(map.size).toBe(0); // 'gap8-real' has no profile in the double: absence is data.
  });

  it('returns an empty map WITHOUT a directory call when nothing usable remains', async () => {
    const { gateway, findProfiles } = build();

    const map = await gateway.profilesFor([null, undefined, '']);

    expect(findProfiles).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('keeps an unresolvable id ABSENT from the map (a render treats absence as the label)', async () => {
    const known = 'gap8-known-member';
    const unknown = 'gap8-left-the-company';
    const { gateway } = build({ profiles: [profileOf(known)] });

    const map = await gateway.profilesFor([known, unknown]);

    expect(map.has(known)).toBe(true);
    expect(map.has(unknown)).toBe(false);
    expect(map.size).toBe(1);
  });
});

