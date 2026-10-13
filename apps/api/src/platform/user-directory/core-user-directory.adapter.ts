import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/core-client';
import { PrismaService } from '../../database/prisma.service';
import {
  DirectoryUserProfile,
  dedupeIds,
  UserDirectoryContract,
} from './user-directory.contract';

/**
 * Phase 50-MOD-CORR: the CORE implementation of the user-directory port.
 *
 * THIS IS THE ONE FILE THAT ANSWERS IDENTITY QUESTIONS ON BEHALF OF AN EXTRACTED
 * MODULE, and it is deliberately the only one: it is Core-owned, it lives outside
 * `src/modules/**`, and it is the sole place where the identity projection is
 * defined. A module importing `PrismaService` would be coupled to Core's schema and
 * to Core's database; a module importing this port is coupled to nothing but the
 * four documented questions. The §25 isolation spec asserts exactly that split.
 *
 * WHY A PRISMA `select` AND NOT `include` / `findUnique` WITH FULL ROWS
 * --------------------------------------------------------------------
 * `PROFILE_SELECT` is a positive allowlist, the same doctrine as the correspondence
 * projection it replaces: never `email`, never `passwordHash`, never `tokenVersion`,
 * never `status`, never `roles`. A denylist would leak every column Core adds later;
 * an allowlist leaks nothing and fails closed. Because the select is shared by every
 * method here, there is no path through this adapter that returns a wider row.
 *
 * NO `status`/`deletedAt` FILTER, ON PURPOSE
 * -----------------------------------------
 * This preserves the behaviour the correspondence service had when it queried
 * `"User"` directly (`where: { id: { in: ids }, tenantId }`), so the extraction is
 * not also a silent policy change: a suspended-but-present account is still a real
 * recipient, and a deleted one is still absent. Changing who may receive a letter is
 * an authorization decision that belongs in a phase of its own.
 */
const PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  jobTitle: true,
  department: true,
} satisfies Prisma.UserSelect;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof PROFILE_SELECT }>;

@Injectable()
export class CoreUserDirectoryAdapter implements UserDirectoryContract {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batched profile read. One query for the whole page of letters, not one per row —
   * the reason this method takes a list rather than an id is that the projection of a
   * letter list would otherwise be N+1 reads against Core.
   */
  async findProfiles(userIds: readonly string[]): Promise<DirectoryUserProfile[]> {
    const ids = dedupeIds(userIds);
    if (ids.length === 0) return [];

    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: PROFILE_SELECT,
    });

    return rows.map(toProfile);
  }

  async filterTenantMembers(
    tenantId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    const ids = dedupeIds(userIds);
    if (ids.length === 0) return [];

    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids }, tenantId },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  async findTenantMember(
    tenantId: string,
    userId: string,
  ): Promise<DirectoryUserProfile | null> {
    if (!tenantId || !userId) return null;

    const row = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: PROFILE_SELECT,
    });

    return row ? toProfile(row) : null;
  }

  async findTenantId(userId: string): Promise<string | null> {
    if (!userId) return null;

    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });

    return row?.tenantId ?? null;
  }
}

/** Row → port shape. Kept trivial so the mapping cannot drift from the select. */
function toProfile(row: ProfileRow): DirectoryUserProfile {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: row.avatarUrl,
    jobTitle: row.jobTitle,
    department: row.department,
  };
}
