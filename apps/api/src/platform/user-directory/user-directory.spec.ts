import { CoreUserDirectoryAdapter } from './core-user-directory.adapter';
import { dedupeIds, MAX_DIRECTORY_IDS, USER_DIRECTORY } from './user-directory.contract';

/**
 * Phase 50-MOD-CORR: the platform identity seam, pinned.
 *
 * This port is the ONLY way an extracted module may learn anything about a person, so
 * what it may NOT return matters as much as what it may: no credential-adjacent
 * column, no role or permission, no evidence that an id belongs to ANOTHER tenant, and
 * no throw when an identity is gone (a letter can outlive its author — D2).
 */

const PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  jobTitle: true,
  department: true,
};

const makePrisma = () => ({
  user: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
  },
});

describe('USER_DIRECTORY port token and id normalisation', () => {
  it('exposes a stable token', () => {
    expect(USER_DIRECTORY).toBe('UserDirectoryContract');
  });

  it('deduplicates and drops empty ids BEFORE the query, then applies the bound', () => {
    expect(dedupeIds(['a', 'a', '', 'b'])).toEqual(['a', 'b']);
    expect(dedupeIds([])).toEqual([]);

    // Deduplication first, bound second: a caller repeating 5 ids 100 times still
    // produces one small query, not a truncated list.
    const repeated = Array.from({ length: 100 }, () => 'same');
    expect(dedupeIds(repeated)).toEqual(['same']);

    const many = Array.from({ length: MAX_DIRECTORY_IDS + 50 }, (_, index) => `u${index}`);
    expect(dedupeIds(many)).toHaveLength(MAX_DIRECTORY_IDS);
  });
});

describe('CoreUserDirectoryAdapter', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let adapter: CoreUserDirectoryAdapter;

  beforeEach(() => {
    prisma = makePrisma();
    adapter = new CoreUserDirectoryAdapter(prisma as never);
  });

  it('returns the allowlisted projection in ONE deduplicated query', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'علی',
        lastName: 'محمدی',
        avatarUrl: null,
        jobTitle: 'کارشناس',
        department: 'دبیرخانه',
      },
    ]);

    await expect(adapter.findProfiles(['u1', 'u1'])).resolves.toEqual([
      {
        id: 'u1',
        firstName: 'علی',
        lastName: 'محمدی',
        avatarUrl: null,
        jobTitle: 'کارشناس',
        department: 'دبیرخانه',
      },
    ]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] } },
      select: PROFILE_SELECT,
    });
  });

  it('never selects a credential-adjacent or authorization column', async () => {
    await adapter.findProfiles(['u1']);
    const args = prisma.user.findMany.mock.calls[0][0] as { select: Record<string, unknown> };

    for (const forbidden of [
      'email',
      'passwordHash',
      'tokenVersion',
      'status',
      'tenantId',
      'roles',
      'permissions',
    ]) {
      expect(args.select).not.toHaveProperty(forbidden);
    }
  });

  it('does not touch the database at all for an empty id list', async () => {
    await expect(adapter.findProfiles([])).resolves.toEqual([]);
    await expect(adapter.filterTenantMembers('t1', [])).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('answers tenant membership with IDS ONLY, never naming a foreign user', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'mine' }]);

    await expect(adapter.filterTenantMembers('t1', ['mine', 'theirs'])).resolves.toEqual(['mine']);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['mine', 'theirs'] }, tenantId: 't1' },
      select: { id: true },
    });
  });

  it('answers null for a non-member, a missing id or a deleted user instead of throwing', async () => {
    await expect(adapter.findTenantMember('t1', 'theirs')).resolves.toBeNull();
    await expect(adapter.findTenantMember('t1', '')).resolves.toBeNull();
    await expect(adapter.findTenantId('gone')).resolves.toBeNull();
  });

  it('answers the tenant of a live user', async () => {
    prisma.user.findUnique.mockResolvedValue({ tenantId: 't1' });

    await expect(adapter.findTenantId('u1')).resolves.toBe('t1');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { tenantId: true },
    });
  });
});